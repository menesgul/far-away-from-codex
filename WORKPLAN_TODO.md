# WORKPLAN_TODO.md — Current Executable Slice

> Only M0.10 is executable after its baseline gate. Do not begin M0.11, M0.12, new agent features, or the separately planned AGENTS.md / Codex orchestration work.

# M0.10 — Add Multi-Client, Restart & Architecture-Boundary Tests

## Status

**PLANNED — NOT IMPLEMENTED.**

Canonical baseline: merged `main` at the start of execution; record its exact SHA in Completion Evidence. M0.9 is checked complete in `WORKPLAN.md`. Its former executable plan and review log are archived at `docs/milestones/M0.9.md`. This document does not authorize implementation of future milestones.

## Objective

Prove the Companion-centered M0 foundation survives concurrent local clients, client faults/disconnects, competing Companion startups, shutdown/restart and SQLite persistence without creating a second authority, leaking IPC session authority, or coupling Companion lifetime to a VS Code window.

This is a **regression/architecture proof** milestone. Prefer tests and narrowly justified fixes to new production functionality. Existing behavior is the starting point; do not reimplement already-covered scenarios or assert that future adapters, PendingInteractions, cloud relay, or mobile clients exist.

## Repository facts at the M0.9 baseline

- Root npm workspaces cover `apps/companion`, `apps/vscode`, `apps/cloud`, `packages/domain`, `packages/contracts`, and `packages/agent-adapter-sdk`.
- Companion is a standalone Node/TypeScript runtime with SQLite/WAL bootstrap, migration and single-instance ownership.
- Local IPC uses Windows Named Pipe / Unix Domain Socket with versioned framed request/response, `hello`, `health.get` and `companion.status`.
- VS Code has a bounded, window-local `CompanionClient` and contribution-driven lightweight activation. It does not own Companion lifetime.
- Existing `apps/companion/test/ipc-server.test.ts` already exercises some two-client, malformed-peer, disconnect and startup-failure behavior. Audit first; do not duplicate it.
- Legacy Telegram connection/pairing remains a separate lazy VS Code/Worker path; M0.10 must preserve it without moving its authority.
- Root `npm run validate` includes builds/typechecks, VS Code compile/lint/pinned integration tests, Companion tests and Cloud tests; GitHub Actions runs Windows Server 2022 and Ubuntu 24.04.
- Prior M0.9 final local evidence: Companion 37 pass / 4 Windows-only skips, VS Code 164 pass, Cloud 73 pass. **These are historical figures, not M0.10 baseline results.** Capture fresh counts.

## Architecture sources — MUST REVIEW

Before implementation, read `ARCHITECTURE.md`, `WORKPLAN.md`, this file, and these diagrams. Mark each reviewed in the execution evidence:

- [ ] `docs/diagrams/02-local-component.mmd`
- [ ] `docs/diagrams/05-permission-round-trip.mmd`
- [ ] `docs/diagrams/06-offline-reconnect.mmd`
- [ ] `docs/diagrams/07-multi-device-race.mmd`
- [ ] `docs/diagrams/10-deployment-topology.mmd`
- [ ] `docs/diagrams/11-trust-boundaries.mmd`

Consult locked Notion decisions from Phase A–E; specifically B2, B3, B4, B5 and C4. The permission/offline/multi-device diagrams define **future invariants**; M0.10 must not fabricate implementation evidence for those future paths.

## Locked decisions for this slice

### 1. One Companion, many clients

B3-D001/D004/D007/D012 and B4-D020: a single per-user Companion owns operational state and its SQLite writer. Each VS Code window is a client, never an owner or leader. A second process must not acquire an overlapping lock/endpoint or corrupt the owner's DB. PID-only ownership is insufficient.

### 2. Local transport and trust boundary

B3-D008–D011, B5-D015–D019: Named Pipe on Windows, UDS on Unix; no TCP/HTTP local control endpoint. OS-local endpoint restrictions and protocol/installation authorization are security boundaries. Distinguish **what is currently implemented** from the full future B5 scoped enrollment model. Do not weaken current checks for test convenience.

### 3. Client isolation and bounded failure

Malformed/partial frames, incompatible versions, disconnected peers, and stalled requests must not terminate the Companion or poison a healthy client's response correlation. Timeouts and cleanup must be deterministic and bounded. Do not add unbounded sleeps or polling loops.

### 4. Restart is a new authority epoch

B3-D020/D021 and B2-D008/D009: old transport sessions are not reusable across process restart. A new handshake is required. Future adapter authority bindings and PendingInteractions require source revalidation, but those subsystems are not implemented in M0; test only real existing behavior and record future obligations separately.

### 5. Lifecycle independence

B3-D022/D031, B4-D002/D022: closing/disabling a VS Code client never stops Companion or source-agent work. Companion shutdown is an explicit local operation that drains its own resources and releases ownership. M0.10 does not implement autostart, installation or process supervision.

### 6. Storage continuity

