# WORKPLAN_TODO.md — Active Implementation Slice

> **Current milestone:** M0 — Repository & Runtime Foundation
>
> **Current step:** M0.3 — Move Existing Apps Without Behavior Change
>
> Implement **only this step**. Do not begin M0.4 or any later work.

## Why this step exists

M0.2 established one npm workspace/install graph while the repository root still temporarily doubled as the VS Code extension package. M0.3 removes that transitional ownership ambiguity.

This step physically isolates the two existing applications:

```text
existing root VS Code extension  → apps/vscode
worker/                          → apps/cloud
repository root                  → orchestration-only workspace root
```

This is a **mechanical application-boundary migration**. It must not change production behavior, runtime authority, Telegram semantics, authentication, or product capabilities.

M0.3 deliberately comes before domain/contracts/adapter packages and before Companion creation so structural-move regressions remain attributable to this move alone.

## Verified starting state

Starting branch: `planning/m0-foundation`.

M0.2 reviewed result:

- root is currently `private: true`;
- transitional npm workspaces = `["worker"]`;
- root is still the VS Code extension manifest/package;
- `worker/` is the Cloudflare Worker workspace;
- one canonical root `package-lock.json` exists;
- `worker/package-lock.json` is gone;
- root Node baseline is `>=22`;
- `tsconfig.base.json` contains only shared `strict` and ES2022 target invariants;
- extension retains Node16 semantics;
- Worker retains ESNext/Bundler/Cloudflare semantics;
- final M0.2 gate = extension compile/lint + **92 tests**, Worker typecheck + **73 tests across 6 files**, aggregate `npm run validate` PASS;
- no production source changed in M0.2.

Expected starting HEAD after the reviewed M0.2 commit:

`c8987f08821bfe241b8bd933b881aaf625df3e11`

If the local checkout does not contain the reviewed M0.2 result or has unrelated uncommitted changes, stop and report before moving files.

## Target shape for this slice

M0.3 should end with:

```text
far-away-from-codex/
├── apps/
│   ├── vscode/
│   │   ├── src/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── .vscode-test.mjs
│   │   └── extension packaging/support files as required
│   └── cloud/
│       ├── src/
│       ├── test/
│       ├── migrations/
│       ├── package.json
│       ├── tsconfig.json
│       ├── vitest.config.ts
│       ├── wrangler.jsonc
│       └── existing Cloud support files
├── package.json             # orchestration-only private workspace root
├── package-lock.json        # sole canonical lockfile
├── tsconfig.base.json
├── eslint.config.mjs        # may remain root-shared if behaviorally clean
├── ARCHITECTURE.md
├── WORKPLAN.md
└── WORKPLAN_TODO.md
```

Do **not** create `apps/companion` or any `packages/*` directory in this slice.

## Ownership decision

After M0.3, the repository root is **not a VS Code extension package**.

The extension package owns its own:

- VS Code manifest fields;
- extension name/version/displayName/description;
- `engines.vscode`;
- `activationEvents`;
- `main`;
- `contributes`;
- runtime dependency `qrcode`;
- extension-specific dev dependencies/scripts needed to compile, lint, test, watch, and package;
- extension source/tests and extension-specific test/packaging configuration.

The Cloud application owns its existing Worker package metadata, Wrangler/Vitest configuration, D1 migrations, tests, source, and Cloud-specific support files.

The root owns only repository-wide concerns:

- `private: true`;
- npm workspace membership;
- Node/toolchain baseline;
- orchestration scripts;
- canonical root lockfile;
- shared TypeScript/ESLint configuration where genuinely shared;
- architecture/workplan/docs.

Do not leave VS Code manifest fields at root merely for convenience.

## Workspace contract

Change workspace membership from transitional `worker/` to the actual application packages:

```text
apps/vscode
apps/cloud
```

Use explicit workspace paths in this slice. Do not add speculative `packages/*` globs before M0.4 creates those packages.

Keep one canonical root `package-lock.json`. There must be no nested application lockfiles.

Regenerate/update the root lock only as required to reflect package relocation. Preserve the M0.2 resolved dependency versions and declared dependency ranges. A physical workspace path change is expected; unrelated dependency churn is not.

A fresh root `npm ci --ignore-scripts` must succeed after the move.

## VS Code application move

