# Bead: ERR-01 — Control Session Slot Permanently Locked on mkdirSync Failure

**BeadID:** ERR-01

**Status:** verified
**Type:** implement
**Runner:** —
**Dependencies:** none
**Scope:** `src/runtimes/agent/runtime.ts`
**Input:** Audit finding: `mkdirSync` outside try/catch in `handleControlTurn` permanently locks control slot
**Output:** Exception-safe control session provisioning with slot release on failure
**Cynefin domain:** clear
**Security sensitive:** false
**Profile:** REPAIR
**Deterministic checks:** `npm run typecheck`, `npx vitest run`
**Turbulence:** L0: 0, L1: 0, L2: 0
**Loop depth:** L0 + L1
**Status:** pending → running → submitted → verified → proven → hardened → reliability-proven → merged
**Current loop:** —
**Bridge sync:** false

## Root Cause

`handleControlTurn()` at runtime.ts:~1664 sets `this.activeControlReportId = reportId` before calling `mkdirSync(controlCwd, { recursive: true, mode: 0o700 })` at ~L1670. The `mkdirSync` is outside the try/catch block that only wraps `session.sendTurn()` at ~L1704. If `mkdirSync` throws (EACCES, ENOSPC, EROFS), the exception propagates out of `handleControlTurn()`, which is called via `void this.handleControlTurn(...)` — becoming an unhandled rejection. The `activeControlReportId` is set but never cleared. The single-flight gate at ~L1656 (`if (this.activeControlReportId)`) rejects all subsequent repair attempts permanently until restart.

Additionally, `void this.handleControlTurn(...)` at ~L1040 and ~L1743 discards the returned promise entirely, so ANY throw from `handleControlTurn` — not just `mkdirSync` — becomes an unhandled promise rejection.

## Implementation Spec

### 1. Wrap entire `handleControlTurn` body in try/catch

```typescript
private async handleControlTurn(reportId: string, contextJson: string): Promise<void> {
  try {
    this.activeControlReportId = reportId;
    // ... existing body (mkdirSync, session creation, sendTurn) ...
  } catch (err) {
    log.error({ err, reportId }, 'control session failed to start — releasing slot');
    this.activeControlReportId = null;
    // Clean up partial state
    if (this.controlSession) {
      try { this.controlSession.shutdown(); } catch { /* best effort */ }
      this.controlSession = null;
    }
    this.chatSessions.delete('control@heal.internal');
    this.chatQueues.delete('control@heal.internal');
  }
}
```

### 2. Add `.catch()` to call sites

```typescript
// At ~L1040 and ~L1743:
void this.handleControlTurn(next.report_id, JSON.stringify({...})).catch((err) => {
  log.error({ err, reportId: next.report_id }, 'unhandled error in handleControlTurn');
});
```

## Maybe I'm Wrong

### Assumption: `mkdirSync` can actually fail in production
**Validation:** The control CWD is `<homedir>/.whatsoup/heal/<reportId>`. If the parent `.whatsoup/heal/` doesn't exist, `{ recursive: true }` creates it. Failures require: disk full, filesystem read-only, or permission denied on the home directory. These are rare but real operational failures.
**Verdict: Confirmed possible.** Disk full is the most likely trigger.

### Assumption: The slot stays locked permanently
**Validation:** Search for all assignments to `activeControlReportId`. Set at ~L1664, cleared at: `emit_heal_result` handler (~L1028), control timeout callback (~L1717), and on crash only if the crash callback clears it. The crash callback at ~L1679 does NOT clear it.
**Verdict: Confirmed.** Once set, only the heal-result handler and timeout clear it. If the session never starts, neither fires.

## Required Tests

### Test 1: Control slot released on provisioning failure
```
GIVEN handleControlTurn is called with a reportId
AND mkdirSync will throw ENOSPC
WHEN handleControlTurn executes
THEN activeControlReportId === null after the call
AND a subsequent handleControlTurn call is NOT rejected by the single-flight gate
```
**Durable/Repeatable:** Mock mkdirSync to throw. **Observable:** Check activeControlReportId. **Provable:** null check.

### Test 2: Partial control session state cleaned up on failure
```
GIVEN handleControlTurn throws after creating a session but before sendTurn
WHEN the catch block runs
THEN chatSessions.has('control@heal.internal') === false
AND controlSession === null
```

## Verification

1. `npm run typecheck` — zero errors
2. `npx vitest run` — all tests pass
3. 2 new tests as specified

## Acceptance Criteria

- [ ] Entire `handleControlTurn` body wrapped in try/catch
- [ ] Catch block clears `activeControlReportId` and partial session state
- [ ] Call sites have `.catch()` as defense-in-depth
- [ ] 2 new tests pass
- [ ] Typecheck + all existing tests pass

## Loop Protocol

### L0 — Implementation
- Worker implements the spec in an isolated clone
- Must produce `bead-output.md` with `<!-- BEAD_OUTPUT_COMPLETE -->` sentinel
- Must pass: `npm run typecheck && npx vitest run`
- Bridge advances: `running` → `submitted`

### L1 — Sentinel Review  
- Different-model agent reviews the implementation
- Validates: code matches spec, tests are durable/repeatable/observable/provable, no regressions
- Bridge advances: `submitted` → `verified`

### L2 — Oracle Consensus
- Third-model agent validates architectural correctness
- Confirms: no unintended side effects, integration safety, edge cases covered
- Bridge advances: `verified` → `proven`

### Output Requirements
- `bead-output.md` must exist in clone root
- Must contain `<!-- BEAD_OUTPUT_COMPLETE -->` sentinel
- Must be >100 bytes
- Must include: commit hash, test results, files changed
