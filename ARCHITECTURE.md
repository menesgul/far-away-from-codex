# ARCHITECTURE.md — Far Away From Codex

> Architecture for the V1 VS Code extension and minimal hosted relay that forward important Codex events to Telegram while **Away Mode** is enabled.

# 1. Architectural Goals

The system should be:

1. **Simple**
   - one-click ON/OFF after first-time setup.

2. **Local-first with a minimal hosted relay**
   - Codex event collection, normalization, session labeling, Away Mode, redaction, and notification formatting stay local,
   - a privacy-limited backend exists only for Telegram pairing, anonymous installation mapping, and delivery,
   - no user accounts and no remote control.

3. **Non-invasive**
   - monitoring must never block or control Codex,
   - failures in this extension must not break a Codex turn.

4. **Secure by default**
   - the extension stores only its anonymous installation credential in VS Code `SecretStorage`,
   - the official Telegram bot token and webhook secret exist only as Cloudflare Worker secrets,
   - loopback-only local communication,
   - no secrets in hook configuration or repository.

5. **Truthful**
   - distinguish a terminal turn failure from a recoverable tool failure,
   - never invent a failure reason,
   - never claim a session name unless obtained from supported metadata.

---

# 2. High-Level Architecture

```text
Codex IDE
    ↓ Codex lifecycle hook
Local Bridge
    ↓ loopback HTTP + runtime nonce
VS Code Extension
    ↓ authenticated HTTPS
Far Away From Codex Backend
Cloudflare Worker
    ├── D1
    └── Telegram Bot API
             ↓
      Official Far Away From Codex Bot
             ↓
          User phone
```

The local Codex hook-to-extension bridge remains required. The hosted backend does not replace it; the backend begins only after the extension has validated, normalized, redacted, and formatted an event.

## 2.1 Telegram pairing path

```text
VS Code Extension
    ↓ POST authenticated pairing request
Cloudflare Worker creates one-time pairing token
    ↓
Extension opens https://t.me/<official-bot>?start=<one-time-token>
    ↓
User presses Start
    ↓
Telegram webhook → Cloudflare Worker
    ↓ validate webhook secret, exact token, private chat
Associate anonymous installation with Telegram chat_id
    ↓
D1
    ↓
Extension observes paired status
    ↓
Connected
```

---

# 3. Why Use a Local Bridge?

Codex lifecycle hooks execute independently of our VS Code extension and receive structured JSON through stdin.

The bridge exists so that:

- Codex can emit events without knowing backend or Telegram credentials,
- the anonymous installation credential stays inside VS Code SecretStorage and never enters bridge files,
- the status-bar Away Mode remains the single source of truth,
- the Codex hook remains lightweight.

The bridge is transport only.

It must **not**:
- decide whether something is Finished/Failed,
- format Telegram messages,
- store backend or Telegram credentials,
- approve/deny Codex requests,
- block a Codex action.

---

# 4. Component Responsibilities

## 4.1 `extension.ts`
Responsibilities:
- activation/deactivation,
- create services,
- register commands,
- create status bar,
- start local receiver,
- install/update bridge assets,
- orchestrate anonymous installation registration and Telegram connection UX.

Must not contain event-specific parsing logic.

---

## 4.2 `AwayModeService`

State:

```ts
type AwayMode = "on" | "off";
```

API:

```ts
enable(): Promise<void>
disable(): Promise<void>
toggle(): Promise<void>
isEnabled(): boolean
```

Rules:
- when OFF, no Telegram alert is sent,
- when ON, supported normalized events can be sent,
- initial install defaults to OFF.

The status bar renders this service's state.

---

## 4.3 `SecretStore`

Backed by:

```text
vscode.SecretStorage
```

Keys conceptually:

```text
farAway.installationCredential
```

This high-entropy credential is returned once by the backend and stored only in VS Code SecretStorage. The backend stores only its cryptographic hash.

SecretStorage must **not** contain:
- the official Telegram bot token,
- the Telegram webhook secret,
- the Telegram chat ID.

The Telegram bot token and webhook secret belong in Cloudflare Worker secret storage. The Telegram chat ID belongs server-side in D1.

---

## 4.4 `HookInstaller`

Responsibilities:
- install stable bridge script,
- add/update required Codex hook definitions,
- avoid destructive edits to the user's existing hook configuration,
- preserve unrelated user hooks,
- explain any required Codex hook trust/review step.

