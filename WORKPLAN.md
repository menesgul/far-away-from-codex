# WORKPLAN.md — Far Away From Codex

> Product: **Far Away From Codex**
> Goal: When the developer leaves the computer, enable one lightweight **Away Mode** in VS Code and receive only important Codex events on Telegram.

## 0. Product Goal and MVP Boundary

### 0.1 Problem
While Codex is running in VS Code, the user may leave the computer and miss:
- task completion,
- a terminal failure,
- an approval request,
- an MCP failure,
- or another event that requires coming back to the computer.

### 0.2 MVP promise
When **Codex Alerts: ON**, send concise Telegram notifications for:

1. **✅ Finished**
   - Include session label when available.
   - Include a short version of the last assistant message when available.

2. **❌ Failed**
   - Prefer a true terminal turn failure.
   - Include the most useful available failure reason.
   - Do not silently convert every recoverable tool error into a terminal failure.

3. **🔐 Approval required**
   - Include what needs approval.
   - Prefer: tool/action, command or target, human-readable reason, cwd/project.

4. **🔌 MCP failed** — best effort for MVP
   - Include MCP server/tool name and error/failure reason when available.

### 0.3 Core UX
- VS Code status bar:
  - `$(bell-slash) Codex Alerts: OFF · $(send) ✓`
  - `$(bell-slash) Codex Alerts: OFF · $(send) ✕`
  - `$(bell-slash) Codex Alerts: OFF · $(send) ?`
  - `$(bell) Codex Alerts: ON · $(send) ✓`
- With verified connection state, one click toggles Away Mode; disconnected and unknown states instead offer Connect or retry the authoritative lookup.
- Commands:
  - `Far Away From Codex: Enable`
  - `Far Away From Codex: Disable`
  - `Far Away From Codex: Toggle`
  - `Far Away From Codex: Connect Telegram`
  - `Far Away From Codex: Disconnect Telegram`
  - `Far Away From Codex: Test Notification`

### 0.4 Explicit non-goals for V1
Do **not** add:
- remote control of Codex,
- replying to prompts from Telegram,
- approval from Telegram,
- web dashboard,
- user accounts,
- analytics,
- payments or subscriptions,
- WhatsApp,
- multiple delivery providers,
- notification history,
- complex notification rules.

Telegram setup is QR-first in V1. Do not add a short human pairing-code fallback. V1 does include one lightweight, local first-activation onboarding prompt; only its explicit Connect Telegram action delegates to the normal Connect command. Notification relay remains Slice E, not Slice D.

The product remains local-first for Codex processing. Its intentionally small hosted component is limited to anonymous installation authentication, Telegram pairing, and relaying final sanitized notification text through the official bot.

---

# 1. Environment and Repository Setup

## 1.1 Create repository
Create a public GitHub repository.

Suggested structure:

```text
far-away-from-codex/
├─ src/
│  ├─ extension.ts
│  ├─ commands/
│  ├─ codex/
│  ├─ bridge/
│  ├─ notifications/
│  ├─ state/
│  └─ utils/
├─ scripts/
├─ test/
├─ resources/
├─ WORKPLAN.md
├─ ARCHITECTURE.md
├─ README.md
├─ package.json
├─ tsconfig.json
└─ .gitignore
```

## 1.2 Initialize VS Code extension
Use:
- TypeScript,
- current supported VS Code Extension API,
- ESLint,
- a lightweight test runner compatible with VS Code extension testing.

## 1.3 Development commands
Provide at minimum:

```text
npm install
npm run compile
npm run watch
npm run lint
npm test
```

## 1.4 Local Extension Development Host
Verify:
- extension activates,
- command palette commands appear,
- status bar item appears,
- extension can be launched using `F5`,
- clean uninstall/reinstall does not leave broken runtime state.

## 1.5 Gate 1 — Environment Review
Do not move to external integrations until all are true:

- [x] clean clone installs successfully,
- [x] extension host starts,
- [x] lint passes,
- [x] current test suite runs,
- [x] status bar renders,
- [x] project structure matches `ARCHITECTURE.md`.

**Gate 1 status: PASS — Phase 2 may begin.**

---

# 2. External Integration and Event Feasibility

This phase implements and proves external boundaries before the real Codex alert event features. Phase 2.1 is realized by implementation Slices B through E: Worker foundation, anonymous installation authentication, Telegram pairing, and test-notification relay. Complete Phase 2.1 before using Phase 2.2–2.7 to prove Codex event sources and local integration feasibility. Gate 2 permits and requires that Phase 2.1 work; it blocks the later Finished/Approval/Failure/MCP feature implementation until all integration sources are proven.

## 2.1 Telegram proof of concept
The project owner creates one official Far Away From Codex bot with BotFather. End users never create bots or handle Telegram credentials.

Prove delivery:

```text
VS Code extension
        ↓
Cloudflare Worker
        ↓
Official Far Away From Codex Telegram bot
        ↓
Phone
```

Prove pairing:

```text
Connect Telegram command
        ↓ ensure/reuse anonymous installation credential
GET /v1/telegram-connection
        ↓ connected: report Connected, no pairing UI
        ↓ disconnected: Worker pairing request
Transient local VS Code QR pairing UI
        ↓ scan with phone; user presses Start in official bot
Telegram webhook
        ↓
Cloudflare Worker + D1 mapping
        ↓
Connected
```

