# Bead: LEAK-01 — Per-Chat State Cleanup Helper

**BeadID:** LEAK-01

**Status:** pending
**Type:** implement
**Runner:** —
**Dependencies:** none
**Scope:** `src/runtimes/agent/runtime.ts`
**Input:** Audit finding: 5 per-chat Maps + 1 Set are never cleaned on session end
**Output:** A single `cleanupPerChatState(mapKey)` private method on `AgentRuntime`
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

When a per-chat session ends (crash, reset, `/new`, or explicit deletion from `chatSessions`), the code deletes from `chatSessions` and `chatQueues` but leaves stale entries in 6 auxiliary maps:

| Map | Declaration (runtime.ts) | What leaks |
|-----|--------------------------|------------|
| `perChatInboundSeqQueue` | L538 | `number[]` — inbound seq FIFO |
| `perChatTurnContentType` | L548 | `string` — content type for voice reply |
| `perChatTurnText` | L549 | `string` — accumulated assistant response (can be large) |
| `perChatAssistantItemText` | L550 | `Map<string, string>` — nested per-item text |
| `pendingTurnText` | L554 | `string` — user message text for replay |
| `resumeFailedHandling` | L559 | `string` — guard flag |

Each Map entry persists for the lifetime of the process. For a bot with many distinct conversations, this grows without bound.

## Implementation Spec

Add a private method to `AgentRuntime`:

```typescript
/**
 * Remove all per-chat auxiliary state for a given map key.
 * Call this whenever a session is removed from chatSessions.
 */
private cleanupPerChatState(mapKey: string): void {
  this.perChatInboundSeqQueue.delete(mapKey);
  this.perChatTurnContentType.delete(mapKey);
  this.perChatTurnText.delete(mapKey);
  this.perChatAssistantItemText.delete(mapKey);
  this.pendingTurnText.delete(mapKey);
  this.resumeFailedHandling.delete(mapKey);
}
```

### Placement

Add this method near the existing per-chat map declarations (around L560, after `resumeFailedHandling`), grouped with the helper `getPerChatAssistantItemMap()` that already exists at L567.

### Design Decisions

- **Single method, not inline deletes**: Every session-deletion site needs to call the same set of deletes. A helper prevents drift when new per-chat maps are added in the future.
- **Idempotent**: `.delete()` on a Map/Set is a no-op if the key doesn't exist. Safe to call multiple times.
- **No logging**: These are routine cleanup operations. Log only if we want to track cleanup for debugging (defer to LEAK-02/03).

## Maybe I'm Wrong

### Assumption: These 6 maps are the complete list of per-chat state
**Validation needed:** Grep `runtime.ts` for all `private.*Map<string,` and `private.*Set<string>` declarations. Cross-reference with the audit.
- The audit traced every `.set()`, `.get()`, `.delete()` for each map. But new maps could have been added since the audit date.
- **Action:** Before implementation, run `grep -n 'private.*Map<string\|private.*Set<string' src/runtimes/agent/runtime.ts` and verify no per-chat maps are missing.
- **Verdict: High confidence** but must verify at implementation time.

### Assumption: Deleting from these maps on session end is safe
**Validation needed:** Could any of these maps be read AFTER session deletion?
- `perChatInboundSeqQueue`: Read in `handlePerChatCrash` (L2118) which runs BEFORE session deletion. Safe.
- `pendingTurnText`: Read in `handleResumeFailed` (L2235) which runs after crash but before new session spawn. If we clean on crash, the replay text is lost. **This is why LEAK-02 has special handling for Site 4** — partial cleanup only.
- `resumeFailedHandling`: A transient guard read in `sendTurnToSession` (L1334). If a session is being deleted, no new turns will be sent to it. Safe.
- **Verdict: Safe for full cleanup on terminal deletion. Partial cleanup needed on crash (LEAK-02 handles this).**

### Assumption: `.delete()` is sufficient (no deep cleanup needed)
**Validation needed:** Do any of these map values hold resources beyond memory?
- All values are primitives (`string`, `number[]`) or plain Maps. No file handles, timers, or event listeners.
- The nested `Map<string, string>` in `perChatAssistantItemText` is just strings. GC handles it.
- **Verdict: Confirmed. `.delete()` is sufficient.**

## Required Tests

### Test 1: cleanupPerChatState removes all entries for a given key
```
GIVEN an AgentRuntime instance with populated per-chat state for key 'test@s.whatsapp.net'
  (all 6 maps/sets have entries for that key)
WHEN cleanupPerChatState('test@s.whatsapp.net') is called
THEN all 6 maps/sets return false for .has('test@s.whatsapp.net')
AND entries for OTHER keys are untouched
```
**Durable:** Tests Map/Set state directly — no timing, no I/O.
**Repeatable:** Pure in-memory operation, deterministic.
**Observable:** `.has()` returns boolean — unambiguous pass/fail.
**Provable:** Independent observer can verify by inspecting Map sizes and `.has()` results.

### Test 2: cleanupPerChatState is idempotent
```
GIVEN an AgentRuntime with NO entries for key 'nonexistent@s.whatsapp.net'
WHEN cleanupPerChatState('nonexistent@s.whatsapp.net') is called
THEN no error is thrown
AND no other map entries are affected
```

### Test 3: cleanupPerChatState covers all per-chat maps
```
GIVEN the source code of runtime.ts
WHEN we count private Map/Set fields whose keys are mapKey/chatJid strings
THEN the count matches the number of .delete() calls in cleanupPerChatState
```
**Note:** This is a structural/meta test — ensures the helper stays in sync with the class fields. Can be implemented as a grep-based test or a reflection-based test on the class.

## Verification

1. `npm run typecheck` — zero errors
2. `npx vitest run` — all 3586 tests pass
3. 3 new unit tests as specified above

## Acceptance Criteria

- [ ] `cleanupPerChatState(mapKey)` method exists on `AgentRuntime`
- [ ] Method deletes from all 6 per-chat maps/sets
- [ ] Method is private (not exported)
- [ ] Pre-implementation grep confirms no missing maps
- [ ] 3 new unit tests pass
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
