// src/core/substrate/time.ts
// Canonical home for cross-ring timestamp utilities (#2242 — previously
// stranded in src/fleet/time-utils.ts, forcing core/transport/mcp callers to
// import upward across the fleet ring boundary).

import { type Clock, systemClock } from '../../lib/clock.ts';

/** Numeric Unix timestamps at or above this value are milliseconds; below it, seconds. */
export const UNIX_MILLISECONDS_THRESHOLD = 100_000_000_000;

/** Current time as Unix seconds. */
export function nowUnixSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** Normalize a Unix timestamp-like value to epoch seconds. */
export function normalizeUnixTimestampSeconds(
  value: unknown,
  fallback?: number,
  // Injectable so the absent-value fallback can be driven to a known instant
  // (#2200). Optional and defaulted, so no existing call site changes behavior.
  clock: Clock = systemClock,
): number {
  const resolvedFallback = fallback === undefined ? clock.nowUnixSec() : fallback;
  if (value == null || value === '') return resolvedFallback;
  const numeric = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isFinite(numeric)) {
    const decoded = longWordsToNumber(value);
    return decoded === undefined ? resolvedFallback : normalizeUnixTimestampSeconds(decoded, resolvedFallback);
  }
  const whole = Math.floor(numeric);
  return whole >= UNIX_MILLISECONDS_THRESHOLD ? Math.floor(whole / 1000) : whole;
}

const INT32_MIN = -(2 ** 31);
const UINT32_MAX = 2 ** 32 - 1;

function isLongWord(word: unknown): word is number {
  return Number.isInteger(word) && (word as number) >= INT32_MIN && (word as number) <= UINT32_MAX;
}

/**
 * Decode a protobuf Long that lost its prototype (for example after JSON), which
 * leaves a plain `{ low, high, unsigned? }` object. Live Long instances already
 * convert through `Number()`. Returns undefined for any other shape or for values
 * outside the safe-integer range.
 */
function longWordsToNumber(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { low, high, unsigned } = value as { low?: unknown; high?: unknown; unsigned?: unknown };
  if (!isLongWord(low) || !isLongWord(high)) return undefined;
  if (unsigned !== undefined && typeof unsigned !== 'boolean') return undefined;
  const highWord = unsigned ? high >>> 0 : high | 0;
  const result = highWord * 2 ** 32 + (low >>> 0);
  return Number.isSafeInteger(result) ? result : undefined;
}

/** Clamp requestedTerminalAt to now + maxHours*3600. */
export function clampTtl(now: number, requested: number | null | undefined, maxHours: number): number {
  const hardMax = now + maxHours * 3600;
  if (requested == null) return hardMax;
  return Math.min(requested, hardMax);
}