Requirements to prove:
- the official project bot exists,
- the Cloudflare Worker runs and its D1 binding works,
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` are configured as Worker secrets and never committed,
- `TELEGRAM_BOT_USERNAME` is configured as non-secret Worker configuration,
- Telegram `setWebhook` registers the deployed `/v1/telegram/webhook` using the webhook secret as `secret_token`,
- webhook configuration is verified before user pairing tests,
- anonymous installation registration is lazy and returns a high-entropy credential once,
- the extension stores that credential in VS Code `SecretStorage`,
- an existing installation credential is reused instead of creating another record,
- first activation can show the local prompt “Connect Telegram to receive Codex alerts on your phone.” with Connect Telegram and Not now actions without any backend request,
- Not now creates no installation or backend/D1 record, while Connect Telegram delegates to the normal QR-first Connect flow,
- a local `globalState` `onboardingShown` flag is set when either onboarding action is chosen and limits the prompt to at most once per local VS Code profile/extension UX state; it is separate from, and never replaces, authoritative D1 Telegram connection state,
- D1 stores only the installation credential hash,
- activation without an installation credential makes zero backend requests and renders the unconfigured `OFF + ✕` indicator,
- activation with an existing credential performs exactly one bounded authenticated `GET /v1/telegram-connection`, rendering `OFF + ✓` when connected, `OFF + ✕` when disconnected, and `OFF + ?` on backend/network failure without treating failure as disconnected,
- definitive invalid/revoked-credential rejection clears only the unusable local credential and renders unconfigured `OFF + ✕`; timeout/network/5xx retains the credential and renders `OFF + ?`,
- activation never calls `POST /v1/installations` and does not persist local connected/disconnected state across sessions; only a later explicit Connect Telegram action may create a replacement identity,
- `GET /v1/telegram-connection` returns only `{ connected: boolean }` for the authenticated installation and D1 is the connection-state authority,
- one-time, short-lived Telegram QR/deep-link pairing works with a QR rendered locally in transient VS Code UI,
- pairing URLs/tokens are not sent to an external QR-generation service and are never persisted or logged,
- Connect Telegram does not automatically call `vscode.env.openExternal()` or otherwise open Telegram; Copy Link and Open on This Device are optional explicit pairing-UI actions, and only the latter may open the URL,
- the webhook secret is validated,
- the webhook accepts only the exact pairing token from a private chat,
- Telegram `chat_id` is discovered automatically and stored only server-side,
- a successful private-chat association persists in D1 across VS Code/extension reload, PC restart, and Away Mode changes; those normal restarts require neither onboarding nor another QR,
- Connect Telegram checks connection state first; an already-connected installation reports Connected without creating a pairing or showing another QR,
- `POST /v1/pairings` returns safe `409 ALREADY_CONNECTED` without a chat ID, token, or URL when a stale client/race requests pairing for an already-connected installation,
- end users enter no bot token, chat ID, phone number, or account information,
- the extension can observe pending/connected/expired pairing status,
- Test Notification travels through the Worker and official bot,
- notification bodies are neither persisted nor intentionally logged,
- notification submission is attempted once without automatic retry,
- definitive successful Disconnect clears the server-side chat association and invalidates pending pairings while keeping the installation credential valid; failed or uncertain Disconnect remains `OFF + ?` until a later authoritative read resolves it,
- full installation reset/revocation remains a separate operation and is required before reconnecting only when the anonymous installation identity is lost or replaced,
- neither Disconnect nor installation reset/revocation automatically resets or re-shows onboarding; both require a new setup only after the user explicitly runs Connect Telegram, while a clean extension install or fresh VS Code profile may naturally show onboarding from new local state,
- expired/used pairing cleanup and revoked/abandoned installation retention behavior are validated,
- endpoint-specific body limits, polling limits, and abuse/rate controls are validated.

### Acceptance
A fresh Extension Development Host user can:

1. run `Far Away From Codex: Connect Telegram`,
2. scan the locally rendered QR with their phone,
3. press **Start** on the official bot,
4. see **Connected** in VS Code,
5. reload the extension or VS Code and confirm no new QR or re-pairing is needed,
6. run Connect Telegram again and confirm it reports Connected without creating another pairing,
7. with Away Mode OFF, run `Far Away From Codex: Test Notification`,
8. receive exactly one phone notification,
9. explicitly run Disconnect Telegram, then Connect Telegram, and receive a fresh QR pairing flow.

This flow requires no BotFather interaction, bot token, chat ID, phone-number entry, or user account. It associates a Telegram private chat/account rather than a physical phone. On a fresh activation with no installation credential, a local onboarding prompt may appear but does not register an installation, call the backend, query connection state, pair, render a QR, or open Telegram. Only its explicit Connect Telegram action starts the normal flow; Not now performs no backend action. An activation that already has a credential separately performs the one bounded authoritative connection lookup defined in section 3.3. Phase 2.1 remains incomplete until real deployed Worker and device acceptance passes.

---

## 2.2 Codex event-source spike

The primary goal is to prove how events from the **currently running Codex IDE session** reach this extension.

### Preferred architecture
Use Codex lifecycle hooks where they provide stable information:

- `Stop`
- `PermissionRequest`
- `PostToolUse`
- optional supporting lifecycle events

Hook payloads already provide common identifiers such as:
- `session_id`,
- `cwd`,
- and turn-scoped `turn_id`.

### Local bridge
Prove this flow:

```text
Codex Hook
   ↓ stdin JSON
stable local bridge script
   ↓ loopback HTTP
