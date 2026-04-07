# Bead: LEAK-12 — Typing Interval Race Guard

**BeadID:** LEAK-12

**Status:** merged
**Type:** implement
**Runner:** —
**Dependencies:** none
**Scope:** `src/runtimes/agent/outbound-queue.ts`
**Input:** Audit finding: `typingRefreshInterval` may not be cleared if turn ends without `abortTurn()`
**Output:** Defensive interval cleanup on all turn-end paths
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

`typingRefreshInterval` is a `setInterval` at 8-second intervals that re-asserts the composing presence indicator. It's started in `startTyping()` and cleared in `stopTyping()`.

`stopTyping()` is called from:
- `abortTurn()` — on crash/reset
- `flushStreamBuffer()` → `enqueueSend()` → does NOT call `stopTyping()`
- `sendFinalText()` / result handler → calls `stopTyping()` via the queue's turn-end path

The concern: if a turn ends via a path that doesn't call `abortTurn()` or `stopTyping()`, the 8-second interval keeps firing, sending spurious composing presence updates. This keeps the event loop alive and causes "typing..." to appear in the chat forever.

## Implementation Spec

### 1. Add defensive `stopTyping()` in `flush()` / turn-completion

In the `result` event handler path in `outbound-queue.ts`, ensure `stopTyping()` is called:

```typescript
// Wherever the final text is enqueued for a turn, ensure:
this.stopTyping(true); // true = send 'paused' presence
```

### 2. Add `stopTyping()` in `shutdown()`

If `OutboundQueue.shutdown()` doesn't already call `stopTyping()`, add it:

```typescript
shutdown(): void {
  this.stopTyping(false); // silent — we're shutting down
  // ... existing flush/cleanup ...
}
```

### 3. Defensive: check for stale interval in `startTyping()`

```typescript
startTyping(): void {
  // Defensive: clear any stale interval before starting a new one
  if (this.typingRefreshInterval) {
    clearInterval(this.typingRefreshInterval);
  }
  // ... existing start logic ...
}
```

## Maybe I'm Wrong

### Assumption: There's a path where typing interval survives turn end
**Validation needed:** Trace every turn-end path and check for `stopTyping()`.
- **Happy path (result event):** The result handler calls `flush()` → `enqueueSend()` → which eventually calls the queue drain. Need to verify if `stopTyping()` is called in this chain. The result handler in `runtime.ts` calls `queue.flush()` and `queue.sendFinalText()` — need to check if either calls `stopTyping()`.
- **Crash path:** `abortTurn()` calls `stopTyping(false)` — confirmed at ~L403.
- **Timeout path (watchdog):** Watchdog calls `session.kill()` → exit handler → `onCrash` → `abortTurn()` — covered.
- If `flush()` and `sendFinalText()` both call `stopTyping()`, this bead may be unnecessary. **Must verify before implementing.**
- **Action required:** Read the actual `flush()`, `sendFinalText()`, and result handler code to confirm whether there's a gap.

### Assumption: A stale interval causes visible problems
**Assessment:** An 8-second `setInterval` sending composing presence is:
- Visible to the user (permanent "typing..." indicator)
- Keeps the event loop alive (prevents clean process exit if all sessions are done)
- Sends unnecessary network traffic (one presence packet every 8 seconds)
- **Verdict: Visible and annoying but not data-corrupting.**

### Risk: Double `stopTyping()` calls
**Assessment:** `stopTyping()` calls `clearInterval(this.typingRefreshInterval)`. Calling `clearInterval` on an already-cleared interval (or null) is a no-op. The presence send (`paused`) is idempotent. No risk from double-calling.
- **Verdict: Safe.**

## Required Tests

### Test 1: Typing interval is cleared after turn completes
```
GIVEN an OutboundQueue with an active typing interval (startTyping called)
WHEN the turn completes (result event processed, final text sent)
THEN typingRefreshInterval is null
AND no further typing presence updates are sent
```
**Durable:** Tests interval state directly.
**Repeatable:** Mock the messenger — no real WhatsApp dependency.
**Observable:** Check `queue.typingRefreshInterval === null` (or expose via getter).
**Provable:** null check is unambiguous.

### Test 2: Typing interval is cleared on abortTurn
```
GIVEN an OutboundQueue with an active typing interval
WHEN abortTurn() is called
THEN typingRefreshInterval is null
```

### Test 3: startTyping clears stale interval before starting new
```
GIVEN an OutboundQueue with a stale typing interval from a prior turn
WHEN startTyping() is called
THEN only one interval is active (not two)
```
**Observable:** After two rapid `startTyping()` calls, `clearInterval` mock should have been called once for the stale interval.

## Verification

1. `npm run typecheck` — zero errors
2. `npx vitest run` — all tests pass
3. **Pre-implementation validation:** Read `outbound-queue.ts` to confirm the gap exists before writing code. If `stopTyping()` is already called on all turn-end paths, mark this bead as `wontfix`.

## Acceptance Criteria

- [ ] Pre-implementation validation confirms the gap exists (or bead is closed as wontfix)
- [ ] `stopTyping()` called in `shutdown()`
- [ ] `startTyping()` defensively clears stale interval
- [ ] 3 new unit tests for typing interval lifecycle
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
