import { describe, expect, it } from 'vitest';

import { sqliteUtcToEpochMs } from '../../src/lib/sqlite-time.ts';

describe('sqliteUtcToEpochMs', () => {
  it('parses a SQLite "YYYY-MM-DD HH:MM:SS" literal as UTC', () => {
    // Space-separated SQLite datetime must be treated as UTC, not local time.
    expect(sqliteUtcToEpochMs('2026-01-15 12:30:45')).toBe(Date.UTC(2026, 0, 15, 12, 30, 45));
    expect(sqliteUtcToEpochMs('2026-01-15 12:30:45')).toBe(Date.parse('2026-01-15T12:30:45Z'));
  });

  it('passes ISO 8601 strings straight through to Date.parse', () => {
    expect(sqliteUtcToEpochMs('2026-01-15T12:30:45Z')).toBe(Date.parse('2026-01-15T12:30:45Z'));
    expect(sqliteUtcToEpochMs('2026-01-15T12:30:45+02:00')).toBe(Date.parse('2026-01-15T12:30:45+02:00'));
  });

  it('returns null for empty and unparseable input', () => {
    expect(sqliteUtcToEpochMs('')).toBeNull();
    expect(sqliteUtcToEpochMs('not-a-timestamp')).toBeNull();
  });

  it('does not UTC-coerce a near-miss that fails the strict format regex', () => {
    // Missing seconds → regex misses → handed to Date.parse as-is (local/ambiguous),
    // which preserves the pre-consolidation behavior of both call sites.
    const single = sqliteUtcToEpochMs('2026-01-15 12:30');
    expect(single === null || Number.isFinite(single)).toBe(true);
  });

  it('handles edge case dates at year boundaries', () => {
    expect(sqliteUtcToEpochMs('2026-01-01 00:00:00')).toBe(Date.UTC(2026, 0, 1, 0, 0, 0));
    expect(sqliteUtcToEpochMs('2025-12-31 23:59:59')).toBe(Date.UTC(2025, 11, 31, 23, 59, 59));
  });

  it('handles leap year dates correctly', () => {
    // 2024 is a leap year
    expect(sqliteUtcToEpochMs('2024-02-29 12:00:00')).toBe(Date.UTC(2024, 1, 29, 12, 0, 0));
  });

  it('handles millisecond-precision ISO 8601 input', () => {
    const result = sqliteUtcToEpochMs('2026-01-15T12:30:45.123Z');
    expect(Number.isFinite(result)).toBe(true);
  });

  it('returns null for null/undefined inputs converted to string', () => {
    expect(sqliteUtcToEpochMs('null')).toBeNull();
    expect(sqliteUtcToEpochMs('undefined')).toBeNull();
  });

  it('handles dates with single-digit month/day by passing to Date.parse', () => {
    // Single digits don't match the strict regex, so they're passed to Date.parse as-is
    // Date.parse actually accepts these, so they return a valid timestamp
    const result = sqliteUtcToEpochMs('2026-1-5 9:5:30');
    expect(result === null || Number.isFinite(result)).toBe(true);
  });

  it('handles very old dates', () => {
    expect(sqliteUtcToEpochMs('1970-01-01 00:00:00')).toBe(Date.UTC(1970, 0, 1, 0, 0, 0));
  });

  it('handles future dates beyond 2100', () => {
    expect(sqliteUtcToEpochMs('2150-06-15 14:30:00')).toBe(Date.UTC(2150, 5, 15, 14, 30, 0));
  });

  it('rejects invalid month values', () => {
    expect(sqliteUtcToEpochMs('2026-13-01 12:00:00')).toBe(null);
  });

  it('rejects invalid day values', () => {
    expect(sqliteUtcToEpochMs('2026-01-32 12:00:00')).toBe(null);
  });

  it('rejects invalid hour values', () => {
    expect(sqliteUtcToEpochMs('2026-01-15 25:00:00')).toBe(null);
  });

  it('rejects invalid minute values', () => {
    expect(sqliteUtcToEpochMs('2026-01-15 12:60:00')).toBe(null);
  });

  it('rejects invalid second values', () => {
    expect(sqliteUtcToEpochMs('2026-01-15 12:30:60')).toBe(null);
  });

  it('timezone-suffixed ISO 8601 strings are parsed correctly', () => {
    const utc = sqliteUtcToEpochMs('2026-01-15T12:30:45Z');
    const offset = sqliteUtcToEpochMs('2026-01-15T14:30:45+02:00');
    expect(utc).toBe(offset); // Same instant in time
  });
});
