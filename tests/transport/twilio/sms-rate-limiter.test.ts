// tests/transport/twilio/sms-rate-limiter.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SmsRateLimiter } from '../../../src/transport/twilio/sms-rate-limiter.ts';

const DEST_A = '+15551230001';
const DEST_B = '+15551230002';

describe('SmsRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows up to the cap without delay', async () => {
    const rl = new SmsRateLimiter(3);
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      delays.push(await rl.acquire(DEST_A));
    }
    expect(delays).toEqual([0, 0, 0]);
  });

  it('delays the over-cap acquire until the window slides, and reports the delay', async () => {
    const rl = new SmsRateLimiter(2, 60_000);
    await rl.acquire(DEST_A); // t=0
    await vi.advanceTimersByTimeAsync(10_000);
    await rl.acquire(DEST_A); // t=10s — window now full

    let resolvedDelay: number | null = null;
    const waiter = rl.acquire(DEST_A).then((d) => {
      resolvedDelay = d;
      return d;
    });

    // t=59.999s: the t=0 slot has not expired yet — still throttled.
    await vi.advanceTimersByTimeAsync(49_999);
    expect(resolvedDelay).toBeNull();

    // Crossing t=60s frees the t=0 slot.
    await vi.advanceTimersByTimeAsync(2);
    await expect(waiter).resolves.toBe(50_000);
    expect(resolvedDelay).toBe(50_000);
  });

  it('tracks windows per destination independently', async () => {
    const rl = new SmsRateLimiter(1, 60_000);
    await rl.acquire(DEST_A); // A is now at cap
    // B must not be throttled by A's traffic.
    await expect(rl.acquire(DEST_B)).resolves.toBe(0);
  });

  it('grants freed slots to waiters in FIFO order per destination', async () => {
    const rl = new SmsRateLimiter(1, 60_000);
    await rl.acquire(DEST_A); // t=0 — at cap

    const order: string[] = [];
    const w1 = rl.acquire(DEST_A).then(() => order.push('w1'));
    const w2 = rl.acquire(DEST_A).then(() => order.push('w2'));

    // t=60s+: only the first waiter's slot frees (w2 must wait for w1's send to age out).
    await vi.advanceTimersByTimeAsync(60_001);
    expect(order).toEqual(['w1']);

    // t=120s+: the second waiter's slot frees.
    await vi.advanceTimersByTimeAsync(60_001);
    await Promise.all([w1, w2]);
    expect(order).toEqual(['w1', 'w2']);
  });

  it('is immediate again after the window fully slides past old sends', async () => {
    const rl = new SmsRateLimiter(1, 60_000);
    await rl.acquire(DEST_A);
    await vi.advanceTimersByTimeAsync(60_001);
    await expect(rl.acquire(DEST_A)).resolves.toBe(0);
  });
});
