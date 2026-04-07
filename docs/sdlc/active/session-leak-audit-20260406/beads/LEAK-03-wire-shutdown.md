# Bead: LEAK-03 — Wire Cleanup Into Shutdown Path

**BeadID:** LEAK-03

**Status:** merged
**Type:** implement
**Runner:** —
**Dependencies:** LEAK-01
**Scope:** `src/runtimes/agent/runtime.ts`
**Input:** LEAK-01 merged (cleanupPerChatState exists)
**Output:** `shutdown()` clears all per-chat auxiliary maps
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

`AgentRuntime.shutdown()` (~L1775-1831) calls `.clear()` on `chatSessions` and `chatQueues` but does NOT clear the 6 per-chat auxiliary maps. While this doesn't matter for process-lifetime leaks (process exits), it matters if:

1. `shutdown()` + re-init is ever called on the same runtime instance (e.g., test harnesses)
2. We want clean shutdown semantics for correctness

## Implementation Spec

In `shutdown()`, after the existing `.clear()` calls on `chatSessions` and `chatQueues` (~L1786-1787), add:

```typescript
// EXISTING:
this.chatSessions.clear();
this.chatQueues.clear();

// ADD — clear all per-chat auxiliary state:
this.perChatInboundSeqQueue.clear();
this.perChatTurnContentType.clear();
this.perChatTurnText.clear();
this.perChatAssistantItemText.clear();
this.pendingTurnText.clear();
this.resumeFailedHandling.clear();
```

### Why `.clear()` instead of iterating `cleanupPerChatState()`

On shutdown, we're tearing down everything. `.clear()` is O(1) per map. Iterating keys and calling `.delete()` on each is O(n). Use `.clear()` directly.

## Maybe I'm Wrong

### Assumption: Sessions don't read per-chat maps during their own shutdown
**Validation needed:** Does `SessionManager.shutdown()` access any per-chat maps on the runtime?
- `SessionManager.shutdown()` at session.ts:1131 only accesses its own instance fields (`this.child`, `this.dbRowId`, `this.active`). It does NOT reference the runtime or its maps.
- The runtime's `shutdown()` loop at L1779 calls `session.shutdown()` for each session, then clears maps. Sessions are shut down BEFORE maps are cleared.
- **Verdict: Confirmed safe.** Sessions don't read runtime maps during shutdown.

### Assumption: `.clear()` is safe even if shutdown is interrupted
**Validation needed:** What if the process receives SIGKILL during shutdown?
- `.clear()` on a Map is atomic from JS's perspective (single synchronous operation). A SIGKILL during Map iteration could leave the Map in an inconsistent state, but the process is dying anyway.
- **Verdict: Not a concern.** SIGKILL kills the process — no JS state matters after that.

### Risk: Clearing maps before all async cleanup completes
**Assessment:** `shutdown()` in runtime.ts calls `session.shutdown()` for each session (synchronous SIGTERM send), then calls `.clear()`. There may be pending exit handlers, crash callbacks, or timer callbacks in the event loop that reference these maps. After `.clear()`, those callbacks will see empty maps.
- The respawn timer issue (LEAK-07) is an example: if a respawn timer fires after maps are cleared, it accesses an empty `chatSessions` map.
- **Verdict: Acceptable.** The maps should be empty after shutdown. Stale callbacks should handle empty maps gracefully (null checks). LEAK-07 addresses the root cause (cancelling timers).

## Required Tests

### Test 1: shutdown() clears all per-chat maps
```
GIVEN an AgentRuntime with per-chat state in all 6 maps (multiple keys)
WHEN shutdown() is called
THEN all 6 maps have size === 0
```
**Durable:** Tests Map.size — no timing dependency.
**Repeatable:** Deterministic — call shutdown, check sizes.
**Observable:** `.size` is a numeric property — unambiguous.
**Provable:** `=== 0` is a boolean check.

### Test 2: shutdown() clears maps AFTER shutting down sessions
```
GIVEN an AgentRuntime with 2 active sessions
WHEN shutdown() is called
THEN session.shutdown() is called for both sessions BEFORE maps are cleared
```
**Observable:** Use mock sessions that record call order. Verify shutdown called before map clear.

## Verification

1. `npm run typecheck` — zero errors
2. `npx vitest run` — all tests pass
3. 2 new unit tests as specified above

## Acceptance Criteria

- [ ] All 6 per-chat maps/sets are `.clear()`'d in `shutdown()`
- [ ] Clears happen after session iteration (sessions may reference these maps during shutdown)
- [ ] 2 new unit tests pass
- [ ] Typecheck passes
- [ ] All existing tests pass

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
