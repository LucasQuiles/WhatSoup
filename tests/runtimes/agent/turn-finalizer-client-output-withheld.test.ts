import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import type {
  FinalizeTurnTerminalResult,
  OutboundDeliveryIdentity,
  OutboundDeliverySnapshot,
  OutboundStatus,
} from '../../../src/core/durability.ts';
import { normalizeFinalizeTurnTerminalParams } from '../../../src/core/turn-finalization-contract.ts';
import type { AlertEmissionResult } from '../../../src/lib/emit-alert.ts';
import {
  finalizeRuntimeTurn,
  type FinalizeRuntimeTurnResult,
  type RuntimeTurnFinalizerDurability,
} from '../../../src/runtimes/agent/turn-finalizer.ts';
import {
  toTurnFinalizationPersistence,
  type AttemptOutcome,
  type TurnIdentity,
  type TurnRecoveryReplayEnvelope,
} from '../../../src/runtimes/agent/turn-terminal.ts';

// #3613: an answer the client output policy withheld is a deliberate terminal
// outcome. The turn is not handed to recovery or replayed, the reply guarantee
// is satisfied by the policy decision, and the terminal record says the output
// was withheld rather than sent.

const emitAlertMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/lib/emit-alert.ts', () => ({ emitObservationChecked: vi.fn(() => true),
  emitAlert: emitAlertMock,
  emitAlertChecked: (...args: unknown[]) => {
    const result = emitAlertMock(...args) as AlertEmissionResult;
    return result.ok;
  },
}));

const IDENTITY: TurnIdentity = {
  scope: 'per_chat',
  conversationKey: 'conversation-51',
  deliveryJid: '15550100051@s.whatsapp.net',
  inboundSeq: 51,
  logicalTurnId: 'turn-51',
  managerId: 'manager-a',
  generation: 2,
};

const REPLAY: TurnRecoveryReplayEnvelope = {
  sourceMessageId: 'wamid-51',
  receivedAtUnixSeconds: 1_780_000_000,
  replaySafe: true,
  senderJid: '15550100052@s.whatsapp.net',
  senderName: 'Sender',
  text: 'inbound text',
  isGroup: false,
};

const RECEIPT: FinalizeTurnTerminalResult = {
  applied: true,
  winnerMatchesRequest: true,
  recordId: 7,
  duplicateFinalizeCount: 0,
  replyGuaranteeDisarmed: true,
  effectiveReplyGuaranteeDisarmed: true,
};

function harness(statuses: Readonly<Record<number, OutboundStatus | undefined>> = {}) {
  const getOutboundDeliverySnapshot = vi.fn<RuntimeTurnFinalizerDurability['getOutboundDeliverySnapshot']>(
    (opId: number, identity: OutboundDeliveryIdentity): OutboundDeliverySnapshot | undefined => {
      const status = statuses[opId];
      return status === undefined ? undefined : { opId, ...identity, status };
    },
  );
  const finalizeTurnTerminal = vi.fn<RuntimeTurnFinalizerDurability['finalizeTurnTerminal']>(() => RECEIPT);
  const markContinuityCandidateIfNoTerminalOutbound = vi.fn<
    RuntimeTurnFinalizerDurability['markContinuityCandidateIfNoTerminalOutbound']
  >(() => true);
  return {
    durability: { getOutboundDeliverySnapshot, finalizeTurnTerminal, markContinuityCandidateIfNoTerminalOutbound },
    finalizeTurnTerminal,
    markContinuityCandidateIfNoTerminalOutbound,
  };
}

function run(
  durability: RuntimeTurnFinalizerDurability,
  opts: { attemptOutcome?: AttemptOutcome; opIds?: readonly number[]; withheldAnswerCount?: number },
): FinalizeRuntimeTurnResult {
  return finalizeRuntimeTurn({
    instanceName: 'agent-alpha',
    durability,
    identity: IDENTITY,
    attemptOutcome: opts.attemptOutcome ?? { kind: 'completed' },
    answerEvidence: {
      kind: 'ready',
      opIds: opts.opIds ?? [],
      withheldAnswerCount: opts.withheldAnswerCount ?? 0,
    },
    recoveryOwner: { logicalTurnId: 'turn-recovery-51', managerId: 'manager-r', generation: 3 },
    replay: REPLAY,
  });
}

function terminal(result: FinalizeRuntimeTurnResult) {
  if (result.kind !== 'terminal') throw new Error(`expected terminal result, received ${result.kind}`);
  return result;
}

beforeEach(() => {
  emitAlertMock.mockReset();
  emitAlertMock.mockReturnValue({ ok: true, channel: 'outbox', status: 'durably_queued' });
});

