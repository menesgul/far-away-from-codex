# WORKPLAN_TODO.md — Current Executable Slice

> Only the slice below is executable. Do not begin M0.9 or later work.

# M0.8 — Add VS Code CompanionClient

## Status

**PLANNED — NOT IMPLEMENTED.**

M0.1–M0.7 are complete. Canonical baseline for this slice is merged `main` commit:

`328bbd859a834cb14cc2a391e6dbd04352d9cc9e`

M0.8 remains unchecked in `WORKPLAN.md` until implementation, regression gates, and independent review pass.

## Objective

Add a VS Code-side `CompanionClient` that consumes the already-locked M0.7 local IPC protocol and can connect to an **already-running** Companion, complete the v1 hello/challenge handshake, issue the two existing read-only requests, and disconnect cleanly.

This slice establishes the client boundary only. It does **not** make extension activation Companion-aware, start/install/update Companion, migrate Telegram ownership, or begin M0.9+.

## Baseline facts from the merged repository

- Companion is the single local runtime authority and owns the IPC server.
- M0.7 exposes only `hello`, `health.get`, and `companion.status`.
- Windows transport is a protected current-user Named Pipe; Unix transport is an owner-only UDS; there is no local TCP.
- Framing is 4-byte unsigned big-endian length + UTF-8 JSON object, maximum 64 KiB.
- `packages/contracts` already owns the v1 wire DTOs.
- Endpoint derivation currently lives in `apps/companion/src/ipc-endpoint.ts`.
- Companion data-root derivation currently lives in `apps/companion/src/paths.ts`.
- The VS Code extension still activates on `onStartupFinished` and directly constructs legacy `BackendClient`, `SecretStore`, Telegram state/onboarding/commands, and the status bar.
- Existing extension regression baseline is 92 tests on VS Code 1.138.0.
- The extension currently has no dependency on `@far-away/contracts` and no Companion IPC client.

## Required architecture — MUST PRESERVE

- Coding-agent runtime owns source truth.
- Companion remains the single local Far Away authority.
- VS Code is an optional UI/setup/bootstrap client only.
- VS Code must never read Companion SQLite or ownership files as state/authority.
- VS Code must never instantiate a competing Companion.
- Local IPC remains Named Pipe / UDS only; no TCP/HTTP/WebSocket fallback.
- OS-user access control is the local-principal boundary.
- Hello challenge/session establishes protocol negotiation, freshness, connection/session binding, and replay isolation; it is not standalone authentication.
- Fail closed on incompatible/malformed protocol.
- No generic command, prompt, shell, source-resolution, or agent-control API.

## Relevant diagrams — MUST REVIEW

Before implementation, reread:

- [ ] `docs/diagrams/02-local-component.mmd`
- [ ] `docs/diagrams/10-deployment-topology.mmd`
- [ ] `docs/diagrams/11-trust-boundaries.mmd`

The diagrams clarify boundaries but do not override explicit locked architecture text. Stop on a conflict.

## Planning resolutions

### A. CompanionClient responsibility in M0.8

`CompanionClient` owns only the VS Code-side mechanics of one local IPC connection:

1. derive/select the canonical local Companion endpoint through shared locator logic;
2. connect through Node `net` to the Named Pipe/UDS;
3. decode the server's `hello.challenge`;
4. send exact v1 `hello` with a bounded request ID and the received challenge;
5. validate `hello.ack` and establish the connection-scoped session;
6. expose typed `health.get` and `companion.status` operations;
7. correlate responses to pending requests;
8. apply bounded timeouts and deterministic cleanup;
9. invalidate all connection/session/request state on disconnect/protocol failure;
10. support multiple independent `CompanionClient` instances without assuming one VS Code window.

It is a transport/protocol client, not a local authority.

### B. Explicit non-responsibilities

M0.8 does not own Companion process lifecycle, installation/update, automatic startup, agent discovery, Telegram/cloud migration, canonical state, persistence, source resolution, policy/routing, or UI/status-bar redesign.

