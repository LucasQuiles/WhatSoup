import { vi } from 'vitest';

/**
 * Real-time bound, so a capture that never settles fails here with a named error
 * before the 10 s test timeout, under fake and real timers alike. Vitest 4 fakes
 * hrtime, performance and setTimeout too, so the real clock and timer are
 * captured when this module loads (static imports run before any test installs
 * fake timers). A step count is not a usable bound either: each fake-timer step
 * yields one real turn, so 50,000 steps lasted about 0.2 s of real time.
 */
const SETTLE_BUDGET_NS = 8_000_000_000n;
const NOT_SETTLED = 'auth-bond capture did not settle within 8 s of real time';
const realNowNs = process.hrtime.bigint;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realSetImmediate = globalThis.setImmediate;
const PINNED_NEEDS_REAL_IMMEDIATES =
  'settleAuthBondCapture({ advanceClockMs: 0 }) needs a real setImmediate; install fake timers with useFakeTimersKeepingImmediates()';
if (vi.isFakeTimers()) throw new Error('auth-bond-capture helper loaded under fake timers; its real clock would be fake');

/**
 * Fake timers for a test that settles a capture with the clock pinned
 * (`advanceClockMs: 0`): every default fake except setImmediate/clearImmediate.
 *
 * A capture moves between steps on setImmediate. Under fake timers an immediate
 * queued while the clock is ticking (from a continuation of the immediate that
 * just fired) is due 1 ms later, not now, so a 0 ms advance never reaches it and
 * the capture stops after its first step. With real immediates the capture
 * runs on real turns and the fake clock stays exactly where the test put it.
 */
export function useFakeTimersKeepingImmediates(): void {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance', 'hrtime'],
  });
}

interface CaptureHolder {
  authSnapshotCapture: Promise<void> | null;
}

/** The timer pair the real-timer wait arms its deadline with; a test passes recording wrappers. */
interface DeadlineTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const REAL_TIMERS: DeadlineTimers = {
  setTimeout: (callback, ms) => realSetTimeout(callback, ms),
  clearTimeout: (handle) => realClearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Wait for `pending` until `deadlineNs` on the real clock; the timer is cleared either way. */
async function awaitByDeadline(pending: Promise<void>, deadlineNs: bigint, timers: DeadlineTimers): Promise<void> {
  const remainingMs = Math.max(0, Number((deadlineNs - realNowNs()) / 1_000_000n));
  let timer: unknown;
  const expired = new Promise<never>((_, reject) => {
    timer = timers.setTimeout(() => reject(new Error(NOT_SETTLED)), remainingMs);
  });
  try {
    await Promise.race([pending, expired]);
  } finally {
    timers.clearTimeout(timer);
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
 * assertion pins exact fake timestamps. That needs a real setImmediate (see
 * useFakeTimersKeepingImmediates, enforced here) and cannot drive a capture
 * that waits on a retry timer. Under real timers the
 * capture runs by itself and is awaited against the same real-time bound, on
 * a deadline timer armed through `timers` (the real timers by default).
 */
export async function settleAuthBondCapture(
  manager: object,
  options: { advanceClockMs?: number; timers?: DeadlineTimers } = {},
): Promise<void> {
  const advanceClockMs = options.advanceClockMs ?? 1;
  const timers = options.timers ?? REAL_TIMERS;
  const holder = manager as CaptureHolder;
  for (;;) {
    const pending = holder.authSnapshotCapture;
    if (pending === null) return;
    const deadlineNs = realNowNs() + SETTLE_BUDGET_NS;
    if (vi.isFakeTimers()) {
      if (advanceClockMs === 0 && globalThis.setImmediate !== realSetImmediate) throw new Error(PINNED_NEEDS_REAL_IMMEDIATES);
      let settled = false;
      void pending.then(() => { settled = true; });
      while (!settled) {
        if (realNowNs() >= deadlineNs) throw new Error(NOT_SETTLED);
        await vi.advanceTimersByTimeAsync(advanceClockMs);
      }
    } else {
      await awaitByDeadline(pending, deadlineNs, timers);
    }
    // A trigger handled while this one settled replaces it; wait for that too.
    if (holder.authSnapshotCapture === pending) return;
  }
}
