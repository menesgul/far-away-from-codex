import { authenticateInstallation } from "./auth";
import { generateInstallationCredential, hashInstallationCredential } from "./credentials";
import type { Env } from "./env";
import { errorResponse, jsonResponse } from "./http";
import { withTimeout, WORKER_DEPENDENCY_TIMEOUT_MS } from "./timeout";

export const INSTALLATION_DATABASE_TIMEOUT_MS = WORKER_DEPENDENCY_TIMEOUT_MS;

export async function registerInstallation(
  env: Env,
  databaseTimeoutMs = INSTALLATION_DATABASE_TIMEOUT_MS,
): Promise<Response> {
  const installationCredential = generateInstallationCredential();
  const credentialHash = await hashInstallationCredential(installationCredential);

  try {
    await withTimeout(
      env.DB.prepare(
        "INSERT INTO installations (id, credential_hash, created_at) VALUES (?, ?, ?)",
      )
        .bind(crypto.randomUUID(), credentialHash, Date.now())
        .run(),
      databaseTimeoutMs,
    );
  } catch {
    return errorResponse(
      503,
      "REGISTRATION_UNAVAILABLE",
      "Installation registration is temporarily unavailable.",
    );
  }

  return jsonResponse({ installationCredential }, 201);
}

export async function revokeInstallation(
  request: Request,
  env: Env,
  databaseTimeoutMs = INSTALLATION_DATABASE_TIMEOUT_MS,
): Promise<Response> {
  let authentication;
  try {
    authentication = await authenticateInstallation(request, env.DB, databaseTimeoutMs);
  } catch {
    return errorResponse(
      503,
      "INSTALLATION_RESET_UNAVAILABLE",
      "Installation reset is temporarily unavailable.",
    );
  }

  if (!authentication.authenticated) {
    return errorResponse(401, "UNAUTHORIZED", "Installation authentication failed.");
  }

  const installationId = authentication.installation.id;
  try {
    await withTimeout(
      env.DB.batch([
        env.DB
          .prepare(
            "UPDATE installations SET revoked_at = ?, telegram_chat_id = NULL WHERE id = ? AND revoked_at IS NULL",
          )
          .bind(Date.now(), installationId),
        env.DB
          .prepare("DELETE FROM pairings WHERE installation_id = ? AND used_at IS NULL")
          .bind(installationId),
      ]),
      databaseTimeoutMs,
    );
  } catch {
    return errorResponse(
      503,
      "INSTALLATION_RESET_UNAVAILABLE",
      "Installation reset is temporarily unavailable.",
    );
  }

  return new Response(null, {
    status: 204,
    headers: { "cache-control": "no-store" },
  });
}
