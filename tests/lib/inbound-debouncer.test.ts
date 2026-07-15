import { describe, expect, it, vi } from 'vitest';

import { createInboundDebouncer } from '../../src/lib/inbound-debouncer.ts';

// Helper: create a debouncer with fake timers from vitest
function makeDebouncer<TMessage>(
  params: Parameters<typeof createInboundDebouncer<TMessage>>[0],
  onFlush: Parameters<typeof createInboundDebouncer<TMessage>>[1],
) {
  return createInboundDebouncer<TMessage>(params, onFlush);
}

describe('createInboundDebouncer', () => {
  it('flushes after idle wait when a single message arrives', () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const debouncer = makeDebouncer<{ text: string }>(
      { waitMs: 500 },
      onFlush,
    );

    debouncer.push('alice', { text: 'hi' });
    expect(onFlush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(499);
    expect(onFlush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'alice',
        messages: [{ text: 'hi' }],
        reason: 'idle',
      }),
    );

    vi.useRealTimers();
  });

  it('coalesces multiple messages within the wait window', () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const debouncer = makeDebouncer<string>({ waitMs: 500 }, onFlush);

    debouncer.push('bob', 'm1');
    vi.advanceTimersByTime(200);
    debouncer.push('bob', 'm2');
    vi.advanceTimersByTime(200);
    debouncer.push('bob', 'm3');

    // Only 400ms elapsed since first — not yet flushed
    expect(onFlush).not.toHaveBeenCalled();
    expect(debouncer.pending('bob')).toBe(3);

    // Idle timer fires waitMs after the LAST push (t=400 + 500 = 900)
    vi.advanceTimersByTime(500);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'bob',
        messages: ['m1', 'm2', 'm3'],
        reason: 'idle',
      }),
    );
    expect(debouncer.pending('bob')).toBe(0);

    vi.useRealTimers();
  });

  it('handles multiple senders independently', () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const debouncer = makeDebouncer<string>({ waitMs: 500 }, onFlush);

    debouncer.push('alice', 'a1');
    vi.advanceTimersByTime(100);
    debouncer.push('bob', 'b1');
    vi.advanceTimersByTime(100);
    debouncer.push('alice', 'a2');

    expect(debouncer.pendingSenders()).toBe(2);

    // After pushes, fake clock is at t=200.
    // Alice idle fires at t=700 (last push t=200 + 500),
    // Bob idle fires at t=600 (last push t=100 + 500).
    vi.advanceTimersByTime(300); // t=200 → t=500
    expect(onFlush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100); // t=500 → t=600: bob flushes
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenLastCalledWith(
      expect.objectContaining({ key: 'bob', messages: ['b1'] }),
    );
    expect(debouncer.pendingSenders()).toBe(1);

    vi.advanceTimersByTime(100); // t=600 → t=700: alice flushes
    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(onFlush).toHaveBeenLastCalledWith(
      expect.objectContaining({ key: 'alice', messages: ['a1', 'a2'] }),
    );
    expect(debouncer.pendingSenders()).toBe(0);

    vi.useRealTimers();
  });

  it('flushes via max-wait timer even with continuous messages', () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const debouncer = makeDebouncer<string>(
      { waitMs: 500, maxWaitMs: 1000 },
      onFlush,
    );

    // Send a message every 200ms — never lets the idle timer fire
    for (let i = 0; i < 10; i++) {
      debouncer.push('carol', `m${i}`);
      vi.advanceTimersByTime(200);
    }

    // After 1000ms total, max-wait should have fired
    const maxWaitCalls = onFlush.mock.calls.filter((c) => c[0]?.reason === 'max-wait');
    expect(maxWaitCalls.length).toBeGreaterThanOrEqual(1);

    vi.useRealTimers();
  });

  it('flushes via max-batch size', () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const debouncer = makeDebouncer<string>(
      { waitMs: 10000, maxBatchSize: 3 },
      onFlush,
    );

    debouncer.push('dave', 'm1');
    debouncer.push('dave', 'm2');
    expect(onFlush).not.toHaveBeenCalled();

    debouncer.push('dave', 'm3');
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'dave',
        messages: ['m1', 'm2', 'm3'],
        reason: 'max-batch',
      }),
    );
    expect(debouncer.pending('dave')).toBe(0);

    vi.useRealTimers();
  });

  it('flush(key) immediately flushes a specific sender', () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const debouncer = makeDebouncer<string>({ waitMs: 500 }, onFlush);

    debouncer.push('eve', 'hello');
    const flushed = debouncer.flush('eve');

    expect(flushed).not.toBeNull();
    expect(flushed!.messages).toEqual(['hello']);
    expect(flushed!.reason).toBe('flush');
    expect(debouncer.pending('eve')).toBe(0);

    vi.useRealTimers();
  });

  it('flush(key) returns null for unknown sender', () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const debouncer = makeDebouncer<string>({ waitMs: 500 }, onFlush);

    expect(debouncer.flush('nobody')).toBeNull();
    vi.useRealTimers();
  });

  it('flushAll() flushes all pending senders', () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const debouncer = makeDebouncer<string>({ waitMs: 10000 }, onFlush);

    debouncer.push('alice', 'a');
    debouncer.push('bob', 'b');
    debouncer.push('carol', 'c');

    expect(debouncer.pendingSenders()).toBe(3);

    const flushed = debouncer.flushAll();
    expect(flushed.length).toBe(3);
    expect(onFlush).toHaveBeenCalledTimes(3);
    expect(debouncer.pendingSenders()).toBe(0);

    vi.useRealTimers();
  });

  it('cancel() clears all pending without flushing', () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const debouncer = makeDebouncer<string>({ waitMs: 500 }, onFlush);

    debouncer.push('alice', 'a');
    debouncer.push('bob', 'b');
    debouncer.cancel();

    expect(debouncer.pendingSenders()).toBe(0);

    vi.advanceTimersByTime(1000);
    expect(onFlush).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('pending(key) returns 0 for unknown sender', () => {
    const debouncer = makeDebouncer<string>({ waitMs: 500 }, vi.fn());
    expect(debouncer.pending('nobody')).toBe(0);
  });

  it('new batch after flush starts fresh', () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const debouncer = makeDebouncer<string>({ waitMs: 500 }, onFlush);

    debouncer.push('alice', 'first');
    vi.advanceTimersByTime(500);
    expect(onFlush).toHaveBeenCalledTimes(1);

    // New message after flush — starts a new batch
    debouncer.push('alice', 'second');
    expect(debouncer.pending('alice')).toBe(1);
    vi.advanceTimersByTime(500);

    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(onFlush).toHaveBeenLastCalledWith(
      expect.objectContaining({ messages: ['second'] }),
    );

    vi.useRealTimers();
  });

  it('records firstAt and lastAt timestamps', () => {
    vi.useFakeTimers({ now: 10000 });
    const onFlush = vi.fn();
    const debouncer = makeDebouncer<string>({ waitMs: 500 }, onFlush);

    debouncer.push('alice', 'm1');
    vi.advanceTimersByTime(200);
    debouncer.push('alice', 'm2');
    vi.advanceTimersByTime(500);

    expect(onFlush).toHaveBeenCalledWith(
      expect.objectContaining({
        firstAt: 10000,
        lastAt: 10200,
      }),
    );

    vi.useRealTimers();
  });

  it('maxBatchSize: 0 or undefined → unlimited', () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const debouncer = makeDebouncer<string>(
      { waitMs: 10000, maxBatchSize: 0 },
      onFlush,
    );

    for (let i = 0; i < 100; i++) {
      debouncer.push('alice', `m${i}`);
    }
    expect(onFlush).not.toHaveBeenCalled();
    expect(debouncer.pending('alice')).toBe(100);

    vi.useRealTimers();
  });

  it('handles waitMs of 0', () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const debouncer = makeDebouncer<string>({ waitMs: 0 }, onFlush);

    debouncer.push('alice', 'hello');
    // waitMs=0 means the timer fires immediately (next tick)
    vi.advanceTimersByTime(0);
    expect(onFlush).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  // --- error isolation (onFlush must never crash the debouncer) ---

  it('routes a synchronous onFlush throw to onError instead of crashing the timer', () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const boom = new Error('sync boom');
    const debouncer = makeDebouncer<string>(
      { waitMs: 500, onError },
      () => {
        throw boom;
      },
    );

    debouncer.push('alice', 'x');
    // Before the fix, the throw escapes the setTimeout callback: the timer
    // callback throws (uncaught exception in production; advanceTimersByTime
    // rethrows here). After the fix it is caught and routed to onError.
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBe(boom);
    // Batch was still cleared from pending.
    expect(debouncer.pendingSenders()).toBe(0);

    vi.useRealTimers();
  });

  it('routes an async onFlush rejection to onError instead of an unhandled rejection', async () => {
    const onError = vi.fn();
    const boom = new Error('async boom');
    const debouncer = makeDebouncer<string>(
      { waitMs: 500, onError },
      () => Promise.reject(boom),
    );

    debouncer.push('alice', 'x');
    // Synchronous trigger returns the rejecting promise from onFlush.
    debouncer.flush('alice');
    // Let the internal .catch microtask run.
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBe(boom);
  });

  it('rejects a non-finite waitMs at construction', () => {
    expect(() => makeDebouncer<string>({ waitMs: Number.NaN }, vi.fn())).toThrow();
    expect(() =>
      makeDebouncer<string>({ waitMs: Number.POSITIVE_INFINITY }, vi.fn()),
    ).toThrow();
  });

  it('flushAll continues past a sender whose onFlush throws', () => {
    const onError = vi.fn();
    const delivered: string[] = [];
    const debouncer = makeDebouncer<string>(
      { waitMs: 10000, onError },
      (batch) => {
        if (batch.key === 'bob') throw new Error('bob boom');
        delivered.push(batch.key);
      },
    );

    debouncer.push('alice', 'a');
    debouncer.push('bob', 'b');
    debouncer.push('carol', 'c');

    const results = debouncer.flushAll();

    // All three senders cleared despite bob throwing — no stranding.
    expect(debouncer.pendingSenders()).toBe(0);
    // Non-throwing senders were delivered.
    expect(delivered).toContain('alice');
    expect(delivered).toContain('carol');
    // Bob's failure routed to onError, not propagated.
    expect(onError).toHaveBeenCalledTimes(1);
    // flushAll still reports all three attempted flushes.
    expect(results.length).toBe(3);
  });
});
