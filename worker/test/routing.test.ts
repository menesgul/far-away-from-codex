import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import {
  enforceRequestBounds,
  MAX_REQUEST_BODY_BYTES,
  REQUEST_BODY_READ_TIMEOUT_MS,
} from "../src/http";
import { OperationTimeoutError, withTimeout } from "../src/timeout";

describe("Worker routing and request safety", () => {
  it("returns a healthy response when configuration and D1 are available", async () => {
    const response = await exports.default.fetch("https://worker.example/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns a safe not-found response for an unimplemented route", async () => {
    const response = await exports.default.fetch("https://worker.example/v1/pairings");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Route not found." },
    });
  });

  it("rejects unsupported methods", async () => {
    const response = await exports.default.fetch("https://worker.example/health", {
      method: "POST",
    });

    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({
      error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." },
    });
  });

  it("rejects oversized request bodies before routing", async () => {
    const response = await exports.default.fetch("https://worker.example/not-implemented", {
      method: "POST",
      body: "x".repeat(MAX_REQUEST_BODY_BYTES + 1),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: { code: "REQUEST_BODY_TOO_LARGE", message: "Request body is too large." },
    });
  });

  it("keeps a bounded request body readable after validation", async () => {
    const body = JSON.stringify({ value: "still readable" });
    const request = new Request("https://worker.example/not-implemented", {
      method: "POST",
      body,
    });

    expect(await enforceRequestBounds(request)).toBeUndefined();
    expect(request.bodyUsed).toBe(false);
    expect(await request.text()).toBe(body);
  });

  it("returns a bounded timeout for a body stream that never finishes", async () => {
    const request = new Request("https://worker.example/not-implemented", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined),
      }),
    });

    const response = await enforceRequestBounds(request, 10);

    expect(response).toBeDefined();
    expect(response?.status).toBe(408);
    expect(await response?.json()).toEqual({
      error: {
        code: "REQUEST_BODY_TIMEOUT",
        message: "Request body could not be read in time.",
      },
    });
    expect(request.bodyUsed).toBe(false);
    expect(REQUEST_BODY_READ_TIMEOUT_MS).toBe(5_000);
  });

  it("rejects an oversized streamed body while preserving the original request body", async () => {
    const body = new Uint8Array(MAX_REQUEST_BODY_BYTES + 1);
    const request = new Request("https://worker.example/not-implemented", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body);
          controller.close();
        },
      }),
    });

    const response = await enforceRequestBounds(request);

    expect(response?.status).toBe(413);
    expect(request.bodyUsed).toBe(false);
    expect((await request.arrayBuffer()).byteLength).toBe(MAX_REQUEST_BODY_BYTES + 1);
  });

  it("bounds pending operations with a timeout", async () => {
    const pendingOperation = new Promise<never>(() => undefined);

    await expect(withTimeout(pendingOperation, 10)).rejects.toBeInstanceOf(OperationTimeoutError);
  });

  it("fails safely when required configuration is missing", async () => {
    const response = await worker.fetch(
      new Request("https://worker.example/health"),
      { ...env, TELEGRAM_BOT_TOKEN: "" },
    );

    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain("Worker configuration is incomplete.");
    expect(body).not.toContain("TELEGRAM_BOT_TOKEN");
  });

  it("reports unhealthy when the registration rate limiter binding is missing", async () => {
    const response = await worker.fetch(
      new Request("https://worker.example/health"),
      { ...env, REGISTRATION_RATE_LIMITER: undefined } as unknown as Env,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "SERVICE_UNAVAILABLE", message: "Worker configuration is incomplete." },
    });
  });

  it("reports unhealthy when the registration rate limiter binding is invalid", async () => {
    const response = await worker.fetch(
      new Request("https://worker.example/health"),
      { ...env, REGISTRATION_RATE_LIMITER: {} } as unknown as Env,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "SERVICE_UNAVAILABLE", message: "Worker configuration is incomplete." },
    });
  });

  it("does not expose dependency errors", async () => {
    const sensitiveDetail = "internal database detail";
    const failingDatabase = {
      prepare(): D1PreparedStatement {
        throw new Error(sensitiveDetail);
      },
    } as unknown as D1Database;

    const response = await worker.fetch(
      new Request("https://worker.example/health"),
      { ...env, DB: failingDatabase },
    );

    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain("Worker dependency is unavailable.");
    expect(body).not.toContain(sensitiveDetail);
  });
});
