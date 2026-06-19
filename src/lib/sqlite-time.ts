// src/lib/sqlite-time.ts
// Shared SQLite-UTC timestamp parsing. SQLite's `datetime()` emits
// "YYYY-MM-DD HH:MM:SS" with no timezone; it must be treated as UTC. This is
// the canonical epoch-ms parser; callers own their own input guarding.

/**
 * Parse a timestamp string to epoch milliseconds.
 *
 * A SQLite datetime literal ("YYYY-MM-DD HH:MM:SS") is normalized to UTC
 * (space → `T`, append `Z`) before parsing; any other string is passed to
 * `Date.parse` as-is (so ISO 8601 inputs work unchanged).
 *
 * Returns `null` when the value does not parse to a finite timestamp.
 */
export function sqliteUtcToEpochMs(value: string): number | null {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}
