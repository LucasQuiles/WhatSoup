# Bead: LOG-01 — Critical Path Logging Gaps

**BeadID:** LOG-01

**Status:** merged
**Type:** implement
**Runner:** —
**Dependencies:** none
**Scope:** `src/runtimes/agent/runtime.ts`, `src/runtimes/agent/session.ts`, `src/runtimes/agent/session-db.ts`
**Input:** Audit finding: 15+ critical operations with no logging
**Output:** Structured log entries at appropriate levels
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

The audit identified these critical gaps where important state transitions happen without logging:

### HIGH priority
1. **Control session crash** (~L1679): `log.warn('control session crashed')` — bare string, no exitCode/signal/sessionId/reportId
2. **handleResumeFailed inner catch** (~L2303): `.catch(() => {})` swallows all context recovery errors silently
3. **Workspace resource cleanup in shutdown** (~L1823-1828): completely silent — no count of stopped servers

### MEDIUM priority
4. **ensureSessionAndQueueSync** (~L2031-2101): creates sessions with no log entry
5. **Queue replacement on /new** (~L1134-1153): old queue abort and new queue creation silent
6. **backfillWorkspaceKeys** (session-db.ts:~165-196): no log for rows processed/mutated
7. **Spawn-per-turn spawnSession** (session.ts:~493-507): no log entry at all
8. **Events dropped on missing queue** (~L1425-1426): silent early return
9. **stderr from child** (session.ts:~688): logged at `debug` — invisible in production

### LOW priority
10. **Socket server stop()**: no log
11. **createOutboundQueue call sites**: no log at any of 10 call sites
12. **Runtime start/stop**: bare strings, no instance context
13. **Auto-respawn delay**: computed delay value not included in log
14. **STDIN timeout**: missing sessionId and pid

## Implementation Spec

Add structured log entries at each gap. Examples:

```typescript
// #1 — Control session crash
onCrash: (info) => {
  log.warn({ exitCode: info.exitCode, signal: info.signal, sessionId: info.sessionId,
    reportId: this.activeControlReportId }, 'control session crashed');
}

// #2 — handleResumeFailed catch
.catch((err) => {
  log.error({ err, mapKey }, 'context recovery failed after resume failure');
})

// #3 — Workspace shutdown
log.info({ count: stoppedCount }, 'workspace resources stopped in shutdown');

// #6 — backfillWorkspaceKeys
log.info({ processed: rows.length, ended: endedCount, updated: updatedCount }, 'backfilled workspace keys');

// #8 — Events dropped on missing queue
log.debug({ mapKey, eventType: event.type }, 'event dropped — no queue for chat');
```

## Maybe I'm Wrong

### Assumption: These logs are needed
**Validation:** Each gap was identified because an operational issue would be invisible in logs. The control session crash (#1) is the most impactful — without structured fields, you can't correlate the crash with the repair that was in progress.
**Verdict: All are justified.** Some are debug-level for high-frequency paths, info/warn for lifecycle events.

### Risk: Log volume increase
**Assessment:** Most additions are lifecycle events (once per session start/stop) or error paths (rare). The `debug` level additions (#8, #10, #11) are only visible when debug logging is enabled. No high-frequency hot-path logging added.
**Verdict: Minimal volume impact.**

## Required Tests

No new tests needed — this is a logging-only change. Verify via:
1. `npm run typecheck` — zero errors
2. `npx vitest run` — all tests pass (no behavioral change)

## Acceptance Criteria

- [ ] All 14 logging gaps addressed with structured log entries
- [ ] Log levels appropriate (warn for errors, info for lifecycle, debug for frequent events)
- [ ] All log entries include relevant context fields (chatJid, sessionId, mapKey, etc.)
- [ ] No sensitive data logged (message content, user data)
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