### C. Activation boundary

**Do not integrate CompanionClient into `activate()` in M0.8.**

The current `activate()` performs legacy Telegram/backend initialization and onboarding under `onStartupFinished`. Replacing or restructuring that lifecycle is exactly the M0.9 boundary. M0.8 must deliver a tested client abstraction without changing activation behavior.

### D. Canonical endpoint discovery

Do not duplicate `resolveCompanionPaths()` / `localEndpoint()` formulas inside VS Code and do not import `apps/companion/src/**` from the extension.

Move only the **pure locator vocabulary/derivation** needed by both processes into `packages/contracts` (or a narrowly scoped module inside that package), then have Companion and VS Code consume it.

Allowed shared locator logic:
- deterministic per-user data-root selection inputs/defaults;
- deterministic Named Pipe / UDS endpoint derivation;
- endpoint transport/path type.

Not allowed in the shared package:
- directory creation/chmod;
- ownership acquisition/assertion;
- SQLite paths/lifecycle;
- server security implementation;
- Companion runtime lifecycle.

The endpoint name/path is a locator, never a credential.

### E. Contract reuse

Reuse the existing IPC DTOs from `@far-away/contracts`. Do not import Companion protocol/session/server classes into VS Code.

The client may implement its own small frame codec in `apps/vscode` for this slice. Do not move server protocol state or Companion implementation into a shared package merely for code reuse. If implementation reveals that a pure framing helper genuinely must be shared, stop and report rather than broadening `packages/contracts` into generic runtime code without review.

### F. Reconnect boundary

M0.8 provides **no automatic reconnect loop**.

After disconnect, timeout, malformed response, protocol error, or transport failure:
- the current connection/session is terminal;
- all pending requests reject exactly once;
- session/challenge state is discarded;
- a caller may explicitly call `connect()` again on a clean client instance/state.

Automatic retry/backoff, Companion restart recovery, and restart/multi-window architecture expansion belong to M0.10 (with M0.9 owning activation/bootstrap integration).

### G. Companion absent

Missing endpoint / refused connection is a typed, non-fatal client outcome. It must not:
- start Companion;
- show UI by itself;
- mutate Telegram state;
- fall back to network transport.

M0.9 decides how activation/bootstrap reacts to this state.

### H. Disconnect invalidation

Any terminal connection event invalidates:
- challenge;
- session ID;
- decoder partial state;
- pending request map;
- connection generation.

Late/stale responses from an old connection must never satisfy requests on a later connection.

### I. Minimum proof

M0.8 must prove the client boundary through focused tests:
- fragmented/coalesced frame decoding and exact 64 KiB behavior on the client side;
- successful real local transport handshake against Companion;
- `health.get` and `companion.status` exact typed responses;
- missing Companion endpoint/refused connection;
- incompatible/malformed hello/response handling;
- request timeout;
- connection loss rejects all pending requests exactly once;
- stale/unknown/duplicate response correlation cannot satisfy the wrong request;
- explicit disconnect cleans state;
- two independent client instances can connect to the same already-running Companion without shared mutable client state.

The last item proves the client abstraction only; restart orchestration and broader M0.10 boundary testing remain out of scope.

### J. GAP / CONFLICT

No architecture conflict blocks M0.8.

One implementation boundary must be handled deliberately: endpoint/data-root derivation is currently Companion-local, but VS Code must locate the same endpoint without importing Companion internals or duplicating canonical formulas. The approved M0.8 solution is to extract only this pure locator logic into `packages/contracts`; this does not move authority out of Companion.

## In scope

### 1. Shared pure local-IPC locator

- Extract the minimum pure locator logic from Companion into `packages/contracts`.
- Preserve existing Windows/macOS/Linux/XDG path semantics exactly.
- Preserve M0.7 endpoint derivation exactly.
- Update Companion to consume the shared locator without behavioral change.
- Add focused contract tests/typechecks if required to prove identical derivation.

