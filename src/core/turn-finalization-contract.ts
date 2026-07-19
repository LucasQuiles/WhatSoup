import type { InboundFailureClass } from './inbound-failure-class.ts';
import {
  ADMISSION_REJECT_CLASSES,
  admissionRejectInboundFailureClass,
} from './inbound-failure-class.ts';
import { parseWhatsAppDeliveryNamespace } from './jid-constants.ts';
import {
  TURN_RECOVERY_MAX_ID_BYTES,
  validateBoundedRequired,
  validatePositiveSafeInteger,
  validateTurnRecoveryJob,
} from './turn-recovery-store.ts';
import type {
  EnqueueTurnRecoveryJobResult,
  TurnRecoveryJobPersistenceParams,
} from './turn-recovery-store.ts';

export interface SessionCheckpointFields {
  sessionId?: string;
  transcriptPath?: string;
  activeTurnId?: string | null;
  lastInboundSeq?: number;
  lastFlushedOutboundId?: number;
  watchdogState?: string;
  workspacePath?: string;
  claudePid?: number;
  sessionStatus?: string;
  completedInboundSeq?: number;
  completedDeliveryJid?: string;
  completedDeliveryNamespace?: string;
  completedScope?: 'per_chat' | 'shared' | 'singleton';
  completedLogicalTurnId?: string;
  completedManagerId?: string;
  completedGeneration?: number;
}

function requireDeliveryNamespace(deliveryJid: string): string {
  const namespace = parseWhatsAppDeliveryNamespace(deliveryJid);
  if (namespace === null) {
    throw new Error('Turn identity requires a canonical WhatsApp delivery JID namespace');
  }
  return namespace;
}

export function validateCompletedCheckpointIdentity(
  fields: SessionCheckpointFields,
): void {
  const bundle = [
    fields.completedInboundSeq,
    fields.completedDeliveryJid,
    fields.completedDeliveryNamespace,
    fields.completedScope,
    fields.completedLogicalTurnId,
    fields.completedManagerId,
    fields.completedGeneration,
  ];
  if (bundle.every((value) => value === undefined)) return;
  if (bundle.some((value) => value === undefined)) {
    throw new Error('Turn checkpoint completed identity must be persisted as one complete bundle');
  }

  validateBoundedRequired(
    fields.completedDeliveryJid!,
    'Turn checkpoint completed delivery JID',
    TURN_RECOVERY_MAX_ID_BYTES,
  );
  validatePositiveSafeInteger(
    fields.completedInboundSeq!,
    'Turn checkpoint completed inbound sequence',
  );
  validateBoundedRequired(
    fields.completedDeliveryNamespace!,
    'Turn checkpoint completed delivery namespace',
    TURN_RECOVERY_MAX_ID_BYTES,
  );
  validateBoundedRequired(
    fields.completedLogicalTurnId!,
    'Turn checkpoint completed logical turn ID',
    TURN_RECOVERY_MAX_ID_BYTES,
  );
  validateBoundedRequired(
    fields.completedManagerId!,
    'Turn checkpoint completed manager ID',
    TURN_RECOVERY_MAX_ID_BYTES,
  );
  validatePositiveSafeInteger(
    fields.completedGeneration!,
    'Turn checkpoint completed generation',
  );
  if (!['per_chat', 'shared', 'singleton'].includes(fields.completedScope!)) {
    throw new Error('Turn checkpoint completed identity has an invalid scope');
  }
  if (requireDeliveryNamespace(fields.completedDeliveryJid!) !== fields.completedDeliveryNamespace) {
    throw new Error('Turn checkpoint completed identity has a contradictory delivery namespace');
  }
}

export interface TurnBookkeepingParams {
  sessionTokens?: {
    dbRowId: number;
    /** Genuinely-new input only — cache_read already subtracted (#1774). */
    inputTokens: number;
    outputTokens: number;
    /** Accumulates into total_cache_read_tokens, never total_input_tokens. */
    cacheReadTokens: number;
  };
  checkpoint?: {
    conversationKey: string;
    fields: SessionCheckpointFields;
  };
  lastOpId?: number;
}

