export const TELEGRAM_SEND_MESSAGE_MAX_TEXT_LENGTH = 4_096;
export const TELEGRAM_SEND_MESSAGE_TIMEOUT_MS = 5_000;
export const TELEGRAM_SEND_MESSAGE_MAX_RESPONSE_BYTES = 16 * 1024;

const TELEGRAM_API_BASE_URL = "https://api.telegram.org";
const MAX_BOT_TOKEN_LENGTH = 512;
const MAX_CHAT_ID_LENGTH = 20;
const BOT_TOKEN_PATTERN = /^[A-Za-z0-9:_-]+$/;
const CHAT_ID_PATTERN = /^-?[1-9][0-9]{0,19}$/;

class TelegramRequestTimeoutError extends Error {}

class TelegramResponseError extends Error {}

export class TelegramBotClientError extends Error {}

export interface TelegramBotClientOptions {
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface TelegramApiSuccessResponse {
  ok: true;
  result: object;
}

/**
 * Owns a single, bounded Telegram Bot API sendMessage request. Callers provide
 * the Worker-held bot token and are responsible for all delivery semantics.
 */
export class TelegramBotClient {
  private readonly timeoutMs: number;
  private readonly request: typeof fetch;

  public constructor(
    private readonly botToken: string,
    options: TelegramBotClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? TELEGRAM_SEND_MESSAGE_TIMEOUT_MS;
    this.request = options.fetch ?? fetch;

    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TelegramBotClientError("Telegram message delivery failed.");
    }
    if (!this.isValidBotToken(this.botToken)) {
      throw new TelegramBotClientError("Telegram bot configuration is invalid.");
    }
  }

  public async sendMessage(chatId: string | number, text: string): Promise<void> {
    const normalizedChatId = this.normalizeChatId(chatId);
    this.assertValidText(text);

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.awaitWithAbort(
        this.request(`${TELEGRAM_API_BASE_URL}/bot${this.botToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify({ chat_id: normalizedChatId, text }),
          signal: controller.signal,
        }),
        controller.signal,
      );

      if (!response.ok) {
        throw new TelegramResponseError();
      }

      const payload = await this.readBoundedJson(response, controller.signal);
      if (!this.isTelegramApiSuccessResponse(payload)) {
        throw new TelegramResponseError();
      }
    } catch (error) {
      if (error instanceof TelegramRequestTimeoutError || controller.signal.aborted) {
        throw new TelegramBotClientError("Telegram message delivery timed out.");
      }
      throw new TelegramBotClientError("Telegram message delivery failed.");
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private normalizeChatId(value: string | number): string {
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || value === 0) {
        throw new TelegramBotClientError("Telegram message input is invalid.");
      }
      return String(value);
    }

    if (typeof value !== "string" || value.length > MAX_CHAT_ID_LENGTH || !CHAT_ID_PATTERN.test(value)) {
      throw new TelegramBotClientError("Telegram message input is invalid.");
    }
    return value;
  }

  private assertValidText(value: string): void {
    if (
      typeof value !== "string"
      || value.length === 0
      || Array.from(value).length > TELEGRAM_SEND_MESSAGE_MAX_TEXT_LENGTH
    ) {
      throw new TelegramBotClientError("Telegram message input is invalid.");
    }
  }

  private isValidBotToken(value: unknown): value is string {
    return typeof value === "string"
      && value.length > 0
      && value.length <= MAX_BOT_TOKEN_LENGTH
      && BOT_TOKEN_PATTERN.test(value);
  }

  private async readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
    if (response.body === null) {
      throw new TelegramResponseError();
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength !== null) {
      const parsedLength = Number(contentLength);
      if (
        !Number.isSafeInteger(parsedLength)
        || parsedLength < 0
        || parsedLength > TELEGRAM_SEND_MESSAGE_MAX_RESPONSE_BYTES
      ) {
        throw new TelegramResponseError();
      }
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await this.awaitWithAbort(reader.read(), signal);
        if (done) {
          break;
        }

        totalBytes += value.byteLength;
        if (totalBytes > TELEGRAM_SEND_MESSAGE_MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new TelegramResponseError();
        }
        chunks.push(value);
      }
    } catch (error) {
      if (signal.aborted) {
        void reader.cancel().catch(() => undefined);
      }
      throw error;
    } finally {
      reader.releaseLock();
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new TelegramResponseError();
    }
  }

  private isTelegramApiSuccessResponse(value: unknown): value is TelegramApiSuccessResponse {
    return typeof value === "object"
      && value !== null
      && (value as { ok?: unknown }).ok === true
      && Object.prototype.hasOwnProperty.call(value, "result")
      && typeof (value as { result?: unknown }).result === "object"
      && (value as { result?: unknown }).result !== null;
  }

  private async awaitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
      throw new TelegramRequestTimeoutError();
    }

    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new TelegramRequestTimeoutError());
      const cleanup = () => signal.removeEventListener("abort", abort);
      signal.addEventListener("abort", abort, { once: true });
      void operation.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    });
  }
}
