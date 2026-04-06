<!-- BEAD_OUTPUT_COMPLETE -->
# LEAK-02 Bead Output

- Bead: LEAK-02 — wire cleanup into crash paths
- Implementation commit: `640faf2`
- Branch: `fix/leak-02-wire-crash-paths`

## Verification
- `grep -n 'chatSessions.delete\|chatQueues.delete' src/runtimes/agent/runtime.ts` ✅ (audited current deletion sites before wiring cleanup)
- `npx vitest run tests/runtimes/agent/runtime.test.ts -t "preserve replay text|LEAK-02 structurally wires cleanup|startup proactive-resume notifyUser cleanup|sandbox per_chat notifyUser cleanup|handleJidAliasChanged cleans the old key"` ✅ (5 targeted regressions)
- `npx vitest run tests/runtimes/agent/runtime.test.ts` ✅ (78 tests)
- `npm run typecheck` ✅
- `npx vitest run` ✅ — 197 files, 3713 tests passed

## Files Changed
- `src/runtimes/agent/runtime.ts`
- `tests/runtimes/agent/runtime.test.ts`
- `bead-output.md`

## Summary
- Wired `cleanupPerChatState()` into the proactive-resume crash notify path plus sandbox/non-sandbox per-chat session creation callbacks when a dead session is removed from the maps.
- Added defensive old-key cleanup after LID→phone re-keying so stale auxiliary state cannot linger under the retired key.
- Narrowed crash-turn cleanup to turn-scoped maps only, preserving pending replay text and inbound sequencing needed by resume-failure recovery.
