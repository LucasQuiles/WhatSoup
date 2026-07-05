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

  it('evicts an idle window entry once the reservation ages out (no leak, G1)', async () => {
    const rl = new SmsRateLimiter(2, 60_000);
    await rl.acquire(DEST_A);
    expect(rl.size).toBe(1);

    // Nothing else ever touches DEST_A again — a long-running instance must
    // not keep one Map entry per distinct destination forever.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rl.size).toBe(0);
  });

  it('does not evict a destination whose window is still live (G1 safety)', async () => {
    const rl = new SmsRateLimiter(2, 60_000);
    await rl.acquire(DEST_A); // t=0
    await vi.advanceTimersByTimeAsync(30_000);
    await rl.acquire(DEST_A); // t=30s — refreshes the destination
    expect(rl.size).toBe(1);

    // The t=0 slot's own cleanup check runs at t=60s, but the t=30s send is
    // still within its window — the entry must survive, not be evicted out
    // from under the still-live reservation.
    await vi.advanceTimersByTimeAsync(30_001);
    expect(rl.size).toBe(1);

    // Now the t=30s send has also aged out and nothing renewed it.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(rl.size).toBe(0);
  });

  it('clamps a stored timestamp ahead of a stepped-back clock, capping the wait at windowMs (G2 backward step)', async () => {
    const rl = new SmsRateLimiter(1, 60_000);
    await rl.acquire(DEST_A); // recorded at t=0

    // Backward step: NTP correction / VM resume / manual clock change moves
    // the wall clock 30s into the past relative to the recorded send.
    vi.setSystemTime(Date.now() - 30_000);

    let resolvedDelay: number | null = null;
    const waiter = rl.acquire(DEST_A).then((d) => {
      resolvedDelay = d;
      return d;
    });

    // Without the clamp this would wait 90s (windowMs plus the 30s step
    // back) — longer than windowMs, and a larger step could go negative.
    // Advancing exactly windowMs must be enough, and acquire must not throw.
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(waiter).resolves.toBe(60_000);
    expect(resolvedDelay).toBe(60_000);
  });

  it('characterization, not a regression guard (passes pre- and post-fix): a forward clock step frees a slot early (G2 forward step, accepted)', async () => {
    const rl = new SmsRateLimiter(1, 60_000);
    await rl.acquire(DEST_A); // t=0 — at cap

    // Forward step: wall clock jumps a full window ahead without any timers
    // firing (NTP correction, VM resume/sleep). This frees the slot early
    // relative to real elapsed time — an accepted tradeoff of staying on
    // Date.now() (no monotonic-clock migration), not something this fix
    // changes; recorded here so the behavior stays intentional, not silent.
    //
    // Deliberately bidirectional: pruneWindow's clamp loop only fires on a
    // BACKWARD step (a stored timestamp ahead of `now`), so a forward step
    // exercises only the pre-existing, unchanged shift-loop beneath it. This
    // case passes unmodified on pre-fix code too (confirmed by swarm-2b
    // review, 2026-07-04) — it documents intended behavior, it does not
    // guard against a regression introduced by this fix.
    vi.setSystemTime(Date.now() + 60_000);

    await expect(rl.acquire(DEST_A)).resolves.toBe(0);
  });
});
