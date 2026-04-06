# LEAK-01 Output

<!-- BEAD_OUTPUT_COMPLETE -->

- Bead: LEAK-01 — per-chat cleanup helper
- Branch: fix/leak-01-cleanup-helper
- Commit: 8e9f850
- Summary: Added a private `cleanupPerChatState(mapKey)` helper that deletes all six auxiliary per-chat maps/sets and routed failed sandbox workspace cleanup through it so abandoned per-chat state does not linger.

## Files Changed
- src/runtimes/agent/runtime.ts
- tests/runtimes/agent/runtime.test.ts

## Verification
- `grep -nE 'private .*Map<string|private .*Set<string' src/runtimes/agent/runtime.ts` ✅ verified the six auxiliary per-chat structures covered by the helper
- `npx vitest run tests/runtimes/agent/runtime.test.ts --pool=forks` ✅ (74 tests passed)
- `npm run typecheck` ✅
- `npx vitest run` ✅ on rerun (197 files, 3,709 tests passed)
- `git push -u origin fix/leak-01-cleanup-helper` ✅

## Notes
- The first full-suite run hit an unrelated transient failure in `tests/runtimes/agent/session.test.ts`; a targeted rerun passed immediately and the subsequent fresh full-suite rerun was fully green.
