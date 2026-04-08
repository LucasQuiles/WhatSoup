# Bead: PERF-03 — Batch Turn-Completion SQLite Writes

**BeadID:** PERF-03

**Status:** merged
**Type:** implement
**Runner:** —
**Dependencies:** PERF-01 (cached statements)
**Scope:** `src/core/durability.ts`, `src/runtimes/agent/runtime.ts`
**Input:** Audit finding: 5 separate SQLite transactions per turn completion
**Output:** Single batched transaction for turn completion
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

When a turn completes (result event), five separate SQLite writes fire:
1. `accumulateSessionTokens` — UPDATE agent_sessions
2. `durability.upsertSessionCheckpoint` — UPSERT session_checkpoints
3. `durability.completeInbound` → `markTurnDone` — UPDATE
4. `durability.completeInbound` → `markInboundComplete` — UPDATE
5. `durability.markTerminal(opId)` — UPDATE

Each is a separate implicit transaction with its own fsync (in WAL mode, still a separate write-ahead-log entry). 5 transactions per turn × N turns per conversation = significant I/O overhead on slower storage.

## Implementation Spec

Add a `completeTurn` method to `DurabilityEngine` that batches all writes:

```typescript
completeTurn(params: {
  inboundSeq: number;
  turnId: string;
  lastOpId: number;
  sessionTokens?: { input: number; output: number; dbRowId: number };
  checkpointUpdate?: SessionCheckpointUpdate;
}): void {
  const txn = this.db.raw.transaction(() => {
    if (params.sessionTokens) {
      this.stmtAccumulateTokens.run(
        params.sessionTokens.input, params.sessionTokens.output, params.sessionTokens.dbRowId
      );
    }
    if (params.checkpointUpdate) {
      this.stmtUpsertCheckpoint.run(/* ... */);
    }
    this.stmtMarkTurnDone.run(params.turnId);
    this.stmtMarkInboundComplete.run(params.inboundSeq);
    this.stmtMarkTerminal.run(params.lastOpId);
  });
  txn();
}
```

Update the `result` event handler in `handleEventWithContext` to call `completeTurn` instead of 5 individual methods.

## Maybe I'm Wrong

### Assumption: 5 transactions are measurably slower than 1
**Validation:** In WAL mode, each transaction appends to the WAL and the OS may coalesce fsyncs. The difference may be negligible on fast NVMe. But on slower storage (USB drives, SD cards, cloud volumes with high latency), each fsync is 1-10ms. 5 × 10ms = 50ms vs 10ms.
**Action:** Benchmark before/after on the target hardware.
**Verdict: Worth doing regardless** — fewer transactions is always better for SQLite contention.

## Required Tests

No new behavioral tests — pure refactor. Verify:
1. `npm run typecheck` — zero errors
2. `npx vitest run` — all tests pass

## Acceptance Criteria

- [ ] `completeTurn` method batches all turn-completion writes in one transaction
- [ ] Result event handler uses `completeTurn` instead of individual calls
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