export interface CompleteTurnParams extends TurnBookkeepingParams {
  inbound?: {
    seq: number;
    terminalReason: string;
  };
}

export type TerminalInboundMutation =
  | { kind: 'complete'; seq: number; terminalReason: string }
  | { kind: 'failed'; seq: number; failureClass: InboundFailureClass };

export interface TurnTerminalPersistenceParams {
  scope: string;
  conversationKey: string;
  deliveryJid: string;
  inboundSeq: number | null;
  logicalTurnId: string;
  managerId: string;
  generation: number;
  attemptKind: string;
  attemptFailureClass: string | null;
  inboundDisposition: string;
  deliveryKind: string;
  deliveryOpId: number | null;
  recoveryOwnerLogicalTurnId: string | null;
  recoveryOwnerManagerId: string | null;
  recoveryOwnerGeneration: number | null;
  replyGuaranteeDisarmed: boolean;
}

export interface TurnTerminalRecordRow {
  id: number;
  scope: string;
  conversation_key: string;
  delivery_jid: string;
  inbound_seq: number | null;
  inbound_seq_key: number;
  logical_turn_id: string;
  manager_id: string;
  generation: number;
  attempt_kind: string;
  attempt_failure_class: string | null;
  inbound_disposition: string;
  delivery_kind: string;
  delivery_op_id: number | null;
  recovery_owner_logical_turn_id: string | null;
  recovery_owner_manager_id: string | null;
  recovery_owner_generation: number | null;
  reply_guarantee_disarmed: number;
  duplicate_finalize_count: number;
  created_at: string;
  last_duplicate_at: string | null;
}

export interface RecordTurnTerminalResult {
  applied: boolean;
  recordId: number;
  duplicateFinalizeCount: number;
  /** Direct evidence stored on the conservative terminal row. */
  replyGuaranteeDisarmed: boolean;
}

export interface FinalizeTurnTerminalResult extends RecordTurnTerminalResult {
  /**
   * Proof that the committed terminal winner is the normalized request made by
   * this caller. True for a newly-applied winner and an exact idempotent
   * duplicate; false when the CAS key was already won by conflicting content.
   */
  winnerMatchesRequest: boolean;
  /**
   * Post-commit decision for the runtime reply guarantee. The terminal row is
   * deliberately conservative: a linked recovery row, not the terminal owner
   * tuple alone, is the durable proof that a transfer can disarm the prior
   * owner.
   */
  effectiveReplyGuaranteeDisarmed: boolean;
  recoveryJob?: EnqueueTurnRecoveryJobResult;
}

export type TurnFinalizationBookkeepingParams = Omit<TurnBookkeepingParams, 'lastOpId'>;

export interface FinalizeTurnTerminalParams {
  terminal: TurnTerminalPersistenceParams;
  inbound?: TerminalInboundMutation;
  bookkeeping?: TurnFinalizationBookkeepingParams;
  recoveryJob?: TurnRecoveryJobPersistenceParams;
}

const TERMINAL_PROVIDER_FAILURE_CLASSES: ReadonlySet<string> = new Set([
  'usage-limit',
  'rate-limit',
  'auth-required',
  'model-unavailable',
  'policy-block',
  'context-overflow',
  'server-error',
  'transient-network',
]);

