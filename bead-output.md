<!-- BEAD_OUTPUT_COMPLETE -->
# LEAK-05 Bead Output

- Bead: LEAK-05 — shared-mode outbound queue pruning
- Implementation commit: `58000f7`
- Branch: `fix/leak-05-shared-queue-pruning`

## Verification
- `npx vitest run tests/runtimes/agent/runtime.test.ts tests/runtimes/agent/outbound-queue.test.ts -t "sweepIdleQueues evicts idle|sweepIdleQueues preserves recently active|sweepIdleQueues preserves queues with pending work|ensureOutboundQueue recreates|queue sweep timer is started|queue sweep timer is unrefd|tracks lastActivity when text is enqueued|flush updates lastActivity and clears pending work state"` ✅ (8 targeted regressions)
- `npx vitest run tests/runtimes/agent/runtime.test.ts tests/runtimes/agent/outbound-queue.test.ts` ✅ (125 tests)
- `npm run typecheck` ✅
- `npx vitest run` ✅ — 197 files, 3725 tests passed

## Files Changed
- `src/runtimes/agent/outbound-queue.ts`
- `src/runtimes/agent/runtime.ts`
- `tests/runtimes/agent/outbound-queue.test.ts`
- `tests/runtimes/agent/runtime.test.ts`
- `bead-output.md`

## Summary
- Added shared-queue idle pruning with a 10-minute unref'd sweep timer, a 1-hour idle threshold, and shutdown cleanup for the sweep interval.
- Outbound queues now expose `lastActivity` plus `hasPendingWork()` so eviction skips active buffers, typing state, and in-flight sends while pruning truly idle queues.
- Added regressions covering idle eviction, recent/pending preservation, on-demand queue recreation, timer lifecycle, and queue activity tracking.