### 2. VS Code CompanionClient

Add a narrow client area, expected shape:

```text
apps/vscode/src/companion/
  CompanionClient.ts
  ipc-frame.ts
```

Exact filenames may vary only if the existing repository conventions justify it.

Client public surface must remain bounded to connection lifecycle plus:
- `connect()`
- `healthGet()`
- `companionStatus()`
- `disconnect()/dispose()`

No generic `request(type, payload)` or public raw-send escape hatch.

### 3. Client protocol state

- v1 only;
- hello-first;
- exact challenge echo;
- exact session binding;
- bounded request IDs (1–64 UTF-8 bytes);
- maximum 32 client-side pending requests;
- finite per-connect/per-request timeout;
- one response settles one matching request;
- protocol errors are typed/sanitized;
- malformed/incompatible/stale responses fail closed;
- no persistence of challenge/session IDs.

### 4. Transport

- Node local socket client only via Named Pipe/UDS endpoint path.
- No dependency on `@far-away/windows-ipc-security` in VS Code: Windows access control is enforced by the Companion-owned server object; the client uses the OS-authorized Named Pipe.
- No TCP fallback.

### 5. Tests

Add focused VS Code tests under the existing `src/test/**` harness. Where real Companion transport is required, use the actual Companion server/test fixture or a narrowly scoped test helper without importing production Companion authority into extension production code.

## Explicitly out of scope

- modifying `activationEvents`;
- constructing/connecting CompanionClient from `extension.ts`;
- Companion autostart/install/update/bootstrap;
- status-bar/UI changes for Companion;
- deleting/replacing legacy BackendClient/SecretStore/Telegram flows;
- Telegram/cloud schema or Worker changes;
- production agent adapters/discovery/observation/resolution;
- PendingInteraction implementation;
- generic IPC RPC;
- local TCP/HTTP/WebSocket;
- B5 account/installation identity, OAuth, P-256;
- D1–D5;
- iOS/APNs/Live Activity/Dynamic Island;
- automatic reconnect/backoff/restart orchestration;
- M0.11 cleanup;
- M0.12 audit.

## Allowed implementation paths

A conforming implementation should be limited to:

```text
apps/vscode/src/companion/**
apps/vscode/src/test/companion/**
apps/vscode/package.json
apps/companion/src/paths.ts
apps/companion/src/ipc-endpoint.ts
apps/companion/**/tests only where required for locator-regression proof
packages/contracts/src/**
packages/contracts/test/**          # only if introduced for pure locator tests
packages/contracts/package.json    # only if test/build surface requires it
package.json                        # only for explicit gate/workspace script needs
package-lock.json                   # only dependency/workspace metadata caused by the slice
WORKPLAN_TODO.md                    # Completion Evidence only after execution
```

If implementation requires edits to `apps/vscode/src/extension.ts`, `apps/cloud/**`, `packages/domain/**`, `packages/agent-adapter-sdk/**`, `packages/windows-ipc-security/**`, `ARCHITECTURE.md`, or diagrams, stop and report before editing.

## Implementation sequence

1. Verify branch, baseline ancestry, and clean working tree.
2. Reread architecture, this slice, and diagrams 02/10/11.
3. Run/record pre-change regression baseline.
4. Extract pure data-root/endpoint locator logic into contracts without changing M0.7 semantics.
5. Repoint Companion path/endpoint use to the shared locator; run focused Companion locator/IPC tests.
6. Add VS Code client-side bounded frame codec.
7. Implement CompanionClient transport + hello/session establishment.
8. Add bounded correlation, timeout, protocol-error, disconnect, and generation invalidation behavior.
9. Add typed `healthGet()` and `companionStatus()`.
10. Add focused unit tests.
11. Add real transport tests against an already-running test Companion, including two independent clients.
12. Audit that `extension.ts` and activation behavior are unchanged.
13. Run full regression gate.
14. Perform a read-only self-review against architecture/negative criteria.
15. Update only Completion Evidence below. Do not mark M0.8 complete in `WORKPLAN.md`.

