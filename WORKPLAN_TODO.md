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

**Status:** NOT STARTED

When M0.2 is executed, replace this section with:

- starting commit:
- npm/Node versions:
- workspace metadata:
- canonical lockfile result:
- nested Worker lockfile result:
- files changed:
- root commands added/changed:
- clean install command/result:
- workspace recognition command/result:
- extension compile result:
- extension lint result:
- extension test result/count:
- Worker typecheck result:
- Worker test result/count:
- aggregate validation result:
- dependency/lockfile review:
- production/source changes:
- deviations or environment issues:
- final regression-gate result:
- notes:

Do not mark M0.2 complete in `WORKPLAN.md` until this evidence has been reviewed.