function expectedTerminalInboundFailureClass(
  terminal: TurnTerminalPersistenceParams,
): InboundFailureClass {
  if (terminal.attemptKind === 'admission_rejected') {
    // Lockstep with turn-terminal.ts#toInboundMutation via the shared mapping:
    // null (legacy) → 'unknown'; a known admission subclass → its distinct
    // class; anything else is a contract violation (#1750).
    return admissionRejectInboundFailureClass(terminal.attemptFailureClass);
  }
  const detailed = terminal.attemptFailureClass;
  if (terminal.attemptKind !== 'failed' || detailed === null) {
    throw new Error('failed_terminal terminal disposition requires an exact attempt failure class');
  }
  if (detailed === 'crash') return 'session_crash';
  if (detailed === 'processor_throw') return 'processor_throw';
  if (detailed === 'unknown_terminal') return 'unknown';
  if (TERMINAL_PROVIDER_FAILURE_CLASSES.has(detailed)) return 'provider_failure';
  throw new Error('failed_terminal terminal disposition has an invalid attempt failure class');
}

export const DELIVERY_STATUS_PROOF: Readonly<Record<string, string>> = {
  enqueued: 'pending',
  flushed: 'submitted',
  echoed: 'echoed',
  delivery_unknown: 'maybe_sent',
};

