# Bead: RACE-02 — Non-Sandboxed Per-Chat Concurrent Message Double-Spawn

**BeadID:** RACE-02

**Status:** merged
**Type:** implement
**Runner:** —
**Dependencies:** none
**Scope:** `src/runtimes/agent/runtime.ts`
**Input:** Audit finding: two concurrent messages during spawn in non-sandboxed per_chat — second calls shutdown() mid-spawn
**Output:** Per-chat turn serialization or spawn mutex
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

In non-sandboxed `per_chat` mode, `_handleMessageInner` is serialized through the global `turnChain`. But per-chat turns call `sendTurnPerChat` directly (~L1245), which calls `sendTurnToSession`. Inside `sendTurnToSession` (~L1319-1325):

```typescript
if (!session.getStatus().active) {
  session.shutdown();
  await session.spawnSession();
}
await session.sendTurn(prefixedText);
```

If message A enters `sendTurnToSession` and starts `spawnSession()` (async), message B can enter `sendTurnToSession` for the SAME chat while A is awaiting. B sees `getStatus().active === false` (spawn not yet complete), calls `session.shutdown()` (killing A's in-progress spawn), then calls `spawnSession()` again. Both turns are dropped. The session is left in a confused state.

This happens because `turnChain` serializes the outer `_handleMessageInner` calls, but `sendTurnToSession` awaits `spawnSession` — and while it's awaiting, the global `turnChain` releases and lets the next message through.

Wait — actually, `turnChain` chains `.then(() => this._handleMessageInner(msg))`. If `_handleMessageInner` awaits `sendTurnPerChat` which awaits `sendTurnToSession` which awaits `spawnSession`, then the chain link doesn't resolve until spawnSession resolves. So the next message in `turnChain` DOES wait. Let me re-examine.

The issue is only if per_chat turns DON'T go through `turnChain`. Need to verify this at implementation time.

## Implementation Spec

### Option A: Per-chat spawn lock

Add a Set tracking chats with in-progress spawns:

```typescript
private spawningChats: Set<string> = new Set();

// In sendTurnToSession, before spawn:
if (this.spawningChats.has(mapKey)) {
  // Queue this turn to be sent after spawn completes
  log.debug({ mapKey }, 'spawn in progress — deferring turn');
  return; // or queue for retry
}
this.spawningChats.add(mapKey);
try {
  await session.spawnSession();
} finally {
  this.spawningChats.delete(mapKey);
}
```

### Option B: Per-chat promise chain (like TurnQueue)

Create a per-chat `Promise` chain stored in a map, so turns for the same chat are serialized:

```typescript
private perChatChains: Map<string, Promise<void>> = new Map();

// In sendTurnPerChat:
const chain = this.perChatChains.get(mapKey) ?? Promise.resolve();
const newChain = chain.then(() => this.sendTurnToSession(session, chatJid, text));
this.perChatChains.set(mapKey, newChain);
await newChain;
```

## Maybe I'm Wrong

### Assumption: This race actually occurs
**Validation needed:** Verify whether `_handleMessageInner` in per_chat mode goes through `turnChain` or not. If all messages are serialized through `turnChain` and `_handleMessageInner` is fully awaited before the next message runs, the race cannot occur.
**Action:** Read the `handleMessage` → `_handleMessageInner` → `sendTurnPerChat` chain and confirm whether the global `turnChain` serializes per-chat turns.
**Verdict: MUST VERIFY.** If `turnChain` fully serializes, this bead is wontfix.

## Required Tests

### Test 1: Two rapid messages for the same chat don't double-spawn
```
GIVEN a per_chat session that is not active
WHEN two messages arrive for the same chatJid within 10ms
THEN only one spawnSession() call is made
AND both messages are eventually sent to the session
AND no session is orphaned
```

## Verification

1. Pre-implementation: verify the race exists by tracing `turnChain` → `_handleMessageInner` → `sendTurnPerChat`
2. `npm run typecheck` — zero errors
3. `npx vitest run` — all tests pass

## Acceptance Criteria

- [ ] Pre-implementation verification confirms the race exists (or bead is closed as wontfix)
- [ ] Per-chat turn serialization prevents double-spawn
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
