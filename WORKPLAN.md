# WORKPLAN.md — Codex Away Alerts

> Working name: **Codex Away Alerts**  
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
  - `🔕 Codex Alerts: OFF`
  - `🔔 Codex Alerts: ON`
- One click toggles Away Mode.
- Commands:
  - `Codex Alerts: Enable`
  - `Codex Alerts: Disable`
  - `Codex Alerts: Toggle`
  - `Codex Alerts: Setup Telegram`
  - `Codex Alerts: Test Notification`

### 0.4 Explicit non-goals for V1
Do **not** add:
- remote control of Codex,
- replying to prompts from Telegram,
- approval from Telegram,
- web dashboard,
- user accounts,
- hosted backend,
- analytics,
- payment,
- WhatsApp,
- complex notification rules.

The product must remain a small local-first VS Code extension.

---

# 1. Environment and Repository Setup

## 1.1 Create repository
Create a public GitHub repository.

Suggested structure:

```text
codex-away-alerts/
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
- Prettier,
- a lightweight test runner compatible with VS Code extension testing.

## 1.3 Development commands
Provide at minimum:

```text
npm install
npm run compile
npm run watch
npm run lint
npm test
npm run package
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

- [ ] clean clone installs successfully,
- [ ] extension host starts,
- [ ] lint passes,
- [ ] empty test suite runs,
- [ ] status bar renders,
- [ ] project structure matches `ARCHITECTURE.md`.

---

# 2. External Integration and Event Feasibility

This phase must prove the external boundaries **before** the main implementation.

## 2.1 Telegram proof of concept
Create a Telegram bot with BotFather and verify:

```text
VS Code extension
        ↓
Telegram Bot API
        ↓
Phone
```

Requirements:
- bot token must never be committed,
- bot token must be stored using VS Code `SecretStorage`,
- chat ID must be stored securely as well,
- test notification must work from Extension Development Host.