## Protocol/client invariants

- Client accepts no application response before a valid `hello.challenge` / `hello.ack` sequence.
- Negotiated version is exactly v1 for this slice.
- Challenge in ack must match the connection's challenge.
- Session ID is connection-scoped and never reused after disconnect.
- Response `requestId` must match exactly one current-generation pending request.
- Response `sessionId` must equal the current session for session-bound responses.
- Unknown request IDs, duplicate terminal responses, wrong-session responses, malformed frames, invalid UTF-8/JSON, oversized frames, and incompatible versions fail closed.
- Pending requests are bounded at 32.
- Request IDs are bounded to 64 UTF-8 bytes and generated by the client.
- Every pending request settles at most once.
- Terminal transport/protocol failure rejects all pending requests and clears all session state.
- Client never treats endpoint knowledge, challenge, or session ID as OS authentication.
- No client operation reads/writes Companion SQLite or ownership artifacts.
- No public generic send/request escape hatch exists.

## Failure behavior

Define typed client failures sufficient to distinguish at least:
- Companion unavailable/refused;
- connection timeout;
- request timeout;
- incompatible protocol;
- protocol violation/malformed response;
- remote protocol error;
- disconnected/closed client.

Error objects/messages must not expose secrets or raw arbitrary payloads.

A protocol violation closes the connection. A normal caller-requested disconnect is idempotent.

## Test plan

### Focused client tests

- frame encode/decode: fragmented prefix/body, coalesced frames, zero/oversized, fatal UTF-8/JSON/non-object, truncated EOF, UTF-8 byte boundary;
- handshake success;
- wrong/incompatible challenge/version/type/shape fails closed;
- absent Companion endpoint is typed/non-fatal;
- health/status success;
- timeout rejects and cleans pending state;
- connection loss rejects all pending once;
- unknown/stale/duplicate response cannot cross-correlate;
- disconnect/dispose idempotency;
- reconnect after terminal state creates a fresh generation/session;
- two independent clients have isolated state.

### Real transport

On the host platform:
- start one test Companion;
- connect client A and complete hello + health/status;
- connect client B to the same Companion and complete hello + health/status;
- disconnect A and prove B remains responsive;
- stop cleanly.

Unix-specific real transport may be skipped on a Windows host only when the skip is explicit and static Unix path/transport tests remain present.

### Regression gate

Run from a clean install where practical:

- `npm ci`
- `npm ls --workspaces --depth=0`
- contracts typecheck/tests if added
- Companion build/typecheck/tests
- VS Code compile/lint/tests; existing 92 tests must remain green in addition to new M0.8 tests
- Cloud typecheck/tests; existing 73 tests remain green
- domain typecheck
- adapter SDK typecheck
- native Windows IPC build
- root `npm run validate`
- `git diff --check`

Record exact pass/fail/skip counts.

## Negative acceptance criteria

M0.8 fails if any of the following occurs:

- VS Code becomes runtime/canonical authority.
- `extension.ts` activation behavior is changed.
- Companion is auto-started/installed/updated.
- Client imports `apps/companion/src/**` in production code.
- Endpoint/data-root formulas are independently duplicated in VS Code.
- VS Code depends on the Windows native server-security package.
- A TCP/HTTP/WebSocket fallback is added.
- A generic public request/send/RPC/command/prompt API is exposed.
- Client reads SQLite/ownership state.
- Challenge/session is described or used as standalone authentication.
- Legacy Telegram behavior is removed/migrated.
- Automatic reconnect/restart orchestration is added.
- Any M0.9+ feature is implemented.
- Existing VS Code/Companion/Cloud regression behavior breaks.

## Stop conditions

Stop and report instead of improvising if:

