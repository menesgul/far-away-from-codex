import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TelegramBotClient,
  TELEGRAM_SEND_MESSAGE_MAX_RESPONSE_BYTES,
  TELEGRAM_SEND_MESSAGE_MAX_TEXT_LENGTH,
} from "../src/telegram/TelegramBotClient";

const BOT_TOKEN = "test-bot-token";
const CHAT_ID = "123456789";
const MESSAGE_TEXT = "outgoing private message";
const SENSITIVE_RESPONSE_DETAIL = "telegram-sensitive-response-detail";
const MALFORMED_RESPONSE_DETAIL = "not-json";

function successfulResponse(): Response {
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function clientWith(fetchImplementation: typeof fetch, timeoutMs?: number): TelegramBotClient {
  return new TelegramBotClient(BOT_TOKEN, { fetch: fetchImplementation, timeoutMs });
}

async function expectSafeFailure(
  operation: Promise<void>,
  expectedMessage: string,
  additionalForbiddenDetails: readonly string[] = [],
): Promise<void> {
  await expect(operation).rejects.toThrow(expectedMessage);
  await operation.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    for (const secret of [
      BOT_TOKEN,
      CHAT_ID,
      MESSAGE_TEXT,
      SENSITIVE_RESPONSE_DETAIL,
      ...additionalForbiddenDetails,
    ]) {
      expect(message).not.toContain(secret);
    }
  });
}

describe("TelegramBotClient", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("performs exactly one JSON POST to Telegram sendMessage", async () => {
    const request = vi.fn(async () => successfulResponse());
    const client = clientWith(request as unknown as typeof fetch);

    await client.sendMessage(CHAT_ID, MESSAGE_TEXT);

    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/bottest-bot-token/sendMessage");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json; charset=utf-8" });
    expect(init.body).toBe(JSON.stringify({ chat_id: CHAT_ID, text: MESSAGE_TEXT }));
  });

  it("rejects empty text before fetch", async () => {
    const request = vi.fn() as unknown as typeof fetch;

    await expectSafeFailure(
      clientWith(request).sendMessage(CHAT_ID, ""),
      "Telegram message input is invalid.",
    );

    expect(request).toHaveBeenCalledTimes(0);
  });

  it("rejects over-limit text before fetch", async () => {
    const request = vi.fn() as unknown as typeof fetch;

    await expectSafeFailure(
      clientWith(request).sendMessage(CHAT_ID, "x".repeat(TELEGRAM_SEND_MESSAGE_MAX_TEXT_LENGTH + 1)),
      "Telegram message input is invalid.",
    );

    expect(request).toHaveBeenCalledTimes(0);
  });

  it("rejects invalid chat IDs before fetch", async () => {
    const request = vi.fn() as unknown as typeof fetch;

    await expectSafeFailure(
      clientWith(request).sendMessage("not-a-chat-id", MESSAGE_TEXT),
      "Telegram message input is invalid.",
    );

    expect(request).toHaveBeenCalledTimes(0);
  });

  it("converts a rejected network request into one safe failure without retrying", async () => {
    const request = vi.fn(async () => Promise.reject(new Error(SENSITIVE_RESPONSE_DETAIL))) as unknown as typeof fetch;

    await expectSafeFailure(
      clientWith(request).sendMessage(CHAT_ID, MESSAGE_TEXT),
      "Telegram message delivery failed.",
    );

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("bounds a timeout, aborts the request, and does not retry", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const request = vi.fn((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    }) as unknown as typeof fetch;
    const send = clientWith(request, 25).sendMessage(CHAT_ID, MESSAGE_TEXT);
    const expectedFailure = expectSafeFailure(send, "Telegram message delivery timed out.");

    await vi.advanceTimersByTimeAsync(25);
    await expectedFailure;

    expect(signal?.aborted).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("converts a non-success HTTP response into one safe failure without reading its body", async () => {
    const request = vi.fn(async () => new Response(SENSITIVE_RESPONSE_DETAIL, { status: 502 })) as unknown as typeof fetch;

    await expectSafeFailure(
      clientWith(request).sendMessage(CHAT_ID, MESSAGE_TEXT),
      "Telegram message delivery failed.",
    );

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed HTTP-success response data safely without retrying", async () => {
    const request = vi.fn(async () => new Response(MALFORMED_RESPONSE_DETAIL, { status: 200 })) as unknown as typeof fetch;

    await expectSafeFailure(
      clientWith(request).sendMessage(CHAT_ID, MESSAGE_TEXT),
      "Telegram message delivery failed.",
      [MALFORMED_RESPONSE_DETAIL],
    );

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects an HTTP-success response without the required result object", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;

    await expectSafeFailure(
      clientWith(request).sendMessage(CHAT_ID, MESSAGE_TEXT),
      "Telegram message delivery failed.",
    );

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects an unsuccessful Bot API result safely without retrying", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      description: SENSITIVE_RESPONSE_DETAIL,
    }), { status: 200 })) as unknown as typeof fetch;

    await expectSafeFailure(
      clientWith(request).sendMessage(CHAT_ID, MESSAGE_TEXT),
      "Telegram message delivery failed.",
    );

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("accepts the minimal valid Telegram success response", async () => {
    const request = vi.fn(async () => successfulResponse()) as unknown as typeof fetch;

    await expect(clientWith(request).sendMessage(CHAT_ID, MESSAGE_TEXT)).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects an oversized Telegram response safely without retrying", async () => {
    const request = vi.fn(async () => new Response(
      "x".repeat(TELEGRAM_SEND_MESSAGE_MAX_RESPONSE_BYTES + 1),
      { status: 200 },
    )) as unknown as typeof fetch;

    await expectSafeFailure(
      clientWith(request).sendMessage(CHAT_ID, MESSAGE_TEXT),
      "Telegram message delivery failed.",
    );

    expect(request).toHaveBeenCalledTimes(1);
  });
});