### Acceptance
A `Codex Alerts: Test Notification` command produces a phone notification.

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
~/.codex/codex-away-alerts/bridge.cjs
```

The Codex hook definition should point at this stable path rather than a versioned VS Code Marketplace extension directory.

The bridge must:
- read hook JSON from stdin,
- discover the active extension loopback endpoint,
- send the event locally,
- exit quickly,
- never contain Telegram credentials,
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

Before application coding begins, create a short spike report containing:

| Event | Source | Verified in IDE? | Useful fields | Reliability |
|---|---|---:|---|---|
| Finished | Stop hook |  |  |  |
| Approval | PermissionRequest |  |  |  |
| Terminal Failed | App Server / equivalent |  |  |  |
| Tool Failed | PostToolUse |  |  |  |
| MCP Failed | App Server / PostToolUse |  |  |  |
| Session label | thread name / cwd / id |  |  |  |

Do not move to Phase 3 until:
- [ ] Telegram works,
- [ ] Finished source is proven,
- [ ] Approval source is proven,
- [ ] failure strategy is explicitly decided,
- [ ] session-label fallback is proven,
- [ ] hook install/trust workflow is understood.

---

# 3. Core Extension Implementation

## 3.1 Extension activation
Implement:
- command registration,
- status bar item,
- configuration loading,
- SecretStorage access,
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
- process supported Codex events,
- format notifications,
- send Telegram messages.

Persist the user's preferred state across normal VS Code restarts only if testing shows that behavior is intuitive. Otherwise default to OFF for safety.

Recommended V1 default:
- **OFF on first install**.

## 3.3 Status bar
Status bar must make state obvious.

```text
🔕 Codex Alerts: OFF
🔔 Codex Alerts: ON
```

Click action:
- toggle state.

Optional tooltip:
```text
Codex Away Alerts
Click to enable/disable phone notifications.
```

---

# 4. Telegram Configuration

## 4.1 Setup command
`Codex Alerts: Setup Telegram`

Collect:
1. Bot Token
2. Chat ID

Store both in `SecretStorage`.

Never write them to:
- `settings.json`,
- logs,
- hook files,
- bridge runtime files,
- repository files.

## 4.2 Test command
`Codex Alerts: Test Notification`

Example:

```text
🔔 Codex Away Alerts
Telegram notifications are working.
```

## 4.3 Error handling
Show a local VS Code error if:
- token is invalid,
- chat ID is invalid,
- Telegram is unreachable.

Do not expose the token in the error message.

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

Telegram token remains inside VS Code SecretStorage.

## 7.3 Runtime file
Suggested path:

```text
~/.codex/codex-away-alerts/runtime.json
```

Contents must never contain:
- Telegram bot token,
- Telegram chat ID.

Delete/stale-check on shutdown/startup.

## 7.4 Logs
Never log:
- Telegram token,
- full sensitive commands by default,
- secrets found in tool payloads.

Implement basic redaction for common secret patterns before notification/logging.

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

## 8.2 Slice B — Telegram
Code:
- SecretStorage,
- setup,
- sender,
- test notification.

Tests:
- success,
- unauthorized,
- bad chat ID,
- timeout,
- token redaction.

Review before Slice C.

## 8.3 Slice C — Local bridge
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
- duplicate event.

Review before Slice D.

## 8.4 Slice D — Finished
Code:
- Stop normalization,
- session label,
- last-message truncation,
- Telegram rendering.

Tests:
- with/without session title,
- with/without last message,
- OFF mode,
- duplicate Stop event.

Manual IDE test.

Review before Slice E.

## 8.5 Slice E — Approval
Code:
- PermissionRequest normalization,
- command/reason extraction.

Tests:
- Bash,
- MCP,
- missing description,
- long command,
- sensitive value redaction.

Manual IDE test.

Review before Slice F.

## 8.6 Slice F — Failure
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
- [ ] no recoverable error mislabeled as terminal failure,
- [ ] Away Mode always respected,
- [ ] session label fallback works.

## 10.2 Security
- [ ] token only in SecretStorage,
- [ ] loopback receiver only,
- [ ] runtime nonce enabled,
- [ ] secrets redacted,
- [ ] no credentials in Git.

## 10.3 Reliability
- [ ] bridge failure never blocks Codex,
- [ ] Telegram failure never blocks Codex,
- [ ] extension restart handled,
- [ ] stale runtime file handled.

## 10.4 UX
- [ ] enabling alerts takes one click after initial setup,
- [ ] disabling alerts takes one click,
- [ ] messages are readable on a phone lock screen,
- [ ] setup takes only a few steps.

Do not package until this gate passes.

---

# 11. README and Open-Source Preparation

README must contain:

1. What problem it solves
2. 20-second usage explanation
3. Installation
4. Telegram bot setup
5. Codex hook setup/trust step
6. Away ON/OFF
7. Notification examples
8. Privacy/security explanation
9. Known limitations
10. Development commands
11. License

Recommended license:
- MIT

Add:
- `CONTRIBUTING.md`
- basic issue templates if useful
- screenshots/GIF after the MVP works

---

# 12. Package as `.vsix`

## 12.1 Package
Use the standard VS Code extension packaging workflow.

Verify package does not include:
- secrets,
- test fixtures containing secrets,
- unnecessary build output,
- local runtime files.

## 12.2 Clean-machine test
Install `.vsix` into a clean VS Code profile.

Test:
- setup,
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
- privacy statement if needed.

Publish V1 only after `.vsix` clean-profile validation.

---

# 14. Post-MVP Backlog

Only after V1 is stable:

## 14.1 Optional notification types
- token/context limit warning,
- rate limit warning,
- explicit “needs user input” separate from approval,
- long-running task threshold.

## 14.2 Optional providers
- ntfy,
- Pushover,
- Discord webhook.

Telegram remains the only provider for MVP.

## 14.3 Better session labels
If a stable public route becomes available:
- use Codex user-facing thread name directly.

Never depend on undocumented UI scraping.

---

# 15. Definition of Done — V1

V1 is done when a fresh user can:

1. install the extension,
2. configure Telegram once,
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
- local-first,
- no hosted backend,
- simple enough to turn on/off in one click.

---

## Official references used while planning

- Codex Hooks: https://learn.chatgpt.com/docs/hooks
- Codex App Server: https://learn.chatgpt.com/docs/app-server
