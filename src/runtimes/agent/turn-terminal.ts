import { Buffer } from 'node:buffer';
import {
  PROVIDER_FAILURE_KINDS,
  type ProviderFailureKind,
} from './failure-taxonomy.ts';
import {
  admissionRejectInboundFailureClass,
  type AdmissionRejectClass,
} from '../../core/inbound-failure-class.ts';
import { TURN_RECOVERY_MAX_TEXT_BYTES } from '../../core/turn-recovery-contract.ts';
import type {
  FinalizeTurnTerminalParams,
  TerminalInboundMutation,
  TurnRecoveryJobPersistenceParams,
} from '../../core/durability.ts';

export interface TurnIdentity {
  readonly scope: 'per_chat' | 'shared' | 'singleton';
  readonly conversationKey: string;
  readonly deliveryJid: string;
  readonly inboundSeq: number | null;
  readonly logicalTurnId: string;
  readonly managerId: string;
  readonly generation: number;
}

export type NonProviderTerminalFailureClass =
  | 'crash'
  | 'processor_throw'
  | 'unknown_terminal'
  | 'provider_stream_corrupt';

const NON_PROVIDER_TERMINAL_FAILURE_CLASS_PRESENCE: Readonly<
  Record<NonProviderTerminalFailureClass, true>
> = {
  crash: true,
  processor_throw: true,
  unknown_terminal: true,
  provider_stream_corrupt: true,
};

export const NON_PROVIDER_TERMINAL_FAILURE_CLASSES = Object.freeze(
  Object.keys(NON_PROVIDER_TERMINAL_FAILURE_CLASS_PRESENCE),
) as readonly NonProviderTerminalFailureClass[];

export const TERMINAL_ATTEMPT_FAILURE_CLASSES = Object.freeze([
  ...PROVIDER_FAILURE_KINDS,
  ...NON_PROVIDER_TERMINAL_FAILURE_CLASSES,
]);

export type AttemptOutcome =
  | { readonly kind: 'completed' }
  | {
    readonly kind: 'failed';
    readonly class: ProviderFailureKind | NonProviderTerminalFailureClass;
  }
  | { readonly kind: 'suppressed_by_policy' }
  | {
    readonly kind: 'admission_rejected';
    /**
     * Distinct rejection reason (#1750). Absent preserves the legacy
     * undifferentiated rejection (durable attempt_failure_class stays null,
     * failure_class coerces to 'unknown').
     */
    readonly class?: AdmissionRejectClass;
  };

export type InboundDisposition =
  | 'finalized_replied'
  | 'finalized_no_reply_policy'
  | 'transferred_to_recovery_owner'
  | 'failed_terminal'
  | 'unfinalized_retry_owned';

export type DeliveryEvidence =
  | { readonly kind: 'none' }
  | { readonly kind: 'enqueued'; readonly opId: number }
  | { readonly kind: 'flushed'; readonly opId: number }
  | { readonly kind: 'echoed'; readonly opId: number }
  | { readonly kind: 'delivery_unknown'; readonly opId: number }
  /** A durably shed answer op (e.g. governor-sheared) — decisive, not ambiguous. */
  | { readonly kind: 'not_sent'; readonly opId: number };

export interface RecoveryOwnerIdentity {
  readonly logicalTurnId: string;
  readonly managerId: string;
  readonly generation: number;
}

export interface TurnTerminalResult {
  readonly identity: TurnIdentity;
  readonly attemptOutcome: AttemptOutcome;
  readonly inboundDisposition: InboundDisposition;
  readonly deliveryEvidence: DeliveryEvidence;
}

/** Primitive-only shape accepted by the core durability layer. */
export interface TurnTerminalPersistence {
  readonly scope: string;
  readonly conversationKey: string;
  readonly deliveryJid: string;
  readonly inboundSeq: number | null;
  readonly logicalTurnId: string;
  readonly managerId: string;
  readonly generation: number;
  readonly attemptKind: string;
  readonly attemptFailureClass: string | null;
  readonly inboundDisposition: string;
  readonly deliveryKind: string;
  readonly deliveryOpId: number | null;
  readonly recoveryOwnerLogicalTurnId: string | null;
  readonly recoveryOwnerManagerId: string | null;
  readonly recoveryOwnerGeneration: number | null;
  readonly replyGuaranteeDisarmed: boolean;
}

export interface ReplyGuaranteeDisarmContext {
  readonly recoveryTransferDurable?: boolean;
}

export interface TurnRecoveryReplayEnvelope {
  readonly sourceMessageId: string;
  readonly receivedAtUnixSeconds: number;
  readonly replaySafe: boolean;
  readonly senderJid: string;
  readonly senderName: string | null;
  readonly text: string;
  readonly isGroup: boolean;
  readonly groupName?: string | null;
}

