import type {
  DurabilityEngine,
  FinalizeTurnTerminalResult,
  OutboundDeliveryIdentity,
  OutboundDeliverySnapshot,
  TurnFinalizationBookkeepingParams,
} from '../../core/durability.ts';
import { emitAlert, type AlertEmissionStatus } from '../../lib/emit-alert.ts';
import { shortHash } from '../../lib/short-hash.ts';
import {
  toTurnFinalizationPersistence,
  toTurnRecoveryJobPersistence,
  type AttemptOutcome,
  type DeliveryEvidence,
  type RecoveryOwnerIdentity,
  type TurnIdentity,
  type TurnRecoveryReplayEnvelope,
  type TurnTerminalResult,
} from './turn-terminal.ts';

const TURN_FINALIZATION_ALERT_SOURCE = 'agent_turn_finalization_failed';
const TURN_FINALIZATION_ALERT_SUMMARY = 'Agent turn finalization could not reach durable terminal state';

export type RuntimeTurnFinalizerDurability = Pick<
  DurabilityEngine,
  'getOutboundDeliverySnapshot' | 'finalizeTurnTerminal'
>;

export type RuntimeAnswerEvidence =
  | { readonly kind: 'ready'; readonly opIds: readonly number[] }
  | { readonly kind: 'failed' };

export interface FinalizeRuntimeTurnParams {
  readonly instanceName: string;
  readonly durability: RuntimeTurnFinalizerDurability;
  readonly identity: TurnIdentity;
  readonly attemptOutcome: AttemptOutcome;
  readonly answerEvidence: RuntimeAnswerEvidence;
  readonly recoveryOwner?: RecoveryOwnerIdentity;
  readonly replay?: TurnRecoveryReplayEnvelope;
  readonly bookkeeping?: TurnFinalizationBookkeepingParams;
}

export interface AffectedTurnScope {
  readonly scope: TurnIdentity['scope'];
  readonly conversationKey: string;
}

export type FinalizeRuntimeTurnResult =
  | {
    readonly kind: 'terminal';
    readonly terminal: TurnTerminalResult;
    readonly receipt: FinalizeTurnTerminalResult;
    readonly effectiveReplyGuaranteeDisarmed: boolean;
  }
  | {
    readonly kind: 'durable_failure_incident';
    readonly identity: TurnIdentity;
    readonly affectedScope: AffectedTurnScope;
    readonly failureStage: 'delivery_proof' | 'terminal_finalize';
    readonly incidentStatus: 'durably_queued';
    /** Only a frozen-evidence terminal-write failure may release the lane. */
    readonly mayAdvance: boolean;
    readonly retryOwned: true;
  }
  | {
    readonly kind: 'dual_sink_failure';
    readonly identity: TurnIdentity;
    readonly affectedScope: AffectedTurnScope;
    readonly failureStage: 'delivery_proof' | 'terminal_finalize';
    readonly incidentStatus: Exclude<AlertEmissionStatus, 'durably_queued'> | 'threw';
    readonly mayAdvance: false;
    readonly stickyDegraded: true;
    readonly stopAcceptingAffectedScope: true;
  };

function deliveryIdentity(identity: TurnIdentity): OutboundDeliveryIdentity {
  return {
    conversationKey: identity.conversationKey,
    deliveryJid: identity.deliveryJid,
    sourceInboundSeq: identity.inboundSeq,
  };
}

function assertSnapshotMatches(
  opId: number,
  expected: OutboundDeliveryIdentity,
  snapshot: OutboundDeliverySnapshot | undefined,
): asserts snapshot is OutboundDeliverySnapshot {
  if (snapshot === undefined) throw new Error('Answer delivery proof is missing');
  if (
    snapshot.opId !== opId ||
    snapshot.conversationKey !== expected.conversationKey ||
    snapshot.deliveryJid !== expected.deliveryJid ||
    snapshot.sourceInboundSeq !== expected.sourceInboundSeq
  ) {
    throw new Error('Answer delivery proof does not match the turn identity');
  }
  if (
    snapshot.status === 'sending' ||
    snapshot.status === 'quarantined'
  ) {
    throw new Error('Answer delivery proof is not terminally classifiable');
  }
}

