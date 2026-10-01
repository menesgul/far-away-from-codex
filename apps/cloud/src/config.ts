import type { Env } from "./env";

const MAX_SECRET_LENGTH = 512;
const MAX_BOT_USERNAME_LENGTH = 64;
const USERNAME_PLACEHOLDER = "replace-with-official-bot-username";

function isConfigured(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximumLength;
}

function isRateLimiter(value: unknown): value is RateLimit {
  return (
    typeof value === "object" &&
    value !== null &&
    "limit" in value &&
    typeof value.limit === "function"
  );
}

export function hasRequiredConfiguration(env: Partial<Env>): env is Env {
  return (
    env.DB !== undefined &&
    typeof env.DB.prepare === "function" &&
    isRateLimiter(env.REGISTRATION_RATE_LIMITER) &&
    isRateLimiter(env.PAIRING_CREATION_RATE_LIMITER) &&
    isRateLimiter(env.PAIRING_STATUS_RATE_LIMITER) &&
    isConfigured(env.TELEGRAM_BOT_TOKEN, MAX_SECRET_LENGTH) &&
    isConfigured(env.TELEGRAM_WEBHOOK_SECRET, MAX_SECRET_LENGTH) &&
    isConfigured(env.TELEGRAM_BOT_USERNAME, MAX_BOT_USERNAME_LENGTH) &&
    env.TELEGRAM_BOT_USERNAME !== USERNAME_PLACEHOLDER
  );
}
