# WORKPLAN_TODO.md — Active Implementation Slice

> **Current milestone:** M0 — Repository & Runtime Foundation
>
> **Current step:** M0.5 — Create Standalone Companion Runtime
>
> Implement **only this step**. Do not begin M0.6 or any later work.

## Why this step exists

M0.1–M0.3 established the repository/workspace and application boundaries. M0.4 added the provider-neutral domain, contracts, and adapter SDK boundaries.

M0.5 now creates the first **actual Local Companion process boundary**.

This slice is intentionally smaller than the full B3 Local Companion architecture. Its job is to prove that Far Away has a standalone TypeScript/Node application that:

- exists outside the VS Code extension process;
- can be built and launched directly from the repository;
- reaches an explicit runtime-ready state;
- stays alive independently of VS Code;
- shuts down cleanly;
- has a lifecycle structure that later M0.6–M0.10 work can extend without moving authority back into VS Code or Cloud.

M0.5 does **not** yet implement persistence, single-instance ownership, IPC, adapter execution, relay connectivity, identity, routing, or source authority.

## Verified starting state

Authoritative merged checkpoint on `main`:

`96963c1fce3256f599753ee9d3054df09d4b7682`

Merge message:

`Merge pull request #2 from menesgul/planning/m0.4-boundaries`

At this checkpoint:

- `apps/` contains exactly the existing `apps/vscode` and `apps/cloud` applications;
- there is no `apps/companion`;
- `packages/` contains `domain`, `contracts`, and `agent-adapter-sdk`;
- root workspaces are exactly those two applications plus those three packages;
- root remains orchestration-only;
- one canonical root `package-lock.json` exists;
- M0.4 final review passed with no remaining GAP or CONFLICT;
- reviewed M0.4 regression evidence is extension **92 passing** on VS Code **1.138.0** and Cloud **73 passing across 6 files** after clean install/aggregate validation.

Planning branch for this slice:

`planning/m0.5-companion`

Before implementation, verify the local checkout contains this planning branch (or an implementation branch based directly on it), is up to date, and has no unrelated working-tree changes. If not, stop and report.

## Architecture source — MUST REVIEW

Read `ARCHITECTURE.md` before editing.

For M0.5, the relevant canonical diagrams are **exactly these four**:

1. `docs/diagrams/01-system-context.mmd` — establishes that Far Away sits beside the normal coding-agent workflow; the source runtime remains source authority.
2. `docs/diagrams/02-local-component.mmd` — establishes the Local Companion as the single local Far Away authority and the future owner of adapters, canonical state, persistence, relay, IPC, and diagnostics.
3. `docs/diagrams/10-deployment-topology.mmd` — establishes the Companion as a standalone per-user Node.js process on the desktop, separate from VS Code, Cloud, and agent runtimes.
4. `docs/diagrams/11-trust-boundaries.mmd` — places Companion inside TB1 (trusted local OS-user boundary) and keeps source authorization at Companion revalidation rather than VS Code/Cloud.

Do **not** require other diagrams for this slice:

- `03-agent-integration-decision-tree` is not relevant because M0.5 implements no adapter/discovery mechanism;
- `04-agent-event-to-attention` through `09-ios-flow` concern attention, permissions, reconnect/multi-device/remote surfaces not implemented here;
- `06-offline-reconnect` becomes directly relevant when restart persistence/authority revalidation exists; M0.5 has no persisted authority;
- M0.6+ must select their own diagrams from actual scope rather than inheriting this list mechanically.

If code required by this slice conflicts with explicit locked architecture text, stop and report the conflict. Diagrams clarify boundaries and flows; they do not override explicit architecture text.

## Locked architecture constraints for M0.5

Preserve all of the following:

- Local Companion is a **standalone TypeScript/Node per-user process**.
- Companion is the future single local Far Away authority; it is not a child service whose correctness depends on the VS Code extension host remaining alive.
- Companion does not own coding-agent source sessions.
- VS Code remains UI/setup/bootstrap only.
- Cloud remains routing/control only.
- Source runtime remains source truth.
- Companion may remain alive while VS Code is closed.
- New Companion code must not deepen the legacy extension-owned cloud/state path.
- No generic remote prompt/command surface may be introduced.
- No provider/vendor payload becomes canonical domain truth.

M0.5 establishes the runtime boundary only. Do not claim authority capabilities that are not implemented yet.

## Target shape for this slice

Add one application workspace:

```text
apps/
├── cloud/
├── companion/
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts
│   │   └── runtime.ts
│   └── test/
└── vscode/
```

Exact internal filenames may differ if a simpler structure is clearly better, but ownership must remain equivalent:

- one thin executable/entry point;
- one testable Companion lifecycle/runtime boundary;
- package-local tests only where they verify M0.5 behavior.

Do not create `packages/test-support` unless a real cross-package need appears. M0.5 should not need it.

## Companion package contract

Create a private workspace package for the standalone Companion.

Requirements:

- TypeScript + Node.js;
- compatible with the root Node `>=22` baseline;
- extends the repository TypeScript baseline rather than inventing a conflicting compiler policy;
- has package-local build/typecheck/test commands;
- has an explicit runnable command/entry point that launches the built Companion independently of VS Code;
- generated build output is not committed;
- no production dependency should be added unless the runtime shell genuinely requires it;
- do not copy VS Code or Cloud implementation into Companion.

Add `apps/companion` explicitly to the root workspace list. Do not replace explicit workspace membership with a broad wildcard in this slice.

Update the canonical root lockfile only as required for the new workspace. Unrelated dependency/version churn is a failure.

## Runtime lifecycle contract

Implement the smallest lifecycle that makes the Companion a real standalone process.

The runtime must have explicit states or equivalent observable lifecycle semantics sufficient to distinguish:

```text
starting → ready → stopping → stopped
```

Required behavior:

1. process entry creates/starts exactly one Companion runtime instance within that process;
2. successful initialization reaches **READY** without requiring VS Code, Cloud, Telegram, an agent runtime, IPC, SQLite, or network access;
3. after READY, normal executable mode remains alive until shutdown is requested;
4. SIGINT and SIGTERM initiate graceful shutdown where supported by Node/OS;
5. shutdown is idempotent: repeated/concurrent stop requests do not run teardown twice or corrupt state;
6. normal graceful shutdown exits successfully;
7. startup failure must fail closed/non-zero rather than printing READY;
8. lifecycle code must be testable without spawning VS Code or depending on the network;
9. process-global signal wiring belongs at the executable boundary, not inside reusable domain/contracts packages.

A concise deterministic lifecycle log is acceptable and useful (for example STARTING / READY / STOPPING / STOPPED), but do not build a logging framework in this slice.

Do not invent fake initialization work merely to populate lifecycle phases.

## Authority semantics

The word **READY** in M0.5 means only:

> the standalone Companion runtime shell initialized successfully and is alive.

It does **not** mean:

- a coding-agent runtime was discovered;
- a source session is attached;
- an `AuthorityBinding` is current;
- persisted state was recovered;
- IPC is accepting clients;
- cloud relay is authenticated;
- the installation is enrolled;
- source resolution is available.

Tests and comments must not blur runtime readiness with source/live authority.

## Dependency direction

For this slice:

```text
apps/companion
    ↓ (only when actually needed)
packages/domain
packages/contracts
packages/agent-adapter-sdk
```

The Companion app may depend on the new packages only if M0.5 runtime-shell code actually uses their public types. Do not add ornamental dependencies just to make the future architecture visible.

Forbidden dependency directions remain:

- `packages/domain` → app code;
- `packages/contracts` → app implementation;
- `packages/agent-adapter-sdk` → Companion implementation;
- `apps/vscode` → Companion source imports;
- `apps/cloud` → Companion source imports.

