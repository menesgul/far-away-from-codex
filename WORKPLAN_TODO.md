# WORKPLAN_TODO.md — Active Implementation Slice

> **Current milestone:** M0 — Repository & Runtime Foundation
>
> **Current step:** M0.7 — Implement Minimal Local IPC Protocol
>
> Implement **only this step**. Do not begin M0.8 or any later work.

## Why this step exists

M0.5 established the standalone Companion process and M0.6 established deterministic local paths, single-instance ownership, and the canonical SQLite lifecycle. M0.7 adds the first supported local client boundary around that Companion:

- a per-user local IPC server owned by Companion;
- Windows Named Pipe / Unix Domain Socket transport, never TCP;
- versioned length-delimited JSON framing;
- minimal protocol-v1 negotiation and read-only health/status requests;
- multiple transport clients may connect without becoming Companion authority.

This slice proves the Companion can expose a narrow local control/diagnostic boundary. It does **not** yet add the VS Code CompanionClient, extension activation/bootstrap, agent operations, or remote/cloud actions.

## Verified starting state

Authoritative merged checkpoint on `main`:

`e29dd858b998fe2f5d319aadcb67b774a1c8e568`

Merge message:

`Merge pull request #4 from menesgul/planning/m0.6-persistence`

At this checkpoint:

- M0.1–M0.6 are marked complete in `WORKPLAN.md`;
- the repository has six workspaces and one canonical root lockfile;
- `apps/companion` is a standalone Node >=22.17 TypeScript process;
- Companion acquires one local ownership claim before opening its canonical SQLite database;
- SQLite WAL/migrations and restart-safe cleanup are green;
- Companion reaches READY independently of VS Code;
- `packages/contracts` currently contains only `ProtocolVersion` and JSON wire vocabulary; concrete IPC messages do not yet exist;
- no Named Pipe/UDS server, local TCP server, IPC framing, negotiation, challenge/session authentication, or VS Code CompanionClient exists;
- reviewed M0.6 regression evidence is Companion 21 passing / 2 documented Windows signal skips, VS Code 92 passing on 1.138.0, Cloud 73 passing across 6 files, and aggregate validation green.

Planning branch:

`planning/m0.7-ipc`

Before implementation, verify the local checkout is based on this branch/checkpoint, is up to date, and has no unrelated working-tree changes. Otherwise stop and report.

## Architecture source — MUST REVIEW

Read `ARCHITECTURE.md`, `WORKPLAN.md`, and this file before editing.

M0.7 is derived primarily from locked **B3/B4/B5 local-boundary decisions** plus the Phase A product boundary. Later C/D/E decisions remain constraints only: local IPC must not become a generic agent controller, cloud relay, policy/action path, or remote source-resolution surface.

The relevant canonical diagrams are **exactly these three**:

1. `docs/diagrams/02-local-component.mmd` — Companion owns the Local IPC Server; VS Code is only a local client and does not become runtime authority.
2. `docs/diagrams/10-deployment-topology.mmd` — VS Code ↔ Companion uses Named Pipe / UDS inside the desktop OS account boundary; no local TCP.
3. `docs/diagrams/11-trust-boundaries.mmd` — local IPC remains inside TB1; it must not cross into cloud/provider/source authority.

Do **not** require diagrams 01, 03–09 for this slice. M0.7 implements no agent integration, source permission round-trip, offline source revalidation, multi-device behavior, Telegram, cloud relay, or iOS.

Diagrams clarify boundaries; explicit locked architecture text wins on conflict.

## Locked architecture constraints

Preserve all of the following:

