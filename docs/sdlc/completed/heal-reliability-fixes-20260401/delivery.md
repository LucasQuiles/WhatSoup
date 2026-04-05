# Delivery: heal-reliability-fixes-20260401

## Summary

Three reliability fixes for the self-healing agent loop, addressing issues P0, P1, and P4 from the 2026-03-31 session report.

## Changes

### P0: Zombie Session Accumulation (ESSENTIAL)
**File:** `src/runtimes/agent/runtime.ts` (sendTurnToSession, line 891-894)
**Fix:** Added `await session.shutdown()` before `await session.spawnSession()` when the session is inactive. Without this, `spawnSession()` overwrites `this.child`, orphaning the old process — its exit handler is skipped, its DB row stays 'active', and its watchdog timers keep firing. The fix mirrors the `handleNew()` pattern already in `session.ts`.
**Test:** `tests/runtimes/agent/zombie-sessions.test.ts` (2 tests) — verifies shutdown-before-spawn call order.

### P1: Control Session Timeout (ACCIDENTAL)
**File:** `src/runtimes/agent/runtime.ts` (handleControlTurn, lines 1197-1213)
**Fix:** Added a 15-minute hard timeout (`CONTROL_SESSION_TIMEOUT_MS`) that fires when the control session runs too long. On timeout: logs warning, shuts down the control session, clears the repair slot, and dequeues the next report. Timeout is cleared on normal completion (emit_heal_result handler), crash (onCrash handler), and send failure (catch block).
**Test:** `tests/runtimes/agent/control-timeout.test.ts` (5 tests) — verifies timeout set/clear lifecycle and force-escalation behavior.

### P4: Degradation Timer Wiring (ACCIDENTAL)
**File:** `src/main.ts` (lines 513-522)
**Fix:** Added 60-second `setInterval` calling `checkDegradationSignals()` from `heal.ts`. Guarded by `config.controlPeers.size > 0` (only runs on instances with heal peers). Uses duck-typing to extract `currentControlReportId` from AgentRuntime when available. Interval cleared in shutdown cleanup.

## Verification

- **Typecheck:** 0 new errors (3 pre-existing `setDurability` errors unchanged)
- **Tests:** 2266/2266 passing (7 new: 2 zombie-sessions + 5 control-timeout)
- **Test files:** 102

## Remaining Open Issues

- **P2 (Control Session Workspace Isolation):** Not addressed. Q's repair protocol uses a git worktree but the end-to-end flow hasn't been validated.
- **P3 (Verify Type 1 End-to-End):** Wired but never triggered in production. First real Loops crash will be the definitive test.
- **Transient MCP denials:** 9 denials in first 15s of fresh sessions remain unexplained. Structured denial logging is in place.

## Uncertainty

The P0 fix assumes `session.shutdown()` is always safe to call on an already-inactive session. The `shutdown` method guards on `this.child !== null`, so this should be a no-op for truly dead sessions. However, there may be edge cases where the session's `active` flag is false but the process is still in its exit handler — the `shutdown` call would then race with the exit handler. This is the same race that exists in `handleNew()`, so it's not a new risk, but it's worth noting.
