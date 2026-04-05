# Bead: H02
**Status:** pending
**Type:** implement
**Runner:** unassigned
**Dependencies:** [H01]
**Scope:** `tests/runtimes/agent/session-budget.test.ts`
**Cynefin domain:** clear
**Security sensitive:** false
**Complexity source:** accidental
**Profile:** BUILD
**Decision trace:** /home/q/LAB/WhatSoup/docs/sdlc/active/transport-hardening-20260404/beads/H02-decision-trace.md
**Deterministic checks:** vitest run tests/runtimes/agent/session-budget.test.ts
**Turbulence:** {L0: 0, L1: 0, L2: 0, L2.5: 0, L2.75: 0}

## Objective
Add missing test coverage for chatBurstLimit and dailySpendCapUsd budget paths. Oracle mutation analysis showed these paths survive any mutation undetected.

## Tests to add
1. `chatBurstLimit`: configure limit=2 per chat, send 3 turns from same chatId, verify 3rd rejected. Send from different chatId, verify it's allowed.
2. `dailySpendCapUsd`: configure cap=$0.01, record enough tokens to exceed cap, verify next turn rejected. Verify `resetDaily()` clears the cap.
3. Verify `getSnapshot()` returns correct `isThrottled` and `throttleReason` for each limit type.

## Estimated effort
20 minutes