- Companion remains the standalone per-user **single local Far Away authority**.
- Local IPC is owned by Companion, not VS Code.
- Windows transport is a Named Pipe; Unix-like transport is a Unix Domain Socket.
- no local TCP/HTTP/WebSocket listener exists.
- the protocol is versioned, length-delimited JSON.
- protocol incompatibility fails closed.
- OS-user access control is part of the local IPC boundary and is the authentication boundary for which local OS principals may connect.
- M0.7 uses **OS-authenticated transport + protocol session establishment**. The protocol challenge/nonce and session identifier provide freshness, negotiation/session binding, and replay isolation; they are not standalone client authentication and must never be described as such.
- M0.7 must not invent B5 InstallationIdentity, OAuth, relay credentials, P-256 enrollment, or a shared secret in the data directory.
- multiple local transport clients may connect to the same Companion without becoming authorities.
- VS Code remains UI/setup/bootstrap only; M0.7 does not implement `CompanionClient`.
- no generic `sendPrompt`, `executeCommand`, arbitrary method, shell, agent command, or source-resolution endpoint may exist.
- IPC status never implies coding-agent/source authority.
- SQLite remains the single canonical Companion database lifecycle from M0.6; IPC must not introduce another canonical writer.

## Exact scope

### 1. Local endpoint policy and transport abstraction

Add a small testable Companion-owned local IPC transport abstraction.

Endpoint policy:

- Windows: deterministic per-user Named Pipe name derived from the selected Companion data-root identity/path without embedding secrets;
- macOS/Linux/other Unix: deterministic Unix Domain Socket path inside the selected Companion data root;
- tests use explicit temporary roots/endpoints and never the real user Far Away directory.

Required transport semantics:

- bind/listen only after M0.6 ownership + SQLite bootstrap succeeds;
- no TCP port and no HTTP/WebSocket server;
- reject startup if the selected local endpoint cannot be bound safely;
- Unix stale socket cleanup is allowed only after Companion ownership for that data root is held; never unlink an endpoint that may belong to another live authority;
- Unix socket permissions must be restricted to the owning OS user where Node/platform support permits;
- Windows Named Pipe must be created with an explicit protected Windows security descriptor/DACL that grants the intended current user/logon principal access and does not rely on the default Named Pipe security descriptor. The implementation may introduce the smallest narrowly scoped native Windows security boundary required to call documented Windows Named Pipe/security APIs. That native boundary owns only secure pipe creation/access control; it must not own Far Away protocol, domain, Companion lifecycle, agent, cloud, or identity logic;
- do not use Node/libuv private or undocumented internals as the security boundary;
- Unix Domain Socket access must be restricted to the owning user with mode `0600` after bind (and the containing Far Away data root remains per-user);
- closing the IPC server must stop accepting new clients and clean up the endpoint without releasing M0.6 process ownership prematurely.

Do not use the IPC endpoint as the M0.6 single-instance primitive.

### 2. Length-delimited JSON framing

Implement a deterministic streaming frame codec for local IPC.

Use a fixed **4-byte unsigned big-endian length prefix** followed by exactly that many UTF-8 bytes containing one JSON value.

Requirements:

- frame length counts UTF-8 bytes, not JavaScript characters;
- parsing supports fragmented prefix/body reads and multiple frames in one read;
- define a conservative maximum frame size of **64 KiB** for M0.7;
- zero-length, oversized, truncated-at-EOF, invalid UTF-8, invalid JSON, and non-object top-level frames fail closed;
- malformed input closes/rejects only that client connection and must not terminate Companion or other clients;
- no newline-delimited or delimiter-scanning fallback;
- outbound messages use the same codec.

### 3. Protocol v1 contracts and envelope

Extend `packages/contracts` with only the concrete local IPC v1 wire DTOs required by M0.7.

Every message must carry a protocol version and explicit message type. Keep DTOs JSON-only and separate from canonical domain types.

Protocol v1 request surface is exactly:

- `hello`
- `health.get`
- `companion.status`

And corresponding bounded responses/errors.

Required semantics:

- `hello` is mandatory before any other request;
- client proposes its supported protocol range/version;
- Companion selects a compatible v1 version or returns a protocol error and closes;
- major-version incompatibility fails closed;
- unknown message types fail closed for that request/connection and never dispatch arbitrary methods;
- request IDs are opaque correlation values with a documented bounded string size; they are not authority tokens;
- duplicate in-flight request IDs on one connection are rejected;
- wire errors are typed and sanitized; no stack traces, filesystem secrets, database handles, source/vendor payloads, or raw exception objects cross IPC.

Do not add generic RPC method names or a generic command envelope that future code could use to bypass the explicit allowlist.

### 4. OS-authenticated transport + protocol session establishment

