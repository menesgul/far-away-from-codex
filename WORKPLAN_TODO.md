# WORKPLAN_TODO.md — Active Implementation Slice

> **Current milestone:** M0 — Repository & Runtime Foundation
>
> **Current step:** M0.6 — Add Companion Paths, SQLite Bootstrap & Single-Instance Ownership
>
> Implement **only this step**. Do not begin M0.7 or any later work.

## Why this step exists

M0.5 established a real standalone Companion process. M0.6 gives that process the minimum durable local foundation required before IPC or agent work exists:

- deterministic per-user local paths;
- one canonical SQLite database owned by Companion;
- WAL bootstrap plus a minimal migration mechanism;
- exactly one authoritative Companion process for the selected local data/installation scope;
- restart-safe startup/shutdown ordering.

This slice establishes **local process and persistence ownership**, not agent/source authority. Persisted state never proves live source authority.

## Verified starting state

Authoritative merged checkpoint on `main`:

`0be1bc51293311d14300ea6787e3fdcb1f952d7c`

Merge message:

`Merge pull request #3 from menesgul/planning/m0.5-companion`

At this checkpoint:

- M0.1–M0.5 are marked complete in `WORKPLAN.md`;
- `apps/companion` is a private Node >=22 TypeScript workspace;
- the built Companion launches independently, reaches READY, remains alive, and shuts down through the M0.5 lifecycle;
- root has the six expected workspaces and one canonical lockfile;
- no Companion persistence, path policy, single-instance ownership, IPC, adapter execution, relay, or identity implementation exists;
- reviewed M0.5 regression evidence is Companion 4 passing / 2 Windows signal skips, VS Code 92 passing on 1.138.0, Cloud 73 passing across 6 files, and aggregate validation green.

Planning branch:

`planning/m0.6-persistence`

Before implementation, verify the local checkout is based on this branch/checkpoint, is up to date, and has no unrelated working-tree changes. Otherwise stop and report.

## Architecture source — MUST REVIEW

Read `ARCHITECTURE.md`, `WORKPLAN.md`, and this file before editing.

M0.6 is derived from the locked A–E architecture baseline. The implementation-driving decisions are primarily **B1/B3** plus the Phase A authority boundary. Later C/D/E decisions remain constraints: this slice must not pull cloud relay, routing/policy, remote surfaces, or mobile authorization forward.

The relevant canonical diagrams are **exactly these four**:

1. `docs/diagrams/02-local-component.mmd` — Companion owns canonical local persistence and is the single local authority; SQLite is inside Companion/TB1.
2. `docs/diagrams/06-offline-reconnect.mmd` — restart must treat persisted authority as non-authoritative; persistence cannot silently restore live source authority.
3. `docs/diagrams/10-deployment-topology.mmd` — one per-user Companion process owns local SQLite inside the desktop account boundary.
4. `docs/diagrams/11-trust-boundaries.mmd` — database and ownership state remain inside TB1; canonical source authorization still requires later Companion/source revalidation.

Do **not** require diagrams 01, 03–05, or 07–09 for this slice. M0.6 implements no agent integration, attention flow, permission round-trip, multi-device behavior, Telegram, or iOS.

Diagrams clarify boundaries; explicit locked architecture text wins on conflict.

## Locked architecture constraints

Preserve all of the following:

- Companion is the standalone per-user **single local Far Away authority**.
- SQLite has one canonical writer: the authoritative Companion process.
- SQLite uses WAL.
- persisted state is not live source authority after restart.
- Companion does not own coding-agent source sessions.
- VS Code remains UI/setup/bootstrap only and is not involved in database ownership.
- Cloud remains routing/control only.
- no local TCP exists.
- secrets/private keys do not belong in this SQLite foundation; OS secure-store work is later.
- no generic remote prompt/command surface is introduced.
- no M0.7 IPC mechanism is used as the singleton primitive.

## Exact scope

### 1. Companion path policy

Add a small testable path resolver owned by `apps/companion`.

Default per-user data location:

- Windows: `%LOCALAPPDATA%/Far Away`;
- macOS: `~/Library/Application Support/Far Away`;
- Linux/other Unix: `$XDG_DATA_HOME/far-away` when set, otherwise `~/.local/share/far-away`.

Within that root, define stable paths for at least:

- canonical SQLite database;
- single-instance ownership artifact.

Do not create cache/log/config trees that M0.6 does not use.

Tests must never write to the developer's real Far Away directory. Use dependency injection or a narrowly scoped explicit test override/temp root.

