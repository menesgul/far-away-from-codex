import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { authenticateInstallation } from "../src/auth";
import { hashInstallationCredential } from "../src/credentials";
import type { Env } from "../src/env";
import worker from "../src/index";
import {
  registerInstallation as registerInstallationResponse,
  revokeInstallation,
} from "../src/installations";
import { REGISTRATION_RATE_LIMIT_RETRY_AFTER_SECONDS } from "../src/registrationRateLimit";

const TEST_INSTALLATION_CREDENTIAL = "abcdefghijklmnopqrstuvwxyz0123456789_ABCDEF";

interface RegistrationBody {
  installationCredential: string;
}

interface InstallationRow {
  id: string;
  credential_hash: string;
  telegram_chat_id: string | null;
  revoked_at: number | null;
}

class FakeRegistrationRateLimiter implements RateLimit {
  readonly keys: string[] = [];
  private attempts = 0;

  constructor(private readonly allowedAttempts = 10) {}

  async limit({ key }: RateLimitOptions): Promise<RateLimitOutcome> {
    this.keys.push(key);
    this.attempts += 1;
    return { success: this.attempts <= this.allowedAttempts };
  }
}

function registrationRequest(clientIp = "198.51.100.10"): Request {
  return new Request("https://worker.example/v1/installations", {
    method: "POST",
    headers: { "CF-Connecting-IP": clientIp },
  });
}

async function requestRegistration(
  rateLimiter: RateLimit = new FakeRegistrationRateLimiter(),
  clientIp?: string,
): Promise<Response> {
  return worker.fetch(registrationRequest(clientIp), {
    ...env,
    REGISTRATION_RATE_LIMITER: rateLimiter,
  });
}

async function registerInstallation(
  rateLimiter: RateLimit = new FakeRegistrationRateLimiter(),
): Promise<RegistrationBody> {
  const response = await requestRegistration(rateLimiter);

  expect(response.status).toBe(201);
  return response.json<RegistrationBody>();
}

function authenticatedRequest(credential?: string): Request {
  const headers = credential === undefined ? undefined : { Authorization: `Bearer ${credential}` };
  return new Request("https://worker.example/v1/installation", {
    method: "DELETE",
    headers,
  });
}

function environmentWithRegistrationWrite(
  run: () => Promise<unknown>,
): Env {
  return {
    ...env,
    DB: {
      prepare: () => ({
        bind: () => ({ run }),
      }),
    } as unknown as D1Database,
  };
}

function environmentWithRevocationOperations(
  lookup: () => Promise<{ id: string } | null>,
  batch: () => Promise<unknown>,
): Env {
  return {
    ...env,
    DB: {
      prepare: () => ({
        bind: () => ({ first: lookup }),
      }),
      batch,
    } as unknown as D1Database,
  };
}

