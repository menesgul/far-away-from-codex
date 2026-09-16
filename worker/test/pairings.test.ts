import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashInstallationCredential } from "../src/credentials";
import type { Env } from "../src/env";
import worker from "../src/index";
import {
  PAIRING_CREATION_RATE_LIMIT_RETRY_AFTER_SECONDS,
  PAIRING_STATUS_RATE_LIMIT_RETRY_AFTER_SECONDS,
} from "../src/pairingRateLimit";
import { PAIRING_TTL_MS, hashPairingToken } from "../src/pairings";

const INSTALLATION_CREDENTIAL = "abcdefghijklmnopqrstuvwxyz0123456789_ABCDEF";

class FakeRateLimiter implements RateLimit {
  readonly keys: string[] = [];
  private attempts = 0;

  constructor(private readonly allowedAttempts: number) {}

  async limit({ key }: RateLimitOptions): Promise<RateLimitOutcome> {
    this.keys.push(key);
    this.attempts += 1;
    return { success: this.attempts <= this.allowedAttempts };
  }
}

interface PairingResponse {
  pairingId: string;
  telegramUrl: string;
  expiresAt: string;
}

function authenticatedHeaders(): HeadersInit {
  return { Authorization: `Bearer ${INSTALLATION_CREDENTIAL}` };
}

function testEnv(
  creationRateLimiter: RateLimit = new FakeRateLimiter(5),
  statusRateLimiter: RateLimit = new FakeRateLimiter(30),
): Env {
  return {
    ...env,
    REGISTRATION_RATE_LIMITER: new FakeRateLimiter(10),
    PAIRING_CREATION_RATE_LIMITER: creationRateLimiter,
    PAIRING_STATUS_RATE_LIMITER: statusRateLimiter,
  };
}

async function createInstallation(): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO installations (id, credential_hash, created_at) VALUES (?, ?, ?)",
  )
    .bind(id, await hashInstallationCredential(INSTALLATION_CREDENTIAL), Date.now())
    .run();
  return { id };
}

async function requestPairing(workerEnv = testEnv()): Promise<Response> {
  return worker.fetch(
    new Request("https://worker.example/v1/pairings", {
      method: "POST",
      headers: authenticatedHeaders(),
    }),
    workerEnv,
  );
}

function tokenFrom(pairing: PairingResponse): string {
  return new URL(pairing.telegramUrl).searchParams.get("start")!;
}

async function webhook(token: string, chatId = 123456789, type = "private"): Promise<Response> {
  return worker.fetch(
    new Request("https://worker.example/v1/telegram/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": env.TELEGRAM_WEBHOOK_SECRET,
      },
      body: JSON.stringify({ message: { text: `/start ${token}`, chat: { id: chatId, type } } }),
    }),
    testEnv(),
  );
}