Move the existing extension implementation/tests from root `src/` into `apps/vscode/src/` without semantic edits except path/config adjustments required by relocation.

Move or recreate extension-specific configuration beside the extension package where the tool expects package-relative paths, including:

- extension `package.json`;
- extension `tsconfig.json`;
- `.vscode-test.mjs`;
- `.vscodeignore` if required for package behavior;
- extension-specific packaging metadata/files required by the current extension workflow.

Do not rewrite `src/extension.ts`, `BackendClient`, Telegram commands/state/UI, or SecretStore for the future Companion architecture. Their current ownership is legacy and intentionally survives this slice. Ownership changes come later.

The extension must still expose exactly the same current commands/activation behavior and compile to its package-local output directory.

## Cloud application move

Move the existing `worker/` application as a unit to `apps/cloud/`.

Preserve:

- Worker package name/version;
- `src/`;
- `test/`;
- `migrations/`;
- `wrangler.jsonc`;
- `vitest.config.ts`;
- `tsconfig.json`;
- `.dev.vars.example`;
- package-local README/gitignore/support files.

Update only paths that became invalid because the package moved.

Wrangler must still target the same application entry point relative to the Cloud package. Vitest must still load the same Wrangler config, test bindings, and D1 migrations. No D1 schema or production route behavior may change.

## Root orchestration

Rewrite root scripts so they orchestrate the relocated workspaces rather than treating root as the extension package.

Required root gates:

- extension compile;
- extension lint;
- extension tests;
- Cloud typecheck;
- Cloud tests;
- aggregate `validate`.

The aggregate gate must remain side-effect free: no `dev`, `deploy`, D1 remote mutation, or other external action.

Prefer npm workspace targeting rather than shell `cd` chains.

Keep the reproducible pinned VS Code test runtime behavior established in M0.2 unless relocation gives a proven reason to change it.

## Structure-coupled tests and path repair

M0.1 explicitly identified structure coupling that must be handled in this slice.

In particular:

- `src/test/extension.test.ts` currently assumes the root extension manifest and fixed root `src/` paths;
- `.vscode-test.mjs` currently discovers `out/test/**/*.test.js`;
- extension `tsconfig.json` currently assumes root `src`/`out`;
- Worker Vitest config assumes package-relative Wrangler/migration paths;
- Worker test environment declarations may assume the old Worker path.

After relocation, repair these assumptions to their **new package-local equivalents**.

For the four structure-coupled extension tests, preserve the intent of each assertion one-for-one. Relocating an assertion is allowed; deleting or weakening it is not.

Ordinary relative imports that remain correct after moving a whole source tree should not be rewritten gratuitously.

## Root/shared config boundaries

Keep `tsconfig.base.json` at root. Update child `extends` paths for their new depth while preserving effective compiler semantics exactly:

- VS Code: Node16 semantics + existing Node/Mocha/DOM/VS Code environment;
- Cloud: ESNext + Bundler + Cloudflare/Vitest environment.

Use `tsc --showConfig` or equivalent comparison to verify no semantic drift beyond path/output relocation.

`eslint.config.mjs` may remain at root as shared tooling. Ensure extension lint targets the relocated extension source and produces the same result.

Do not invent a Cloud lint gate; M0.1/M0.2 froze Cloud typecheck + tests as the current contract.

## Repository-support files

Classify root support files before moving them.

Rules:

- architecture/workplan files remain root;
- root project README/LICENSE may remain repository-level unless the extension tool demonstrably requires package-local copies;
- extension-specific files belong under `apps/vscode`;
- Cloud-specific files move with `apps/cloud`;
- root development/editor configuration may remain root if it is repository-wide, but any paths inside it must be repaired if they reference the old layout.

Do not perform unrelated README/product-documentation cleanup in M0.3.

## Tasks

