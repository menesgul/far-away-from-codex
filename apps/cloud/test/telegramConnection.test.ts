import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashInstallationCredential } from "../src/credentials";
import type { Env } from "../src/env";
import worker from "../src/index";
import { TELEGRAM_CONNECTION_RATE_LIMIT_RETRY_AFTER_SECONDS } from "../src/pairingRateLimit";
import {
  getTelegramConnection,
  TELEGRAM_DISCONNECT_ACKNOWLEDGEMENT,
} from "../src/pairings";

const INSTALLATION_CREDENTIAL = "abcdefghijklmnopqrstuvwxyz0123456789_ABCDEF";
const ACTIVE_TELEGRAM_CONNECTION_QUERY =
  "SELECT telegram_chat_id FROM installations WHERE id = ? AND revoked_at IS NULL LIMIT 1";

class FakeRateLimiter implements RateLimit {
  readonly keys: string[] = [];
  private readonly attemptsByKey = new Map<string, number>();

  constructor(private readonly allowedAttempts = 30) {}

  async limit({ key }: RateLimitOptions): Promise<RateLimitOutcome> {
    this.keys.push(key);
    const attempts = (this.attemptsByKey.get(key) ?? 0) + 1;
    this.attemptsByKey.set(key, attempts);
    return { success: attempts <= this.allowedAttempts };
  }
}

interface InstallationRow {
  id: string;
  credential_hash: string;
  telegram_chat_id: string | null;
  created_at: number;
  revoked_at: number | null;
}

interface PairingRow {
  id: string;
  installation_id: string;
  token_hash: string;
  expires_at: number;
  used_at: number | null;
  created_at: number;
}

function authenticatedHeaders(credential = INSTALLATION_CREDENTIAL): HeadersInit {
  return { Authorization: `Bearer ${credential}` };
}

function testEnv(statusRateLimiter: RateLimit = new FakeRateLimiter()): Env {
  return { ...env, PAIRING_STATUS_RATE_LIMITER: statusRateLimiter };
}

function concurrentDisconnectBarrier() {
  let releaseReads: () => void;
  let readsCaptured: () => void;
  const release = new Promise<void>((resolve) => {
    releaseReads = resolve;
  });
  const bothReadsCaptured = new Promise<void>((resolve) => {
    readsCaptured = resolve;
  });
  const capturedChats: Array<string | null> = [];

  const database = {
    prepare(query: string) {
      const statement = env.DB.prepare(query);
      if (query !== ACTIVE_TELEGRAM_CONNECTION_QUERY) {
        return statement;
      }

      return {
        bind: (...values: unknown[]) => {
          const boundStatement = statement.bind(...values);
          return {
            first: async <T>() => {
              const row = await boundStatement.first<T & { telegram_chat_id: string | null }>();
              if (capturedChats.length < 2) {
                capturedChats.push(row?.telegram_chat_id ?? null);
                if (capturedChats.length === 2) {
                  readsCaptured();
                }
                await release;
              }
              return row;
            },
          };
        },
      } as unknown as D1PreparedStatement;
    },
    batch: env.DB.batch.bind(env.DB),
  } as unknown as D1Database;

  return {
    env: { ...testEnv(), DB: database } satisfies Env,
    bothReadsCaptured,
    capturedChats,
    release: () => releaseReads(),
  };
}