describe("Telegram pairing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM pairings"),
      env.DB.prepare("DELETE FROM installations"),
    ]);
  });

  it("creates a five-minute, hash-only pairing and replaces an existing pending pairing", async () => {
    const installation = await createInstallation();
    const response = await requestPairing();
    expect(response.status).toBe(201);
    const first = await response.json<PairingResponse>();
    const firstToken = tokenFrom(first);

    expect(first.pairingId).toMatch(/^[0-9a-f-]{36}$/);
    expect(firstToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.telegramUrl).toMatch(/^https:\/\/t\.me\/far_away_from_codex_test_bot\?start=/);
    expect(Date.parse(first.expiresAt) - Date.now()).toBeGreaterThan(PAIRING_TTL_MS - 5_000);
    expect(Date.parse(first.expiresAt) - Date.now()).toBeLessThanOrEqual(PAIRING_TTL_MS + 1_000);

    const stored = await env.DB.prepare(
      "SELECT token_hash FROM pairings WHERE id = ? AND installation_id = ?",
    )
      .bind(first.pairingId, installation.id)
      .first<{ token_hash: string }>();
    expect(stored?.token_hash).toBe(await hashPairingToken(firstToken));
    expect(stored?.token_hash).not.toBe(firstToken);

    const secondResponse = await requestPairing();
    const second = await secondResponse.json<PairingResponse>();
    const active = await env.DB.prepare("SELECT id FROM pairings WHERE installation_id = ? AND used_at IS NULL")
      .bind(installation.id)
      .all<{ id: string }>();
    expect(active.results.map(({ id }) => id)).toEqual([second.pairingId]);
  });

  it("limits creation per installation", async () => {
    const installation = await createInstallation();
    const creationRateLimiter = new FakeRateLimiter(5);
    const workerEnv = testEnv(creationRateLimiter);

    for (let count = 0; count < 5; count += 1) {
      expect((await requestPairing(workerEnv)).status).toBe(201);
    }

    const limited = await requestPairing(workerEnv);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe(
      String(PAIRING_CREATION_RATE_LIMIT_RETRY_AFTER_SECONDS),
    );
    expect(creationRateLimiter.keys).toEqual(Array(6).fill(installation.id));
  });

  it("returns a status only to its owner and limits status polling", async () => {
    const installation = await createInstallation();
    const pairing = await (await requestPairing()).json<PairingResponse>();
    const statusRateLimiter = new FakeRateLimiter(1);
    const workerEnv = testEnv(new FakeRateLimiter(5), statusRateLimiter);

    const pending = await worker.fetch(
      new Request(`https://worker.example/v1/pairings/${pairing.pairingId}`, {
        headers: authenticatedHeaders(),
      }),
      workerEnv,
    );
    expect(await pending.json()).toEqual({ status: "pending" });
    expect(statusRateLimiter.keys).toEqual([installation.id]);

    const limited = await worker.fetch(
      new Request(`https://worker.example/v1/pairings/${pairing.pairingId}`, {
        headers: authenticatedHeaders(),
      }),
      workerEnv,
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe(
      String(PAIRING_STATUS_RATE_LIMIT_RETRY_AFTER_SECONDS),
    );

    const otherCredential = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_abcdef";
    await env.DB.prepare(
      "INSERT INTO installations (id, credential_hash, created_at) VALUES (?, ?, ?)",
    )
      .bind(crypto.randomUUID(), await hashInstallationCredential(otherCredential), Date.now())
      .run();
    const otherResponse = await worker.fetch(
      new Request(`https://worker.example/v1/pairings/${pairing.pairingId}`, {
        headers: { Authorization: `Bearer ${otherCredential}` },
      }),
      testEnv(),
    );
    expect(otherResponse.status).toBe(404);
  });

  it("accepts only an authenticated, exact private-chat start and consumes the token once", async () => {
    const installation = await createInstallation();
    const pairing = await (await requestPairing()).json<PairingResponse>();
    const token = tokenFrom(pairing);

    const unauthenticated = await worker.fetch(
      new Request("https://worker.example/v1/telegram/webhook", {
        method: "POST",
        body: new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) }),
      }),
      testEnv(),
    );
    expect(unauthenticated.status).toBe(401);

    expect((await webhook(token, 777, "group")).status).toBe(200);
    let installationRow = await env.DB.prepare("SELECT telegram_chat_id FROM installations WHERE id = ?")
      .bind(installation.id)
      .first<{ telegram_chat_id: string | null }>();
    expect(installationRow?.telegram_chat_id).toBeNull();

    const connected = await webhook(token, 777);
    expect(connected.status).toBe(200);
    installationRow = await env.DB.prepare("SELECT telegram_chat_id FROM installations WHERE id = ?")
      .bind(installation.id)
      .first<{ telegram_chat_id: string | null }>();
    expect(installationRow?.telegram_chat_id).toBe("777");

    expect((await webhook(token, 888)).status).toBe(200);
    installationRow = await env.DB.prepare("SELECT telegram_chat_id FROM installations WHERE id = ?")
      .bind(installation.id)
      .first<{ telegram_chat_id: string | null }>();
    expect(installationRow?.telegram_chat_id).toBe("777");

    const status = await worker.fetch(
      new Request(`https://worker.example/v1/pairings/${pairing.pairingId}`, {
        headers: authenticatedHeaders(),
      }),
      testEnv(),
    );
    expect(await status.json()).toEqual({ status: "connected" });
  });

  it("never rebinds a replay that arrives in the same millisecond as consumption", async () => {
    const installation = await createInstallation();
    const pairing = await (await requestPairing()).json<PairingResponse>();
    const token = tokenFrom(pairing);
    const consumedAt = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(consumedAt);

    expect((await webhook(token, 777)).status).toBe(200);
    expect((await webhook(token, 888)).status).toBe(200);

    const installationRow = await env.DB.prepare("SELECT telegram_chat_id FROM installations WHERE id = ?")
      .bind(installation.id)
      .first<{ telegram_chat_id: string | null }>();
    expect(installationRow?.telegram_chat_id).toBe("777");
  });

  it("does not bind expired pairings and disconnect preserves the credential while invalidating pending pairings", async () => {
    const installation = await createInstallation();
    const expiredPairing = await (await requestPairing()).json<PairingResponse>();
    const expiredToken = tokenFrom(expiredPairing);
    await env.DB.prepare("UPDATE pairings SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, expiredPairing.pairingId)
      .run();
    expect((await webhook(expiredToken, 555)).status).toBe(200);

    const expiredStatus = await worker.fetch(
      new Request(`https://worker.example/v1/pairings/${expiredPairing.pairingId}`, {
        headers: authenticatedHeaders(),
      }),
      testEnv(),
    );
    expect(await expiredStatus.json()).toEqual({ status: "expired" });

    const pendingPairing = await (await requestPairing()).json<PairingResponse>();
    await env.DB.prepare("UPDATE installations SET telegram_chat_id = ? WHERE id = ?")
      .bind("123", installation.id)
      .run();
    const disconnect = await worker.fetch(
      new Request("https://worker.example/v1/telegram-connection", {
        method: "DELETE",
        headers: authenticatedHeaders(),
      }),
      testEnv(),
    );
    expect(disconnect.status).toBe(204);

    const installationRow = await env.DB.prepare("SELECT telegram_chat_id FROM installations WHERE id = ?")
      .bind(installation.id)
      .first<{ telegram_chat_id: string | null }>();
    expect(installationRow?.telegram_chat_id).toBeNull();
    expect(
      await env.DB.prepare("SELECT id FROM pairings WHERE id = ?").bind(pendingPairing.pairingId).first(),
    ).toBeNull();
    expect((await requestPairing(testEnv())).status).toBe(201);
  });
});
