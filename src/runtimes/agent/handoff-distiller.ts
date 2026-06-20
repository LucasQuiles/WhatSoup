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
  distill: () => Promise<DistillOutcome>;
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

  try {
    const outcome = await deps.distill();
    deps.persist({
      conversationKey: deps.conversationKey,
      summary: outcome.summary,
      seededArtifacts: outcome.seededArtifacts ?? null,
      updatedAt: deps.now,
      sourceProvider: deps.sourceProvider,
      sourceModel: deps.sourceModel,
      tokenBaseline: deps.tokenBaseline,
    });
    const nextState = recordDistillSuccess(decision.nextState, outcome.tokensUsed, deps.now, deps.config);
    return { ran: true, denied: null, failed: false, nextState };
  } catch (err) {
    const nextState = recordDistillFailure(decision.nextState, deps.now, deps.config);
    const reason = errorMessage(err);
    deps.onDegraded?.(`handoff distill failed: ${reason.slice(0, 160)}`);
    return { ran: false, denied: null, failed: true, nextState };
  }
}
