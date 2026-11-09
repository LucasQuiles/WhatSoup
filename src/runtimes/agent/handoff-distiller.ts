/**
 * Warm handoff distiller — orchestration brain.
 *
 * Decides whether to distill now (via the cost-budget + circuit-breaker gate),
 * runs the injected LLM distill, persists the resulting artifact, and folds the
 * outcome back into the gate state. Pure over injected dependencies (the distill
 * call, the store write, the clock, and the gate state/config) so the control
 * flow is unit-testable without a timer loop or a real model. The background
 * scheduler and the concrete LLM distill implementation wrap this.
 *
 * Guarantees:
 *  - the gate is always consulted first; a denied distill never calls the model;
 *  - a successful distill persists exactly one artifact and counts its spend;
 *  - a thrown distill is folded as a failure (advancing the breaker) and never
 *    persists a partial artifact, and surfaces a degradation signal.
 */

import {
  evaluateDistillGate,
  recordDistillSuccess,
  recordDistillFailure,
  type DistillBudgetConfig,
  type DistillDenyReason,
  type DistillState,
} from './handoff-distill-gate.ts';
import type { HandoffArtifact } from './handoff-prelude.ts';
import { errorMessage } from '../../lib/error-message.ts';

/** Result of the injected LLM distill call. */
export interface DistillOutcome {
  summary: string;
  seededArtifacts?: string | null;
  tokensUsed: number;
}

/** Must succeed synchronously immediately before the provider request is sent. */
export type ReserveDistillTokens = (tokens: number) => void;

class DistillTokenBudgetExceeded extends Error {}

/** A rejected artifact can still carry validated provider spend. */
export class HandoffDistillUsageError extends Error {
  readonly tokensUsed: number;
  constructor(message: string, tokensUsed: number) {
    super(message);
    this.tokensUsed = tokensUsed;
  }
}

export interface RunHandoffDistillDeps {
  state: DistillState;
  config: DistillBudgetConfig;
  now: number;
  globalInFlight: number;
  conversationKey: string;
  sourceProvider: string;
  sourceModel: string | null;
  tokenBaseline: number;
  /** The LLM distill call. May reject; rejection is folded as a failure. */
  distill: (reserveTokens: ReserveDistillTokens) => Promise<DistillOutcome>;
  /** Persist the produced artifact (store upsert). */
  persist: (artifact: HandoffArtifact) => void;
  /** Optional degradation signal (alert outbox) on distill failure. */
  onDegraded?: (reason: string) => void;
}

export interface RunHandoffDistillResult {
  /** A distill executed and succeeded. */
  ran: boolean;
  /** Set when the gate denied the distill (model not called). */
  denied: DistillDenyReason | null;
  /** A distill executed but threw. */
  failed: boolean;
  /** Gate state to persist (window-roll, breaker transition, spend/failure fold). */
  nextState: DistillState;
}

export async function runHandoffDistill(deps: RunHandoffDistillDeps): Promise<RunHandoffDistillResult> {
  const decision = evaluateDistillGate({
    state: deps.state,
    config: deps.config,
    now: deps.now,
    globalInFlight: deps.globalInFlight,
  });

  if (!decision.allow) {
    return { ran: false, denied: decision.reason as DistillDenyReason, failed: false, nextState: decision.nextState };
  }

  let reservedTokens: number | undefined;
  let chargedTokens: number | undefined;
  const reserveTokens: ReserveDistillTokens = (tokens) => {
    if (reservedTokens !== undefined) throw new Error('handoff token reservation already made');
    if (!Number.isSafeInteger(tokens) || tokens <= 0) throw new Error('invalid handoff token reservation');
    if (tokens > deps.config.maxTokensPerWindow - decision.nextState.tokensThisWindow) {
      throw new DistillTokenBudgetExceeded('handoff token budget exhausted');
    }
    reservedTokens = tokens;
    chargedTokens = decision.nextState.tokensThisWindow + tokens;
  };
  try {
    const outcome = await deps.distill(reserveTokens);
    if (reservedTokens === undefined) throw new Error('handoff token reservation missing');
    const nextState = recordDistillSuccess(decision.nextState, outcome.tokensUsed, deps.now, deps.config);
    chargedTokens = nextState.tokensThisWindow;
    if (outcome.tokensUsed > reservedTokens) {
      // A provider billing surprise must stop further egress for this window.
      chargedTokens = Math.max(chargedTokens, deps.config.maxTokensPerWindow);
      throw new Error('handoff reported token usage exceeds reservation');
    }
    deps.persist({
      conversationKey: deps.conversationKey,
      summary: outcome.summary,
      seededArtifacts: outcome.seededArtifacts ?? null,
      updatedAt: deps.now,
      sourceProvider: deps.sourceProvider,
      sourceModel: deps.sourceModel,
      tokenBaseline: deps.tokenBaseline,
    });
    return { ran: true, denied: null, failed: false, nextState };
  } catch (err) {
    if (err instanceof DistillTokenBudgetExceeded && reservedTokens === undefined) {
      return { ran: false, denied: 'budget-tokens', failed: false, nextState: decision.nextState };
    }
    if (err instanceof HandoffDistillUsageError && Number.isSafeInteger(err.tokensUsed) && err.tokensUsed >= 0) {
      chargedTokens = Math.min(Number.MAX_SAFE_INTEGER, decision.nextState.tokensThisWindow + err.tokensUsed);
      if (reservedTokens === undefined || err.tokensUsed > reservedTokens) {
        chargedTokens = Math.max(chargedTokens, deps.config.maxTokensPerWindow);
      }
    }
    // Uncertain provider outcomes retain the reservation; failed writes retain actual spend.
    const failureState = { ...decision.nextState,
      tokensThisWindow: chargedTokens ?? decision.nextState.tokensThisWindow };
    const nextState = recordDistillFailure(failureState, deps.now, deps.config);
    const reason = errorMessage(err);
    deps.onDegraded?.(`handoff distill failed: ${reason.slice(0, 160)}`);
    return { ran: false, denied: null, failed: true, nextState };
  }
}
