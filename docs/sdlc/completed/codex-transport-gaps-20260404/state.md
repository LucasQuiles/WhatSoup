# Task: Codex Transport Layer — Gap Remediation

**ID:** codex-transport-gaps-20260404
**Created:** 2026-04-04
**Status:** complete
**Profile:** BUILD
**Complexity:** complicated
**Cynefin:** complicated
**Parent task:** multi-provider-runtime-2026-0404 (related, not blocking)

## Objective
Fix critical gaps in the Codex CLI transport layer that prevent production parity with Claude CLI. The multi-provider runtime is architecturally complete (providers/, parsers, session dispatch), but the Codex path has correctness issues (silent token loss, wrong identity), reliability gaps (no crash resume, busy-wait polling), and unused infrastructure (ProviderBudget dead code).

## Success Criteria
1. Codex token tracking works — `thread/tokenUsage/updated` events flow to DB
2. System prompt is provider-aware — no hardcoded "Claude Code agent"
3. OpenCode parser is concurrency-safe — no module-level mutable state
4. Codex session resume works on crash — thread ID passed to `thread/start`
5. ProviderBudget is wired into SessionManager — rate limiting + spend caps active
6. Busy-wait polling replaced with event-driven ready signals
7. All existing tests pass (3116+), new tests for each fix
8. Zero regressions in Claude CLI path

## Scope
- `src/runtimes/agent/providers/codex-parser.ts` — token tracking
- `src/runtimes/agent/session.ts` — system prompt, busy-wait, resume, budget wiring
- `src/runtimes/agent/providers/opencode-parser.ts` — concurrency fix
- `src/runtimes/agent/providers/budget.ts` — wire existing dead code
- `src/runtimes/agent/runtime.ts` — budget integration point
- Tests for all changes

## Phase Log
| Phase | Started | Status |
|-------|---------|--------|
| Normalize | 2026-04-04 | complete (existing SDLC state detected, clean working tree) |
| Frame | 2026-04-04 | complete (findings from deep code-explorer investigation) |
| Scout | 2026-04-04 | complete (full architecture review with feature parity table) |
| Architect | 2026-04-04 | complete (12 beads + B04a oracle remediation) |
| Execute | 2026-04-04 | complete (14 beads, 10 commits, all verified) |
| Synthesize | 2026-04-04 | complete (oracle APPROVE_WITH_NOTES, critical remediation applied) |
