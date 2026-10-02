# WORKPLAN.md — Far Away

> Status: **ACTIVE MIGRATION PLAN**
>
> Architecture source: `ARCHITECTURE.md` (A–E locked baseline).
>
> This file stores durable milestone contracts and milestone-level progress. Fine-grained instructions for the one active implementation slice belong in `WORKPLAN_TODO.md`.

## Planning rules

1. Do not implement a future milestone merely because it is visible here.
2. Only the active slice in `WORKPLAN_TODO.md` is executable scope.
3. Before opening the next slice, review the result of the previous slice against `ARCHITECTURE.md`, the relevant locked decisions/diagrams, and the current repository state.
4. A completed slice is marked here only after its acceptance gate is verified.
5. Research rationale stays outside this file; this is an implementation contract.
6. Existing working behavior is preserved during migration unless a slice explicitly replaces it.
7. Architecture conflicts are surfaced as gaps; implementation must not silently redefine architecture.

# M0 — Repository & Runtime Foundation

## Objective

Migrate Far Away from a VS Code-extension-owned repository/runtime into a Companion-centered architecture **without regressing the existing Telegram pairing foundation**.

M0 creates the structural/runtime foundation required by later milestones. It does not implement the product's real agent-attention pipeline yet.

## Architecture drivers

M0 is constrained primarily by:
- B1 — provider-neutral canonical domain;
- B2 — Discovery / Observation / Resolution adapter boundaries;
- B3 — standalone Local Companion is the single local Far Away authority;
- B4 — VS Code is UI/setup/bootstrap only;
- B5 — installation identity/credentials belong to Companion, not the extension;
- Local Component Diagram;
- Deployment Topology Diagram;
- Trust Boundaries Diagram.

Phase A additionally forbids turning the new IPC/runtime foundation into a generic remote agent controller.

## Migration baseline

M0 begins from Git commit:

`e5e6fab28983cba22cc2f5506eaf6e0f9270b54d`

At this baseline:
- repository root is the VS Code extension package;
- `src/` contains extension-owned Telegram/cloud/state code;
- `worker/` is a separate Cloudflare Worker npm project;
- Telegram pairing/connect/disconnect foundations and tests exist;
- there is no standalone Companion;
- there is no canonical domain/contracts/adapter SDK package boundary;
- there is no local Companion IPC.

## In scope

- npm-workspace repository foundation;
- `apps/vscode`;
- `apps/cloud`;
- `apps/companion`;
- `packages/domain`;
- `packages/contracts`;
- `packages/agent-adapter-sdk`;
- shared test support only where genuinely cross-package;
- standalone Companion lifecycle;
- Companion path/data bootstrap;
- SQLite WAL bootstrap and migration mechanism;
- one Companion instance per local user/installation scope;
- Named Pipe / Unix Domain Socket IPC abstraction;
- versioned minimal IPC protocol;
- multi-client local IPC;
- VS Code `CompanionClient`;
- lightweight/contribution-driven extension activation;
- explicit isolation of temporary legacy extension-owned cloud/state code;
- root build/lint/typecheck/test orchestration;
- architecture-boundary tests;
- preservation of existing Telegram pairing behavior during the migration.

## Out of scope

M0 must not implement:
- production OpenCode/Claude/Codex/Qwen/Cline adapters;
- real agent discovery/observation/resolution;
- ACP integration;
- the full PendingInteraction lifecycle;
- D1 routing;
- D2 escalation;
- D3 policy engine;
- D4 derived attention;
- D5 production inbox;
- production Companion ↔ cloud relay WebSocket;
- Installation Relay Durable Object;
- final OAuth/account migration;
- production P-256 enrollment/relay authentication;
- actionable Telegram approvals;
- iOS;
- APNs;
- Live Activity;
- Dynamic Island;
- E5 mobile action authorization.

## Target repository shape

```text
far-away/
├── apps/
│   ├── companion/
│   ├── vscode/
│   └── cloud/
├── packages/
│   ├── domain/
│   ├── contracts/
│   ├── agent-adapter-sdk/
│   └── test-support/       # only as cross-package need emerges
├── docs/
├── ARCHITECTURE.md
├── WORKPLAN.md
├── WORKPLAN_TODO.md
├── package.json
├── package-lock.json
├── tsconfig.base.json
└── eslint.config.mjs
```

`packages/domain` contains canonical Far Away vocabulary, not wire DTOs or provider payloads.

`packages/contracts` contains process/network boundary contracts such as IPC protocol DTOs/version negotiation. It must not become a generic shared-code junk drawer.

`packages/agent-adapter-sdk` owns provider-neutral adapter ports/contracts, not concrete vendor integrations.

## Deliverables

