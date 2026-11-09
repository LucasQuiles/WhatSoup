import { vi } from 'vitest';

/** A bound on wait steps, so a capture that never settles fails the test instead of hanging it. */
const MAX_TURNS = 50_000;

interface CaptureHolder {
  authSnapshotCapture: Promise<void> | null;
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
 * cannot drive a capture that waits on a retry timer.
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
    let settled = false;
    void pending.then(() => { settled = true; });
    for (let turn = 0; !settled; turn += 1) {
      if (turn >= MAX_TURNS) throw new Error('auth-bond capture did not settle');
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(advanceClockMs);
      else await pending;
    }
    // A trigger handled while this one settled replaces it; wait for that too.
    if (holder.authSnapshotCapture === pending) return;
  }
}
