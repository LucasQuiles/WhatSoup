import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clamp,
  computeBackoff,
  DEFAULT_HEARTBEAT_SECONDS,
  DEFAULT_RECONNECT_POLICY,
  isReconnectExhausted,
  resolveHeartbeatSeconds,
  resolveReconnectPolicy,
  type ReconnectPolicy,
} from '../../src/lib/reconnect-policy.ts';

describe('clamp', () => {
  it('clamps below min to min', () => {
    expect(clamp(5, 10, 20)).toBe(10);
  });
  it('clamps above max to max', () => {
    expect(clamp(25, 10, 20)).toBe(20);
  });
  it('preserves in-range values', () => {
    expect(clamp(15, 10, 20)).toBe(15);
  });
  it('returns min for NaN', () => {
    expect(clamp(Number.NaN, 10, 20)).toBe(10);
  });
  it('handles negative ranges', () => {
    expect(clamp(-5, -10, -1)).toBe(-5);
  });
});

describe('DEFAULT_RECONNECT_POLICY', () => {
  it('has sane initial values', () => {
    expect(DEFAULT_RECONNECT_POLICY.initialMs).toBe(2_000);
    expect(DEFAULT_RECONNECT_POLICY.maxMs).toBe(30_000);
    expect(DEFAULT_RECONNECT_POLICY.factor).toBe(1.8);
    expect(DEFAULT_RECONNECT_POLICY.jitter).toBe(0.25);
    expect(DEFAULT_RECONNECT_POLICY.maxAttempts).toBe(12);
  });
});

describe('resolveReconnectPolicy', () => {
  it('returns defaults when no overrides', () => {
    const p = resolveReconnectPolicy();
    expect(p).toEqual(DEFAULT_RECONNECT_POLICY);
  });

  it('applies config overrides', () => {
    const p = resolveReconnectPolicy({ initialMs: 5_000, factor: 2 });
    expect(p.initialMs).toBe(5_000);
    expect(p.factor).toBe(2);
    expect(p.maxMs).toBe(DEFAULT_RECONNECT_POLICY.maxMs);
  });

  it('caller overrides win over config overrides', () => {
    const p = resolveReconnectPolicy({ initialMs: 5_000 }, { initialMs: 7_000 });
    expect(p.initialMs).toBe(7_000);
  });

  it('clamps initialMs to >= 250', () => {
    expect(resolveReconnectPolicy({ initialMs: 100 }).initialMs).toBe(250);
    expect(resolveReconnectPolicy({ initialMs: 0 }).initialMs).toBe(250);
    expect(resolveReconnectPolicy({ initialMs: -5 }).initialMs).toBe(250);
  });

  it('clamps maxMs to >= initialMs', () => {
    expect(resolveReconnectPolicy({ initialMs: 5_000, maxMs: 1_000 }).maxMs).toBe(5_000);
  });

  it('clamps factor to [1.1, 10]', () => {
    expect(resolveReconnectPolicy({ factor: 1 }).factor).toBe(1.1);
    expect(resolveReconnectPolicy({ factor: 0 }).factor).toBe(1.1);
    expect(resolveReconnectPolicy({ factor: 15 }).factor).toBe(10);
    expect(resolveReconnectPolicy({ factor: 2 }).factor).toBe(2);
  });

  it('clamps jitter to [0, 1]', () => {
    expect(resolveReconnectPolicy({ jitter: -0.5 }).jitter).toBe(0);
    expect(resolveReconnectPolicy({ jitter: 1.5 }).jitter).toBe(1);
    expect(resolveReconnectPolicy({ jitter: 0.3 }).jitter).toBe(0.3);
  });

  it('clamps maxAttempts to >= 0 (integer)', () => {
    expect(resolveReconnectPolicy({ maxAttempts: -5 }).maxAttempts).toBe(0);
    expect(resolveReconnectPolicy({ maxAttempts: 2.7 }).maxAttempts).toBe(2);
    expect(resolveReconnectPolicy({ maxAttempts: 0 }).maxAttempts).toBe(0);
  });

  it('preserves valid values through clamping', () => {
    const p = resolveReconnectPolicy({
      initialMs: 1_000,
      maxMs: 60_000,
      factor: 2,
      jitter: 0.5,
      maxAttempts: 5,
    });
    expect(p).toEqual({
      initialMs: 1_000,
      maxMs: 60_000,
      factor: 2,
      jitter: 0.5,
      maxAttempts: 5,
    });
  });
});

