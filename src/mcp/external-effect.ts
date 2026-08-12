/**
 * D2 — closed external-effect taxonomy (capability-obligation replay).
 *
 * `replay_policy` answers "is re-running this after a crash safe?" — recovery
 * semantics. It is deliberately NOT reused here. This module owns the separate
 * question the obligation trigger needs answered fail-closed: "did this turn cause
 * any externally observable mutation?"
 *
 * Two layers:
 *
 *  1. STATIC declaration (`ToolDeclaration.externalEffect`): every exposed tool
 *     explicitly declares `kind: 'none'` (a pure read — an accepted invocation
 *     observably mutates nothing outside the process) or `kind: 'external'`
 *     (an accepted invocation may mutate something observable: a WhatsApp send,
 *     a DB/memory write, a third-party call). Fail-closed authoring rule: when in
 *     doubt, `external`. Coverage is CI-enforced with no grandfather list
 *     (tests/mcp/external-effect-coverage.test.ts).
 *
 *  2. PER-INVOCATION fold (`classifyInvocationEffect`): a persisted, turn-scoped
 *     `tool_calls` record folds to one closed class:
 *       - `none`                — declared-none tool, any outcome;
 *       - `failed_before_accept`— declared-external, rejected before the handler
 *                                 could run (admission/validation/authorization/
 *                                 policy failure stages);
 *       - `accepted`            — declared-external, completed (or replayed);
 *       - `ambiguous`           — declared-external, handler/dependency error,
 *                                 non-terminal, or quarantined: mutation may have
 *                                 begun;
 *       - `unknown`             — unclassified tool, or a record shape this
 *                                 version does not recognize.
 *
 * `foldTurnEffects` reduces a turn's classes to the single proof bit the terminal
 * decision consumes: conclusive-no-effect iff enumeration is complete, no
 * durability write-loss occurred in the window, and every invocation is `none` or
 * `failed_before_accept`. Anything else yields a typed reason and, per D2, creates
 * no dispatchable obligation (`not_created_side_effect_uncertain` audit).
 */

export const EXTERNAL_EFFECT_CONTRACT_VERSION = 1;

/** Static per-tool declaration. See module doc for the authoring rule. */
export interface ExternalEffectDeclaration {
  version: number;
  kind: 'none' | 'external';
}

export type ExternalEffectClass =
  | 'none'
  | 'failed_before_accept'
  | 'accepted'
  | 'ambiguous'
  | 'unknown';

/** The tool_calls fields the fold consumes (post-migration-50 shape). */
export interface ToolInvocationRecordLike {
  toolName: string;
  status: string;
  outcomeCode: string | null;
  failureStage: string | null;
}

const PRE_ACCEPT_FAILURE_STAGES = new Set(['admission', 'validation', 'authorization', 'policy']);
const POST_ACCEPT_FAILURE_STAGES = new Set(['handler', 'dependency', 'recovery']);

export function classifyInvocationEffect(
  declared: ExternalEffectDeclaration | undefined,
  record: ToolInvocationRecordLike,
): ExternalEffectClass {
  if (declared === undefined) return 'unknown';
  if (declared.kind === 'none') return 'none';
  switch (record.status) {
    case 'complete':
    case 'replayed':
      return 'accepted';
    case 'error':
      if (record.failureStage !== null && PRE_ACCEPT_FAILURE_STAGES.has(record.failureStage)) {
        return 'failed_before_accept';
      }
      if (record.failureStage === null || POST_ACCEPT_FAILURE_STAGES.has(record.failureStage)) {
        return 'ambiguous';
      }
      return 'unknown';
    case 'executing':
    case 'pending':
    case 'quarantined':
      return 'ambiguous';
    default:
      return 'unknown';
  }
}

export type TurnEffectFold =
  | { conclusiveNoEffect: true }
  | {
      conclusiveNoEffect: false;
      reason:
        | 'enumeration_incomplete'
        | 'write_loss_in_window'
        | 'invocation_accepted'
        | 'invocation_ambiguous'
        | 'invocation_unknown';
    };

export interface TurnEffectEvidence {
  /** True only when the turn's tool activity is provably fully enumerable. */
  enumerationComplete: boolean;
  /** True when any durability record-write loss fell inside the turn window. */
  writeLossInWindow: boolean;
}

export function foldTurnEffects(
  classes: readonly ExternalEffectClass[],
  evidence: TurnEffectEvidence,
): TurnEffectFold {
  if (!evidence.enumerationComplete) {
    return { conclusiveNoEffect: false, reason: 'enumeration_incomplete' };
  }
  if (evidence.writeLossInWindow) {
    return { conclusiveNoEffect: false, reason: 'write_loss_in_window' };
  }
  for (const blocking of ['accepted', 'ambiguous', 'unknown'] as const) {
    if (classes.includes(blocking)) {
      return { conclusiveNoEffect: false, reason: `invocation_${blocking}` };
    }
  }
  return { conclusiveNoEffect: true };
}
