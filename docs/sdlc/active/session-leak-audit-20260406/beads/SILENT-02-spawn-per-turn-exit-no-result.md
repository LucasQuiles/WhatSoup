# Bead: SILENT-02 — Spawn-Per-Turn Non-Zero Exit: No Result Event Synthesized

**BeadID:** SILENT-02

**Status:** pending
**Type:** implement
**Runner:** —
**Dependencies:** none
**Scope:** `src/runtimes/agent/session.ts`, `src/runtimes/agent/runtime.ts`
**Input:** Audit finding: spawn-per-turn exit code != 0 logs warning but synthesizes no result event — inbound seq stuck
**Output:** Synthesize result event or call onCrash on non-zero exit
**Cynefin domain:** complicated
**Security sensitive:** false
**Profile:** REPAIR
**Deterministic checks:** `npm run typecheck`, `npx vitest run`
**Turbulence:** L0: 0, L1: 0, L2: 1
**Loop depth:** L0 + L1 + L2 + L2.5
**Status:** pending → running → submitted → verified → proven → hardened → reliability-proven → merged
**Current loop:** —
**Bridge sync:** false

## Root Cause

At session.ts:~984-989, when a spawn-per-turn child exits with non-zero code:

```typescript
if (code !== 0 && code !== null) {
  this.budget?.cancelPending();
  log.warn({ exitCode: code, signal }, 'provider turn process exited with error');
}
```

No `result` event is synthesized. No `onCrash` callback is invoked. The runtime's `handleEventPerChat` never sees a `result`, so:
- `perChatInboundSeqQueue` never shifts the current seq — blocking future turns
- `durability.completeInbound()` is never called — event stays in 'processing'
- The user gets no response and no error notification
- The typing indicator eventually times out silently

## Implementation Spec

Synthesize a `result` event on non-zero exit:

```typescript
if (code !== 0 && code !== null) {
  this.budget?.cancelPending();
  log.warn({ exitCode: code, signal, chatJid: this.chatJid }, 'provider turn process exited with error');
  // Synthesize result event so the runtime can clean up
  this.onEvent?.({
    type: 'result',
    text: '',
    inputTokens: 0,
    outputTokens: 0,
  });
}
```

Alternatively, invoke `onCrash` so the runtime's crash handling (which includes user notification and inbound-seq cleanup) kicks in.

## Maybe I'm Wrong

### Assumption: No result event is ever synthesized
**Validation:** The exit handler for spawn-per-turn (session.ts:~960-990) checks `code !== 0`, logs, and returns. The normal exit (code === 0) path at ~L974 also does not synthesize a result — it relies on the child having emitted a result event before exiting. For non-zero exits, the child may not have emitted any result.
**Verdict: Confirmed.** No fallback result is synthesized.

### Assumption: This leaves inbound seq stuck
**Validation:** `perChatInboundSeqQueue.shift()` is called only in `handleEventPerChat` on `result` event (~L1434). Without a result event, the shift never happens.
**Verdict: Confirmed.**

## Required Tests

### Test 1: Non-zero exit produces result or crash notification
```
GIVEN a spawn-per-turn session processing a turn
WHEN the child exits with code 1
THEN either a result event is synthesized (completing the turn lifecycle)
OR onCrash is called (triggering user notification and seq cleanup)
AND the inbound seq is consumed from perChatInboundSeqQueue
```

### Test 2: User receives error notification on non-zero exit
```
GIVEN a spawn-per-turn session
WHEN the child exits with non-zero code
THEN the user receives an error message (not silence)
```

## Verification

1. `npm run typecheck` — zero errors
2. `npx vitest run` — all tests pass

## Acceptance Criteria

- [ ] Non-zero exit from spawn-per-turn child triggers result/crash lifecycle
- [ ] Inbound seq is consumed (not stuck)
- [ ] Durability marks event as completed or failed
- [ ] User receives notification
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
