import { MS_PER_HOUR } from './time-units.ts';

/** Budget and concurrency limits consumed by the handoff distill runner. */
export interface HandoffDistillBudgetConfig {
  maxTokensPerWindow: number;
  maxCallsPerWindow: number;
  windowMs: number;
  failureThreshold: number;
  breakerCooldownMs: number;
  globalConcurrency: number;
}

/** Scheduler and runner configuration shared by legacy and typed handoff paths. */
export interface HandoffDistillConfig {
  sweepMs: number;
  growthThreshold: number;
  verbatimN: number;
  budget: HandoffDistillBudgetConfig;
}

export interface TypedHandoffDistillInput {
  enabled: boolean;
  contextInjection?: boolean;
  provider?: string;
  model?: string;
  sweepMs?: number;
  growthThreshold?: number;
  verbatimN?: number;
  maxTokensPerWindow?: number;
  maxCallsPerWindow?: number;
  windowMs?: number;
  failureThreshold?: number;
  breakerCooldownMs?: number;
  globalConcurrency?: number;
}

/** Normalized instance policy. Its absence at the runtime boundary retains legacy env behavior. */
export interface TypedHandoffDistillConfig {
  enabled: boolean;
  contextInjection: boolean;
  model: string | null;
  config: HandoffDistillConfig;
}

export const HANDOFF_DISTILL_NUMERIC_LIMITS = {
  sweepMs: { min: 10_000, max: MS_PER_HOUR, integer: false },
  growthThreshold: { min: 500, max: 1_000_000, integer: true },
  verbatimN: { min: 1, max: 200, integer: true },
  maxTokensPerWindow: { min: 1_000, max: 5_000_000, integer: true },
  maxCallsPerWindow: { min: 1, max: 1_000, integer: true },
  windowMs: { min: 60_000, max: 86_400_000, integer: false },
  failureThreshold: { min: 1, max: 100, integer: true },
  breakerCooldownMs: { min: 10_000, max: 86_400_000, integer: false },
  globalConcurrency: { min: 1, max: 32, integer: true },
} as const;

/** Return a fresh copy so no runtime can mutate another instance's defaults. */
export function defaultHandoffDistillConfig(): HandoffDistillConfig {
  return {
    sweepMs: 60_000,
    growthThreshold: 4_000,
    verbatimN: 40,
    budget: {
      maxTokensPerWindow: 50_000,
      maxCallsPerWindow: 6,
      windowMs: MS_PER_HOUR,
      failureThreshold: 3,
      breakerCooldownMs: 300_000,
      globalConcurrency: 2,
    },
  };
}

/** Resolve an already-validated instance object without reading process.env. */
export function resolveTypedHandoffDistillConfig(input: TypedHandoffDistillInput): TypedHandoffDistillConfig {
  const defaults = defaultHandoffDistillConfig();
  if (!input.enabled) {
    return { enabled: false, contextInjection: false, model: null, config: defaults };
  }
  return {
    enabled: true,
    contextInjection: input.contextInjection === true,
    model: input.model ?? null,
    config: {
      sweepMs: input.sweepMs ?? defaults.sweepMs,
      growthThreshold: input.growthThreshold ?? defaults.growthThreshold,
      verbatimN: input.verbatimN ?? defaults.verbatimN,
      budget: {
        maxTokensPerWindow: input.maxTokensPerWindow ?? defaults.budget.maxTokensPerWindow,
        maxCallsPerWindow: input.maxCallsPerWindow ?? defaults.budget.maxCallsPerWindow,
        windowMs: input.windowMs ?? defaults.budget.windowMs,
        failureThreshold: input.failureThreshold ?? defaults.budget.failureThreshold,
        breakerCooldownMs: input.breakerCooldownMs ?? defaults.budget.breakerCooldownMs,
        globalConcurrency: input.globalConcurrency ?? defaults.budget.globalConcurrency,
      },
    },
  };
}
