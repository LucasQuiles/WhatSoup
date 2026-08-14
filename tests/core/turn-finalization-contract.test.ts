import { describe, expect, it } from 'vitest';
import {
  normalizeFinalizeTurnTerminalParams,
  validateCompletedCheckpointIdentity,
  type FinalizeTurnTerminalParams,
  type SessionCheckpointFields,
  type TurnTerminalPersistenceParams,
} from '../../src/core/turn-finalization-contract.ts';

const CONVERSATION_KEY = 'conversation-contract';
const DELIVERY_JID = '15550100001:7@s.whatsapp.net';
const DELIVERY_NAMESPACE = 's.whatsapp.net';

function terminal(
  overrides: Partial<TurnTerminalPersistenceParams> = {},
): TurnTerminalPersistenceParams {
  return {
    scope: 'per_chat',
    conversationKey: CONVERSATION_KEY,
    deliveryJid: DELIVERY_JID,
    inboundSeq: 41,
    logicalTurnId: 'turn-41',
    managerId: 'manager-contract',
    generation: 2,
    attemptKind: 'failed',
    attemptFailureClass: 'transient-network',
    inboundDisposition: 'unfinalized_retry_owned',
    deliveryKind: 'none',
    deliveryOpId: null,
    recoveryOwnerLogicalTurnId: null,
    recoveryOwnerManagerId: null,
    recoveryOwnerGeneration: null,
    replyGuaranteeDisarmed: false,
    ...overrides,
  };
}

function completedBundle(
  overrides: Partial<SessionCheckpointFields> = {},
): SessionCheckpointFields {
  return {
    completedInboundSeq: 41,
    completedDeliveryJid: DELIVERY_JID,
    completedDeliveryNamespace: DELIVERY_NAMESPACE,
    completedScope: 'per_chat',
    completedLogicalTurnId: 'turn-41',
    completedManagerId: 'manager-contract',
    completedGeneration: 2,
    ...overrides,
  };
}

describe('completed checkpoint identity bundle', () => {
  it('accepts a complete coherent bundle and an entirely absent one', () => {
    expect(() => validateCompletedCheckpointIdentity(completedBundle())).not.toThrow();
    expect(() => validateCompletedCheckpointIdentity({})).not.toThrow();
  });

  it.each([
    'completedInboundSeq',
    'completedDeliveryJid',
    'completedDeliveryNamespace',
    'completedScope',
    'completedLogicalTurnId',
    'completedManagerId',
    'completedGeneration',
  ] as const)('rejects a bundle missing only %s', (field) => {
    expect(() => validateCompletedCheckpointIdentity({
      ...completedBundle(),
      [field]: undefined,
    })).toThrow('one complete bundle');
  });

  it('rejects a bundle whose scope is outside the bounded vocabulary', () => {
    expect(() => validateCompletedCheckpointIdentity(completedBundle({
      completedScope: 'invalid-scope' as never,
    }))).toThrow('invalid scope');
  });

  it('rejects a namespace that contradicts the completed delivery JID', () => {
    expect(() => validateCompletedCheckpointIdentity(completedBundle({
      completedDeliveryNamespace: 'lid',
    }))).toThrow('contradictory delivery namespace');
  });
});

describe('terminal attempt axis coherence', () => {
  it('rejects failed_terminal built from a completed attempt with no failure class', () => {
    expect(() => normalizeFinalizeTurnTerminalParams({
      terminal: terminal({
        attemptKind: 'completed',
        attemptFailureClass: null,
        inboundDisposition: 'failed_terminal',
      }),
    })).toThrow('requires an exact attempt failure class');
  });

  it('rejects an admission rejection carrying a non-admission subclass', () => {
    expect(() => normalizeFinalizeTurnTerminalParams({
      terminal: terminal({
        attemptKind: 'admission_rejected',
        attemptFailureClass: 'not-an-admission-class',
        inboundDisposition: 'failed_terminal',
      }),
    })).toThrow('incoherent failure class');
  });
});

describe('terminal disposition and delivery coherence', () => {
  it('rejects an unknown terminal disposition', () => {
    expect(() => normalizeFinalizeTurnTerminalParams({
      terminal: terminal({ inboundDisposition: 'not-a-disposition' }),
    })).toThrow('Unknown terminal disposition');
  });

  it('rejects a transfer with no unresolved delivery evidence', () => {
    expect(() => normalizeFinalizeTurnTerminalParams({
      terminal: terminal({
        inboundDisposition: 'transferred_to_recovery_owner',
        deliveryKind: 'none',
        deliveryOpId: null,
      }),
    })).toThrow('unresolved delivery evidence');
  });

  it('rejects a transfer that also carries an inbound mutation', () => {
    expect(() => normalizeFinalizeTurnTerminalParams({
      terminal: terminal({
        inboundDisposition: 'transferred_to_recovery_owner',
        deliveryKind: 'enqueued',
        deliveryOpId: 7,
        recoveryOwnerLogicalTurnId: 'recovery-turn',
        recoveryOwnerManagerId: 'manager-recovery',
        recoveryOwnerGeneration: 3,
      }),
      inbound: { kind: 'complete', seq: 41, terminalReason: 'response_echoed' },
    })).toThrow('forbids an inbound mutation');
  });

  it('rejects echoed delivery evidence on a retry-owned disposition', () => {
    expect(() => normalizeFinalizeTurnTerminalParams({
      terminal: terminal({
        inboundDisposition: 'unfinalized_retry_owned',
        deliveryKind: 'echoed',
        deliveryOpId: 7,
      }),
    })).toThrow('exclusive to a finalized_replied disposition');
  });

  it('rejects a transfer whose recovery owner tuple is incomplete', () => {
    expect(() => normalizeFinalizeTurnTerminalParams({
      terminal: terminal({
        inboundDisposition: 'transferred_to_recovery_owner',
        deliveryKind: 'enqueued',
        deliveryOpId: 7,
        recoveryOwnerLogicalTurnId: 'recovery-turn',
        recoveryOwnerManagerId: null,
        recoveryOwnerGeneration: null,
      }),
    })).toThrow('complete recovery owner');
  });

  it('rejects a recovery owner tuple on a non-transferred disposition', () => {
    expect(() => normalizeFinalizeTurnTerminalParams({
      terminal: terminal({
        inboundDisposition: 'unfinalized_retry_owned',
        recoveryOwnerLogicalTurnId: 'recovery-turn',
      }),
    })).toThrow('only valid for a transferred disposition');
  });
});