Preferred bridge location:

```text
~/.codex/far-away-from-codex/bridge.cjs
```

The hook definition points to this stable path.

This avoids coupling hooks to a versioned VS Code Marketplace extension directory.

### Required hooks for MVP

Primary:
- `Stop`
- `PermissionRequest`

Conditional:
- `PostToolUse`

`PostToolUse` is used only where required for supported tool/MCP failure detection.

---

## 4.5 `LocalEventReceiver`

Bind:

```text
127.0.0.1:<ephemeral-port>
```

Never:

```text
0.0.0.0
```

On activation:
1. choose free loopback port,
2. generate cryptographically random nonce,
3. write runtime descriptor.

Suggested descriptor:

```json
{
  "port": 43127,
  "nonce": "runtime-random-value",
  "pid": 12345
}
```

Suggested file:

```text
~/.codex/far-away-from-codex/runtime.json
```

The runtime descriptor contains **no installation credential or Telegram credential**.

Endpoint concept:

```text
POST /events
Authorization: Bearer <runtime-nonce>
Content-Type: application/json
```

Receiver validates:
- loopback source,
- nonce,
- body size,
- recognized event shape.

---

## 4.6 `BackendClient`

The extension-side client talks only to the Far Away From Codex backend over HTTPS.

Responsibilities:
- lazily register an anonymous installation on the first backend-dependent action,
- create a one-time Telegram pairing,
- check pairing status,
- disconnect Telegram,
- send an already-redacted, already-formatted notification,
- use bounded timeouts and translate backend errors safely.

It must never:
- call the Telegram Bot API directly,
- log the installation credential,
- log notification bodies,
- put credentials in query strings,
- retry forever.

Installation registration is lazy. Extension activation alone creates no backend or D1 record. `Far Away From Codex: Connect Telegram` first checks SecretStorage, reuses an existing installation credential when present, and calls `POST /v1/installations` only when it is missing.

`POST /v1/notifications` is attempted exactly once in V1 and is never automatically retried by the extension. A lost response after successful Worker delivery creates an uncertain outcome; retrying could duplicate the Telegram message. The extension reports delivery as uncertain/failed locally and does not affect Codex. Read-only/idempotent operations such as pairing-status checks may use bounded retries. Future notification retries require an explicit idempotency key or client-generated delivery ID plus short-lived server-side deduplication state; V1 does not implement that mechanism.

`Far Away From Codex: Test Notification` is a connection diagnostic, not a Codex event notification. It sends exactly one test message through `BackendClient` whether Away Mode is ON or OFF, and fails clearly when Telegram is not connected or backend delivery fails. Away Mode gates only real Codex event notifications.

## 4.7 Cloudflare Worker

The Worker is an intentionally small pairing and relay service.

Responsibilities:
- create anonymous installation records and authenticate extension requests,
- create/check one-time pairings,
- validate and handle the Telegram webhook,
- perform bounded D1 operations,
- relay sanitized notification text through the official bot,
- translate Telegram API failures,
- disconnect Telegram and revoke installation access where appropriate,
- enforce request/body limits, rate limits, and abuse protection.

The project owner creates the official Far Away From Codex bot once with BotFather. End users never create a bot and never provide a phone number, Telegram username, bot token, or chat ID. Worker secrets are:

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_WEBHOOK_SECRET
```

The bot token and webhook secret exist only in Cloudflare Worker secret storage. They are not stored in D1, shipped in the extension, written to logs, or committed. D1 binding/configuration identifiers are not secrets.

The Worker must not:
- store notification bodies or raw Codex events,
- control Codex or execute user commands,
- create user accounts,
- retain notification history or unnecessary personal data,
- expose the official bot token.

## 4.8 D1 data model

Conceptual schema:

```text
installations
-------------
id                         primary key
credential_hash            unique
telegram_chat_id           nullable
created_at
revoked_at                 nullable

