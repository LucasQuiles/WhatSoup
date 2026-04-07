# Bead: SILENT-03 — Per-Chat Crash Count Instead of Global

**BeadID:** SILENT-03

**Status:** merged
**Type:** implement
**Runner:** —
**Dependencies:** none
**Scope:** `src/runtimes/agent/runtime.ts`
**Input:** Audit finding: `recentCrashCount` is global — one bad chat exhausts auto-respawn for all
**Output:** Per-chat crash tracking
**Cynefin domain:** clear
**Security sensitive:** false
**Profile:** REPAIR
**Deterministic checks:** `npm run typecheck`, `npx vitest run`
**Turbulence:** L0: 0, L1: 0, L2: 1
**Loop depth:** L0 + L1 + L2
**Status:** pending → running → submitted → verified → proven → hardened → reliability-proven → merged
**Current loop:** —
**Bridge sync:** false

## Root Cause

At runtime.ts:~522-532:
```typescript
private recentCrashCount = 0;
private lastCrashAt: string | null = null;
private recordCrash(): void {
  this.recentCrashCount++;
  this.lastCrashAt = new Date().toISOString();
}
```

These are global counters shared across ALL per_chat sessions. `AUTO_RESPAWN_MAX_CRASHES = 3` is checked against this global count at ~L2137. If 3 different chats each crash once, the global count hits 3 and ALL chats are denied auto-respawn. One flapping chat can exhaust the limit for healthy chats.

The counter is decremented at ~L1327 on successful spawn in `sendTurnToSession` — but only when ANY chat's session spawns successfully, which credits all chats equally.

## Implementation Spec

Replace global counters with a per-mapKey Map:

```typescript
private perChatCrashCount: Map<string, number> = new Map();

private recordCrash(mapKey: string): void {
  const count = (this.perChatCrashCount.get(mapKey) ?? 0) + 1;
  this.perChatCrashCount.set(mapKey, count);
}

private getCrashCount(mapKey: string): number {
  return this.perChatCrashCount.get(mapKey) ?? 0;
}

private decrementCrashCount(mapKey: string): void {
  const count = this.perChatCrashCount.get(mapKey) ?? 0;
  if (count > 0) this.perChatCrashCount.set(mapKey, count - 1);
}
```

Update `handlePerChatCrash` to use per-chat count:
```typescript
this.recordCrash(mapKey);
if (this.getCrashCount(mapKey) > AUTO_RESPAWN_MAX_CRASHES) {
  // Don't respawn THIS chat, but other chats are unaffected
}
```

Add `perChatCrashCount` to `cleanupPerChatState` (LEAK-01).

For single/shared mode, keep a single key `'_global'`.

## Maybe I'm Wrong

### Assumption: Cross-chat blast radius happens in practice
**Validation:** In per_chat mode with 5+ active chats, if one chat has a bug that causes repeated crashes (e.g., a tool that always fails), it crashes 3 times quickly, hitting the global limit. Other chats that crash for unrelated reasons are denied respawn.
**Verdict: Confirmed architecture issue.** The probability depends on crash frequency, but the design is fundamentally wrong for multi-chat deployments.

## Required Tests

### Test 1: Chat A crashing 3 times doesn't block chat B's respawn
```
GIVEN chat A has crashed 3 times (at AUTO_RESPAWN_MAX_CRASHES)
WHEN chat B crashes for the first time
THEN chat B's auto-respawn is still allowed
```

### Test 2: Per-chat crash count is independent
```
GIVEN chats A, B, C each crash once
WHEN checking respawn eligibility for each
THEN each has crashCount=1 (not 3)
AND all three are eligible for respawn
```

## Verification

1. `npm run typecheck` — zero errors
2. `npx vitest run` — all tests pass

## Acceptance Criteria

- [ ] Crash count tracked per mapKey, not globally
- [ ] One chat's crashes don't affect other chats' respawn eligibility
- [ ] Added to `cleanupPerChatState` helper
- [ ] Single/shared mode still works with a single global key
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
