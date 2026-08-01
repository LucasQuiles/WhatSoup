// src/core/substrate/time.ts
// Canonical home for cross-ring timestamp utilities (#2242 — previously
// stranded in src/fleet/time-utils.ts, forcing core/transport/mcp callers to
// import upward across the fleet ring boundary).

const UNIX_MILLISECONDS_THRESHOLD = 100_000_000_000;

/** Current time as Unix seconds. */
export function nowUnixSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** Normalize a Unix timestamp-like value to epoch seconds. */
export function normalizeUnixTimestampSeconds(value: unknown, fallback = nowUnixSec()): number {
  if (value == null || value === '') return fallback;
  const numeric = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const whole = Math.floor(numeric);
  return whole >= UNIX_MILLISECONDS_THRESHOLD ? Math.floor(whole / 1000) : whole;
}

/** Clamp requestedTerminalAt to now + maxHours*3600. */
export function clampTtl(now: number, requested: number | null | undefined, maxHours: number): number {
  const hardMax = now + maxHours * 3600;
  if (requested == null) return hardMax;
  return Math.min(requested, hardMax);
}
