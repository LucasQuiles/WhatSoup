# LEAK-03 Output

<!-- BEAD_OUTPUT_COMPLETE -->

- Bead: LEAK-03 — wire per-chat cleanup into shutdown
- Branch: fix/leak-03-wire-shutdown
- Commit: 013c6c1
- Summary: Routed per-chat shutdown through `cleanupPerChatState(mapKey)` for every tracked chat key after session/queue teardown, and added regressions covering helper invocation, auxiliary-state cleanup, and shutdown ordering.

## Files Changed
- src/runtimes/agent/runtime.ts
- tests/runtimes/agent/runtime.test.ts
- bead-output.md

## Verification
- `npx vitest run --pool=forks tests/runtimes/agent/runtime.test.ts -t "per_chat shutdown"` ✅
- `npx vitest run --pool=forks tests/runtimes/agent/runtime.test.ts` ✅
- `npm run typecheck` ✅
- `npm run typecheck:all` ✅
- `npx vitest run --pool=forks` ⚠️ blocked by pre-existing `tests/console/line-detail-ds-compliance-round2.test.ts`
- `cd /home/q/LAB/WhatSoup && npx vitest run --pool=forks tests/console/line-detail-ds-compliance-round2.test.ts` ⚠️ same failure reproduced on repo main (`GroupDetailModal` missing `maxHeight: 'var(--modal-max-h)'`)

## Notes
- Shutdown now snapshots per-chat keys before clearing `chatSessions` / `chatQueues`, then calls `cleanupPerChatState(mapKey)` once per key.
- The new ordering test verifies each session still sees its replay/auxiliary state during `session.shutdown()`, and cleanup only happens afterwards.
- Global `.clear()` calls remain as a final sweep for any stale per-chat state not anchored to an active session/queue key.
