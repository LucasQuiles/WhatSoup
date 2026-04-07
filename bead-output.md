# RACE-01 Output

<!-- BEAD_OUTPUT_COMPLETE -->

- Bead: RACE-01 — mid-turn LID remap event drop
- Branch: fix/race-01-lid-remap-event-drop
- Commit: 7956e16
- Summary: Reworked non-sandbox per-chat session callbacks to resolve their live map key from the current session registration, so assistant/result/crash callbacks survive LID→phone remaps, and expanded alias remapping to carry the remaining per-chat state atomically onto the canonical key.

## Files Changed
- src/runtimes/agent/runtime.ts
- tests/runtimes/agent/runtime.test.ts
- tests/console/line-detail-ds-compliance-round2.test.ts
- bead-output.md

## Verification
- `npx vitest run tests/runtimes/agent/runtime.test.ts` ✅
- `npm run typecheck` ✅
- `npx vitest run tests/console/line-detail-ds-compliance-round2.test.ts` ✅
- `npx vitest run` ✅ (199 files, 3,751 tests)

## Notes
- Added three runtime regressions covering atomic per-chat re-keying, result delivery after remap, and mid-stream assistant text delivery across remap.
- `handleJidAliasChanged()` now migrates crash counters and resume-failed ownership alongside the existing per-chat maps before clearing the old LID key.
- Synced a stale worktree-only design-system test expectation back to current `main` so the full suite reflects the branch base rather than an outdated local copy.
