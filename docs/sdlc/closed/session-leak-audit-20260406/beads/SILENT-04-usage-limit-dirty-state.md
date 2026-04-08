# Bead: SILENT-04 — Usage Limit Break Leaves Dirty State

**BeadID:** SILENT-04

**Status:** merged
**Type:** implement
**Runner:** —
**Dependencies:** none
**Scope:** `src/runtimes/agent/runtime.ts`
**Input:** Audit finding: isUsageLimitMessage break doesn't complete inbound, flush queue, or clear state
**Output:** Clean turn lifecycle on usage limit detection
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

At runtime.ts ~L1502-1505 (handleEventWithContext) and ~L2417-2421 (handleEvent):

```typescript
if (isUsageLimitMessage(event.text)) {
  log.warn(...);
  session?.shutdown();
  break;
}
```

The `break` exits the switch without:
1. Setting `currentTurnChatJid = null`
2. Calling `durability.completeInbound(...)` — inbound event stays in 'processing'
3. Calling `queue.flush()` — typing indicator stays alive
4. Clearing `activeToolNames`
5. Resetting `turnHadVisibleOutput`

The session is shut down but the turn lifecycle is left dirty.

## Implementation Spec

Add cleanup before the break:

```typescript
if (isUsageLimitMessage(event.text)) {
  log.warn({ chatJid, sessionId }, 'usage limit hit — shutting down session');
  // Complete turn lifecycle
  queue?.flush();
  queue?.stopTyping(true);
  if (this.currentInboundSeq !== undefined) {
    this.durability?.completeInbound(this.currentInboundSeq);
  }
  this.activeToolNames.clear(); // or per-session clear after RACE-04
  this.currentTurnChatJid = null;
  this.turnHadVisibleOutput = false;
  session?.shutdown();
  break;
}
```

Apply the same pattern in `handleEvent` (~L2417-2421).

## Maybe I'm Wrong

### Assumption: Usage limit detection happens in production
**Validation:** `isUsageLimitMessage` checks for strings like "you've reached your usage limit". This happens when Claude's context/rate limits are hit. In production with heavy usage, this is a real scenario.
**Verdict: Confirmed.**

## Required Tests

### Test 1: Usage limit completes inbound event
```
GIVEN a turn in progress with an inbound seq
WHEN a result event contains a usage-limit message
THEN durability.completeInbound is called
AND the inbound seq is not left in 'processing'
```

### Test 2: Queue flushed and typing stopped on usage limit
```
GIVEN an active typing indicator and pending queue items
WHEN usage limit is detected
THEN queue.flush() is called
AND typing indicator is stopped
```

## Verification

1. `npm run typecheck` — zero errors
2. `npx vitest run` — all tests pass

## Acceptance Criteria

- [ ] Inbound event completed on usage limit
- [ ] Queue flushed, typing stopped
- [ ] activeToolNames cleared
- [ ] Turn state variables reset
- [ ] Both handleEvent and handleEventWithContext paths fixed
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
