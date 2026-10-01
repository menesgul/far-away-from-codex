# WORKPLAN_TODO.md — Active Implementation Slice

> **Current milestone:** M0 — Repository & Runtime Foundation
>
> **Current step:** M0.2 — Introduce npm Workspace Root
>
> Implement **only this step**. Do not begin M0.3 or any later work.

## Why this step exists

M0.1 froze the pre-migration regression contract. M0.2 now introduces the package-manager/tooling foundation needed for the repository to become a monorepo, while deliberately leaving the existing VS Code extension and Cloud Worker in their current locations.

This is a **workspace/tooling migration only**. Source relocation belongs to M0.3.

The repository must remain behaviorally equivalent after this step.

## Starting state

M0.1 is reviewed and complete.

Current repository shape:

```text
far-away-from-codex/
├── src/                    # VS Code extension implementation/tests
├── worker/                 # Cloudflare Worker package
│   ├── package.json
│   ├── package-lock.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   └── ...
├── package.json            # currently both repo root and VS Code extension manifest
├── package-lock.json
├── tsconfig.json
├── eslint.config.mjs
└── .vscode-test.mjs
```

Important current facts:

- root package is still the VS Code extension package;
- `worker/` is a separate npm package;
- both currently use TypeScript 6.x;
- root extension compilation uses Node16 module semantics;
- Worker uses ESNext + Bundler module semantics and Cloudflare-specific types/tooling;
- M0.1 baseline is 92 passing VS Code tests plus green compile/lint;
- M0.1 baseline is 73 passing Worker tests across 6 files plus green Worker typecheck;
- there are currently two package lockfiles;
- no `apps/`, `packages/`, Companion, IPC, or canonical-domain packages exist yet.

## M0.2 design decision

Use **npm workspaces**. Do not introduce pnpm, Yarn, Nx, Turborepo, or another monorepo orchestrator.

For this transitional slice, the repository root may remain both:

1. the existing VS Code extension package, and
2. the npm workspace root.

That temporary dual role is intentional. It avoids moving `src/` before M0.3 while still establishing a single root install graph.

The only existing child workspace in M0.2 is:

```text
worker/
```

Do **not** create placeholder `apps/*` or `packages/*` directories merely to match the final architecture.

M0.3 will move the existing application packages into their final `apps/vscode` and `apps/cloud` locations and finish separating the repository root from the VS Code package.

## Package-manager contract

The root `package.json` must become the npm workspace authority without changing the extension manifest behavior.

Required root metadata:

- keep the current VS Code extension manifest fields intact;
- add `private: true`;
- add npm `workspaces` containing the current Worker package path;
- declare a Node.js baseline compatible with the current toolchain: Node 22.x or newer within the supported major policy chosen by the implementation; do not silently require an older runtime than current Cloudflare tooling supports;
- do not rename the extension/package/product in this slice.

Use the root `package-lock.json` as the canonical workspace lockfile after migration.

The nested `worker/package-lock.json` must no longer remain a competing install authority once the root workspace lock is successfully generated and verified. Remove it only as part of the verified workspace-lock migration, not before.

Do not perform dependency upgrades merely because `npm install` produces a newer compatible transitive resolution. Prefer preserving the existing declared dependency ranges and observed behavior. Any unavoidable lockfile resolution change must be inspectable in the diff and must not be accompanied by unrelated package-version edits.

## Root orchestration contract

Add explicit root commands that make the repository operable from one entry point.

At minimum provide root-level orchestration for:

- extension compile;
- extension lint;
- extension tests;
- Worker typecheck;
- Worker tests;
- an aggregate validation command suitable for migration gates.

Prefer clear scripts over shell-specific command chains. They must work on Windows, since the current development baseline is Windows/PowerShell.

Do not make `dev` or `deploy` part of aggregate validation. Deployment must never happen as a side effect of build/test/typecheck.

Preserve the existing extension commands required by VS Code tooling, including `vscode:prepublish`, `compile`, `watch`, `lint`, and `test`, unless an exact behavior-preserving alias is needed.

Worker `dev`, `deploy`, `typecheck`, and `test` remain package-local responsibilities and must still be runnable through npm workspace targeting.

## TypeScript configuration

Create `tsconfig.base.json` only for **genuinely shared compiler invariants**.

It must not force runtime-specific module semantics across applications.

In particular:

- VS Code extension may retain Node16 module semantics;
- Cloud Worker must retain its ESNext/Bundler/Cloudflare semantics;
- Cloudflare-specific types must not leak into the root/extension configuration;
- VS Code-specific types must not leak into the Worker configuration;
- no future Companion assumptions should be encoded yet.

If extending the base config would cause semantic churn in this slice, keep package configs explicit and make the base intentionally minimal. The existence of a base config is not a reason to rewrite working compiler settings.

## ESLint/tooling boundary

Keep the existing root ESLint configuration functional for the current extension.

Do not attempt the final multi-package lint architecture in M0.2 unless required for the aggregate validation gate.

The Worker currently has no lint script. Do not invent a Worker lint migration solely to increase symmetry; M0.1 froze Worker typecheck + tests as its current gate.

