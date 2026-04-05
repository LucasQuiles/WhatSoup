# Bead: p1-control-timeout
**Status:** merged
**Type:** implement
**Runner:** runner-p1-control-timeout
**Dependencies:** p0-zombie-sessions
**Scope:** src/runtimes/agent/runtime.ts (handleControlTurn, ~line 1124-1181), tests
**Input:** See problem description below
**Output:** Code fix + test proving timeout fires and escalates
**Sentinel notes:**
**Cynefin domain:** clear
**Security sensitive:** false
**Complexity source:** accidental
**Profile:** REPAIR
**Decision trace:** docs/sdlc/active/heal-reliability-fixes-20260401/beads/p1-control-timeout-decision-trace.md
**Deterministic checks:** npm run typecheck, npx vitest run --pool=forks
**Turbulence:** {L0: 0, L1: 0, L2: 0, L2.5: 0, L2.75: 0}
**Assumptions:** controlSession.shutdown() properly cleans up; dequeueNextReport available from heal.ts
**Confidence:**

## Problem

The control session spawned by `handleControlTurn` has no timeout. A validation test spawned a control session that ran 35+ minutes (1.6G memory, 138 tasks, 10min CPU) trying to "repair" a fake error.

## Fix

Add a hard timeout (15 minutes) to `handleControlTurn`. When it fires:
1. Log a warning with the reportId
2. Call `this.controlSession.shutdown()` to kill the runaway session
3. Clear `this.activeControlReportId`
4. Call `dequeueNextReport()` to process any queued reports (import from heal.ts if needed)

Store the timeout handle on the runtime instance so it can be cleared when the control session completes normally (in the result event handler).