pairings
--------
id                         primary key
installation_id            foreign key → installations.id
token_hash                 unique
expires_at
used_at                    nullable
created_at
```

Useful indexes include `credential_hash`, `token_hash`, and active pairings by `installation_id`/`expires_at`. Installation credentials and pairing tokens are stored only as cryptographic hashes. Pairing tokens are short-lived and single-use; consumed or expired tokens cannot bind another chat.

D1 contains no notification-body/history table, Codex-event table, or user-profile table. It may store the Telegram chat ID because delivery requires the server-side association.

### Data lifecycle

- expired pairings are invalid immediately after `expires_at`, whether or not the row has been deleted,
- consumed pairings cannot be reused,
- stale expired or used pairing rows may be deleted lazily during normal requests,
- scheduled cleanup may be added if operationally needed, but V1 requires no complex background cleanup infrastructure,
- disconnecting Telegram leaves the installation and its credential valid,
- revoked installations fail authentication,
- abandoned or revoked installations may be purged after a reasonable deployment-defined retention period; retention is not a user-facing setting.

## 4.9 Anonymous installation and pairing protocol

There are no user accounts. An extension that is merely installed or activated creates no backend record. On the first backend-dependent action—normally `Far Away From Codex: Connect Telegram`—the extension checks SecretStorage and registers only if no installation credential exists. Identity is that installation, not an email, password, phone number, GitHub login, Telegram username, or other user profile.

```text
POST /v1/installations
  Create anonymous installation.
  Return a high-entropy installation credential once.
  Store only its hash server-side.

POST /v1/pairings
  Require installation bearer authentication.
  Create a short-lived, one-time pairing.
  Return pairingId, telegramUrl, and expiresAt.

GET /v1/pairings/:id
  Require installation bearer authentication.
  Require the pairing to belong to the authenticated installation.
  Return pending, connected, or expired.

POST /v1/telegram/webhook
  Accept Telegram requests only after validating the webhook secret.
  Require an exact /start <pairing-token> from a private chat.
  Atomically consume the token and bind chat_id to the installation.

POST /v1/notifications
  Require installation bearer authentication.
  Accept only final sanitized, formatted text within a bounded body size.
  Look up the paired chat_id, attempt one forward through the official bot, and discard the body.
  Do not rely on extension retries; V1 has no notification idempotency mechanism.

DELETE /v1/telegram-connection
  Require installation bearer authentication.
  Clear the chat association and invalidate applicable pending pairings.

DELETE /v1/installation
  Require the current installation bearer credential.
  Revoke the credential, invalidate pending pairings, and clear the chat association.
  Make the credential unusable for all subsequent requests.
```

Pairing tokens use cryptographically secure randomness, are stored only as hashes, expire quickly, require exact matching, and are consumed once. The `/start` token necessarily appears transiently in Telegram during deep-link pairing; it is not a long-lived credential. Pairing never trusts a Telegram username and accepts private chats only.

`Far Away From Codex: Disconnect Telegram` clears the server-side chat association and relevant pending pairings while keeping the installation identity and credential valid. `DELETE /v1/installation` resets/revokes the anonymous installation itself, invalidates its credential and pending pairings, and clears its Telegram association. Installation reset is a recovery path, not an everyday action. Neither operation affects the official bot token, and neither is user-account deletion because no user account exists.

## 4.10 Trust boundaries

Credentials are separate and never reused across boundaries:

1. **Local hook → extension**
   - loopback-only receiver,
   - per-activation runtime nonce.

2. **Extension → backend**
   - `Authorization: Bearer <installation-credential>`,
   - high entropy, securely generated, HTTPS-only, stored in VS Code SecretStorage,
   - only its hash is stored in D1; never log it or place it in a query string,
   - revocable and never copied into hook/bridge files.

3. **Telegram → backend**
   - Telegram webhook secret validated by the Worker.

4. **Backend → Telegram Bot API**
   - official Telegram bot token held only as a Worker secret.

All hosted API traffic uses TLS/HTTPS. Requests, bodies, timeouts, and eligible idempotent retries are bounded, with no infinite retry path. Notification submission is not automatically retried in V1.

## 4.11 Official bot and webhook bootstrap

The project owner performs this deployment bootstrap once per environment:

1. create the official Far Away From Codex bot with BotFather,
2. configure `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` as Worker secrets,
3. configure `TELEGRAM_BOT_USERNAME` as non-secret Worker configuration,
4. deploy the Worker,
5. call Telegram `setWebhook` for the deployed `/v1/telegram/webhook` endpoint, passing `TELEGRAM_WEBHOOK_SECRET` as Telegram's `secret_token`,
6. verify webhook configuration before user pairing tests.

The Worker builds `https://t.me/<official-bot>?start=<pairing-token>` from `TELEGRAM_BOT_USERNAME`. It does not call `getMe` on every pairing to rediscover the username. Documentation and repository files contain no real secret values.