export function shouldDisarmReplyGuarantee(
  result: Pick<TurnTerminalResult, 'inboundDisposition' | 'deliveryEvidence'>,
  context: ReplyGuaranteeDisarmContext = {},
): boolean {
  // Delivery uncertainty outranks ownership transfer: the new owner keeps the
  // obligation armed until late-echo reconciliation can establish truth.
  if (result.deliveryEvidence.kind === 'delivery_unknown') return false;

  return result.deliveryEvidence.kind === 'echoed' ||
    (
      result.inboundDisposition === 'transferred_to_recovery_owner' &&
      context.recoveryTransferDurable === true
    ) ||
    result.inboundDisposition === 'finalized_no_reply_policy';
}

export function toTurnTerminalPersistence(
  result: TurnTerminalResult,
  recoveryOwner?: RecoveryOwnerIdentity,
): TurnTerminalPersistence {
  if (
    result.inboundDisposition === 'transferred_to_recovery_owner' &&
    recoveryOwner === undefined
  ) {
    throw new Error('A transferred terminal disposition requires a recovery owner identity');
  }
  if (
    result.inboundDisposition === 'transferred_to_recovery_owner' &&
    result.deliveryEvidence.kind !== 'enqueued' &&
    result.deliveryEvidence.kind !== 'flushed' &&
    result.deliveryEvidence.kind !== 'delivery_unknown'
  ) {
    throw new Error('A transferred terminal disposition requires unresolved delivery evidence');
  }
  if (
    result.inboundDisposition !== 'transferred_to_recovery_owner' &&
    recoveryOwner !== undefined
  ) {
    throw new Error('A recovery owner identity is only valid for a transferred disposition');
  }
  if (recoveryOwner !== undefined) {
    if (recoveryOwner.logicalTurnId.trim() === '') {
      throw new Error('A recovery owner requires a nonempty logical turn ID');
    }
    if (recoveryOwner.managerId.trim() === '') {
      throw new Error('A recovery owner requires a nonempty manager ID');
    }
    if (!Number.isSafeInteger(recoveryOwner.generation) || recoveryOwner.generation < 1) {
      throw new Error('A recovery owner generation must be a positive safe integer');
    }
  }
  if (
    result.deliveryEvidence.kind === 'delivery_unknown' &&
    result.inboundDisposition !== 'unfinalized_retry_owned' &&
    result.inboundDisposition !== 'transferred_to_recovery_owner'
  ) {
    throw new Error('delivery_unknown requires a bounded retry owner until late-echo reconciliation');
  }

  return {
    scope: result.identity.scope,
    conversationKey: result.identity.conversationKey,
    deliveryJid: result.identity.deliveryJid,
    inboundSeq: result.identity.inboundSeq,
    logicalTurnId: result.identity.logicalTurnId,
    managerId: result.identity.managerId,
    generation: result.identity.generation,
    attemptKind: result.attemptOutcome.kind,
    // admission_rejected carries its distinct subclass on the durable
    // attempt_failure_class column (#1750); absent stays null (legacy).
    attemptFailureClass: result.attemptOutcome.kind === 'failed'
      ? result.attemptOutcome.class
      : result.attemptOutcome.kind === 'admission_rejected'
        ? result.attemptOutcome.class ?? null
        : null,
    inboundDisposition: result.inboundDisposition,
    // not_sent collapses to the same persisted shape as 'none': the core
    // contract's failed_terminal invariant requires deliveryKind='none', and
    // the shed op's own outbound_ops row already carries full provenance
    // (status='failed_permanent', source_inbound_seq) — nothing is lost.
    deliveryKind: result.deliveryEvidence.kind === 'not_sent'
      ? 'none'
      : result.deliveryEvidence.kind,
    deliveryOpId: result.deliveryEvidence.kind === 'none' || result.deliveryEvidence.kind === 'not_sent'
      ? null
      : result.deliveryEvidence.opId,
    recoveryOwnerLogicalTurnId: recoveryOwner?.logicalTurnId ?? null,
    recoveryOwnerManagerId: recoveryOwner?.managerId ?? null,
    recoveryOwnerGeneration: recoveryOwner?.generation ?? null,
    // This row atomically records the declared owner tuple, but tuple presence
    // is not proof that an actionable durable owner exists. Manager generations
    // can restart at one, so T1 cannot infer a cross-manager forward relation.
    // T3 must create and verify the owner before this call and own later disarm.
    replyGuaranteeDisarmed: shouldDisarmReplyGuarantee(result),
  };
}

