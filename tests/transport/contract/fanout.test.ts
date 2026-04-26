import { describe, it, expect, vi } from 'vitest';
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

const opts: FanoutOptions = {
  perSubscriberCapacity: 4,
  subscriberTimeoutMs: 50,
  overflowThreshold: 2,
  consecutiveTimeoutThreshold: 2,
};

describe('FanoutDispatcher', () => {
  it('delivers events to all subscribers', async () => {
    const d = new FanoutDispatcher(opts);
    const a = vi.fn(); const b = vi.fn();
    d.subscribe('a', a); d.subscribe('b', b);
    d.enqueue(ev(1));
    await d.flush();
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it('a slow subscriber does NOT delay another', async () => {
    const d = new FanoutDispatcher(opts);
    const fast = vi.fn();
    const slow = vi.fn(async () => { await new Promise(r => setTimeout(r, 30)); });
    d.subscribe('fast', fast); d.subscribe('slow', slow);
    d.enqueue(ev(1));
    // Wait for fast to complete; slow may still be running.
    await new Promise(r => setTimeout(r, 5));
    // Drain explicitly so the test is deterministic.
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
    const d = new FanoutDispatcher({ ...opts, subscriberTimeoutMs: 5 });
    const ok = vi.fn();
    const slow = vi.fn(async () => { await new Promise(r => setTimeout(r, 30)); });
    d.subscribe('ok', ok); d.subscribe('slow', slow);
    d.enqueue(ev(1)); d.enqueue(ev(2)); d.enqueue(ev(3));
    await d.flush();
    expect(d.isSuspended('slow')).toBe(true);
    expect(ok).toHaveBeenCalledTimes(3);
  });

  it('overflow on a subscriber queue increments metric AND suspends after threshold', async () => {
    const d = new FanoutDispatcher({ ...opts, perSubscriberCapacity: 1, overflowThreshold: 2 });
    const stuck = vi.fn(async () => { await new Promise(r => setTimeout(r, 100)); });
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
    const handler = vi.fn(async () => {
      started += 1;
      inflight += 1;
      await new Promise(r => setTimeout(r, 20));
      inflight -= 1;
    });
    const sub = d.subscribe('s', handler);
    d.enqueue(ev(1));
    d.enqueue(ev(2));
    d.enqueue(ev(3));
    d.enqueue(ev(4));
    // Let the drainLoop start processing the first event.
    await new Promise(r => setTimeout(r, 5));
    expect(started).toBe(1);
    expect(inflight).toBe(1);
    sub.dispose();
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
