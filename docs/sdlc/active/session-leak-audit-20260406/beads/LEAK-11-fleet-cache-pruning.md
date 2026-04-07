# Bead: LEAK-11 — Fleet Cache Pruning for Deleted Instances

**BeadID:** LEAK-11

**Status:** merged
**Type:** implement
**Runner:** —
**Dependencies:** none
**Scope:** `src/fleet/health-poller.ts`, `src/fleet/realtime-event-poller.ts`, `src/fleet/routes/lines.ts`
**Input:** Audit finding: fleet caches retain entries for deleted instances indefinitely
**Output:** Caches pruned against live instance list on each poll/sweep cycle
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

Three fleet components maintain per-instance caches that never prune entries for instances removed from discovery:

### 1. `HealthPoller.statuses` — `health-poller.ts:26`
```typescript
private statuses: Map<string, InstanceStatus> = new Map();
```
`poll()` writes results for discovered instances but never deletes entries for removed instances. `getStatus(name)` returns stale data for deleted instances.

### 2. `FleetRealtimeEventPoller.snapshots` — `realtime-event-poller.ts:52`
```typescript
private snapshots = new Map<string, InstanceSnapshot>();
```
Same pattern — snapshots accumulate for instances that no longer exist.

### 3. Line stats caches — `routes/lines.ts:92-207`
Five Maps (`messageStatsCache`, `sessionCountCache`, `chatCountsCache`, `tokenStatsCache`, `lastActiveCache`) with per-instance entries that linger after instance deletion.

## Implementation Spec

### 1. `HealthPoller.poll()` — prune after polling

At the end of `poll()`, after writing results for all discovered instances:

```typescript
// Prune entries for instances no longer in discovery
const discoveredNames = new Set(instances.map(i => i.name));
for (const name of this.statuses.keys()) {
  if (!discoveredNames.has(name)) {
    this.statuses.delete(name);
  }
}
```

### 2. `FleetRealtimeEventPoller.poll()` — prune after snapshot

Similar pattern at the end of the poll method:

```typescript
const discoveredNames = new Set(instances.map(i => i.name));
for (const name of this.snapshots.keys()) {
  if (!discoveredNames.has(name)) {
    this.snapshots.delete(name);
  }
}
```

### 3. Line stats caches — prune in the route handler

Add a helper that runs before returning cached results:

```typescript
function pruneStaleCache(cache: Map<string, any>, validNames: Set<string>): void {
  for (const key of cache.keys()) {
    if (!validNames.has(key)) cache.delete(key);
  }
}

// In the /api/lines handler, after getting instances:
const validNames = new Set(instances.map(i => i.name));
pruneStaleCache(messageStatsCache, validNames);
pruneStaleCache(sessionCountCache, validNames);
pruneStaleCache(chatCountsCache, validNames);
pruneStaleCache(tokenStatsCache, validNames);
pruneStaleCache(lastActiveCache, validNames);
```

## Maybe I'm Wrong

### Assumption: Instances are actually deleted in practice
**Validation needed:** How are instances removed? Is deletion common?
- Instances are discovered via filesystem scan (`discovery.ts:scan()`). An instance is "deleted" when its config file or directory is removed. `scan()` does `this.instances.clear()` then rebuilds, so deleted instances disappear from discovery immediately.
- In practice, instance deletion is rare (reconfiguration, decommissioning). But it does happen, and stale data is a correctness bug even if rare.
- **Verdict: Low frequency, but the fix is trivial and prevents stale data.**

### Assumption: Stale health data causes real problems
**Validation needed:** Who consumes `getStatus()`?
- The fleet dashboard consumes health statuses. A deleted instance showing as "healthy" or "degraded" in the dashboard is confusing.
- The realtime event poller uses snapshots for diff-based change detection. Stale snapshots for deleted instances waste memory but don't cause incorrect behavior (no events will be generated for a non-existent instance).
- **Verdict: Dashboard correctness is the main concern. Low severity but worth fixing.**

### Risk: Prune-during-poll race condition
**Assessment:** JavaScript is single-threaded. The prune runs synchronously at the end of the poll cycle, after all results are written. No race possible.
- **Verdict: Safe.**

## Required Tests

### Test 1: HealthPoller prunes deleted instances
```
GIVEN a HealthPoller with statuses for instances A, B, C
WHEN poll() runs and discovery returns only A and B
THEN statuses.has('C') === false
AND statuses.has('A') === true AND statuses.has('B') === true
```
**Durable:** Tests the Map state directly — no timing dependency.
**Repeatable:** Deterministic — mocked discovery response.
**Observable:** Assert on Map contents after poll.
**Provable:** Map.has() returns boolean — pass/fail is unambiguous.

### Test 2: RealtimeEventPoller prunes deleted instances
```
GIVEN a RealtimeEventPoller with snapshots for instances A, B
WHEN poll() runs and discovery returns only A
THEN snapshots.has('B') === false AND snapshots.has('A') === true
```

### Test 3: Line caches prune deleted instances
```
GIVEN messageStatsCache has entries for instances A, B, C
WHEN pruneStaleCache is called with validNames = {'A', 'B'}
THEN cache.has('C') === false
AND cache.size === 2
```

## Verification

1. `npm run typecheck` — zero errors
2. `npx vitest run` — all tests pass
3. New tests for prune behavior (3 tests as specified above)

## Acceptance Criteria

- [ ] `HealthPoller.poll()` prunes entries for undiscovered instances
- [ ] `FleetRealtimeEventPoller.poll()` prunes stale snapshots
- [ ] Line stats caches are pruned on each request
- [ ] 3 new unit tests covering prune behavior
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