## Tasks

- [ ] Verify M0.1 is marked complete in `WORKPLAN.md` before changing repository tooling.
- [ ] Confirm the working tree is clean and record the starting HEAD in Completion Evidence.
- [ ] Add npm workspace metadata to the existing root package without changing VS Code extension manifest behavior.
- [ ] Register `worker/` as the transitional child workspace.
- [ ] Add the root Node engine/toolchain baseline needed by the current workspace.
- [ ] Generate and inspect a canonical root workspace `package-lock.json`.
- [ ] Remove `worker/package-lock.json` only after the root lockfile demonstrably represents the Worker workspace and a fresh root install succeeds.
- [ ] Add/normalize root scripts for extension compile/lint/test, Worker typecheck/test, and aggregate validation.
- [ ] Ensure Worker `dev` and `deploy` remain explicit opt-in commands and are not transitively invoked by validation.
- [ ] Add a minimal `tsconfig.base.json` for safe shared invariants without changing package-specific module/runtime semantics.
- [ ] Update existing TypeScript configs to extend the base only where this is behaviorally neutral; otherwise document why a config remains explicit.
- [ ] Run a clean/fresh root dependency installation using the workspace lockfile.
- [ ] Verify npm recognizes the Worker as a workspace from the root.
- [ ] Run the extension compile and lint gates.
- [ ] Run the extension test suite using the reproducible M0.1-compatible VS Code runtime if the default runner again encounters the known runtime-download issue.
- [ ] Run Worker typecheck through the workspace/root orchestration.
- [ ] Run all Worker tests through the workspace/root orchestration.
- [ ] Run the aggregate root validation command.
- [ ] Inspect the final diff for accidental dependency upgrades, manifest changes, source moves, or production behavior changes.
- [ ] Record exact commands/results, lockfile outcome, test counts, and any environment-only runner issue under Completion Evidence.

## Required regression gate

M0.2 is accepted only if all M0.1 behavior remains protected:

- VS Code extension compile: PASS;
- VS Code extension lint: PASS;
- VS Code extension tests: **92 passing**;
- Worker typecheck: PASS;
- Worker tests: **73 passing across 6 files**;
- test counts do not decrease silently;
- installation/authentication/revocation behavior remains unchanged;
- Telegram pairing TTL/hash/one-time/race/private-chat/webhook behavior remains unchanged;
- Telegram lookup/disconnect/concurrent-rebind behavior remains unchanged;
- extension QR/open-copy-cancel/session/onboarding/secret-storage behavior remains unchanged;
- bounded HTTP and Telegram client semantics remain unchanged.

The known M0.1 VS Code test-runtime download/contention issue is an environment/runner issue, not permission to skip the extension suite. Use the already-compatible/pinned runtime approach when necessary and record it.

## Acceptance criteria

M0.2 is complete only when:

- [ ] root npm workspace metadata is valid;
- [ ] `worker/` is recognized as a workspace;
- [ ] one canonical root workspace lockfile can reproduce dependencies from the repository root;
- [ ] there is no competing Worker lockfile after successful lock consolidation;
- [ ] a fresh root install succeeds;
- [ ] root scripts can invoke the required extension and Worker validation gates;
- [ ] aggregate validation is side-effect free and never deploys;
- [ ] TypeScript runtime-specific semantics remain isolated;
- [ ] all M0.1 regression gates pass with the same test counts;
- [ ] no source file has been moved;
- [ ] no production behavior has changed;
- [ ] no M0.3 directory migration has started.

## Expected file-scope

Expected changes are primarily:

```text
package.json
package-lock.json
tsconfig.base.json
tsconfig.json                 # only if safe base extension is useful
worker/package-lock.json      # expected deletion after verified consolidation
worker/tsconfig.json          # only if safe base extension is useful
WORKPLAN_TODO.md              # Completion Evidence only after execution
```

A change outside this set requires a concrete M0.2 tooling reason. Production files under `src/` or `worker/src/` should not need modification.

## Do not

During M0.2:

- do not create `apps/vscode`;
- do not create `apps/cloud`;
- do not create `apps/companion`;
- do not create `packages/domain`, `packages/contracts`, or `packages/agent-adapter-sdk`;
- do not move `src/`;
- do not move `worker/`;
- do not rewrite imports merely for future paths;
- do not implement Companion;
- do not introduce IPC;
- do not introduce SQLite;
- do not introduce agent discovery/observation/resolution;
- do not change Telegram behavior;
- do not rewrite installation/authentication;
- do not add generic agent commands;
- do not rename the product;
- do not perform unrelated dependency upgrades;
- do not weaken or delete tests to make the migration pass;
- do not begin M0.3.

## Stop conditions

Stop and report instead of improvising if:

- npm cannot represent the transitional root-extension + child-Worker workspace without changing extension runtime/package semantics;
- lockfile consolidation requires unexplained dependency/version churn;
- a baseline regression test fails because of the workspace migration;
- TypeScript base inheritance changes emitted/runtime semantics;
- a production source change appears necessary;
- M0.2 would require moving `src/` or `worker/`.

