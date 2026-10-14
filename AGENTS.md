# Agent instructions — Far Away from Codex

## Authority and scope

Read `ARCHITECTURE.md`, `WORKPLAN.md`, and `WORKPLAN_TODO.md` before planning or changing code. `ARCHITECTURE.md` captures the locked Phase A–E architecture; `WORKPLAN.md` defines milestone gates; only the active implementation slice in `WORKPLAN_TODO.md` authorizes product changes. Consult relevant `docs/diagrams/` and locked research decisions when a task touches their boundaries. If a research decision is unavailable, say so rather than inventing it.

This file governs agent behavior; it does **not** expand the active milestone's implementation scope. In particular, this agent-configuration change is separate from M0.10's production/test work. Do not opportunistically implement M0.10 or future milestones while editing agent instructions.

## Architecture guardrails

- Source coding-agent runtimes own source truth. The standalone Local Companion owns canonical Far Away local state, live attachment authority, source-resolution revalidation, and the single operational SQLite writer (WAL).
- VS Code is an optional, window-local UI/setup/bootstrap IPC client; its activation and disposal must not own Companion lifetime. Multiple local clients share one Companion.
- Local IPC uses Windows Named Pipe or Unix Domain Socket, not local TCP. Keep protocol versioning, handshake, client isolation, bounded failure, and cleanup intact.
- Cloud is an authenticated routing/control plane, not source authority. Telegram/iOS are bounded attention and response surfaces, not remote IDEs or generic agent command channels.
- Persistence is not proof of live authority after restart. Network/provider acknowledgement is not source resolution. Do not blindly retry an unknown source commit.
- Keep canonical domain, wire contracts, adapter SDK, and app dependencies separated. Preserve existing legacy Telegram pairing during migration unless the active slice explicitly replaces it.
- Never introduce generic remote prompting, command execution, or source-control endpoints.

## Execution discipline

1. Establish the exact active slice, its acceptance and negative gates, and a clean baseline before implementation. Do not infer that a future architectural invariant is already implemented.
2. Audit existing implementation and tests before adding coverage. Prefer small, reproducible tests and narrow fixes over duplication, broad refactors, new dependencies, or speculative features.
3. Test real production seams when feasible. For lifecycle/concurrency changes, prove negative cases, isolation, cleanup, and deterministic interleavings; do not treat mock-only tests as end-to-end evidence.
4. Run the relevant focused checks and root `npm run validate` when feasible; report exact commands, outcomes, skips, platform limitations, and unverified claims. Never report a gate as passed without running it.
5. Stop and ask when the request conflicts with locked architecture, active scope, security boundaries, or a documented stop condition.
6. Do not commit, push, open/merge PRs, or change branch protections without explicit authorization for that action. Never auto-merge.

## Delegation and independent review

Custom read-only reviewers are configured in `.codex/agents/`: `watchtower` (correctness/security/scope), `spider_sense` (races/lifecycle/authority), and `web_check` (test validity). Their presence does not mean they have run. For meaningful code changes, delegate independent reviews when supported and useful; for IPC, restart, concurrency, and lifecycle work, prioritize all three specialties. Give reviewers the precise diff/base, active slice, and relevant paths. Reviewers must not edit or auto-fix files.

Treat review reports as evidence to verify, not unquestionable verdicts. Resolve substantiated BLOCKERs and rerun affected tests/reviews; record NON-BLOCKING findings and deferred work without smuggling future scope into the current slice. Distinguish an agent being discoverable from its actually executing a review.