B3-D013/D025/D029: Companion is the only operational DB writer; SQLite uses WAL on supported local filesystems, and schema migration runs before readiness. Restart must preserve implemented state/schema and reject incompatible migration states. No second writer may appear during startup or teardown.

### 7. No accidental product expansion

Phase A/B2 forbid generic vendor RPC passthrough, agent prompting, stopping, or model switching through IPC. C4 idempotency/multi-device source-commit decisions and Phase D/E attention/iOS decisions are architectural constraints only. No cloud/mobile/adapter implementation in M0.10.

## In scope

Expected primary surfaces (verify real paths before edits):

```text
apps/companion/src/**                 # only narrowly necessary correctness fixes
apps/companion/test/**                # real-transport/lifecycle/storage regression
apps/vscode/src/companion/**          # only narrowly necessary client correctness fixes
apps/vscode/src/test/**               # CompanionClient/activation regression
packages/contracts/**                 # tests only if an existing contract needs a guard
WORKPLAN_TODO.md                     # evidence after implementation
WORKPLAN.md                          # checkbox only after all gates pass
```

Test helpers and small deterministic fault-injection seams are permitted if they demonstrably reduce flaky integration tests. New dependencies, protocol methods and broad refactors require explicit stop/review.

## Explicitly out of scope

- New Codex/Claude/OpenCode adapters, source discovery, observation or resolution;
- source authority-binding revalidation implementation, PendingInteraction recovery or approval;
- Companion/cloud relay, Durable Objects, outbox delivery, cloud reconnect and multi-device action races;
- Telegram/Worker/cloud behavior changes or migration;
- B5 full installation key enrollment, OAuth/PKCE, local client registration, installer, autostart, packaging;
- agent orchestration, `AGENTS.md` and `race-reviewer.toml`/`reviewer.toml`/`test-auditor.toml`;
- Phase D attention routing, Phase E iOS/APNs/Live Activity/Dynamic Island;
- M0.11 root scaffolding cleanup, M0.12 full audit, or architecture redesign.

## Implementation sequence

1. Create `test/m0-10-multi-client-restart` (or equivalent) from latest merged `main`; confirm clean tree and M0.9 closure.
2. Read all required architecture sources, current Companion ownership/startup/shutdown/storage/IPC and VS Code CompanionClient code and tests.
3. Run fresh root `npm run validate` baseline; capture exact OS, Node, pass/fail/skip totals and platform limitations.
4. Create a **coverage matrix** with `existing`, `missing`, or `future-not-implemented` for every Required tests category below. Cite existing test names/files. Stop if scope differs materially from this plan.
5. Select the smallest set of genuinely missing high-risk regressions. Write failing tests first where feasible; record what they would catch.
6. Implement M0.10.1: independent multi-client real-transport and fault-isolation coverage.
7. Implement M0.10.2: competing Companion owner and shutdown/release-order coverage.
8. Implement M0.10.3: stop/restart on same data root, fresh IPC handshake, WAL/migration persistence and startup rollback.
9. Implement M0.10.4: narrow dependency/IPC architecture guards, only where an actual regression is otherwise unprotected.
10. Make minimal production fixes only when a real failing regression demonstrates need; no unrelated refactor.
11. Run focused tests, complete Companion and VS Code suites, then full root `npm run validate`.
12. Confirm both Windows and Ubuntu CI checks and explain genuine platform skips.
13. Perform **independent read-only review** of race windows, test strength, teardown and architecture boundaries; address findings and rerun affected tests.
14. Record Completion Evidence. Only then check M0.10 in `WORKPLAN.md`; leave M0.11/M0.12 untouched.

## Required tests

### A. Concurrent clients and protocol correlation

- Two independently connected clients can handshake and issue overlapping read-only requests against the same running Companion.
- Response IDs and per-client session/authorization state never cross streams.
- Closing/disconnecting one client does not break the other, kill Companion or release its ownership lock.
- Incompatible or unauthorized client fails closed without disturbing authorized peers.
- Malformed, truncated or oversized input from one peer cannot crash server or contaminate another client's stream.
- No duplicate implementation of scenarios already present in `ipc-server.test.ts`; strengthen only missing edge cases.

### B. Competing Companion processes and ownership

- Two startup attempts using the same installation/data root cannot both reach authoritative READY.
- Losing startup attempt cannot remove, unlock or corrupt winner's ownership state, IPC endpoint or database.
- A failed partial startup cleans up **only resources it owns**; subsequent clean startup succeeds.
- Shutdown called repeatedly is safe; endpoint, DB and lock are released in an observable safe order.
- Use separate real processes where in-process simulation would miss lock/OS behavior; do not claim cross-process safety from a same-process mock.

### C. Restart and durable state

- Clean Companion stop then new process start with the same local data root preserves schema version, WAL configuration and implemented persistent state.
- Existing transport session/socket handles are not accepted as a valid post-restart connection; fresh `hello` and authorization are required.
- Stale Unix socket cleanup does not delete another live owner's socket; Windows pipe restart follows its platform semantics.
- Migration/startup error leaves no zombie endpoint or lock; next valid start can recover.
- Do not invent fake agent authority/PendingInteraction data to claim future revalidation is complete.

