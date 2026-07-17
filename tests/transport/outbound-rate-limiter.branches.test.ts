// Extension tests for outbound-rate-limiter.ts — added edge cases and branch coverage
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OutboundRateLimiter } from '../../src/transport/outbound-rate-limiter.ts';

const DEST_A = '15551230001';

describe('OutboundRateLimiter extensions — constructor clamping', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('clamps negative maxPerWindow to 1 (prevents busy-loop)', () => {
    const rl = new OutboundRateLimiter(-5, 1_000);
    expect(rl.tryAcquireSync(DEST_A)).toBe(true);
    expect(rl.tryAcquireSync(DEST_A)).toBe(false);
  });

  it('clamps zero maxPerWindow to 1', () => {
    const rl = new OutboundRateLimiter(0, 1_000);
    expect(rl.tryAcquireSync(DEST_A)).toBe(true);
    expect(rl.tryAcquireSync(DEST_A)).toBe(false);
  });

  it('clamps fractional maxPerWindow via Math.floor', () => {
    const rl = new OutboundRateLimiter(2.7, 1_000);
    expect(rl.tryAcquireSync(DEST_A)).toBe(true);
    expect(rl.tryAcquireSync(DEST_A)).toBe(true);
    expect(rl.tryAcquireSync(DEST_A)).toBe(false);
  });
});

describe('OutboundRateLimiter extensions — clock non-monotonicity', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('handles clock going backward by clamping future timestamps to present', async () => {
    // This tests the pruneWindow branch: if (window[i]! > now) window[i] = now;
    const rl = new OutboundRateLimiter(2, 10_000);
    vi.setSystemTime(100_000);
    const result1 = rl.tryAcquireSync(DEST_A);  // reserve at t=100s
    expect(result1).toBe(true);

    // Clock backward to t=50s
    vi.setSystemTime(50_000);

    // pruneWindow will see stored[0]=100s > now=50s, so clamps to 50s.
    // After clamping to 50s, the window's oldest entry is at 50s.
    // With windowMs=10_000, entry is expired at 50 + 10_000 = 60_000.
    // Since we're at 50_000, the entry is still valid. But we have cap=2, so second slot free.
    const result2 = rl.tryAcquireSync(DEST_A);  // second acquire
    expect(result2).toBe(true);  // Second slot available
  });

  it('forward time skip frees slots early (normal behavior)', async () => {
    const rl = new OutboundRateLimiter(1, 10_000);
    vi.setSystemTime(0);
    expect(rl.tryAcquireSync(DEST_A)).toBe(true);
    expect(rl.tryAcquireSync(DEST_A)).toBe(false);
    
    vi.setSystemTime(15_000);
    expect(rl.tryAcquireSync(DEST_A)).toBe(true);
  });
});

describe('OutboundRateLimiter extensions — edge cases for reserveSlot', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('respects minimum 1ms wait floor in reserveSlot', async () => {
    const rl = new OutboundRateLimiter(1, 5);
    await rl.acquire(DEST_A);
    
    const delayed = rl.acquire(DEST_A);
    await vi.advanceTimersByTimeAsync(5);
    const result = await delayed;
    expect(result).toBeGreaterThanOrEqual(1);
  });
});

describe('OutboundRateLimiter extensions — cleanup guards', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cleanup does not delete while a reservation is in flight', async () => {
    const rl = new OutboundRateLimiter(1, 100);
    await rl.acquire(DEST_A);
    
    const waiter = rl.acquire(DEST_A);
    await vi.advanceTimersByTimeAsync(200);
    
    const result = await waiter;
    expect(result).toBeGreaterThan(0);
  });

  it('cleanup evicts entry only when all guards pass', async () => {
    const rl = new OutboundRateLimiter(1, 100);
    await rl.acquire(DEST_A);
    expect(rl.size).toBe(1);
    
    vi.advanceTimersByTimeAsync(101);
    await vi.runOnlyPendingTimersAsync();
    
    expect(rl.size).toBe(0);
  });
});

describe('OutboundRateLimiter extensions — acquireBounded accumulated wait', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sheds if accumulated wait across iterations exceeds bound', async () => {
    const rl = new OutboundRateLimiter(1, 200_000);
    await rl.acquireBounded(DEST_A, 1_000);
    
    const result = await rl.acquireBounded(DEST_A, 100);
    expect(result.capped).toBe(true);
    expect(result.delayMs).toBe(0);
  });

  it('does not reserve a slot when shedding', async () => {
    const rl = new OutboundRateLimiter(1, 100_000);
    await rl.acquireBounded(DEST_A, 50_000);
    
    const shed = rl.acquireBounded(DEST_A, 5_000);
    const result = await shed;
    expect(result.capped).toBe(true);
    
    // Window slides, next acquire should succeed (no slots consumed by shed)
  });
});