Do not modify the M0.4 public domain/adapter contracts merely to make this runtime shell convenient. If a real incompatibility is found, stop and report it.

## Root orchestration

Update root orchestration minimally so Companion participates in repository validation.

Expected root-level commands should include equivalent gates for:

- Companion build;
- Companion typecheck;
- Companion tests.

`npm run validate` must include the Companion gates while preserving all existing domain/contracts/adapter, VS Code, and Cloud gates.

Do not turn the root into an application package.

## Tests required in M0.5

Add focused tests for lifecycle behavior, not future architecture.

At minimum verify:

- fresh runtime starts in the expected pre-ready state;
- successful start reaches READY;
- stop after READY reaches STOPPED;
- stop is idempotent;
- startup failure does not report READY and results in a failed startup contract;
- lifecycle can be exercised without VS Code/network/IPC/SQLite.

Where practical, add a standalone process smoke test or deterministic command-level check proving the built Companion can launch independently and expose READY. Do not create an IPC endpoint merely to make the smoke test easier.

Tests must not rely on arbitrary sleeps when a deterministic lifecycle hook/event/promise can be used.

## Existing behavior / regression contract

M0.5 must not alter production behavior in `apps/vscode` or `apps/cloud`.

Existing migration behavior remains:

```text
Existing vertical slice:
VS Code → legacy cloud client → Cloud Worker → Telegram pairing

New foundation:
standalone Companion runtime shell
(no VS Code client path yet)
```

The new Companion is not wired into the extension in this slice.

Required regression gate:

1. clean root install succeeds;
2. npm recognizes all six explicit workspaces:
   - `apps/vscode`
   - `apps/cloud`
   - `apps/companion`
   - `packages/domain`
   - `packages/contracts`
   - `packages/agent-adapter-sdk`