export type TurnFinalizationPersistence = Pick<
  FinalizeTurnTerminalParams,
  'terminal' | 'inbound'
>;

function toInboundMutation(result: TurnTerminalResult): TerminalInboundMutation | undefined {
  const seq = result.identity.inboundSeq;

  switch (result.inboundDisposition) {
    case 'finalized_replied':
      if (result.deliveryEvidence.kind !== 'echoed') {
        throw new Error('finalized_replied requires echoed delivery evidence');
      }
      return seq === null
        ? undefined
        : { kind: 'complete', seq, terminalReason: 'response_echoed' };
    case 'finalized_no_reply_policy':
      if (result.attemptOutcome.kind !== 'suppressed_by_policy') {
        throw new Error('finalized_no_reply_policy requires an explicit policy suppression');
      }
      return seq === null
        ? undefined
        : { kind: 'complete', seq, terminalReason: 'no_reply_policy' };
    case 'failed_terminal': {
      if (
        result.attemptOutcome.kind !== 'failed' &&
        result.attemptOutcome.kind !== 'admission_rejected'
      ) {
        throw new Error('failed_terminal requires a failed or admission-rejected attempt');
      }
      if (seq === null) return undefined;
      const failureClass = result.attemptOutcome.kind === 'admission_rejected'
        ? admissionRejectInboundFailureClass(result.attemptOutcome.class)
        : result.attemptOutcome.class === 'crash'
          ? 'session_crash'
          : result.attemptOutcome.class === 'processor_throw'
            ? 'processor_throw'
            : result.attemptOutcome.class === 'unknown_terminal'
              ? 'unknown'
              : 'provider_failure';
      return { kind: 'failed', seq, failureClass };
    }
    case 'transferred_to_recovery_owner':
    case 'unfinalized_retry_owned':
      return undefined;
  }
}

/**
 * Typed agent-to-core adapter. It derives inbound persistence only from the
 * explicit disposition and evidence axes; a completed attempt alone never
 * implies that a response was sent.
 */
export function toTurnFinalizationPersistence(
  result: TurnTerminalResult,
  recoveryOwner?: RecoveryOwnerIdentity,
): TurnFinalizationPersistence {
  return {
    terminal: toTurnTerminalPersistence(result, recoveryOwner),
    inbound: toInboundMutation(result),
  };
}

/**
 * Captures the exact already-transformed queue input needed by a later recovery
 * consumer. Source IDs remain provenance; they are never treated as a recipe
 * for reconstructing media, group, or transformed text.
 */
export function toTurnRecoveryJobPersistence(
  result: TurnTerminalResult,
  recoveryOwner: RecoveryOwnerIdentity,
  replay: TurnRecoveryReplayEnvelope,
): TurnRecoveryJobPersistenceParams {
  if (result.inboundDisposition !== 'transferred_to_recovery_owner') {
    throw new Error('A recovery job requires a transferred disposition');
  }
  if (result.identity.inboundSeq === null) {
    throw new Error('A recovery job requires an existing journaled inbound source');
  }
  toTurnTerminalPersistence(result, recoveryOwner);
  if (typeof replay.replaySafe !== 'boolean') {
    throw new Error('A recovery job requires an explicit replay-safety decision');
  }
  if (replay.sourceMessageId.trim() === '') {
    throw new Error('A recovery job requires a nonempty source message ID');
  }
  if (replay.senderJid.trim() === '') {
    throw new Error('A recovery job requires a nonempty sender JID');
  }
  if (Buffer.byteLength(replay.text, 'utf8') > TURN_RECOVERY_MAX_TEXT_BYTES) {
    throw new Error('Recovery replay text exceeds its byte limit');
  }
  if (replay.text.trim() === '') {
    throw new Error('A recovery job requires nonempty replay text');
  }
  if (!replay.isGroup && replay.groupName != null) {
    throw new Error('A direct-message recovery job cannot carry a group name');
  }

  return {
    scope: result.identity.scope,
    conversationKey: result.identity.conversationKey,
    deliveryJid: result.identity.deliveryJid,
    sourceInboundSeq: result.identity.inboundSeq,
    sourceLogicalTurnId: result.identity.logicalTurnId,
    sourceManagerId: result.identity.managerId,
    sourceGeneration: result.identity.generation,
    sourceMessageId: replay.sourceMessageId,
    ownerLogicalTurnId: recoveryOwner.logicalTurnId,
    ownerManagerId: recoveryOwner.managerId,
    ownerGeneration: recoveryOwner.generation,
    replaySafe: replay.replaySafe,
    senderJid: replay.senderJid,
    senderName: replay.senderName,
    replayText: replay.text,
    isGroup: replay.isGroup,
    groupName: replay.groupName ?? null,
  };
}
