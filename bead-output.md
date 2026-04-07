# LEAK-08 Output

<!-- BEAD_OUTPUT_COMPLETE -->

- Bead: LEAK-08 — SIGTERM grace period with SIGKILL fallback
- Branch: fix/leak-08-sigterm-grace
- Commit: ea1b495
- Summary: Added a shutdown grace timer for session children, cancelled stale escalation timers on respawn/exit across persistent and spawn-per-turn providers, and covered the new lifecycle with regressions.

## Files Changed
- src/runtimes/agent/session.ts
- tests/runtimes/agent/session.test.ts
- bead-output.md

## Verification
- `npx vitest run --pool=forks tests/runtimes/agent/session.test.ts` ✅
- `npm run typecheck` ✅
- `npm run typecheck:all` ✅
- `npx vitest run --pool=forks` ✅ (199 files, 3756 tests)

## Notes
- `shutdown()` now sends SIGTERM, schedules a 5s SIGKILL fallback, and keeps cleanup fire-and-forget.
- `spawnSession()` clears any pending shutdown escalation before starting a replacement child.
- Both persistent and spawn-per-turn exit handlers clear the pending escalation timer before superseded-child guards run.