After transport connection, establish a connection-local challenge as part of `hello`.

M0.7 separates two responsibilities: the OS transport boundary determines which local principal may connect; the protocol handshake establishes a fresh negotiated Far Away session on an already OS-authorized connection. A challenge echo by itself is **not** authentication.

Requirements:

- Companion generates a fresh unpredictable challenge/nonce per OS-authorized connection;
- the successful `hello` exchange must bind the negotiated protocol and a fresh connection/session identifier to that challenge;
- no non-`hello` request is accepted before the connection reaches protocol-established state;
- session/challenge values are connection-local, short-lived runtime material and are never InstallationIdentity, relay credentials, or source authority;
- reconnect creates a new challenge/session; old connection material cannot be replayed as a current session;
- do not persist session/challenge values in SQLite;
- do not expose cloud/relay credentials to local clients.

Windows must obtain the required access-control guarantee from documented Windows security primitives (explicit Named Pipe security descriptor/DACL), and Unix from UDS filesystem permissions. The challenge/session layer must not be presented as a substitute for that OS authentication boundary. Do not invent a shared secret in the data directory.

### 5. Minimal read-only request behavior

Implement only:

`health.get`
- proves the Companion IPC service is responsive;
- returns bounded process/runtime health information only;
- must not claim agent/source health or authority.

`companion.status`
- returns the Companion runtime state and minimal protocol/runtime metadata needed by future local clients;
- must not expose canonical DB internals, source sessions, PendingInteraction data, relay credentials, filesystem secrets, or vendor payloads.

Both requests are read-only. They must not mutate canonical state or SQLite.

### 6. Runtime integration and ordering

Extend the M0.6 executable lifecycle so startup is:

`paths/ownership → SQLite/migrations → local IPC bind/listen → READY`

Shutdown is:

`STOPPING → stop accepting IPC → close active IPC connections → close SQLite → release ownership → STOPPED → release executable lifetime hold`

Requirements:

- if IPC bind/start fails, unwind IPC resources if any, then SQLite, then ownership; never reach READY;
- IPC client disconnect must not stop Companion;
- malformed/failed client must not affect other clients;
- multiple simultaneous clients are allowed at the transport/protocol layer;
- repeated/concurrent Companion shutdown remains idempotent.

M0.8 will add the actual VS Code client. Do not modify VS Code application behavior in M0.7.

## Tests required

Add deterministic focused tests covering at least:

- Windows endpoint policy produces a Named Pipe and never a TCP endpoint;
- Windows secure pipe creation applies an explicit protected DACL for the intended current user/logon principal and does not fall back to the default Named Pipe security descriptor;
- Unix real-transport coverage verifies the UDS is restricted to mode `0600` where supported;
- Unix endpoint policy produces a UDS inside a temp data root;
- Unix stale endpoint handling is safe and occurs only under Companion ownership;
- frame encode/decode uses UTF-8 byte length;
- fragmented prefix/body parsing;
- multiple frames in one chunk;
- zero/oversized/truncated/invalid-UTF8/invalid-JSON/non-object frames fail closed;
- one malformed client does not terminate the IPC server or another healthy client;
- `hello` is required before every non-hello request;
- compatible v1 negotiation succeeds;
- incompatible major version fails closed;
- unknown message type is rejected without generic dispatch;
- duplicate in-flight request ID rejection;
- fresh protocol challenge/session material per OS-authorized connection and reconnect;
- stale/replayed connection material is not accepted as a current session;
- `health.get` returns only bounded local health;
- `companion.status` returns only bounded Companion/runtime metadata;
- neither read-only request writes to SQLite/canonical state;
- server bind occurs only after M0.6 storage ownership/bootstrap;
- IPC startup failure prevents READY and unwinds storage/ownership;
- shutdown closes IPC before SQLite/ownership;
- at least two real local transport clients can connect concurrently to one Companion and independently complete `hello` + read-only requests;
- disconnecting one client leaves the other client and Companion alive.

Where platform-specific transport tests cannot execute on the current OS, keep pure endpoint-policy tests cross-platform and explicitly document skipped real-transport coverage. Do not fake a TCP transport for portability.