## 4.12 V1 rate-limit and abuse policy

- `POST /v1/installations` is unauthenticated, so it requires IP-level rate limiting/abuse controls, a bounded request body, and protection against unlimited D1 record creation.
- `POST /v1/pairings` is installation-authenticated, rate-limited per installation, and prevents unlimited concurrent active pairings.
- `GET /v1/pairings/:id` is installation-authenticated, scoped to its installation, and limited to a reasonable polling frequency; clients must not poll aggressively.
- `POST /v1/notifications` is installation-authenticated, rate-limited per installation, and enforces a bounded message length/body.
- `POST /v1/telegram/webhook` validates the webhook secret before processing, enforces a bounded body, and safely rejects malformed or unsupported updates.

V1 adds no CAPTCHA, Turnstile, login, or account system. Those controls require evidence of abuse before consideration; pairing remains low-friction.

---

# 5. Codex Event Sources

# 5.1 Finished

Preferred source:

```text
Stop hook
```

Useful fields from the official hook contract:

```text
session_id
turn_id
cwd
last_assistant_message
```

Normalized form:

```ts
interface FinishedEvent {
  type: "finished";
  sessionId: string;
  turnId?: string;
  cwd?: string;
  lastAssistantMessage?: string;
  source: "codex-stop-hook";
}
```

### Important caveat
The implementation must verify current Codex IDE behavior during the feasibility phase.

A known protocol/client difference must not be hidden behind an assumption.

---

# 5.2 Approval Required

Preferred source:

```text
PermissionRequest hook
```

Useful fields:

```text
session_id
turn_id
cwd
tool_name
tool_input
tool_input.command
tool_input.description
```

The description is best-effort and is not guaranteed for every tool.

Normalized form:

```ts
interface ApprovalRequiredEvent {
  type: "approval_required";
  sessionId: string;
  turnId?: string;
  cwd?: string;
  action?: string;
  commandOrTarget?: string;
  reason?: string;
  source: "codex-permission-hook";
}
```

### Extraction examples

#### Bash
```text
action = Bash
commandOrTarget = tool_input.command
reason = tool_input.description ?? fallback
```

#### MCP
```text
action = tool_name
commandOrTarget = selected safe summary of tool_input
reason = tool_input.description ?? fallback
```

The extension **does not approve or deny** anything.

---

# 5.3 Terminal Failure

A real terminal failure is different from a failed command inside an otherwise recoverable turn.

Preferred authoritative shape:

```text
turn/completed
turn.status = failed
turn.error.message
turn.error.codexErrorInfo
turn.error.additionalDetails
```

This comes from the Codex App Server protocol.

### Architectural constraint
The extension must not create a second Codex session merely to monitor the first.

Before enabling this adapter, the feasibility spike must prove that it can observe the active IDE session using a supported mechanism.

Normalized form:

```ts
interface FailedEvent {
  type: "failed";
  scope: "turn";
  sessionId: string;
  turnId?: string;
  cwd?: string;
  reason?: string;
  code?: string;
  detail?: string;
  source: string;
}
```

If a terminal event does not provide detail:

```text
Reason: No detailed error was provided. Open VS Code to inspect.
```

Do not guess.

---

# 5.4 Tool Failure Fallback

`PostToolUse` can observe supported tool output and exposes:

```text
tool_name
tool_input
tool_response
```

For Bash, it also runs after non-zero command exits.

This is useful for:
- command failures,
- MCP tool errors.

But it is **not automatically a terminal turn failure**.

Therefore:

```ts
interface ToolFailedEvent {
  type: "tool_failed";
  scope: "tool";
  ...
}
```

Never render this as:

```text
❌ Codex failed
```

unless a separate authoritative terminal event confirms that the turn failed.

Possible rendering:

```text
⚠️ Codex tool failed
```

The V1 release decision can choose whether to expose tool failures or only use them for MCP-specific alerts.

---

# 5.5 MCP Failure

Two supported sources may be used.

## Source A — App Server startup status

The protocol provides:

```text
mcpServer/startupStatus/updated
```

with:

