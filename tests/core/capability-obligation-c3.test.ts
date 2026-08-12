/**
 * D4 — terminal decision, audit, and obligation insert share C3 atomicity
 * (capability-obligation replay). Fault matrix per the reviewed contract:
 * failure at/around terminal insert, audit insert, obligation insert → restart
 * observes one terminal delivery record and at most one open obligation, never
 * a delivered refusal plus silently lost debt; duplicate re-finalization never
 * duplicates the decision.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CapabilityDecisionParams } from '../../src/core/capability-obligation-store.ts';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import {
  toTurnFinalizationPersistence,
  type TurnTerminalResult,
} from '../../src/runtimes/agent/turn-terminal.ts';

const IDENTITY = {
  scope: 'per_chat',
  conversationKey: 'conversation-obligation',
  deliveryJid: '15550100002:7@s.whatsapp.net',
  inboundSeq: 1,
  logicalTurnId: 'turn-obligation',
  managerId: 'manager-primary',
  generation: 2,
} as const;

function replied(inboundSeq: number, opId: number): TurnTerminalResult {
  return {
    identity: { ...IDENTITY, inboundSeq },
    attemptOutcome: { kind: 'completed' },
    inboundDisposition: 'finalized_replied',
    deliveryEvidence: { kind: 'echoed', opId },
  };
}

function decision(over: Partial<Record<string, unknown>> = {}): CapabilityDecisionParams {
  return {
    auditEvent: {
      action: 'obligation.create',
      actorType: 'runtime',
      reasonCode: 'conclusive_no_effect',
      sourceHash: 'aa'.repeat(32),
    },
    obligation: {
      sourceInboundSeq: 1,
      sourceMessageId: 'msg-obligation-1',
      conversationKey: IDENTITY.conversationKey,
      deliveryJid: IDENTITY.deliveryJid,
      senderJid: '15550100003@s.whatsapp.net',
      senderName: 'Test Sender',
      isGroup: false,
      groupName: null,
      scope: 'per_chat',
      originRecoveryJobId: null,
      replayText: 'https://youtu.be/abc',
      contentTypeHint: 'text',
      contractVersion: 'test-instance/1',
      requiredCapability: 'child_process_tools',
      capabilityParams: '{"skill":"watch"}',
      inputDigest: 'aa'.repeat(32),
      retainedMedia: null,
      creationReason: 'typed_deferral_signal',
      ...over,
    } as CapabilityDecisionParams['obligation'],
  };
}

describe('C3-joined capability decision (D4)', () => {
  let db: Database;
  let durability: DurabilityEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    durability = new DurabilityEngine(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedEchoedTurn(messageId = 'msg-obligation-1'): { inboundSeq: number; opId: number } {
    const inboundSeq = durability.journalInbound(
      messageId,
      IDENTITY.conversationKey,
      IDENTITY.deliveryJid,
      'agent',
    );
    const opId = durability.createOutboundOp({
      conversationKey: IDENTITY.conversationKey,
      chatJid: IDENTITY.deliveryJid,
      opType: 'send_text',
      payload: '{"text":"refusal"}',
      replayPolicy: 'safe',
      sourceInboundSeq: inboundSeq,
    });
    durability.markSending(opId);
    durability.markSubmitted(opId, `wa-${messageId}`);
    durability.markEchoed(opId);
    return { inboundSeq, opId };
  }

  const counts = () => ({
    terminals: (db.raw.prepare('SELECT COUNT(*) c FROM turn_terminal_records').get() as { c: number }).c,
    obligations: (db.raw.prepare('SELECT COUNT(*) c FROM capability_obligations').get() as { c: number }).c,
    events: (db.raw.prepare('SELECT COUNT(*) c FROM capability_obligation_events').get() as { c: number }).c,
  });

  it('commits terminal + audit event + obligation atomically and links the evidence', () => {
    const { inboundSeq, opId } = seedEchoedTurn();
    const result = durability.finalizeTurnTerminal({
      ...toTurnFinalizationPersistence(replied(inboundSeq, opId)),
      capabilityDecision: decision({ sourceInboundSeq: inboundSeq }),
    });

    expect(result.applied).toBe(true);
    expect(result.capabilityDecision?.obligationId).toBeTypeOf('number');
    expect(counts()).toEqual({ terminals: 1, obligations: 1, events: 1 });

    const row = db.raw
      .prepare(
        'SELECT state, creation_evidence_event_id, creation_reason FROM capability_obligations WHERE id = ?',
      )
      .get(result.capabilityDecision!.obligationId!) as Record<string, unknown>;
    expect(row.state).toBe('waiting_capability');
    expect(row.creation_evidence_event_id).toBe(result.capabilityDecision!.eventId);
    expect(row.creation_reason).toBe('typed_deferral_signal');
  });

  it('records a not_created decision with an event and no obligation row', () => {
    const { inboundSeq, opId } = seedEchoedTurn();
    const result = durability.finalizeTurnTerminal({
      ...toTurnFinalizationPersistence(replied(inboundSeq, opId)),
      capabilityDecision: {
        auditEvent: {
          action: 'obligation.not_created',
          actorType: 'runtime',
          reasonCode: 'not_created_side_effect_uncertain',
          sourceHash: 'bb'.repeat(32),
        },
      },
    });
    expect(result.applied).toBe(true);
    expect(result.capabilityDecision).toEqual({ eventId: expect.any(Number), obligationId: null });
    expect(counts()).toEqual({ terminals: 1, obligations: 0, events: 1 });
  });

  it('FAULT: an obligation insert failure rolls back the terminal record and the audit event', () => {
    const { inboundSeq, opId } = seedEchoedTurn();
    // Violates the migration-57 group insert gate: group obligation forced to
    // waiting_capability is impossible, but a group WITHOUT a group name fails
    // store validation; use a schema-level failure instead — an is_group row
    // must be born waiting_approval, which the store derives, so trip the CHECK
    // via an invalid sha (media identity all-or-none is store-shaped, so use a
    // duplicate UNIQUE key seeded directly).
    db.raw
      .prepare(
        `INSERT INTO capability_obligations
           (source_inbound_seq, source_message_id, conversation_key, delivery_jid, sender_jid,
            is_group, scope, replay_text, contract_version, required_capability,
            capability_params, input_digest, state, creation_reason)
         VALUES (?, 'msg-obligation-1', 'ck', 'dj@lid', 'sj@s.whatsapp.net',
                 0, 'per_chat', 'x', 'test-instance/1', 'child_process_tools',
                 '{}', '${'aa'.repeat(32)}', 'waiting_capability', 'typed_deferral_signal')`,
      )
      .run(inboundSeq);
    const before = counts();

    expect(() =>
      durability.finalizeTurnTerminal({
        ...toTurnFinalizationPersistence(replied(inboundSeq, opId)),
        capabilityDecision: decision({ sourceInboundSeq: inboundSeq }),
      }),
    ).toThrow(/UNIQUE/i);

    // Full rollback: no new terminal, no new event, no new obligation.
    expect(counts()).toEqual(before);
    expect(counts().terminals).toBe(0);
  });

  it('FAULT: an audit-event failure aborts the terminal too (audit-write blocks the state change)', () => {
    const { inboundSeq, opId } = seedEchoedTurn();
    const spy = vi
      .spyOn(durability.capabilityObligations, 'appendEventWithinCallerTransaction')
      .mockImplementation(() => {
        throw new Error('injected audit failure');
      });
    expect(() =>
      durability.finalizeTurnTerminal({
        ...toTurnFinalizationPersistence(replied(inboundSeq, opId)),
        capabilityDecision: decision({ sourceInboundSeq: inboundSeq }),
      }),
    ).toThrow(/injected audit failure/);
    spy.mockRestore();
    expect(counts()).toEqual({ terminals: 0, obligations: 0, events: 0 });

    // Retry after the fault succeeds cleanly (no torn state survived).
    const result = durability.finalizeTurnTerminal({
      ...toTurnFinalizationPersistence(replied(inboundSeq, opId)),
      capabilityDecision: decision({ sourceInboundSeq: inboundSeq }),
    });
    expect(result.applied).toBe(true);
    expect(counts()).toEqual({ terminals: 1, obligations: 1, events: 1 });
  });

  it('duplicate re-finalization is read-only: no second obligation, no second event', () => {
    const { inboundSeq, opId } = seedEchoedTurn();
    const persistence = toTurnFinalizationPersistence(replied(inboundSeq, opId));
    const first = durability.finalizeTurnTerminal({
      ...persistence,
      capabilityDecision: decision({ sourceInboundSeq: inboundSeq }),
    });
    expect(first.applied).toBe(true);

    const duplicate = durability.finalizeTurnTerminal({
      ...persistence,
      capabilityDecision: decision({ sourceInboundSeq: inboundSeq }),
    });
    expect(duplicate.applied).toBe(false);
    expect(duplicate.winnerMatchesRequest).toBe(true);
    expect(duplicate.capabilityDecision).toBeUndefined();
    expect(counts()).toEqual({ terminals: 1, obligations: 1, events: 1 });
  });

  it('a group decision creates the obligation in waiting_approval', () => {
    const { inboundSeq, opId } = seedEchoedTurn();
    const result = durability.finalizeTurnTerminal({
      ...toTurnFinalizationPersistence(replied(inboundSeq, opId)),
      capabilityDecision: decision({
        sourceInboundSeq: inboundSeq,
        isGroup: true,
        groupName: 'Test Group',
        deliveryJid: 'test-group-gamma@g.us',
      }),
    });
    const state = db.raw
      .prepare('SELECT state FROM capability_obligations WHERE id = ?')
      .get(result.capabilityDecision!.obligationId!) as { state: string };
    expect(state.state).toBe('waiting_approval');
  });

  it('store methods refuse to run outside a caller-owned transaction', () => {
    expect(() =>
      durability.capabilityObligations.applyDecisionWithinCallerTransaction(decision()),
    ).toThrow(/caller-owned transaction/i);
  });

  it('rejects a malformed decision before any transaction opens', () => {
    const { inboundSeq, opId } = seedEchoedTurn();
    expect(() =>
      durability.finalizeTurnTerminal({
        ...toTurnFinalizationPersistence(replied(inboundSeq, opId)),
        capabilityDecision: {
          auditEvent: {
            action: 'obligation.not_created',
            actorType: 'runtime',
          },
          obligation: decision().obligation,
        },
      }),
    ).toThrow(/accompany exactly the create action/i);
    expect(counts()).toEqual({ terminals: 0, obligations: 0, events: 0 });
  });
});
