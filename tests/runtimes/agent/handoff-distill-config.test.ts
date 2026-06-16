/**
 * Pure env-resolution for the background handoff-distiller knobs.
 *
 * Covers: defaults when env is empty; each override parsed; invalid values
 * (NaN/negative/zero/empty) falling back to the default; and out-of-range
 * values clamping to the documented bounds.
 */
import { describe, it, expect } from 'vitest';
import { resolveHandoffDistillConfig } from '../../../src/runtimes/agent/handoff-distill-config.ts';

const DEFAULTS = {
  sweepMs: 60_000,
  growthThreshold: 4_000,
  verbatimN: 40,
  budget: {
    maxTokensPerWindow: 50_000,
    maxCallsPerWindow: 6,
    windowMs: 3_600_000,
    failureThreshold: 3,
    breakerCooldownMs: 300_000,
    globalConcurrency: 2,
  },
};

describe('resolveHandoffDistillConfig', () => {
  it('returns the hardcoded defaults when env is empty', () => {
    expect(resolveHandoffDistillConfig({})).toEqual(DEFAULTS);
  });

  it('parses each override', () => {
    const cfg = resolveHandoffDistillConfig({
      WHATSOUP_HANDOFF_DISTILL_SWEEP_MS: '30000',
      WHATSOUP_HANDOFF_DISTILL_GROWTH_THRESHOLD: '8000',
      WHATSOUP_HANDOFF_DISTILL_VERBATIM_N: '80',
      WHATSOUP_HANDOFF_DISTILL_MAX_TOKENS: '100000',
      WHATSOUP_HANDOFF_DISTILL_MAX_CALLS: '12',
      WHATSOUP_HANDOFF_DISTILL_WINDOW_MS: '7200000',
      WHATSOUP_HANDOFF_DISTILL_FAILURE_THRESHOLD: '5',
      WHATSOUP_HANDOFF_DISTILL_BREAKER_COOLDOWN_MS: '600000',
      WHATSOUP_HANDOFF_DISTILL_GLOBAL_CONCURRENCY: '4',
    });
    expect(cfg).toEqual({
      sweepMs: 30_000,
      growthThreshold: 8_000,
      verbatimN: 80,
      budget: {
        maxTokensPerWindow: 100_000,
        maxCallsPerWindow: 12,
        windowMs: 7_200_000,
        failureThreshold: 5,
        breakerCooldownMs: 600_000,
        globalConcurrency: 4,
      },
    });
  });

  it('truncates integer knobs to whole numbers', () => {
    const cfg = resolveHandoffDistillConfig({
      WHATSOUP_HANDOFF_DISTILL_VERBATIM_N: '40.9',
      WHATSOUP_HANDOFF_DISTILL_GLOBAL_CONCURRENCY: '3.7',
    });
    expect(cfg.verbatimN).toBe(40);
    expect(cfg.budget.globalConcurrency).toBe(3);
  });

  it.each([
    ['NaN', 'not-a-number'],
    ['negative', '-100'],
    ['zero', '0'],
    ['empty', ''],
    ['undefined', undefined],
  ])('falls back to defaults on %s values', (_label, bad) => {
    const cfg = resolveHandoffDistillConfig({
      WHATSOUP_HANDOFF_DISTILL_SWEEP_MS: bad,
      WHATSOUP_HANDOFF_DISTILL_GROWTH_THRESHOLD: bad,
      WHATSOUP_HANDOFF_DISTILL_VERBATIM_N: bad,
      WHATSOUP_HANDOFF_DISTILL_MAX_TOKENS: bad,
      WHATSOUP_HANDOFF_DISTILL_MAX_CALLS: bad,
      WHATSOUP_HANDOFF_DISTILL_WINDOW_MS: bad,
      WHATSOUP_HANDOFF_DISTILL_FAILURE_THRESHOLD: bad,
      WHATSOUP_HANDOFF_DISTILL_BREAKER_COOLDOWN_MS: bad,
      WHATSOUP_HANDOFF_DISTILL_GLOBAL_CONCURRENCY: bad,
    });
    expect(cfg).toEqual(DEFAULTS);
  });

  it('clamps values above the upper bound', () => {
    const cfg = resolveHandoffDistillConfig({
      WHATSOUP_HANDOFF_DISTILL_SWEEP_MS: '999999999', // > 1h
      WHATSOUP_HANDOFF_DISTILL_GROWTH_THRESHOLD: '99999999', // > 1_000_000
      WHATSOUP_HANDOFF_DISTILL_VERBATIM_N: '9999', // > 200
      WHATSOUP_HANDOFF_DISTILL_MAX_TOKENS: '999999999', // > 5_000_000
      WHATSOUP_HANDOFF_DISTILL_MAX_CALLS: '99999', // > 1_000
      WHATSOUP_HANDOFF_DISTILL_WINDOW_MS: '999999999999', // > 86_400_000
      WHATSOUP_HANDOFF_DISTILL_FAILURE_THRESHOLD: '9999', // > 100
      WHATSOUP_HANDOFF_DISTILL_BREAKER_COOLDOWN_MS: '999999999999', // > 86_400_000
      WHATSOUP_HANDOFF_DISTILL_GLOBAL_CONCURRENCY: '9999', // > 32
    });
    expect(cfg).toEqual({
      sweepMs: 3_600_000,
      growthThreshold: 1_000_000,
      verbatimN: 200,
      budget: {
        maxTokensPerWindow: 5_000_000,
        maxCallsPerWindow: 1_000,
        windowMs: 86_400_000,
        failureThreshold: 100,
        breakerCooldownMs: 86_400_000,
        globalConcurrency: 32,
      },
    });
  });

  it('clamps values below the lower bound (but above zero)', () => {
    const cfg = resolveHandoffDistillConfig({
      WHATSOUP_HANDOFF_DISTILL_SWEEP_MS: '1', // < 10_000
      WHATSOUP_HANDOFF_DISTILL_GROWTH_THRESHOLD: '1', // < 500
      WHATSOUP_HANDOFF_DISTILL_MAX_TOKENS: '1', // < 1_000
      WHATSOUP_HANDOFF_DISTILL_WINDOW_MS: '1', // < 60_000
      WHATSOUP_HANDOFF_DISTILL_BREAKER_COOLDOWN_MS: '1', // < 10_000
    });
    expect(cfg.sweepMs).toBe(10_000);
    expect(cfg.growthThreshold).toBe(500);
    expect(cfg.budget.maxTokensPerWindow).toBe(1_000);
    expect(cfg.budget.windowMs).toBe(60_000);
    expect(cfg.budget.breakerCooldownMs).toBe(10_000);
  });
});
