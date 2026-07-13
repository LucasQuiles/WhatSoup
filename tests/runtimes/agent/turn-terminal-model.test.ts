import { describe, expect, it } from 'vitest';
import { normalizeFinalizeTurnTerminalParams } from '../../../src/core/turn-finalization-contract.ts';
import {
  shouldDisarmReplyGuarantee,
  toTurnFinalizationPersistence,
  toTurnTerminalPersistence,
  type TurnTerminalResult,
} from '../../../src/runtimes/agent/turn-terminal.ts';

const IDENTITY = {
  scope: 'per_chat',
  conversationKey: '15550100001',
  deliveryJid: '15550100001:7@s.whatsapp.net',
  inboundSeq: 41,
  logicalTurnId: 'turn-41',
  managerId: 'manager-a',
  generation: 3,
} as const;

function terminal(overrides: Partial<TurnTerminalResult> = {}): TurnTerminalResult {
  return {
    identity: IDENTITY,
    attemptOutcome: { kind: 'completed' },
    inboundDisposition: 'finalized_replied',
    deliveryEvidence: { kind: 'none' },
    ...overrides,
  };
}

describe('three-axis terminal model', () => {
  it('represents attempt outcome, inbound disposition, and delivery evidence independently', () => {
    expect(terminal({
      attemptOutcome: { kind: 'failed', class: 'transient-network' },
      inboundDisposition: 'unfinalized_retry_owned',
      deliveryEvidence: { kind: 'flushed', opId: 91 },
    })).toMatchObject({
      attemptOutcome: { kind: 'failed', class: 'transient-network' },
      inboundDisposition: 'unfinalized_retry_owned',
      deliveryEvidence: { kind: 'flushed', opId: 91 },
    });
  });

  it('preserves delivery JID independently from conversation key during serialization', () => {
    const persisted = toTurnTerminalPersistence(terminal());
    expect(persisted.conversationKey).toBe('15550100001');
    expect(persisted.deliveryJid).toBe('15550100001:7@s.whatsapp.net');
  });

  it('serializes exact provider failure class on the attempt axis', () => {
    const persisted = toTurnTerminalPersistence(terminal({
      attemptOutcome: { kind: 'failed', class: 'rate-limit' },
    }));
    expect(persisted.attemptKind).toBe('failed');
    expect(persisted.attemptFailureClass).toBe('rate-limit');
  });
});

describe('turn-finalization persistence mapping', () => {
  it('maps only an echoed reply to response_echoed', () => {
    expect(toTurnFinalizationPersistence(terminal({
      deliveryEvidence: { kind: 'echoed', opId: 72 },
    })).inbound).toEqual({
      kind: 'complete',
      seq: 41,
      terminalReason: 'response_echoed',
    });
  });

  it('rejects finalized_replied without echoed delivery evidence', () => {
    expect(() => toTurnFinalizationPersistence(terminal({
      deliveryEvidence: { kind: 'flushed', opId: 72 },
    }))).toThrow('echoed delivery evidence');
  });

  it('maps explicit no-reply policy without inferring it from completion', () => {
    expect(toTurnFinalizationPersistence(terminal({
      attemptOutcome: { kind: 'suppressed_by_policy' },
      inboundDisposition: 'finalized_no_reply_policy',
    })).inbound).toEqual({
      kind: 'complete',
      seq: 41,
      terminalReason: 'no_reply_policy',
    });
    expect(toTurnFinalizationPersistence(terminal({
      inboundDisposition: 'unfinalized_retry_owned',
    })).inbound).toBeUndefined();
  });

  it.each([
    ['rate-limit', 'provider_failure'],
    ['processor_throw', 'unknown'],
    ['crash', 'session_crash'],
    ['unknown_terminal', 'unknown'],
  ] as const)(
    'keeps exact terminal class %s while mapping bounded inbound class',
    (failureClass, expected) => {
      const persistence = toTurnFinalizationPersistence(terminal({
        attemptOutcome: { kind: 'failed', class: failureClass },
        inboundDisposition: 'failed_terminal',
      }));
      expect(persistence.terminal.attemptFailureClass).toBe(failureClass);
      expect(persistence.inbound).toEqual({
        kind: 'failed',
        seq: 41,
        failureClass: expected,
      });
    },
  );

  it('retains admission rejection and maps bounded unknown inbound', () => {
    const persistence = toTurnFinalizationPersistence(terminal({
      attemptOutcome: { kind: 'admission_rejected' },
      inboundDisposition: 'failed_terminal',
    }));
    expect(persistence.terminal.attemptKind).toBe('admission_rejected');
    expect(persistence.inbound).toEqual({
      kind: 'failed',
      seq: 41,
      failureClass: 'unknown',
    });
  });

  it('does not manufacture an inbound write without an inbound sequence', () => {
    expect(toTurnFinalizationPersistence(terminal({
      identity: { ...IDENTITY, inboundSeq: null },
      deliveryEvidence: { kind: 'echoed', opId: 72 },
    })).inbound).toBeUndefined();
  });

  it('collapses not_sent delivery evidence to a persisted none so the failed_terminal contract shape is unchanged (#1749)', () => {
    const persistence = toTurnFinalizationPersistence(terminal({
      attemptOutcome: { kind: 'failed', class: 'unknown_terminal' },
      inboundDisposition: 'failed_terminal',
      deliveryEvidence: { kind: 'not_sent', opId: 72 },
    }));

    expect(persistence.terminal.deliveryKind).toBe('none');
    expect(persistence.terminal.deliveryOpId).toBeNull();
    expect(persistence.inbound).toEqual({
      kind: 'failed',
      seq: 41,
      failureClass: 'unknown',
    });

    // Round-trip proof: the collapsed shape is exactly what the contract
    // already accepts for a 'none' failed_terminal row, so it must not throw.
    expect(() => normalizeFinalizeTurnTerminalParams({
      terminal: persistence.terminal,
      inbound: persistence.inbound,
    })).not.toThrow();
  });
});

