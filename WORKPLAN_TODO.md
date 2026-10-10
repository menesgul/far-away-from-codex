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

## Proposed VS Code Telegram Concurrency Contract

**Approved product decisions for M0.9 review.** This contract applies only to the legacy Telegram command surface in the VS Code extension. It does not prescribe UI behavior for the standalone Companion, CLI, or future non-VS Code clients, and it does not move Telegram connection authority from the Worker.

1. **Connected:** Every distinct Toggle click flips the local alerts setting ON or OFF. Sharing an in-flight connection read must not collapse distinct clicks that are actionable as connected Toggles.
2. **Unknown:** A Toggle click performs an authoritative connection refresh, not an alerts flip. If that read resolves connected, a later click performs the flip; if it remains unknown, alerts stay OFF. This includes a cold VS Code Telegram entry whose initial connection projection is unknown.
3. **Disconnected:** A Toggle click offers Connect. Repeated clicks do not imply an OFF action and must not create duplicate pairing sessions. An accepted Toggle-initiated Connect carries one enable-alerts-after-connect intent; dismissing the offer leaves alerts OFF.
4. **Onboarding:** Repeated Toggle clicks while the current onboarding prompt is open share one connection intent. They do not open duplicate onboarding or Connect prompts and do not represent separate alerts flips. A dismissed prompt starts no pairing; an accepted prompt starts at most one pairing with the Toggle's enable-alerts-after-connect intent. The persisted onboarding decision remains one-time.
5. **Stale prompts:** A prompt superseded by a newer command may remain visible until VS Code resolves it, but it must not block the newer command. A late selection from that stale prompt has no effect on pairing, alerts, or connection presentation.
6. **Disconnect in progress:** Disconnect immediately turns alerts OFF and fences older local callbacks. Once DELETE is issued, later Connect waits for its outcome before a Worker connection GET can support a connected claim. An ambiguous DELETE outcome remains unknown until an explicit authoritative action resolves it. A newer Disconnect supersedes pending Toggle intents; a stale Toggle must not offer Connect, create pairing, or enable alerts afterward.

M0.8 already defined connected flips, unknown refresh-only clicks, disconnected Connect offers, pairing single-flight, and the distinction between confirmed and uncertain Disconnect. Its eager activation could show onboarding independently of a Toggle, and it did not define the multi-click ordering above for an onboarding prompt or an in-flight Disconnect. The rules above are approved VS Code product decisions for those cases, not claims that M0.8 or the current uncommitted implementation already passes them. Preserve the existing connection-state revision fencing, credential-rejection recovery, pairing single-flight, and disposal fencing while applying this contract.

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

**Status:** DEFERRED TOGGLE REJECTION CORRECTED; AWAITING FINAL M0.9 REVIEW. Acceptance checkboxes and the M0.9 milestone remain unchecked.