```text
threadId
name
status
error
failureReason
```

This is the best source for MCP startup/authentication failure if accessible from the active IDE session.

Normalized:

```ts
interface McpFailedEvent {
  type: "mcp_failed";
  sessionId: string;
  serverName?: string;
  reason?: string;
  detail?: string;
  source: string;
}
```

## Source B — PostToolUse
If an MCP call itself returns an identifiable error:
- inspect `tool_response`,
- extract a concise error,
- emit `mcp_failed` if confidence is high.

Do not treat arbitrary tool text containing the word "error" as a failure.

---

# 6. Session Identification

The user must be able to tell **which Codex session/project** caused the notification.

## 6.1 Desired precedence

```text
1. supported user-facing Codex thread/session name
2. workspace/repository name from cwd
3. shortened session_id
```

Examples:

```text
OpenGrok #5035 • a1b2c3d4
```

fallback:

```text
opengrok • a1b2c3d4
```

last fallback:

```text
Session a1b2c3d4
```

## 6.2 Thread name

Codex App Server supports a user-facing `thread.name` and emits `thread/name/updated`.

Use this only if the active session's supported metadata is available to this extension.

## 6.3 No transcript title scraping

Hook input provides `transcript_path`, but the Codex documentation explicitly states that transcript format is not a stable interface.

Therefore:
- do not parse transcript internals to derive session title,
- do not make title resolution depend on JSONL implementation details.

## 6.4 `SessionLabelResolver`

Conceptual API:

```ts
resolve(input: {
  sessionId: string;
  threadName?: string | null;
  cwd?: string | null;
}): string
```

Algorithm:

```text
if threadName is non-empty:
    return "<threadName> • <shortSessionId>"

else if cwd exists:
    return "<basename(cwd)> • <shortSessionId>"

else:
    return "Session <shortSessionId>"
```

---

# 7. Notification Pipeline

```text
Raw Codex Event
      ↓
Validate
      ↓
Normalize
      ↓
Deduplicate
      ↓
Resolve Session Label
      ↓
Check Away Mode
      ↓
Redact Sensitive Text
      ↓
Format Final Notification
      ↓
BackendClient
      ↓ authenticated HTTPS
Cloudflare Worker
      ↓
Telegram Bot API
      ↓
User phone
```

Order matters.

Especially:
- deduplicate before sending,
- Away Mode check before network work,
- redact and format before `BackendClient`,
- never send raw Codex events or raw tool payloads to the backend.

---

# 8. Deduplication

Potential duplicate causes:
- retrying bridge delivery,
- overlapping sources,
- repeated lifecycle notification.

Suggested key:

```text
eventType + sessionId + turnId + toolUseId? + stableReasonHash?
```

Use a small in-memory TTL cache.

Example TTL:
- 30–120 seconds depending on event type.

Do not persist notification history in V1.

---

# 9. Message Formatting

Telegram messages should be lock-screen friendly.

# 9.1 Finished

```text
✅ Codex finished
Session: opengrok • a1b2c3d4
Summary: Bazaar tests were updated and the requested checks completed.
```

Summary source:
- existing `last_assistant_message`,
- deterministic truncation only.

No LLM call for summarization in V1.

---

# 9.2 Failed

```text
❌ Codex failed
Session: portfolio • f91a20c4
Reason: MCP authentication required
Detail: github server needs reauthentication.
```

Fallback:

```text
❌ Codex failed
Session: portfolio • f91a20c4
Reason: No detailed error was provided. Open VS Code to inspect.
```

---

# 9.3 Approval Required

```text
🔐 Approval required
Session: opengrok • a1b2c3d4
Action: Bash
Command: mvn test
Reason: Command requires approval.
```

Missing fields are omitted rather than displayed as `undefined`.

---

# 9.4 MCP Failed

```text
🔌 MCP failed
Session: stock-service • 70a94f31
Server: github
Reason: reauthenticationRequired
```

---

# 10. Sensitive Data Handling

Codex commands/tool inputs may contain credentials.

Before rendering a notification, redact likely:
- API keys,
- bearer tokens,
- passwords,
- authorization headers,
- common secret assignment patterns.

Examples to redact:

```text
Authorization: Bearer ***
OPENAI_API_KEY=***
TOKEN=***
PASSWORD=***
```

