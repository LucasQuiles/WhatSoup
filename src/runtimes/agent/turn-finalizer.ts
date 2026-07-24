import type {
  DurabilityEngine,
  FinalizeTurnTerminalResult,
  OutboundDeliveryIdentity,
  OutboundDeliverySnapshot,
  TurnFinalizationBookkeepingParams,
} from '../../core/durability.ts';
import { emitAlert, emitAlertChecked, type AlertEmissionStatus } from '../../lib/emit-alert.ts';
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

const REPLY_GUARANTEE_BREACH_ALERT_SOURCE = 'agent_reply_guarantee_breach';
const REPLY_GUARANTEE_BREACH_ALERT_SUMMARY =
  'Agent turn failed terminally with no completed reply proof — operator catch-up is required';

export type RuntimeTurnFinalizerDurability = Pick<
  DurabilityEngine,
  'getOutboundDeliverySnapshot' | 'finalizeTurnTerminal' | 'markContinuityCandidateIfNoTerminalOutbound'
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

function boundedBreachEvidence(
  params: FinalizeRuntimeTurnParams,
  attemptFailureClass: string,
  receipt: FinalizeTurnTerminalResult,
  continuityMarked: boolean,
): string {
  const { identity } = params;
  return [
    'runtime_source=turn-finalizer',
    `attempt_failure_class=${attemptFailureClass}`,
    `scope=${identity.scope}`,
    `inbound_seq=${identity.inboundSeq ?? 'none'}`,
    `generation=${identity.generation}`,
    `reply_guarantee_disarmed=${receipt.effectiveReplyGuaranteeDisarmed}`,
    `continuity_marked=${continuityMarked}`,
    `partial_answer_op_count=${params.answerEvidence.kind === 'ready' ? params.answerEvidence.opIds.length : 0}`,
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
    const observedDeliveryEvidence = deriveDeliveryEvidence(
      params.durability,
      params.identity,
      params.answerEvidence.opIds,
    );
    // An echoed fragment proves transport delivery, but a provider failure
    // proves the requested turn did not reach a completed answer. Keep that
    // fragment non-terminal so it cannot tombstone the inbound as replied.
    // Pending and ambiguous sends retain their existing recovery-owner path.
    deliveryEvidence = params.attemptOutcome.kind === 'failed' &&
      observedDeliveryEvidence.kind === 'echoed'
      ? { kind: 'none' }
      : observedDeliveryEvidence;
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

    // A runtime fault that never produced delivery evidence finalizes with the
    // reply guarantee still armed and no recovery owner: the inbound is dropped.
    // That drop must not be silent (owner-directed messages have died this way),
    // so it gets a durable continuity-candidate mark plus a breach alert below.
    // Admission-rejected sheds stay excluded; pre_dispatch_error is the typed
    // exception because it means an admitted queue processor failed before send.
    const replyGuaranteeBreachClass = attemptOutcome.kind === 'failed'
      ? attemptOutcome.class ?? 'unknown'
      : attemptOutcome.kind === 'admission_rejected' && attemptOutcome.class === 'pre_dispatch_error'
        ? attemptOutcome.class
        : null;
    const replyGuaranteeBreach =
      terminal.inboundDisposition === 'failed_terminal' &&
      replyGuaranteeBreachClass !== null &&
      params.identity.inboundSeq !== null;
    let continuityMarked = false;
    if (replyGuaranteeBreach) {
      // The guarded statement refuses to mark once a turn_terminal_records row
      // exists for the seq, so this must land before terminal persistence. A
      // marking failure must not block finalization — it is reported through
      // the breach alert evidence instead.
      try {
        continuityMarked = params.durability.markContinuityCandidateIfNoTerminalOutbound(
          params.identity.inboundSeq!,
          'runtime_fault_no_terminal_outbound',
          'runtime_fault_disarm',
        );
      } catch {
        continuityMarked = false;
      }
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
    if (replyGuaranteeBreach && replyGuaranteeBreachClass !== null) {
      // Best-effort visibility: the terminal state is already durable, so an
      // alert-sink failure must not convert a finalized turn into an incident.
      try {
        emitAlertChecked(
          params.instanceName,
          REPLY_GUARANTEE_BREACH_ALERT_SOURCE,
          REPLY_GUARANTEE_BREACH_ALERT_SUMMARY,
          boundedBreachEvidence(params, replyGuaranteeBreachClass, receipt, continuityMarked),
        );
      } catch {
        // Swallowed by design — see comment above.
      }
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
