import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  normalizeTimestamp,
  normalizeUnixTimestampSeconds,
  nowUnixSec,
  toIsoFromUnix,
} from '../../src/fleet/time-utils.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fleet time-utils', () => {
  it('converts unix seconds and milliseconds to ISO', () => {
    expect(toIsoFromUnix(1_744_000_000)).toBe('2025-04-07T04:26:40.000Z');
    expect(toIsoFromUnix(1_744_000_000_000)).toBe('2025-04-07T04:26:40.000Z');
  });

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

  it('normalizes sqlite datetime strings and unix numbers', () => {
    expect(normalizeTimestamp('2026-04-05 12:34:56')).toBe('2026-04-05T12:34:56.000Z');
    expect(normalizeTimestamp(1_744_000_000)).toBe('2025-04-07T04:26:40.000Z');
    expect(normalizeTimestamp('2026-04-05T12:34:56.000Z')).toBe('2026-04-05T12:34:56.000Z');
  });

  it('keeps SQLite datetime strings out of the Unix-number path', () => {
    expect(normalizeTimestamp('2026-06-13 07:54:22')).toBe('2026-06-13T07:54:22.000Z');
    expect(normalizeTimestamp('2026-06-13 07:54:22')).not.toBe('1970-01-01T00:33:46.000Z');
  });

  it('returns null for unsupported timestamp inputs', () => {
    expect(normalizeTimestamp(null)).toBeNull();
    expect(normalizeTimestamp('')).toBeNull();
    expect(normalizeTimestamp('not-a-timestampTstill-invalid')).toBeNull();
    expect(normalizeTimestamp('not-a-timestamp')).toBeNull();
    expect(normalizeTimestamp({})).toBeNull();
  });

  it('returns the current unix timestamp in seconds', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_744_000_123_987);
    expect(nowUnixSec()).toBe(1_744_000_123);
  });
});