- shared pure locator extraction would require moving ownership, filesystem mutation, SQLite, secure-store, or runtime authority into contracts;
- the client cannot locate the canonical endpoint without duplicating implementation or crossing app boundaries;
- M0.7 wire behavior must change to make the client work;
- a required behavior needs a new IPC request beyond `hello`, `health.get`, `companion.status`;
- VS Code activation must change to make the slice testable;
- the implementation would require `@far-away/windows-ipc-security` in VS Code;
- a platform requires local TCP fallback;
- tests cannot prove request/session invalidation without broadening into M0.10;
- any locked architecture/diagram conflicts with the real repository.

## Acceptance criteria

- [x] Baseline/branch/clean-tree preconditions recorded.
- [x] Diagrams 02, 10, and 11 reviewed.
- [x] Pure canonical locator logic is shared without moving authority out of Companion.
- [x] Companion M0.7 endpoint/path behavior remains unchanged.
- [x] VS Code has a bounded CompanionClient with no generic request escape hatch.
- [x] Real v1 hello/challenge/session handshake works.
- [x] `health.get` works through typed client API.
- [x] `companion.status` works through typed client API.
- [x] Missing Companion is typed and non-fatal.
- [x] Timeouts are finite and tested.
- [x] Disconnect invalidates session/pending state.
- [x] Stale/unknown/duplicate responses cannot cross-correlate.
- [x] Two independent clients can share one Companion without shared client authority/state.
- [x] No activation/M0.9 behavior changed.
- [x] Existing Telegram behavior remains green.
- [x] No local TCP/generic command/source-operation surface exists.
- [x] Full regression gate passes.
- [x] Negative-scope audit passes.
- [x] Independent review passes before M0.8 is checked in `WORKPLAN.md`.

## Completion Evidence

**Status:** CLOSED / PASS. Independent M0.8 re-review passed; acceptance boxes and `WORKPLAN.md` are checked.

