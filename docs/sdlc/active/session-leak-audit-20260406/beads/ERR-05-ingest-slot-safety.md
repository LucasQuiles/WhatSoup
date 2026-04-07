# Bead: ERR-05 — Ingest Handler Slot Counter Safety

**BeadID:** ERR-05

**Status:** merged
**Type:** implement
**Runner:** —
**Dependencies:** none
**Scope:** `src/core/ingest.ts`
**Input:** Audit finding: `void (async () => {...})()` ingest handler — slot counter corruption on unexpected throw
**Output:** Outer error boundary preventing slot counter leak
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

At ingest.ts:~140, the ingest handler uses:
```typescript
void (async () => {
  const proceed = await acquireSlot(msg);
  if (!proceed) return;
  try { /* processing */ } finally { releaseSlot(); }
})();
```

If `acquireSlot()` itself throws (not just rejects), or if `releaseSlot()` throws inside the finally block, the exception becomes an unhandled promise rejection. More critically, if any error escapes the try/finally (e.g., `releaseSlot` throws because `next.resolve` is corrupted), `_activeSlots` remains incremented permanently. After enough such failures, all ingest slots are consumed and the pipeline starves — no messages are processed.

## Implementation Spec

Add an outer try/catch around the entire async body:

```typescript
void (async () => {
  let slotAcquired = false;
  try {
    const proceed = await acquireSlot(msg);
    if (!proceed) return;
    slotAcquired = true;
    // ... existing processing ...
  } catch (err) {
    log.error({ err, messageId: msg.key?.id }, 'unhandled error in ingest handler');
  } finally {
    if (slotAcquired) {
      try { releaseSlot(); } catch (releaseErr) {
        log.error({ err: releaseErr }, 'releaseSlot failed — slot may be permanently consumed');
      }
    }
  }
})();
```

## Maybe I'm Wrong

### Assumption: `acquireSlot` can throw synchronously
**Validation:** Need to read `acquireSlot` implementation. If it's a simple promise-based semaphore, it returns a promise and cannot throw synchronously. But if the semaphore state is corrupted (e.g., `_activeSlots` is NaN), comparisons could behave unexpectedly.
**Verdict: Unlikely but defensive coding is warranted.** The fix is trivial and prevents a catastrophic failure mode.

## Required Tests

### Test 1: Slot released even on processing error
```
GIVEN an ingest handler where processing throws an unexpected error
WHEN the handler completes
THEN the slot is released (activeSlots decremented)
AND subsequent messages can still acquire slots
```

## Verification

1. `npm run typecheck` — zero errors
2. `npx vitest run` — all tests pass

## Acceptance Criteria

- [ ] Outer try/catch/finally wraps entire ingest async body
- [ ] `slotAcquired` flag ensures releaseSlot only called if acquired
- [ ] releaseSlot wrapped in inner try/catch
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
