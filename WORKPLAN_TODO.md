# WORKPLAN_TODO.md — Active Implementation Slice

> **Current milestone:** M0 — Repository & Runtime Foundation
>
> **Current step:** M0.4 — Introduce Domain / Contracts / Adapter SDK Boundaries
>
> Implement **only this step**. Do not begin M0.5 or any later work.

## Why this step exists

M0.1–M0.3 established and verified the migration baseline, a single npm workspace/install graph, and physical application boundaries under `apps/vscode` and `apps/cloud`.

M0.4 is the first new architecture-code slice. Its purpose is deliberately narrow: create the provider-neutral package boundaries that later Companion work can depend on **without creating the Companion yet and without migrating existing application behavior into the new packages**.

This slice establishes three contracts:

```text
packages/domain             canonical Far Away vocabulary and invariants
packages/contracts          process/network wire-contract boundary
packages/agent-adapter-sdk  provider-neutral adapter ports
```

The packages must be useful enough to compile, test, and constrain later implementation, but must not speculate ahead into IPC transport, SQLite, cloud relay, real adapters, routing, policy, or remote actions.

## Verified starting state

Starting point: merged M0.1–M0.3 checkpoint on `main`.

Expected checkpoint:

`ee2e38af969fec2600831d4c6cd9d736f5e57324`

At this checkpoint:

- `WORKPLAN.md` marks M0.1, M0.2, and M0.3 complete and M0.4 incomplete;
- root is an orchestration-only private npm workspace;
- root workspaces are exactly `apps/vscode` and `apps/cloud`;
- `apps/vscode` contains the existing extension;
- `apps/cloud` contains the existing Cloudflare Worker;
- one canonical root `package-lock.json` exists;
- `tsconfig.base.json` provides shared `strict: true` and ES2022 target invariants;
- existing production application code was preserved by M0.3;
- reviewed regression gate is extension compile/lint/**92 tests**, Cloud typecheck/**73 tests across 6 files**, aggregate `npm run validate` PASS;
- the reviewed VS Code regression runtime is **1.138.0**.

If execution does not start from the reviewed checkpoint (or a planning-only descendant of it), or the working tree contains unrelated changes, stop and report.

## Architecture source

Treat `ARCHITECTURE.md` as authoritative. For this slice, especially preserve:

- canonical domain is provider-neutral;
- vendor payloads are never canonical truth;
- Far Away `sessionKey` is distinct from source/vendor session identity;
- lifecycle, attachment, and authority are distinct;
- persisted state never proves live authority;
- source resolution requires exact current correlation and authority;
- terminal interactions do not become pending again;
- delivery state does not change source truth;
- support is scoped to agent + topology + version/evidence;
- adapters expose independent optional Discovery / Observation / Resolution ports;
- discovery is non-mutating;
- resolution accepts only exact current source correlation plus an allowed bounded response;
- there is no generic agent command/prompt API.

Do not reinterpret architecture in order to make package design easier. Surface a conflict instead.

## Target shape for this slice

M0.4 should add only:

```text
packages/
├── domain/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
├── contracts/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
└── agent-adapter-sdk/
    ├── package.json
    ├── tsconfig.json
    └── src/
```

Tests may live package-locally where they directly verify these package contracts.

Do **not** create `apps/companion` or `packages/test-support` in this slice. Shared test support is deferred until a real cross-package need exists.

## Package ownership

### 1. `packages/domain`

Own the smallest coherent canonical vocabulary required to make the locked B1 model concrete.

The domain package should define explicit provider-neutral types for:

- `AgentDescriptor`;
- `RuntimeTopology`;
- `AgentSession`, including a Far Away-owned `sessionKey`;
- `SourceSessionRef`;
- `PendingInteraction`;
- `SourceRequestRef`;
- `AllowedResponse`;
- immutable `AttentionEvent`;
- `CapabilityProfile`;
- `SupportProfile`;
- `AuthorityBinding`.

Also define only the supporting identifiers/enums/unions/value shapes genuinely required to express those concepts coherently.

Required semantic boundaries:

- source/vendor identifiers remain wrapped as source references and never become Far Away identity;
- `sessionKey`, interaction identity, attention-event identity, and authority generation are distinct concepts;
- `PendingInteraction` must carry enough canonical correlation to bind an exact source request and its exact allowed response set;
- terminal versus pending interaction state must be representable without permitting accidental resurrection by type design;
- `AttentionEvent` represents canonical attention facts and must not contain delivery-provider state;
- `SupportProfile` must be capable of expressing the locked taxonomy: `Interactive`, `Monitor`, `Experimental`, `Unsupported`;
- support/capability representation must not imply authority merely because a capability exists.

Prefer opaque/branded string identifiers where they prevent accidental cross-assignment without adding runtime complexity. Do not build a framework of speculative value objects.

The domain package must not import:

- `vscode`;
- Cloudflare types;
- Telegram/APNs/iOS types;
- concrete agent/vendor SDK types;
- app implementation code;
- wire DTOs from `packages/contracts`.

### 2. `packages/contracts`

Own **wire/process boundary contracts**, not canonical business state.

For M0.4, keep this intentionally minimal. Establish:

- explicit protocol-version vocabulary suitable for later version negotiation;
- generic request/response/event envelope primitives only if they can be defined without inventing M0.7 IPC methods;
- serialization-safe DTO conventions/types needed to prove that wire contracts are distinct from canonical domain objects.

It is acceptable—and preferable—to keep this package very small if no concrete wire message belongs to M0.4.

Do **not** define M0.7's `hello`, `health.get`, or `companion.status` message set here yet. M0.7 owns the actual minimal IPC protocol.

Do not add:

- Named Pipe/UDS transport code;
- socket/server/client implementations;
- local authentication/challenge flow;
- cloud relay envelopes;
- Telegram callback contracts;
- mobile/APNs contracts;
- generic `sendPrompt`, `executeCommand`, `runAgent`, or arbitrary command payloads.

The contracts package must not import application implementations.

### 3. `packages/agent-adapter-sdk`

Own provider-neutral adapter ports/contracts. It may depend on `packages/domain`; it must not depend on apps or concrete adapters.

Define the `AgentAdapter` boundary with independently optional:

- `DiscoveryPort`;
- `ObservationPort`;
- `ResolutionPort`.

Required port semantics:

**Discovery**
- non-mutating;
- reports discoverable runtimes/sessions/evidence without claiming canonical authority by itself;
- supports more than one simultaneous session/runtime.

**Observation**
- asynchronous event/observation surface;
- preserves source/session/request correlation needed for later canonicalization;
- does not expose vendor payloads as canonical domain truth.

**Resolution**
- accepts an exact `SourceRequestRef`/current authority context and one allowed bounded response;
- result distinguishes source-confirmed resolution from rejection/stale/not-authoritative/unknown outcomes;
- no blind retry semantics;
- no arbitrary prompt/command surface.

The SDK must be implementable by different integration mechanisms (native hooks/APIs/plugins/event streams/ACP where appropriate) without encoding ACP or any one vendor as the abstraction.

Do not add a concrete Codex, Claude, OpenCode, Qwen, Cline, Gemini, Cursor, or Grok adapter.

## Dependency direction

For this slice, enforce:

```text
packages/domain
    ↑
packages/agent-adapter-sdk

packages/contracts   (independent unless a concrete, justified domain type dependency is necessary)
```

Applications do not need to consume these packages yet. M0.4 establishes boundaries; later slices introduce actual consumers.

Forbidden dependencies:

```text
domain             -> contracts / adapter-sdk / apps / provider SDKs
contracts          -> apps / provider SDKs
agent-adapter-sdk  -> apps / concrete adapters / provider SDKs
```

Avoid circular workspace dependencies.

## Workspace and package rules

Update root workspace membership to include exactly the existing apps plus the three new packages:

```json
[
  "apps/vscode",
  "apps/cloud",
  "packages/domain",
  "packages/contracts",
  "packages/agent-adapter-sdk"
]
```

Do not add speculative `packages/*` or `apps/*` globs in this slice.

Use private internal package names under one consistent Far Away namespace. Do not publish packages or add publishing configuration.

Preserve the single canonical root lockfile; do not create nested lockfiles.

Keep dependency additions minimal. Prefer TypeScript-only package contracts with no new runtime dependency unless implementation proves one is necessary. Do not upgrade existing dependencies.

## Build and test contract

Each new package must have an explicit package-local typecheck/build or equivalent compile gate. Add focused tests only where runtime helpers/invariant constructors exist; do not manufacture tests for compile-time-only aliases merely to increase counts.

Root orchestration must gain named gates for the new packages and include them in aggregate validation without weakening existing gates.

Existing regression requirements remain:

- extension compile: PASS;
- extension lint: PASS;
- extension tests: **92 passing** using VS Code **1.138.0**;
- Cloud typecheck: PASS;
- Cloud tests: **73 passing across 6 files**;
- aggregate root validation: PASS;
- no silent test-count decrease.

New package gates must also pass from a clean root install.

## Boundary verification

Before completion, explicitly audit imports and exported APIs.

Verify that:

- domain source contains no VS Code/Cloudflare/Telegram/APNs/iOS/vendor-agent imports or vocabulary leakage;
- contracts contains no app implementation imports and no generic agent-control API;
- adapter SDK contains no concrete provider dependency or provider-specific public type;
- apps have not been rewritten to use the new packages in this slice;
- no source-affecting implementation exists;
- no `apps/companion` exists;
- no IPC transport, SQLite, relay, routing, escalation, policy, inbox, OAuth/P-256, mobile, or production adapter implementation has appeared.

A simple repository search/guard is sufficient for this slice; do not prematurely build the full M0.10 architecture-test system.

## Tasks

- [ ] Confirm starting HEAD is the reviewed M0.1–M0.3 checkpoint or a planning-only descendant and working tree is clean.
- [ ] Re-read `ARCHITECTURE.md`, this active slice, and the current workspace/package manifests before editing.
- [ ] Create only `packages/domain`, `packages/contracts`, and `packages/agent-adapter-sdk`.
- [ ] Give each package a private internal package manifest and package-local TypeScript configuration.
- [ ] Add the three package paths explicitly to root workspaces.
- [ ] Update the canonical root lockfile without unrelated dependency churn.
- [ ] Implement the minimal canonical domain vocabulary listed above.
- [ ] Keep provider/source identity distinct from Far Away identity in exported types.
- [ ] Model pending interaction correlation, allowed bounded responses, attention events, capabilities, support profile, and authority binding without delivery/provider leakage.
- [ ] Implement independent optional Discovery / Observation / Resolution adapter ports.
- [ ] Ensure resolution is exact/correlated/bounded and exposes no generic command API.
- [ ] Establish only minimal protocol-version/wire-boundary primitives in `packages/contracts`; do not implement M0.7 messages.
- [ ] Add package-local typecheck/build gates.
- [ ] Add focused tests only for runtime invariants/helpers actually introduced.
- [ ] Add root orchestration gates for all three packages and include them in `npm run validate`.
- [ ] Run a clean root install and verify npm recognizes all five workspaces.
- [ ] Run all new package gates.
- [ ] Run extension compile/lint/tests and retain 92 passing on VS Code 1.138.0.
- [ ] Run Cloud typecheck/tests and retain 73 passing across 6 files.
- [ ] Run root aggregate validation.
- [ ] Audit dependency direction and public exports.
- [ ] Search for forbidden provider/app imports and generic command/prompt APIs in the new packages.
- [ ] Confirm existing app production code has not been semantically migrated/refactored.
- [ ] Confirm no M0.5+ implementation exists.
- [ ] Record exact package APIs, dependency graph, commands/results, test counts, lockfile review, and deviations under Completion Evidence.

## Required regression gate

M0.4 must preserve all reviewed M0.3 behavior while adding only architecture package boundaries.

Required:

- clean root install succeeds;
- all five npm workspaces are recognized;
- all three new package compile/typecheck gates pass;
- extension compile/lint/**92 tests** pass on VS Code **1.138.0**;
- Cloud typecheck/**73 tests across 6 files** pass;
- aggregate `npm run validate` passes;
- existing app production behavior remains unchanged;
- no existing test is deleted, skipped, or weakened;
- no unexplained dependency-version churn occurs.

## Acceptance criteria

M0.4 is complete only when:

- [ ] `packages/domain` exists and exports the canonical provider-neutral vocabulary required by the locked architecture;
- [ ] `packages/contracts` exists as a deliberately small wire-contract boundary and does not pre-implement M0.7;
- [ ] `packages/agent-adapter-sdk` exists and exports optional Discovery / Observation / Resolution ports;
- [ ] adapter resolution is exact, bounded, correlation-aware, and contains no generic command/prompt API;
- [ ] package dependency direction is acyclic and architecture-compliant;
- [ ] no provider-specific types leak into canonical public APIs;
- [ ] no application becomes canonical authority through this work;
- [ ] root remains orchestration-only;
- [ ] one root lockfile remains canonical;
- [ ] clean install and all package/application regression gates pass;
- [ ] no `apps/companion`, IPC transport, SQLite, production adapter, routing/policy/inbox, relay, auth migration, or mobile implementation has begun;
- [ ] M0.5 has not started.

## Expected change shape

Expected categories:

```text
packages/domain/**             new canonical domain types + package config
packages/contracts/**          minimal wire/version primitives + package config
packages/agent-adapter-sdk/**  provider-neutral adapter ports + package config
package.json                   explicit workspace + orchestration gate additions
package-lock.json              three workspace additions, minimal dependency graph changes
WORKPLAN_TODO.md               this slice + execution evidence after implementation
```

Existing `apps/vscode/src/**`, `apps/cloud/src/**`, Cloud migrations, and existing tests should not require semantic edits.

## Do not

During M0.4:

- do not create or start Companion;
- do not create `apps/companion`;
- do not add Named Pipe/UDS/local TCP code;
- do not add SQLite;
- do not implement IPC `hello`, `health.get`, or `companion.status`;
- do not add real agent discovery/observation/resolution implementations;
- do not add ACP transport/client/server code;
- do not migrate `BackendClient`, `SecretStore`, or Telegram ownership;
- do not change Telegram behavior;
- do not change Cloud routes/D1 schema/authentication;
- do not add D1 routing, D2 escalation, D3 policy, D4 synthetic attention, or D5 inbox;
- do not add OAuth/P-256/relay authentication;
- do not add production relay WebSocket;
- do not add iOS/APNs/Live Activity/Dynamic Island code;
- do not introduce generic remote prompt/command APIs;
- do not use provider-specific payloads as domain objects;
- do not add dependencies or upgrade versions without a demonstrated M0.4 need;
- do not refactor existing apps merely to consume the new packages;
- do not create speculative `test-support`;
- do not begin M0.5.

## Stop conditions

Stop and report rather than improvising if:

- a canonical type cannot be defined without resolving an architecture ambiguity not covered by `ARCHITECTURE.md`;
- the adapter ports appear to require a provider-specific concept in their public API;
- exact resolution cannot be expressed without inventing source-authority semantics beyond the locked model;
- a useful contracts package appears to require defining M0.7 IPC methods early;
- package setup requires changing existing app runtime/module semantics;
- lockfile update introduces unexplained dependency-version churn;
- existing extension/Cloud regression counts cannot be reproduced;
- implementation would require migrating application behavior into the new packages;
- the slice starts pulling Companion, persistence, IPC transport, routing, auth, relay, or concrete adapters forward.

A desire for a cleaner future abstraction is not permission to expand M0.4.

## Completion Evidence

**Status:** NOT EXECUTED

After implementation, record:

- starting commit/branch and clean-tree confirmation;
- package names and exact exported public API;
- dependency graph;
- workspace/lockfile result and dependency-version review;
- package typecheck/build/test results;
- extension compile/lint/test result and exact count/runtime;
- Cloud typecheck/test result and exact count;
- aggregate validation result;
- forbidden-import/API audit;
- existing-app semantic-diff audit;
- M0.5+ scope audit;
- deviations/environment issues.

Do not mark M0.4 complete in `WORKPLAN.md` until this evidence has been reviewed.