describe('client output policy withheld answer finalization (#3613)', () => {
  it('finalizes a completed turn whose only answer was withheld as withheld_by_policy', () => {
    const h = harness();
    const result = terminal(run(h.durability, { withheldAnswerCount: 1 }));

    expect(result.terminal).toMatchObject({
      attemptOutcome: { kind: 'withheld_by_policy' },
      inboundDisposition: 'finalized_no_reply_policy',
      deliveryEvidence: { kind: 'none' },
    });
  });

  it('(a) is not handed to recovery or replayed: no recovery job, no owner, no catch-up candidate', () => {
    const h = harness();
    run(h.durability, { withheldAnswerCount: 1 });

    expect(h.finalizeTurnTerminal).toHaveBeenCalledTimes(1);
    const params = h.finalizeTurnTerminal.mock.calls[0]![0];
    expect(params.recoveryJob).toBeUndefined();
    expect(params.terminal.recoveryOwnerLogicalTurnId).toBeNull();
    expect(params.terminal.inboundDisposition).toBe('finalized_no_reply_policy');
    // The continuity candidate mark is what later operator catch-up replays.
    expect(h.markContinuityCandidateIfNoTerminalOutbound).not.toHaveBeenCalled();
  });

  it('(b) satisfies the reply guarantee: disarmed, no breach alert, no continuity candidate', () => {
    const h = harness();
    run(h.durability, { withheldAnswerCount: 2 });

    const params = h.finalizeTurnTerminal.mock.calls[0]![0];
    expect(params.terminal.replyGuaranteeDisarmed).toBe(true);
    expect(emitAlertMock).not.toHaveBeenCalled();
    expect(h.markContinuityCandidateIfNoTerminalOutbound).not.toHaveBeenCalled();
  });

  it('(c) records completed-with-withheld-output, not a sent reply', () => {
    const h = harness();
    run(h.durability, { withheldAnswerCount: 1 });

    const params = h.finalizeTurnTerminal.mock.calls[0]![0];
    expect(params.terminal.attemptKind).toBe('withheld_by_policy');
    expect(params.terminal.attemptFailureClass).toBeNull();
    expect(params.terminal.deliveryKind).toBe('none');
    expect(params.terminal.deliveryOpId).toBeNull();
    expect(params.inbound).toEqual({ kind: 'complete', seq: 51, terminalReason: 'client_output_withheld' });
  });

  it('keeps a completed empty turn with nothing withheld as a terminal unknown failure', () => {
    const h = harness();
    const result = terminal(run(h.durability, { withheldAnswerCount: 0 }));

    expect(result.terminal.attemptOutcome).toEqual({ kind: 'failed', class: 'unknown_terminal' });
    expect(result.terminal.inboundDisposition).toBe('failed_terminal');
  });

  it('keeps a turn that delivered another answer as replied', () => {
    const h = harness({ 9: 'echoed' });
    const result = terminal(run(h.durability, { opIds: [9], withheldAnswerCount: 1 }));

    expect(result.terminal.attemptOutcome).toEqual({ kind: 'completed' });
    expect(result.terminal.inboundDisposition).toBe('finalized_replied');
  });

  it('does not relabel a failed attempt as withheld', () => {
    const h = harness();
    const result = terminal(run(h.durability, {
      attemptOutcome: { kind: 'failed', class: 'crash' },
      withheldAnswerCount: 1,
    }));

    expect(result.terminal.attemptOutcome).toEqual({ kind: 'failed', class: 'crash' });
    expect(result.terminal.inboundDisposition).toBe('failed_terminal');
  });

  it('rejects a withheld outcome paired with the no-reply-policy completion reason', () => {
    const persistence = toTurnFinalizationPersistence({
      identity: IDENTITY,
      attemptOutcome: { kind: 'withheld_by_policy' },
      inboundDisposition: 'finalized_no_reply_policy',
      deliveryEvidence: { kind: 'none' },
    });
    expect(() => normalizeFinalizeTurnTerminalParams({
      ...persistence,
      inbound: { kind: 'complete', seq: 51, terminalReason: 'no_reply_policy' },
    })).toThrow(/finalized_no_reply_policy/);
  });

  it('persists through the real durability ledger without a schema change', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const durability = new DurabilityEngine(db);
      const conversationKey = 'conversation-withheld-ledger';
      const deliveryJid = '15550100053@s.whatsapp.net';
      const inboundSeq = durability.journalInbound('wamid-withheld', conversationKey, deliveryJid, 'agent');

      const result = terminal(finalizeRuntimeTurn({
        instanceName: 'agent-alpha',
        durability,
        identity: {
          scope: 'per_chat',
          conversationKey,
          deliveryJid,
          inboundSeq,
          logicalTurnId: 'turn-withheld',
          managerId: 'manager-withheld',
          generation: 1,
        },
        attemptOutcome: { kind: 'completed' },
        answerEvidence: { kind: 'ready', opIds: [], withheldAnswerCount: 1 },
        replay: REPLAY,
      }));

      expect(result.terminal.inboundDisposition).toBe('finalized_no_reply_policy');
      expect(db.raw.prepare(
        `SELECT attempt_kind, inbound_disposition, delivery_kind, reply_guarantee_disarmed
           FROM turn_terminal_records WHERE inbound_seq = ?`,
      ).get(inboundSeq)).toEqual({
        attempt_kind: 'withheld_by_policy',
        inbound_disposition: 'finalized_no_reply_policy',
        delivery_kind: 'none',
        reply_guarantee_disarmed: 1,
      });
      expect(db.raw.prepare(
        'SELECT processing_status, terminal_reason FROM inbound_events WHERE seq = ?',
      ).get(inboundSeq)).toEqual({ processing_status: 'complete', terminal_reason: 'client_output_withheld' });
      expect(db.raw.prepare('SELECT COUNT(*) AS n FROM turn_recovery_jobs').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
});