For V1:
- use conservative deterministic redaction,
- truncate overly long commands,
- never send complete environment dumps,
- complete redaction and formatting locally before network transmission.

The backend necessarily sees the final Telegram-ready message transiently so it can forward it. This is not end-to-end encryption, and the architecture does not claim the Worker is technically unable to observe an in-transit message. The privacy boundary is data minimization: the Worker receives only final sanitized text, forwards it to Telegram, and discards it.

Notification bodies must never be written to D1 or intentionally logged. Raw Codex events and raw tool payloads must never leave the extension. No notification history is retained.

A public privacy statement is a required V1 release artifact. It must accurately cover stored anonymous installation state, credential hashes, Telegram chat IDs, temporary pairing metadata, transient sanitized-message processing by the Worker and Telegram, excluded data, and disconnect/reset behavior. It must not claim end-to-end encryption.

---

# 11. Backend Client

API concept:

```ts
registerInstallation(): Promise<InstallationCredential>
createPairing(): Promise<Pairing>
getPairingStatus(pairingId: string): Promise<PairingStatus>
disconnectTelegram(): Promise<void>
sendNotification(message: string): Promise<SendResult>
```

Responsibilities:
- authenticated HTTPS calls to the Worker,
- anonymous installation registration,
- pairing creation and status checks,
- disconnect requests,
- sending only sanitized, formatted notification text,
- bounded timeouts and safe backend error reporting.

Must not:
- call the Telegram Bot API,
- retry forever,
- block Codex,
- expose the installation credential or notification body in logs.

Recommended behavior:
- short, bounded timeouts,
- bounded retries only for safe/idempotent operations such as pairing-status reads,
- exactly one attempt for `POST /v1/notifications`; timeout or lost response is reported as uncertain/failed without automatic retry.

Future notification retry support requires an explicit idempotency key/delivery ID and short-lived server-side deduplication state before retries can be enabled.

Telegram Bot API client logic belongs in the Worker, not in the VS Code extension.

---

# 12. Failure Isolation

Codex must keep functioning even if this extension is broken.

Every layer is best effort.

```text
Hook fires
  ↓
Bridge unavailable?
  → exit success / do not block Codex

Bridge sends event
  ↓
Extension OFF?
  → drop

Backend unavailable?
  → report notification delivery uncertain/failed locally
  → do not retry notification POST automatically
  → do not affect Codex

Telegram unavailable?
  → Worker returns a bounded delivery failure
  → extension may show a local warning
  → do not affect Codex

D1 unavailable?
  → fail pairing/notification safely
  → do not affect Codex
```

A notification extension and its hosted relay must never become part of Codex's critical execution path. No layer retries forever, and V1 never automatically retries notification submission.

---

# 13. Hook Installation Strategy

User may already have:

```text
~/.codex/hooks.json
```

or inline hooks in:

```text
~/.codex/config.toml
```

The installer must not overwrite unrelated configuration.

Preferred approach:
1. inspect current user-level hook configuration,
2. add only namespaced Far Away From Codex hook entries,
3. preserve existing content,
4. maintain an uninstall path,
5. inform user about Codex hook trust/review.

If safe automated merging cannot be guaranteed:
- generate the exact required snippet,
- provide a guided setup command,
- do not destructively rewrite configuration.

---

# 14. Event Adapter Boundary

Use an adapter interface so V1 is not permanently tied to one Codex integration path.

Concept:

```ts
interface CodexEventAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  onEvent(listener: (event: RawCodexEvent) => void): Disposable;
}
```

Possible adapters:

```text
HookBridgeAdapter
AppServerAdapter
```

V1 should use the smallest verified combination.

This is not an invitation to over-engineer:
- only implement adapters that are needed,
- keep the abstraction thin.

---

# 15. Proposed Source Mapping

| Product event | Preferred source | Fallback | V1 confidence target |
|---|---|---|---|
| Finished | `Stop` hook | none until proven | High |
| Approval | `PermissionRequest` | App Server request approval | High |
| Terminal Failed | active-session App Server terminal event | supported equivalent if found | Must be proven |
| MCP Failed | MCP startup event | `PostToolUse` MCP error | Medium/High |
| Session name | supported `thread.name` | `basename(cwd)` + short session ID | High fallback |

---

# 16. Suggested Source Layout

