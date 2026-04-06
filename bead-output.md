<!-- BEAD_OUTPUT_COMPLETE -->
# LEAK-07 Bead Output

- Bead: LEAK-07 — track and cancel auto-respawn timers
- Implementation commit: `8a294d7`
- Branch: `fix/leak-07-respawn-timer-tracking`

## Verification
- `npx vitest run tests/runtimes/agent/runtime.test.ts -t "tracks pending auto-respawn timers per crash and removes them after firing|shutdown clears pending auto-respawn timers before per_chat session cleanup"` ✅
- `npm run typecheck` ✅
- `npx vitest run --pool=forks` ✅ — 198 files, 3,729 tests passed

## Files Changed
- `src/runtimes/agent/runtime.ts`
- `tests/runtimes/agent/runtime.test.ts`
- `bead-output.md`

## Summary
- Added `pendingRespawnTimers` tracking on `AgentRuntime` so per-chat auto-respawn timers are stored when scheduled and removed when they fire.
- Cleared every pending respawn timer during `shutdown()` before per-chat session cleanup begins, preventing timers from surviving teardown.
- Added regressions covering both timer self-removal after respawn and shutdown-time cancellation ordering.