Path creation must fail closed with a useful error. On Unix-like systems request restrictive per-user directory permissions where Node supports it; do not invent custom Windows ACL management in this slice.

### 2. Single-instance ownership

Acquire ownership **before opening/migrating the canonical database**.

Use a filesystem-based, atomic ownership primitive inside the Companion data root. It must not use Named Pipe/UDS/TCP/HTTP/WebSocket.

Required semantics:

- exactly one process can own a given data root at a time;
- a second live Companion fails startup non-zero and never reaches READY;
- ownership records enough diagnostic metadata to identify at least PID and a unique owner token;
- never steal ownership merely because a wall-clock timeout elapsed;
- stale ownership may be reclaimed only when the recorded owner process is demonstrably not alive;
- if liveness is ambiguous, fail closed rather than risk two authorities;
- stale-reclaim races must still produce at most one winner;
- only the process holding the matching owner token may release ownership;
- graceful shutdown releases ownership;
- startup failure after acquisition releases ownership;
- crash-stale ownership can be recovered on a later start when dead-owner status is established.

Do not deepen this into installation identity/B5 authentication. The owner token is local lock correlation, not an InstallationIdentity or credential.

### 3. SQLite bootstrap

After ownership is acquired:

- open one canonical database for the Companion process;
- enable and verify `journal_mode=WAL`;
- enable `foreign_keys=ON`;
- set a finite busy timeout suitable for local startup/migrations;
- expose one owned database lifecycle so later code cannot casually create competing canonical writers;
- close the database before releasing process ownership during graceful shutdown.

Do not create domain/session/PendingInteraction/outbox tables yet.

### 4. Migration mechanism

Add the smallest deterministic migration runner needed for future Companion schema evolution.

Requirements:

- ordered integer versions;
- migration identity/name;
- a canonical migration-history table;
- each unapplied migration is applied transactionally;
- already-applied migrations are not rerun;
- duplicate/out-of-order/invalid migration definitions fail before partial application;
- migration failure rolls back that migration and prevents READY;
- database schema version/history survives close/reopen;
- production M0.6 may have no product-domain migration beyond migration bookkeeping; tests may use temporary test migrations to prove the runner.

Do not design future domain schema speculatively.

### 5. Runtime integration and ordering

Extend the M0.5 executable/runtime with explicit resource ownership. Equivalent structure is acceptable, but startup ordering must be:

`resolve/create paths → acquire single-instance ownership → open/configure SQLite → run migrations → READY`

Shutdown ordering must be:

`STOPPING → close SQLite → release ownership → STOPPED → release executable lifetime hold`

Failure at any intermediate startup step must unwind only resources already acquired, in reverse order, then exit non-zero without READY.

Repeated/concurrent shutdown remains idempotent.

Do not move signal handling into domain/contracts packages.

## Tests required

Add deterministic focused tests covering at least:

- path resolution for Windows/macOS/Linux rules without touching real user directories;
- data-root creation in a temp location;
- first ownership acquisition succeeds;
- a competing owner for the same root is rejected;
- wrong owner token cannot release another owner's lock;
- dead/stale ownership is reclaimable;
- ambiguous/live ownership is not stolen;
- SQLite opens under the temp root with WAL verified and foreign keys enabled;
- migration history persists across close/reopen;
- applied migrations are not rerun;
- migration failure rolls back and prevents successful bootstrap;
- startup failure after ownership acquisition releases owned resources;
- graceful shutdown closes DB and releases ownership;
- a subsequent Companion using the same temp root can start after graceful shutdown;
- a real spawned second Companion using the same temp root cannot reach READY while the first is alive.

Prefer injectable process-liveness/path dependencies for deterministic unit tests. Spawned-process coverage should prove the real executable boundary where practical. Timeouts may bound failure, but must not be the success synchronization mechanism.

Preserve the documented Windows signal-test limitation from M0.5; do not broaden this slice to solve it.

## Root/regression contract

M0.6 should remain inside `apps/companion/**` unless a root script/lockfile change is genuinely required by an added dependency.

Run:

1. clean root `npm ci`;
2. verify all six workspaces;
3. Companion build/typecheck/tests;
4. all M0.4 package typechecks;
5. VS Code compile/lint/**92 tests on VS Code 1.138.0**;
6. Cloud typecheck/**73 tests across 6 files**;
7. aggregate root `npm run validate`;
8. `git diff --check`.

No existing VS Code/Cloud/package test may be deleted, skipped, or weakened to pass M0.6.

## Explicitly forbidden in M0.6

Do **not** implement:

- Named Pipe or Unix Domain Socket server/client;
- any local TCP/HTTP/WebSocket transport;
- `hello`, `health.get`, `companion.status`, framing, negotiation, IPC auth/challenge;
- VS Code `CompanionClient` or extension activation/bootstrap changes;
- agent manager, concrete/fake production adapters, discovery/observation/resolution;
- canonical AgentSession/PendingInteraction persistence;
- immutable AttentionEvent/outbox production schema;
- D1 routing, D2 escalation, D3 policy, D4 synthetic attention, D5 inbox;
- Companion ↔ cloud relay;
- Telegram behavior changes;
- account/OAuth, InstallationIdentity, P-256/ES256, secure-store enrollment;
- iOS/APNs/Live Activity/Dynamic Island;
- generic prompt/command execution.

Do not use M0.7 IPC as a shortcut for single-instance ownership.

## Relevant diagrams — MUST REVIEW

Before implementation and again during final self-review:

- [ ] `docs/diagrams/02-local-component.mmd`
- [ ] `docs/diagrams/06-offline-reconnect.mmd`
- [ ] `docs/diagrams/10-deployment-topology.mmd`
- [ ] `docs/diagrams/11-trust-boundaries.mmd`

Review questions:

- Is there still exactly one canonical local Companion writer/authority per selected data root?
- Can a second live process ever reach READY against the same canonical DB?
- Does persisted state remain non-authoritative with respect to future source authority?
- Are SQLite and ownership artifacts entirely inside TB1?
- Is VS Code uninvolved in DB/lock ownership?
- Was any IPC/relay/adapter/identity responsibility pulled forward?
- On startup failure, are acquired resources unwound before process exit?
- On shutdown, is SQLite closed before ownership is released?

Any NO/unclear answer is a review finding.

## Acceptance criteria

M0.6 is complete only when:

- [ ] platform-aware per-user Companion data paths are deterministic and tested;
- [ ] tests do not touch the real user data directory;
- [ ] exactly one live Companion can own a selected data root;
- [ ] a competing Companion fails closed and never reaches READY;
- [ ] stale dead-owner state can be safely reclaimed without time-based lock stealing;
- [ ] ownership release is token-checked and idempotent;
- [ ] canonical SQLite opens only after ownership acquisition;
- [ ] SQLite WAL and foreign-key enforcement are verified;
- [ ] one canonical DB lifecycle/writer is owned by Companion;
- [ ] ordered transactional migrations and persistent migration history work;
- [ ] failed migration/bootstrap prevents READY and unwinds ownership/database resources;
- [ ] graceful shutdown closes SQLite before releasing ownership;
- [ ] restart against the same data root succeeds after clean shutdown;
- [ ] no persisted data is treated as live agent/source authority;
- [ ] existing M0.5 lifecycle semantics remain intact;
- [ ] clean install and full regression gates pass;
- [ ] implementation conforms to diagrams 02, 06, 10, and 11;
- [ ] no M0.7 IPC or later feature work has begun.

## Expected change shape

A conforming diff should be dominated by:

```text
apps/companion/src/**
apps/companion/test/**
apps/companion/package.json        # only if a real dependency is justified
package-lock.json                  # only if dependency metadata changes
WORKPLAN_TODO.md                   # Completion Evidence only during execution
```

Unexpected edits to `apps/vscode/**`, `apps/cloud/**`, `packages/**`, diagrams, or `ARCHITECTURE.md` require explanation and normally indicate scope drift.

## Stop conditions

Stop and report instead of improvising if:

- local checkout does not descend from merged M0.5;
- unrelated local changes are present;
- single-instance correctness appears to require IPC/network transport;
- a proposed stale-lock strategy can steal ownership from a process that may still be alive;
- SQLite would have multiple canonical writers;
- implementation requires defining future domain/session/outbox schema;
- VS Code/Cloud must become involved in local persistence ownership;
- a locked A–E architecture invariant or one of diagrams 02/06/10/11 conflicts with the slice.

## Completion Evidence

**Status:** NOT IMPLEMENTED.

When execution finishes, update only this section with factual evidence:

- starting commit/branch;
- files added/changed;
- exact path policy implemented;
- ownership primitive and stale-recovery semantics;
- SQLite PRAGMAs verified;
- migration behavior verified;
- startup/shutdown resource ordering;
- focused test counts;
- spawned competing-process evidence;
- clean install/workspace/full regression results;
- diagram review result;
- negative-scope audit;
- platform/environment constraints or deviations.

Do not mark M0.6 complete in `WORKPLAN.md` until this evidence has been independently reviewed.