function deriveDeliveryEvidence(
  durability: RuntimeTurnFinalizerDurability,
  identity: TurnIdentity,
  answerOpIds: readonly number[],
): DeliveryEvidence {
  if (answerOpIds.length === 0) return { kind: 'none' };

  const expected = deliveryIdentity(identity);
  const snapshots = answerOpIds.map((opId) => {
    const snapshot = durability.getOutboundDeliverySnapshot(opId, expected);
    assertSnapshotMatches(opId, expected, snapshot);
    return snapshot;
  });

  const maybeSent = snapshots.find((snapshot) => snapshot.status === 'maybe_sent');
  if (maybeSent) return { kind: 'delivery_unknown', opId: maybeSent.opId };

  const pending = snapshots.find((snapshot) => snapshot.status === 'pending');
  if (pending) return { kind: 'enqueued', opId: pending.opId };

  const submitted = snapshots.find((snapshot) => snapshot.status === 'submitted');
  if (submitted) return { kind: 'flushed', opId: submitted.opId };

  const notSent = snapshots.find((snapshot) => snapshot.status === 'failed_permanent');
  if (notSent) return { kind: 'not_sent', opId: notSent.opId };

  const finalAnswer = snapshots.at(-1);
  if (finalAnswer && snapshots.every((snapshot) => snapshot.status === 'echoed')) {
    return { kind: 'echoed', opId: finalAnswer.opId };
  }

  throw new Error('Answer delivery proof contains an unsupported status');
}

function deriveInboundDisposition(
  attemptOutcome: AttemptOutcome,
  deliveryEvidence: DeliveryEvidence,
): TurnTerminalResult['inboundDisposition'] {
  if (attemptOutcome.kind === 'admission_rejected') {
    if (deliveryEvidence.kind === 'none') return 'failed_terminal';
    throw new Error('Admission rejection contradicts answer delivery evidence');
  }
  if (deliveryEvidence.kind === 'echoed') {
    return 'finalized_replied';
  }
  if (deliveryEvidence.kind === 'delivery_unknown') {
    return 'transferred_to_recovery_owner';
  }
  // A shed answer op is decisive negative evidence, not ambiguity — it always
  // fails the turn terminally, even where 'none' would otherwise finalize a
  // no-reply policy (that combination is a contradiction the persistence
  // mapping below rejects, mirroring the admission_rejected contradiction).
  if (deliveryEvidence.kind === 'not_sent') {
    return 'failed_terminal';
  }
  if (attemptOutcome.kind === 'suppressed_by_policy' && deliveryEvidence.kind === 'none') {
    return 'finalized_no_reply_policy';
  }
  if (attemptOutcome.kind === 'failed' && deliveryEvidence.kind === 'none') {
    return 'failed_terminal';
  }
  return 'transferred_to_recovery_owner';
}

function affectedScope(identity: TurnIdentity): AffectedTurnScope {
  return { scope: identity.scope, conversationKey: identity.conversationKey };
}

function boundedIncidentEvidence(
  params: FinalizeRuntimeTurnParams,
  failureStage: 'delivery_proof' | 'terminal_finalize',
): string {
  const { identity } = params;
  return [
    'runtime_source=turn-finalizer',
    `failure_stage=${failureStage}`,
    `scope=${identity.scope}`,
    `inbound_seq=${identity.inboundSeq ?? 'none'}`,
    `generation=${identity.generation}`,
    `answer_evidence=${params.answerEvidence.kind}`,
    `answer_op_count=${params.answerEvidence.kind === 'ready' ? params.answerEvidence.opIds.length : 0}`,
    `conversation_key_hash=${shortHash(identity.conversationKey)}`,
    `delivery_jid_hash=${shortHash(identity.deliveryJid)}`,
    `logical_turn_hash=${shortHash(identity.logicalTurnId)}`,
    `manager_hash=${shortHash(identity.managerId)}`,
  ].join('\n');
}

