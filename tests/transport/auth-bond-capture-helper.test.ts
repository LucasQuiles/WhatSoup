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

// Real timers: connection-auth-bond-edge.test.ts calls the helper without fake timers.
// Cleanup is checked on the helper's own deadline timer, recorded through the `timers` option; a
// process-wide Timeout count also sees worker timers that start and end on their own.
describe('settleAuthBondCapture under real timers', () => {
  // Declared here, not imported, so this file runs unchanged against a helper without the option.
  interface DeadlineTimers {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  }
  interface ArmedTimer { handle: unknown; ms: number; fired: boolean }
  const recordingTimers = (): { armed: ArmedTimer[]; cleared: unknown[]; timers: DeadlineTimers } => {
    const armed: ArmedTimer[] = [];
    const cleared: unknown[] = [];
    const timers: DeadlineTimers = {
      setTimeout(callback, ms) {
        const record: ArmedTimer = { handle: undefined, ms, fired: false };
        record.handle = setTimeout(() => { record.fired = true; callback(); }, ms);
        armed.push(record);
        return record.handle;
      },
      clearTimeout(handle) {
        cleared.push(handle);
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
    };
    return { armed, cleared, timers };
  };

  it('waits for a capture held 200 ms and clears its deadline timer before it fires', async () => {
    expect(vi.isFakeTimers()).toBe(false);
    const holder = {
      authSnapshotCapture: new Promise<void>((resolve) => { setTimeout(resolve, 200); }) as Promise<void> | null,
    };
    const { armed, cleared, timers } = recordingTimers();
    await settleAuthBondCapture(holder, { timers });
    expect(armed).toHaveLength(1);
    expect(armed[0].ms).toBeGreaterThan(7_900);
    expect(armed[0].ms).toBeLessThanOrEqual(8_000);
    expect(armed[0].fired).toBe(false);
    expect(cleared).toEqual([armed[0].handle]);
  });

  it('fails with the named error after 8 s when a capture never settles, and clears its timer', async () => {
    expect(vi.isFakeTimers()).toBe(false);
    const holder = { authSnapshotCapture: new Promise<void>(() => {}) as Promise<void> | null };
    const { armed, cleared, timers } = recordingTimers();
    const started = process.hrtime.bigint();
    await expect(settleAuthBondCapture(holder, { timers })).rejects.toThrow(
      'auth-bond capture did not settle within 8 s of real time',
    );
    expect(process.hrtime.bigint() - started).toBeGreaterThanOrEqual(7_900_000_000n);
    expect(armed).toHaveLength(1);
    expect(armed[0].fired).toBe(true);
    expect(cleared).toEqual([armed[0].handle]);
  }, 15_000);
});