3. Companion build/typecheck/tests pass;
4. extension compile/lint/**92 tests on VS Code 1.138.0** pass;
5. Cloud typecheck/**73 tests across 6 files** pass;
6. all M0.4 package typechecks remain green;
7. aggregate root `npm run validate` passes;
8. `git diff --check` passes;
9. no existing application test is deleted, skipped, weakened, or rewritten merely to make the gate pass.

If the VS Code Electron test runner hits the known sandbox `spawn EPERM` restriction, request/obtain the required execution permission and rerun rather than treating it as a product failure.

## Explicitly forbidden in M0.5

Do **not** implement any of the following:

- Companion data/config directory policy;
- SQLite, WAL, schema, migration runner, repositories, durable outbox;
- single-instance lock/mutex/lease/ownership;
- Named Pipe, Unix Domain Socket, local TCP, HTTP, WebSocket, or any IPC server/client;
- `hello`, `health.get`, `companion.status`, protocol envelopes, framing, negotiation, challenge/auth;
- VS Code `CompanionClient`, Companion bootstrap/install/update integration, or activation changes;
- adapter manager;
- concrete or fake production adapters;
- agent discovery/observation/resolution;
- canonical session/PendingInteraction state management;
- D1 routing, D2 escalation, D3 policy, D4 synthetic attention, D5 inbox;
- cloud relay client or Companion ↔ cloud WebSocket;
- Telegram behavior changes;
- identity enrollment, installation keys, secure-store integration, OAuth, P-256/ES256;
- iOS/APNs/Live Activity/Dynamic Island;
- generic `sendPrompt`, `executeCommand`, `runAgent`, arbitrary command execution, or equivalent control API.

Important: **do not open a local TCP port even temporarily.** M0.5 needs no transport at all.

## Relevant diagrams — MUST REVIEW

Before implementation and again during final self-review:

- [ ] `docs/diagrams/01-system-context.mmd`
- [ ] `docs/diagrams/02-local-component.mmd`
- [ ] `docs/diagrams/10-deployment-topology.mmd`
- [ ] `docs/diagrams/11-trust-boundaries.mmd`

Review questions:

- Does Companion remain a separate local process beside VS Code rather than inside it?
- Does the implementation preserve the source runtime as source authority?
- Is the new runtime entirely inside the local OS-user trust boundary?
- Is VS Code still optional UI/bootstrap rather than runtime authority?
- Has any future DB/secure-store/relay/IPC/adapter responsibility been prematurely implemented?
- Does READY describe runtime health only, not source authority?

Any NO/unclear answer is a review finding.

## Acceptance criteria

M0.5 is complete only when:

- [x] `apps/companion` exists as a private TypeScript/Node workspace application;
- [x] Companion builds to runnable JavaScript and can launch directly without VS Code;
- [x] Companion reaches an explicit READY state after successful runtime-shell initialization;
- [x] normal executable mode remains alive until shutdown is requested;
- [x] SIGINT/SIGTERM are handled as graceful shutdown requests where supported;
- [x] shutdown is idempotent and reaches STOPPED;
- [x] startup failure does not report READY and has non-success failure semantics;
- [x] lifecycle behavior is covered by focused deterministic tests;
- [x] root workspace membership explicitly contains the six expected workspaces;
- [x] root validation includes Companion build/typecheck/tests;
- [x] one canonical root lockfile remains;
- [x] existing M0.4 package boundaries remain intact;
- [x] existing VS Code and Cloud production behavior is unchanged;
- [x] clean install and full regression gates pass;
- [x] the implementation conforms to diagrams 01, 02, 10, and 11;
- [x] no M0.6 persistence/path/single-instance work has begun;
- [x] no M0.7 IPC work or later feature work has begun.

## Expected change shape

A conforming M0.5 diff should be dominated by:

```text
apps/companion/**
package.json
package-lock.json
WORKPLAN_TODO.md
```

Tests/configuration directly belonging to `apps/companion` are expected.

`WORKPLAN.md` should not be marked M0.5 complete by the implementation agent. M0.4 may already be marked complete by the reviewed planning checkpoint.

Unexpected edits to these areas require explanation and usually mean scope drift:

```text
apps/vscode/**
apps/cloud/**
packages/domain/**
packages/contracts/**
packages/agent-adapter-sdk/**
docs/diagrams/**
ARCHITECTURE.md
```

## Stop conditions

Stop and report instead of improvising if:

- the local starting point does not contain merged M0.4;
- unrelated local changes are present;
- implementing standalone lifecycle appears to require IPC, SQLite, single-instance ownership, cloud connectivity, VS Code integration, or an agent adapter;
- the proposed runtime would only work while the VS Code extension host is alive;
- a package boundary from M0.4 must be weakened or inverted;
- tests require changing existing application semantics;
- a locked architecture/diagram conflict is discovered.

A desire to make M0.6/M0.7 easier is not permission to implement them early.

## Completion Evidence

**Status:** M0.5 lifetime correction validated on Windows; executable signal delivery remains platform-limited; awaiting independent review.

- Starting point: clean `planning/m0.5-companion` at `4df08b3405baa106a66e9eb84ce1bfbaeb702f6e`, matching `origin/planning/m0.5-companion` and descending from merged M0.4 commit `96963c1fce3256f599753ee9d3054df09d4b7682`.
- Added: `apps/companion/package.json`, `apps/companion/tsconfig.json`, `apps/companion/src/index.ts`, `apps/companion/src/runtime.ts`, `apps/companion/test/runtime.test.ts`, `apps/companion/test/process.test.ts`. Modified: root `package.json`, root `package-lock.json`, and this Completion Evidence section only.
- `@far-away/companion` is a private Node `>=22` TypeScript ESM workspace. It extends `tsconfig.base.json`, emits runnable JavaScript under ignored `dist/`, and provides package-local `build`, `typecheck`, `test`, and `start` scripts. The standalone entry point is built `dist/src/index.js`; the root adds Companion build/typecheck/test gates to `validate`.
- The runtime starts in `starting`, reaches `ready` after successful shell initialization, and stays alive in executable mode until shutdown. The executable owns a referenced, in-process `MessageChannel` event-loop hold; it sends no messages and opens no transport. Shutdown or startup failure removes signal listeners and closes both ports, allowing natural exit. SIGINT/SIGTERM request shutdown where supported; concurrent/repeated stops share one teardown and reach `stopped`. Initialization rejection never reports READY and rejects startup; the executable sets a non-zero exit code on startup failure. READY describes process-shell health only.
- CompanionRuntime unit tests verified initial state/READY/STOPPED and one teardown for concurrent/repeated stops, failed initialization without READY, and stop requested during initialization without READY (3 passed). A spawned-process test launched the real built `dist/src/index.js` without VS Code, observed `Companion STARTING` and `Companion READY`, then verified continued liveness over a 750 ms observation window before force-cleaning and reaping the child (1 passed). A separate direct terminal launch remained at READY for 10 seconds instead of exiting; Ctrl+C then produced STOPPING and STOPPED. Independent spawned-process SIGINT and SIGTERM cases assert READY, STOPPING, STOPPED, and successful exit on platforms where Node can deliver those signals to the child; both cases were skipped on this Windows run and their executable handler behavior is **not verified by those cases here**.
- The process-test helper bounds READY and graceful-close waits at 5 seconds each, reports captured stdout/stderr on timeout, and uses `SIGKILL` plus a bounded close wait to reap a child still alive after failure. Test listeners and timers are removed after each wait and cleanup. The 750 ms timer is solely a post-READY liveness observation; READY and shutdown remain event-driven.
- `npm ci` passed from the root. `npm ls --workspaces --depth=0` recognized all six explicit workspaces. The single root lockfile changed only for the Companion workspace record/link and workspace membership; no unrelated dependency versions changed. Companion adds no production dependency and imports no M0.4 package merely for architecture shape.
- Boundary audit: no edits to VS Code, Cloud, domain, contracts, adapter SDK, diagrams, or `ARCHITECTURE.md`; no existing application test changed. No IPC server/client/protocol or TCP transport, SQLite/persistence/path policy, single-instance ownership, adapter/discovery, relay/cloud integration, authentication, routing, Telegram change, or mobile work was introduced. The in-process event-loop hold is used only for executable lifetime.
- Diagrams `01-system-context`, `02-local-component`, `10-deployment-topology`, and `11-trust-boundaries` were rereviewed after the lifetime correction. The confirmed running Companion process is separate from VS Code inside TB1; VS Code stays optional, source runtime stays source authority, and future Companion responsibilities remain unimplemented. All M0.5 diagram review questions passed.
- After the lifetime correction, `npm run companion:build`, `npm run companion:typecheck`, and focused `npm run companion:test` passed (4 passed, 2 platform skips). A fresh root `npm ci` passed; `npm ls --workspaces --depth=0` recognized all six workspaces. The complete post-install `npm run validate` passed: three M0.4 package typechecks; Companion build/typecheck and 4 passing tests with 2 Windows signal skips; extension compile/lint and **92 passing** on VS Code **1.138.0**; Cloud typecheck and **73 passing across 6 files**. `git diff --check` passed.
- Environment constraints: sandboxed `npm ci` lacked a cached registry response, so clean install ran with registry access. Sandboxed Node test child processes returned `spawn EPERM`, so process tests and the full gate ran with execution permission. On Windows, Node `child.kill('SIGINT'/'SIGTERM')` cannot reliably prove delivery to the child's JavaScript handlers; both executable signal tests are explicitly skipped here. The unit tests prove runtime shutdown semantics. Direct terminal Ctrl+C produced STOPPING/STOPPED, but PowerShell returned status 1 for the interrupted command, so successful graceful signal exit remains to be verified on a platform that supports the spawned-process assertions.

Do not mark M0.5 complete in `WORKPLAN.md` until this evidence has been independently reviewed.
