# WORKPLAN_TODO.md — Current Executable Slice

> Only the slice below is executable. Do not begin M0.10 or later work.

# M0.9 — Make VS Code Activation Lightweight and Companion-Aware

## Status

**PLANNED — NOT IMPLEMENTED.**

Canonical baseline is merged `main` commit:

`85c6da0474e1e6ac00fce43accab8051c443bbfc`

M0.8 is closed. M0.9 remains unchecked in `WORKPLAN.md` until implementation, regression gates, and independent review pass.

## Objective

Replace the current eager `onStartupFinished` extension bootstrap with a contribution-driven, lightweight VS Code activation boundary that treats the standalone Companion as the local runtime authority.

When the extension is activated by one of its contributed commands, it may create one window-local `CompanionClient`, attempt one bounded connection to an **already-running** Companion, and expose the resulting local availability/status without blocking command registration or making Companion absence fatal.

This slice does **not** install, update, spawn, restart, or supervise Companion. It does not migrate Telegram/cloud ownership. Those responsibilities must not be improvised here.

## Repository facts at the M0.8 baseline

- `apps/vscode/package.json` still declares only `onStartupFinished`.
- `activate()` eagerly constructs legacy `BackendClient` and `SecretStore`, creates Telegram connection/onboarding state, creates and shows the Telegram status bar, and starts `runTelegramActivationOnboarding()`.
- Four commands are already contributed: toggle alerts, test notification, connect Telegram, disconnect Telegram.
- VS Code >=1.74 automatically activates an extension when one of its contributed commands is invoked; this extension targets VS Code ^1.137.0.
- M0.8 added the bounded `CompanionClient`: `connect()`, `healthGet()`, `companionStatus()`, `disconnect()/dispose()`.
- `CompanionClient.connect()` has finite timeout/fail-closed behavior and returns typed non-fatal `unavailable` when the endpoint is absent/refused.
- M0.8 deliberately added no automatic reconnect, startup, UI, or activation integration.
- Legacy Telegram/backend/state code remains migration input and must continue to work when its commands are invoked.
- Current complete VS Code baseline is 109 passing tests on VS Code 1.138.0.

## Architecture source — MUST REVIEW

Read `ARCHITECTURE.md`, `WORKPLAN.md`, this file, and exactly these diagrams before implementation:

- [ ] `docs/diagrams/02-local-component.mmd`
- [ ] `docs/diagrams/10-deployment-topology.mmd`
- [ ] `docs/diagrams/11-trust-boundaries.mmd`

M0.9 changes only the VS Code local-client/bootstrap boundary represented by these diagrams. It does not implement agent integration, cloud relay, remote actions, reconnect/restart recovery, Telegram migration, or iOS.

## Locked decisions for this slice

### 1. Contribution-driven activation

Remove the eager `onStartupFinished` activation path.

Activation is caused only by already-declared/contributed Far Away commands in M0.9. Do not add wildcard/workspace/language/startup activation merely to recreate eager startup.

`activate()` must synchronously register the command surfaces and disposables required for the extension to be usable. It must not wait for Companion IPC, cloud requests, Telegram refresh, onboarding, agent discovery, filesystem scans, or other network/runtime work before returning.

### 2. Companion-aware, not Companion-owned

One VS Code extension-host instance may own one window-local `CompanionClient` as an optional local client. Companion remains the single local authority.

After activation, schedule at most one non-blocking bounded probe of the already-running Companion:
1. `connect()`;
2. if connected, `companionStatus()`;
3. retain the client only while the connection is valid;
4. surface a small local status projection such as **Companion: Connected** / **Companion: Not running** / **Companion: Incompatible**.

The exact presentation may use one dedicated VS Code status-bar item and a narrow refresh/status command if implementation needs an explicit user retry. It must not reuse Telegram connection state as Companion state.

Companion absence/refusal is normal and non-fatal. No error toast on ordinary absence during activation.

### 3. No automatic Companion lifecycle yet

M0.9 must **not** spawn, install, update, restart, supervise, or poll Companion.