```text
far-away-from-codex/
├─ src/                       # VS Code extension
│  ├─ extension.ts
│  ├─ commands/
│  │  ├─ toggleAlerts.ts
│  │  ├─ connectTelegram.ts
│  │  ├─ disconnectTelegram.ts
│  │  └─ testNotification.ts
│  ├─ state/
│  │  ├─ AwayModeService.ts
│  │  └─ SecretStore.ts
│  ├─ backend/
│  │  ├─ BackendClient.ts
│  │  └─ BackendTypes.ts       # only if shared backend types are useful
│  ├─ codex/
│  ├─ bridge/
│  ├─ notifications/
│  │  ├─ NotificationFormatter.ts
│  │  └─ Redactor.ts
│  └─ utils/
├─ worker/                    # separate Cloudflare Worker TypeScript project
│  ├─ src/
│  ├─ migrations/
│  ├─ package.json
│  └─ wrangler configuration
├─ scripts/
├─ WORKPLAN.md
├─ ARCHITECTURE.md
└─ ...
```

The Worker remains a separate subproject so Cloudflare runtime dependencies and configuration do not contaminate the VS Code extension bundle.

---

# 17. Testing Architecture

## 17.1 Unit tests
Pure services:
- SessionLabelResolver,
- EventNormalizer,
- NotificationFormatter,
- Redactor,
- Deduplicator,
- AwayModeService.

## 17.2 Integration tests
Mock:
- loopback receiver,
- backend endpoint in extension tests,
- Telegram endpoint and D1 in Worker tests,
- SecretStorage.

Cover lazy installation registration/reuse, webhook bootstrap/authentication, pairing lifecycle and cleanup, per-endpoint limits, installation reset versus Telegram disconnect, notification no-retry behavior under uncertain delivery, and Test Notification while Away Mode is OFF.

Use real Codex only in manual/contract tests.

## 17.3 Contract fixtures
Keep anonymized JSON fixtures representing verified Codex events:

```text
test/fixtures/codex/
├─ stop.json
├─ permission-bash.json
├─ permission-mcp.json
├─ post-tool-use-failure.json
├─ turn-failed.json
└─ mcp-startup-failed.json
```

Fixtures must be captured/validated against a known Codex version.

---

# 18. Observability

Provide one VS Code OutputChannel:

```text
Far Away From Codex
```

Safe logs:

```text
[info] Away mode enabled
[info] Received Stop event for session a1b2c3d4
[info] Notification relay succeeded
[warn] Dropped duplicate PermissionRequest event
[error] Notification relay failed
```

Never print:
- installation credentials,
- pairing tokens,
- Telegram bot or webhook secrets,
- Telegram chat IDs,
- notification bodies,
- raw unredacted payloads.

Optional developer-only verbose mode may be added later.

---

# 19. Compatibility and Versioning

Codex event contracts can evolve.

Track:
- extension version,
- minimum supported VS Code version,
- Codex behavior verified during release testing.

Do not silently rely on:
- DOM/UI scraping,
- VS Code webview internals,
- undocumented Codex extension private APIs,
- transcript JSONL internals.

Prefer:
- documented hooks,
- documented App Server protocol,
- graceful fallback.

---

# 20. V1 Architectural Decision Summary

## Use
- VS Code TypeScript extension,
- Cloudflare Worker with D1,
- one official Far Away From Codex Telegram bot and webhook,
- anonymous installation authentication,
- VS Code SecretStorage for the client installation credential,
- Codex lifecycle hooks,
- local loopback bridge,
- deterministic message formatting,
- best-effort session label.

## Avoid
- user accounts and user profiles,
- notification or Codex-event history,
- remote control,
- Telegram replies or approval actions controlling Codex,
- login/signup, email authentication, OAuth accounts, and admin/web frontends,
- analytics, telemetry, billing, subscriptions, and dashboards,
- multiple delivery providers and WhatsApp,
- AI-generated summaries,
- UI scraping,
- unstable transcript parsing.

## Fundamental V1 promise

```text
I am leaving my desk.
Turn Codex Alerts ON.
If Codex finishes, fails, needs approval,
or an MCP problem needs attention,
tell me on my phone and tell me which session it came from.
```

---

## Official references

- Codex Hooks: https://learn.chatgpt.com/docs/hooks
- Codex App Server: https://learn.chatgpt.com/docs/app-server
