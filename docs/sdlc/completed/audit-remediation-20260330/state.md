# Task: Audit Remediation

**ID:** audit-remediation-20260330
**Created:** 2026-03-30T15:00:00Z
**Status:** in-progress
**Phase:** 4-execute
**Profile:** REPAIR
**Complexity:** complicated
**Audit:** `docs/audit-2026-03-30.md`

## Objective

Fix 28 issues found in the WhatSoup code audit (6 P0, 7 P1, 15 P2) before cutover. P0s block cutover. P1s block production load. P2s are production hygiene.

## Success Criteria

1. All 6 P0 issues verified fixed with tests
2. All 7 P1 issues verified fixed
3. Full test suite green (961+ tests)
4. Integration tests for scope enforcement pass
5. E2E smoke test boots without QR prompt, processes messages

## Bead Manifest

| Bead | Type | Priority | Depends | Scope | Status |
|------|------|----------|---------|-------|--------|
| B01-sigterm | implement | P0 | — | main.ts, socket-server.ts | running |
| B02-perchat-race | implement | P0 | — | runtime.ts | running |
| B03-enrichment-visibility | implement | P0 | — | poller.ts | running |
| B04-spawn-error | implement | P0 | — | session.ts | running |
| B05-conversation-key | implement | P0 | — | runtime.ts, conversation-key.ts | running |
| B06-null-session | implement | P0 | — | runtime.ts | running |
| B07-mcp-logging | implement | P1 | — | registry.ts | running |
| B08-socket-catch | implement | P1 | — | socket-server.ts | running |
| B09-nan-config | implement | P1 | — | config.ts | running |
| B10-sock-abstraction | implement | P1 | — | connection.ts, tools/*.ts | running |
| B11-empty-jid | implement | P1 | — | conversation-key.ts | running |
| B12-integration-tests | implement | — | B01-B11 | tests/integration/ | pending |
| B13-e2e-validation | verify | — | B12 | deploy/ | pending |

### Execution Plan

**Wave 1 (parallel, running):** B01-B11 — dispatched as two parallel runners
**Wave 2 (serial):** B12 — integration tests after all fixes land
**Wave 3 (serial):** B13 — E2E validation

## Phase Log

| Phase | Status | Notes |
|-------|--------|-------|
| 0-normalize | complete | 961/961 tests, audit received |
| 1-frame | skipped | Audit defines all issues with file paths and fixes |
| 2-scout | skipped | Audit is the scout output |
| 3-architect | skipped | Fixes are prescribed in audit |
| 4-execute | in-progress | Wave 1 running (2 parallel runners for P0+P1) |