- [ ] D1 — npm-workspace monorepo root.
- [ ] D2 — VS Code application isolated under `apps/vscode`.
- [ ] D3 — Cloud application isolated under `apps/cloud`.
- [ ] D4 — Standalone Companion application.
- [ ] D5 — Canonical domain package.
- [ ] D6 — Wire-contract package.
- [ ] D7 — Agent adapter SDK package.
- [ ] D8 — Cross-package test support where justified.
- [ ] D9 — Runnable standalone Companion executable.
- [ ] D10 — Named Pipe / Unix Domain Socket transport abstraction; no local TCP.
- [ ] D11 — Protocol v1 minimal `hello`, `health.get`, and `companion.status` flow.
- [ ] D12 — SQLite bootstrap with WAL and migration runner.
- [ ] D13 — Single-instance Companion ownership.
- [ ] D14 — Multiple local IPC clients can share one Companion.
- [ ] D15 — VS Code `CompanionClient`.
- [ ] D16 — Lightweight extension activation with no agent discovery.
- [ ] D17 — Temporary legacy extension-owned cloud/state responsibilities are visibly isolated.
- [ ] D18 — Root build/lint/typecheck/test orchestration.
- [ ] D19 — Architecture-boundary tests/guards.
- [ ] D20 — Existing Telegram pairing/connect/disconnect regression behavior remains green.

## Execution sequence

Only one step is expanded in `WORKPLAN_TODO.md` at a time.

- [x] **M0.1 — Freeze Baseline & Regression Contract**
- [x] **M0.2 — Introduce npm Workspace Root**
- [x] **M0.3 — Move Existing Apps Without Behavior Change**
- [x] **M0.4 — Introduce Domain / Contracts / Adapter SDK Boundaries**
- [x] **M0.5 — Create Standalone Companion Runtime**
- [x] **M0.6 — Add Companion Paths, SQLite Bootstrap & Single-Instance Ownership**
- [ ] **M0.7 — Implement Minimal Local IPC Protocol**
- [ ] **M0.8 — Add VS Code CompanionClient**
- [ ] **M0.9 — Make VS Code Activation Lightweight and Companion-Aware**
- [ ] **M0.10 — Add Multi-Client, Restart & Architecture-Boundary Tests**
- [ ] **M0.11 — Remove Obsolete Root Scaffolding / Normalize Tooling**
- [ ] **M0.12 — Full Regression & Architecture Audit**

The sequence is intentionally gated. In particular, M0.3 must preserve behavior before new runtime work proceeds, so failures can be attributed to either structural migration or new Companion code rather than both at once.

## Required migration behavior

During M0, a temporary dual shape is acceptable:

```text
Existing vertical slice:
VS Code → legacy cloud client → Cloud Worker → Telegram pairing

New foundation:
VS Code → local IPC → Companion
```

The old path is migration input, not the target authority model. New canonical runtime authority must be implemented only in Companion.

## Dependency rules

Target dependency direction must preserve:
- canonical domain independence from VS Code, Cloudflare, Telegram, APNs, and vendor-agent types;
- contracts independence from app implementations;
- VS Code communicates with Companion through contracts/IPC, never source imports;
- cloud does not import Companion implementation;
- adapter SDK does not depend on concrete adapters or Companion implementation.

No generic `sendPrompt`, `executeCommand`, or equivalent agent-control endpoint may be introduced into local IPC.

## M0 acceptance gate

M0 is complete only when all are true:

- fresh checkout installs through the root workspace;
- root build/lint/typecheck/test gates pass;
- standalone Companion can start independently of VS Code and reach READY;
- Companion can be stopped cleanly and restarted;
- SQLite bootstrap/migrations survive restart and use WAL;
- a second Companion cannot become a competing local authority;
- VS Code window A can connect to Companion;
- VS Code window B can connect to the same Companion;
- disconnecting one local client does not terminate the other or Companion;
- IPC is Named Pipe/UDS rather than local TCP;
- protocol incompatibility fails closed;
- extension activation performs no agent discovery;
- no new canonical cloud/agent authority exists in the extension;
- existing Telegram pairing/connect/disconnect regression tests remain green.

## Negative acceptance criteria

M0 fails if:
- Companion is merely an extension-owned in-process service;
- Companion lifetime is permanently tied to the VS Code extension host;
- local IPC opens a TCP port;
- domain code imports VS Code/Cloudflare/provider/vendor-agent types;
- a generic remote prompt/command IPC endpoint appears;
- multiple VS Code windows create competing Companions;
- SQLite is designed for multiple canonical writers;
- working Telegram pairing behavior is lost without an explicit replacement slice;
- M0 starts implementing production agent discovery or remote source resolution;
- the existing anonymous bearer model is deepened and presented as the final B5 identity architecture.

## Observable demo

At the M0 gate:

```text
Terminal:
  Far Away Companion → READY

VS Code Window A:
  Companion → Connected

VS Code Window B:
  Companion → Connected

Both clients:
  same Companion process / same local authority

Existing Telegram pairing regression suite:
  GREEN
```

## Definition of Done

Far Away is structurally and operationally a Companion-centered system: the Local Companion can exist independently, multiple VS Code clients use it as the local runtime authority, and the existing Telegram pairing foundation has survived the migration.

This does **not** mean the real coding-agent attention pipeline is implemented. That begins only in later milestones after M0 is reviewed and locked.
