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
import { fakeClock } from '../../../src/lib/clock.ts';

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

  it('derives the absent-value fallback from the injected clock, not the wall clock (fails if reverted to free nowUnixSec)', () => {
    const t0ms = 2_000_000_000_000; // distinctive future epoch (2033-05-18)
    const fakeNowSec = Math.floor(t0ms / 1000);
    // Omitted fallback must resolve through the injected clock's epoch. Reverted
    // code evaluates the free nowUnixSec() default against the real 2026 wall
    // clock (~1.77e9), never the distinctive ~2e9 value.
    expect(normalizeUnixTimestampSeconds(undefined, undefined, fakeClock(t0ms))).toBe(fakeNowSec);
    expect(normalizeUnixTimestampSeconds('', undefined, fakeClock(t0ms))).toBe(fakeNowSec);
    expect(normalizeUnixTimestampSeconds('not-a-number', undefined, fakeClock(t0ms))).toBe(fakeNowSec);
    expect(normalizeUnixTimestampSeconds(Number.POSITIVE_INFINITY, undefined, fakeClock(t0ms))).toBe(fakeNowSec);
  });

  // A protobuf Long that has been through JSON (for example a stored raw message)
  // loses its prototype and becomes a plain { low, high, unsigned } word pair.
  // Number() of that object is NaN, so it used to fall back to "now".
  describe('Long word pairs that lost their prototype', () => {
    it('decodes an unsigned seconds value', () => {
      expect(normalizeUnixTimestampSeconds({ low: 1_789_108_312, high: 0, unsigned: true }, -1)).toBe(1_789_108_312);
    });

    it('decodes milliseconds whose low word is negative as an int32', () => {
      // 1_789_108_312_123 ms = high word 416, low word 2_401_916_987 (-1_893_050_309 as int32).
      expect(normalizeUnixTimestampSeconds({ low: -1_893_050_309, high: 416, unsigned: true }, -1)).toBe(1_789_108_312);
      expect(normalizeUnixTimestampSeconds({ low: 2_401_916_987, high: 416, unsigned: true }, -1)).toBe(1_789_108_312);
    });

    it('decodes signed words, including when unsigned is omitted', () => {
      expect(normalizeUnixTimestampSeconds({ low: -1_893_050_309, high: 416, unsigned: false }, -1)).toBe(1_789_108_312);
      expect(normalizeUnixTimestampSeconds({ low: 1_789_108_312, high: 0 }, -1)).toBe(1_789_108_312);
      expect(normalizeUnixTimestampSeconds({ low: -5, high: -1, unsigned: false }, 123)).toBe(-5);
    });

    it('returns the decoded instant instead of the clock when no fallback is given', () => {
      const clock = fakeClock(2_000_000_000_000);
      expect(normalizeUnixTimestampSeconds({ low: 1_789_108_312, high: 0, unsigned: true }, undefined, clock)).toBe(
        1_789_108_312,
      );
    });

    it('keeps falling back for malformed or out-of-range word pairs', () => {
      const malformed: unknown[] = [
        {},
        { low: 1_789_108_312 },
        { high: 0 },
        { low: 'x', high: 0 },
        { low: '1789108312', high: 0 },
        { low: 1.5, high: 0 },
        { low: 2 ** 32, high: 0 },
        { low: 0, high: -(2 ** 31) - 1 },
        { low: 1_789_108_312, high: 0, unsigned: 'yes' },
        { low: -1, high: -1, unsigned: true }, // 2^64 - 1 is not a safe integer
        [1_789_108_312, 0],
      ];
      for (const value of malformed) {
        expect(normalizeUnixTimestampSeconds(value, 123), JSON.stringify(value)).toBe(123);
      }
    });
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
