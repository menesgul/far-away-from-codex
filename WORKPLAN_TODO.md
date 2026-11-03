# WORKPLAN_TODO.md — Current Executable Slice

> Only M0.10 is executable after its baseline gate. Do not begin M0.11, M0.12, new agent features, or the separately planned AGENTS.md / Codex orchestration work.

# M0.10 — Add Multi-Client, Restart & Architecture-Boundary Tests

## Status

**IN PROGRESS — locally implemented and validated; focused review passed; both CI OS jobs remain unverified.**

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

- [x] Baseline SHA, diagram/decision review and existing-vs-missing coverage matrix recorded.
- [x] Multiple real clients share one Companion without response/authority crossover.
- [x] Malformed/disconnected client cannot disrupt healthy peer.
- [x] Concurrent Companion startup cannot create a second owner/writer.
- [x] Shutdown and restart release/reacquire resources safely.
- [x] Same-root restart preserves implemented SQLite schema/WAL/state.
- [x] Old IPC sessions fail closed; fresh handshake succeeds.
- [x] VS Code clients remain lifecycle-independent and non-authoritative.
- [x] Narrow architecture guards protect actual M0 boundaries.
- [x] Existing Telegram/VS Code/Cloud regressions pass.
- [ ] Full local validation and both CI OS jobs pass with skip accounting.
- [x] Independent review of the latest corrections has no unresolved blocking findings.
- [ ] `WORKPLAN.md` M0.10 checked only after evidence/review.

## Completion Evidence

2026-10-14, M0.10 local execution evidence (retain this record until CI can verify the uncommitted implementation):

- Branch / baseline SHA: `test/m0-10-multi-client-restart`, created from clean `main` at `9248f5357fb218c76b246e2f701a37d81e86e54b`. `git ls-remote origin refs/heads/main` confirmed the same tip. M0.9 was checked complete before edits. No commit, push, or PR was made.
- Reviewed architecture: `AGENTS.md`, `ARCHITECTURE.md`, `WORKPLAN.md`, this entire active plan, and diagrams `02-local-component`, `05-permission-round-trip`, `06-offline-reconnect`, `07-multi-device-race`, `10-deployment-topology`, `11-trust-boundaries`. The linked locked Notion B2, B3, B4, B5, and C4 decisions were fetched and reviewed. B5's full client enrollment and B2/C4 source recovery remain future obligations.
- Baseline Windows x64, Node v22.17.1: `npm run validate` exit 0. Companion 37 pass / 4 skip / 0 fail; pinned VS Code 1.138.0 integration 164 pass; Cloud 73 pass. Four Companion skips were two Unix UDS tests and SIGINT/SIGTERM process-signal tests that Windows `child.kill` cannot exercise. Cloud test runner warned that local Telegram secrets were absent; its tests passed.

| Required category | Existing and proven at baseline | Missing and in scope, addressed in this branch | Future functionality not yet implemented |
| --- | --- | --- | --- |
| A. Clients and correlation | `ipc-server.test.ts`: “real local transport serves two clients; malformed/disconnected peer is isolated…”; `ipc-protocol.test.ts`: “hello is required…”, “incompatible major, wrong challenge…”, “duplicate in-flight IDs…”; `real-transport.test.ts`: “two clients handshake and read…” | Strengthened real-transport request/session ID assertions and cross-client session rejection; added “silent and partial-frame peers expire…” including half-open and EOF peers. | B5 scoped client enrollment. |
| B. Competing owners | `process.test.ts`: “second executable cannot reach READY…”, “two spawned reclaimers…”; `storage.test.ts`: “owner rejects competitors…”; `ipc-server.test.ts`: ordered shutdown and post-bind failure cleanup. | Losing real process now demonstrably leaves winner's owner token and working IPC handshake intact. | Installer, autostart, and process supervision. |
| C. Restart and durable state | `storage.test.ts`: WAL, migration persistence, rollback, incompatible history; `process.test.ts`: killed-process recovery and Unix signal shutdown; `ipc-server.test.ts`: post-bind rollback and Unix stale-socket protection; `ipc-protocol.test.ts`: stale in-process session rejection. | Added “replacement Companion process requires a fresh IPC session and preserves WAL migration state”: clean A stop, old socket close, same-root B start, old session rejected, fresh hello/read, persisted migration fixture/WAL checked. | Adapter authority binding, PendingInteraction recovery, relay reconnect, and source commit idempotency. |
| D. VS Code client boundary | `real-transport.test.ts`: two production `CompanionClient`s with independent disposal and explicit process stop; `CompanionClient.test.ts`: bounded absence/timeouts/reconnect and stale socket events; `activation.test.ts`: nonfatal absence, mismatch, disposal, no background retry or eager Telegram runtime. | No duplicate VS Code test needed. | Bootstrap/enrollment/autostart UX. |
| E. Architecture boundaries | `ipc-server.test.ts`: Named Pipe/UDS endpoint, no TCP; `ipc-protocol.test.ts`: unknown command rejected; root typecheck and package root boundaries. | Added `architecture.test.ts` guard for declared workspace dependency direction across domain, contracts, adapter SDK, Companion, VS Code, and Cloud. | Future agent/relay/mobile contract and authority guards. |

