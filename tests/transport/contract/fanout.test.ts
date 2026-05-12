import { afterEach, describe, it, expect, vi } from 'vitest';
import { makeChannelId } from '../../../src/core/transport-refs.ts';
import { FanoutDispatcher, type FanoutOptions } from '../../../src/transport/contract/fanout.ts';
import type { InboundEvent } from '../../../src/transport/contract/events.ts';

const ev = (n: number): InboundEvent => ({
  kind: 'message',
  data: {
    ref: { channel: makeChannelId('whatsapp', 'test'), conversation: 'c', id: String(n) },
    conversation: { channel: makeChannelId('whatsapp', 'test'), id: 'c' },
    sender: { channel: makeChannelId('whatsapp', 'test'), id: 's' },
    fromMe: false,
    text: `m${n}`,
    attachments: [],
    timestamp: new Date(),
    inboundEventKey: `wa:${n}`,
    transportTimestamp: new Date(),
    ingestSeq: n,
  },
});

const reactionEv = (n: number): InboundEvent => ({
  kind: 'reaction',
  data: {
    target: { channel: makeChannelId('whatsapp', 'test'), conversation: 'c', id: String(n) },
    actor: { channel: makeChannelId('whatsapp', 'test'), id: 's' },
    emoji: '👍',
    removed: false,
    at: new Date(),
  },
});

const opts: FanoutOptions = {
  perSubscriberCapacity: 4,
  subscriberTimeoutMs: 50,
  overflowThreshold: 2,
  consecutiveTimeoutThreshold: 2,
  persistDurableEvent: () => {},
};

