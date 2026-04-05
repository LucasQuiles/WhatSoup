# Task: Transport Layer Hardening — Oracle Follow-ups + Quality Sweep

**ID:** transport-hardening-20260404
**Created:** 2026-04-04
**Status:** complete
**Profile:** BUILD
**Complexity:** complicated
**Cynefin:** complicated
**Parent task:** codex-transport-gaps-20260404 (completed)

## Objective
Address oracle council findings from the completed Codex transport task, add missing test coverage for budget enforcement paths, and harden the approval pre-filter. Then perform a quality sweep of the full transport layer with fitness checks.

## Success Criteria
1. Budget burst bypass mitigated — pre-send counting or pessimistic reservations
2. chatBurstLimit and dailySpendCapUsd test coverage added
3. Approval pre-filter resilient to JSON key reordering
4. Integration test for Codex turn lifecycle (tokenUsage + turn/completed coexistence)
5. Full fitness check across all changed files
6. All tests pass, build clean

## Source — Oracle Council Findings (from B10 review)
1. [HIGH] Budget burst bypass — concurrent sends all pass checkBudget before any response
2. [MEDIUM] Approval prefilter assumes JSON key ordering
3. [MEDIUM] Missing tests: chatBurstLimit, dailySpendCapUsd budget paths
4. [MEDIUM] No integration test for Codex turn lifecycle with dual events

## Phase Log
| Phase | Started | Status |
|-------|---------|--------|
| Normalize | 2026-04-04 | complete (clean continuation) |
| Frame | 2026-04-04 | complete (oracle findings are the spec) |
| Architect | 2026-04-04 | complete (6 beads) |
| Execute | 2026-04-04 | complete (5 commits, all verified) |
| Synthesize | 2026-04-04 | complete (oracle APPROVE) |