An architecture/tooling conflict is evidence to review, not permission to silently expand scope.

## Completion Evidence

**Status:** EXECUTED — REGRESSION GATE PASS; AWAITING REVIEW

- starting commit: `029e06285cc5096efd8ded042b9879e2430b6333`; `git status --short` was empty before tooling changes.
- npm/Node versions: npm `10.9.2`; Node.js `v22.17.1`. Root `engines.node` is `>=22`; the existing `engines.vscode` remains `^1.137.0`.
- workspace metadata: root is `private: true` with `workspaces: ["worker"]`; the existing root extension name/version/product and Worker name/version are unchanged.
- canonical lockfile result: root `package-lock.json` is lockfile v3 and contains the `worker` package plus the `node_modules/far-away-from-codex-worker -> worker` workspace link. A plain fresh `npm ci --ignore-scripts` reproduced the unified install successfully.
- nested Worker lockfile result: `worker/package-lock.json` was removed only after the unified root lock represented the Worker, the first fresh root install passed, and npm reported the linked workspace with its expected dependency versions. A second clean install and aggregate validation then passed with the nested lockfile absent.
- files changed: `package.json`, `package-lock.json`, `tsconfig.base.json`, `tsconfig.json`, `worker/tsconfig.json`, deletion of `worker/package-lock.json`, and this M0.2 Completion Evidence section. No other plan section was changed.
- root commands added/changed: added `extension:compile`, `extension:lint`, pinned `extension:test`, `worker:typecheck`, `worker:test`, and `validate`. Existing `vscode:prepublish`, `compile`, `watch`, `pretest`, `lint`, and `test` remain. `validate` invokes only compile/lint/tests/typecheck; it does not invoke Worker `dev` or `deploy`.
- clean install command/result: after removing only the verified repository-local root and Worker `node_modules` directories, `npm ci --ignore-scripts` passed (`345 packages added`, `347 packages audited`). After deleting `worker/package-lock.json`, the same command passed again from the root lock alone with the same package/audit counts. npm reported 6 existing dependency audit findings (1 low, 3 moderate, 2 high); no audit-fix or dependency upgrade was performed.
- workspace recognition command/result: `npm ls --workspaces --depth=0` passed and reported `far-away-from-codex-worker@0.0.1 -> .\\worker` with `@cloudflare/vitest-plugin@1.1.9`, `@cloudflare/workers-types@5.20260915.1`, `typescript@6.0.3`, `vitest@4.1.11`, and `wrangler@4.131.2`. `npm pkg get name version --workspaces` also reported the Worker workspace.
- extension compile result: `npm run extension:compile` passed.
- extension lint result: `npm run extension:lint` passed.
- extension test result/count: `npm run extension:test` passed against cached VS Code `1.137.0`; **92 passing**.
- Worker typecheck result: `npm run worker:typecheck` passed.
- Worker test result/count: `npm run worker:test` passed; **73 passing across 6 files**.
- aggregate validation result: `npm run validate` passed end-to-end both before and after the final root-lock-only clean install; **92 extension tests** and **73 Worker tests across 6 files** passed in the final aggregate run.
- dependency/lockfile review: declared dependency ranges are unchanged. All 264 pre-existing root package resolutions remain present with zero version mismatches. Of the 161 baseline Worker package entries, 80 remain represented with zero version mismatches and 81 omitted entries are all optional non-host binary packages; zero non-optional entries are missing. Worker direct tool versions remain exactly at their baseline resolutions. `git diff --check` passed apart from Git's existing LF-to-CRLF working-copy warnings.
- production/source changes: none. `git status --short -- src worker/src apps packages` was empty; no source was moved, no production file changed, and no M0.3 directory was created.
- deviations or environment issues: the first npm 10.9.2 lock-only solve hit npm's internal `Cannot read properties of null (reading 'edgesOut')` peer-resolution error. Lock generation therefore used `--legacy-peer-deps` and a `2026-09-18` registry cutoff to preserve the two baseline lockfiles' resolutions; the final plain `npm ci --ignore-scripts` did not require that flag. The default VS Code runner attempted an unnecessary 1.140.0 download, so the new orchestration command pins the already-compatible cached 1.137.0 runtime. Electron/Vite child-process launches required running outside the filesystem sandbox after initial `spawn EPERM` startup failures. Worker tests emitted the expected missing local Telegram secret warnings but passed.
- final regression-gate result: **PASS** — extension compile/lint passed; extension tests remained 92; Worker typecheck passed; Worker tests remained 73 across 6 files; aggregate validation passed.
- notes: `tsconfig.base.json` contains only the already-shared `strict: true` and `target: ES2022` invariants. `tsc --showConfig` confirmed the extension still uses Node16 semantics with Node/Mocha/DOM types and the Worker still uses ESNext/Bundler semantics with Cloudflare/Vitest types. M0.2 remains unmarked in `WORKPLAN.md` pending review.

Do not mark M0.2 complete in `WORKPLAN.md` until this evidence has been reviewed.
