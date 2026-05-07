// ---------------------------------------------------------------------------
//  Shared timestamp utilities for the fleet layer.
// ---------------------------------------------------------------------------

/** Convert Unix timestamp (seconds or milliseconds) to ISO string. */
export function toIsoFromUnix(ts: number): string {
  return new Date(ts > 1e12 ? ts : ts * 1000).toISOString();
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
