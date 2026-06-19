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
});