export function normalizeFinalizeTurnTerminalParams(
  params: FinalizeTurnTerminalParams,
): FinalizeTurnTerminalParams {
  const { terminal, inbound, bookkeeping } = params;
  if (!['per_chat', 'shared', 'singleton'].includes(terminal.scope)) {
    throw new Error('Terminal identity has an invalid scope');
  }
  validateBoundedRequired(
    terminal.conversationKey,
    'Terminal identity conversation key',
    TURN_RECOVERY_MAX_ID_BYTES,
  );
  validateBoundedRequired(
    terminal.deliveryJid,
    'Terminal identity delivery JID',
    TURN_RECOVERY_MAX_ID_BYTES,
  );
  const terminalDeliveryNamespace = requireDeliveryNamespace(terminal.deliveryJid);
  validateBoundedRequired(
    terminal.logicalTurnId,
    'Terminal identity logical turn ID',
    TURN_RECOVERY_MAX_ID_BYTES,
  );
  validateBoundedRequired(
    terminal.managerId,
    'Terminal identity manager ID',
    TURN_RECOVERY_MAX_ID_BYTES,
  );
  if (terminal.inboundSeq !== null) {
    validatePositiveSafeInteger(terminal.inboundSeq, 'Terminal identity inbound sequence');
  }
  validatePositiveSafeInteger(terminal.generation, 'Terminal identity generation');

  if (terminal.attemptKind === 'failed') {
    const detailed = terminal.attemptFailureClass;
    if (
      detailed === null ||
      (
        detailed !== 'crash' &&
        detailed !== 'processor_throw' &&
        detailed !== 'unknown_terminal' &&
        !TERMINAL_PROVIDER_FAILURE_CLASSES.has(detailed)
      )
    ) {
      throw new Error('Terminal attempt axis requires a bounded exact failure class');
    }
  } else if (terminal.attemptKind === 'admission_rejected') {
    // #1750: admission_rejected may carry a distinct subclass on
    // attempt_failure_class (or null for a legacy/undifferentiated rejection).
    if (
      terminal.attemptFailureClass !== null &&
      !ADMISSION_REJECT_CLASSES.has(terminal.attemptFailureClass)
    ) {
      throw new Error('Terminal attempt axis has an incoherent failure class');
    }
  } else if (
    !['completed', 'suppressed_by_policy'].includes(terminal.attemptKind) ||
    terminal.attemptFailureClass !== null
  ) {
    throw new Error('Terminal attempt axis has an incoherent failure class');
  }

  const deliveryHasOp = terminal.deliveryKind !== 'none';
  if (
    (terminal.deliveryKind === 'none' && terminal.deliveryOpId !== null) ||
    (deliveryHasOp && (
      terminal.deliveryOpId === null ||
      !Number.isSafeInteger(terminal.deliveryOpId) ||
      terminal.deliveryOpId < 1 ||
      DELIVERY_STATUS_PROOF[terminal.deliveryKind] === undefined
    ))
  ) {
    throw new Error('Terminal delivery evidence has an incoherent durable op identity');
  }
  if (
    terminal.deliveryKind === 'delivery_unknown' &&
    terminal.inboundDisposition !== 'unfinalized_retry_owned' &&
    terminal.inboundDisposition !== 'transferred_to_recovery_owner'
  ) {
    throw new Error('delivery_unknown requires a bounded retry owner');
  }
  if (inbound !== undefined && terminal.inboundSeq !== inbound.seq) {
    throw new Error('Companion inbound mutation must match the terminal identity');
  }

  const requiresInboundMutation = terminal.inboundSeq !== null;
  switch (terminal.inboundDisposition) {
    case 'finalized_replied':
      if (
        terminal.deliveryKind !== 'echoed' ||
        (requiresInboundMutation && (
          inbound?.kind !== 'complete' ||
          inbound.terminalReason !== 'response_echoed'
        )) ||
        (!requiresInboundMutation && inbound !== undefined)
      ) {
        throw new Error(
          'finalized_replied terminal disposition requires echoed delivery and response_echoed completion',
        );
      }
      break;
    case 'finalized_no_reply_policy':
      if (
        terminal.attemptKind !== 'suppressed_by_policy' ||
        terminal.deliveryKind !== 'none' ||
        (requiresInboundMutation && (
          inbound?.kind !== 'complete' ||
          inbound.terminalReason !== 'no_reply_policy'
        )) ||
        (!requiresInboundMutation && inbound !== undefined)
      ) {
        throw new Error(
          'finalized_no_reply_policy terminal disposition requires no_reply_policy completion',
        );
      }
      break;
    case 'failed_terminal': {
      const expectedFailureClass = expectedTerminalInboundFailureClass(terminal);
      if (
        terminal.deliveryKind !== 'none' ||
        (requiresInboundMutation && inbound?.kind !== 'failed') ||
        (inbound?.kind === 'failed' && inbound.failureClass !== expectedFailureClass) ||
        (!requiresInboundMutation && inbound !== undefined)
      ) {
        throw new Error('failed_terminal terminal disposition requires a failed inbound mutation');
      }
      break;
    }
    case 'transferred_to_recovery_owner':
      if (terminal.deliveryKind === 'echoed') {
        throw new Error('Echoed delivery is exclusive to a finalized_replied disposition');
      }
      if (
        terminal.deliveryKind !== 'enqueued' &&
        terminal.deliveryKind !== 'flushed' &&
        terminal.deliveryKind !== 'delivery_unknown'
      ) {
        throw new Error(
          'transferred_to_recovery_owner requires unresolved delivery evidence',
        );
      }
      if (inbound !== undefined) {
        throw new Error(`${terminal.inboundDisposition} terminal disposition forbids an inbound mutation`);
      }
      break;
    case 'unfinalized_retry_owned':
      if (inbound !== undefined) {
        throw new Error(`${terminal.inboundDisposition} terminal disposition forbids an inbound mutation`);
      }
      break;
    default:
      throw new Error('Unknown terminal disposition');
  }

  if (
    terminal.deliveryKind === 'echoed' &&
    terminal.inboundDisposition !== 'finalized_replied'
  ) {
    throw new Error('Echoed delivery is exclusive to a finalized_replied disposition');
  }

  const ownerTuple = [
    terminal.recoveryOwnerLogicalTurnId,
    terminal.recoveryOwnerManagerId,
    terminal.recoveryOwnerGeneration,
  ];
  if (terminal.inboundDisposition === 'transferred_to_recovery_owner') {
    if (ownerTuple.some((value) => value === null)) {
      throw new Error('Transferred terminal disposition requires a complete recovery owner');
    }
    validateBoundedRequired(
      terminal.recoveryOwnerLogicalTurnId!,
      'Terminal recovery owner logical turn ID',
      TURN_RECOVERY_MAX_ID_BYTES,
    );
    validateBoundedRequired(
      terminal.recoveryOwnerManagerId!,
      'Terminal recovery owner manager ID',
      TURN_RECOVERY_MAX_ID_BYTES,
    );
    validatePositiveSafeInteger(
      terminal.recoveryOwnerGeneration!,
      'Terminal recovery owner generation',
    );
  } else if (ownerTuple.some((value) => value !== null)) {
    throw new Error('Recovery owner tuple is only valid for a transferred disposition');
  }

  if (
    bookkeeping?.checkpoint !== undefined &&
    bookkeeping.checkpoint.conversationKey !== terminal.conversationKey
  ) {
    throw new Error('Turn checkpoint conversation must match the terminal conversation');
  }
  if (bookkeeping !== undefined && 'lastOpId' in bookkeeping) {
    throw new Error('Finalization derives its terminal op from delivery evidence');
  }

  const isTransfer = terminal.inboundDisposition === 'transferred_to_recovery_owner';
  if (isTransfer && params.recoveryJob === undefined) {
    throw new Error('A transferred terminal disposition requires a recovery job');
  }
  if (!isTransfer && params.recoveryJob !== undefined) {
    throw new Error('A recovery job is only valid for a transferred disposition');
  }
  if (params.recoveryJob !== undefined) {
    const job = params.recoveryJob;
    validateTurnRecoveryJob(job);
    if (
      terminal.inboundSeq === null ||
      job.scope !== terminal.scope ||
      job.conversationKey !== terminal.conversationKey ||
      job.deliveryJid !== terminal.deliveryJid ||
      job.sourceInboundSeq !== terminal.inboundSeq ||
      job.sourceLogicalTurnId !== terminal.logicalTurnId ||
      job.sourceManagerId !== terminal.managerId ||
      job.sourceGeneration !== terminal.generation
    ) {
      throw new Error('Recovery source identity does not match terminal identity');
    }
    if (
      job.ownerLogicalTurnId !== terminal.recoveryOwnerLogicalTurnId ||
      job.ownerManagerId !== terminal.recoveryOwnerManagerId ||
      job.ownerGeneration !== terminal.recoveryOwnerGeneration
    ) {
      throw new Error('Recovery owner identity does not match the terminal owner tuple');
    }
    if (
      job.sourceLogicalTurnId === job.ownerLogicalTurnId &&
      job.sourceManagerId === job.ownerManagerId &&
      job.sourceGeneration === job.ownerGeneration
    ) {
      throw new Error('Recovery source and owner identities must differ');
    }
  }

  const normalizedTerminal: TurnTerminalPersistenceParams = {
    ...terminal,
    replyGuaranteeDisarmed:
      terminal.deliveryKind === 'echoed' ||
      terminal.inboundDisposition === 'finalized_no_reply_policy',
  };
  if (bookkeeping?.checkpoint === undefined) {
    return { ...params, terminal: normalizedTerminal };
  }

  const fields = bookkeeping.checkpoint.fields;
  const expectedInboundSeq = terminal.inboundSeq ?? undefined;
  const expectedFlushedOp = ['flushed', 'echoed', 'delivery_unknown'].includes(
    terminal.deliveryKind,
  )
    ? terminal.deliveryOpId ?? undefined
    : undefined;
  if (fields.activeTurnId !== undefined && fields.activeTurnId !== null) {
    throw new Error('Turn checkpoint activeTurnId must clear the completing turn');
  }
  if (
    fields.lastInboundSeq !== undefined &&
    fields.lastInboundSeq !== expectedInboundSeq
  ) {
    throw new Error('Turn checkpoint lastInboundSeq contradicts terminal identity');
  }
  if (
    fields.lastFlushedOutboundId !== undefined &&
    fields.lastFlushedOutboundId !== expectedFlushedOp
  ) {
    throw new Error('Turn checkpoint lastFlushedOutboundId contradicts delivery evidence');
  }

  const providedCompletedIdentity = [
    fields.completedInboundSeq,
    fields.completedDeliveryJid,
    fields.completedDeliveryNamespace,
    fields.completedScope,
    fields.completedLogicalTurnId,
    fields.completedManagerId,
    fields.completedGeneration,
  ];
  if (
    params.inbound === undefined &&
    providedCompletedIdentity.some((value) => value !== undefined)
  ) {
    throw new Error('Turn checkpoint completed identity requires a terminal inbound mutation');
  }
  const completedIdentity = params.inbound === undefined || expectedInboundSeq === undefined
    ? undefined
    : {
        completedInboundSeq: expectedInboundSeq,
        completedDeliveryJid: terminal.deliveryJid,
        completedDeliveryNamespace: terminalDeliveryNamespace,
        completedScope: terminal.scope as 'per_chat' | 'shared' | 'singleton',
        completedLogicalTurnId: terminal.logicalTurnId,
        completedManagerId: terminal.managerId,
        completedGeneration: terminal.generation,
      };
  if (completedIdentity !== undefined) {
    const contradictions = [
      fields.completedInboundSeq !== undefined &&
        fields.completedInboundSeq !== completedIdentity.completedInboundSeq,
      fields.completedDeliveryJid !== undefined &&
        fields.completedDeliveryJid !== completedIdentity.completedDeliveryJid,
      fields.completedDeliveryNamespace !== undefined &&
        fields.completedDeliveryNamespace !== completedIdentity.completedDeliveryNamespace,
      fields.completedScope !== undefined &&
        fields.completedScope !== completedIdentity.completedScope,
      fields.completedLogicalTurnId !== undefined &&
        fields.completedLogicalTurnId !== completedIdentity.completedLogicalTurnId,
      fields.completedManagerId !== undefined &&
        fields.completedManagerId !== completedIdentity.completedManagerId,
      fields.completedGeneration !== undefined &&
        fields.completedGeneration !== completedIdentity.completedGeneration,
    ];
    if (contradictions.some(Boolean)) {
      throw new Error('Turn checkpoint completed identity contradicts terminal identity');
    }
    validateCompletedCheckpointIdentity(
      completedIdentity,
    );
  }

  return {
    ...params,
    terminal: normalizedTerminal,
    bookkeeping: {
      ...bookkeeping,
      checkpoint: {
        conversationKey: bookkeeping.checkpoint.conversationKey,
        fields: {
          ...fields,
          activeTurnId: null,
          ...(expectedInboundSeq === undefined ? {} : { lastInboundSeq: expectedInboundSeq }),
          ...(expectedFlushedOp === undefined
            ? {}
            : { lastFlushedOutboundId: expectedFlushedOp }),
          ...(completedIdentity === undefined ? {} : completedIdentity),
        },
      },
    },
  };
}

export function terminalRecordMatches(
  row: TurnTerminalRecordRow,
  terminal: TurnTerminalPersistenceParams,
): boolean {
  return row.scope === terminal.scope &&
    row.conversation_key === terminal.conversationKey &&
    row.delivery_jid === terminal.deliveryJid &&
    row.inbound_seq === terminal.inboundSeq &&
    row.logical_turn_id === terminal.logicalTurnId &&
    row.manager_id === terminal.managerId &&
    row.generation === terminal.generation &&
    row.attempt_kind === terminal.attemptKind &&
    row.attempt_failure_class === terminal.attemptFailureClass &&
    row.inbound_disposition === terminal.inboundDisposition &&
    row.delivery_kind === terminal.deliveryKind &&
    row.delivery_op_id === terminal.deliveryOpId &&
    row.recovery_owner_logical_turn_id === terminal.recoveryOwnerLogicalTurnId &&
    row.recovery_owner_manager_id === terminal.recoveryOwnerManagerId &&
    row.recovery_owner_generation === terminal.recoveryOwnerGeneration &&
    row.reply_guarantee_disarmed === (terminal.replyGuaranteeDisarmed ? 1 : 0);
}
