import { vi } from 'vitest';

/**
 * Real-time bound, so a capture that never settles fails here with a named error
 * before the 10 s test timeout, under fake and real timers alike. Vitest 4 fakes
 * hrtime, performance and setTimeout too, so the real clock and timer are
 * captured when this module loads (static imports run before any test installs
 * fake timers). A step count is not a usable bound: each fake-timer step yields
 * one real setImmediate turn, so 50,000 steps lasted about 0.2 s and a capture
 * whose file I/O waited on a busy libuv threadpool (a loaded test slot) "did not
 * settle" although it would have.
 */
const SETTLE_BUDGET_NS = 8_000_000_000n;
const NOT_SETTLED = 'auth-bond capture did not settle within 8 s of real time';
const realNowNs = process.hrtime.bigint;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
if (vi.isFakeTimers()) throw new Error('auth-bond-capture helper loaded under fake timers; its real clock would be fake');

interface CaptureHolder {
  authSnapshotCapture: Promise<void> | null;
}

/** Wait for `pending` until `deadlineNs` on the real clock; the timer is cleared either way. */
async function awaitByDeadline(pending: Promise<void>, deadlineNs: bigint): Promise<void> {
  const remainingMs = Math.max(0, Number((deadlineNs - realNowNs()) / 1_000_000n));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = realSetTimeout(() => reject(new Error(NOT_SETTLED)), remainingMs);
  });
  try {
    await Promise.race([pending, expired]);
  } finally {
    realClearTimeout(timer);
  }
}

/**
 * Wait until ConnectionManager has handled its most recent auth-bond capture,
 * including any re-run queued behind it.
 *
 * A capture runs off the event loop (#3677): its walks resume on setImmediate
 * and a deferred retry waits on setTimeout, both held by fake timers, while its
 * file I/O completes in real time. Under fake timers each step therefore
 * advances the fake clock by `advanceClockMs`, and advanceTimersByTimeAsync
 * also yields real turns for the I/O. Pass `advanceClockMs: 0` where a later
 * assertion pins exact fake timestamps; that runs due immediates only, so it
 * cannot drive a capture that waits on a retry timer. Under real timers the
 * capture runs by itself and is awaited against the same real-time bound.
 */
export async function settleAuthBondCapture(
  manager: object,
  options: { advanceClockMs?: number } = {},
): Promise<void> {
  const advanceClockMs = options.advanceClockMs ?? 1;
  const holder = manager as CaptureHolder;
  for (;;) {
    const pending = holder.authSnapshotCapture;
    if (pending === null) return;
    const deadlineNs = realNowNs() + SETTLE_BUDGET_NS;
    if (vi.isFakeTimers()) {
      let settled = false;
      void pending.then(() => { settled = true; });
      while (!settled) {
        if (realNowNs() >= deadlineNs) throw new Error(NOT_SETTLED);
        await vi.advanceTimersByTimeAsync(advanceClockMs);
      }
    } else {
      await awaitByDeadline(pending, deadlineNs);
    }
    // A trigger handled while this one settled replaces it; wait for that too.
    if (holder.authSnapshotCapture === pending) return;
  }
}
