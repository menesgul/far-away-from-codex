# WORKPLAN_TODO.md — Active Implementation Slice

> **Current milestone:** M0 — Repository & Runtime Foundation
>
> **Current step:** M0.1 — Freeze Baseline & Regression Contract
>
> Implement **only this step**. Do not begin M0.2 or any later work.

## Why this step exists

M0 will move package boundaries and later introduce a standalone Companion. Before changing repository layout or runtime ownership, establish a reproducible pre-migration behavioral baseline so later failures can be classified as:
- pre-existing,
- structural-migration regression,
- or new-runtime regression.

This step changes planning/baseline evidence only. It must not perform the repository migration itself.

## Locked baseline

Git baseline for M0:

`e5e6fab28983cba22cc2f5506eaf6e0f9270b54d`

Expected baseline shape:
- root = VS Code extension npm package;
- `src/` = extension implementation and tests;
- `worker/` = Cloudflare Worker npm project and tests;
- Telegram pairing/connect/disconnect foundation exists;
- no standalone Companion exists.

If the working branch no longer matches this assumption, stop and report the divergence rather than rewriting the baseline.

## Tasks

- [ ] Record the exact baseline commit SHA used for the migration.
- [ ] Inventory the current root VS Code build, lint, compile, and test commands from repository configuration.
- [ ] Inventory the current Worker build/test commands and Cloudflare test configuration.
- [ ] Run or otherwise verify the existing VS Code extension test suite from the baseline environment.
- [ ] Run or otherwise verify the existing Worker test suite from the baseline environment.
- [ ] Record test counts/results and any pre-existing failures separately for root and Worker.
- [ ] Identify the tests that protect Telegram pairing creation/expiry/single-use/race behavior.
- [ ] Identify the tests that protect Telegram connection lookup and disconnect behavior.
- [ ] Identify the tests that protect installation registration/authentication/revocation behavior.
- [ ] Identify extension-side tests protecting QR/onboarding/pairing-session/connect/disconnect behavior.
- [ ] Identify tests whose assertions are coupled to current file paths/package layout rather than user-visible behavior.
- [ ] Classify each migration-critical test group as **behavioral regression contract**, **security regression contract**, or **structure-coupled test**.
- [ ] Record any behavior that is currently implemented but insufficiently covered and would be at risk during M0.2/M0.3.
- [ ] Define the explicit regression gate that M0.2 and M0.3 must preserve.
- [ ] Produce a concise M0.1 completion record in this file under `Completion Evidence`.

## Regression contract to freeze

At minimum, preserve the current behavior represented by:
- installation registration and credential validation;
- pairing token generation and expiry;
- one-time pairing consumption;
- concurrent/racing pairing safety;
- private Telegram chat binding rules;
- Telegram webhook secret validation;
- Telegram connection lookup semantics;
- disconnect idempotency/rebind safety/concurrent-delete behavior;
- extension QR-first connect flow;
- explicit open/copy/cancel pairing UX where currently covered;
- extension pairing polling/session behavior;
- onboarding behavior where currently covered;
- secret-storage behavior where currently covered;
- bounded HTTP/Telegram client behavior and timeout/error handling where currently covered.

This list freezes existing useful behavior for migration safety. It does **not** promote the old anonymous bearer identity model, extension-owned cloud state, or `telegram_chat_id` installation schema into target architecture.

## Acceptance criteria

M0.1 is complete only when:

- [ ] baseline SHA is explicit and reproducible;
- [ ] root and Worker test commands are known;
- [ ] baseline test results are recorded;
- [ ] any pre-existing failures are explicitly separated from migration regressions;
- [ ] migration-critical Telegram/security behavior is mapped to concrete tests;
- [ ] structure-coupled tests are identified before paths are moved;
- [ ] known coverage gaps relevant to M0.2/M0.3 are recorded;
- [ ] an explicit regression gate exists for the next structural steps;
- [ ] no repository/package/runtime migration has been performed.

