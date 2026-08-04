// Pure, env-driven resolution of the background handoff-distiller knobs.
//
// The runtime hardcoded these as module-scope consts; extracting the parse +
// clamp logic into a pure helper keeps it unit-testable WITHOUT mutating
// process.env at module-load time. runtime.ts calls
// resolveHandoffDistillConfig(process.env) once and feeds the result into the
// sweep / runner exactly where the consts used to sit.
//
// Every knob follows the established PROVIDER_FALLBACK_* precedent: a malformed,
// non-finite, zero, or negative value falls back to the default; an in-range
// value is truncated to an integer (where integral) and clamped to [min, max].
// With no env set the result is byte-identical to the prior hardcoded values.

import { type DistillBudgetConfig } from './handoff-distill-gate.ts';
import { MS_PER_HOUR } from '../../lib/time-units.ts';

export interface HandoffDistillConfig {
  sweepMs: number;
  growthThreshold: number;
  verbatimN: number;
  budget: DistillBudgetConfig;
}

type Env = Record<string, string | undefined>;

/**
 * Parse a positive numeric env value, clamping into [min, max]. Non-finite,
 * zero, or negative values fall back to `def`. When `integer` is true the value
 * is truncated toward zero before clamping (matching the PROVIDER_FALLBACK_*
 * `Math.trunc` precedent).
 */
function resolveNumber(
  raw: string | undefined,
  def: number,
  min: number,
  max: number,
  integer: boolean,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  const v = integer ? Math.trunc(n) : n;
  return Math.min(Math.max(v, min), max);
}

export function resolveHandoffDistillConfig(env: Env): HandoffDistillConfig {
  const sweepMs = resolveNumber(
    env['WHATSOUP_HANDOFF_DISTILL_SWEEP_MS'],
    60_000,
    10_000, // 10s floor — sub-10s sweeps would hammer the runner machinery.
    MS_PER_HOUR, // 1h ceiling.
    false,
  );
  const growthThreshold = resolveNumber(
    env['WHATSOUP_HANDOFF_DISTILL_GROWTH_THRESHOLD'],
    4_000,
    500,
    1_000_000,
    true,
  );
  const verbatimN = resolveNumber(
    env['WHATSOUP_HANDOFF_DISTILL_VERBATIM_N'],
    40,
    1,
    200,
    true,
  );
  const maxTokensPerWindow = resolveNumber(
    env['WHATSOUP_HANDOFF_DISTILL_MAX_TOKENS'],
    50_000,
    1_000,
    5_000_000,
    true,
  );
  const maxCallsPerWindow = resolveNumber(
    env['WHATSOUP_HANDOFF_DISTILL_MAX_CALLS'],
    6,
    1,
    1_000,
    true,
  );
  const windowMs = resolveNumber(
    env['WHATSOUP_HANDOFF_DISTILL_WINDOW_MS'],
    MS_PER_HOUR,
    60_000,
    86_400_000,
    false,
  );
  const failureThreshold = resolveNumber(
    env['WHATSOUP_HANDOFF_DISTILL_FAILURE_THRESHOLD'],
    3,
    1,
    100,
    true,
  );
  const breakerCooldownMs = resolveNumber(
    env['WHATSOUP_HANDOFF_DISTILL_BREAKER_COOLDOWN_MS'],
    300_000,
    10_000,
    86_400_000,
    false,
  );
  const globalConcurrency = resolveNumber(
    env['WHATSOUP_HANDOFF_DISTILL_GLOBAL_CONCURRENCY'],
    2,
    1,
    32,
    true,
  );

  return {
    sweepMs,
    growthThreshold,
    verbatimN,
    budget: {
      maxTokensPerWindow,
      maxCallsPerWindow,
      windowMs,
      failureThreshold,
      breakerCooldownMs,
      globalConcurrency,
    },
  };
}

// ---------------------------------------------------------------------------
// Handoff feature-flag / model readers
// ---------------------------------------------------------------------------
// Trivial env-flag reads, extracted from AgentRuntime alongside the knob
// resolution above (same WHATSOUP_HANDOFF_* env surface). Default to process.env
// so existing callers are behavior-identical; the env param keeps them testable.

/** Whether the background handoff distiller sweep is enabled. */
export function handoffDistillerEnabled(env: Env = process.env): boolean {
  return env['WHATSOUP_HANDOFF_DISTILLER'] === '1';
}

/** Whether handoff context injection is enabled. */
export function handoffContextEnabled(env: Env = process.env): boolean {
  return env['WHATSOUP_HANDOFF_CONTEXT'] === '1';
}

/** The configured handoff distill model id, or null when unset. */
export function handoffDistillModel(env: Env = process.env): string | null {
  return env['WHATSOUP_HANDOFF_DISTILL_MODEL']?.trim() || null;
}
