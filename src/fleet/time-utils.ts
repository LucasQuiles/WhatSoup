// ---------------------------------------------------------------------------
//  Shared timestamp utilities for the fleet layer.
// ---------------------------------------------------------------------------

const UNIX_MILLISECONDS_THRESHOLD = 100_000_000_000;

/** Normalize a Unix timestamp-like value to epoch seconds. */
export function normalizeUnixTimestampSeconds(value: unknown, fallback = nowUnixSec()): number {
  if (value == null || value === '') return fallback;
  const numeric = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const whole = Math.floor(numeric);
  return whole >= UNIX_MILLISECONDS_THRESHOLD ? Math.floor(whole / 1000) : whole;
}

/** Convert Unix timestamp (seconds or milliseconds) to ISO string.
 *
 * Preserves millisecond precision: does NOT route through
 * ``normalizeUnixTimestampSeconds`` (which floors to epoch seconds for
 * storage).  Instead, detects seconds vs. milliseconds directly so a
 * numeric Pino timestamp ending in .676 round-trips as .676Z (#2526). */
export function toIsoFromUnix(ts: number): string {
  const ms = ts >= UNIX_MILLISECONDS_THRESHOLD ? ts : ts * 1000;
  return new Date(ms).toISOString();
}

/** Current time as Unix seconds. */
export function nowUnixSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Normalize a timestamp value to an ISO 8601 string.
 *
 * Handles:
 * - ISO 8601 strings (returned as-is)
 * - SQLite datetime format "YYYY-MM-DD HH:MM:SS" (treated as UTC)
 * - Unix seconds/milliseconds (number)
 *
 * Returns `null` for falsy, unparseable, or unsupported input.
 */
export function normalizeTimestamp(ts: unknown): string | null {
  if (!ts) return null;
  if (typeof ts === 'number') return toIsoFromUnix(ts);
  if (typeof ts !== 'string') return null;
  // Already ISO 8601 (has T and Z or timezone offset)
  if (ts.includes('T')) {
    const d = new Date(ts);
    return isNaN(d.getTime()) ? null : ts;
  }
  // SQLite datetime format "YYYY-MM-DD HH:MM:SS" — treat as UTC
  const d = new Date(ts.replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Strict ISO-8601 UTC check: the value must round-trip exactly through
 * Date#toISOString (millisecond precision, trailing Z). This is the same
 * round-trip rule the fleet artifact contracts apply; date-only strings and
 * non-UTC offsets are rejected.
 */
export function isStrictIsoUtcTimestamp(value: string): boolean {
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}