- Preconditions: work remains uncommitted on `planning/m0.9-lightweight-activation` at `b9ccb802e8aebc539c68f26a5a98b09272e83052`; `85c6da0474e1e6ac00fce43accab8051c443bbfc` is an ancestor. The original clean-tree/pre-change gate and review of `ARCHITECTURE.md`, `WORKPLAN.md`, this slice, M0.8 client, Telegram code/tests, and diagrams 02/10/11 were recorded before M0.9 implementation.
- Pre-change baseline: `npm ci` and `npm run validate` passed; Companion 37 pass / 0 fail / 4 Windows-host skips, VS Code 109 pass / 0 fail / 0 skip, Cloud 73 pass / 0 fail / 0 skip.
- Failed-review reproduction: the first new activation/status tests produced 119 pass / 2 fail. Production legacy-runtime entry tests, using injected BackendClient, SecretStore, prompts, and pairing session, then produced 122 pass / 6 fail: optional client locator failure aborted activation, status implied current liveness after a prior check, and cold Toggle/onboarding/Disconnect behaviors differed. Two additional command-order tests each failed before their targeted revision-fencing correction.
- Corrections: all five contributed commands register synchronously before any optional CompanionClient construction; an invalid `LOCALAPPDATA` locator becomes a non-fatal unavailable status, and partial registration failure disposes created resources. The connected status and tooltip explicitly describe a last-check IPC snapshot. The existing M0.8 client and IPC contract were not changed; there is no polling or automatic reconnect. Cold Telegram Toggle now completes its initial authoritative refresh before acting, honors connected users' first click, retains new-user onboarding, gives previously onboarded disconnected users the Connect CTA, and upgrades Toggle-initiated or already-starting pairing to enable alerts. Cold no-credential Disconnect reports already disconnected without DELETE; direct Connect fences an older cold Disconnect/refresh. Pairing single flight and credential rejection recovery remain in the existing flows.
- Tests: pinned VS Code 1.138.0 host observed a genuinely inactive extension become active through its contributed refresh command. Activation tests cover all command registrations, invalid locator, partial cleanup, non-blocking probe, disposal during an in-flight probe, absence, protocol failure, and one lazy runtime under concurrent first commands. Production legacy-runtime tests cover connected/disconnected/new/previously onboarded cold Toggle, pairing intent, unknown retry, rejected credential, credentialed and no-credential Disconnect, and both rapid Connect/Toggle and Disconnect/Connect orderings. A real Companion transport test stops the server after a successful status response and verifies the client disconnects while the UI remains explicitly a last-check snapshot; independent clients and disposal isolation are exercised. Existing tests were retained.
- Round 2 independent-review findings: M09-R2-P1-01 identified an older Disconnect sending DELETE after a newer Connect began while credential lookup was pending; M09-R2-P2-01 identified an unexpected cold Toggle Connect-prompt failure being swallowed. Deterministic tests were added before production changes. The pinned VS Code 1.138.0 RED run had 136 pass / 2 fail / 0 skip: each new finding failed, while the new opposite-order test (newer Disconnect superseding older Connect) passed.
- Round 2 corrections: Disconnect now checks its connection-state revision immediately after credential lookup and before issuing DELETE, while retaining its post-response revision check. The cold Toggle path catches expected initial refresh/onboarding failures for retry, then awaits the Toggle command outside that catch so an unexpected Connect-prompt rejection propagates without a duplicate error message. The tests also verify the newer Connect's pairing and connected projection survive the stale Disconnect, that the opposite command ordering remains fenced, and that the registered contributed Toggle callback propagates the prompt rejection.
- Round 2 gate: the earlier `npm ci` and `npm ls --workspaces --depth=0` passed. After Round 2, root `npm run validate` passed domain typecheck, contracts typecheck/build, adapter SDK typecheck, native Windows IPC build, Companion build/typecheck/tests, VS Code compile/lint/tests on pinned 1.138.0, and Cloud typecheck/tests. Exact GREEN totals: Companion 37 pass / 0 fail / 4 skip; VS Code 139 pass / 0 fail / 0 skip; Cloud 73 pass / 0 fail / 0 skip. An earlier focused VS Code run, before adding the contributed-callback assertion, had 138 pass / 0 fail / 0 skip. `git diff --check` passed. No dependency or lockfile change.
- Scope audit: Companion status remains separate from Telegram state and comes only from the bounded IPC client. The diff adds no agent discovery, Companion DB/ownership/PID/process inspection, Companion spawn/install/update/restart/supervision, timer/backoff/watcher, new IPC method, generic IPC API, TCP/HTTP/WebSocket fallback, cloud/domain/adapter-SDK/Companion production change, or M0.10+ work. Diagrams 02/10/11 and the listed stop conditions reveal no conflict.
- Concurrency review after Round 3 reported three command-order defects: an issued DELETE racing a newer Connect GET, a second Disconnect sharing a stale first attempt after intervening Connect, and a later Toggle sharing a superseded onboarding prompt. Six deferred-promise tests were added before coordinator production edits; each failed behaviorally on the pinned VS Code 1.138.0 host without TypeScript compilation errors. The tests also covered ambiguous DELETE, queued Connect supersession, and stale rejected refresh credential deletion.
- The lazy Telegram runtime now owns one local `LegacyTelegramCommandCoordinator`: each Connect, Disconnect, and Toggle claims an owner token; only the current owner can share its command's single flight. An issued DELETE remains an independent barrier until settlement, so a later Connect cannot GET while it is unresolved. A confirmed DELETE permits the current Connect to proceed; an ambiguous outcome leaves the projection unknown and does not claim a connected result. Existing connection-state revision checks still fence stale response and pairing callbacks. A later Disconnect supersedes an older credential lookup or queued Connect; a later Toggle upgrades current or queued Connect. Disposal invalidates local owners without issuing a new request.
- Credential recovery uses the same owner/barrier rule. A stale rejected refresh cannot delete a credential belonging to newer work, and a newer Connect waits for recovery already underway. During the final audit, a further deferred test showed that a rejected Disconnect's in-progress credential deletion also needed this barrier: before the narrow fix, its pinned-host RED run was 0 pass / 1 fail; after passing the Disconnect owner into the existing recovery barrier, the test passed. The connected-state Toggle guard was separately tested while a pairing session remained active: the click flips alerts directly once the local projection is connected.
- Final post-correction verification: the focused pinned VS Code 1.138.0 Telegram suite passed 108 / failed 0 / skipped 0. Root `npm run validate` then passed domain typecheck, contracts typecheck/build, adapter SDK typecheck, native Windows IPC build, Companion build/typecheck/tests, VS Code compile/lint/tests on pinned 1.138.0, and Cloud typecheck/tests. Exact final totals: Companion 37 pass / 0 fail / 4 skip; VS Code 152 pass / 0 fail / 0 skip; Cloud 73 pass / 0 fail / 0 skip. `git diff --check` passed. Two isolated pinned-host launches were blocked before tests by sandbox `spawn EPERM`; approved reruns executed the tests, and the complete root gates ran successfully.
- Residual limits: an already-issued DELETE cannot be revoked; the barrier settles its outcome before a later Connect GET, and a lost/ambiguous response requires explicit user retry. Companion Connected remains explicitly a last-check snapshot. The four Companion skips are Unix UDS and executable signal tests unavailable on this Windows host. No Worker, Companion production, architecture, diagram, dependency, or lockfile change was made; no automatic retry, polling, reconnect, new IPC, or M0.10+ behavior was added. Round 3 independent re-review passed before the subsequent three concurrency findings; the corrected concurrency implementation still awaits independent review.
- The next independent concurrency review returned FAIL on three additional interleavings: an older credential deletion could outlive a newer recovery barrier; two cold Toggle clicks during one GET shared one flip; and a Toggle after Disconnect waited for a superseded onboarding prompt. Three production-entry tests using deferred credential deletions, GET, and prompt promises were added before production edits. On the pinned VS Code 1.138.0 host, the RED run compiled and reported 0 pass / 3 fail / 0 skip, one behavioral failure per finding.
- Narrow corrections retain the existing coordinator. It now snapshots all in-flight credential deletions for Connect and waits for all to settle, including when one rejects; owner-scoped stale-result fencing remains. Distinct Toggle clicks share initial discovery but each current-owner click applies its own action in order. A new Toggle clears a superseded initial-prompt reference and acts immediately; the old prompt's eventual selection remains fenced by its existing owner token, while its onboarding persistence path remains intact. No queue framework, polling, retry, new IPC, or Companion/Worker change was added.
- Final verification after these changes: targeted RED cases became 3 pass / 0 fail / 0 skip, and the focused pinned VS Code 1.138.0 Telegram suite passed 111 / 0 / 0. The first full root gate stopped at an activation test that forbids the source word `ownership` in `extension.ts`; a newly added comment contained that word. Rewording the comment changed no behavior, and the complete rerun of `npm run validate` passed domain typecheck, contracts typecheck/build, adapter SDK typecheck, native Windows IPC build, Companion build/typecheck/tests, VS Code compile/lint/tests on pinned 1.138.0, and Cloud typecheck/tests. Exact final counts: Companion 37 pass / 0 fail / 4 Windows skips; VS Code 155 pass / 0 fail / 0 skip; Cloud 73 pass / 0 fail / 0 skip. `git diff --check` passed. Focused VS Code launch initially hit sandbox `spawn EPERM`; the approved rerun executed the RED tests.
- Adjacent lifecycle audit: the credential barrier captures only deletions already issued before Connect starts and waits for every captured promise; a later stale owner cannot initiate credential deletion. Issued DELETE remains separately fenced. Superseded onboarding selection cannot create pairing, and disposal invalidates local callbacks without issuing new requests. Existing Connect/Disconnect/pairing/unknown-refresh tests remained green. Independent re-review of these three corrections is pending; M0.9 remains unchecked and uncommitted.
- The next independent review found that Disconnect → Toggle → Disconnect could run the queued Toggle after the final Disconnect, and that one activation test rejected source substrings instead of verifying behavior. A deferred production-runtime test was added before the ordering fix: with the first Disconnect held at credential lookup, the pinned VS Code 1.138.0 RED run compiled and reported 0 pass / 1 fail because the final Disconnect shared the first promise; the test also asserts no stale Connect CTA, pairing, or enabled alerts and exactly one DELETE from the final owner.
- The existing coordinator now records a deferred Toggle intent at invocation without cancelling the Disconnect it waits for. A later Disconnect therefore owns a distinct attempt and invalidates the queued Toggle; owner-scoped single-flight and the prior Toggle-after-Disconnect behavior remain. Multiple queued Toggle clicks use only a per-Disconnect promise tail, with no general command queue. The activation source-substring assertion was replaced with runtime checks of synchronous command registration, a single scheduled IPC probe, no background reconnect, and no access to legacy secrets/onboarding/workspace state during Companion-only activation. Negative scope was also checked against the changed production paths.
- Final verification: focused cold Telegram runtime plus activation tests passed 42 / 0 / 0, and the broader pinned VS Code 1.138.0 Telegram plus activation selection passed 119 / 0 / 0. The complete root `npm run validate` passed domain typecheck, contracts typecheck/build, adapter SDK typecheck, native Windows IPC build, Companion build/typecheck/tests, VS Code compile/lint/tests on pinned 1.138.0, and Cloud typecheck/tests. The pinned VS Code suite was rerun separately to capture its exact total. Final counts: Companion 37 pass / 0 fail / 4 Windows skips; VS Code 156 pass / 0 fail / 0 skip; Cloud 73 pass / 0 fail / 0 skip. `git diff --check` passed. Isolated focused launches initially hit sandbox `spawn EPERM`; approved reruns executed them successfully.
- Residual limits remain: an already-issued DELETE cannot be revoked, an ambiguous DELETE response requires explicit user retry, Companion status is a last-check snapshot, and the four Companion tests require Unix facilities unavailable on this Windows host. No Companion, Worker, IPC, architecture, diagram, dependency, or M0.10+ change was made. The implementation remains uncommitted and awaits independent final concurrency review.
- Contract-based independent review confirmed three remaining findings against the approved VS Code Telegram concurrency contract: a cold unknown Toggle flipped alerts after its GET returned connected (rule 2); three clicks during one unresolved onboarding prompt could produce a later separate Connect offer after dismissal (rule 4); and an issued DELETE could show a late extension notification after runtime disposal (disposal fencing). Three production-runtime tests, including controlled prompt and DELETE promises, were added before the fixes. The pinned VS Code 1.138.0 RED run compiled and reported 0 pass / 3 fail / 0 skip, with one behavioral failure per finding. Earlier evidence describing a first cold connected Toggle as an alert flip is superseded by approved rule 2.
- The cold Toggle now treats its initial unknown-state GET as refresh only, including when the Worker reports connected; a later distinct connected click flips alerts. Toggles while the same initial unknown discovery or current onboarding prompt is pending share that intent, so dismissal creates no later Connect offer, while accepting onboarding starts one enable-alerts-after-connect pairing. The extension-owned Disconnect notifications and error callback check runtime disposal before touching VS Code UI; issued DELETE still settles normally. No coordinator, Worker, Companion, IPC, or architecture change was made.
- Additional deterministic coverage holds two Toggle clicks behind one issued DELETE. With the first Connect offer held, the second does not create pairing or a simultaneous prompt; dismissal allows its later offer, and accepting the first offer yields one pairing with alerts enabled on connection. The tests also cover a failed DELETE settling after disposal, repeated unknown-state clicks, subsequent connected flips, unknown refresh retry, and the existing Telegram/activation paths.
- Post-fix focused cold Telegram runtime plus activation tests passed 45 / 0 / 0. The broader pinned VS Code 1.138.0 Telegram plus activation selection passed 126 / 0 / 0. The complete root `npm run validate` passed domain typecheck, contracts typecheck/build, adapter SDK typecheck, native Windows IPC build, Companion build/typecheck/tests, VS Code compile/lint/tests on pinned 1.138.0, and Cloud typecheck/tests. Exact final totals: Companion 37 pass / 0 fail / 4 Windows skips; VS Code 163 pass / 0 fail / 0 skip; Cloud 73 pass / 0 fail / 0 skip. One sandboxed full-gate rerun could not locate Python for the native build; its approved unsandboxed rerun passed. An isolated focused host launch likewise hit sandbox `spawn EPERM` before its successful approved rerun. The four Companion skips need Unix facilities unavailable on this Windows host. The corrected contract behavior remains subject to independent re-review; M0.9 remains unchecked and uncommitted.
- A later independent review found that two Toggles deferred behind an issued DELETE were linked with success-only `predecessor.then(...)`: rejection of the first Connect prompt rejected the second click without evaluating its intent. A deterministic production-runtime test held DELETE, queued both clicks, rejected the first prompt, and required a separate second offer; its final form also asserts that each click propagates its own distinct prompt error. The pinned VS Code 1.138.0 RED run compiled and reported 0 pass / 1 fail / 0 skip: only one offer appeared instead of two.
- The per-Disconnect promise tail now resumes the next Toggle after its predecessor settles either way. The first click retains its own rejection; the second checks its deferred owner token and runs its own current-state dispatch. A held prompt still delays later deferred clicks; accepting it shares the active connection/pairing intent, while rejecting or dismissing it allows a later eligible click its own offer. Supersession, disposal, issued-DELETE ordering, and the existing coordinator are unchanged.
- After this correction, the pinned VS Code 1.138.0 focused Telegram plus activation selection passed 127 / 0 / 0. The complete root `npm run validate` passed domain typecheck, contracts typecheck/build, adapter SDK typecheck, native Windows IPC build, Companion build/typecheck/tests, VS Code compile/lint/tests on pinned 1.138.0, and Cloud typecheck/tests. Exact current totals: Companion 37 pass / 0 fail / 4 Windows skips; VS Code 164 pass / 0 fail / 0 skip; Cloud 73 pass / 0 fail / 0 skip. The first isolated test launch hit sandbox `spawn EPERM`; its approved rerun produced the behavioral RED result. No Worker, Companion, IPC, diagram, coordinator, or M0.10+ production change was made. Final independent review is pending; M0.9 remains unchecked and uncommitted.