- [ ] Verify M0.2 is marked complete in `WORKPLAN.md`.
- [ ] Confirm starting HEAD and a clean working tree.
- [ ] Inventory root files that are extension-owned versus repository-owned before moving them.
- [ ] Create only `apps/vscode` and `apps/cloud`.
- [ ] Move the current extension `src/` tree to `apps/vscode/src/` preserving history/content.
- [ ] Move the extension manifest/package metadata and required package-local test/build/packaging config to `apps/vscode/`.
- [ ] Move the existing `worker/` application to `apps/cloud/` as a unit.
- [ ] Convert root `package.json` into an orchestration-only private workspace package.
- [ ] Set root workspaces explicitly to `apps/vscode` and `apps/cloud`.
- [ ] Preserve application package names, versions, declared dependency ranges, VS Code manifest behavior, and Cloud package behavior.
- [ ] Update root orchestration scripts to target relocated workspaces.
- [ ] Update the canonical root lockfile for the new workspace paths without unrelated resolution churn.
- [ ] Verify there are no nested application lockfiles.
- [ ] Repair extension TypeScript/config/test-discovery paths for package-local operation.
- [ ] Repair Cloud TypeScript/Vitest/Wrangler/migration/test paths only where relocation requires it.
- [ ] Repair all four M0.1 structure-coupled extension assertions one-for-one for the new layout.
- [ ] Inspect root `.vscode/`, ignore files, packaging files, and other path-bearing support config for relocation breakage.
- [ ] Verify effective TypeScript runtime/module/type semantics remain unchanged.
- [ ] Run a fresh root `npm ci --ignore-scripts`.
- [ ] Verify npm recognizes both `apps/vscode` and `apps/cloud` as workspaces.
- [ ] Run extension compile.
- [ ] Run extension lint.
- [ ] Run extension tests and retain **92 passing**.
- [ ] Run Cloud typecheck.
- [ ] Run Cloud tests and retain **73 passing across 6 files**.
- [ ] Run root aggregate `npm run validate`.
- [ ] Audit the final diff for semantic production-code edits versus pure moves/path repairs.
- [ ] Confirm old root `src/` and old `worker/` no longer remain as competing application locations.
- [ ] Confirm no `apps/companion` or `packages/*` work began.
- [ ] Record exact moves, config repairs, commands/results, test counts, lockfile review, and any deviations under Completion Evidence.

## Required regression gate

M0.3 must preserve the complete M0.1/M0.2 behavioral contract:

- extension compile: PASS;
- extension lint: PASS;
- extension tests: **92 passing**;
- Cloud typecheck: PASS;
- Cloud tests: **73 passing across 6 files**;
- aggregate root validation: PASS;
- no silent test-count decrease;
- installation registration/authentication/revocation semantics unchanged;
- pairing TTL/hash/single-use/race/private-chat/webhook semantics unchanged;
- Telegram connection lookup/disconnect/concurrent-rebind semantics unchanged;
- QR/open-copy-cancel/pairing-session/onboarding/secret-storage semantics unchanged;
- bounded HTTP/Telegram client behavior unchanged.

Moved production files should be byte-for-byte identical wherever path changes do not require an edit. Any production-source edit requires an explicit relocation necessity and must be called out in Completion Evidence.

## Acceptance criteria

M0.3 is complete only when:

- [ ] root is orchestration-only and no longer contains the VS Code extension manifest;
- [ ] `apps/vscode` is a valid npm workspace containing the existing extension;
- [ ] `apps/cloud` is a valid npm workspace containing the existing Worker;
- [ ] root workspaces contain exactly the application packages introduced in this slice;
- [ ] one canonical root lockfile installs both applications;
- [ ] no nested lockfile competes with root;
- [ ] fresh root install succeeds;
- [ ] extension manifest/commands/activation/runtime behavior are unchanged;
- [ ] Cloud Wrangler/Vitest/D1 behavior is unchanged;
- [ ] effective TypeScript runtime semantics are unchanged;
- [ ] all 92 extension tests pass;
- [ ] all 73 Cloud tests across 6 files pass;
- [ ] root aggregate validation passes;
- [ ] the four known structure-coupled assertions have one-for-one preserved intent;
- [ ] old root `src/` and `worker/` application locations are gone;
- [ ] no production capability or authority migration occurred;
- [ ] M0.4 has not started.

## Expected change shape

Large rename/move noise is expected.

Expected categories:

```text
src/**                         → apps/vscode/src/**
worker/**                      → apps/cloud/**
package.json                   → orchestration-only root manifest
apps/vscode/package.json       → extension manifest/package
package-lock.json              → workspace path updates
tsconfig.json                  → moved/replaced by apps/vscode/tsconfig.json
.vscode-test.mjs               → apps/vscode/.vscode-test.mjs
.vscodeignore                  → apps/vscode/.vscodeignore if package-owned
apps/cloud/tsconfig.json       → extends ../../tsconfig.base.json
apps/vscode/tsconfig.json      → extends ../../tsconfig.base.json
root scripts/config paths      → relocation repairs
WORKPLAN_TODO.md               → Completion Evidence only after execution
```