describe("anonymous installation authentication", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM pairings"),
      env.DB.prepare("DELETE FROM installations"),
    ]);
  });

  it("returns a credential once and stores only its SHA-256 hash", async () => {
    const { installationCredential } = await registerInstallation();
    const rows = await env.DB.prepare(
      "SELECT id, credential_hash, telegram_chat_id, revoked_at FROM installations",
    ).all<InstallationRow>();

    expect(installationCredential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].credential_hash).toBe(
      await hashInstallationCredential(installationCredential),
    );
    expect(rows.results[0].credential_hash).not.toBe(installationCredential);
    expect(JSON.stringify(rows.results[0])).not.toContain(installationCredential);
  });

  it("does not return a credential when the D1 registration write times out", async () => {
    const response = await registerInstallationResponse(
      environmentWithRegistrationWrite(() => new Promise<never>(() => undefined)),
      5,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "REGISTRATION_UNAVAILABLE",
        message: "Installation registration is temporarily unavailable.",
      },
    });
  });

  it("does not expose failed D1 registration details or return a credential", async () => {
    const databaseDetail = "sensitive database detail";
    const response = await registerInstallationResponse(
      environmentWithRegistrationWrite(async () => Promise.reject(new Error(databaseDetail))),
    );
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).toContain("Installation registration is temporarily unavailable.");
    expect(body).not.toContain(databaseDetail);
    expect(body).not.toContain("installationCredential");
  });

  it("allows registration and keys the rate limiter with Cloudflare's client IP", async () => {
    const rateLimiter = new FakeRegistrationRateLimiter();
    const response = await requestRegistration(rateLimiter, "203.0.113.7");
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM installations").first<{
      count: number;
    }>();

    expect(response.status).toBe(201);
    expect(rateLimiter.keys).toEqual(["203.0.113.7"]);
    expect(count?.count).toBe(1);
  });

  it("rejects registration with a missing bot secret before rate limiting or D1 work", async () => {
    let rateLimiterCalled = false;
    const rateLimiter = {
      limit: async () => {
        rateLimiterCalled = true;
        return { success: true };
      },
    } as RateLimit;
    const response = await worker.fetch(registrationRequest(), {
      ...env,
      TELEGRAM_BOT_TOKEN: "",
      REGISTRATION_RATE_LIMITER: rateLimiter,
    });
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM installations").first<{
      count: number;
    }>();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "SERVICE_UNAVAILABLE", message: "Worker configuration is incomplete." },
    });
    expect(rateLimiterCalled).toBe(false);
    expect(count?.count).toBe(0);
  });

  it("rejects registration with the placeholder bot username without creating an installation", async () => {
    const response = await worker.fetch(registrationRequest(), {
      ...env,
      TELEGRAM_BOT_USERNAME: "replace-with-official-bot-username",
    });
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM installations").first<{
      count: number;
    }>();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "SERVICE_UNAVAILABLE", message: "Worker configuration is incomplete." },
    });
    expect(count?.count).toBe(0);
  });

  it("rejects registrations over the limit without creating additional D1 records", async () => {
    const rateLimiter = new FakeRegistrationRateLimiter(10);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await requestRegistration(rateLimiter, "203.0.113.8");
      expect(response.status).toBe(201);
    }

    const limitedResponse = await requestRegistration(rateLimiter, "203.0.113.8");
    const nextLimitedResponse = await requestRegistration(rateLimiter, "203.0.113.8");
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM installations").first<{
      count: number;
    }>();

    expect(limitedResponse.status).toBe(429);
    expect(limitedResponse.headers.get("Retry-After")).toBe(
      String(REGISTRATION_RATE_LIMIT_RETRY_AFTER_SECONDS),
    );
    expect(await limitedResponse.json()).toEqual({
      error: {
        code: "REGISTRATION_RATE_LIMITED",
        message: "Too many registration requests. Please try again later.",
      },
    });
    expect(nextLimitedResponse.status).toBe(429);
    expect(count?.count).toBe(10);
  });

  it("fails closed when the registration rate limiter hangs without inserting into D1", async () => {
    const hangingRateLimiter = {
      limit: () => new Promise<RateLimitOutcome>(() => undefined),
    } as RateLimit;
    const response = await requestRegistration(hangingRateLimiter, "203.0.113.9");
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM installations").first<{
      count: number;
    }>();

    expect(response?.status).toBe(503);
    expect(await response?.json()).toEqual({
      error: {
        code: "REGISTRATION_UNAVAILABLE",
        message: "Registration is temporarily unavailable. Please try again later.",
      },
    });
    expect(count?.count).toBe(0);
  });

  it("authenticates a valid credential", async () => {
    const { installationCredential } = await registerInstallation();

    const result = await authenticateInstallation(
      authenticatedRequest(installationCredential),
      env.DB,
    );

    expect(result.authenticated).toBe(true);
  });

  it("rejects missing and invalid credentials with the same safe response", async () => {
    const missingResponse = await exports.default.fetch(authenticatedRequest());
    const invalidResponse = await exports.default.fetch(
      authenticatedRequest("invalid_credential_value_that_is_long_enough"),
    );

    expect(missingResponse.status).toBe(401);
    expect(invalidResponse.status).toBe(401);
    expect(await missingResponse.json()).toEqual({
      error: { code: "UNAUTHORIZED", message: "Installation authentication failed." },
    });
    expect(await invalidResponse.json()).toEqual({
      error: { code: "UNAUTHORIZED", message: "Installation authentication failed." },
    });
  });

  it("rejects a revoked credential", async () => {
    const { installationCredential } = await registerInstallation();
    await env.DB.prepare("UPDATE installations SET revoked_at = ?").bind(Date.now()).run();

    const result = await authenticateInstallation(
      authenticatedRequest(installationCredential),
      env.DB,
    );
    const response = await exports.default.fetch(authenticatedRequest(installationCredential));

    expect(result.authenticated).toBe(false);
    expect(response.status).toBe(401);
  });

  it("returns a bounded safe failure when the revocation lookup hangs", async () => {
    const response = await revokeInstallation(
      authenticatedRequest(TEST_INSTALLATION_CREDENTIAL),
      environmentWithRevocationOperations(
        () => new Promise<never>(() => undefined),
        async () => [],
      ),
      5,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "INSTALLATION_RESET_UNAVAILABLE",
        message: "Installation reset is temporarily unavailable.",
      },
    });
  });

  it("returns a bounded safe failure when the revocation batch hangs", async () => {
    const response = await revokeInstallation(
      authenticatedRequest(TEST_INSTALLATION_CREDENTIAL),
      environmentWithRevocationOperations(
        async () => ({ id: "installation-id" }),
        () => new Promise<never>(() => undefined),
      ),
      5,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "INSTALLATION_RESET_UNAVAILABLE",
        message: "Installation reset is temporarily unavailable.",
      },
    });
  });

  it("revokes the credential, clears chat association, and deletes pending pairings", async () => {
    const { installationCredential } = await registerInstallation();
    const installation = await env.DB.prepare("SELECT id FROM installations").first<{ id: string }>();
    expect(installation).not.toBeNull();

    await env.DB.batch([
      env.DB
        .prepare("UPDATE installations SET telegram_chat_id = ? WHERE id = ?")
        .bind("123456789", installation!.id),
      env.DB
        .prepare(
          "INSERT INTO pairings (id, installation_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind("pending-pairing", installation!.id, "pending-token-hash", Date.now() + 60_000, Date.now()),
      env.DB
        .prepare(
          "INSERT INTO pairings (id, installation_id, token_hash, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind("used-pairing", installation!.id, "used-token-hash", Date.now(), Date.now(), Date.now()),
    ]);

    const response = await exports.default.fetch(authenticatedRequest(installationCredential));
    expect(response.status).toBe(204);

    const row = await env.DB.prepare(
      "SELECT id, credential_hash, telegram_chat_id, revoked_at FROM installations WHERE id = ?",
    )
      .bind(installation!.id)
      .first<InstallationRow>();
    const pairings = await env.DB.prepare(
      "SELECT id FROM pairings WHERE installation_id = ? ORDER BY id",
    )
      .bind(installation!.id)
      .all<{ id: string }>();

    expect(row?.revoked_at).not.toBeNull();
    expect(row?.telegram_chat_id).toBeNull();
    expect(pairings.results.map(({ id }) => id)).toEqual(["used-pairing"]);

    const authentication = await authenticateInstallation(
      authenticatedRequest(installationCredential),
      env.DB,
    );
    expect(authentication.authenticated).toBe(false);
  });
});
