import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { settleAuthBondCapture } from '../helpers/auth-bond-capture.ts';

// Real timers, captured before any test installs fake ones: they stand in for
// capture file I/O, which completes in real time while the fake clock is held.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

describe('settleAuthBondCapture', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for a capture held 2 s by real-time work with the fake clock pinned (advanceClockMs: 0)', async () => {
    const fakeStart = Date.now();
    let release: ReturnType<typeof setTimeout> | undefined;
    const holder = {
      authSnapshotCapture: new Promise<void>((resolve) => {
        release = realSetTimeout(resolve, 2_000);
      }) as Promise<void> | null,
    };
    try {
      await settleAuthBondCapture(holder, { advanceClockMs: 0 });
    } finally {
      realClearTimeout(release);
    }
    // The fake clock did not move, so exact-timestamp assertions after a settle stay valid.
    expect(Date.now()).toBe(fakeStart);
  });

  it('fails with the named error when a capture never settles', async () => {
    const holder = { authSnapshotCapture: new Promise<void>(() => {}) as Promise<void> | null };
    await expect(settleAuthBondCapture(holder, { advanceClockMs: 0 })).rejects.toThrow(
      'auth-bond capture did not settle within 8 s of real time',
    );
  }, 15_000);
});
