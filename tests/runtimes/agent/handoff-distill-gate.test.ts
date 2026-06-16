import { describe, expect, it } from 'vitest';

import {
  evaluateDistillGate,
  initialDistillState,
  recordDistillFailure,
  recordDistillSuccess,
  type DistillBudgetConfig,
  type DistillState,
} from '../../../src/runtimes/agent/handoff-distill-gate.ts';

const NOW = 1_781_000_000_000;

const CONFIG: DistillBudgetConfig = {
  maxTokensPerWindow: 10_000,
  maxCallsPerWindow: 3,
  windowMs: 60_000,
  failureThreshold: 2,
  breakerCooldownMs: 30_000,
  globalConcurrency: 2,
};

function gate(state: DistillState, over: { now?: number; globalInFlight?: number } = {}) {
  return evaluateDistillGate({ state, config: CONFIG, now: over.now ?? NOW, globalInFlight: over.globalInFlight ?? 0 });
}

describe('distill gate — budget & concurrency', () => {
  it('allows from the initial state', () => {
    expect(gate(initialDistillState(NOW)).reason).toBe('ok');
  });

  it('denies when global concurrency is saturated', () => {
    expect(gate(initialDistillState(NOW), { globalInFlight: 2 }).reason).toBe('global-saturated');
  });

  it('denies once the per-window call budget is spent', () => {
    const s = { ...initialDistillState(NOW), callsThisWindow: 3 };
    expect(gate(s).reason).toBe('budget-calls');
  });

  it('denies once the per-window token budget is spent', () => {
    const s = { ...initialDistillState(NOW), tokensThisWindow: 10_000 };
    expect(gate(s).reason).toBe('budget-tokens');
  });

  it('rolls the window forward, resetting counters', () => {
    const spent = { ...initialDistillState(NOW), tokensThisWindow: 10_000, callsThisWindow: 3 };
    const decision = gate(spent, { now: NOW + 60_000 });
    expect(decision.reason).toBe('ok');
    expect(decision.nextState.tokensThisWindow).toBe(0);
    expect(decision.nextState.callsThisWindow).toBe(0);
    expect(decision.nextState.windowStart).toBe(NOW + 60_000);
  });
});

describe('distill gate — circuit breaker', () => {
  it('trips open after the consecutive-failure threshold', () => {
    let s = initialDistillState(NOW);
    s = recordDistillFailure(s, NOW, CONFIG);
    expect(s.breaker).toBe('closed'); // 1 < threshold 2
    s = recordDistillFailure(s, NOW + 1, CONFIG);
    expect(s.breaker).toBe('open');
    expect(s.breakerOpenedAt).toBe(NOW + 1);
  });

  it('denies while open within the cooldown', () => {
    let s = recordDistillFailure(recordDistillFailure(initialDistillState(NOW), NOW, CONFIG), NOW + 1, CONFIG);
    expect(gate(s, { now: NOW + 10_000 }).reason).toBe('breaker-open');
  });

  it('transitions open → half-open after cooldown and allows one trial', () => {
    let s = recordDistillFailure(recordDistillFailure(initialDistillState(NOW), NOW, CONFIG), NOW + 1, CONFIG);
    const decision = gate(s, { now: NOW + 1 + 30_000 });
    expect(decision.nextState.breaker).toBe('half-open');
    expect(decision.reason).toBe('ok');
  });

  it('half-open success closes the breaker and clears failures', () => {
    const halfOpen: DistillState = { ...initialDistillState(NOW), breaker: 'half-open', consecutiveFailures: 2, breakerOpenedAt: NOW - 30_000 };
    const s = recordDistillSuccess(halfOpen, 500, NOW, CONFIG);
    expect(s.breaker).toBe('closed');
    expect(s.consecutiveFailures).toBe(0);
    expect(s.tokensThisWindow).toBe(500);
    expect(s.callsThisWindow).toBe(1);
  });

  it('half-open failure re-opens immediately (does not wait for threshold)', () => {
    const halfOpen: DistillState = { ...initialDistillState(NOW), breaker: 'half-open', consecutiveFailures: 0, breakerOpenedAt: NOW - 30_000 };
    const s = recordDistillFailure(halfOpen, NOW, CONFIG);
    expect(s.breaker).toBe('open');
    expect(s.breakerOpenedAt).toBe(NOW);
  });
});

describe('distill gate — precedence & outcome folding', () => {
  it('breaker-open takes precedence over an exhausted budget', () => {
    const s: DistillState = { ...initialDistillState(NOW), tokensThisWindow: 10_000, breaker: 'open', breakerOpenedAt: NOW };
    expect(gate(s, { now: NOW + 1 }).reason).toBe('breaker-open');
  });

  it('global saturation takes precedence over budget when the breaker is closed', () => {
    const s: DistillState = { ...initialDistillState(NOW), tokensThisWindow: 10_000 };
    expect(gate(s, { globalInFlight: 5 }).reason).toBe('global-saturated');
  });

  it('success counts spend and never lets negative tokens reduce the window total', () => {
    const s = recordDistillSuccess(initialDistillState(NOW), -50, NOW, CONFIG);
    expect(s.tokensThisWindow).toBe(0);
    expect(s.callsThisWindow).toBe(1);
  });
});