- Finding A confirmed: framing bounded size but no server-side deadline for silent pre-`hello` or unfinished frames. A new real-transport test failed with `ERR_TEST_FAILURE` after 3,000 ms before the fix. `IpcProtocolSession` now has 10 s hello and 5 s incomplete-frame deadlines, configurable only as local test options; all end/stop paths clear timers. Unix protocol close uses `destroySoon()` so a half-open peer cannot retain the server socket after timeout; native shutdown stops sessions before pipe teardown. No new protocol method was added.
- Finding B confirmed as a coverage gap: existing tests did not prove an old transport session fails across two real process epochs on one data root. The new process test passes without a restart production change. Its `restart_probe` migration/row is a storage test fixture, not a claim that production agent or PendingInteraction state exists.
- Focused verification after implementation: `npm run companion:test` exit 0, 40 pass / 4 Windows skips / 0 fail. A later focused run after the half-open close correction also passed 40 / 4 / 0. `git diff --check` exit 0 before documentation edits. One intermediate focused run failed because the Windows native pipe dropped the optional protocol-error frame during immediate disconnect; the test was corrected to assert the security property, actual socket closure. A reviewer run overlapped the native-addon rebuild and saw `MODULE_NOT_FOUND` before behavior executed; the sequential root gate rebuilds the addon.
- Prior root `npm run validate` on Windows x64 / Node v22.17.1: exit 0. Companion 40 pass / 4 platform skips / 0 fail; pinned VS Code 1.138.0 integration 164 pass; Cloud 73 pass. Builds, typechecks, and extension lint passed. `npm ci` was not run on a clean CI checkout in this local workspace.
- Windows/Ubuntu CI: no M0.10 links or final-job results exist. The workflow only runs on `main` push or a PR to `main`; this branch is intentionally uncommitted/unpushed under the user's Git boundary. Local Ubuntu WSL has no `node` executable; Docker Linux engine is unavailable. Unix-specific tests and both final CI OS jobs remain unverified.
- Earlier independent custom read-only reviews of the then-current diff: `spider_sense`: PASS after finding a Unix half-open timeout cleanup blocker, fixed with `destroySoon()` and a regression; it later checked and withdrew a separate EOF concern after verifying Node's accepted-socket default. `web_check`: PASS, real production seams and negative assertions. `watchtower`: PASS, architecture/scope/security. Those earlier follow-up reviews found no unresolved blocker. A reviewer saw a transient missing native addon while its build was running concurrently; the sequential root gate rebuilt it and passed.
- Subsequent independent review attempt: native Codex delegation of `watchtower`, `spider_sense`, and `web_check` was unavailable, so none of those three ran or acquired a result in that attempt. A separate read-only review found a P1 Unix test defect: the half-open silent and partial-frame clients awaited `close` after server EOF. That review did not run repository tests. The test now awaits `end` on Unix, awaits native-pipe `close` on Windows, and explicitly destroys both clients afterward; a Windows-only intermediate version awaiting `end` on both platforms timed out before the transport-specific correction. A later focused Windows `npm run companion:test` passed 40 / 4 skips / 0 fail, and `git diff --check` passed. These corrections are not covered by the earlier reviewer PASS results.
- 2026-11-03 final review corrections: the replacement-process test now checks the fresh `health.get` response type, request ID, and new session ID. `WORKPLAN_TODO.md` decoded as strict UTF-8 with no replacement characters or mojibake patterns; apparent corruption was display encoding, so no encoding rewrite was made. On Windows x64 / Node v22.17.1, `npm run companion:test` exited 0 (40 pass / 4 platform skips / 0 fail), root `npm run validate` exited 0 (Companion 40 / 4 skips / 0 fail, pinned VS Code 1.138.0 integration 164 pass, Cloud 73 pass; builds, typechecks, and lint passed), and `git diff --check` exited 0. Cloud tests warned that local Telegram secrets were absent. No current independent reviewer execution or Windows/Ubuntu CI job is claimed.
- 2026-11-03 P2 independent review follow-up: the cross-client borrowed-session test previously checked disconnect but could miss a successful response sent before it. The test client now retains every complete decoded frame; after the unauthorized client handshakes, the test inspects all frames received through closure and permits only an optional `protocol.error` with `INVALID_SESSION`. No production code changed. On Windows x64 / Node v22.17.1, `npm run companion:test` exited 0 (40 pass / 4 platform skips / 0 fail) and root `npm run validate` exited 0 (Companion 40 / 4 skips / 0 fail, pinned VS Code 1.138.0 integration 164 pass, Cloud 73 pass; builds, typechecks, and lint passed). Fresh read-only P2 reviews by `watchtower`, `spider_sense`, and `web_check` each returned PASS; their findings are limited to this correction and relevant IPC seams, not a full re-review of all M0.10 changes. Ubuntu transport and both CI jobs remain unverified.
- 2026-11-03 P2 restart-test review follow-up: the replacement-process test required an `INVALID_SESSION` frame even though Windows Named Pipe closure can precede delivery of that optional frame. It now registers a three-second close deadline before sending the stale request and inspects every complete frame recorded from that request through closure. Zero frames or one `protocol.error` with `INVALID_SESSION` pass; any successful or unexpected response fails. Fresh-session response assertions and SQLite WAL/migration checks remain. No production code changed. On Windows x64 / Node v22.17.1, `npm run companion:test` exited 0 (40 pass / 4 platform skips / 0 fail), root `npm run validate` exited 0 (Companion 40 / 4 skips / 0 fail, pinned VS Code 1.138.0 integration 164 pass, Cloud 73 pass; builds, typechecks, and lint passed), and `git diff --check` exited 0. Focused read-only reviews by `watchtower`, `spider_sense`, and `web_check` each returned PASS for this correction; they were not a full re-review of M0.10. Ubuntu transport and both CI OS jobs remain unverified.
- Residual limits: package-manifest guard checks declared dependency direction; TypeScript package root boundaries cover normal imports, but it is not a full runtime import graph audit. No implemented agent, cloud relay, installation enrollment, or mobile authority is claimed.
- Final gate decision: **M0.10 remains incomplete** until both required CI OS jobs pass. Leave `WORKPLAN.md` M0.10 unchecked.

## Research links

- [B2 Decision Register](https://app.notion.com/p/3eb752fe5b3c815cb10bc6ac322b293a)
- [B3 Decision Register](https://app.notion.com/p/3eb752fe5b3c8124b08fdf0eb301dbbb)
- [B4 Decision Register](https://app.notion.com/p/3eb752fe5b3c81c9a213d5ea0a92fdc4)
- [B5 Decision Register](https://app.notion.com/p/3eb752fe5b3c81f586b6e346f1b4b80e)
- [C4 Reliability](https://app.notion.com/p/3eb752fe5b3c8128831ac84f7ffa315d)
