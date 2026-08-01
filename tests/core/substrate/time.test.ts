/**
 * Direct unit coverage for src/core/substrate/time.ts.
 *
 * The module is the canonical home (#2242) for cross-ring timestamp
 * primitives, plus one substrate-local helper:
 *
 * - nowUnixSec: current time as Unix seconds
 * - normalizeUnixTimestampSeconds: normalizes a Unix timestamp-like value
 *   (seconds, milliseconds, or bigint) to epoch seconds
 * - clampTtl: bounds a requested terminal time to `now + maxHours*3600`,
 *   defaulting to the hard-max when no request is provided
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { clampTtl, normalizeUnixTimestampSeconds, nowUnixSec } from '../../../src/core/substrate/time.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('nowUnixSec', () => {
  it('returns a finite integer-ish unix-seconds value', () => {
    const t = nowUnixSec();
    expect(typeof t).toBe('number');
    expect(Number.isFinite(t)).toBe(true);
    // Sanity: must be after the year 2020 epoch (1577836800) and before
    // year 2050 (2524608000). Catches accidental ms-vs-sec drift.
    expect(t).toBeGreaterThan(1577836800);
    expect(t).toBeLessThan(2524608000);
  });

  it('returns the current unix timestamp in seconds', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_744_000_123_987);
    expect(nowUnixSec()).toBe(1_744_000_123);
  });
});

describe('normalizeUnixTimestampSeconds', () => {
  it('normalizes unix seconds and milliseconds to stored epoch seconds', () => {
    expect(normalizeUnixTimestampSeconds(1_777_824_570)).toBe(1_777_824_570);
    expect(normalizeUnixTimestampSeconds(1_777_824_570_676)).toBe(1_777_824_570);
    expect(normalizeUnixTimestampSeconds(BigInt(1_777_824_570_676))).toBe(1_777_824_570);
  });

  it('uses the caller fallback for absent or non-finite unix timestamp values', () => {
    expect(normalizeUnixTimestampSeconds(undefined, 123)).toBe(123);
    expect(normalizeUnixTimestampSeconds('', 123)).toBe(123);
    expect(normalizeUnixTimestampSeconds('not-a-number', 123)).toBe(123);
    expect(normalizeUnixTimestampSeconds(Number.POSITIVE_INFINITY, 123)).toBe(123);
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
