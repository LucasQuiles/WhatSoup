# Bead: H01
**Status:** pending
**Type:** implement
**Runner:** unassigned
**Dependencies:** none
**Scope:** `src/runtimes/agent/providers/budget.ts`, `src/runtimes/agent/session.ts`, `tests/runtimes/agent/session-budget.test.ts`
**Cynefin domain:** complicated
**Security sensitive:** false
**Complexity source:** essential
**Profile:** BUILD
**Decision trace:** /home/q/LAB/WhatSoup/docs/sdlc/active/transport-hardening-20260404/beads/H01-decision-trace.md
**Deterministic checks:** vitest run tests/runtimes/agent/session-budget.test.ts
**Turbulence:** {L0: 0, L1: 0, L2: 0, L2.5: 0, L2.75: 0}

## Objective
Fix budget burst bypass. Currently `checkBudget()` checks the sliding window BEFORE send, but `recordUsage()` only fires AFTER response. Concurrent sends all pass the check before any response arrives.

## Approach
Add pessimistic counting in `checkBudget()`:
1. Add `pendingRequests: number` field to ProviderBudget
2. Increment `pendingRequests` inside `checkBudget()` when returning `{ allowed: true }`
3. Include `pendingRequests` in the rate check: `requestWindow.length + pendingRequests >= limit`
4. Decrement `pendingRequests` in `recordUsage()` (response arrived)
5. Add a `cancelPending()` for error/timeout paths where response never arrives
6. Test: fire 3 concurrent sendTurns with limit=2, verify 3rd is rejected immediately

## Estimated effort
30 minutes
