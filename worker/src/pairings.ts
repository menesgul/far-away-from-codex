import { authenticateInstallation } from "./auth";
import type { Env } from "./env";
import { errorResponse, jsonResponse } from "./http";
import {
  enforceInstallationRateLimit,
  pairingCreationRateLimitOptions,
  pairingStatusRateLimitOptions,
} from "./pairingRateLimit";
import { withTimeout, WORKER_DEPENDENCY_TIMEOUT_MS } from "./timeout";

export const PAIRING_TOKEN_BYTES = 32;
export const PAIRING_TTL_MS = 5 * 60 * 1_000;

interface PairingStatusRow {
  expires_at: number;
  used_at: number | null;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function generatePairingToken(): string {
  const randomBytes = new Uint8Array(PAIRING_TOKEN_BYTES);
  crypto.getRandomValues(randomBytes);
  return toBase64Url(randomBytes);
}

export async function hashPairingToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function authenticatePairingRequest(
  request: Request,
  env: Env,
): Promise<{ installationId: string } | Response> {
  try {
    const authentication = await authenticateInstallation(request, env.DB);
    if (!authentication.authenticated) {
      return errorResponse(401, "UNAUTHORIZED", "Installation authentication failed.");
    }

    return { installationId: authentication.installation.id };
  } catch {
    return errorResponse(503, "PAIRING_UNAVAILABLE", "Pairing is temporarily unavailable.");
  }
}

export async function createPairing(request: Request, env: Env): Promise<Response> {
  const authentication = await authenticatePairingRequest(request, env);
  if (authentication instanceof Response) {
    return authentication;
  }

  const rateLimitResponse = await enforceInstallationRateLimit(
    authentication.installationId,
    env.PAIRING_CREATION_RATE_LIMITER,
    pairingCreationRateLimitOptions,
  );
  if (rateLimitResponse !== undefined) {
    return rateLimitResponse;
  }

  const token = generatePairingToken();
  const tokenHash = await hashPairingToken(token);
  const pairingId = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + PAIRING_TTL_MS;

  try {
    await withTimeout(
      env.DB.batch([
        env.DB.prepare("DELETE FROM pairings WHERE installation_id = ? AND used_at IS NULL")
          .bind(authentication.installationId),
        env.DB
          .prepare(
            "INSERT INTO pairings (id, installation_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .bind(pairingId, authentication.installationId, tokenHash, expiresAt, now),
      ]),
      WORKER_DEPENDENCY_TIMEOUT_MS,
    );
  } catch {
    return errorResponse(503, "PAIRING_UNAVAILABLE", "Pairing is temporarily unavailable.");
  }

  return jsonResponse(
    {
      pairingId,
      telegramUrl: `https://t.me/${encodeURIComponent(env.TELEGRAM_BOT_USERNAME)}?start=${token}`,
      expiresAt: new Date(expiresAt).toISOString(),
    },
    201,
  );
}

export async function getPairingStatus(
  request: Request,
  env: Env,
  pairingId: string,
): Promise<Response> {
  const authentication = await authenticatePairingRequest(request, env);
  if (authentication instanceof Response) {
    return authentication;
  }

  const rateLimitResponse = await enforceInstallationRateLimit(
    authentication.installationId,
    env.PAIRING_STATUS_RATE_LIMITER,
    pairingStatusRateLimitOptions,
  );
  if (rateLimitResponse !== undefined) {
    return rateLimitResponse;
  }

  let pairing: PairingStatusRow | null;
  try {
    pairing = await withTimeout(
      env.DB
        .prepare(
          "SELECT expires_at, used_at FROM pairings WHERE id = ? AND installation_id = ? LIMIT 1",
        )
        .bind(pairingId, authentication.installationId)
        .first<PairingStatusRow>(),
      WORKER_DEPENDENCY_TIMEOUT_MS,
    );
  } catch {
    return errorResponse(503, "PAIRING_STATUS_UNAVAILABLE", "Pairing status is temporarily unavailable.");
  }

  if (pairing === null) {
    return errorResponse(404, "PAIRING_NOT_FOUND", "Pairing was not found.");
  }

  if (pairing.used_at !== null) {
    return jsonResponse({ status: "connected" });
  }

  if (pairing.expires_at <= Date.now()) {
    return jsonResponse({ status: "expired" });
  }

  return jsonResponse({ status: "pending" });
}

export async function disconnectTelegram(request: Request, env: Env): Promise<Response> {
  let authentication;
  try {
    authentication = await authenticateInstallation(request, env.DB);
  } catch {
    return errorResponse(
      503,
      "TELEGRAM_DISCONNECT_UNAVAILABLE",
      "Telegram disconnect is temporarily unavailable.",
    );
  }

  if (!authentication.authenticated) {
    return errorResponse(401, "UNAUTHORIZED", "Installation authentication failed.");
  }

  try {
    await withTimeout(
      env.DB.batch([
        env.DB
          .prepare("UPDATE installations SET telegram_chat_id = NULL WHERE id = ? AND revoked_at IS NULL")
          .bind(authentication.installation.id),
        env.DB.prepare("DELETE FROM pairings WHERE installation_id = ? AND used_at IS NULL")
          .bind(authentication.installation.id),
      ]),
      WORKER_DEPENDENCY_TIMEOUT_MS,
    );
  } catch {
    return errorResponse(
      503,
      "TELEGRAM_DISCONNECT_UNAVAILABLE",
      "Telegram disconnect is temporarily unavailable.",
    );
  }

  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