describe('null-inbound terminal normalization', () => {
  it('normalizes a null-inbound replied terminal and derives the echoed disarm', () => {
    const params: FinalizeTurnTerminalParams = {
      terminal: terminal({
        inboundSeq: null,
        logicalTurnId: 'turn-null-replied',
        inboundDisposition: 'finalized_replied',
        attemptKind: 'completed',
        attemptFailureClass: null,
        deliveryKind: 'echoed',
        deliveryOpId: 7,
      }),
    };

    const normalized = normalizeFinalizeTurnTerminalParams(params);

    expect(normalized.terminal).toEqual({
      ...params.terminal,
      replyGuaranteeDisarmed: true,
    });
  });

  it('normalizes a null-inbound failed terminal without disarming the reply guarantee', () => {
    const params: FinalizeTurnTerminalParams = {
      terminal: terminal({
        inboundSeq: null,
        logicalTurnId: 'turn-null-failed',
        inboundDisposition: 'failed_terminal',
        attemptKind: 'failed',
        attemptFailureClass: 'crash',
        replyGuaranteeDisarmed: true,
      }),
    };

    const normalized = normalizeFinalizeTurnTerminalParams(params);

    expect(normalized.terminal).toEqual({
      ...params.terminal,
      replyGuaranteeDisarmed: false,
    });
  });
});

describe('checkpoint derivation for null-inbound and completed identity', () => {
  it('leaves inbound and delivery checkpoint fields absent for a null-inbound policy turn', () => {
    const normalized = normalizeFinalizeTurnTerminalParams({
      terminal: terminal({
        inboundSeq: null,
        logicalTurnId: 'turn-null-policy',
        inboundDisposition: 'finalized_no_reply_policy',
        attemptKind: 'suppressed_by_policy',
        attemptFailureClass: null,
      }),
      bookkeeping: {
        checkpoint: {
          conversationKey: CONVERSATION_KEY,
          fields: { watchdogState: 'healthy' },
        },
      },
    });

    expect(normalized.terminal.replyGuaranteeDisarmed).toBe(true);
    expect(normalized.bookkeeping?.checkpoint?.fields).toEqual({
      watchdogState: 'healthy',
      activeTurnId: null,
    });
  });

  it('rejects checkpoint completed identity fields without a terminal inbound mutation', () => {
    expect(() => normalizeFinalizeTurnTerminalParams({
      terminal: terminal(),
      bookkeeping: {
        checkpoint: {
          conversationKey: CONVERSATION_KEY,
          fields: { completedInboundSeq: 41 },
        },
      },
    })).toThrow('requires a terminal inbound mutation');
  });

  it('rejects a checkpoint completedInboundSeq that contradicts the terminal identity', () => {
    expect(() => normalizeFinalizeTurnTerminalParams({
      terminal: terminal({
        inboundDisposition: 'finalized_replied',
        attemptKind: 'completed',
        attemptFailureClass: null,
        deliveryKind: 'echoed',
        deliveryOpId: 7,
      }),
      inbound: { kind: 'complete', seq: 41, terminalReason: 'response_echoed' },
      bookkeeping: {
        checkpoint: {
          conversationKey: CONVERSATION_KEY,
          fields: { completedInboundSeq: 999 },
        },
      },
    })).toThrow('contradicts terminal identity');
  });

  it('accepts a matching provided completedInboundSeq and derives the full identity', () => {
    const normalized = normalizeFinalizeTurnTerminalParams({
      terminal: terminal({
        inboundDisposition: 'finalized_replied',
        attemptKind: 'completed',
        attemptFailureClass: null,
        deliveryKind: 'echoed',
        deliveryOpId: 7,
      }),
      inbound: { kind: 'complete', seq: 41, terminalReason: 'response_echoed' },
      bookkeeping: {
        checkpoint: {
          conversationKey: CONVERSATION_KEY,
          fields: { completedInboundSeq: 41 },
        },
      },
    });

    expect(normalized.bookkeeping?.checkpoint?.fields).toEqual({
      activeTurnId: null,
      lastInboundSeq: 41,
      lastFlushedOutboundId: 7,
      completedInboundSeq: 41,
      completedDeliveryJid: DELIVERY_JID,
      completedDeliveryNamespace: DELIVERY_NAMESPACE,
      completedScope: 'per_chat',
      completedLogicalTurnId: 'turn-41',
      completedManagerId: 'manager-contract',
      completedGeneration: 2,
    });
  });
});
