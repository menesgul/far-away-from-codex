export interface Env {
  DB: D1Database;
  REGISTRATION_RATE_LIMITER: RateLimit;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  TELEGRAM_BOT_USERNAME: string;
}
