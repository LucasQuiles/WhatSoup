# Bead: LEAK-09 — Cancel `controlSessionTimeout` on Shutdown

**BeadID:** LEAK-09

**Status:** merged
**Type:** implement
**Runner:** —
**Dependencies:** none
**Scope:** `src/runtimes/agent/runtime.ts`
**Input:** Audit finding: `controlSessionTimeout` not cleared in `shutdown()`
**Output:** Timer cancelled in shutdown
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

`controlSessionTimeout` (~L601) is a `setTimeout` that fires after 15 minutes to kill an idle control/heal session. It's cleared in:
- `emit_heal_result` handler (~L1028) — when heal completes
- The timeout callback itself (~L1708) — when it fires

But it is NOT cleared in `shutdown()`. If shutdown occurs while a control repair is in progress, the timeout fires after shutdown, calling `this.controlSession.shutdown()` on an already-torn-down session, and potentially accessing cleared maps.

## Implementation Spec

In `shutdown()`, add before or after the control session shutdown:

```typescript
// Cancel pending control session timeout
if (this.controlSessionTimeout) {
  clearTimeout(this.controlSessionTimeout);
  this.controlSessionTimeout = null;
}

// EXISTING: shutdown control session if active
if (this.controlSession) {
  this.controlSession.shutdown();
  this.controlSession = null;
}
```

## Maybe I'm Wrong

### Assumption: `controlSessionTimeout` can fire after shutdown
**Validation needed:** Verify that `shutdown()` doesn't already cancel this timer.
- Search `shutdown()` method body for `controlSessionTimeout` — it does not appear.
- Search for all `clearTimeout(this.controlSessionTimeout)` calls — only in `emit_heal_result` handler and the timeout callback itself.
- **Verdict: Confirmed.** The timer is not cancelled in shutdown.

### Assumption: This causes real problems
**Validation needed:** What happens when the timeout fires after shutdown?
- Callback at ~L1708: calls `this.controlSession.shutdown()`. If `this.controlSession` was already nulled by the runtime shutdown, this is a null-ref crash.
- Actually, need to check: does `runtime.shutdown()` null out `this.controlSession`? If yes, the callback will crash. If no, it calls `shutdown()` on an already-shutdown session (which is a no-op if `this.child` is null).
- Need to read the actual `shutdown()` method to confirm.
- **Verdict: Likely a null-ref crash or no-op depending on whether `controlSession` is nulled.** Either way, cleaning up the timer is correct.

### Risk: None
- Cancelling a timer on shutdown is always safe. No behavioral change to running systems.

## Verification

1. `npm run typecheck` — zero errors
2. `npx vitest run` — all tests pass

## Acceptance Criteria

- [ ] `controlSessionTimeout` is `clearTimeout`'d in `shutdown()`
- [ ] Timer field is nulled after clearing
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
