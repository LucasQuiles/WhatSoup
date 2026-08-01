/**
 * Cost-budget + circuit-breaker gate for the warm handoff distiller.
 *
 * The distiller issues LLM calls per active conversation; left unbounded it is
 * an unobserved spend surface (the highest-risk item the design review flagged).
 * This module is the safety core that decides whether a distill may run *now*:
 *  - a per-conversation rolling-window **token & call budget**;
 *  - a global **concurrency** ceiling across conversations;
 *  - a **circuit breaker** (closed → open → half-open) that suspends distillation
 *    for a conversation after repeated failures and probes recovery with a
 *    single trial after a cooldown.
 *
 * Pure and deterministic over an injected clock and explicit state, so every
 * guard is unit-testable without timers or an LLM. The distiller persists the
 * returned {@link DistillState} and folds outcomes via {@link recordDistill-
 * Success} / {@link recordDistillFailure}.
 *
 * Per-conversation serialisation (one in-flight distill per conversation, which
 * the debounced distiller guarantees) is assumed, so a half-open state yields
 * exactly one trial.
 */

import type { CircuitState } from '../../core/circuit-breaker.ts';

export type DistillDenyReason =
  | 'budget-tokens'
  | 'budget-calls'
  | 'breaker-open'
  | 'global-saturated';

export interface DistillBudgetConfig {
  /** Per-conversation token budget per rolling window. */
  maxTokensPerWindow: number;
  /** Per-conversation distill-call budget per rolling window. */
  maxCallsPerWindow: number;
  /** Rolling-window length (ms). */
  windowMs: number;
  /** Consecutive failures that trip the breaker open. */
  failureThreshold: number;
  /** Open → half-open cooldown (ms). */
  breakerCooldownMs: number;
  /** Max concurrent distills across all conversations. */
  globalConcurrency: number;
}

export interface DistillState {
  windowStart: number;
  tokensThisWindow: number;
  callsThisWindow: number;
  consecutiveFailures: number;
  breaker: CircuitState;
  breakerOpenedAt: number | null;
}

export interface DistillDecision {
  allow: boolean;
  reason: 'ok' | DistillDenyReason;
  /** State with window-roll and any breaker open→half-open transition applied. */
  nextState: DistillState;
}

export function initialDistillState(now: number): DistillState {
  return {
    windowStart: now,
    tokensThisWindow: 0,
    callsThisWindow: 0,
    consecutiveFailures: 0,
    breaker: 'closed',
    breakerOpenedAt: null,
  };
}

/** Roll the rolling window forward if it has elapsed (resets per-window counters). */
function rollWindow(state: DistillState, now: number, windowMs: number): DistillState {
  if (now - state.windowStart < windowMs) return state;
  return { ...state, windowStart: now, tokensThisWindow: 0, callsThisWindow: 0 };
}

/** Apply the open → half-open cooldown transition if due. */
function settleBreaker(state: DistillState, now: number, cooldownMs: number): DistillState {
  if (state.breaker === 'open' && state.breakerOpenedAt !== null && now - state.breakerOpenedAt >= cooldownMs) {
    return { ...state, breaker: 'half-open' };
  }
  return state;
}

export function evaluateDistillGate(args: {
  state: DistillState;
  config: DistillBudgetConfig;
  now: number;
  globalInFlight: number;
}): DistillDecision {
  const { config, now, globalInFlight } = args;
  const nextState = settleBreaker(rollWindow(args.state, now, config.windowMs), now, config.breakerCooldownMs);

  const deny = (reason: DistillDenyReason): DistillDecision => ({ allow: false, reason, nextState });

  // Breaker still open (cooldown not elapsed) — suspend distillation.
  if (nextState.breaker === 'open') return deny('breaker-open');
  // Global concurrency ceiling (applies in closed and half-open).
  if (globalInFlight >= config.globalConcurrency) return deny('global-saturated');
  // Per-conversation budget — a half-open trial still costs, so it is gated too.
  if (nextState.callsThisWindow >= config.maxCallsPerWindow) return deny('budget-calls');
  if (nextState.tokensThisWindow >= config.maxTokensPerWindow) return deny('budget-tokens');

  return { allow: true, reason: 'ok', nextState };
}

/** Fold a successful distill: count spend, reset failures, close the breaker. */
export function recordDistillSuccess(
  state: DistillState,
  tokensUsed: number,
  now: number,
  config: DistillBudgetConfig,
): DistillState {
  const rolled = rollWindow(state, now, config.windowMs);
  return {
    ...rolled,
    tokensThisWindow: rolled.tokensThisWindow + Math.max(0, tokensUsed),
    callsThisWindow: rolled.callsThisWindow + 1,
    consecutiveFailures: 0,
    breaker: 'closed',
    breakerOpenedAt: null,
  };
}

/** Fold a failed distill: count the attempt, increment failures, trip open at threshold. */
export function recordDistillFailure(
  state: DistillState,
  now: number,
  config: DistillBudgetConfig,
): DistillState {
  const rolled = rollWindow(state, now, config.windowMs);
  const consecutiveFailures = rolled.consecutiveFailures + 1;
  // A failure in half-open re-opens immediately; in closed, opens at threshold.
  const trip = rolled.breaker === 'half-open' || consecutiveFailures >= config.failureThreshold;
  return {
    ...rolled,
    callsThisWindow: rolled.callsThisWindow + 1,
    consecutiveFailures,
    breaker: trip ? 'open' : rolled.breaker,
    breakerOpenedAt: trip ? now : rolled.breakerOpenedAt,
  };
}
