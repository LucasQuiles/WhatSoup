# RACE-02 Output

<!-- BEAD_OUTPUT_COMPLETE -->

- Bead: RACE-02 — non-sandboxed per_chat concurrent spawn
- Branch: fix/race-02-perchat-concurrent-spawn
- Commit: e4ebfee
- Summary: Added a regression proving same-chat non-sandboxed `per_chat` messages stay serialized behind the pending `spawnSession()` on `turnChain`, so the suspected double-spawn race is not reachable and no runtime mutex change is required.

## Files Changed
- tests/runtimes/agent/runtime.test.ts
- bead-output.md

## Verification
- `npx vitest run tests/runtimes/agent/runtime.test.ts -t "non-sandboxed per_chat serializes same-chat messages while spawnSession is pending" --pool=forks` ✅
- `npx vitest run tests/runtimes/agent/runtime.test.ts --pool=forks` ✅
- `npm run typecheck` ✅
- `npx vitest run --pool=forks` ✅
- `git push -u origin fix/race-02-perchat-concurrent-spawn` ⏳

## Notes
- `handleMessage()` chains `_handleMessageInner()` onto `turnChain`, and the per-chat path fully awaits `sendTurnPerChat()` → `sendTurnToSession()` → `spawnSession()`, so a second same-chat message cannot enter the spawn path until the first finishes.
- The new test blocks `spawnSession()` mid-flight, sends two rapid messages for the same chat, and proves only one `spawnSession()` happens while both user turns are eventually delivered in order.
