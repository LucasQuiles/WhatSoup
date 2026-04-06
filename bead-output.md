<!-- BEAD_OUTPUT_COMPLETE -->
# RACE-03 Bead Output

- Bead: RACE-03 — SQLITE_BUSY orphaned child cleanup
- Implementation commit: `c765928`
- Branch: `fix/race-03-sqlite-busy-orphan`

## Verification
- `npx vitest run tests/runtimes/agent/session.test.ts -t "db failure during spawn kills the child and resets session state|db failure during spawn does not block a later successful retry"` ✅ (2 tests)
- `npx vitest run tests/runtimes/agent/session.test.ts` ✅ (59 tests)
- `npm run typecheck` ✅
- `npx vitest run` ✅ — 197 files, 3708 tests passed

## Files Changed
- `src/runtimes/agent/session.ts`
- `tests/runtimes/agent/session.test.ts`
- `bead-output.md`

## Summary
- Wrapped the post-spawn session DB write in a failure boundary so `createSession`/`updateSessionStatus` errors no longer leave an untracked child running.
- On DB persistence failure, the spawned child is force-killed, runtime/session state is reset, and the original error is re-thrown for caller handling.
- Added regressions covering both immediate cleanup on SQLITE_BUSY and successful retry after the failed spawn.
