# Bead: B06
**Status:** pending
**Type:** implement
**Runner:** unassigned
**Dependencies:** [B01]
**Scope:** `src/runtimes/agent/session.ts`, `src/runtimes/agent/runtime.ts`, `src/runtimes/agent/providers/budget.ts`, `tests/runtimes/agent/budget.test.ts`
**Cynefin domain:** complicated
**Security sensitive:** false
**Complexity source:** essential
**Profile:** BUILD
**Decision trace:** beads/B06-decision-trace.md
**Deterministic checks:** vitest run tests/runtimes/agent/
**Turbulence:** {L0: 0, L1: 0, L2: 0, L2.5: 0, L2.75: 0}

## Objective
Wire the existing ProviderBudget (177 lines of working dead code in budget.ts) into the hot path. This gives rate limiting, daily spend caps, and per-chat burst protection — all already coded but never instantiated.

## Approach
1. In `SessionManager` constructor (or `AgentRuntime`), instantiate `ProviderBudget` with config from `providerConfig.budget` (add to config schema if needed)
2. Before each `sendTurn()`, call `budget.checkBudget(chatId)` — if not allowed, emit a result event with the throttle reason and skip the turn
3. On each `result` event with token counts, call `budget.recordUsage({ input, output }, chatId)`
4. Default budget config: no limits (backward compatible). User configures via instance config.
5. Add `budget` section to instance config schema in `instance-loader.ts`
6. Test: verify budget check gates sendTurn, verify recordUsage accumulates

## Estimated effort
45 minutes
