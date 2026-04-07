# Bead: LEAK-07 — Track and Cancel Auto-Respawn Timers

**BeadID:** LEAK-07

**Status:** merged
**Type:** implement
**Runner:** —
**Dependencies:** none
**Scope:** `src/runtimes/agent/runtime.ts`
**Input:** Audit finding: auto-respawn `setTimeout` at ~L2146 is fire-and-forget
**Output:** Respawn timers are tracked and cancelled on shutdown
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

`handlePerChatCrash()` schedules auto-respawn via:

```typescript
setTimeout(() => {
  // ... respawn logic ...
}, jitteredDelay(...));
```

This timer handle is not stored. If `shutdown()` runs while respawn timers are pending, they fire against a partially torn-down runtime — calling `session.spawnSession()` on a shutdown session, accessing cleared maps, etc.

## Implementation Spec

### 1. Add a Set to track pending respawn timers

```typescript
private pendingRespawnTimers: Set<ReturnType<typeof setTimeout>> = new Set();
```

### 2. Track the timer in `handlePerChatCrash`

```typescript
// EXISTING (~L2146):
setTimeout(() => {
  // ... respawn logic ...
}, jitteredDelay(...));

// REPLACE WITH:
const timer = setTimeout(() => {
  this.pendingRespawnTimers.delete(timer);
  // ... existing respawn logic ...
}, jitteredDelay(...));
this.pendingRespawnTimers.add(timer);
```

### 3. Cancel all pending timers in `shutdown()`

```typescript
// In shutdown(), before session cleanup:
for (const timer of this.pendingRespawnTimers) {
  clearTimeout(timer);
}
this.pendingRespawnTimers.clear();
```

## Maybe I'm Wrong

### Assumption: The respawn timer can fire after shutdown
**Validation needed:** Check if `shutdown()` awaits all async operations or if timers can outlive it.
- `shutdown()` in `runtime.ts` is synchronous in its timer/map cleanup. It calls `session.shutdown()` for each session, clears maps, stops servers. But it does NOT cancel any pending `setTimeout`s outside its own scope.
- Node.js event loop: a pending `setTimeout` callback runs in a future tick, after `shutdown()` returns. If the process doesn't exit immediately (e.g., other async work keeps the loop alive), the callback fires.
- **Verdict: Confirmed.** The timer can fire after shutdown if the process is still alive (which it is — shutdown is called on SIGTERM, and there may be async cleanup pending).

### Assumption: Firing after shutdown is harmful
**Validation needed:** What does the respawn callback actually do?
- It calls `this.chatSessions.get(mapKey)` — map has been `.clear()`'d → returns `undefined` → likely null-ref or silent no-op depending on the guard.
- It calls `session.spawnSession()` — session has been `.shutdown()`'d → `this.active` is false, but the guard is `if (this.active && this.child !== null) return` — since active is false AND child is null, the guard does NOT return, and `spawnSession` proceeds to spawn a new child process after the runtime is shutting down.
- **Verdict: Confirmed harmful.** A zombie child process is spawned during/after shutdown.

### Risk: Timer self-cleanup race
**Assessment:** The `this.pendingRespawnTimers.delete(timer)` at the start of the callback runs synchronously before any async work. If `shutdown()` runs concurrently (impossible in single-threaded JS, but just to be safe), the `clearTimeout` in shutdown will prevent the callback from firing. If the callback has already started, `delete` is a no-op on an already-cleared Set. No race.
- **Verdict: Safe.**

## Verification

1. `npm run typecheck` — zero errors
2. `npx vitest run` — all tests pass
3. Code review: verify the `setTimeout` in `handlePerChatCrash` is the only untracked fire-and-forget timer in the crash path

## Acceptance Criteria

- [ ] `pendingRespawnTimers` Set exists on `AgentRuntime`
- [ ] Auto-respawn timer is added to the Set on creation
- [ ] Timer self-removes from the Set when it fires
- [ ] `shutdown()` cancels all pending timers and clears the Set
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