## Do not

During M0.1:
- do not create `apps/` or `packages/`;
- do not move `src/`;
- do not move `worker/`;
- do not create Companion;
- do not introduce IPC;
- do not introduce SQLite;
- do not rewrite authentication;
- do not change Telegram behavior;
- do not rename product/runtime concepts in code;
- do not implement an agent adapter;
- do not modify production behavior merely to make a test easier to classify.

If a baseline test is broken, record it first. Fixing it is a separate explicitly approved action unless the failure prevents establishing the baseline at all.

## Completion Evidence

**Status:** EXECUTED; AWAITING REVIEW

- baseline commit: `e5e6fab28983cba22cc2f5506eaf6e0f9270b54d`. It is an ancestor of the execution commit `7369ea3dcbf79e5719193cb4325737e0e8538bcf`; the three intervening commits change only `ARCHITECTURE.md`, `WORKPLAN.md`, and `WORKPLAN_TODO.md`. The working tree was clean before evidence was recorded, and the expected root `src/` plus `worker/` baseline shape remains intact.
- environment/tool versions relevant to reproducibility: Windows x64; Node.js `v22.17.1`; npm `10.9.2`; Git `2.47.1.windows.1`; TypeScript `6.0.3`; ESLint `10.10.0`; `@vscode/test-cli` `0.0.15`; existing VS Code Electron test runtime `1.138.0` (compatible with the extension's `^1.137.0` engine); Vitest `4.1.11`; Wrangler declared/installed as `4.131.2`.
- root command inventory: `npm run vscode:prepublish` -> `npm run compile`; `npm run compile` -> `tsc -p ./` (compile/typecheck plus emit); `npm run lint` -> `eslint src`; `npm test` -> pretest `npm run compile && npm run lint`, then `vscode-test`; `npm run watch` -> `tsc -watch -p ./`. There is no separate root `build` or `typecheck` script.
- root commands executed: `npm test` reached successful compile and lint, then attempted to resolve/download VS Code `1.140.0`; a duplicate attempt contended on the same download and was stopped. The reproducible suite execution was completed with the already-installed compatible runtime via `npx vscode-test --code-version 1.138.0` after the same compile and lint gate had passed.
- root test result: PASS — `92 passing` across 11 suites; compile PASS; lint PASS. The Electron runner exited `0`.
- Worker command/config inventory: `npm run typecheck` -> `tsc --noEmit`; `npm test` -> `vitest run`; `npm run dev` -> `wrangler dev`; `npm run deploy` -> `wrangler deploy`. There is no separate Worker build or lint script. `worker/vitest.config.ts` uses `@cloudflare/vitest-plugin`, loads `worker/wrangler.jsonc`, injects test Telegram bindings, reads D1 migrations from `worker/migrations`, and applies them through `worker/test/apply-migrations.ts`. Wrangler targets `worker/src/index.ts`, compatibility date `2026-09-15`, D1, three rate-limit bindings, and required Telegram secrets.
- Worker commands executed: from `worker/`, `npm run typecheck` and `npm test`.
- Worker test result: PASS — typecheck exited `0`; Vitest reported `6 passed` files and `73 passed` tests in `14.41s`. The test runner emitted expected Wrangler warnings that real Telegram secrets were absent; test bindings supplied the test values.
- pre-existing failures: none in compile, lint, root tests, Worker typecheck, or Worker tests. The default root runner's current-version download contention and sandboxed Electron `spawn EPERM` were environment/runner issues, not test failures; pinning the existing `1.138.0` runtime and allowing Electron launch produced the green result above.
- migration-critical test map:
  - **Security regression contract:** `worker/test/installations.test.ts` (14 tests: one-time credential return/hash-only storage, registration failure/rate limits, authentication, revocation, bounded failures, revoke cleanup); `worker/test/pairings.test.ts` (17 tests: five-minute/hash-only creation, expiry, owner-only status, rate limits, authenticated webhook handling, private-chat-only binding, one-time/replay/same-millisecond race safety, connection/revocation races, acknowledgement failure); `worker/test/telegramConnection.test.ts` (15 tests: lookup without chat-ID disclosure, credential/revocation checks, throttling, authoritative disconnect, idempotency, concurrent delete, and rebind safety); `worker/test/telegramBotClient.test.ts` (12 tests: input/response bounds, timeout, safe errors, and no blind retry); the request-bound/configuration checks in `worker/test/routing.test.ts`; `src/test/ui/TelegramPairingPanel.test.ts` (3 tests: local QR, CSP/no token exposure, exact action messages); and `src/test/state/SecretStore.test.ts` (1 test: credential-only secret storage).
  - **Behavioral regression contract:** `src/test/backend/BackendClient.test.ts` (18 runtime tests: lazy registration, credential reuse/reset, pairing/status/connection/disconnect HTTP contracts and bounded failures); `src/test/state/TelegramConnectionState.test.ts` (6); `src/test/state/TelegramConnectionStateRefresh.test.ts` (5); `src/test/telegram/TelegramAlertsToggleCommand.test.ts` (9); `src/test/telegram/TelegramConnectCommand.test.ts` (14); `src/test/telegram/TelegramDisconnectCommand.test.ts` (12); `src/test/telegram/TelegramOnboarding.test.ts` (12); `src/test/telegram/TelegramPairingSession.test.ts` (8); the visible QR/panel behavior in `src/test/ui/TelegramPairingPanel.test.ts`; `worker/test/routing.test.ts` (12); and `worker/test/d1.test.ts` (3 schema-foundation tests).
  - **Structure-coupled test:** all 4 tests in `src/test/extension.test.ts` read `../../package.json` and fixed `../../src/...` paths and assert implementation source strings. Their security/behavioral intent remains part of the gate, but the assertions must be deliberately relocated or replaced when M0.3 moves the extension. Other suites use relative source imports; those imports and the `.vscode-test.mjs` `out/test/**/*.test.js`, root `tsconfig.json` `src`/`out`, `worker/vitest.config.ts` config/migration paths, and `worker/test/env.d.ts` main-module path are harness path coupling rather than user-visible assertions.
- structure-coupled tests: specifically `src/test/extension.test.ts` (4 source/package-layout assertions), plus the test-discovery/configuration paths listed above. No other test was found whose assertion depends on the current repository file location; ordinary relative imports will still require mechanical updates during M0.3.
- coverage gaps: no end-to-end extension-to-Worker contract test (extension HTTP tests mock responses while Worker routes are tested separately); no test activates the packaged extension and invokes the contributed commands/status bar/webview through real VS Code registration (the four extension tests inspect source text); webhook authentication covers a missing secret but not an explicitly incorrect secret; `SecretStore` uses a fake `SecretStorage` rather than VS Code persistence; and there is no fresh-install/package smoke test or Worker lint/build-only gate. These are gaps to protect manually or add in an explicitly authorized later slice, not reasons to change behavior in M0.1.
- regression gate: M0.2 and M0.3 must keep root compile and lint green, retain all 92 root behavioral/security assertions (with an explicit one-to-one replacement for any relocated structure-coupled assertion), keep Worker typecheck green, and retain all 73 Worker assertions. Test counts must not decrease silently. The installation/authentication/revocation, pairing TTL/hash/one-time/race/private-chat/webhook, lookup/disconnect/concurrent-rebind, QR/open-copy-cancel/session/onboarding/secret-storage, and bounded HTTP/Telegram semantics above must remain unchanged. Runner/config paths may change only as required by the structural move; no production behavior change is authorized.
- notes: only this `Completion Evidence` section was changed. No `apps/` or `packages/` directories were created, no source or Worker files were moved, no production code/runtime behavior was modified, and M0.1 remains unchecked in `WORKPLAN.md` pending review.

Do not mark M0.1 complete in `WORKPLAN.md` until this evidence has been reviewed.
