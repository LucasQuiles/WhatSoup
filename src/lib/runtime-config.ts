// src/lib/runtime-config.ts
// Canonical registry of every runtime process.env access.
//
// This module is the single source of truth (SSOT) for environment-variable
// reads. Before this module existed, process.env.* was accessed directly in
// 17+ files without typed defaults or validation — violating SSOT, SOC, and
// type safety (all values are string | undefined with no defaults).
//
// Phase 1 (this module): establishes typed accessors and migrates the
// highest-risk sites (flag-parsing, JSON parsing, bind addresses, PATH).
// Phase 2 (follow-up): migrate remaining sites and add an ESLint rule
// that blocks direct process.env access outside this module.
//
// See #2192 for the full design rationale.

/**
 * Read a string env var with a fallback. Never throws.
 * @example envStr('FLEET_BIND_ADDRESS', '127.0.0.1')
 */
export function envStr(key: string, fallback: string): string {
  const val = process.env[key];
  return val !== undefined && val !== '' ? val : fallback;
}

/**
 * Read a boolean env var. Accepts '1'/'true' (case-insensitive) as true.
 * Everything else (including unset) returns the fallback.
 * @example envBool('WHATSOUP_PREFLIGHT_IMPORT_ONLY', false)
 */
export function envBool(key: string, fallback: boolean): boolean {
  const val = process.env[key];
  if (val === undefined || val === '') return fallback;
  const lower = val.toLowerCase();
  return lower === '1' || lower === 'true' ? true : lower === '0' || lower === 'false' ? false : fallback;
}

/**
 * Read an integer env var with a fallback. Returns fallback on NaN.
 * @example envInt('PORT', 3000)
 */
export function envInt(key: string, fallback: number): number {
  const val = process.env[key];
  if (val === undefined || val === '') return fallback;
  const parsed = parseInt(val, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * Read a string env var that may be absent (returns undefined, not a default).
 * Use this for optional vars where '' and unset are both valid "not set".
 * @example envStrOpt('WHATSOUP_GIT_SHA')
 */
export function envStrOpt(key: string): string | undefined {
  const val = process.env[key];
  return val !== undefined && val !== '' ? val : undefined;
}
