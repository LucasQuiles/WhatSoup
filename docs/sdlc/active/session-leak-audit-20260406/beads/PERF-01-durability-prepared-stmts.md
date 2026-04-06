# Bead: PERF-01 — Cache DurabilityEngine Prepared Statements

**BeadID:** PERF-01

**Status:** pending
**Type:** implement
**Runner:** —
**Dependencies:** none
**Scope:** `src/core/durability.ts`
**Input:** Audit finding: `.prepare()` called inline on every method — 40 statements recompiled on every invocation
**Output:** All statements cached as private properties, initialized in constructor
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

Every method in `DurabilityEngine` calls `this.db.raw.prepare(...)` inline:

```typescript
recordToolCall(turnId, toolId, toolName) {
  this.db.raw.prepare('INSERT INTO ...').run(turnId, toolId, toolName);
}
markToolExecuting(id) {
  this.db.raw.prepare('UPDATE ... WHERE id = ?').run(id);
}
```

`better-sqlite3`'s `.prepare()` compiles the SQL statement each time. In a turn with 20 tool calls, that's 60+ statement compilations. This is the highest-frequency performance issue found in the audit.

## Implementation Spec

Cache all prepared statements in the constructor:

```typescript
class DurabilityEngine {
  // Cached statements
  private readonly stmtRecordToolCall: Statement;
  private readonly stmtMarkToolExecuting: Statement;
  private readonly stmtMarkToolComplete: Statement;
  // ... 37 more ...

  constructor(db: Database) {
    this.db = db;
    this.stmtRecordToolCall = db.raw.prepare('INSERT INTO ...');
    this.stmtMarkToolExecuting = db.raw.prepare('UPDATE ... WHERE id = ?');
    this.stmtMarkToolComplete = db.raw.prepare('UPDATE ... WHERE id = ?');
    // ... etc ...
  }

  recordToolCall(turnId: string, toolId: string, toolName: string): number {
    return this.stmtRecordToolCall.run(turnId, toolId, toolName).lastInsertRowid as number;
  }
}
```

Also apply the same fix to `canonicalizeChatJid` in `jid-constants.ts` (~L91) which has the same pattern.

## Maybe I'm Wrong

### Assumption: Statement compilation is a measurable cost
**Validation:** `better-sqlite3` benchmarks show `.prepare()` takes ~10-50μs per statement. With 60 compilations per turn, that's 0.6-3ms per turn — measurable but not catastrophic. However, it's pure waste — cached statements are near-zero overhead.
**Verdict: Clear optimization.** The fix is mechanical and risk-free.

### Assumption: All 40 statements can be cached
**Validation:** Some queries use dynamic SQL (e.g., IN-clause with variable placeholders). These cannot be cached. Need to audit each statement.
**Action:** Read durability.ts and identify which statements have fixed SQL (cacheable) vs. dynamic SQL (not cacheable).
**Verdict: Most are cacheable.** A few with dynamic IN-clauses will remain inline.

## Required Tests

No new behavioral tests — this is a pure refactor. Verify:
1. `npm run typecheck` — zero errors
2. `npx vitest run` — all tests pass (no behavioral change)
3. Optional: benchmark before/after on a 20-tool-call turn

## Acceptance Criteria

- [ ] All fixed-SQL statements cached as private properties
- [ ] Constructor initializes all cached statements
- [ ] Methods use cached statements instead of inline `.prepare()`
- [ ] Dynamic-SQL statements documented as exceptions
- [ ] `canonicalizeChatJid` statement also cached
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
