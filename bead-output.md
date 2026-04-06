<!-- BEAD_OUTPUT_COMPLETE -->
# RACE-04 Bead Output

- Bead: RACE-04 — activeToolNames isolation
- Implementation commit: `ccc0dc0`
- Branch: `fix/race-04-active-tool-names-isolation`

## Verification
- `npm run typecheck` ✅
- `npx vitest run` ✅ — 196 files, 3695 tests passed
- Targeted regression: `npx vitest run tests/runtimes/agent/runtime.test.ts -t "per_chat late result from a replaced session does not wipe the new session tool name scope|per_chat result from one chat leaves another chat tool name scope intact"` ✅

## Files Changed
- `src/runtimes/agent/runtime.ts`
- `tests/runtimes/agent/runtime.test.ts`
- `bead-output.md`

## Summary
- Moved tool-name tracking to session-scoped buckets instead of a single shared map.
- Bound per-chat session event closures to stable tool scope keys so late `/new` results cannot wipe the replacement session state.
- Added two regressions covering replaced-session and cross-chat result isolation.
