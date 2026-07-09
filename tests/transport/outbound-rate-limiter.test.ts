// tests/transport/outbound-rate-limiter.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OutboundRateLimiter } from '../../src/transport/outbound-rate-limiter.ts';

const DEST_A = '15551230001';
const DEST_B = '15551230002';
const GLOBAL = '__global__';

describe('OutboundRateLimiter — sliding window (ported from SmsRateLimiter)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows up to the cap without delay', async () => {
    const rl = new OutboundRateLimiter(3);
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      delays.push(await rl.acquire(DEST_A));
    }
    expect(delays).toEqual([0, 0, 0]);
  });

  it('delays the over-cap acquire until the window slides, and reports the delay', async () => {
    const rl = new OutboundRateLimiter(2, 60_000);
    await rl.acquire(DEST_A); // t=0
    await vi.advanceTimersByTimeAsync(10_000);
    await rl.acquire(DEST_A); // t=10s — window now full

    let resolvedDelay: number | null = null;
    const waiter = rl.acquire(DEST_A).then((d) => {
      resolvedDelay = d;
      return d;
    });

    await vi.advanceTimersByTimeAsync(49_999);
    expect(resolvedDelay).toBeNull();

    await vi.advanceTimersByTimeAsync(2);
    await expect(waiter).resolves.toBe(50_000);
    expect(resolvedDelay).toBe(50_000);
  });

  it('tracks windows per destination independently', async () => {
    const rl = new OutboundRateLimiter(1, 60_000);
    await rl.acquire(DEST_A);
    await expect(rl.acquire(DEST_B)).resolves.toBe(0);
  });

  it('grants freed slots to waiters in FIFO order per destination', async () => {
    const rl = new OutboundRateLimiter(1, 60_000);
    await rl.acquire(DEST_A); // t=0 — at cap

    const order: string[] = [];
    const w1 = rl.acquire(DEST_A).then(() => order.push('w1'));
    const w2 = rl.acquire(DEST_A).then(() => order.push('w2'));

    await vi.advanceTimersByTimeAsync(60_001);
    expect(order).toEqual(['w1']);

    await vi.advanceTimersByTimeAsync(60_001);
    await Promise.all([w1, w2]);
    expect(order).toEqual(['w1', 'w2']);
  });

  it('evicts an idle window entry once the reservation ages out (no leak)', async () => {
    const rl = new OutboundRateLimiter(2, 60_000);
    await rl.acquire(DEST_A);
    expect(rl.size).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rl.size).toBe(0);
  });
});

describe('OutboundRateLimiter — bounded acquire (F4: never wait longer than maxWaitMs)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reserves immediately with capped:false when a slot is free', async () => {
    const rl = new OutboundRateLimiter(2, 60_000);
    await expect(rl.acquireBounded(DEST_A, 5_000)).resolves.toEqual({ delayMs: 0, capped: false });
  });

  it('paces (waits, then reserves) when the freeing wait fits inside maxWaitMs', async () => {
    // window 1s, cap 1 — the 2nd acquire frees ~1s out, well under the 5s bound.
    const rl = new OutboundRateLimiter(1, 1_000);
    await rl.acquireBounded(DEST_A, 5_000); // t=0 reserves
    const waiter = rl.acquireBounded(DEST_A, 5_000);
    await vi.advanceTimersByTimeAsync(1_001);
    const res = await waiter;
    expect(res.capped).toBe(false);
    expect(res.delayMs).toBeGreaterThan(0);
  });

  it('sheds with capped:true (no slot reserved) when freeing would exceed maxWaitMs', async () => {
    // window 100s, cap 1 — the 2nd slot frees ~100s out, far past the 5s bound.
    const rl = new OutboundRateLimiter(1, 100_000);
    await rl.acquireBounded(DEST_A, 5_000); // reserves the only slot
    const res = await rl.acquireBounded(DEST_A, 5_000);
    expect(res.capped).toBe(true);
    // The shed did NOT consume a slot, so a later window-slide admits again.
    await vi.advanceTimersByTimeAsync(100_001);
    await expect(rl.acquireBounded(DEST_A, 5_000)).resolves.toEqual({ delayMs: 0, capped: false });
  });
});

describe('OutboundRateLimiter — tryAcquireSync (hard-ceiling peek, no FIFO chain)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reserves synchronously up to the cap, then refuses without waiting', () => {
    const rl = new OutboundRateLimiter(2, 3_600_000);
    expect(rl.tryAcquireSync(DEST_A)).toBe(true);
    expect(rl.tryAcquireSync(DEST_A)).toBe(true);
    expect(rl.tryAcquireSync(DEST_A)).toBe(false); // ceiling hit — reject, do not block
  });

  it('admits again once the window slides past the reservations', () => {
    const rl = new OutboundRateLimiter(1, 3_600_000);
    expect(rl.tryAcquireSync(DEST_A)).toBe(true);
    expect(rl.tryAcquireSync(DEST_A)).toBe(false);
    vi.setSystemTime(Date.now() + 3_600_001);
    expect(rl.tryAcquireSync(DEST_A)).toBe(true);
  });
});

describe('OutboundRateLimiter — single-key (global) bucket throttles aggregate calls', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a fixed global key caps regardless of how many callers hit it', async () => {
    const global = new OutboundRateLimiter(1, 60_000);
    await expect(global.acquireBounded(GLOBAL, 5_000)).resolves.toEqual({ delayMs: 0, capped: false });
    // Second call on the SAME key is over cap and cannot fit the bound → shed.
    await expect(global.acquireBounded(GLOBAL, 5_000)).resolves.toMatchObject({ capped: true });
  });
});
