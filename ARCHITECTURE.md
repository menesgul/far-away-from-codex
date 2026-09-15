# ARCHITECTURE.md — Codex Away Alerts

> Architecture for the V1 VS Code extension that forwards important Codex events to Telegram while **Away Mode** is enabled.

# 1. Architectural Goals

The system should be:

1. **Simple**
   - one-click ON/OFF after first-time setup.

2. **Local-first**
   - no project-owned backend,
   - no account system,
   - no remote control.

3. **Non-invasive**
   - monitoring must never block or control Codex,
   - failures in this extension must not break a Codex turn.

4. **Secure by default**
   - Telegram token in VS Code `SecretStorage`,
   - loopback-only local communication,
   - no secrets in hook configuration.

5. **Truthful**
   - distinguish a terminal turn failure from a recoverable tool failure,
   - never invent a failure reason,
   - never claim a session name unless obtained from supported metadata.

---

# 2. High-Level Architecture

```text
┌───────────────────────────────┐
│          Codex IDE            │
│                               │
│  Stop                         │
│  PermissionRequest            │
│  PostToolUse                  │
│  other supported event        │
└───────────────┬───────────────┘
                │ hook JSON via stdin
                ▼
┌───────────────────────────────┐
│ Local Bridge                  │
│ ~/.codex/codex-away-alerts/   │
│ bridge.cjs                    │
│                               │
│ - no Telegram credential      │
│ - quick best-effort forward   │
└───────────────┬───────────────┘
                │ HTTP on 127.0.0.1
                │ runtime nonce
                ▼
┌───────────────────────────────┐
│ VS Code Extension Host        │
│                               │
│ Event Receiver                │
│ Event Normalizer              │
│ Session Label Resolver        │
│ Away Mode State               │
│ Notification Formatter        │
│ Telegram Client               │
│ SecretStorage                 │
└───────────────┬───────────────┘
                │ HTTPS
                ▼
┌───────────────────────────────┐
│ Telegram Bot API              │
└───────────────┬───────────────┘
                ▼
          📱 User phone
```

---

# 3. Why Use a Local Bridge?

Codex lifecycle hooks execute independently of our VS Code extension and receive structured JSON through stdin.

The bridge exists so that:

- Codex can emit events without knowing Telegram credentials,
- the Telegram token stays inside VS Code SecretStorage,
- the status-bar Away Mode remains the single source of truth,
- the Codex hook remains lightweight,
- no hosted server is needed.

The bridge is transport only.

It must **not**:
- decide whether something is Finished/Failed,
- format Telegram messages,
- store Telegram credentials,
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
- install/update bridge assets.

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
telegram.botToken
telegram.chatId
```

No other component should persist these secrets to disk.

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
~/.codex/codex-away-alerts/bridge.cjs
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
~/.codex/codex-away-alerts/runtime.json
```

The runtime descriptor contains **no Telegram credential**.

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
Format Telegram Message
      ↓
Telegram Client
```

Order matters.

Especially:
- deduplicate before sending,
- Away Mode check before network work,
- redact before Telegram.

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

Do not persist large notification history in V1.

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
- never send complete environment dumps.

---

# 11. Telegram Client

API concept:

```ts
send(message: string): Promise<SendResult>
```

Responsibilities:
- Bot API request,
- timeout,
- non-2xx handling,
- safe error reporting.

Must not:
- retry forever,
- block Codex,
- expose bot token in logs.

Recommended behavior:
- short timeout,
- at most one bounded retry for a clearly transient network failure.

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

Telegram unavailable?
  → optionally show local VS Code warning
  → do not affect Codex
```

A notification extension should never become part of Codex's critical execution path.

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
2. add only namespaced Codex Away hook entries,
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
src/
├─ extension.ts
├─ commands/
│  ├─ toggleAlerts.ts
│  ├─ setupTelegram.ts
│  └─ testNotification.ts
├─ state/
│  ├─ AwayModeService.ts
│  └─ SecretStore.ts
├─ codex/
│  ├─ HookInstaller.ts
│  ├─ EventNormalizer.ts
│  ├─ SessionLabelResolver.ts
│  ├─ EventDeduplicator.ts
│  └─ adapters/
│     ├─ HookBridgeAdapter.ts
│     └─ AppServerAdapter.ts   # only if feasibility proves it is needed/safe
├─ bridge/
│  ├─ LocalEventReceiver.ts
│  └─ bridge.cjs
├─ notifications/
│  ├─ NotificationFormatter.ts
│  ├─ TelegramClient.ts
│  └─ Redactor.ts
└─ utils/
   └─ logger.ts
```

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
- Telegram endpoint,
- SecretStorage.

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
Codex Away Alerts
```

Safe logs:

```text
[info] Away mode enabled
[info] Received Stop event for session a1b2c3d4
[info] Telegram notification sent
[warn] Dropped duplicate PermissionRequest event
[error] Telegram request failed: HTTP 401
```

Never print:
- bot token,
- chat ID unless masked,
- raw unredacted payload by default.

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
- Telegram Bot API,
- VS Code SecretStorage,
- Codex lifecycle hooks,
- local loopback bridge,
- deterministic message formatting,
- best-effort session label.

## Avoid
- backend server,
- database,
- remote control,
- Telegram command handling,
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
