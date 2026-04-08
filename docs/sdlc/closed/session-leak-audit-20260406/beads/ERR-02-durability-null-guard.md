# Bead: ERR-02 — Replace `this.durability!` Non-Null Assertion with Guard

**BeadID:** ERR-02

**Status:** merged
**Type:** implement
**Runner:** —
**Dependencies:** none
**Scope:** `src/runtimes/agent/runtime.ts`
**Input:** Audit finding: `this.durability!` at ~L813 crashes startup if durability not set
**Output:** Null guard with graceful fallback or early error
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

`this.durability` is typed `DurabilityEngine | null`, initialized to `null`. `setDurability()` is called by the transport layer after construction. At ~L813:

```typescript
const classified = classifyActiveSessions(this.db, this.durability!);
```

If `start()` runs before `setDurability()`, or if durability is intentionally disabled for a config, the `!` assertion causes a runtime crash deep inside `classifyActiveSessions` (which calls `.getSessionCheckpoint()` on null).

## Implementation Spec

Replace the non-null assertion with a guard:

```typescript
if (!this.durability) {
  log.warn('durability engine not set — skipping active session classification');
} else {
  const classified = classifyActiveSessions(this.db, this.durability);
  // ... existing classification logic ...
}
```

Also audit for other `this.durability!` assertions in `runtime.ts` and replace each with a null check.

## Maybe I'm Wrong

### Assumption: `setDurability` can be called late or not at all
**Validation:** Check the bootstrap sequence in `main.ts` — is `setDurability` always called before `start()`? If the call order is guaranteed by construction, the assertion is safe (but still bad practice).
**Action:** Grep for `setDurability` call sites and verify ordering relative to `start()`.
**Verdict: Must verify.** Even if currently safe, the `!` assertion is a maintenance trap.

## Required Tests

### Test 1: start() handles null durability gracefully
```
GIVEN an AgentRuntime with sessionScope='per_chat' and durability=null
WHEN start() is called
THEN no TypeError is thrown
AND a warning is logged
AND the runtime starts successfully (skipping session classification)
```

## Verification

1. `npm run typecheck` — zero errors
2. `npx vitest run` — all tests pass

## Acceptance Criteria

- [ ] All `this.durability!` assertions replaced with null guards
- [ ] Graceful skip with warning log when durability is null
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
