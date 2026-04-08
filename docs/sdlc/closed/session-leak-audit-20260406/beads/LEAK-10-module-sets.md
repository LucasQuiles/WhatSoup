# Bead: LEAK-10 — Module-Level Unbounded Set/Map Eviction

**BeadID:** LEAK-10

**Status:** merged
**Type:** implement
**Runner:** —
**Dependencies:** none
**Scope:** `src/core/admin.ts`, `src/runtimes/agent/runtime.ts`, `src/fleet/group-resolver.ts`
**Input:** Audit finding: 3 module-level Sets/Maps grow without bound
**Output:** TTL or size-based eviction for each
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

Three module-level data structures accumulate entries for the process lifetime with no eviction:

### 1. `replayedIds` — `src/core/admin.ts:17`
```typescript
const replayedIds = new Set<string>();
```
Stores every message ID replayed via `allow` command. One entry per replayed message, never pruned. UUIDs (~36 bytes each).

### 2. `createdMediaDirs` — `src/runtimes/agent/runtime.ts:59`
```typescript
const createdMediaDirs = new Set<string>();
```
Stores every workspace media directory path that has been `mkdirSync`'d. One entry per unique chat workspace, never cleared. Path strings (~80 bytes each).

### 3. `attemptedCache` — `src/fleet/group-resolver.ts:23`
```typescript
const attemptedCache = new Map<string, number>();
```
Stores timestamp of last group-resolution attempt per `instanceName:groupKey`. One entry per unique instance+group pair, never evicted. Used to rate-limit retries to once per 5 minutes.

## Implementation Spec

### 1. `replayedIds` — Size-capped Set

Replace with a simple bounded Set that evicts oldest entries:

```typescript
const MAX_REPLAYED_IDS = 10_000;
const replayedIds = new Set<string>();

// In the replay function, after adding:
replayedIds.add(messageId);
if (replayedIds.size > MAX_REPLAYED_IDS) {
  // Delete oldest (first inserted — Set maintains insertion order)
  const first = replayedIds.values().next().value;
  if (first !== undefined) replayedIds.delete(first);
}
```

### 2. `createdMediaDirs` — Size-capped Set

Same pattern. Worst case: `mkdirSync` is called twice for an evicted directory (no-op because `recursive: true`):

```typescript
const MAX_MEDIA_DIRS = 5_000;
const createdMediaDirs = new Set<string>();

// After adding:
createdMediaDirs.add(dirPath);
if (createdMediaDirs.size > MAX_MEDIA_DIRS) {
  const first = createdMediaDirs.values().next().value;
  if (first !== undefined) createdMediaDirs.delete(first);
}
```

### 3. `attemptedCache` — TTL-based pruning

The cache already stores timestamps. Add a periodic prune:

```typescript
const RETRY_MS = 5 * 60 * 1000; // already defined
const PRUNE_INTERVAL_MS = 10 * 60 * 1000; // every 10 minutes

// On every cache check, opportunistically prune if needed:
let lastPrune = 0;

function shouldRetryGroupResolution(key: string): boolean {
  const now = Date.now();

  // Opportunistic prune
  if (now - lastPrune > PRUNE_INTERVAL_MS) {
    lastPrune = now;
    for (const [k, ts] of attemptedCache) {
      if (now - ts > RETRY_MS) attemptedCache.delete(k);
    }
  }

  const last = attemptedCache.get(key);
  if (last && now - last < RETRY_MS) return false;
  attemptedCache.set(key, now);
  return true;
}
```

## Maybe I'm Wrong

### Assumption: These grow large enough to matter
**Validation needed:** What's the realistic growth rate?
- `replayedIds`: Only populated when an admin runs `allow` on blocked messages. Typical usage: 0-10 entries per day. Even over months, unlikely to exceed 1000. **Low practical impact** but trivially fixable.
- `createdMediaDirs`: One entry per unique chat that receives media in `sandboxPerChat` mode. A bot with 100 active chats over weeks accumulates ~100 entries. **Very low practical impact.**
- `attemptedCache`: One entry per instance+group pair. A fleet with 10 instances, each with 50 groups = 500 entries. Over time, groups are added/removed but entries for removed groups stay. **Low practical impact** for typical fleet sizes.
- **Verdict: None of these are urgent.** The fixes are simple and defensive — worth doing for correctness, but this is the lowest priority bead.

### Assumption: Set insertion order is reliable for eviction
**Validation needed:** Does JavaScript Set maintain insertion order?
- ECMAScript spec guarantees Sets iterate in insertion order. `values().next().value` returns the first inserted element.
- **Verdict: Confirmed.** This is a valid poor-man's LRU for dedup Sets.

### Risk: `mkdirSync` redundant calls after eviction from `createdMediaDirs`
**Assessment:** `mkdirSync` with `{ recursive: true }` is a no-op if the directory exists. The guard is purely a performance optimization to avoid the syscall. Evicting from the Set just means an occasional redundant syscall. Zero correctness risk.
- **Verdict: Safe.**

## Verification

1. `npm run typecheck` — zero errors
2. `npx vitest run` — all tests pass

## Acceptance Criteria

- [ ] `replayedIds` capped at 10,000 entries with FIFO eviction
- [ ] `createdMediaDirs` capped at 5,000 entries with FIFO eviction
- [ ] `attemptedCache` pruned of expired entries every 10 minutes
- [ ] No behavioral changes to calling code
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