The final diff should predominantly be Git renames plus configuration/path changes, not logic rewrites.

## Do not

During M0.3:

- do not create Companion;
- do not create `apps/companion`;
- do not create `packages/domain`;
- do not create `packages/contracts`;
- do not create `packages/agent-adapter-sdk`;
- do not introduce IPC or SQLite;
- do not migrate BackendClient/SecretStore authority to Companion yet;
- do not change Telegram behavior;
- do not change D1 schema/routes;
- do not rewrite authentication;
- do not implement P-256/OAuth;
- do not add agent adapters or ACP;
- do not add routing/escalation/policy/inbox logic;
- do not rename existing commands/product identifiers;
- do not upgrade dependencies merely because files moved;
- do not delete/skip/weaken regression tests;
- do not perform unrelated code cleanup/refactoring;
- do not begin M0.4.

## Stop conditions

Stop and report rather than improvising if:

- moving the extension requires a production behavior change rather than a path/config repair;
- moving the Cloud app changes Wrangler/D1 runtime semantics;
- npm lock regeneration introduces unexplained dependency-version churn;
- extension test intent cannot be preserved after relocation;
- the baseline test counts cannot be reproduced;
- a root support file has ambiguous ownership and moving/duplicating it would alter packaging behavior;
- the move appears to require creating domain/contracts/Companion abstractions early.

A structural inconvenience is not permission to pull M0.4+ work into this slice.

## Completion Evidence

**Status:** EXECUTED — REGRESSION GATE PASS; AWAITING REVIEW