VS Code extension
```

The extension should copy/install a small stable bridge script under a user-level path such as:

```text
~/.codex/far-away-from-codex/bridge.cjs
```

The Codex hook definition should point at this stable path rather than a versioned VS Code Marketplace extension directory.

The bridge must:
- read hook JSON from stdin,
- discover the active extension loopback endpoint,
- send the event locally,
- exit quickly,
- never contain the installation credential or Telegram credentials,
- fail silently when the VS Code extension is not running.

---

## 2.3 Prove Finished event

Preferred source:
- Codex `Stop` hook.

Verify that the event contains:
- `session_id`,
- `turn_id`,
- `cwd`,
- `last_assistant_message`.

Test:
1. run a normal Codex task,
2. let it finish,
3. inspect captured event,
4. verify the event is associated with the correct session.

### Important validation
Confirm behavior in the current Codex IDE extension version. Do not assume CLI behavior is identical without testing.

---

## 2.4 Prove Approval event

Preferred source:
- Codex `PermissionRequest` hook.

Capture:
- `session_id`,
- `turn_id`,
- `tool_name`,
- `tool_input`,
- `tool_input.command` where applicable,
- `tool_input.description` where available,
- `cwd`.

Test at least:
- shell approval,
- network approval if practical,
- MCP approval if practical.

Expected rendered examples:

```text
🔐 Approval required
Session: opengrok • a1b2c3d4
Action: Bash
Command: mvn test
Reason: Command requires approval
```

or:

```text
🔐 Approval required
Session: portfolio • e8f91a20
Action: Network
Target: github.com
```

---

## 2.5 Prove terminal Failure event

This is the most important technical spike.

### Preferred source
A true terminal Codex turn event with:

```text
status = failed
error.message
codexErrorInfo
additionalDetails
```

The Codex App Server protocol exposes this through `turn/completed`, but the implementation must verify that the extension can observe the **same active IDE session** without creating a separate Codex session.

### Decision order

#### Option A — direct stable IDE/App Server event access
Use it if the current Codex IDE integration exposes a supported and reliable route.

#### Option B — supported hook/event equivalent
Use it if a lifecycle hook exposes a terminal turn failure in the installed version.

#### Option C — limited fallback
If neither A nor B is safely available:
- use `PostToolUse` only for explicitly identifiable tool/MCP failures,
- label them as **Tool failed** or **MCP failed**, not as a terminal Codex failure,
- do not claim the whole turn failed,
- document the limitation.

### Hard rule
Do not parse undocumented Codex UI internals to fake terminal failure detection.

Do not base V1 on an unstable transcript parser. Codex documentation explicitly treats the transcript format as non-stable.

---

## 2.6 Prove MCP failure event

Preferred sources, in order:

1. App Server `mcpServer/startupStatus/updated`
   - `threadId`
   - `name`
   - `status`
   - `error`
   - `failureReason`

2. `PostToolUse` MCP result for an MCP invocation that returns an error.

Expected notification:

```text
🔌 MCP failed
Session: stock-service • f71b2e09
Server: github
Reason: reauthenticationRequired
Detail: Stored OAuth credentials could not be refreshed.
```

---

## 2.7 Session-label feasibility

Desired label precedence:

1. user-facing Codex thread/session name, if obtained from a supported API/event;
2. workspace/repository folder name derived from `cwd`;
3. shortened Codex `session_id`.

Example:

```text
Session: OpenGrok #5035 • a1b2c3d4
```

Fallback:

```text
Session: opengrok • a1b2c3d4
```

Do not parse the unstable transcript format merely to obtain a pretty session name.

---

## 2.8 Gate 2 — Integration Review

Before Codex event-feature implementation begins, create a short spike report containing:

| Event | Source | Verified in IDE? | Useful fields | Reliability |
|---|---|---:|---|---|
| Finished | Stop hook |  |  |  |
| Approval | PermissionRequest |  |  |  |
| Terminal Failed | App Server / equivalent |  |  |  |
| Tool Failed | PostToolUse |  |  |  |
| MCP Failed | App Server / PostToolUse |  |  |  |
| Session label | thread name / cwd / id |  |  |  |

Do not move to Phase 3 until:
- [ ] official bot + Worker delivery works,
- [ ] anonymous installation authentication is proven,
- [ ] first-activation onboarding is local-only until an explicit Connect Telegram click, with Not now performing no backend action,
- [ ] activation reads existing installation state without registration: no credential makes zero requests; a credential makes one bounded connection lookup and accurately renders `✓`, `✕`, or `?`,
- [ ] definitive invalid/revoked credential rejection clears the local identity without auto-registration, while timeout/network/5xx preserves the credential and `?` state,
- [ ] QR-first one-time pairing through the user's phone is proven,
- [ ] D1-authoritative connection-state lookup is proven and already-connected Connect bypasses a new pairing/QR,
- [ ] Telegram webhook authentication is proven,
- [ ] deployed webhook registration/configuration is verified,
- [ ] automatic private-chat association is proven,
- [ ] Test Notification reaches the phone through the backend,
- [ ] the backend does not persist or intentionally log message bodies,
- [ ] notification POST is attempted once without automatic retry,
- [ ] the one-time connection persists across VS Code/extension reload, PC restart, and Away Mode changes until Disconnect/reset,
- [ ] Disconnect and separate installation reset/revocation semantics are proven, including fresh pairing after Disconnect,
- [ ] Finished source is proven,
- [ ] Approval source is proven,
- [ ] failure strategy is explicitly decided,
- [ ] session-label fallback is proven,
- [ ] hook install/trust workflow is understood.

Slices B through E are the implementation work required to complete Phase 2.1 and are explicitly allowed before Gate 2 passes. Gate 2 prevents proceeding into the real Codex event-feature slices—Finished, Approval, Failure, and MCP behavior—until both the backend/Telegram path and Codex event sources have been proven. Gate 2 remains open.

---

# 3. Core Extension Implementation

## 3.1 Extension activation
Implement:
- command registration,
- status bar item,
- activation-time read of an existing installation credential and exactly one bounded authoritative connection lookup when that credential exists; never installation registration during activation,
- the one-time local first-activation onboarding prompt and its local UX-state handling, only as Slice D's final eighth UX step after the core pairing changes validate,
- configuration loading,
- SecretStorage access,
- BackendClient lifecycle,
- local event receiver startup.

## 3.2 Away Mode state

State values:

```text
ON
OFF
```

Behavior:

### OFF
- receive/drop local events if necessary,
- send no Telegram notification.

### ON
- require verified Telegram connection state before enabling,
- process supported Codex events locally,
- redact and format notifications locally,
- relay final sanitized messages through the backend.

Persist the user's preferred state across normal VS Code restarts only if testing shows that behavior is intuitive. Otherwise default to OFF for safety.

Recommended V1 default:
- **OFF on first install**.

## 3.3 Status bar
Status bar must make both Away Mode and the current authoritative Telegram connection state obvious. Activation first reads `farAway.installationCredential` from SecretStorage:

```text
no credential:       $(bell-slash) Codex Alerts: OFF · $(send) ✕
connected:           $(bell-slash) Codex Alerts: OFF · $(send) ✓
disconnected:        $(bell-slash) Codex Alerts: OFF · $(send) ✕
backend failure:     $(bell-slash) Codex Alerts: OFF · $(send) ?
enabled/connected:   $(bell) Codex Alerts: ON · $(send) ✓
```

Activation behavior:

1. With no credential, make zero backend requests and render `OFF + ✕`.
2. With a credential, perform exactly one bounded authenticated `GET /v1/telegram-connection`.
3. Render `✓` for `{ connected: true }`, `✕` for `{ connected: false }`, and retain the credential with `?` for timeout, network, or 5xx failure. Failure must never be represented as disconnected.
4. On a definitive invalid/revoked installation-credential rejection, remove the unusable credential from SecretStorage and render the local installation as unconfigured `OFF + ✕`. This same classification applies to activation and later authenticated lookup retries. It is anonymous-identity recovery, not Telegram disconnected state.
5. Never call `POST /v1/installations` during activation or persist a local connected/disconnected boolean. Only a later explicit Connect Telegram action may lazily register a replacement credential.

Click behavior:

- `OFF + ✓`: enable alerts.
- `ON + ✓`: disable alerts.
- `OFF + ✕`: offer **Connect Telegram** or Cancel.
- `OFF + ?`: retry the authoritative connection lookup. A successful response restores `✓` or `✕`; another failure remains `?`.

`ON + ✕` and `ON + ?` are not normal reachable states. Disconnect immediately forces Away Mode OFF; its suffix becomes `✕` only after definitive DELETE success, otherwise `?`.

Optional tooltip:
```text
Far Away From Codex
Click to enable/disable phone notifications.
```

---

# 4. Telegram Connection

## 4.1 Connect command
`Far Away From Codex: Connect Telegram`

Flow:
1. check VS Code `SecretStorage` for `farAway.installationCredential`,
2. if missing, call `POST /v1/installations` and store the credential returned once,
3. if present, reuse it and do not create another installation,
4. call authenticated `GET /v1/telegram-connection`, for which D1 is authoritative,
5. if it returns `{ connected: true }`, report **Telegram connected** and do not create a pairing or show the pairing UI,
6. otherwise request a short-lived, one-time pairing from the Worker,
7. render the returned `telegramUrl` as a QR code locally in a transient VS Code pairing UI,
8. make scanning the QR with the user's phone the primary action; the user presses **Start** in the official bot,
9. offer only explicit optional actions: **Copy Link**, **Open on This Device**, and Cancel; Open on This Device may use `vscode.env.openExternal()` only after that click,
10. bounded-poll the pairing for `pending`, `connected`, or `expired`, close/complete the pairing UI on success, and report **Telegram connected**.

The command must never automatically call `vscode.env.openExternal()` or send `telegramUrl`/pairing tokens to an external QR-generation service. QR and pairing material are transient: do not persist or log them. Installation registration remains lazy: activation may read existing installation state through the single bounded connection lookup, but it never creates a backend/D1 record, calls `POST /v1/installations`, creates a pairing, renders a QR, or opens Telegram. A fresh install without a credential makes no activation backend request.

If an existing credential was cleared after a definitive invalid/revoked-credential rejection, this explicit command is the recovery path: it lazily registers a replacement installation credential, then follows the same authoritative connection check and QR-first pairing flow. Timeout, network, and 5xx lookup failures retain the existing credential and render `?`; they do not trigger replacement registration.

The user never enters a bot token, Telegram chat ID, phone number, username, or account credential. The official bot token and webhook secret exist only as Worker secrets; the chat ID exists only in D1.

## 4.2 Test command
`Far Away From Codex: Test Notification`

Example:

```text
🔔 Far Away From Codex
Telegram notifications are working.
```

The extension sends this final sanitized text to `BackendClient`. The Worker looks up the paired chat ID, attempts exactly one message through the official bot, and does not persist the body. The extension must not automatically retry this notification POST.

Test Notification is a setup/connection diagnostic and works independently of `Codex Alerts: ON/OFF`. It must send exactly one test message even when Away Mode is OFF, and fail clearly when Telegram is not connected or backend delivery fails. Away Mode controls only real Codex event notifications.

## 4.3 Disconnect command
`Far Away From Codex: Disconnect Telegram`

Behavior:
- force Away Mode OFF immediately,
- call authenticated `DELETE /v1/telegram-connection`,
- on definitive DELETE success, clear the server-side Telegram chat association and invalidate applicable pending pairings,
- retain the installation credential; do not persist a local connected boolean as a replacement for D1,
- on definitive DELETE success, render `OFF + ✕`,
- on failed, timed-out, or uncertain DELETE, render `OFF + ?`, show a safe local error/retry message, and do not claim Telegram is disconnected,
- allow a later Connect Telegram command to check D1 state and create a new QR pairing,
- leave the official bot token untouched.

Resetting/revoking the anonymous installation credential is a separate recovery operation, conceptually `DELETE /v1/installation`. It invalidates the credential and pending pairings, clears the Telegram association, and makes that credential unusable. Disconnect keeps the installation credential valid; reset/revoke does not. There is no user-account deletion because no user account exists.

## 4.4 Error handling
Show a local VS Code error if:
- registration or installation authentication fails,
- pairing expires or is rejected,
- Disconnect fails or has an uncertain outcome,
- the backend, D1, or Telegram is unavailable,
- notification delivery fails.

Do not expose installation credentials, pairing tokens, Telegram secrets, chat IDs, notification bodies, or raw backend/Telegram URLs in errors or logs.

---

# 5. Event Normalization

## 5.1 Internal normalized event

All Codex-specific inputs should be converted to one internal model before rendering:

```ts
type AlertEvent =
  | FinishedEvent
  | FailedEvent
  | ApprovalRequiredEvent
  | McpFailedEvent;
