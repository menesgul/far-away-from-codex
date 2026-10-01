# ARCHITECTURE.md — Far Away

> Status: **A–E LOCKED BASELINE**
>
> This file is the implementation-facing architecture truth for Far Away. Detailed research, decision history, and diagrams live in the project research workspace. Implementation must not silently weaken these invariants.

## 1. Product boundary

Far Away is an **agent-neutral remote-attention layer for coding agents**.

Its job is to let a developer step away from long-running or parallel coding-agent work while retaining awareness and performing only narrowly bounded responses when the source runtime actually requests them.

**Principle: Respond, don't chat.**

Far Away is not:
- a remote IDE,
- a generic coding-agent client,
- an arbitrary remote prompt surface,
- a session launcher,
- a workflow-replacement layer.

V1 remote source-affecting interaction is limited to an active, correlated source request and its exact allowed response: approve/reject, an exact choice, or bounded short text when the source supports it.

## 2. Authority model

Authority is deliberately split.

| Component | Authority |
| --- | --- |
| Coding-agent runtime | Source truth and source-side request/result state |
| Local Companion | Canonical Far Away local state, live attachment authority, PendingInteraction revalidation, source resolution |
| Cloud | Authenticated routing/control plane and bounded sanitized projections; never coding-agent authority |
| VS Code extension | UI, setup, bootstrap, diagnostics; never runtime authority |
| Telegram / iOS | Bounded remote presentation and response surfaces; never source authority |

Network/provider acknowledgement is never equivalent to source resolution.

## 3. Canonical domain

The provider-neutral domain includes:
- `AgentDescriptor`
- `RuntimeTopology`
- `AgentSession` with a Far Away-owned `sessionKey`
- `SourceSessionRef`
- `PendingInteraction`
- `SourceRequestRef`
- `AllowedResponse`
- immutable `AttentionEvent`
- `CapabilityProfile`
- `SupportProfile`
- `AuthorityBinding`

Core invariants:
- vendor payloads are never canonical domain truth;
- Far Away `sessionKey` is not a vendor/source session ID;
- lifecycle, attachment, and authority are separate;
- persisted state does not imply live authority;
- source resolution requires exact correlation and current authority;
- an old authority generation cannot resolve until revalidated;
- terminal interactions do not become pending again;
- delivery state does not change source truth;
- notifications are projections of canonical attention state;
- support is scoped to agent + topology + version/evidence.

## 4. Agent integration

Each integration family implements an `AgentAdapter` with independent optional ports:
- `DiscoveryPort`
- `ObservationPort`
- `ResolutionPort`

Discovery is non-mutating. Observation is asynchronous. Resolution accepts only an exact current source reference and an allowed bounded response; there is no generic command API.

Support taxonomy:
- **Interactive**
- **Monitor**
- **Experimental**
- **Unsupported**

First-class support requires normal workflow preservation, existing-session attachment, parallel-session identity, restart rediscovery, and relevant documented events. Interactive additionally requires safe correlated bounded response.

Mechanism selection is per agent/topology/version. Tie-break order:
1. same live authority,
2. workflow preservation,
3. documented/stable interface,
4. request correlation,
5. reconnect behavior,
6. security clarity,
7. implementation simplicity.

ACP is a useful stable protocol where it preserves these requirements, but ACP does not by itself prove live existing-session attachment or multi-client authority and is not Far Away's moat.

## 5. Local Companion

The Local Companion is a standalone TypeScript/Node per-user process and the **single local Far Away authority** for an installation/user.

It owns:
- adapter lifecycle,
- discovery/observation/resolution coordination,
- canonical local state,
- persistence,
- attention processing,
- durable outbox,
- cloud relay client,
- local IPC,
- diagnostics,
- restart/recovery.

It does **not** own coding-agent source sessions.

Runtime rules:
- one authoritative Companion process per OS user/installation;
- SQLite uses a single writer and WAL;
- canonical aggregate updates, immutable attention events, and durable outbox writes that belong together are transactional;
- persisted authority bindings are non-authoritative after restart until rediscovered/revalidated;
- Companion uses outbound cloud connectivity only;
- secrets/private keys live in the OS secure store;
- Companion may remain alive while the user is logged in even when VS Code is closed.

## 6. Local IPC and VS Code

VS Code is an optional local client of Companion.

