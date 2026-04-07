# Bead: LEAK-08 — SIGTERM Grace Period with SIGKILL Fallback

**BeadID:** LEAK-08

**Status:** merged
**Type:** implement
**Runner:** —
**Dependencies:** none
**Scope:** `src/runtimes/agent/session.ts`
**Input:** Audit finding: `shutdown()` sends SIGTERM then immediately nulls `this.child`
**Output:** Graceful SIGTERM → wait → SIGKILL escalation
**Cynefin domain:** complicated
**Security sensitive:** false
**Profile:** REPAIR
**Deterministic checks:** `npm run typecheck`, `npx vitest run`
**Turbulence:** L0: 0, L1: 0, L2: 1 (behavioral change — shutdown waits for child exit)
**Loop depth:** L0 + L1 + L2 + L2.5
**Status:** pending → running → submitted → verified → proven → hardened → reliability-proven → merged
**Current loop:** —
**Bridge sync:** false

## Root Cause

`SessionManager.shutdown()` at L1161:

```typescript
this.child.kill('SIGTERM');
this.child = null;
```

Problems:
1. No wait for the child to exit — if it ignores SIGTERM, it becomes orphaned
2. `this.child = null` immediately — the exit handler (L696: `if (this.child !== child) return`) will silently ignore the exit event, so the DB row is never updated
3. For spawn-per-turn providers at L895-898, same pattern: `this.child.kill('SIGTERM'); this.child = null;`

## Implementation Spec

### 1. Add a SIGKILL escalation timer

```typescript
private static readonly SHUTDOWN_GRACE_MS = 5_000; // 5 seconds
private shutdownKillTimer: ReturnType<typeof setTimeout> | null = null;
```

### 2. Modify `shutdown()` to wait for exit with SIGKILL fallback

```typescript
shutdown(suspend = true): void {
  if (!this.child) return;

  this.clearTurnWatchdog();
  this.active = false;

  // Update DB status
  if (this.dbRowId != null) {
    updateSessionStatus(this.db, this.dbRowId, suspend ? 'suspended' : 'ended');
  }
  // Update durability checkpoint
  if (this.durability) {
    this.durability.upsertSessionCheckpoint(this.conversationKey, {
      sessionStatus: suspend ? 'suspended' : 'ended',
    });
  }

  const child = this.child;
  child.kill('SIGTERM');

  // Set up SIGKILL fallback
  this.shutdownKillTimer = setTimeout(() => {
    this.shutdownKillTimer = null;
    try {
      child.kill('SIGKILL');
      log.warn({ pid: child.pid }, 'child did not exit after SIGTERM, sent SIGKILL');
    } catch {
      // Process already exited
    }
  }, SessionManager.SHUTDOWN_GRACE_MS);

  // Clear references (the exit handler will see this.child !== child and skip)
  this.child = null;
  this.sessionId = null;
  this.dbRowId = null;
  // ... rest of existing cleanup ...
}
```

### 3. Cancel kill timer if child exits naturally

In the exit handler (~L692), before the `if (this.child !== child) return` guard:

```typescript
// Always cancel the kill timer for this child, even if superseded
if (this.shutdownKillTimer) {
  clearTimeout(this.shutdownKillTimer);
  this.shutdownKillTimer = null;
}
```

Wait — this won't work because the exit handler checks `this.child !== child` and returns early. The kill timer needs to be cancelled even in that case. Move the timer cancellation BEFORE the guard:

```typescript
child.on('exit', (code, signal) => {
  // Cancel any pending SIGKILL timer for this child
  if (this.shutdownKillTimer) {
    clearTimeout(this.shutdownKillTimer);
    this.shutdownKillTimer = null;
  }

  if (this.child !== child) return; // superseded
  // ... rest of existing handler ...
});
```

### 4. Also cancel in `spawnSession()` guard

If `spawnSession()` is called while a kill timer is pending (e.g., crash respawn during shutdown grace), cancel it:

```typescript
// At start of spawnSession():
if (this.shutdownKillTimer) {
  clearTimeout(this.shutdownKillTimer);
  this.shutdownKillTimer = null;
}
```

## Maybe I'm Wrong

### Assumption: Children can ignore SIGTERM
**Validation needed:** Can Claude Code CLI / Codex CLI / Gemini CLI ignore SIGTERM?
- Claude Code is a Node.js process. Node.js processes handle SIGTERM by default (exit immediately). However, if Claude Code has a SIGTERM handler that does cleanup (saving state, flushing), it may take time to exit.
- Claude Code's `--resume` feature suggests it does graceful shutdown on SIGTERM to persist session state.
- **Verdict: Children likely handle SIGTERM but may take several seconds.** A 5-second grace period is appropriate.

### Assumption: Orphaned children are a real problem
**Validation needed:** Does the existing stale-session reaper (L812-839) catch these?
- Yes — `classifyActiveSessions()` on next startup detects stale PIDs and sends SIGTERM + marks orphaned. So orphaned children ARE cleaned up, but only on the next process restart.
- Between restarts, orphaned children consume memory and CPU. For a long-running instance that restarts sessions frequently (high crash rate), this compounds.
- **Verdict: The reaper is a safety net, not a fix.** Proper shutdown should not rely on next-startup cleanup.

### Assumption: The 5-second wait doesn't block shutdown
**Validation needed:** Does `shutdown()` need to be synchronous?
- `shutdown()` is called from `handleNew()`, from runtime `shutdown()`, and from `sendTurnToSession` before respawn. In all cases, the caller continues after `shutdown()` returns — they don't wait for the child to actually exit.
- The fire-and-forget SIGKILL timer is fine here — it's a safety net, not a synchronization point. The caller doesn't need to wait for the child to die.
- **Verdict: Safe.** The timer-based approach doesn't change the synchronous behavior of `shutdown()`.

### Risk: SIGKILL on a Claude Code process mid-save could corrupt session state
**Assessment:** SIGKILL is sent only after 5 seconds of SIGTERM being ignored. If Claude Code is mid-save after 5 seconds, something is wrong. SIGKILL is the correct escalation. The session DB will show `suspended` status (set before SIGTERM), so resume will be attempted on next startup.
- **Verdict: Acceptable risk.** SIGKILL after 5s grace is standard practice.

## Verification

1. `npm run typecheck` — zero errors
2. `npx vitest run` — all tests pass
3. Manual: trigger a session shutdown, verify child exits within 5 seconds (check `ps aux | grep claude`)

## Acceptance Criteria

- [ ] `shutdown()` sends SIGTERM and schedules a 5s SIGKILL fallback
- [ ] Exit handler cancels the SIGKILL timer (even for superseded children)
- [ ] `spawnSession()` cancels any pending SIGKILL timer
- [ ] Kill timer is a private field, properly typed
- [ ] Typecheck passes
- [ ] All tests pass

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
