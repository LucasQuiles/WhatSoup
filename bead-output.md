# SILENT-03 Output

<!-- BEAD_OUTPUT_COMPLETE -->

- Bead: SILENT-03 — per-chat crash count instead of global
- Branch: fix/silent-03-global-crash-count
- Commit: pending (reported in result message after commit)
- Summary: Replaced the global crash counter with per-chat crash tracking, kept single/shared mode on a global crash scope, decayed only the spawning chat on successful restart, and extended runtime regressions for cross-chat isolation plus cleanup coverage.

## Files Changed
- src/runtimes/agent/runtime.ts
- tests/runtimes/agent/runtime.test.ts
- bead-output.md

## Verification
- `npx vitest run tests/runtimes/agent/runtime.test.ts` ✅
- `npm run typecheck` ✅
- `npx vitest run` ✅ (199 files, 3746 tests)

## Notes
- `perChatCrashCount` is keyed by runtime mapKey for per-chat mode and by `__global__` for single/shared mode.
- `cleanupPerChatState()` now prunes crash counts alongside the existing auxiliary per-chat state maps.
- Health stats and per-chat health snapshots now report aggregate recent crash totals derived from the per-chat map.
