# Far Away From Codex Worker

This is the isolated Cloudflare Worker subproject for the official Far Away From Codex Telegram bot. Slice D adds anonymous-installation pairing with hash-based bearer authentication, one-time Telegram webhook pairing, and Telegram disconnect. Notification relay remains intentionally unimplemented.

## Local setup

1. Run `npm install` in this directory.
2. Copy `.dev.vars.example` to `.dev.vars` and replace its placeholder values for local development. Never commit `.dev.vars`.
3. Replace the non-secret `TELEGRAM_BOT_USERNAME` placeholder in `wrangler.jsonc` with the official bot username.
4. Create the D1 database and replace the non-secret `database_id` placeholder in `wrangler.jsonc`.
5. Choose unused positive-integer namespace IDs for `REGISTRATION_RATE_LIMITER`, `PAIRING_CREATION_RATE_LIMITER`, and `PAIRING_STATUS_RATE_LIMITER` in `wrangler.jsonc`; the checked-in IDs are placeholders.
6. Apply migrations locally with `npx wrangler d1 migrations apply DB --local`.

For a deployed Worker, configure secrets without putting their values in files:

```text
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

`TELEGRAM_BOT_USERNAME` and the D1 identifiers are non-secret configuration. No actual credentials belong in source, Wrangler configuration, logs, or migrations.

## Commands

```text
npm run typecheck
npm test
npm run dev
```