describe('reply-guarantee disarm rules', () => {
  it('disarms on echoed delivery and explicit no-reply policy', () => {
    expect(shouldDisarmReplyGuarantee(terminal({
      deliveryEvidence: { kind: 'echoed', opId: 1 },
    }))).toBe(true);
    expect(shouldDisarmReplyGuarantee(terminal({
      attemptOutcome: { kind: 'suppressed_by_policy' },
      inboundDisposition: 'finalized_no_reply_policy',
    }))).toBe(true);
  });

  it('requires durable transfer context to disarm a normal ownership transfer', () => {
    const transfer = terminal({
      inboundDisposition: 'transferred_to_recovery_owner',
      deliveryEvidence: { kind: 'enqueued', opId: 2 },
    });
    expect(shouldDisarmReplyGuarantee(transfer)).toBe(false);
    expect(shouldDisarmReplyGuarantee(transfer, { recoveryTransferDurable: true })).toBe(true);
  });

  it.each([
    { kind: 'none' } as const,
    { kind: 'enqueued', opId: 2 } as const,
    { kind: 'flushed', opId: 3 } as const,
  ])('stays armed with $kind delivery evidence', (deliveryEvidence) => {
    expect(shouldDisarmReplyGuarantee(terminal({ deliveryEvidence }))).toBe(false);
  });

  it('keeps delivery_unknown armed for retry and transferred ownership', () => {
    expect(shouldDisarmReplyGuarantee(terminal({
      inboundDisposition: 'unfinalized_retry_owned',
      deliveryEvidence: { kind: 'delivery_unknown', opId: 4 },
    }))).toBe(false);
    expect(shouldDisarmReplyGuarantee(
      terminal({
        inboundDisposition: 'transferred_to_recovery_owner',
        deliveryEvidence: { kind: 'delivery_unknown', opId: 5 },
      }),
      { recoveryTransferDurable: true },
    )).toBe(false);
  });

  it('rejects delivery_unknown without a bounded retry owner', () => {
    expect(() => toTurnTerminalPersistence(terminal({
      deliveryEvidence: { kind: 'delivery_unknown', opId: 5 },
    }))).toThrow('bounded retry owner');
  });
});

describe('recovery-owner serialization', () => {
  const transfer = terminal({
    attemptOutcome: { kind: 'failed', class: 'transient-network' },
    inboundDisposition: 'transferred_to_recovery_owner',
    deliveryEvidence: { kind: 'enqueued', opId: 2 },
  });

  it('requires a complete recovery owner only on transferred dispositions', () => {
    expect(() => toTurnTerminalPersistence(transfer)).toThrow('recovery owner identity');
    expect(() => toTurnTerminalPersistence(terminal(), {
      logicalTurnId: 'retry', managerId: 'recovery-manager', generation: 4,
    })).toThrow('only valid for a transferred');
  });

  it.each([
    { logicalTurnId: ' ', managerId: 'manager', generation: 4 },
    { logicalTurnId: 'retry', managerId: '\t', generation: 4 },
  ])('rejects blank owner IDs', (owner) => {
    expect(() => toTurnTerminalPersistence(transfer, owner)).toThrow('nonempty');
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid recovery generation %s',
    (generation) => {
      expect(() => toTurnTerminalPersistence(transfer, {
        logicalTurnId: 'retry', managerId: 'manager', generation,
      })).toThrow('positive safe integer');
    },
  );
});
