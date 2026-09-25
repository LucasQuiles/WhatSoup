// ---------------------------------------------------------------------------
//  Fleet-only timestamp utilities. nowUnixSec/normalizeUnixTimestampSeconds
//  moved to src/core/substrate/time.ts (#2242) — those two are consumed by
//  core/transport/mcp callers; the helpers below have no consumer outside
//  src/fleet/, so they stay here and import the canonical primitive down
//  from core.
// ---------------------------------------------------------------------------
import { UNIX_MILLISECONDS_THRESHOLD } from '../core/substrate/time.ts';

/**
 * Convert a Unix timestamp (seconds or milliseconds) to an ISO string that
 * keeps the represented instant (#2526). This is a formatter, not the
 * epoch-seconds storage boundary: it must not floor a millisecond value to
 * whole seconds, or distinct records inside one second collapse to one time.
 */
export function toIsoFromUnix(ts: number): string {
  const epochMs = Math.floor(ts) >= UNIX_MILLISECONDS_THRESHOLD ? ts : ts * 1000;
  return new Date(epochMs).toISOString();
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