- Start: clean `planning/m0.8-vscode-companion-client` at `1db5525e913e2efe4e157d8630e3bcf06edfcdc4`; only the M0.8 planning commit follows ancestor `328bbd8`.
- Pre-change baseline: root `npm run validate` passed; contracts, domain, adapter SDK, Cloud and Companion typechecks, Companion build, VS Code compile/lint, and Windows native IPC build passed. Companion: 37 pass, 0 fail, 4 skip (41 total). VS Code 1.138.0: 92 pass, 0 fail, 0 skip. Cloud: 73 pass, 0 fail, 0 skip (6 files).
- Changed implementation paths: `packages/contracts/src/index.ts`, new `packages/contracts/src/local-locator.ts`, `packages/contracts/package.json`, `apps/companion/src/paths.ts`, `apps/companion/src/ipc-endpoint.ts`, `apps/companion/package.json`, new `apps/vscode/src/companion/CompanionClient.ts` and `ipc-frame.ts`, `apps/vscode/package.json`, root `package.json`, and `package-lock.json`. New tests: `apps/vscode/src/test/companion/CompanionClient.test.ts`, `ipc-frame.test.ts`, and `real-transport.test.ts`.
- Shared locator: contracts now owns only pure data-root selection and M0.7 Named Pipe/UDS derivation. Companion's existing path and endpoint imports delegate to it; SQLite and ownership paths, filesystem mutation, IPC ownership, and native security remain Companion-local. Golden Windows, macOS, Linux/XDG, and Unix endpoint tests pass; existing Companion locator/IPC tests pass unchanged.
- Client API: `connect()`, typed `healthGet()`, typed `companionStatus()`, `disconnect()`, and `dispose()`. It selects the shared canonical endpoint and uses Node local sockets only. It validates `hello.challenge`, sends exact v1 `hello`, accepts only matching `hello.ack`, then binds the returned session to that connection.
- Correlation/lifecycle: generated unique IDs remain at most 64 UTF-8 bytes; at most 32 requests are pending. Finite connect/handshake and request timers, exact response shape/session/ID checks, sanitized typed errors, terminal fail-closed behavior, pending rejection/cleanup, and generation invalidation are tested. Missing/closed endpoint returns typed `unavailable`; no startup, UI, Telegram mutation, or network fallback occurs.
- Real transport: on Windows, a test Companion process served two independent CompanionClient instances through the actual Named Pipe. A completed hello, health and status reads; B completed hello/read, then stayed responsive after A disconnected. Both clients and the test Companion stopped cleanly.
- Focused tests: 17 pass, 0 fail, 0 skip. Final clean root `npm ci` installed 404 packages; `npm ls --workspaces --depth=0` passed. Contracts typecheck/build passed; no contracts test suite was added. Companion build/typecheck/tests: 37 pass, 0 fail, 4 skip (41 total). VS Code compile/lint/complete VS Code 1.138.0 suite: 109 pass, 0 fail, 0 skip (92 existing plus 17 new). Cloud typecheck/complete suite: 73 pass, 0 fail, 0 skip (6 files). Domain and adapter SDK typechecks, native Windows IPC build, root `npm run validate`, and `git diff --check` passed.
- Independent review correction: both P1 findings were reproduced. With ignored contracts `dist` temporarily absent, direct Node resolution failed with `MODULE_NOT_FOUND` and independent `npm run companion:test` failed because its build had not produced contracts runtime JS. The Companion manifest and lockfile lacked its runtime `@far-away/contracts` dependency. The correction adds that dependency to both and uses Companion `prebuild` to build contracts; VS Code `precompile` builds contracts and `preextension:test` compiles before its independent test command. No locator or IPC wire logic changed.
- Cold lifecycle proof: after explicitly removing `packages/contracts/dist`, clean root `npm ci` succeeded (404 packages) and left that directory absent. Without manual contracts build or root validate, independent `npm run companion:test` invoked contracts build through `prebuild` and passed 37/0/4 (41 total). Contracts `dist` was removed again; independent `npm run extension:test` invoked `preextension:test` → `compile` → `precompile` → contracts build and passed 109/0/0 on VS Code 1.138.0. A separate focused M0.8 run passed 17/0/0.
- Dependency closure: `apps/companion/package.json` and `package-lock.json` both declare `@far-away/contracts: 0.0.1`; `npm ls --workspace=@far-away/companion --omit=dev --depth=0` lists contracts and Windows IPC as Companion production dependencies. Node resolution from the Companion package resolves the built contracts `dist/index.js` and its locator. The current M0 packaging is private npm workspaces; isolated publication outside that workspace is unsupported and was not claimed. Final `npm ls --workspaces --depth=0`, contracts/Companion/Cloud/domain/adapter SDK typechecks, contracts/Companion/native Windows builds, VS Code compile/lint, complete Companion 37/0/4, VS Code 109/0/0, Cloud 73/0/0 (6 files), and root `npm run validate` passed.
- Preservation: `apps/vscode/src/extension.ts`, activation events, Telegram code, Cloud, domain, adapter SDK, Windows native security code, architecture and diagrams have no diff. Existing 92 VS Code tests remain green.
- Reviewed diagrams: `02-local-component.mmd`, `10-deployment-topology.mmd`, and `11-trust-boundaries.mmd`. Read-only negative-scope audit found no Companion implementation import in VS Code, duplicated locator formula, public generic request/send API, TCP/HTTP/WebSocket fallback, automatic reconnect, SQLite/ownership access from VS Code, Windows security-package import in VS Code, M0.9+ change, or challenge/session-as-authentication claim.
- Platform limits: Windows Named Pipe transport was executed. Unix-only Companion tests (2) and executable signal-handler tests (2) are skipped on Windows; Unix locator semantics were tested statically. Isolated package publication outside the root npm workspace was not tested. No architecture GAP/CONFLICT was found within M0.8.
- Independent re-review: both corrected P1 findings are CLOSED; the review found 0 BLOCKER, 0 MAJOR, 0 MINOR, 0 GAP, and 0 CONFLICT findings and returned PASS for M0.8 closure.

Do not mark M0.8 complete in `WORKPLAN.md` until this evidence has passed independent review.