### D. VS Code client boundary

- Multiple window-local `CompanionClient` instances can independently connect and dispose.
- Extension disposal closes only its local client and UI resources, not Companion.
- Companion absence, restart and protocol mismatch remain bounded/non-fatal for VS Code activation; no hidden infinite reconnect or eager Telegram initialization.
- VS Code never reads Companion SQLite/lock/PID directly or starts source-agent discovery.

### E. Architecture boundaries

- No local TCP control listener, generic vendor RPC, arbitrary agent prompt/stop/execute IPC endpoint.
- Domain/contracts/adapter SDK dependency direction remains valid; Companion must not import VS Code runtime, and VS Code must not import Companion implementation.
- Guards should be meaningful and maintainable; prefer runtime/contract/type/package tests over brittle source-string matching.
- Distinguish future-only security and reliability obligations from currently executable acceptance tests.

## Regression gate

Run and report, at minimum:

```text
npm ci                        # on clean CI checkout
npm run validate              # root: build, typecheck, lint, tests
git diff --check
```

- Use pinned VS Code integration test runtime; do not silently change VS Code version to make a test pass.
- GitHub Actions: required `Validate (windows-2022)` and `Validate (ubuntu-24.04)` must both pass before merge.
- Report per-suite totals and exact skips. Linux/UDS tests should run on Ubuntu rather than being counted as Windows-only skips.
- Use bounded deadlines and `finally` teardown for child processes, IPC clients, sockets and temporary data directories.
- If CI differs from local, diagnose rather than weaken the test or suppress a required check.

## Negative acceptance criteria

M0.10 **fails** if:

- a second Companion can own the same installation/data root concurrently;
- one client's failure disconnects another or kills Companion;
- stale pre-restart IPC authorization works against a new process;
- client/extension disposal stops Companion;
- SQLite state is lost or multiple canonical writers appear;
- local TCP/vendor prompt/control endpoints are introduced;
- test doubles are presented as proof of OS-level locking or real transport behavior;
- flaky timing/sleep-based tests are accepted without deterministic synchronization;
- existing Telegram/VS Code/Cloud regression behavior is broken;
- unimplemented agent/relay/mobile scenarios are reported as tested;
- scope expands into M0.11/M0.12 or unrelated feature work.

## Stop conditions

Stop and report before continuing if:

1. A locked A–E decision conflicts with actual code or `ARCHITECTURE.md`.
2. A required test demands a new production subsystem, protocol operation or significant refactor.
3. A security boundary (IPC authorization, lock ownership, secret storage) appears weaker than assumed.
4. Cross-process tests cannot be made deterministic with current harness and require design choice.
5. Existing test coverage already proves a requirement; do not write redundant tests merely to increase count.
6. CI/environment failure cannot be distinguished from product failure.
7. Work would require changing M0.11/M0.12 or agent-orchestration files.

## Acceptance criteria

- [ ] Baseline SHA, diagram/decision review and existing-vs-missing coverage matrix recorded.
- [ ] Multiple real clients share one Companion without response/authority crossover.
- [ ] Malformed/disconnected client cannot disrupt healthy peer.
- [ ] Concurrent Companion startup cannot create a second owner/writer.
- [ ] Shutdown and restart release/reacquire resources safely.
- [ ] Same-root restart preserves implemented SQLite schema/WAL/state.
- [ ] Old IPC sessions fail closed; fresh handshake succeeds.
- [ ] VS Code clients remain lifecycle-independent and non-authoritative.
- [ ] Narrow architecture guards protect actual M0 boundaries.
- [ ] Existing Telegram/VS Code/Cloud regressions pass.
- [ ] Full local validation and both CI OS jobs pass with skip accounting.
- [ ] Independent review has no unresolved blocking findings.
- [ ] `WORKPLAN.md` M0.10 checked only after evidence/review.

## Completion Evidence

**NOT STARTED.** During implementation append short, dated evidence here, preserving failures and corrective retests:

- Branch / baseline SHA:
- Reviewed diagrams / locked decisions:
- Existing vs missing coverage matrix:
- Focused RED tests and intended regression:
- Production changes (if any) and why:
- Focused GREEN tests:
- Root `npm run validate` totals / environment:
- Windows and Ubuntu CI links / skips:
- Independent reviewer findings / resolutions:
- Residual limitations / deferred Phase B–E obligations:
- Final gate decision:

## Research links

- [B2 Decision Register](https://app.notion.com/p/3eb752fe5b3c815cb10bc6ac322b293a)
- [B3 Decision Register](https://app.notion.com/p/3eb752fe5b3c8124b08fdf0eb301dbbb)
- [B4 Decision Register](https://app.notion.com/p/3eb752fe5b3c81c9a213d5ea0a92fdc4)
- [B5 Decision Register](https://app.notion.com/p/3eb752fe5b3c81f586b6e346f1b4b80e)
- [C4 Reliability](https://app.notion.com/p/3eb752fe5b3c8128831ac84f7ffa315d)
