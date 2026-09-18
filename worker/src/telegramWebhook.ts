import type { Env } from "./env";
import { enforceRequestBounds, errorResponse, jsonResponse } from "./http";
import { hashPairingToken } from "./pairings";
import { TelegramBotClient } from "./telegram/TelegramBotClient";
import { withTimeout, WORKER_DEPENDENCY_TIMEOUT_MS } from "./timeout";

const START_TOKEN_PATTERN = /^\/start ([A-Za-z0-9_-]{43})$/;

export const TELEGRAM_PAIRING_ACKNOWLEDGEMENT = "\u2705 Connected to Far Away From Codex\n\n"
  + "This Telegram chat is now connected to your VS Code installation.\n"
  + "Turn Codex Alerts ON in VS Code to receive alerts here.";

interface TelegramMessageClient {
  sendMessage(chatId: string | number, text: string): Promise<void>;
}

export interface TelegramWebhookDependencies {
  createTelegramBotClient?: (botToken: string) => TelegramMessageClient;
}

interface TelegramUpdate {
  message?: {
    text?: unknown;
    chat?: {
      id?: unknown;
      type?: unknown;
    };
  };
}

function privateStart(update: unknown): { token: string; chatId: string } | undefined {
  if (typeof update !== "object" || update === null) {
    return undefined;
  }

  const message = (update as TelegramUpdate).message;
  if (
    message === undefined ||
    message.chat === undefined ||
    message.chat.type !== "private" ||
    typeof message.chat.id !== "number" ||
    !Number.isSafeInteger(message.chat.id) ||
    typeof message.text !== "string"
  ) {
    return undefined;
  }

  const tokenMatch = message.text.match(START_TOKEN_PATTERN);
  if (tokenMatch === null) {
    return undefined;
  }

  return { token: tokenMatch[1], chatId: String(message.chat.id) };
}

export async function handleTelegramWebhook(
  request: Request,
  env: Env,
  dependencies: TelegramWebhookDependencies = {},
): Promise<Response> {
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
    return errorResponse(401, "UNAUTHORIZED", "Webhook authentication failed.");
  }

  const boundsError = await enforceRequestBounds(request);
  if (boundsError !== undefined) {
    return boundsError;
  }

  let update: unknown;
  try {
    update = await withTimeout(request.json(), WORKER_DEPENDENCY_TIMEOUT_MS);
  } catch {
    return errorResponse(400, "INVALID_TELEGRAM_UPDATE", "Telegram update is invalid.");
  }

  const start = privateStart(update);
  if (start === undefined) {
    return jsonResponse({ ok: true });
  }

  const now = Date.now();
  // This marker is unique to this delivery. It lets the binding statement prove
  // that the preceding transition from unused to consumed belonged to this
  // request, rather than merely observing a matching timestamp from another.
  const consumeMarker = crypto.randomUUID();
  let result: D1Result<unknown>[];
  try {
    const tokenHash = await hashPairingToken(start.token);
    result = await withTimeout(
      env.DB.batch([
        env.DB
          .prepare(
            "UPDATE pairings SET used_at = ?, consumed_marker = ? " +
              "WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? " +
              "AND EXISTS (SELECT 1 FROM installations " +
              "WHERE installations.id = pairings.installation_id AND installations.revoked_at IS NULL)",
          )
          .bind(now, consumeMarker, tokenHash, now),
        env.DB
          .prepare(
            "UPDATE installations SET telegram_chat_id = ? " +
              "WHERE id = (SELECT installation_id FROM pairings WHERE token_hash = ? AND consumed_marker = ?) " +
              "AND revoked_at IS NULL",
          )
          .bind(start.chatId, tokenHash, consumeMarker),
      ]),
      WORKER_DEPENDENCY_TIMEOUT_MS,
    );
  } catch {
    return errorResponse(503, "WEBHOOK_UNAVAILABLE", "Webhook processing is temporarily unavailable.");
  }

  // A non-matching, expired, or replayed token is intentionally acknowledged without detail.
  if (result[0]?.meta.changes !== 1 || result[1]?.meta.changes !== 1) {
    return jsonResponse({ ok: true });
  }

  // D1 has already atomically consumed the pairing and bound the chat. The
  // acknowledgement is optional UX only: never let transport failure alter
  // that authoritative outcome or the webhook acknowledgement.
  try {
    const createTelegramBotClient = dependencies.createTelegramBotClient
      ?? ((botToken: string) => new TelegramBotClient(botToken));
    await createTelegramBotClient(env.TELEGRAM_BOT_TOKEN).sendMessage(
      start.chatId,
      TELEGRAM_PAIRING_ACKNOWLEDGEMENT,
    );
  } catch {
    // Telegram delivery failures are deliberately not surfaced or retried.
  }

  return jsonResponse({ ok: true });
}
