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

**Status:** NOT STARTED

When the step is executed, replace this section with:

- baseline commit:
- environment/tool versions relevant to reproducibility:
- root commands executed:
- root test result:
- Worker commands executed:
- Worker test result:
- pre-existing failures:
- migration-critical test map:
- structure-coupled tests:
- coverage gaps:
- regression gate:
- notes:

Do not mark M0.1 complete in `WORKPLAN.md` until this evidence has been reviewed.
