# Bead: ERR-04 — Exception Safety in Shutdown Cleanup

**BeadID:** ERR-04

**Status:** pending
**Type:** implement
**Runner:** —
**Dependencies:** none
**Scope:** `src/runtimes/agent/runtime.ts`
**Input:** Audit finding: shutdown cleanup not try/catch'd — first failure skips remaining resources
**Output:** Each cleanup step wrapped in try/catch so failures don't cascade
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

`AgentRuntime.shutdown()` has several cleanup steps that are not wrapped in try/catch:

1. **~L1790** — `await this.session.shutdown()` (single/shared mode) — if this throws, queue shutdown, socket server stop, and workspace cleanup are all skipped.
2. **~L1824-1827** — Workspace resource cleanup loop — if the first `socketServer.stop()` throws, remaining workspaces are not cleaned up.
3. **~L1819** — `this.globalSocketServer.stop()` — not wrapped.

## Implementation Spec

Wrap each cleanup phase in individual try/catch blocks:

```typescript
async shutdown(): Promise<void> {
  log.info({ instanceName: this.instanceName }, 'AgentRuntime shutting down');
  const startedAt = Date.now();

  // Phase 1: Cancel timers
  if (this.workspaceSweepTimer) { clearInterval(this.workspaceSweepTimer); this.workspaceSweepTimer = null; }
  if (this.queueSweepTimer) { clearInterval(this.queueSweepTimer); this.queueSweepTimer = null; }
  if (this.controlSessionTimeout) { clearTimeout(this.controlSessionTimeout); this.controlSessionTimeout = null; }
  for (const timer of this.pendingRespawnTimers) clearTimeout(timer);
  this.pendingRespawnTimers.clear();

  // Phase 2: Shut down sessions (each individually wrapped)
  if (this.sessionScope === 'per_chat') {
    for (const [key, session] of this.chatSessions) {
      try { session.shutdown(); } catch (err) { log.warn({ err, key }, 'session shutdown failed'); }
    }
    for (const [key, queue] of this.chatQueues) {
      try { queue.shutdown(); } catch (err) { log.warn({ err, key }, 'queue shutdown failed'); }
    }
  } else {
    try { this.session?.shutdown(); } catch (err) { log.warn({ err }, 'session shutdown failed'); }
    try { this.queue?.shutdown(); } catch (err) { log.warn({ err }, 'queue shutdown failed'); }
  }

  // Phase 3: Stop socket servers and media bridges (each individually wrapped)
  try { this.globalSocketServer?.stop(); } catch (err) { log.warn({ err }, 'global socket server stop failed'); }
  let stoppedCount = 0;
  for (const [key, res] of this.workspaceResources) {
    try { if (res.socketServer) res.socketServer.stop(); } catch (err) { log.warn({ err, key }, 'workspace socket stop failed'); }
    try { if (res.mediaBridge) res.mediaBridge(); } catch (err) { log.warn({ err, key }, 'workspace media bridge stop failed'); }
    stoppedCount++;
  }
  log.info({ stoppedCount }, 'workspace resources stopped');

  // Phase 4: Clear all maps
  this.chatSessions.clear();
  this.chatQueues.clear();
  this.workspaceResources.clear();
  // ... per-chat maps ...

  log.info({ durationMs: Date.now() - startedAt }, 'AgentRuntime shut down');
}
```

## Maybe I'm Wrong

### Assumption: `session.shutdown()` can throw
**Validation:** `shutdown()` calls `updateSessionStatus` (DB write), `durability.upsertSessionCheckpoint`, and `child.kill()`. DB writes can throw on SQLITE_BUSY. `child.kill()` can throw if PID is invalid. The `kill` is guarded by `if (this.child)` but a race is possible.
**Verdict: Confirmed.** DB write failure is the most likely throw path.

## Required Tests

### Test 1: First session shutdown failure doesn't prevent remaining cleanup
```
GIVEN 3 sessions in chatSessions, first one's shutdown() throws
WHEN AgentRuntime.shutdown() is called
THEN all 3 sessions had shutdown() called (not just the first)
AND all workspace resources were stopped
AND all maps were cleared
```

## Verification

1. `npm run typecheck` — zero errors
2. `npx vitest run` — all tests pass

## Acceptance Criteria

- [ ] Every cleanup step in shutdown() wrapped in individual try/catch
- [ ] Failures logged at warn level with context
- [ ] Shutdown always reaches map cleanup regardless of individual failures
- [ ] Shutdown duration logged
- [ ] 1 new test passes
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
