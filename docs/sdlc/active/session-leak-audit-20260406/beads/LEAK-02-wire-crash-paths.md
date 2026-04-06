# Bead: LEAK-02 — Wire Cleanup Into All Session-Deletion Sites

**BeadID:** LEAK-02

**Status:** pending
**Type:** implement
**Runner:** —
**Dependencies:** LEAK-01
**Scope:** `src/runtimes/agent/runtime.ts`
**Input:** LEAK-01 merged (cleanupPerChatState exists)
**Output:** All 5 session-deletion code paths call `cleanupPerChatState()`
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

There are 5 code paths in `runtime.ts` that delete from `chatSessions` and/or `chatQueues` without cleaning up per-chat auxiliary state. Each is a `notifyUser` crash callback or an in-session replacement.

## Implementation Spec

Add `this.cleanupPerChatState(key)` at each of these sites:

### Site 1 — `notifyUser` callback in startup proactive resume (non-sandbox per_chat)

**Location:** ~L868-872

```typescript
// EXISTING:
chatSessions.delete(chatJid);
chatQueues.get(chatJid)?.abortTurn();
chatQueues.delete(chatJid);
// ADD:
this.cleanupPerChatState(chatJid);
```

### Site 2 — `notifyUser` callback in `ensureSessionAndQueue` (sandboxPerChat)

**Location:** ~L1986-1990

```typescript
// EXISTING:
chatSessions.delete(workspaceKey);
chatQueues.get(workspaceKey)?.abortTurn();
chatQueues.delete(workspaceKey);
// ADD:
this.cleanupPerChatState(workspaceKey);
```

### Site 3 — `notifyUser` callback in `ensureSessionAndQueueSync` (non-sandbox per_chat)

**Location:** ~L2044-2048

```typescript
// EXISTING:
chatSessions.delete(chatJid);
chatQueues.get(chatJid)?.abortTurn();
chatQueues.delete(chatJid);
// ADD:
this.cleanupPerChatState(chatJid);
```

### Site 4 — `handlePerChatCrash`

**Location:** ~L2115-2122

This is the most important site. Currently `handlePerChatCrash` calls `abortTurn()` but does NOT delete the session from `chatSessions` (the session stays for auto-respawn). However, per-chat turn state from the crashed turn should still be cleaned:

```typescript
// EXISTING (after abortTurn):
const seqQueue = this.perChatInboundSeqQueue.get(mapKey) ?? [];
// ... shift crashed seq ...
// ADD after the seq handling:
this.perChatTurnContentType.delete(mapKey);
this.perChatTurnText.delete(mapKey);
this.perChatAssistantItemText.delete(mapKey);
// NOTE: Do NOT delete perChatInboundSeqQueue here — handlePerChatCrash
// already manages it (shift the crashed seq, keep remaining).
// NOTE: Do NOT delete pendingTurnText here — it's needed for replay
// in handleResumeFailed which may follow.
// NOTE: Do NOT delete resumeFailedHandling — it's a transient guard.
```

**Important**: Site 4 is a partial cleanup. We clean turn-scoped state (content type, turn text, assistant items) but preserve session-scoped state (seq queue, pending text, resume guard) because the session may auto-respawn and replay.

### Site 5 — `handleJidAliasChanged` in-session replacement

**Location:** ~L1140-1150

When the LID→phone mapping is learned mid-session and the session is replaced:

```typescript
// EXISTING:
chatSessions.delete(oldKey);
// ... create new session under canonical key ...
// ADD (clean old key's auxiliary state):
this.cleanupPerChatState(oldKey);
```

Note: The re-keying logic at L718-741 (which migrates map entries from LID key to canonical key) runs BEFORE this deletion. So the data has already been moved to the new key. Cleaning the old key is safe and correct.

## Maybe I'm Wrong

### Assumption: There are exactly 5 session-deletion sites
**Validation needed:** Grep for all `chatSessions.delete` calls in `runtime.ts`.
- The audit found 5 sites. But code may have changed since the audit.
- **Action:** Before implementation, run `grep -n 'chatSessions.delete\|chatQueues.delete' src/runtimes/agent/runtime.ts` and verify the count and line numbers match.
- **Verdict: Must verify at implementation time.**