```

Common fields:

```text
type
sessionId
turnId?
sessionLabel
cwd?
timestamp
source
```

This separates Codex integration from Telegram formatting.

## 5.2 Finished normalization
Fields:
- session label,
- last assistant message,
- optional elapsed/turn metadata if already available.

Do not generate an AI summary in V1.

Use deterministic truncation of the existing last assistant message.

## 5.3 Failed normalization
Fields:
- failure reason,
- error code/type if available,
- additional detail if safe and concise,
- source reliability.

Differentiate:

```text
Terminal failure
Tool failure
MCP failure
```

Never mislabel a recoverable tool failure as a terminal turn failure.

## 5.4 Approval normalization
Fields:
- action/tool,
- command/target,
- human-readable description/reason,
- cwd/project.

Sanitize excessively long commands.

---

# 6. Notification Formatting

## 6.1 Finished

```text
✅ Codex finished
Session: opengrok • a1b2c3d4
Summary: Updated Bazaar repository tests and completed the requested checks.
```

If no assistant message is available:

```text
✅ Codex finished
Session: opengrok • a1b2c3d4
```

## 6.2 Terminal failure

```text
❌ Codex failed
Session: portfolio • 91c20a7e
Reason: MCP authentication required
Detail: github server needs reauthentication.
```

Fallback:

```text
❌ Codex failed
Session: portfolio • 91c20a7e
Reason: No detailed error was provided. Open VS Code to inspect.
```

## 6.3 Approval

```text
🔐 Approval required
Session: opengrok • a1b2c3d4
Action: Bash
Command: mvn test
Reason: Command requires approval.
```

## 6.4 MCP failure

```text
🔌 MCP failed
Session: stock-service • 70a94f31
Server: GitHub
Reason: reauthenticationRequired
```

---

# 7. Local Bridge and Security

## 7.1 Loopback only
Local receiver must bind only to:

```text
127.0.0.1
```

Never bind to `0.0.0.0`.

## 7.2 Runtime authentication
On extension activation:
- generate a random runtime nonce,
- start receiver on an available loopback port,
- write only `{port, nonce}` to a restricted runtime file.

Bridge:
- reads runtime file,
- attaches nonce,
- POSTs hook payload to loopback.

The anonymous installation credential remains inside VS Code SecretStorage and must never enter the bridge or runtime file.

## 7.3 Runtime file
Suggested path:

```text
~/.codex/far-away-from-codex/runtime.json
```

Contents must never contain:
- anonymous installation credential,
- Telegram bot token or webhook secret,
- Telegram chat ID.

Delete/stale-check on shutdown/startup.

## 7.4 Logs
Never log:
- installation credentials or pairing tokens,
- Telegram bot or webhook secrets,
- Telegram chat IDs,
- notification bodies,
- full sensitive commands by default,
- secrets found in tool payloads.

Implement deterministic redaction and final formatting locally before calling the backend. Never transmit raw Codex events or raw tool payloads to the Worker.

## 7.5 Hosted API security

- use TLS/HTTPS only,
- authenticate extension requests with a high-entropy installation bearer credential,
- store only installation-credential hashes and pairing-token hashes in D1,
- never place credentials in query strings, logs, repository files, or hook/bridge files,
- validate the Telegram webhook secret,
- protect unauthenticated `POST /v1/installations` with IP-level rate limiting/abuse controls and a bounded request body so it cannot create unlimited D1 records,
- rate-limit `POST /v1/pairings` per installation and prevent unlimited active pairings,
- make `POST /v1/pairings` refuse an authenticated installation that already has a Telegram chat association, returning safe `409 ALREADY_CONNECTED` without a chat ID, token, or URL,
- require installation authentication for `GET /v1/telegram-connection`, return only `{ connected: boolean }`, and rate-limit it to reasonable activation- and command-driven reads,
- require installation authentication for `GET /v1/pairings/:id` and enforce reasonable, non-aggressive polling,
- rate-limit `POST /v1/notifications` per installation and enforce bounded message/body length,
- validate the webhook secret before processing `POST /v1/telegram/webhook`, bound its body, and safely reject malformed/unsupported updates,
- use bounded request timeouts and no infinite retry path,
- make pairing tokens short-lived, exact-match, private-chat-only, and single-use,
- keep V1 low-friction: no CAPTCHA, Turnstile, login, or account system without later evidence of abuse.

---

# 8. Coding + Unit Testing Cycle

Implement one vertical slice at a time.

## 8.1 Slice A — Away state
Code:
- toggle,
- status bar,
- persistence decision.

Tests:
- ON → OFF,
- OFF → ON,
- status text,
- default state.

Review before Slice B.

## 8.2 Slice B — Worker foundation
Code:
- separate Cloudflare Worker TypeScript project,
- optional health route,
- D1 binding and minimal migrations,
- Worker secret strategy for `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`,
- non-secret `TELEGRAM_BOT_USERNAME` configuration,
- deployment bootstrap with Telegram `setWebhook` and webhook verification,
- bounded requests, responses, and timeouts.

Tests:
- Worker routing,
- D1 binding/repository behavior,
- missing secret/config failure,
- webhook bootstrap/configuration verification,
- body limits and safe errors.

Review before Slice C.

## 8.3 Slice C — Anonymous installation authentication
Code:
- installation registration endpoint,
- lazy registration on first backend use and existing-credential reuse,
- secure high-entropy credential generation,
- server-side credential hashing,
- `BackendClient` registration/authentication,
- VS Code SecretStorage integration,
- installation reset/revocation endpoint and lifecycle,
- local anonymous-installation identity recovery: clear a credential only after definitive invalid/revoked authentication rejection, never for timeout/network/5xx, and require explicit Connect for replacement registration.

Tests:
- registration returns credential once,
- fresh activation without a credential makes zero backend requests, renders `OFF + ✕`, and creates no backend/D1 record,
- activation with a credential never registers an installation,
- existing credential prevents duplicate registration,
- D1 contains only credential hash,
- valid/invalid/revoked authentication,
- invalid/revoked credential is cleared from SecretStorage only after definitive authentication rejection and renders unconfigured `OFF + ✕`,
- timeout/network/5xx connection lookup retains the credential and renders `OFF + ?`,
- activation never registers a replacement credential; the next explicit Connect Telegram action may lazily register and pair a replacement identity,
- reset invalidates credential, pairings, and chat association,
- credential never appears in URLs or logs.

Review before Slice D.

## 8.4 Slice D — Telegram pairing
Code:
- official bot webhook,
- webhook-secret validation,
- hashed, expiring, one-time pairing tokens,
- private-chat exact `/start <token>` matching,
- D1-authoritative private-chat association that persists per anonymous installation across VS Code/extension reloads, PC restarts, and Away Mode changes,
- authenticated `GET /v1/telegram-connection` returning `{ connected: boolean }`,
- activation-time connection-status UX as a refinement of the existing state flow, not a ninth pairing feature: one bounded lookup for an existing credential, `✓`/`✕`/`?` rendering, and stateful status-bar click behavior,
- Disconnect outcome handling that forces Away Mode OFF immediately but renders `✕` only after definitive DELETE success and `?` for failed, timed-out, or uncertain DELETE,
- Connect Telegram ensures/reuses the installation credential, checks connection state before pairing, and bypasses pairing UI when already connected,
- `POST /v1/pairings` refuses a connected installation with safe `409 ALREADY_CONNECTED` to protect stale clients and races,
- QR-first transient local pairing UI that renders the Worker-returned `telegramUrl` without an external QR service; primary phone-scan action plus explicit Copy Link, Open on This Device, and Cancel actions,
- no automatic Telegram/deep-link opening; `vscode.env.openExternal()` is allowed only after the explicit Open on This Device click,
- transient QR/pairing material with no persistence or logging,
- no short human pairing-code fallback or notification relay in this slice (relay remains Slice E),
- lazy cleanup of expired/used pairing rows and deployment-defined installation retention,
- bounded pairing-status polling that closes/completes the UI on successful pairing,
- Connect Telegram and Disconnect Telegram commands,
- as the final eighth UX step, after the seven core pairing changes above are complete and validated, add one non-nagging local first-activation onboarding prompt: “Connect Telegram to receive Codex alerts on your phone.” with Connect Telegram and Not now actions. Showing it is local-only; Connect Telegram delegates to the existing QR-first Connect flow, and Not now does nothing remotely. Choosing either action sets a local `globalState` `onboardingShown` flag, which limits the prompt to at most once per local VS Code profile/extension UX state and is never connection state. Disconnect and installation reset/revocation do not automatically clear that flag or re-show onboarding; a clean extension install or fresh VS Code profile may naturally show it from new local state.

Tests:
- exact private-chat pairing,
- wrong/expired/consumed token rejection,
- group-chat rejection,
- webhook authentication,
- pairing replay resistance,
- fresh user connects by scanning the locally rendered QR and VS Code reports Connected,
- fresh first activation without a credential can show onboarding without any backend request, installation registration, connection-state read, pairing, QR, or Telegram launch,
- choosing either onboarding action marks the prompt shown; Not now creates no installation or backend/D1 record and the prompt does not repeat/nag in the same local profile/extension UX state,
- choosing onboarding Connect Telegram delegates into the existing QR-first Connect flow,
- onboarding `globalState` UX state is separate from authoritative D1 Telegram connection state,
- fresh activation without a credential performs zero backend requests and shows `OFF + ✕`,
- activation with an existing credential performs exactly one bounded connection lookup,
- activation lookup renders connected as `OFF + ✓`, disconnected as `OFF + ✕`, and backend/network failure as `OFF + ?` without conflating failure with disconnected,
- activation never calls `POST /v1/installations` or persists a local connected/disconnected boolean,
- revoked/invalid credential is cleared only after definitive authentication rejection; timeout/network/5xx leaves it intact with `OFF + ?`,
- activation never registers a replacement installation; the next explicit Connect Telegram action may lazily register and pair one,
- `OFF + ✓` enables alerts, `ON + ✓` disables alerts, `OFF + ✕` offers Connect Telegram/Cancel, and `OFF + ?` retries authoritative lookup; `ON + ✕` and `ON + ?` are not normal reachable states,
- Disconnect and installation reset/revocation do not clear `onboardingShown` or re-show onboarding on the next activation; a fresh local profile may show it,
- an already-connected installation causes `GET /v1/telegram-connection` to bypass pairing creation and pairing UI,
- `POST /v1/pairings` returns `409 ALREADY_CONNECTED` for a connected installation without leaking pairing or chat material,
- no automatic `vscode.env.openExternal()` call; Open on This Device calls it only after the explicit click,
- QR/deep-link token material is local/transient and never sent to an external QR service, persisted, or logged,
- connection persists across extension/VS Code reload, PC restart simulation, and Away Mode ON/OFF without another QR,
- once paired, normal restarts require neither onboarding nor QR; Disconnect, installation reset/revocation, or loss/replacement of the anonymous installation identity requires a new pairing only when the user explicitly runs Connect Telegram and never automatically re-shows onboarding,
- per-installation creation limits, connection-status-read limits, and reasonable polling frequency,
- successful Disconnect clears the D1 association, invalidates pending pairings, keeps the credential valid, and enables a later fresh pairing,
- successful Disconnect forces Away Mode OFF and renders `OFF + ✕`,
- failed, timed-out, or uncertain Disconnect forces Away Mode OFF and renders `OFF + ?` with a safe local error/retry message; a later authoritative GET may resolve it to `✓` or `✕`,
- installation reset/revocation remains distinct and requires re-registration after the identity is lost or replaced.

Review before Slice E.

## 8.5 Slice E — Test notification relay
Code:
- locally sanitized test message,
- authenticated notification endpoint,
- server-side chat lookup,
- bounded Telegram Bot API send,
- exactly one extension submission attempt with no automatic retry,
- no message-body persistence or intentional logging.

Tests:
- exactly one relay,
- Test Notification works while Away Mode is OFF,
- uncertain/lost response does not trigger a second notification POST,
- unpaired/revoked installation,
- backend/Telegram timeout and failure,
- no notification body written to D1 or logs.

Perform real official-bot/device acceptance before continuing to the local Codex event path.

Review before Slice F.

## 8.6 Slice F — Local bridge
Code:
- receiver,
- nonce,
- bridge,
- runtime file.

Tests:
- valid event,
- invalid nonce,
- extension not running,
- malformed JSON,
- duplicate event,
- no backend credential in bridge/runtime files.

Review before Slice G.

## 8.7 Slice G — Finished
Code:
- Stop normalization,
- session label,
- last-message truncation,
- local redaction/formatting before relay.

Tests:
- with/without session title,
- with/without last message,
- OFF mode,
- duplicate Stop event.

Manual IDE test.

Review before Slice H.

## 8.8 Slice H — Approval
Code:
- PermissionRequest normalization,
- command/reason extraction,
- local redaction/formatting before relay.

Tests:
- Bash,
- MCP,
- missing description,
- long command,
- sensitive value redaction.

Manual IDE test.

Review before Slice I.

## 8.9 Slice I — Failure
Implement only the strategy approved in Gate 2.

Tests must distinguish:
- terminal failure,
- recoverable tool failure,
- MCP failure,
- no detail,
- repeated failure events.

Manual IDE test.

---

# 9. Integration Testing

## 9.1 Happy path
Scenario:
1. turn alerts ON,
2. start Codex task,
3. leave VS Code untouched,
4. Codex finishes,
5. Telegram receives one Finished notification.

## 9.2 Approval path
Scenario:
1. alerts ON,
2. Codex requests approval,
3. Telegram receives one Approval notification,
4. command/action is visible.

## 9.3 Failure path
Scenario:
1. alerts ON,
2. trigger a verified failure mode,
3. Telegram receives one failure notification,
4. reason is visible if available.

## 9.4 OFF path
For every event:
- no Telegram message when OFF.

## 9.5 Multi-session path
Run at least two Codex sessions/workspaces.

Verify each notification contains enough context to identify the originating session/project.

---

# 10. Review Gate Before Packaging

Perform a manual code review against:

## 10.1 Correctness
- [ ] no duplicate notifications,
- [ ] notification POST is never automatically retried in V1,
- [ ] Test Notification sends once and ignores Away Mode,
- [ ] no recoverable error mislabeled as terminal failure,
- [ ] Away Mode always respected for real Codex event notifications,
- [ ] session label fallback works.

## 10.2 Security
- [ ] installation credential only in SecretStorage and only its hash in D1,
- [ ] pairing tokens are hashed, short-lived, and single-use,
- [ ] QR and pairing URL/token material stay transient, are rendered locally, and are never sent to an external QR service, persisted, or logged,
- [ ] Telegram opens only after the user explicitly chooses Open on This Device,
- [ ] Telegram bot/webhook secrets exist only as Worker secrets,
- [ ] webhook secret validation enabled,
- [ ] loopback receiver only,
- [ ] runtime nonce enabled,
- [ ] deterministic redaction and formatting occur locally,
- [ ] raw Codex events/tool payloads never reach the backend,
- [ ] notification bodies are not persisted or intentionally logged,
- [ ] per-endpoint body/rate limits and non-aggressive pairing polling are enforced,
- [ ] authenticated connection-state reads are scoped, bounded, and D1-authoritative; pairing creation safely rejects already-connected installations,
- [ ] activation never registers an installation or persists a local connected/disconnected boolean,
- [ ] a definitively invalid/revoked credential is cleared only as anonymous-identity recovery; timeout/network/5xx never clear it,
- [ ] no credentials in Git.

## 10.3 Reliability
- [ ] bridge failure never blocks Codex,
- [ ] backend/D1 failure never blocks Codex,
- [ ] Telegram failure never blocks Codex,
- [ ] no infinite retries,
- [ ] uncertain notification delivery is reported locally without retrying,
- [ ] revoked installation credentials fail authentication,
- [ ] expired/consumed pairings cannot be reused and stale rows are cleanable,
- [ ] Telegram association persists through extension/VS Code reload, PC restart, and Away Mode changes until Disconnect/reset,
- [ ] activation performs at most one bounded connection lookup for an existing credential; failure renders `?`, never `✕`,
- [ ] ON is reachable only with verified `✓` state; Disconnect always forces Away Mode OFF, renders `✕` only after definitive DELETE success, and otherwise renders `?`,
- [ ] no replacement installation is registered during activation; explicit Connect is the only replacement-identity recovery path,
- [ ] onboarding UX state is local-only, non-nagging, and never used as Telegram connection state,
- [ ] extension restart handled without unnecessary re-pairing or QR,
- [ ] stale runtime file handled.

## 10.4 UX
- [ ] enabling alerts takes one click after initial setup,
- [ ] disabling alerts takes one click,
- [ ] initial Telegram setup is QR-first; an already-connected installation immediately reports Connected without showing another QR,
- [ ] the status bar shows `✓`, `✕`, or `?` immediately after activation and offers the corresponding enable/disable/connect/retry action,
- [ ] first activation offers the local Connect Telegram/Not now prompt without launching or contacting Telegram until Connect is explicitly chosen,
- [ ] explicit Disconnect permits a later fresh QR pairing,
- [ ] messages are readable on a phone lock screen,
- [ ] setup takes only a few steps.

Do not package until this gate passes.

---

# 11. README and Open-Source Preparation

README must contain:

1. What problem it solves
2. 20-second usage explanation
3. Installation
4. Connect/disconnect the official Telegram bot
5. Codex hook setup/trust step
6. Away ON/OFF
7. Notification examples
8. Required privacy statement and security explanation
9. Known limitations
10. Development commands
11. License

Recommended license:
- MIT

Add:
- `CONTRIBUTING.md`
- basic issue templates if useful
- screenshots/GIF after the MVP works

The V1 privacy statement is a required release deliverable. It must truthfully explain:
- stored data: anonymous installation record, credential hash, Telegram chat ID, and pairing metadata while needed,
- excluded data: notification bodies/history, raw Codex events, raw tool payloads, phone number, email, Telegram username as identity, analytics, and telemetry,
- final sanitized notification text transits the Worker and Telegram,
- there is no end-to-end encryption claim,
- Telegram disconnect versus installation reset/revocation behavior.

Do not publish without this statement.

---

# 12. Package as `.vsix`

## 12.1 Package
Use the standard VS Code extension packaging workflow.

At this stage, provide and validate the appropriate VS Code extension packaging command, such as `npm run package`, using the standard VS Code packaging tooling.

Verify package does not include:
- secrets,
- test fixtures containing secrets,
- unnecessary build output,
- local runtime files.

## 12.2 Clean-machine test
Install `.vsix` into a clean VS Code profile.

Test:
- connect/disconnect Telegram,
- hook install,
- hook trust,
- Telegram,
- ON/OFF,
- Finished,
- Approval,
- Failure.

## 12.3 Gate 3 — Release Candidate
Release candidate is accepted only if the clean-profile test passes.

---

# 13. Publish to VS Code Marketplace

Prepare:
- publisher account,
- extension name,
- icon,
- description,
- repository URL,
- license,
- changelog,
- completed public privacy statement matching the deployed V1 data flow and retention behavior.

Publish V1 only after `.vsix` clean-profile validation.

---

# 14. Post-MVP Backlog

Only after V1 is stable:

## 14.1 Optional notification types
- token/context limit warning,
- rate limit warning,
- explicit “needs user input” separate from approval,
- long-running task threshold.

## 14.2 Better session labels
If a stable public route becomes available:
- use Codex user-facing thread name directly.

Never depend on undocumented UI scraping.

---

# 15. Definition of Done — V1

V1 is done when a fresh user can:

1. install the extension,
2. connect the official Telegram bot without BotFather, tokens, chat IDs, phone-number entry, or an account,
3. complete required Codex hook trust/setup,
4. click `🔔 Codex Alerts: ON`,
5. walk away,
6. receive:
   - Finished,
   - Approval + what needs approval,
   - supported Failure + reason,
   - MCP failure when detectable,
7. identify the originating session/project,
8. return to the PC,
9. click `🔕 Codex Alerts: OFF`,
10. receive no further phone alerts.

The final product must remain:
- free,
- open-source,
- local-first for Codex collection, normalization, redaction, and formatting,
- backed only by a minimal privacy-limited pairing and notification relay,
- free of user accounts, analytics, notification history, and remote control,
- simple enough to turn on/off in one click.

---

## Official references used while planning

- Codex Hooks: https://learn.chatgpt.com/docs/hooks
- Codex App Server: https://learn.chatgpt.com/docs/app-server
