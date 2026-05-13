/**
 * Test helper: wait until the ingest pipeline is fully drained.
 *
 * Replaces `await new Promise(r => setTimeout(r, 0))` / `setImmediate(r)`
 * style "drains" that flush *a* microtask/macrotask tick but offer no
 * guarantee that the fire-and-forget IIFE inside `createIngestHandler`
 * (admin routing, storeMessageIfNew, journaling, runtime.handleMessage,
 * messenger.sendMessage, etc.) has actually completed.
 *
 * Uses the live `getIngestStats()` counters that `acquireSlot`/`releaseSlot`
 * mutate — when `active === 0 && queued === 0`, every dispatched message
 * has either returned, released its slot, or rejected.
 *
 * Pattern reference: `tests/core/ingest-backpressure.test.ts`.
 */
import { vi } from 'vitest';
import { getIngestStats } from '../../../src/core/ingest.ts';

export async function drainIngest(timeoutMs = 5_000): Promise<void> {
  await vi.waitFor(
    () => {
      const s = getIngestStats();
      if (s.active !== 0 || s.queued !== 0) {
        throw new Error(
          `ingest not drained: active=${s.active} queued=${s.queued} dropped=${s.dropped}`,
        );
      }
    },
    { timeout: timeoutMs, interval: 5 },
  );
}