- starting commit: `000cef534ccd82b8f3009d45ce235af4319878ab` on `planning/m0-foundation`, with reviewed M0.2 commit `c8987f08821bfe241b8bd933b881aaf625df3e11` as its direct parent; working tree was clean and M0.2 was marked complete before execution.
- files/directories moved: root `src/` → `apps/vscode/src/`; root extension `package.json`, `tsconfig.json`, `.vscode-test.mjs`, `.vscodeignore`, `README.md`, `CHANGELOG.md`, and `vsc-extension-quickstart.md` → `apps/vscode/`; `worker/` → `apps/cloud/` as one application, including source, tests, migrations, Wrangler/Vitest config, package metadata, README, gitignore, and `.dev.vars.example`.
- root files retained and why: `ARCHITECTURE.md`, `WORKPLAN.md`, and `WORKPLAN_TODO.md` remain planning/architecture truth; `LICENSE` remains repository-level; `tsconfig.base.json` and `eslint.config.mjs` remain shared configuration; `.gitignore` remains repository-wide; `.vscode/` remains repository development configuration and its extension paths were repaired.
- extension package location/manifest result: `apps/vscode/package.json`; name/version/display name/description, VS Code engine, activation event, main entry, all four contributed commands, `qrcode` range, dev-dependency ranges, and extension scripts are preserved. The repository Node engine moved to the orchestration root as required.
- Cloud package location/result: `apps/cloud`; package name/version, source, tests, two D1 migrations, Wrangler entry/bindings/migration directory, Vitest bindings/setup/migration loading, and support files are preserved.
- workspace metadata: root is `far-away-from-codex-workspace`, `private: true`, with explicit workspaces exactly `apps/vscode` and `apps/cloud`; it contains no VS Code display/activation/main/contribution fields or application dependencies.
- canonical lockfile result: sole root `package-lock.json` migrated from the old root/`worker` workspace paths to `apps/vscode`/`apps/cloud`; both workspace links are present and `npm ci --ignore-scripts` succeeded.
- nested lockfiles: none outside `node_modules`; `rg --files -uu -g 'package-lock.json' -g '!**/node_modules/**'` returned only root `package-lock.json`.
- root orchestration changes: root scripts now target workspaces for extension compile/lint/pinned tests and Cloud typecheck/tests; `validate` runs all five gates without dev/deploy/remote mutation. Compatibility aliases `worker:typecheck` and `worker:test` delegate to the Cloud-named gates; root `watch` delegates to the extension workspace for the retained VS Code task.
- extension config/path repairs: extension `tsconfig.json` now extends `../../tsconfig.base.json`; package-local `src`, `out`, `.vscode-test.mjs`, and `.vscodeignore` behavior remains unchanged; root `.vscode/launch.json` points extension development/output paths at `apps/vscode`; root output visibility settings point at `apps/vscode/out`.
- Cloud config/path repairs: only `apps/cloud/tsconfig.json` changed, updating `extends` to `../../tsconfig.base.json`; Wrangler and Vitest configuration remained byte-for-byte unchanged because their package-relative paths stayed valid.
- structure-coupled test repairs: moving the complete extension package preserved every existing `../../package.json` and `../../src/...` lookup as the same package-local relationship, so no assertion rewrite was necessary. `apps/vscode/src/test/extension.test.ts` is byte-for-byte identical to the starting blob (`6ed3a88b99d6dae54a1afd06ea485cdb1da9d0b8`), and all four assertions passed.
- TypeScript effective-config comparison: pre/post `tsc --showConfig` outputs have identical effective compiler options and file sets apart from the intended package-relative output/exclude location. VS Code remains strict ES2022 + Node16 with Node/Mocha/DOM types and source maps; Cloud remains strict ES2022 + ESNext/Bundler with Cloudflare/Vitest types, `noEmit`, and `skipLibCheck`.
- clean install result: PASS — fresh root `npm ci --ignore-scripts` added 346 packages and audited 349 packages. npm reported the pre-existing audit total of 6 vulnerabilities (1 low, 3 moderate, 2 high); no audit fix or dependency upgrade was performed.
- workspace recognition result: PASS — `npm ls --workspaces --depth=0` recognized `far-away-from-codex@0.0.1 -> apps/vscode` and `far-away-from-codex-worker@0.0.1 -> apps/cloud`.
- extension compile result: PASS — `npm run extension:compile`.
- extension lint result: PASS — `npm run extension:lint`.
- extension test result/count: PASS — `npm run extension:test`, pinned to VS Code `1.137.0`, **92 passing**.
- Cloud typecheck result: PASS — `npm run cloud:typecheck`.
- Cloud test result/count: PASS — `npm run cloud:test`, **73 passing across 6 files**.
- aggregate validation result: PASS — `npm run validate` reran extension compile/lint/**92 tests** and Cloud typecheck/**73 tests across 6 files** successfully.
- dependency/lockfile review: declared dependency ranges are unchanged and a normalized comparison found exactly 346 versioned lock entries before and after with no added, removed, or changed package/version tuple. Lock changes are root/application ownership plus `worker` → `apps/cloud` path relocation and the new `apps/vscode` workspace link; there is no resolution churn.
- production source diff audit: PASS — Git blob comparison found zero content mismatches across moved extension production source, Cloud production source, and D1 migrations. No production `.ts` or SQL file was edited; changes are mechanical moves and config/path repairs only.
- old-location cleanup result: root `src/` and `worker/` no longer exist; applications live only at `apps/vscode` and `apps/cloud`.
- M0.4+ scope audit: `apps/companion` does not exist; `packages/` does not exist; no domain/contracts/adapter SDK, IPC, SQLite, Companion, agent adapter, routing, policy, inbox, authentication, Telegram semantic, or D1 schema work began.
- deviations/environment issues: no implementation deviation. npm 10.9.2 could not incrementally reconcile the physically relocated pre-move install/lock (`edgesOut` internal error), so generated `node_modules` trees were removed and the lock workspace paths were migrated mechanically; exact version-tuple comparison and the successful clean install verified the result. The sandbox first blocked registry/process spawning, and the VS Code archive download stalled; final gates ran outside the sandbox using the existing ignored pinned 1.137.0 test-runtime cache via a temporary ignored package-local junction, which was removed after verification. Cloud tests emitted the existing missing-local-secret warnings while using their configured test bindings.
- final regression-gate result: **PASS** — extension compile/lint/**92 tests**, Cloud typecheck/**73 tests across 6 files**, and aggregate validation all passed with no silent count decrease or production behavior change.
- notes: M0.3 is intentionally not marked complete in `WORKPLAN.md`; this evidence awaits review.

Do not mark M0.3 complete in `WORKPLAN.md` until this evidence has been reviewed.