Local IPC:
- Windows: Named Pipe;
- Unix-like systems: Unix Domain Socket;
- no local TCP;
- versioned length-delimited JSON protocol;
- OS-user access control plus authenticated session/challenge design;
- multiple local clients may connect to the same Companion.

The VS Code extension:
- uses contribution-driven/lightweight activation;
- performs no agent discovery during activation;
- may install/update/start Companion;
- does not make Companion live inside the extension version directory;
- communicates through versioned IPC and fails closed on incompatibility;
- may expose status, native views, walkthrough/setup, diagnostics, and canonical Companion operations;
- may be disabled/uninstalled without deleting canonical Companion data or making the extension the runtime authority.

## 7. Identity and security

Distinct identities include:
- `AccountIdentity`
- `InstallationIdentity`
- `InstallationKey`
- `CompanionInstance`
- `LocalClientIdentity`
- `RelaySession`
- mobile identities/bindings when iOS is introduced.

Installation ID is a random locator, not an authenticator. No hardware fingerprinting.

V1 trust key: **P-256 / ES256**.

Account authorization uses browser OAuth Authorization Code + PKCE. Relay authentication uses short-lived credentials, installation-bound refresh semantics, and proof-of-possession where supported.

Local clients never receive relay credentials.

A revoked cloud installation loses relay authorization while local monitoring can continue. A clean reinstall creates a new identity; normal updates preserve it.

## 8. Attention architecture

Canonical classes:
- **NEEDS YOU**
- **OUTCOME**
- **MEANINGFUL PROGRESS**

### D1 — Routing

Routing is separate from classification. Inputs include canonical `AttentionEvent`, context, effective policy, capability, presence, and available surfaces.

Tiers: `PASSIVE`, `ACTIVE`, `ATTENTION`, `URGENT`.
Destinations: local inbox, local desktop, Telegram, future mobile.
Modes: immediate, coalesce, inbox-only, suppress-remote.

Safety dominates source capability, policy, presence, and defaults.

### D2 — Escalation

Escalation is durable follow-up, not a second router. It tracks unresolved eligible attention subjects and revalidates canonical state/policy/risk/channel before every step. Acknowledging attention is not source resolution.

### D3 — Policies

Policies are typed/declarative with immutable built-in safety plus user/project/session scopes. Repository files cannot silently activate policy. Equal-priority conflicting scalar rules are invalid. Effective policy is revisioned and explainable.

### D4 — Synthetic attention

Derived attention fills explicit semantic evidence gaps only. It carries detector/version/evidence/confidence provenance and never manufactures source authority. Silence alone is not proof of a stall. Derived NEEDS_YOU cannot become remotely actionable without a real `PendingInteraction`.

### D5 — Cross-agent inbox

The inbox is a human attention projection, not a session manager, event log, or source authority. READ, ACK/SNOOZE, triage state, and canonical subject state remain separate. There are no bulk source actions.

## 9. Cloud relay

Cloud is an authenticated routing/control plane.

Target path:

`Remote surface → Public Edge Worker → Installation Relay Durable Object ↔ outbound authenticated Companion WebSocket → Companion → adapter/source`

One relay authority is scoped per installation/incarnation. Relational cloud storage is control-plane storage, not source truth or the hot live-authority path.

Companion WebSocket uses a versioned JSON envelope and explicit messages such as:
- `hello`
- `hello.ack`
- `protocol.error`
- `action.intent`
- `action.received`
- `action.result`

Cloud never sends vendor source IDs, `SourceRequestRef`, adapter handles, or raw source payloads to remote surfaces.

## 10. Remote actions and idempotency

A remote action is transaction authorization, not generic remote control.

An action binds the account/channel/device context, installation, action ID, interaction ID, projection version, exact allowed response, issue/expiry time, and risk context.

There is no exactly-once network promise. Stable `actionId` represents one user intent. Source effect is not blindly retried after unknown commit state.

Companion always revalidates:
- PendingInteraction is still pending,
- source request reference is current,
- authority generation is current,
- response is allowed,
- session/source is current,
- expiry and safety constraints still hold.

First canonical source resolution wins across competing devices/surfaces.

## 11. Telegram

Telegram is a sanitized attention/response surface, not an agent client.

It supports:
- notifications,
- bounded sanitized projection,
- exact callback-based bounded responses when representable,
- strict correlated bounded text where explicitly supported.

