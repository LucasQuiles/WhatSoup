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

import {
  defaultHandoffDistillConfig,
  HANDOFF_DISTILL_NUMERIC_LIMITS,
  type HandoffDistillConfig,
} from '../../lib/handoff-distill-config.ts';

export {
  resolveTypedHandoffDistillConfig,
  type HandoffDistillConfig,
  type TypedHandoffDistillConfig,
  type TypedHandoffDistillInput,
} from '../../lib/handoff-distill-config.ts';

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
    defaultHandoffDistillConfig().sweepMs,
    HANDOFF_DISTILL_NUMERIC_LIMITS.sweepMs.min,
    HANDOFF_DISTILL_NUMERIC_LIMITS.sweepMs.max,
    HANDOFF_DISTILL_NUMERIC_LIMITS.sweepMs.integer,
  );
  const growthThreshold = resolveNumber(
    env['WHATSOUP_HANDOFF_DISTILL_GROWTH_THRESHOLD'],
    defaultHandoffDistillConfig().growthThreshold,
    HANDOFF_DISTILL_NUMERIC_LIMITS.growthThreshold.min,
    HANDOFF_DISTILL_NUMERIC_LIMITS.growthThreshold.max,
    HANDOFF_DISTILL_NUMERIC_LIMITS.growthThreshold.integer,
  );
  const verbatimN = resolveNumber(
    env['WHATSOUP_HANDOFF_DISTILL_VERBATIM_N'],
    defaultHandoffDistillConfig().verbatimN,
    HANDOFF_DISTILL_NUMERIC_LIMITS.verbatimN.min,
    HANDOFF_DISTILL_NUMERIC_LIMITS.verbatimN.max,
    HANDOFF_DISTILL_NUMERIC_LIMITS.verbatimN.integer,
  );
  const maxTokensPerWindow = resolveNumber(
    env['WHATSOUP_HANDOFF_DISTILL_MAX_TOKENS'],
    defaultHandoffDistillConfig().budget.maxTokensPerWindow,
    HANDOFF_DISTILL_NUMERIC_LIMITS.maxTokensPerWindow.min,
    HANDOFF_DISTILL_NUMERIC_LIMITS.maxTokensPerWindow.max,
    HANDOFF_DISTILL_NUMERIC_LIMITS.maxTokensPerWindow.integer,
  );
  const maxCallsPerWindow = resolveNumber(
    env['WHATSOUP_HANDOFF_DISTILL_MAX_CALLS'],
    defaultHandoffDistillConfig().budget.maxCallsPerWindow,
    HANDOFF_DISTILL_NUMERIC_LIMITS.maxCallsPerWindow.min,
    HANDOFF_DISTILL_NUMERIC_LIMITS.maxCallsPerWindow.max,
    HANDOFF_DISTILL_NUMERIC_LIMITS.maxCallsPerWindow.integer,
  );
  const windowMs = resolveNumber(
    env['WHATSOUP_HANDOFF_DISTILL_WINDOW_MS'],
    defaultHandoffDistillConfig().budget.windowMs,
    HANDOFF_DISTILL_NUMERIC_LIMITS.windowMs.min,
    HANDOFF_DISTILL_NUMERIC_LIMITS.windowMs.max,
    HANDOFF_DISTILL_NUMERIC_LIMITS.windowMs.integer,
  );
  const failureThreshold = resolveNumber(
    env['WHATSOUP_HANDOFF_DISTILL_FAILURE_THRESHOLD'],
    defaultHandoffDistillConfig().budget.failureThreshold,
    HANDOFF_DISTILL_NUMERIC_LIMITS.failureThreshold.min,
    HANDOFF_DISTILL_NUMERIC_LIMITS.failureThreshold.max,
    HANDOFF_DISTILL_NUMERIC_LIMITS.failureThreshold.integer,
  );
  const breakerCooldownMs = resolveNumber(
    env['WHATSOUP_HANDOFF_DISTILL_BREAKER_COOLDOWN_MS'],
    defaultHandoffDistillConfig().budget.breakerCooldownMs,
    HANDOFF_DISTILL_NUMERIC_LIMITS.breakerCooldownMs.min,
    HANDOFF_DISTILL_NUMERIC_LIMITS.breakerCooldownMs.max,
    HANDOFF_DISTILL_NUMERIC_LIMITS.breakerCooldownMs.integer,
  );
  const globalConcurrency = resolveNumber(
    env['WHATSOUP_HANDOFF_DISTILL_GLOBAL_CONCURRENCY'],
    defaultHandoffDistillConfig().budget.globalConcurrency,
    HANDOFF_DISTILL_NUMERIC_LIMITS.globalConcurrency.min,
    HANDOFF_DISTILL_NUMERIC_LIMITS.globalConcurrency.max,
    HANDOFF_DISTILL_NUMERIC_LIMITS.globalConcurrency.integer,
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
// env-allowed: pure-resolver param-default; the DI idiom, not a bypass
export function handoffDistillerEnabled(env: Env = process.env): boolean {
  return env['WHATSOUP_HANDOFF_DISTILLER'] === '1';
}

/** Whether handoff context injection is enabled. */
// env-allowed: pure-resolver param-default; the DI idiom, not a bypass
export function handoffContextEnabled(env: Env = process.env): boolean {
  return env['WHATSOUP_HANDOFF_CONTEXT'] === '1';
}

/** The configured handoff distill model id, or null when unset. */
// env-allowed: pure-resolver param-default; the DI idiom, not a bypass
export function handoffDistillModel(env: Env = process.env): string | null {
  return env['WHATSOUP_HANDOFF_DISTILL_MODEL']?.trim() || null;
}
