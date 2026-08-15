// Pure, env-driven resolution of the fallback chain-canary knobs.
//
// Mirrors handoff-distill-config.ts: parse + clamp in a pure helper over an
// explicit `env` so resolution is unit-testable without mutating process.env.
// Every knob follows the PROVIDER_FALLBACK_* precedent — malformed, non-finite,
// zero, or negative values fall back to the default; in-range values are
// truncated to integers and clamped.
//
// Why a canary exists at all (fleet incident 2026-08-15): a fallback entry
// whose ACCOUNT is dead (billing suspension) passes every metadata check — the
// provider's models endpoint returns 200 and the key is present — and only a
// REAL completion reveals it. The first entry of a fleet chain was dead for 24
// days with zero signal, then pinned an outage while healthy entries waited
// behind it. The canary issues a tiny real completion per configured entry on
// an interval, records per-entry evidence, alerts on transitions, and lets
// window selection skip entries with fresh failure evidence.

import { MS_PER_HOUR, MS_PER_MINUTE } from '../../lib/time-units.ts';

export interface FallbackCanaryConfig {
  /** Probe cadence; 0 disables the periodic canary entirely (default). */
  intervalMs: number;
  /** How long failure evidence is trusted by selection before it goes stale. */
  trustMs: number;
  /** Per-probe hard timeout. */
  timeoutMs: number;
}

type Env = Record<string, string | undefined>;

/** The probe prompt — deliberately tiny; the answer content is irrelevant. */
export const CHAIN_CANARY_PROMPT = 'Reply with exactly: OK';

function resolveNumber(
  raw: string | undefined,
  def: number,
  min: number,
  max: number,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

// env-allowed: default param passes env into the pure resolver at the call boundary
export function resolveFallbackCanaryConfig(env: Env = process.env): FallbackCanaryConfig {
  const rawInterval = Number(env['WHATSOUP_FALLBACK_CANARY_MS']);
  // 0/absent/malformed → disabled. A positive value is clamped to [1min, 24h].
  const intervalMs = Number.isFinite(rawInterval) && rawInterval > 0
    ? Math.min(Math.max(Math.trunc(rawInterval), MS_PER_MINUTE), 24 * MS_PER_HOUR)
    : 0;
  const trustMs = resolveNumber(
    env['WHATSOUP_FALLBACK_CANARY_TRUST_MS'],
    intervalMs > 0 ? intervalMs * 2 : 12 * MS_PER_HOUR,
    MS_PER_MINUTE,
    48 * MS_PER_HOUR,
  );
  const timeoutMs = resolveNumber(
    env['WHATSOUP_FALLBACK_CANARY_TIMEOUT_MS'],
    90_000,
    10_000,
    5 * MS_PER_MINUTE,
  );
  return { intervalMs, trustMs, timeoutMs };
}
