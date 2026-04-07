# LEAK-10 Output

<!-- BEAD_OUTPUT_COMPLETE -->

- Bead: LEAK-10 — module-level Set/Map eviction
- Branch: fix/leak-10-module-sets
- Commit: pending
- Summary: Added FIFO caps for replayed admin message IDs and created workspace media directories, plus opportunistic TTL pruning for group-resolution retry cache, with focused regression coverage.

## Files Changed
- src/core/admin.ts
- src/runtimes/agent/runtime.ts
- src/fleet/group-resolver.ts
- tests/core/admin.test.ts
- tests/runtimes/agent/prepare-content.test.ts
- tests/fleet/group-resolver.test.ts
- bead-output.md

## Verification
- `npx vitest run --pool=forks tests/core/admin.test.ts tests/runtimes/agent/prepare-content.test.ts tests/fleet/group-resolver.test.ts` ✅
- `npm run typecheck` ✅
- `npm run typecheck:all` ✅
- `npx vitest run --pool=forks` ✅ (200 files, 3762 tests)

## Notes
- `replayedIds` now evicts oldest entries after 10,000 IDs.
- `createdMediaDirs` now evicts oldest directory entries after 5,000 paths; redundant future `mkdirSync(..., { recursive: true })` calls remain safe.
- `attemptedCache` now opportunistically prunes expired retry entries every 10 minutes before evaluating new group metadata backfills.
