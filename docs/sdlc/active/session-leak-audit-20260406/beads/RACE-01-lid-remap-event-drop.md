# Bead: RACE-01 — Mid-Turn LID Remapping Silently Drops Events

**BeadID:** RACE-01

**Status:** merged
**Type:** implement
**Runner:** —
**Dependencies:** none
**Scope:** `src/runtimes/agent/runtime.ts`
**Input:** Audit finding: LID alias change during active turn drops all remaining events — closure captures old key
**Output:** Event closure updated or re-routed after LID remapping
**Cynefin domain:** complex
**Security sensitive:** false
**Profile:** REPAIR
**Deterministic checks:** `npm run typecheck`, `npx vitest run`
**Turbulence:** L0: 0, L1: 0, L2: 2
**Loop depth:** L0 + L1 + L2 + L2.5 + L2.75
**Status:** pending → running → submitted → verified → proven → hardened → reliability-proven → merged
**Current loop:** —
**Bridge sync:** false

## Root Cause

In `ensureSessionAndQueue` (~L1980), the `handleEventPerChat` closure is created capturing `workspaceKey`:

```typescript
const handleEventPerChat = (event: ProviderEvent) => {
  // mapKey derived from captured workspaceKey
  const queue = this.chatQueues.get(mapKey);
  if (!queue) return;  // ← silent drop
  // ...
};
```

When `handleJidAliasChanged` fires (~L699-747), it re-keys `chatSessions`, `chatQueues`, and all per-chat maps from the old LID-based key to the canonical phone-based key. But the closure still holds the OLD `workspaceKey`. All subsequent events from the active session use the old key to look up the queue — which was just moved to the new key. `chatQueues.get(oldKey)` returns `undefined`, the guard fires, and events are silently dropped.

**Consequence:** The entire remainder of the active turn's output is lost. The user sees partial output (whatever was delivered before the LID mapping arrived) and then silence.

## Implementation Spec

### Option A: Update the closure's key reference (recommended)

Change the event handler to look up the key dynamically rather than capturing it:

```typescript
// Instead of capturing mapKey at closure creation time,
// derive it from the session's current chatJid at event time:
const handleEventPerChat = (event: ProviderEvent) => {
  // Find which key this session is stored under
  const mapKey = this.findMapKeyForSession(session);
  if (!mapKey) return; // session was removed
  const queue = this.chatQueues.get(mapKey);
  if (!queue) { log.debug({ event: event.type }, 'event dropped — no queue'); return; }
  // ...
};
```

Where `findMapKeyForSession` iterates `chatSessions` to find the key for this session object. This is O(n_chats) but LID remapping is rare and n_chats is small.

### Option B: Store a mutable key reference

Use an object wrapper so the closure captures a reference that can be mutated:

```typescript
const keyRef = { current: workspaceKey };
// In handleJidAliasChanged, update keyRef.current = canonicalKey
const handleEventPerChat = (event: ProviderEvent) => {
  const mapKey = keyRef.current;
  // ...
};
```

This requires `handleJidAliasChanged` to know about and update the `keyRef` for the affected session. Store the `keyRef` in `workspaceResources` or a parallel map.

### Option C: Re-create the closure after remapping

In `handleJidAliasChanged`, after re-keying maps, update the session's `onEvent` callback:

```typescript
session.onEvent = createEventHandler(canonicalKey);
```

This is cleanest but requires `onEvent` to be reassignable on `SessionManager`.

## Maybe I'm Wrong

### Assumption: LID remapping actually happens during active turns
**Validation:** LID→phone mappings arrive via `handleJidAliasChanged` which is fired by Baileys' `jid-alias-changed` event. This can fire at any time — including during an active turn. The audit confirmed this is a real race.
**Verdict: Confirmed.** Especially for new contacts whose LID mapping isn't known until after first interaction.

### Assumption: Events are actually dropped (not just delayed)
**Validation:** `chatQueues.get(oldKey)` returns undefined after re-keying. The guard at ~L1425 returns immediately with no fallback. Events are permanently lost, not queued.
**Verdict: Confirmed.** No retry or fallback mechanism.

### Risk: Option A's `findMapKeyForSession` is O(n)
**Assessment:** LID remapping happens once per contact per process lifetime. The O(n) lookup runs only on events AFTER remapping, which is rare. Even with 100 chats, iterating 100 map entries is sub-microsecond.
**Verdict: Acceptable.**

## Required Tests

### Test 1: Events delivered after LID remapping
```
GIVEN an active per_chat session under LID key L
AND chatQueues has entry under L
WHEN handleJidAliasChanged fires, remapping L→C
AND a 'result' event arrives from the session
THEN the event is delivered to the queue under canonical key C
AND the inbound seq is properly completed
```

### Test 2: No event drop during mid-turn remapping
```
GIVEN a session actively streaming text (assistant_text events)
WHEN handleJidAliasChanged fires mid-stream
THEN all subsequent assistant_text events are still delivered
AND the final result event is delivered
AND the user receives the complete response
```

## Verification

1. `npm run typecheck` — zero errors
2. `npx vitest run` — all tests pass

## Acceptance Criteria

- [ ] Event handler resolves map key dynamically (not captured at creation)
- [ ] LID remapping mid-turn does not drop events
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
