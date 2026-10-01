import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("D1 schema foundation", () => {
  it("creates the approved application tables plus migration metadata", async () => {
    const result = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all<{ name: string }>();

    expect(result.results.map(({ name }) => name)).toEqual([
      "d1_migrations",
      "installations",
      "pairings",
    ]);
  });

  it("creates the approved installation and pairing columns", async () => {
    const installationColumns = await env.DB.prepare("PRAGMA table_info(installations)").all<{
      name: string;
    }>();
    const pairingColumns = await env.DB.prepare("PRAGMA table_info(pairings)").all<{ name: string }>();

    expect(installationColumns.results.map(({ name }) => name)).toEqual([
      "id",
      "credential_hash",
      "telegram_chat_id",
      "created_at",
      "revoked_at",
    ]);
    expect(pairingColumns.results.map(({ name }) => name)).toEqual([
      "id",
      "installation_id",
      "token_hash",
      "expires_at",
      "used_at",
      "created_at",
      "consumed_marker",
    ]);
  });

  it("enforces unique credential and pairing-token hashes", async () => {
    await env.DB.prepare(
      "INSERT INTO installations (id, credential_hash, created_at) VALUES (?, ?, ?)",
    )
      .bind("installation-one", "credential-hash", 1)
      .run();

    await expect(
      env.DB.prepare("INSERT INTO installations (id, credential_hash, created_at) VALUES (?, ?, ?)")
        .bind("installation-two", "credential-hash", 2)
        .run(),
    ).rejects.toThrow();

    await env.DB.prepare(
      "INSERT INTO pairings (id, installation_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind("pairing-one", "installation-one", "pairing-token-hash", 100, 1)
      .run();

    await expect(
      env.DB.prepare(
        "INSERT INTO pairings (id, installation_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
      )
        .bind("pairing-two", "installation-one", "pairing-token-hash", 100, 2)
        .run(),
    ).rejects.toThrow();
  });
});