### Assumption: Site 4 (handlePerChatCrash) should NOT do full cleanup
**Validation needed:** What happens after a crash? Does auto-respawn use `pendingTurnText` or `perChatInboundSeqQueue`?
- `handlePerChatCrash` at L2118: reads `perChatInboundSeqQueue` to shift the crashed seq and mark durability failure. If we delete the queue before this read, we lose the seq number.
- `handleResumeFailed` at L2235: reads `pendingTurnText` for replay. If we delete it during crash cleanup, replay fails silently.
- `perChatInboundSeqQueue` after shift: the remaining seqs are for queued messages that haven't been processed yet. If we delete the queue, those seqs are lost → durability gaps.
- **Verdict: Confirmed — Site 4 must only clean turn-scoped state, not session-scoped state.** The three maps cleaned (contentType, turnText, assistantItemText) are purely turn-scoped and not read by any post-crash recovery path.

### Assumption: Site 5 (handleJidAliasChanged) cleanup of old key is safe
**Validation needed:** Has the re-key migration at L718-741 already moved data to the new key?
- L718-741: for each of the 6 maps, it reads the old key, deletes the old key, and sets the new canonical key. So by the time Site 5 runs, the old key entries have already been moved.
- **Verdict: Confirmed safe.** The `cleanupPerChatState(oldKey)` at Site 5 is a defensive no-op (entries already deleted by the re-key logic). But it's good to have as a safety net.

### Risk: cleanup called before queue.abortTurn()
**Assessment:** At Sites 1-3, the pattern is `chatSessions.delete()` → `chatQueues.get().abortTurn()` → `chatQueues.delete()`. We add cleanup after all three operations. The queue's `abortTurn()` doesn't read from per-chat maps, so ordering doesn't matter.
- **Verdict: Safe regardless of ordering.**

## Required Tests

### Test 1: Crash path cleans turn-scoped state but preserves session-scoped state
```
GIVEN an AgentRuntime with per-chat state for key K:
  - perChatTurnContentType has entry for K
  - perChatTurnText has entry for K
  - perChatAssistantItemText has entry for K
  - perChatInboundSeqQueue has [1, 2] for K
  - pendingTurnText has 'hello' for K
WHEN handlePerChatCrash fires for key K
THEN perChatTurnContentType.has(K) === false
AND perChatTurnText.has(K) === false
AND perChatAssistantItemText.has(K) === false
AND perChatInboundSeqQueue.has(K) === true (seq shifted but entry exists)
AND pendingTurnText.has(K) === true (preserved for replay)
```
**Durable:** Tests Map state — no timing dependency.
**Repeatable:** Mocked session crash, deterministic.
**Observable:** `.has()` checks on each map.
**Provable:** Boolean assertions, unambiguous.

### Test 2: Terminal deletion cleans ALL per-chat state
```
GIVEN an AgentRuntime with per-chat state for key K (all 6 maps populated)
WHEN notifyUser crash callback fires and deletes session for K
THEN all 6 maps return .has(K) === false
```

### Test 3: LID re-key cleanup is safe (no double-delete crash)
```
GIVEN an AgentRuntime where handleJidAliasChanged has already migrated key OLD→NEW
WHEN cleanupPerChatState(OLD) is called
THEN no error is thrown
AND entries for NEW key are untouched
```

### Test 4: Cleanup doesn't interfere with other chats
```
GIVEN per-chat state for keys A, B, C
WHEN cleanup fires for key B only
THEN A and C entries are completely untouched in all 6 maps
```

## Verification

1. `npm run typecheck` — zero errors
2. `npx vitest run` — all tests pass
3. Pre-implementation grep confirms deletion site count
4. 4 new unit tests as specified above

## Acceptance Criteria

- [ ] Sites 1-3 call `this.cleanupPerChatState(key)` after session/queue deletion
- [ ] Site 4 cleans turn-scoped state only (contentType, turnText, assistantItemText)
- [ ] Site 5 cleans old key after LID re-key migration
- [ ] No behavioral change to auto-respawn or resume-failed paths
- [ ] Pre-implementation grep confirms 5 deletion sites
- [ ] 4 new unit tests pass
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