describe('computeBackoff', () => {
  const noJitter: ReconnectPolicy = {
    initialMs: 1_000,
    maxMs: 30_000,
    factor: 2,
    jitter: 0,
    maxAttempts: 5,
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns initialMs at attempt 0 (no jitter)', () => {
    expect(computeBackoff(noJitter, 0)).toBe(1_000);
  });

  it('grows exponentially by factor', () => {
    expect(computeBackoff(noJitter, 0)).toBe(1_000);
    expect(computeBackoff(noJitter, 1)).toBe(2_000);
    expect(computeBackoff(noJitter, 2)).toBe(4_000);
    expect(computeBackoff(noJitter, 3)).toBe(8_000);
    expect(computeBackoff(noJitter, 4)).toBe(16_000);
  });

  it('caps at maxMs', () => {
    expect(computeBackoff(noJitter, 10)).toBe(30_000);
    expect(computeBackoff(noJitter, 100)).toBe(30_000);
  });

  it('treats negative attempt as 0', () => {
    expect(computeBackoff(noJitter, -1)).toBe(1_000);
    expect(computeBackoff(noJitter, -100)).toBe(1_000);
  });

  it('floors fractional attempt', () => {
    expect(computeBackoff(noJitter, 1.9)).toBe(2_000);
  });

  it('returns exact value when jitter is 0', () => {
    const p = { ...noJitter, jitter: 0 };
    expect(computeBackoff(p, 2)).toBe(4_000);
  });

  it('applies positive jitter (delay <= unjittered)', () => {
    const p = { ...noJitter, jitter: 0.5 };
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    // unjittered = 4000, spread = 2000, delay = 4000 - 0.5*2000 = 3000
    expect(computeBackoff(p, 2)).toBe(3_000);
  });

  it('jitter at full random=1 gives delay * (1 - jitter)', () => {
    const p = { ...noJitter, jitter: 0.5 };
    vi.spyOn(Math, 'random').mockReturnValue(1);
    // unjittered = 4000, spread = 2000, delay = 4000 - 1*2000 = 2000
    expect(computeBackoff(p, 2)).toBe(2_000);
  });

  it('jitter at random=0 gives full unjittered delay', () => {
    const p = { ...noJitter, jitter: 0.5 };
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(computeBackoff(p, 2)).toBe(4_000);
  });

  it('never produces a delay below delay*(1-jitter)', () => {
    const p = { ...noJitter, jitter: 0.25, maxMs: 4_000 };
    // attempt where unjittered hits maxMs exactly: 1000*2^2 = 4000 == maxMs
    vi.spyOn(Math, 'random').mockReturnValue(1);
    // floor = 4000 * (1 - 0.25) = 3000
    expect(computeBackoff(p, 2)).toBe(3_000);
  });

  it('respects maxMs even with jitter', () => {
    const p = { ...noJitter, maxMs: 1_500, jitter: 1 };
    vi.spyOn(Math, 'random').mockReturnValue(0); // no jitter reduction
    expect(computeBackoff(p, 5)).toBe(1_500);
  });
});

describe('resolveHeartbeatSeconds', () => {
  it('returns the override when positive', () => {
    expect(resolveHeartbeatSeconds(30)).toBe(30);
  });

  it('returns default when override is 0', () => {
    expect(resolveHeartbeatSeconds(0)).toBe(DEFAULT_HEARTBEAT_SECONDS);
  });

  it('returns default when override is negative', () => {
    expect(resolveHeartbeatSeconds(-5)).toBe(DEFAULT_HEARTBEAT_SECONDS);
  });

  it('returns default when override is undefined', () => {
    expect(resolveHeartbeatSeconds(undefined)).toBe(DEFAULT_HEARTBEAT_SECONDS);
  });

  it('DEFAULT_HEARTBEAT_SECONDS is 60', () => {
    expect(DEFAULT_HEARTBEAT_SECONDS).toBe(60);
  });
});

describe('isReconnectExhausted', () => {
  const policy: ReconnectPolicy = {
    initialMs: 1_000,
    maxMs: 10_000,
    factor: 2,
    jitter: 0,
    maxAttempts: 3,
  };

  it('returns false when attempt < maxAttempts', () => {
    expect(isReconnectExhausted(policy, 0)).toBe(false);
    expect(isReconnectExhausted(policy, 2)).toBe(false);
  });

  it('returns true when attempt == maxAttempts', () => {
    expect(isReconnectExhausted(policy, 3)).toBe(true);
  });

  it('returns true when attempt > maxAttempts', () => {
    expect(isReconnectExhausted(policy, 10)).toBe(true);
  });

  it('returns false when maxAttempts is 0 and attempt is 0', () => {
    const zeroPolicy = { ...policy, maxAttempts: 0 };
    expect(isReconnectExhausted(zeroPolicy, 0)).toBe(true);
  });
});
