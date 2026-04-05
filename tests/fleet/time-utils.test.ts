import { describe, expect, it, vi, afterEach } from 'vitest';
import { normalizeTimestamp, nowUnixSec, toIsoFromUnix } from '../../src/fleet/time-utils.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fleet time-utils', () => {
  it('converts unix seconds and milliseconds to ISO', () => {
    expect(toIsoFromUnix(1_744_000_000)).toBe('2025-04-07T04:26:40.000Z');
    expect(toIsoFromUnix(1_744_000_000_000)).toBe('2025-04-07T04:26:40.000Z');
  });

  it('normalizes sqlite datetime strings and unix numbers', () => {
    expect(normalizeTimestamp('2026-04-05 12:34:56')).toBe('2026-04-05T12:34:56.000Z');
    expect(normalizeTimestamp(1_744_000_000)).toBe('2025-04-07T04:26:40.000Z');
    expect(normalizeTimestamp('2026-04-05T12:34:56.000Z')).toBe('2026-04-05T12:34:56.000Z');
  });

  it('returns null for unsupported timestamp inputs', () => {
    expect(normalizeTimestamp(null)).toBeNull();
    expect(normalizeTimestamp('')).toBeNull();
    expect(normalizeTimestamp({})).toBeNull();
  });

  it('returns the current unix timestamp in seconds', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_744_000_123_987);
    expect(nowUnixSec()).toBe(1_744_000_123);
  });
});
