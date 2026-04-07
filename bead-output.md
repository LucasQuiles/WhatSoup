# LEAK-11 Output

<!-- BEAD_OUTPUT_COMPLETE -->

- Bead: LEAK-11 — fleet cache pruning for deleted instances
- Branch: fix/leak-11-fleet-cache-pruning
- Commit: 8ac4265
- Summary: Pruned stale per-instance fleet health, realtime snapshot, and line-stat cache entries whenever discovery drops an instance, and added regressions covering each cache surface.

## Files Changed
- src/fleet/health-poller.ts
- src/fleet/realtime-event-poller.ts
- src/fleet/routes/lines.ts
- tests/fleet/health-poller.test.ts
- tests/fleet/realtime-event-poller.test.ts
- tests/fleet/routes/lines.test.ts
- bead-output.md

## Verification
- `npx vitest run tests/fleet/health-poller.test.ts tests/fleet/realtime-event-poller.test.ts tests/fleet/routes/lines.test.ts` ✅
- `npm run typecheck` ✅
- `npx vitest run` ✅ (199 files, 3,759 tests)

## Notes
- `HealthPoller.poll()` now deletes statuses for instances no longer returned by discovery after each poll cycle.
- `FleetRealtimeEventPoller.poll()` now drops stale snapshots for removed instances after rebuilding current snapshots.
- `routes/lines.ts` now prunes all five TTL caches on both list and detail requests and exposes narrow underscore-prefixed test helpers to reset/inspect cache state in unit tests.
