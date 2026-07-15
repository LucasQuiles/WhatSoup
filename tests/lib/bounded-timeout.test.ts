import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TimeoutError, withBoundedTimeout } from '../../src/lib/bounded-timeout.ts';

/** Resolve after `ms` — with fake timers, intercepted by vi.useFakeTimers(). */
function resolveAfter<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function rejectAfter(ms: number, error: unknown): Promise<never> {
  return new Promise((_resolve, reject) => setTimeout(() => reject(error), ms));
}

describe('withBoundedTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('resolves with the value when run() completes before the timeout', async () => {
    const pending = withBoundedTimeout(() => resolveAfter(10, 'ok'), 100);
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toBe('ok');
  });

  it('rejects with TimeoutError when the timeout fires first', async () => {
    const slow = new Promise<string>(() => { /* never resolves */ });
    const pending = withBoundedTimeout(() => slow, 20);
    // Pre-attach catch before advancing: the timeout fires inside advanceTimersByTimeAsync.
    const caught = pending.catch((e) => e);
    await vi.advanceTimersByTimeAsync(20);
    expect(await caught).toBeInstanceOf(TimeoutError);
  });

  it('propagates run() rejection when it rejects before the timeout', async () => {
    const err = new Error('boom');
    const pending = withBoundedTimeout(() => rejectAfter(10, err), 100);
    const caught = pending.catch((e) => e);
    await vi.advanceTimersByTimeAsync(10);
    expect(await caught).toBe(err);
  });

  it('TimeoutError carries the requested ms and a stable name', async () => {
    const never = new Promise<string>(() => {});
    const pending = withBoundedTimeout(() => never, 42);
    const caught = pending.catch((e) => e);
    await vi.advanceTimersByTimeAsync(42);
    const err = await caught;
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).timeoutMs).toBe(42);
    expect((err as TimeoutError).name).toBe('TimeoutError');
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
    const pending = withBoundedTimeout(() => resolveAfter(30, 'late-value'), 10, { onLateSettle: late });
    const caught = pending.catch((e) => e);
    await vi.advanceTimersByTimeAsync(10);
    expect(await caught).toBeInstanceOf(TimeoutError);
    // Advance past run()'s delay so the late resolution fires and is observed.
    await vi.advanceTimersByTimeAsync(20);
    expect(late).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledWith({ ok: true, value: 'late-value' });
  });

  it('calls onLateSettle({ok:false, error}) when run() rejects AFTER timeout', async () => {
    const late = vi.fn();
    const lateErr = new Error('late failure');
    const pending = withBoundedTimeout(() => rejectAfter(30, lateErr), 10, { onLateSettle: late });
    const caught = pending.catch((e) => e);
    await vi.advanceTimersByTimeAsync(10);
    expect(await caught).toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(20);
    expect(late).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledWith({ ok: false, error: lateErr });
  });

  it('does NOT produce an unhandled rejection when run() rejects after timeout and no onLateSettle is supplied', async () => {
    // Core safety property: a late rejection must always have a handler attached,
    // even when the caller did not supply onLateSettle.
    const unhandled: unknown[] = [];
    const handler = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', handler);
    try {
      const lateErr = new Error('late and unobserved');
      const pending = withBoundedTimeout(() => rejectAfter(30, lateErr), 10);
      const caught = pending.catch((e) => e);
      await vi.advanceTimersByTimeAsync(10);
      expect(await caught).toBeInstanceOf(TimeoutError);
      // Advance past the late rejection — the internal .then() handler must be in place.
      await vi.advanceTimersByTimeAsync(30);
      await vi.runAllTimersAsync();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', handler);
    }
  });

  it('does not fire onLateSettle when run() settles before the timeout', async () => {
    const late = vi.fn();
    const pending = withBoundedTimeout(() => resolveAfter(10, 'fast'), 100, { onLateSettle: late });
    await vi.advanceTimersByTimeAsync(10);
    await pending;
    // Advance well past where the timeout would have fired.
    await vi.advanceTimersByTimeAsync(100);
    expect(late).not.toHaveBeenCalled();
  });

  it('clears the timer on normal completion (no late spurious timeout)', async () => {
    const pending = withBoundedTimeout(() => resolveAfter(5, 'done'), 30);
    await vi.advanceTimersByTimeAsync(5);
    expect(await pending).toBe('done');
    // Advance past the original timeout deadline — no throw means the guard works.
    await vi.advanceTimersByTimeAsync(50);
  });

  // --- Fix 1: a throwing/rejecting onLateSettle must never leak an unhandled rejection.
  // These two run on REAL timers: unhandledRejection is emitted on a real event-loop
  // turn (not by draining the fake microtask queue), so fake timers would false-green.
  // `await caught` (the actual TimeoutError signal) is the sync primitive — not a sleep;
  // settlement is driven by a deferred, and real setImmediate turns surface the event.

  it('does NOT leak an unhandled rejection when a sync-throwing onLateSettle runs on a late resolve', async () => {
    vi.useRealTimers();
    const unhandled: unknown[] = [];
    const handler = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', handler);
    try {
      let resolveRun!: (value: string) => void;
      const runP = new Promise<string>((res) => { resolveRun = res; });
      const late = vi.fn(() => { throw new Error('onLateSettle sync throw'); });
      const caught = withBoundedTimeout(() => runP, 1, { onLateSettle: late }).catch((e) => e);
      expect(await caught).toBeInstanceOf(TimeoutError);
      // Settle AFTER the timeout — exercises the late SUCCESS arrow.
      resolveRun('late-value');
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(late).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', handler);
    }
  });

  it('does NOT leak an unhandled rejection when an async-rejecting onLateSettle runs on a late reject', async () => {
    vi.useRealTimers();
    const unhandled: unknown[] = [];
    const handler = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', handler);
    try {
      let rejectRun!: (error: unknown) => void;
      const runP = new Promise<string>((_res, rej) => { rejectRun = rej; });
      const late = vi.fn(async () => { throw new Error('onLateSettle async reject'); });
      const caught = withBoundedTimeout(() => runP, 1, { onLateSettle: late }).catch((e) => e);
      expect(await caught).toBeInstanceOf(TimeoutError);
      // Settle AFTER the timeout — exercises the late ERROR arrow.
      rejectRun(new Error('late failure'));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(late).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', handler);
    }
  });

  // --- Fix 2: non-finite / oversized timeoutMs must reject with RangeError and must NOT
  // silently settle. The RangeError type assertion is itself the discriminator: a clamped
  // ~1ms timer path would resolve the value (or reject TimeoutError), failing these.
  it('rejects with RangeError for non-finite timeoutMs (never silently settling)', async () => {
    // Non-finite check must precede the <= 0 branch: -Infinity is <= 0 yet must be RangeError.
    await expect(withBoundedTimeout(() => Promise.resolve('x'), Number.NaN)).rejects.toBeInstanceOf(RangeError);
    await expect(withBoundedTimeout(() => Promise.resolve('x'), Number.POSITIVE_INFINITY)).rejects.toBeInstanceOf(RangeError);
    await expect(withBoundedTimeout(() => Promise.resolve('x'), Number.NEGATIVE_INFINITY)).rejects.toBeInstanceOf(RangeError);
  });

  it('rejects with RangeError when timeoutMs exceeds the 32-bit timer ceiling', async () => {
    await expect(withBoundedTimeout(() => Promise.resolve('x'), 2_147_483_648)).rejects.toBeInstanceOf(RangeError);
  });
});
