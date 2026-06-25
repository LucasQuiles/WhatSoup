/**
 * Direct unit coverage for src/core/substrate/time.ts.
 *
 * The module exposes two helpers used by the substrate vault to manage
 * TTL clamping on submission timestamps:
 *
 * - nowUnixSec: re-export from fleet/time-utils (already covered indirectly)
 * - clampTtl: bounds a requested terminal time to `now + maxHours*3600`,
 *   defaulting to the hard-max when no request is provided
 *
 * No test mirror existed for this module despite TTL clamping being the
 * vault's primary guarantee against runaway holds.
 */
import { describe, expect, it } from 'vitest';
import { clampTtl, nowUnixSec } from '../../../src/core/substrate/time.ts';

describe('nowUnixSec re-export', () => {
  it('returns a finite integer-ish unix-seconds value', () => {
    const t = nowUnixSec();
    expect(typeof t).toBe('number');
    expect(Number.isFinite(t)).toBe(true);
    // Sanity: must be after the year 2020 epoch (1577836800) and before
    // year 2050 (2524608000). Catches accidental ms-vs-sec drift.
    expect(t).toBeGreaterThan(1577836800);
    expect(t).toBeLessThan(2524608000);
  });
});

describe('clampTtl', () => {
  const NOW = 1_700_000_000;
  const ONE_HOUR_SEC = 3600;
  const MAX_HOURS = 24;
  const HARD_MAX = NOW + MAX_HOURS * ONE_HOUR_SEC;

  it('returns hardMax (now + maxHours*3600) when requested is null', () => {
    expect(clampTtl(NOW, null, MAX_HOURS)).toBe(HARD_MAX);
  });

  it('returns hardMax when requested is undefined', () => {
    expect(clampTtl(NOW, undefined, MAX_HOURS)).toBe(HARD_MAX);
  });

  it('returns the requested value when it is below hardMax', () => {
    const requested = NOW + 1000;
    expect(clampTtl(NOW, requested, MAX_HOURS)).toBe(requested);
  });

  it('clamps down to hardMax when requested exceeds the window', () => {
    const requested = NOW + 365 * 24 * ONE_HOUR_SEC; // 1 year out
    expect(clampTtl(NOW, requested, MAX_HOURS)).toBe(HARD_MAX);
  });

  it('accepts requested == hardMax at the boundary', () => {
    expect(clampTtl(NOW, HARD_MAX, MAX_HOURS)).toBe(HARD_MAX);
  });

  it('accepts requested in the past (no floor — only a ceiling)', () => {
    // clampTtl only enforces the ceiling. Past timestamps round-trip
    // unchanged; callers are responsible for any min-future floor.
    const requested = NOW - 1000;
    expect(clampTtl(NOW, requested, MAX_HOURS)).toBe(requested);
  });

  it('handles maxHours=0 (immediate expiry)', () => {
    expect(clampTtl(NOW, null, 0)).toBe(NOW);
    expect(clampTtl(NOW, NOW + 100, 0)).toBe(NOW);
  });

  it('handles fractional maxHours', () => {
    // 0.5 hours = 1800 seconds
    expect(clampTtl(NOW, null, 0.5)).toBe(NOW + 1800);
  });
});