Although B4 permits VS Code to bootstrap Companion eventually, the repository has not yet established packaging/update ownership or restart orchestration. Adding process lifecycle here would mix those concerns into activation and overlap M0.10/M0.11. M0.9 proves the optional-client activation boundary first.

A user-triggered Companion status refresh may perform one explicit reconnect attempt. No timer, retry loop, backoff, watcher, or hidden reconnect.

### 4. Legacy Telegram path becomes lazy, not deleted

The legacy Telegram vertical slice remains temporary migration input.

Do not construct `BackendClient`, `SecretStore`, pairing/onboarding machinery, or Telegram connection refresh merely because the extension activated for a Companion-related command.

Create a small lazy legacy-Telegram runtime/factory so those objects are initialized only when a Telegram command actually needs them. Preserve:
- connect/disconnect behavior;
- pairing-session single-flight/revision fencing;
- credential-rejection recovery;
- alert toggle behavior;
- existing pairing UI;
- current production backend URL ownership rule.

Do not migrate these responsibilities into Companion in M0.9.

The old automatic activation onboarding prompt must not force eager startup back into the design. Preserve the onboarding helper/data and allow it to run only when entering the legacy Telegram surface if needed; do not show Telegram onboarding merely because a Companion status command activated the extension.

### 5. Status projections are not authority

Companion status shown by VS Code is diagnostic/presentation state only. It must never imply:
- agent/source authority;
- persisted Companion liveness;
- cloud/Telegram connectivity;
- source session health.

Do not read Companion SQLite, ownership files, PID files, or process tables to infer status. Use only the M0.8 IPC client.

### 6. Disposal

Extension disposal must:
- dispose the window-local CompanionClient;
- dispose status/UI registrations;
- dispose any lazy legacy Telegram runtime if it was created.

Disabling/closing VS Code must **not** stop Companion or delete Companion data.

## In scope

Expected implementation surface:

```text
apps/vscode/package.json
apps/vscode/src/extension.ts
apps/vscode/src/companion/**              # small activation/status coordinator if justified
apps/vscode/src/telegram/**               # lazy legacy runtime extraction only if justified
apps/vscode/src/test/**
WORKPLAN_TODO.md                           # completion evidence after execution
```

Small test helpers are allowed. Package-lock changes are allowed only if an actual dependency change is required; no new dependency is expected.

## Explicitly out of scope

- Companion install/update/spawn/autostart/login-start implementation;
- process supervision, polling, automatic reconnect/backoff;
- M0.10 restart/reconnect architecture tests;
- agent discovery/observation/resolution;
- new IPC methods beyond M0.8;
- Telegram/cloud authority migration;
- Worker/cloud changes;
- domain/adapter SDK changes;
- SQLite/ownership reads from VS Code;
- generic IPC request/send surface;
- local TCP/HTTP/WebSocket;
- OAuth/installation identity/P-256 work;
- D1–D5;
- iOS/APNs/Live Activity/Dynamic Island;
- architecture or diagram changes unless a real conflict is found;
- M0.11 cleanup or M0.12 audit.

## Implementation sequence

1. Verify branch `planning/m0.9-lightweight-activation`, baseline ancestry from `85c6da0`, and clean tree.
2. Read architecture, current activation/package contributions, M0.8 CompanionClient, legacy Telegram state/commands, relevant tests, and diagrams 02/10/11.
3. Record pre-change full regression baseline.
4. Add focused tests that fail against the current eager activation shape.
5. Remove `onStartupFinished`; rely on contributed command activation.
6. Refactor `activate()` so command/disposable registration is synchronous and heavyweight work is deferred.
7. Add the one-shot window-local Companion availability/status projection through `CompanionClient`.
8. Make legacy Telegram runtime lazy while preserving command behavior.
9. Prove Companion absence/incompatibility does not break activation or Telegram command registration.
10. Prove extension disposal closes only the client/UI resources and never Companion.
11. Run focused activation tests, complete VS Code suite, then full root regression.
12. Audit negative criteria and scope.
13. Perform independent read-only review.
14. Update only Completion Evidence. Do not check M0.9 in `WORKPLAN.md` before review passes.

## Required tests

At minimum prove:

- package manifest has no `onStartupFinished` or equivalent eager activation;
- contributed commands still activate/register correctly;
- `activate()` returns without awaiting Companion/cloud/Telegram work;
- no agent discovery exists in activation;
- Companion already running → one client can connect and status projection becomes connected;
- Companion absent/refused → activation remains healthy and status is non-fatal;
- incompatible/protocol failure is fail-closed and distinguishable from connected;
- no automatic reconnect/poll loop occurs;
- explicit user refresh, if added, makes at most one new bounded connection attempt;
- two VS Code-side runtime instances can remain independent clients of one Companion without owning it;
- disposing one extension-side client does not stop Companion or another client;
- legacy Telegram runtime is not created for Companion-only activation;
- Telegram connect/disconnect/toggle/onboarding/pairing regression tests remain green;
- no Companion SQLite/ownership/process inspection from VS Code;
- no local TCP/network fallback or generic IPC API appears.

## Regression gate

Run and record exact counts:

- `npm ci`
- `npm ls --workspaces --depth=0`
- contracts typecheck/build
- Companion build/typecheck/tests
- VS Code compile/lint/full tests on pinned VS Code 1.138.0
- Cloud typecheck/tests
- domain typecheck
- adapter SDK typecheck
- native Windows IPC build
- root `npm run validate`
- `git diff --check`

Baseline expectations before new M0.9 tests: Companion 37 pass / 4 Windows-host skips; VS Code 109 pass; Cloud 73 pass.

## Negative acceptance criteria

M0.9 fails if:

- `onStartupFinished` or equivalent eager startup activation remains;
- `activate()` blocks on IPC/network/onboarding/discovery;
- extension starts or supervises Companion;
- automatic reconnect/poll/backoff is added;
- VS Code becomes canonical/runtime/source authority;
- Companion status is inferred from DB/ownership/PID/process inspection;
- Companion absence prevents commands from registering;
- Companion and Telegram state are conflated;
- Telegram/cloud legacy objects are eagerly constructed for Companion-only activation;
- working Telegram connect/disconnect/toggle/pairing behavior regresses;
- agent discovery is added to activation;
- generic IPC/TCP/HTTP/WebSocket surface is added;
- M0.10+ work begins.

## Stop conditions

Stop and report instead of improvising if:

- contribution-driven activation cannot preserve required command behavior on the pinned VS Code version;
- preserving Telegram behavior truly requires eager `onStartupFinished`;
- Companion-aware status requires a new IPC method;
- process spawning/install/update becomes necessary to satisfy the slice;
- CompanionClient requires automatic reconnect changes;
- a locked architecture/diagram conflicts with the repository;
- implementation requires Cloud/domain/adapter-SDK/Companion production changes.

## Acceptance criteria

- [ ] Baseline/branch/clean-tree preconditions recorded.
- [ ] Diagrams 02, 10, and 11 reviewed.
- [ ] Eager `onStartupFinished` activation removed.
- [ ] Activation is contribution-driven by declared Far Away commands.
- [ ] `activate()` registers usable command/disposable surfaces without awaiting external work.
- [ ] No agent discovery or canonical authority exists in activation.
- [ ] One window-local CompanionClient is integrated as an optional client.
- [ ] Already-running Companion can be represented as connected through IPC status only.
- [ ] Missing/refused Companion is non-fatal and does not block activation.
- [ ] Protocol incompatibility/failure fails closed.
- [ ] No Companion spawn/install/update/supervision or automatic reconnect exists.
- [ ] Companion and Telegram state remain separate.
- [ ] Legacy Telegram runtime is lazy for Companion-only activation.
- [ ] Existing Telegram connect/disconnect/toggle/pairing behavior remains green.
- [ ] Disposal closes VS Code client/UI resources without stopping Companion.
- [ ] Full regression gate passes.
- [ ] Negative-scope audit passes.
- [ ] Independent review passes before M0.9 is checked in `WORKPLAN.md`.

## Completion Evidence

**Status:** NOT STARTED.

Record implementation evidence, exact test counts, platform limitations, review findings/corrections, and final independent-review verdict here after execution.
