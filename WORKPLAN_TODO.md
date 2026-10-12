# WORKPLAN_TODO.md — Current Executable Slice

> M0.10 is the only next implementation milestone. Do not start M0.11/M0.12 or agent configuration work. This plan does not itself implement M0.10.

# M0.10 — Multi-Client and Restart Architecture Regression Tests

## Status
**PLANNED — NOT IMPLEMENTED.** Begin implementation only after confirming M0.9 is merged and closed. Final completion requires test evidence, root validation, and independent review.

## Goal
Prove the **existing** Local Companion / VS Code IPC boundary remains correct with multiple clients, competing Companion startups, malformed/disconnected peers, clean shutdown and restart, and persistent SQLite. Do not duplicate existing tests or pretend future adapters, cloud relay or permission workflows already exist.

## Locked source-of-truth
- Phase A: Respond, don't chat; discovery/observation/resolution separation; no generic vendor control passthrough.
- Phase B2: source authority is not established by a stored session ID; adapter restart requires revalidation; session processing serialized; duplicate observation tolerant.
- Phase B3: one per-user Companion, one SQLite writer, named-pipe/UDS IPC, single-instance lock + health handshake, shutdown does not cancel coding agents, persisted authority invalid after restart.
- Phase B4: each VS Code window is a client; closing/deactivating it must not stop Companion.
- Phase B5: installation, process and local client identities are distinct; current implementation must not be represented as complete future client enrollment.
- Phase C4: transport retry does not imply permission to retry source mutation; cloud ACK is not source authority; multi-device race resolves at Companion.
- Phases D/E: attention and iOS surfaces do not change the local authority boundary.
- Diagrams: `docs/diagrams/02-local-component.mmd`, `05-permission-round-trip.mmd`, `06-offline-reconnect.mmd`, `07-multi-device-race.mmd`, `10-deployment-topology.mmd`, `11-trust-boundaries.mmd`.

## M0.10.1 — Baseline and gap analysis
- [ ] Confirm merged `main` SHA, M0.9 closure and clean working tree.
- [ ] Inspect Companion startup/ownership/IPC/storage and VS Code CompanionClient, plus existing tests (`apps/companion/test/ipc-server.test.ts`, `apps/vscode/src/test/companion/real-transport.test.ts`).
- [ ] Build a concise **existing / missing / future-not-implemented** matrix for: concurrent clients, handshake isolation, malformed peer, client disconnect, duplicate startup, startup rollback, shutdown, restart, old IPC session rejection, persistence and platform behavior.
- [ ] Run and record baseline `npm run validate`. Do not add redundant coverage.
**Gate:** specific missing cases identified with file/test references.

## M0.10.2 — Multi-client and single-owner regressions
- [ ] Add only missing deterministic real-transport tests for concurrent clients with distinct challenge/session/request correlation.
- [ ] Assert one client's malformed frame, failed handshake or disconnect cannot break a healthy peer or shut down Companion.
- [ ] Assert duplicate Companion startup cannot acquire second SQLite writer/IPC owner, alter first owner's DB or release first owner's lock.
- [ ] Assert idempotent shutdown and correct IPC-before-DB-before-lock release order.
- [ ] Run Windows named-pipe and Linux UDS scenarios in their corresponding CI OS jobs; do not conceal platform-specific skips.
**Gate:** one owner, independent clients, bounded timeouts and reliable teardown.

## M0.10.3 — Restart and persistence regressions
- [ ] Test stop/start on the **same** data root; DB schema/migrations and implemented persisted state remain valid.
- [ ] Require fresh handshake after restart; old IPC session/challenge/socket cannot authorize the new process.
- [ ] Test injected startup failure cleanup and successful subsequent start using existing injection seams.
- [ ] Ensure restart cannot leave stale IPC ownership or two writers.
- [ ] Explicitly record future-only gaps: adapter authority revalidation, PendingInteraction recovery, durable outbox, cloud reconnect. Do **not** fake or implement them here.
**Gate:** fresh process transport authority, valid persisted storage, no duplicate ownership.

## M0.10.4 — Architecture guardrails
- [ ] Add narrow guards only for realistic missing regressions: VS Code cannot own canonical Companion DB/discovery/resolution; Companion must not depend on VS Code runtime.
- [ ] Preserve versioned authenticated local IPC and no TCP/vendor RPC passthrough.
- [ ] Prefer typecheck, package boundaries and behavior tests over brittle text-search tests. Avoid new dependencies without need.
**Gate:** guards demonstrably catch prohibited changes without overfitting implementation.

## M0.10.5 — Final validation and review
- [ ] Run focused suites then full `npm run validate`; record pass/fail/skip counts.
- [ ] Verify GitHub Actions Windows and Ubuntu checks pass.
- [ ] Independent review: race windows, lock ownership, restart correctness, fault injection, cleanup, determinism and whether each new test actually detects its claimed regression.
- [ ] Confirm no unintended Telegram/cloud/agent/diagram or M0.11+ production changes.
- [ ] Only after gates pass: update `WORKPLAN.md` M0.10 status and append concise evidence/remaining gaps.

## Out of scope
No new adapter, discovery engine, cloud relay, remote approval, Durable Object, iOS/APNs, installation key enrollment, standalone installer, or M0.11/M0.12 work. Do not modify `AGENTS.md`, `race-reviewer.toml`, `reviewer.toml`, or `test-auditor.toml` here; these are the user's separate step 2.

## Notion references
- [Phase A](https://app.notion.com/p/3eb752fe5b3c814980b7d8dacdd9d4d5)
- [B2 decisions](https://app.notion.com/p/3eb752fe5b3c815cb10bc6ac322b293a)
- [B3 decisions](https://app.notion.com/p/3eb752fe5b3c8124b08fdf0eb301dbbb)
- [B4 decisions](https://app.notion.com/p/3eb752fe5b3c81c9a213d5ea0a92fdc4)
- [B5 decisions](https://app.notion.com/p/3eb752fe5b3c81f586b6e346f1b4b80e)
- [C4 reliability](https://app.notion.com/p/3eb752fe5b3c8128831ac84f7ffa315d)
- [Phase D](https://app.notion.com/p/3eb752fe5b3c817c99dacaa101f15dae)
- [Phase E](https://app.notion.com/p/3eb752fe5b3c81fa85c8c33bb7c083bb)
