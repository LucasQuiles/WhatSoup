import { describe, expect, it } from 'vitest';

import { DEFAULT_FRESH_INVALID_GRACE_MS } from '../../src/lib/auth-bond-policy.ts';

describe('auth-bond-policy constants', () => {
  it('DEFAULT_FRESH_INVALID_GRACE_MS is defined', () => {
    expect(DEFAULT_FRESH_INVALID_GRACE_MS).toBeDefined();
  });

  it('DEFAULT_FRESH_INVALID_GRACE_MS is a number', () => {
    expect(typeof DEFAULT_FRESH_INVALID_GRACE_MS).toBe('number');
  });

  it('DEFAULT_FRESH_INVALID_GRACE_MS is exactly 10000 milliseconds', () => {
    expect(DEFAULT_FRESH_INVALID_GRACE_MS).toBe(10_000);
  });

  it('DEFAULT_FRESH_INVALID_GRACE_MS is positive', () => {
    expect(DEFAULT_FRESH_INVALID_GRACE_MS).toBeGreaterThan(0);
  });

  it('DEFAULT_FRESH_INVALID_GRACE_MS is a reasonable timeout value', () => {
    // 10 seconds is a reasonable grace period for auth bond freshness checks
    expect(DEFAULT_FRESH_INVALID_GRACE_MS).toBeLessThan(60_000);
    expect(DEFAULT_FRESH_INVALID_GRACE_MS).toBeGreaterThanOrEqual(1_000);
  });

  it('can be used in time comparisons', () => {
    const now = Date.now();
    const withinGrace = now - (DEFAULT_FRESH_INVALID_GRACE_MS - 1000);
    const outsideGrace = now - (DEFAULT_FRESH_INVALID_GRACE_MS + 1000);
    expect(withinGrace > now - DEFAULT_FRESH_INVALID_GRACE_MS).toBe(true);
    expect(outsideGrace > now - DEFAULT_FRESH_INVALID_GRACE_MS).toBe(false);
  });
});