Preserve the two documented Windows signal-test skips from M0.5/M0.6; do not solve them in this slice unless required by IPC shutdown correctness.

## Root/regression contract

M0.7 should be dominated by `apps/companion/**` and `packages/contracts/**`. Root/lockfile edits are allowed only for a justified dependency or orchestration change.

Run:

1. clean root `npm ci`;
2. verify all six workspaces;
3. Companion build/typecheck/tests;
4. domain/contracts/adapter-sdk typechecks;
5. VS Code compile/lint/**92 tests on VS Code 1.138.0**;
6. Cloud typecheck/**73 tests across 6 files**;
7. aggregate root `npm run validate`;
8. `git diff --check`.

No existing VS Code/Cloud/package test may be deleted, skipped, or weakened to pass M0.7.

## Explicitly forbidden in M0.7

Do **not** implement:

- VS Code `CompanionClient`, activation, bootstrap, status bar, view, walkthrough, or extension behavior changes;
- local TCP, HTTP, WebSocket, gRPC, Electron IPC, or stdio as the production transport;
- generic RPC/command/prompt/shell/agent-control endpoints;
- agent manager, production/fake agent adapters, discovery/observation/resolution;
- AgentSession/PendingInteraction/AttentionEvent/outbox production persistence;
- source request resolution or permission round-trip;
- Companion ↔ cloud relay;
- Telegram behavior changes;
- account/OAuth/InstallationIdentity/P-256/secure-store enrollment;
- D1 routing, D2 escalation, D3 policy, D4 synthetic attention, D5 inbox;
- iOS/APNs/Live Activity/Dynamic Island;
- changes to canonical diagrams or `ARCHITECTURE.md`.

## Relevant diagrams — MUST REVIEW

Before implementation and again during final self-review:

- [x] `docs/diagrams/02-local-component.mmd`
- [x] `docs/diagrams/10-deployment-topology.mmd`
- [x] `docs/diagrams/11-trust-boundaries.mmd`

Review questions:

- Is Companion still the sole owner of the IPC server and canonical local runtime?
- Is VS Code still only a future client rather than runtime authority?
- Is the transport exclusively Named Pipe / UDS with no local TCP?
- Does Windows enforce the intended local principal boundary with an explicit protected Named Pipe DACL and Unix with UDS permissions before protocol session establishment?
- Is the challenge/session mechanism correctly described as protocol freshness/session binding rather than standalone client authentication?
- Can malformed/incompatible clients affect only themselves rather than Companion/other clients?
- Does IPC expose only the explicit M0.7 read-only allowlist?
- Can any IPC message be interpreted as a generic agent/source command?
- Are challenge/session values clearly distinct from InstallationIdentity, relay credentials, and source authority?
- Does shutdown close IPC before SQLite/ownership?
- Did any M0.8+ responsibility get pulled forward?

Any NO/unclear answer is a review finding.

## Acceptance criteria

M0.7 is complete only when:

- [x] Windows endpoint policy is Named Pipe and Unix endpoint policy is UDS;
- [x] no local TCP/HTTP/WebSocket listener exists;
- [x] Windows Named Pipe creation uses an explicit protected DACL for the intended current user/logon principal rather than the default descriptor, and Unix UDS access is restricted to mode `0600` where supported;
- [x] framing is 4-byte big-endian length-prefixed UTF-8 JSON with a 64 KiB maximum;
- [x] fragmented/coalesced frames parse correctly and malformed frames fail closed per client;
- [x] concrete protocol-v1 contracts contain only `hello`, `health.get`, `companion.status`, and bounded responses/errors;
- [x] `hello` is mandatory and incompatible protocol versions fail closed;
- [x] fresh per-connection protocol challenge/session material exists, reconnect invalidates old connection material, and this mechanism is not claimed as standalone client authentication;
- [x] no shared secret, InstallationIdentity, relay credential, or source authority is invented for IPC;
- [x] `health.get` and `companion.status` are read-only and bounded;
- [x] multiple local transport clients can coexist without becoming authorities;
- [x] one malformed/disconnected client does not terminate Companion or another client;
- [x] IPC binds only after M0.6 storage bootstrap and closes before SQLite/ownership;
- [x] IPC startup failure prevents READY and unwinds acquired resources;
- [x] M0.5/M0.6 lifecycle and persistence semantics remain intact;
- [x] clean install and full regression gates pass;
- [x] implementation conforms to diagrams 02, 10, and 11;
- [x] no M0.8 VS Code client or later feature work has begun.

## Expected change shape

A conforming diff should be dominated by:

```text
apps/companion/src/**
apps/companion/test/**
packages/contracts/src/**
packages/contracts/test/**          # if contract-focused tests are justified
packages/windows-ipc-security/**     # only if used for the narrow documented Windows DACL/native boundary
package.json / package-lock.json    # only if genuinely required
WORKPLAN_TODO.md                    # Completion Evidence only during execution
```

Unexpected edits to `apps/vscode/**`, `apps/cloud/**`, `packages/domain/**`, `packages/agent-adapter-sdk/**`, diagrams, or `ARCHITECTURE.md` require explanation and normally indicate scope drift.

## Stop conditions

Stop and report instead of improvising if:

- local checkout does not descend from merged M0.6 checkpoint `e29dd858b998fe2f5d319aadcb67b774a1c8e568`;
- unrelated local changes are present;
- a proposed implementation requires local TCP/HTTP/WebSocket;
- the documented Windows security APIs cannot provide the required explicit per-user/logon-principal Named Pipe DACL through a narrowly scoped native boundary, or Unix cannot enforce the required UDS owner permissions;
- implementation would require a generic RPC/command surface;
- VS Code must be modified to make the protocol work;
- IPC would open before M0.6 ownership/storage bootstrap;
- IPC lifecycle would outlive or compete with the authoritative Companion lifecycle;
- SQLite would gain another canonical writer;
- implementation requires agent/session/source-resolution state;
- a locked A–E architecture invariant or diagram 02/10/11 conflicts with the slice.

## Completion Evidence

**Status:** COMPLETE — independent re-review PASS.

- Starting checkout: `planning/m0.7-ipc` at `5b8ebe7a0587ba3cbc14a2fc31b1911b1e295d90`; the M0.6 merge `e29dd858b998fe2f5d319aadcb67b774a1c8e568` is an ancestor; the starting working tree was clean.
- Changed files: Companion application, endpoint, framing, protocol, transport, storage ownership assertion, executable integration, and three focused test files under `apps/companion/`; explicit v1 DTOs in `packages/contracts/src/index.ts`; the narrow `packages/windows-ipc-security/` native package; root and Companion package manifests and root lockfile; this Completion Evidence section. No VS Code, Cloud, domain, adapter SDK, architecture, or diagram file changed.
- Endpoint/transport: Windows uses a deterministic `\\.\pipe\far-away-<32 hex SHA-256 prefix>` locator from the normalized, lowercased selected data-root path. Unix uses `companion.sock` inside the selected data root. Neither is a credential. The server exposes no TCP, HTTP, WebSocket, or gRPC listener.
- Windows OS boundary: the native Node-API addon obtains the current process token's user SID, converts `D:P(A;;GA;;;<current-user-SID>)` to a security descriptor, passes it explicitly to `CreateNamedPipeW`, requests `PIPE_REJECT_REMOTE_CLIENTS`, and refuses startup unless `GetSecurityInfo` confirms a protected DACL with exactly one current-user allow ACE. The Windows focused test observed `{ protectedDacl: true, currentUserOnly: true, aceCount: 1, rejectRemoteClients: true }`. The native code handles protected pipe creation/access control and the necessary raw pipe byte I/O; it has no Far Away protocol, domain, agent, cloud, or identity logic and uses no private Node/libuv handle API.
- Unix OS boundary: code requires a real current-user data-root directory, restricts it to `0700`, binds a UDS, sets and verifies socket mode `0600`, and probes an existing socket before removing it only after the M0.6 ownership assertion. Two Unix real-transport tests cover mode and live/stale endpoint behavior but were skipped on this Windows host; Unix behavior was not executed here.
- Framing: four-byte unsigned big-endian payload length, fatal UTF-8 JSON object decoding, and a 64 KiB byte maximum. Focused tests passed for UTF-8 byte counts, fragmented prefix/body, coalesced frames, and zero, oversized, truncated, invalid UTF-8/JSON, and non-object frames.
- Protocol: only `hello`, `health.get`, and `companion.status` requests plus their explicit v1 responses and sanitized typed errors. `hello` negotiates v1 before read-only requests; incompatible ranges/versions, unknown messages, invalid sessions, and duplicate in-flight IDs fail closed. Request IDs are limited to 64 UTF-8 bytes and 32 simultaneous in-flight requests per connection.
- Session: each OS-authorized connection gets a fresh 32-byte random challenge; successful `hello` binds it to v1 and a fresh UUID session ID. Reconnect changes both; stale challenge/session material is rejected and never stored in SQLite. Challenge echo and session ID provide protocol freshness and replay isolation, not standalone client authentication; the OS ACL/UDS permissions define the local principal boundary.
- Read-only surfaces: `health.get` returns only `service: responsive` and bounded uptime seconds. `companion.status` returns only runtime state, transport kind, and v1 metadata. Focused tests compared exact response objects and checked canonical SQLite migration count/schema version before and after requests; handlers contain no storage dependency.
- Lifecycle: startup is ownership → SQLite/WAL/migrations → IPC bind/security check → READY. Shutdown stops accepting and closes IPC clients before SQLite closes and ownership releases. A real occupied endpoint prevented READY and produced database-close then ownership-release events; repeated/concurrent stop remained idempotent. A newly injected `ipc-bound` hook failure produced IPC-close → database-close → ownership-release events, never reached READY, left the endpoint unavailable, and permitted a subsequent startup and client handshake.
- Independent-review BLOCKER correction: Windows `disconnect()` now only marks/cancels the client; it never joins a reader from a data callback. Native data and control events wait at the bounded 256-event Node-API queue rather than dropping another client's data. A queued close event triggers client reclamation after it reaches JavaScript; server shutdown sets `closing` before joining readers. The Windows regression test blocked JavaScript while a child flooded the real Named Pipe, observed `queueFullCount > 0`, sent a malformed zero-length frame, and then confirmed a second real client received `health.get`, Companion remained READY, native clients were reclaimed, and shutdown completed.
- Independent-review MAJOR correction: initialization failure after IPC bind now calls the IPC-first disposal path before closing SQLite and releasing ownership. The injected post-bind failure test verified ordering, no READY, no listening endpoint, and successful restart/bind.
- Independent-review MINOR correction: the Windows close event now reaps its finished native client without awaiting a new connection. A dedicated clean-disconnect test verified native client count returned to zero while Companion remained READY; the pressure test also verified reclamation after malformed closure.
- Focused/local result on Windows Node 22.17.1: Companion suite **37 passed, 0 failed, 4 skipped** (two Unix-only tests and the two existing Windows signal tests). The focused real transport file passed **8, skipped 2**; explicit DACL, saturated queue/malformed-client isolation, post-bind failure unwind, and clean-disconnect reclamation tests passed.
- Full gate after correction: clean root `npm ci` passed; `npm ls --workspaces --depth=0` listed the original six plus the native workspace; native build passed with node-gyp/Visual Studio; Companion build/typecheck/tests and domain/contracts/adapter SDK typechecks passed; VS Code compile/lint and **92 tests on VS Code 1.138.0** passed; Cloud typecheck and **73 tests across 6 files** passed; aggregate `npm run validate` passed. `git diff --check` passed.
- Read-only architecture/scope review: diagrams 02, 10, and 11 were reread. Companion remains the only local runtime/IPC owner; VS Code remains a future client; all IPC stays in TB1 over Named Pipe/UDS; no source, cloud, provider, or mobile authority enters the protocol. No M0.8 client, agent adapters, source resolution, relay, Telegram change, identity enrollment, D1–D5, iOS, generic command surface, or canonical diagram/architecture edit was introduced.
- Platform limitation: real Unix UDS `0600` and stale-socket tests could not execute on this Windows host and are explicitly skipped as allowed by this slice. The three independent-review findings were independently re-reviewed and confirmed RESOLVED; no new finding, GAP, or CONFLICT remains. M0.7 is closed.
