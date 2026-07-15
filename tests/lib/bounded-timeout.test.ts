import { describe, expect, it, vi } from 'vitest';

import { TimeoutError, withBoundedTimeout } from '../../src/lib/bounded-timeout.ts';

/** Resolve after `ms` (real timers; tests use short, bounded durations). */
function resolveAfter<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function rejectAfter(ms: number, error: unknown): Promise<never> {
  return new Promise((_resolve, reject) => setTimeout(() => reject(error), ms));
}

describe('withBoundedTimeout', () => {
  it('resolves with the value when run() completes before the timeout', async () => {
    const result = await withBoundedTimeout(() => resolveAfter(10, 'ok'), 100);
    expect(result).toBe('ok');
  });

  it('rejects with TimeoutError when the timeout fires first', async () => {
    const slow = new Promise<string>(() => { /* never resolves */ });
    await expect(withBoundedTimeout(() => slow, 20)).rejects.toBeInstanceOf(TimeoutError);
  });

  it('propagates run() rejection when it rejects before the timeout', async () => {
    const err = new Error('boom');
    await expect(withBoundedTimeout(() => rejectAfter(10, err), 100)).rejects.toBe(err);
  });

  it('TimeoutError carries the requested ms and a stable name', async () => {
    const never = new Promise<string>(() => {});
    try {
      await withBoundedTimeout(() => never, 42);
      throw new Error('should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(TimeoutError);
      expect((err as TimeoutError).timeoutMs).toBe(42);
      expect((err as TimeoutError).name).toBe('TimeoutError');
    }
  });

  it('rejects immediately with TimeoutError when timeoutMs <= 0', async () => {
    await expect(withBoundedTimeout(() => resolveAfter(1, 'x'), 0)).rejects.toBeInstanceOf(TimeoutError);
    await expect(withBoundedTimeout(() => resolveAfter(1, 'x'), -5)).rejects.toBeInstanceOf(TimeoutError);
  });

  it('rejects immediately when run() throws synchronously (not wrapped in TimeoutError)', async () => {
    const syncErr = new Error('sync throw');
    await expect(
      withBoundedTimeout(() => { throw syncErr; }, 100),
    ).rejects.toBe(syncErr);
  });

  it('calls onLateSettle({ok:true, value}) when run() resolves AFTER timeout', async () => {
    const late = vi.fn();
    // run() resolves at 30ms; timeout fires at 10ms.
    await expect(
      withBoundedTimeout(() => resolveAfter(30, 'late-value'), 10, { onLateSettle: late }),
    ).rejects.toBeInstanceOf(TimeoutError);

    // Wait long enough for the late resolution to fire and be observed.
    await new Promise((r) => setTimeout(r, 50));
    expect(late).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledWith({ ok: true, value: 'late-value' });
  });

  it('calls onLateSettle({ok:false, error}) when run() rejects AFTER timeout', async () => {
    const late = vi.fn();
    const lateErr = new Error('late failure');
    await expect(
      withBoundedTimeout(() => rejectAfter(30, lateErr), 10, { onLateSettle: late }),
    ).rejects.toBeInstanceOf(TimeoutError);

    await new Promise((r) => setTimeout(r, 50));
    expect(late).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledWith({ ok: false, error: lateErr });
  });

  it('does NOT produce an unhandled rejection when run() rejects after timeout and no onLateSettle is supplied', async () => {
    // This is the core safety property: a late rejection must always have a
    // handler attached, even when the caller did not supply onLateSettle.
    // We track unhandled rejections on the process for the duration of the test.
    const unhandled: unknown[] = [];
    const handler = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', handler);
    try {
      const lateErr = new Error('late and unobserved');
      await expect(
        withBoundedTimeout(() => rejectAfter(30, lateErr), 10),
      ).rejects.toBeInstanceOf(TimeoutError);
      // Allow microtasks + the late rejection timer to drain.
      await new Promise((r) => setTimeout(r, 60));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', handler);
    }
  });

  it('does not fire onLateSettle when run() settles before the timeout', async () => {
    const late = vi.fn();
    await withBoundedTimeout(() => resolveAfter(10, 'fast'), 100, { onLateSettle: late });
    await new Promise((r) => setTimeout(r, 30));
    expect(late).not.toHaveBeenCalled();
  });

  it('clears the timer on normal completion (no late spurious timeout)', async () => {
    // If the timer weren't cleared, a late timeout callback could fire after
    // resolution. Since `settled` guards it, this is safe — but verify no
    // late TimeoutError leaks by completing well before the timeout and waiting
    // past it.
    const result = await withBoundedTimeout(() => resolveAfter(5, 'done'), 30);
    expect(result).toBe('done');
    // Wait past the original timeout deadline.
    await new Promise((r) => setTimeout(r, 50));
    // No throw / no unhandled rejection means the timer was harmless.
  });
});