Callback data is opaque; canonical action fields remain server-side. Private paired chat/user validation is required.

High-risk or unclassifiable source approval is notification/review only and requires local-desktop confirmation. No generic Telegram PIN and no generic bot command for arbitrary agent control.

## 12. Native iOS

The iOS app is a paired remote attention client. It never connects directly to coding agents or adapters.

It uses distinct mobile device identity and explicit installation bindings. APNs tokens and Live Activity tokens are mutable delivery addresses, not identities or authenticators.

Mobile state is a bounded sanitized projection/cache. Any source-affecting action is revalidated by Companion.

## 13. APNs

APNs is a best-effort delivery adapter.

Provider acceptance means accepted by APNs, not delivered to the user and not source-resolved. V1 does not depend on silent/background refresh pushes. Visible attention pushes plus foreground snapshot/delta are the baseline.

## 14. Live Activity

A Live Activity represents a bounded **ongoing work projection**, not an `AgentSession`.

`LiveAttentionProjection` is rebuildable from canonical state and may move through Working → Needs You → Completed. Dismissal is presentation-only. `staleDate` is presentation freshness only.

## 15. Dynamic Island

Dynamic Island is an E3 presentation adapter, not domain/routing authority.

V1 remains **display/deep-link-only**, including after actionable notification security is implemented. It has no source-affecting action buttons.

## 16. Native actionable security

iOS source-affecting actions use exact transaction authorization.

Assurance:
- A0 — display only
- A1 — unlocked device
- A2 — fresh device-owner authentication
- A3 — local desktop confirmation

LOW approval from a system surface requires fresh A2. MEDIUM remote approval requires representability, policy, A2, device signature, and App Attest where supported; otherwise it falls back to stronger review/A3. HIGH and UNCLASSIFIED always require A3.

Exact action authorization binds a fresh challenge, exact response, canonical display digest, device/incarnation, installation, interaction, projection version, and expiry. App Attest supplements device-key proof; it does not prove human presence or source authority.

## 17. Offline and reconnect

Restart/offline never silently restores authority.

On Companion restart:
1. persisted bindings are treated as non-authoritative;
2. runtimes/sessions are rediscovered;
3. authority generation is renewed;
4. pending interactions are revalidated;
5. stale interactions are rejected.

Cloud may retain only bounded sanitized action intent until expiry. Reconnection never extends source validity.

## 18. Trust boundaries

- **TB0 Source runtime:** owns coding-agent truth.
- **TB1 Local OS user:** Companion, secure store, SQLite, local IPC, local clients.
- **TB2 Far Away cloud:** authenticated routing/control plane and bounded projections.
- **TB3 Provider networks:** Telegram/APNs delivery surfaces.
- **TB4 Mobile device:** iOS app/system UI/device credentials.

Source authorization terminates only after Companion canonical revalidation against the source runtime.

## 19. Repository direction

Implementation is migrating toward:

```text
apps/
  companion/        standalone local authority
  vscode/           optional UI/setup/bootstrap client
  cloud/            routing/control plane

packages/
  domain/           canonical provider-neutral domain
  contracts/        process/network wire contracts
  agent-adapter-sdk/
  test-support/
```

The current extension-owned/cloud-pairing implementation is migration input, not architecture truth. Legacy behavior may temporarily coexist during a strangler migration, but new canonical authority must not be added to the extension.

## 20. Non-negotiable invariants

1. Source runtime owns source truth.
2. Companion owns canonical local live attachment and source-resolution revalidation.
3. Cloud is routing/control, not coding-agent authority.
4. VS Code is optional UI/setup/bootstrap.
5. Telegram and iOS are bounded remote surfaces.
6. No workflow migration is required for supported normal usage.
7. No generic remote prompt/command surface.
8. Every source-affecting response is exact, current, allowed, unexpired, and revalidated.
9. Provider/network acknowledgement is not source resolution.
10. Persisted state is not live authority after restart.
11. Old authority generations cannot resolve without revalidation.
12. Unknown commit state is never blindly retried.
13. D1 routing, D2 escalation, D3 policy, D4 derivation, and D5 inbox remain separate responsibilities.
14. Dynamic Island V1 is display/deep-link-only.
15. HIGH/UNCLASSIFIED mobile approval requires local-desktop confirmation.