describe('FanoutDispatcher', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers events to all subscribers', async () => {
    const d = new FanoutDispatcher(opts);
    const a = vi.fn(); const b = vi.fn();
    d.subscribe('a', a); d.subscribe('b', b);
    d.enqueue(ev(1));
    await d.flush();
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it('requires a durable persistence hook', () => {
    expect(() => new FanoutDispatcher({
      perSubscriberCapacity: 4,
      subscriberTimeoutMs: 50,
      overflowThreshold: 2,
      consecutiveTimeoutThreshold: 2,
    } as unknown as FanoutOptions)).toThrow(/persistDurableEvent is required/);
  });

  it('persists durable events before subscriber dispatch', async () => {
    const order: string[] = [];
    const d = new FanoutDispatcher({
      ...opts,
      persistDurableEvent: (event) => {
        order.push(`persist:${event.kind}`);
      },
    });
    d.subscribe('s', () => {
      order.push('handler');
    });

    d.enqueue(ev(1));
    await d.flush();

    expect(order).toEqual(['persist:message', 'handler']);
  });

  it('does not force non-durable events through the persistence hook', async () => {
    const persistDurableEvent = vi.fn();
    const handler = vi.fn();
    const d = new FanoutDispatcher({ ...opts, persistDurableEvent });
    d.subscribe('s', handler);

    d.enqueue(reactionEv(1));
    await d.flush();

    expect(persistDurableEvent).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledOnce();
  });

  it('does not dispatch a durable event when the persistence hook throws', async () => {
    const handler = vi.fn();
    const d = new FanoutDispatcher({
      ...opts,
      persistDurableEvent: () => {
        throw new Error('persist failed');
      },
    });
    d.subscribe('s', handler);

    expect(() => d.enqueue(ev(1))).toThrow(/persist failed/);
    await d.flush();

    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects async durable persistence hooks before dispatch', async () => {
    const handler = vi.fn();
    const d = new FanoutDispatcher({
      ...opts,
      persistDurableEvent: (() => Promise.resolve()) as unknown as FanoutOptions['persistDurableEvent'],
    });
    d.subscribe('s', handler);

    expect(() => d.enqueue(ev(1))).toThrow(/synchronous/i);
    await d.flush();

    expect(handler).not.toHaveBeenCalled();
  });

  it('a slow subscriber does NOT delay another', async () => {
    const d = new FanoutDispatcher(opts);
    const fast = vi.fn();
    let releaseSlow: (() => void) | undefined;
    const slow = vi.fn(async () => {
      await new Promise<void>(resolve => { releaseSlow = resolve; });
    });
    d.subscribe('fast', fast); d.subscribe('slow', slow);
    d.enqueue(ev(1));
    expect(fast).toHaveBeenCalledOnce();
    expect(slow).toHaveBeenCalledOnce();
    releaseSlow?.();
    await d.flush();
    expect(fast).toHaveBeenCalledOnce();
    expect(slow).toHaveBeenCalledOnce();
  });

  it('a throwing subscriber does NOT crash the dispatcher; other subscribers still get the event', async () => {
    const d = new FanoutDispatcher(opts);
    const ok = vi.fn();
    const bad = vi.fn(() => { throw new Error('boom'); });
    d.subscribe('ok', ok); d.subscribe('bad', bad);
    d.enqueue(ev(1));
    await d.flush();
    expect(ok).toHaveBeenCalledOnce();
    expect(bad).toHaveBeenCalledOnce();
    expect(d.metrics.subscriberFailures.get('bad') ?? 0).toBeGreaterThan(0);
  });

  it('repeated subscriber timeouts cause suspension; sibling subscribers continue', async () => {
    vi.useFakeTimers();
    const d = new FanoutDispatcher({ ...opts, subscriberTimeoutMs: 5 });
    const ok = vi.fn();
    const slow = vi.fn(async () => { await new Promise<void>(() => {}); });
    d.subscribe('ok', ok); d.subscribe('slow', slow);
    d.enqueue(ev(1)); d.enqueue(ev(2)); d.enqueue(ev(3));
    const flushed = d.flush();
    await vi.advanceTimersByTimeAsync(10);
    await flushed;
    expect(d.isSuspended('slow')).toBe(true);
    expect(ok).toHaveBeenCalledTimes(3);
    expect(slow).toHaveBeenCalledTimes(2);
  });

  it('overflow on a subscriber queue increments metric AND suspends after threshold', async () => {
    const d = new FanoutDispatcher({ ...opts, perSubscriberCapacity: 1, overflowThreshold: 2 });
    const stuck = vi.fn(async () => { await new Promise<void>(() => {}); });
    d.subscribe('s', stuck);
    d.enqueue(ev(1));   // accepted, drain starts, queue slot becomes free synchronously before await
    d.enqueue(ev(2));   // accepted into the 1-cap queue while drain is busy
    d.enqueue(ev(3));   // overflow #1
    d.enqueue(ev(4));   // overflow #2 — crosses threshold
    expect(d.metrics.subscriberOverflow.get('s') ?? 0).toBeGreaterThanOrEqual(2);
    expect(d.isSuspended('s')).toBe(true);
    expect(d.metrics.subscriberSuspensions.get('s')).toBe('overflow');
  });

  it('subscribe returns a Subscription whose dispose() removes the subscriber', async () => {
    const d = new FanoutDispatcher(opts);
    const fn = vi.fn();
    const sub = d.subscribe('x', fn);
    sub.dispose();
    d.enqueue(ev(1));
    await d.flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it('dispatcher dispose stops queued delivery after the in-flight handler resolves', async () => {
    const d = new FanoutDispatcher({ ...opts, subscriberTimeoutMs: 1000 });
    let releaseInflight: (() => void) | undefined;
    const handler = vi.fn(async () => {
      await new Promise<void>(resolve => { releaseInflight = resolve; });
    });
    d.subscribe('s', handler);

    d.enqueue(ev(1));
    d.enqueue(ev(2));
    d.enqueue(ev(3));
    expect(handler).toHaveBeenCalledTimes(1);

    const disposed = d.dispose();
    d.enqueue(ev(4));
    releaseInflight?.();
    await disposed;
    await d.flush();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('dispatcher dispose rejects new subscriptions', async () => {
    const d = new FanoutDispatcher(opts);

    await d.dispose();

    expect(() => d.subscribe('late', () => {})).toThrow(/disposed/i);
  });

  it('dispose() is idempotent', () => {
    const d = new FanoutDispatcher(opts);
    const sub = d.subscribe('x', () => {});
    sub.dispose(); sub.dispose(); sub.dispose();
    expect(() => sub.dispose()).not.toThrow();
  });

  it('A3 — dispose() while events are queued: at most the in-flight event delivers', async () => {
    // Subscribe with a slow handler. Enqueue several events so the queue fills.
    // Dispose mid-drain. The currently-awaited handler completes (it cannot be
    // cancelled mid-await), but the remaining queued events MUST NOT deliver
    // because dispose marks the subscriber suspended.
    const d = new FanoutDispatcher({ ...opts, subscriberTimeoutMs: 1000 });
    let inflight = 0;
    let started = 0;
    let releaseInflight: (() => void) | undefined;
    const handler = vi.fn(async () => {
      started += 1;
      inflight += 1;
      await new Promise<void>(resolve => { releaseInflight = resolve; });
      inflight -= 1;
    });
    const sub = d.subscribe('s', handler);
    d.enqueue(ev(1));
    d.enqueue(ev(2));
    d.enqueue(ev(3));
    d.enqueue(ev(4));
    expect(started).toBe(1);
    expect(inflight).toBe(1);
    sub.dispose();
    releaseInflight?.();
    await d.flush();
    // After dispose, no further handler invocations.
    expect(handler).toHaveBeenCalledTimes(1);
    expect(inflight).toBe(0);
  });

  it('A8 — flush() awaits re-entrant enqueue from inside a handler', async () => {
    // The handler enqueues another event synchronously on its first invocation.
    // flush() must observe the second event's drain and not return until both
    // invocations complete. This locks in the current re-entrancy contract.
    const d = new FanoutDispatcher(opts);
    let calls = 0;
    const handler = vi.fn((_e: InboundEvent) => {
      calls += 1;
      if (calls === 1) d.enqueue(ev(2));
    });
    d.subscribe('reenter', handler);
    d.enqueue(ev(1));
    await d.flush();
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
