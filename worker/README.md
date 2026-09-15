# Far Away From Codex Worker

This is the isolated Cloudflare Worker subproject for the official Far Away From Codex Telegram bot. Slice C provides anonymous installation registration, hash-based bearer authentication, and installation reset/revocation on top of the Slice B foundation. Pairing, webhook processing, and notification relay are intentionally not implemented yet.

## Local setup

1. Run `npm install` in this directory.
2. Copy `.dev.vars.example` to `.dev.vars` and replace its placeholder values for local development. Never commit `.dev.vars`.
3. Replace the non-secret `TELEGRAM_BOT_USERNAME` placeholder in `wrangler.jsonc` with the official bot username.
4. Create the D1 database and replace the non-secret `database_id` placeholder in `wrangler.jsonc`.
5. Choose an unused positive-integer namespace ID for `REGISTRATION_RATE_LIMITER` in `wrangler.jsonc`; the checked-in `1001` is a placeholder.
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