function emitFailureIncident(
  params: FinalizeRuntimeTurnParams,
  failureStage: 'delivery_proof' | 'terminal_finalize',
): Exclude<FinalizeRuntimeTurnResult, { kind: 'terminal' }> {
  const scope = affectedScope(params.identity);
  try {
    const result = emitAlert(
      params.instanceName,
      TURN_FINALIZATION_ALERT_SOURCE,
      TURN_FINALIZATION_ALERT_SUMMARY,
      boundedIncidentEvidence(params, failureStage),
    );
    if (result.status !== 'durably_queued') {
      return {
        kind: 'dual_sink_failure',
        identity: params.identity,
        affectedScope: scope,
        failureStage,
        incidentStatus: result.status,
        mayAdvance: false,
        stickyDegraded: true,
        stopAcceptingAffectedScope: true,
      };
    }
    return {
      kind: 'durable_failure_incident',
      identity: params.identity,
      affectedScope: scope,
      failureStage,
      incidentStatus: 'durably_queued',
      mayAdvance: false,
      retryOwned: true,
    };
  } catch {
    return {
      kind: 'dual_sink_failure',
      identity: params.identity,
      affectedScope: scope,
      failureStage,
      incidentStatus: 'threw',
      mayAdvance: false,
      stickyDegraded: true,
      stopAcceptingAffectedScope: true,
    };
  }
}

export function finalizeRuntimeTurn(
  params: FinalizeRuntimeTurnParams,
): FinalizeRuntimeTurnResult {
  if (params.answerEvidence.kind === 'failed') {
    return emitFailureIncident(params, 'delivery_proof');
  }

  let deliveryEvidence: DeliveryEvidence;
  try {
    deliveryEvidence = deriveDeliveryEvidence(
      params.durability,
      params.identity,
      params.answerEvidence.opIds,
    );
  } catch {
    return emitFailureIncident(params, 'delivery_proof');
  }

  try {
    const attemptOutcome: AttemptOutcome =
      params.attemptOutcome.kind === 'completed' &&
      (deliveryEvidence.kind === 'none' || deliveryEvidence.kind === 'not_sent')
        ? { kind: 'failed', class: 'unknown_terminal' }
        : params.attemptOutcome;
    const terminal: TurnTerminalResult = {
      identity: params.identity,
      attemptOutcome,
      inboundDisposition: deriveInboundDisposition(attemptOutcome, deliveryEvidence),
      deliveryEvidence,
    };
    const recoveryOwner = terminal.inboundDisposition === 'transferred_to_recovery_owner'
      ? params.recoveryOwner
      : undefined;
    if (
      terminal.inboundDisposition === 'transferred_to_recovery_owner' &&
      (recoveryOwner === undefined || params.replay === undefined)
    ) {
      throw new Error('A transferred runtime turn requires a recovery owner and replay envelope');
    }

    const persistence = toTurnFinalizationPersistence(terminal, recoveryOwner);
    const recoveryJob = terminal.inboundDisposition === 'transferred_to_recovery_owner'
      ? toTurnRecoveryJobPersistence(terminal, recoveryOwner!, params.replay!)
      : undefined;
    const receipt = params.durability.finalizeTurnTerminal({
      ...persistence,
      ...(params.bookkeeping === undefined ? {} : { bookkeeping: params.bookkeeping }),
      ...(recoveryJob === undefined ? {} : { recoveryJob }),
    });
    if (!receipt.winnerMatchesRequest) {
      throw new Error('Durable terminal winner conflicts with the requested terminal identity');
    }
    return {
      kind: 'terminal',
      terminal,
      receipt,
      effectiveReplyGuaranteeDisarmed: receipt.effectiveReplyGuaranteeDisarmed,
    };
  } catch {
    return emitFailureIncident(params, 'terminal_finalize');
  }
}