async function createInstallation(telegramChatId: string | null = null): Promise<InstallationRow> {
  const row: InstallationRow = {
    id: crypto.randomUUID(),
    credential_hash: await hashInstallationCredential(INSTALLATION_CREDENTIAL),
    telegram_chat_id: telegramChatId,
    created_at: Date.now(),
    revoked_at: null,
  };
  await env.DB.prepare(
    "INSERT INTO installations (id, credential_hash, telegram_chat_id, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(row.id, row.credential_hash, row.telegram_chat_id, row.created_at)
    .run();
  return row;
}

function connectionRequest(credential?: string, method = "GET"): Request {
  return new Request("https://worker.example/v1/telegram-connection", {
    method,
    headers: credential === undefined ? undefined : authenticatedHeaders(credential),
  });
}

function successfulTelegramResponse(): Response {
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
}

function pairingStatusRequest(pairingId: string): Request {
  return new Request(`https://worker.example/v1/pairings/${pairingId}`, {
    headers: authenticatedHeaders(),
  });
}

async function createPendingPairing(installationId: string): Promise<PairingRow> {
  const pairing: PairingRow = {
    id: crypto.randomUUID(),
    installation_id: installationId,
    token_hash: crypto.randomUUID(),
    expires_at: Date.now() + 60_000,
    used_at: null,
    created_at: Date.now(),
  };
  await env.DB.prepare(
    "INSERT INTO pairings (id, installation_id, token_hash, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      pairing.id,
      pairing.installation_id,
      pairing.token_hash,
      pairing.expires_at,
      pairing.used_at,
      pairing.created_at,
    )
    .run();
  return pairing;
}

describe("Telegram connection state", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM pairings"),
      env.DB.prepare("DELETE FROM installations"),
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns disconnected without exposing the chat ID and does not mutate D1 state", async () => {
    const installation = await createInstallation();
    const pairing = await createPendingPairing(installation.id);

    const response = await worker.fetch(connectionRequest(INSTALLATION_CREDENTIAL), testEnv());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(body)).toEqual({ connected: false });
    expect(body).not.toContain("telegram_chat_id");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(
      await env.DB.prepare(
        "SELECT id, credential_hash, telegram_chat_id, created_at, revoked_at FROM installations WHERE id = ?",
      )
        .bind(installation.id)
        .first<InstallationRow>(),
    ).toEqual(installation);
    expect(
      await env.DB.prepare(
        "SELECT id, installation_id, token_hash, expires_at, used_at, created_at FROM pairings WHERE id = ?",
      )
        .bind(pairing.id)
        .first<PairingRow>(),
    ).toEqual(pairing);
  });

  it("returns connected for an authenticated installation with a chat association", async () => {
    const chatId = "123456789";
    await createInstallation(chatId);

    const response = await worker.fetch(connectionRequest(INSTALLATION_CREDENTIAL), testEnv());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(body)).toEqual({ connected: true });
    expect(body).not.toContain(chatId);
    expect(body).not.toContain("telegram_chat_id");
  });

  it("returns the existing safe unauthorized response for missing, invalid, and revoked credentials", async () => {
    const installation = await createInstallation();
    const invalidCredential = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_abcdef";

    const missing = await worker.fetch(connectionRequest(), testEnv());
    const invalid = await worker.fetch(connectionRequest(invalidCredential), testEnv());
    await env.DB.prepare("UPDATE installations SET revoked_at = ? WHERE id = ?")
      .bind(Date.now(), installation.id)
      .run();
    const revoked = await worker.fetch(connectionRequest(INSTALLATION_CREDENTIAL), testEnv());

    for (const response of [missing, invalid, revoked]) {
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: { code: "UNAUTHORIZED", message: "Installation authentication failed." },
      });
    }
  });

  it("returns a safe connection-specific failure when the state lookup fails", async () => {
    let lookupCount = 0;
    const failingStateLookupEnv = {
      ...testEnv(),
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => {
              lookupCount += 1;
              if (lookupCount === 1) {
                return { id: "installation-id" };
              }
              throw new Error("sensitive database detail");
            },
          }),
        }),
      } as unknown as D1Database,
    };

    const response = await getTelegramConnection(
      connectionRequest(INSTALLATION_CREDENTIAL),
      failingStateLookupEnv,
    );
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(body)).toEqual({
      error: {
        code: "TELEGRAM_CONNECTION_UNAVAILABLE",
        message: "Telegram connection is temporarily unavailable.",
      },
    });
    expect(body).not.toContain("sensitive database detail");
  });

  it("returns a bounded safe failure when the state lookup never resolves", async () => {
    let lookupCount = 0;
    const hangingStateLookupEnv = {
      ...testEnv(),
      DB: {
        prepare: () => ({
          bind: () => ({
            first: () => {
              lookupCount += 1;
              return lookupCount === 1
                ? Promise.resolve({ id: "installation-id" })
                : new Promise<never>(() => undefined);
            },
          }),
        }),
      } as unknown as D1Database,
    };

    const response = await getTelegramConnection(
      connectionRequest(INSTALLATION_CREDENTIAL),
      hangingStateLookupEnv,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "TELEGRAM_CONNECTION_UNAVAILABLE",
        message: "Telegram connection is temporarily unavailable.",
      },
    });
  });

  it("fails closed if the installation is revoked after authentication", async () => {
    let lookupCount = 0;
    const revokedAfterAuthenticationEnv = {
      ...testEnv(),
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => {
              lookupCount += 1;
              return lookupCount === 1 ? { id: "installation-id" } : null;
            },
          }),
        }),
      } as unknown as D1Database,
    };

    const response = await getTelegramConnection(
      connectionRequest(INSTALLATION_CREDENTIAL),
      revokedAfterAuthenticationEnv,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "UNAUTHORIZED", message: "Installation authentication failed." },
    });
  });

  it("reuses the pairing-status limiter with connection-specific throttling", async () => {
    const installation = await createInstallation();
    const rateLimiter = new FakeRateLimiter(1);
    const workerEnv = testEnv(rateLimiter);

    expect((await worker.fetch(connectionRequest(INSTALLATION_CREDENTIAL), workerEnv)).status).toBe(200);
    const limited = await worker.fetch(connectionRequest(INSTALLATION_CREDENTIAL), workerEnv);

    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe(
      String(TELEGRAM_CONNECTION_RATE_LIMIT_RETRY_AFTER_SECONDS),
    );
    expect(await limited.json()).toEqual({
      error: {
        code: "TELEGRAM_CONNECTION_RATE_LIMITED",
        message: "Too many Telegram connection-state requests. Please try again later.",
      },
    });
    expect(rateLimiter.keys).toEqual([
      `telegram-connection:${installation.id}`,
      `telegram-connection:${installation.id}`,
    ]);
  });

  it("isolates connection-state quota from pairing-status polling on the shared binding", async () => {
    const installation = await createInstallation();
    const pairing = await createPendingPairing(installation.id);
    const rateLimiter = new FakeRateLimiter(1);
    const workerEnv = testEnv(rateLimiter);

    expect((await worker.fetch(connectionRequest(INSTALLATION_CREDENTIAL), workerEnv)).status).toBe(200);
    expect((await worker.fetch(connectionRequest(INSTALLATION_CREDENTIAL), workerEnv)).status).toBe(429);

    const pairingStatus = await worker.fetch(pairingStatusRequest(pairing.id), workerEnv);
    expect(pairingStatus.status).toBe(200);
    expect(await pairingStatus.json()).toEqual({ status: "pending" });
    expect(rateLimiter.keys).toEqual([
      `telegram-connection:${installation.id}`,
      `telegram-connection:${installation.id}`,
      `pairing-status:${installation.id}`,
    ]);
  });

  it("allows only GET and preserves the existing DELETE disconnect route", async () => {
    const installation = await createInstallation("123456789");

    const unsupported = await worker.fetch(connectionRequest(INSTALLATION_CREDENTIAL, "POST"), testEnv());
    expect(unsupported.status).toBe(405);
    expect(await unsupported.json()).toEqual({
      error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." },
    });

    const disconnect = await worker.fetch(
      connectionRequest(INSTALLATION_CREDENTIAL, "DELETE"),
      testEnv(),
    );
    expect(disconnect.status).toBe(204);
    expect(
      await env.DB.prepare("SELECT telegram_chat_id FROM installations WHERE id = ?")
        .bind(installation.id)
        .first<{ telegram_chat_id: string | null }>(),
    ).toEqual({ telegram_chat_id: null });
  });

  it("disconnects authoritatively, invalidates pending pairings, and acknowledges the old chat once", async () => {
    const oldChatId = "123456789";
    const installation = await createInstallation(oldChatId);
    const pairing = await createPendingPairing(installation.id);
    const telegramRequest = vi.fn(async () => successfulTelegramResponse());
    vi.stubGlobal("fetch", telegramRequest);

    const response = await worker.fetch(connectionRequest(INSTALLATION_CREDENTIAL, "DELETE"), testEnv());

    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(
      await env.DB.prepare("SELECT telegram_chat_id FROM installations WHERE id = ?")
        .bind(installation.id)
        .first<{ telegram_chat_id: string | null }>(),
    ).toEqual({ telegram_chat_id: null });
    expect(await env.DB.prepare("SELECT id FROM pairings WHERE id = ?").bind(pairing.id).first()).toBeNull();
    expect(telegramRequest).toHaveBeenCalledTimes(1);
    const [url, init] = telegramRequest.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/sendMessage");
    expect(JSON.parse(init.body as string)).toEqual({
      chat_id: oldChatId,
      text: "\u{1F50C} Disconnected from Far Away From Codex\n\n"
        + "This chat will no longer receive Codex alerts from that VS Code installation.",
    });
    expect((JSON.parse(init.body as string) as { text: string }).text).toBe(
      TELEGRAM_DISCONNECT_ACKNOWLEDGEMENT,
    );
  });

  it("keeps the definitive disconnect when Telegram acknowledgement delivery fails", async () => {
    const installation = await createInstallation("123456789");
    const pairing = await createPendingPairing(installation.id);
    const telegramRequest = vi.fn(async () => {
      throw new Error("sensitive Telegram failure");
    });
    vi.stubGlobal("fetch", telegramRequest);

    const response = await worker.fetch(connectionRequest(INSTALLATION_CREDENTIAL, "DELETE"), testEnv());
    const body = await response.text();

    expect(response.status).toBe(204);
    expect(body).toBe("");
    expect(body).not.toContain("sensitive Telegram failure");
    expect(
      await env.DB.prepare("SELECT telegram_chat_id FROM installations WHERE id = ?")
        .bind(installation.id)
        .first<{ telegram_chat_id: string | null }>(),
    ).toEqual({ telegram_chat_id: null });
    expect(await env.DB.prepare("SELECT id FROM pairings WHERE id = ?").bind(pairing.id).first()).toBeNull();
    expect(telegramRequest).toHaveBeenCalledTimes(1);
  });

  it("does not acknowledge an already disconnected installation", async () => {
    await createInstallation();
    const telegramRequest = vi.fn(async () => successfulTelegramResponse());
    vi.stubGlobal("fetch", telegramRequest);

    const response = await worker.fetch(connectionRequest(INSTALLATION_CREDENTIAL, "DELETE"), testEnv());

    expect(response.status).toBe(204);
    expect(telegramRequest).not.toHaveBeenCalled();
  });

  it("allows two DELETEs that read the same old chat to acknowledge exactly one transition", async () => {
    const oldChatId = "123456789";
    const installation = await createInstallation(oldChatId);
    const telegramRequest = vi.fn(async () => successfulTelegramResponse());
    vi.stubGlobal("fetch", telegramRequest);
    const barrier = concurrentDisconnectBarrier();

    const first = worker.fetch(connectionRequest(INSTALLATION_CREDENTIAL, "DELETE"), barrier.env);
    const second = worker.fetch(connectionRequest(INSTALLATION_CREDENTIAL, "DELETE"), barrier.env);
    await barrier.bothReadsCaptured;
    expect(barrier.capturedChats).toEqual([oldChatId, oldChatId]);
    barrier.release();
    const responses = await Promise.all([first, second]);

    expect(responses.map((response) => response.status)).toEqual([204, 204]);
    expect(
      await env.DB.prepare("SELECT telegram_chat_id FROM installations WHERE id = ?")
        .bind(installation.id)
        .first<{ telegram_chat_id: string | null }>(),
    ).toEqual({ telegram_chat_id: null });
    expect(telegramRequest).toHaveBeenCalledTimes(1);
    const [, init] = telegramRequest.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      chat_id: oldChatId,
      text: TELEGRAM_DISCONNECT_ACKNOWLEDGEMENT,
    });
  });

  it("does not clear or acknowledge a chat rebound after the disconnect read", async () => {
    const oldChatId = "123456789";
    const newChatId = "987654321";
    const installation = await createInstallation(oldChatId);
    const pendingPairing = await createPendingPairing(installation.id);
    const telegramRequest = vi.fn(async () => successfulTelegramResponse());
    vi.stubGlobal("fetch", telegramRequest);
    let rebounded = false;
    const workerEnv = {
      ...testEnv(),
      DB: {
        prepare: env.DB.prepare.bind(env.DB),
        batch: async (statements: D1PreparedStatement[]) => {
          if (!rebounded) {
            rebounded = true;
            await env.DB.prepare("UPDATE installations SET telegram_chat_id = ? WHERE id = ?")
              .bind(newChatId, installation.id)
              .run();
          }
          return env.DB.batch(statements);
        },
      } as unknown as D1Database,
    } satisfies Env;

    const response = await worker.fetch(connectionRequest(INSTALLATION_CREDENTIAL, "DELETE"), workerEnv);

    expect(response.status).toBe(409);
    const responseBody = await response.text();
    expect(JSON.parse(responseBody)).toEqual({
      error: {
        code: "TELEGRAM_CONNECTION_CHANGED",
        message: "Telegram connection changed. Please try again.",
      },
    });
    expect(responseBody).not.toContain(oldChatId);
    expect(responseBody).not.toContain(newChatId);
    expect(rebounded).toBe(true);
    expect(
      await env.DB.prepare("SELECT telegram_chat_id FROM installations WHERE id = ?")
        .bind(installation.id)
        .first<{ telegram_chat_id: string | null }>(),
    ).toEqual({ telegram_chat_id: newChatId });
    expect(await env.DB.prepare("SELECT id FROM pairings WHERE id = ?").bind(pendingPairing.id).first())
      .toEqual({ id: pendingPairing.id });
    expect(telegramRequest).not.toHaveBeenCalled();
  });

  it("preserves unauthorized disconnect behavior and sends no acknowledgement", async () => {
    const installation = await createInstallation("123456789");
    const invalidCredential = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_abcdef";
    const telegramRequest = vi.fn(async () => successfulTelegramResponse());
    vi.stubGlobal("fetch", telegramRequest);

    const missing = await worker.fetch(connectionRequest(undefined, "DELETE"), testEnv());
    const invalid = await worker.fetch(connectionRequest(invalidCredential, "DELETE"), testEnv());
    await env.DB.prepare("UPDATE installations SET revoked_at = ? WHERE id = ?")
      .bind(Date.now(), installation.id)
      .run();
    const revoked = await worker.fetch(connectionRequest(INSTALLATION_CREDENTIAL, "DELETE"), testEnv());

    for (const response of [missing, invalid, revoked]) {
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: { code: "UNAUTHORIZED", message: "Installation authentication failed." },
      });
    }
    expect(telegramRequest).not.toHaveBeenCalled();
  });
});
