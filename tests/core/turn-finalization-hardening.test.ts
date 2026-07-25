import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/core/database.ts';
import {
  DurabilityEngine,
  type FinalizeTurnTerminalParams,
} from '../../src/core/durability.ts';
import {
  toTurnFinalizationPersistence,
  toTurnRecoveryJobPersistence,
  type DeliveryEvidence,
  type InboundDisposition,
  type RecoveryOwnerIdentity,
  type TurnTerminalResult,
} from '../../src/runtimes/agent/turn-terminal.ts';

type OutboundStatus = 'pending' | 'submitted' | 'echoed' | 'maybe_sent';

const CONVERSATION_KEY = 'conversation-proof';
const DELIVERY_JID = '15550100001:7@s.whatsapp.net';

describe('turn finalization proof boundary', () => {
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

  function journal(suffix: string): number {
    return durability.journalInbound(
      `message-${suffix}`,
      CONVERSATION_KEY,
      DELIVERY_JID,
      'agent',
    );
  }

  function result(
    inboundSeq: number,
    deliveryEvidence: DeliveryEvidence,
    inboundDisposition: InboundDisposition = 'unfinalized_retry_owned',
  ): TurnTerminalResult {
    return {
      identity: {
        scope: 'per_chat',
        conversationKey: CONVERSATION_KEY,
        deliveryJid: DELIVERY_JID,
        inboundSeq,
        logicalTurnId: `turn-${inboundSeq}`,
        managerId: 'manager-proof',
        generation: 2,
      },
      attemptOutcome: inboundDisposition === 'finalized_replied'
        ? { kind: 'completed' }
        : { kind: 'failed', class: 'transient-network' },
      inboundDisposition,
      deliveryEvidence,
    };
  }

  function outbound(inboundSeq: number, status: OutboundStatus): number {
    const id = durability.createOutboundOp({
      conversationKey: CONVERSATION_KEY,
      chatJid: DELIVERY_JID,
      opType: 'send_text',
      payload: '{"text":"proof"}',
      replayPolicy: 'safe',
      sourceInboundSeq: inboundSeq,
    });
    if (status === 'submitted' || status === 'echoed') {
      durability.markSending(id);
      durability.markSubmitted(id, `wa-${id}`);
    }
    if (status === 'echoed') durability.markEchoed(id);
    if (status === 'maybe_sent') durability.markMaybeSent(id, 'delivery uncertain');
    return id;
  }

  function transferParams(inboundSeq: number, suffix: string): FinalizeTurnTerminalParams {
    const owner: RecoveryOwnerIdentity = {
      logicalTurnId: `recovery-${suffix}`,
      managerId: 'manager-recovery',
      generation: 3,
    };
    const deliveryOpId = outbound(inboundSeq, 'pending');
    const terminalResult: TurnTerminalResult = {
      ...result(inboundSeq, { kind: 'enqueued', opId: deliveryOpId }, 'transferred_to_recovery_owner'),
      identity: {
        ...result(inboundSeq, { kind: 'enqueued', opId: deliveryOpId }).identity,
        logicalTurnId: `turn-transfer-${suffix}`,
      },
    };
    const replay = {
      sourceMessageId: `message-${suffix}`,
      receivedAtUnixSeconds: 1_780_000_000,
      replaySafe: true,
      senderJid: '15550100002:9@s.whatsapp.net',
      senderName: 'Recovery Sender',
      text: `exact replay ${suffix}`,
      isGroup: false,
    };
    return {
      ...toTurnFinalizationPersistence(terminalResult, owner),
      recoveryJob: toTurnRecoveryJobPersistence(terminalResult, owner, replay),
    };
  }

  function inboundState(inboundSeq: number) {
    return db.raw.prepare(
      `SELECT processing_status, terminal_reason, failure_class,
              continuity_candidate_reason, continuity_candidate_source
       FROM inbound_events WHERE seq = ?`,
    ).get(inboundSeq);
  }

  it.each([
    ['enqueued', 'pending'],
    ['flushed', 'submitted'],
    ['delivery_unknown', 'maybe_sent'],
  ] as const)(
    'accepts %s only with durable outbound status %s and derives an armed record',
    (deliveryKind, status) => {
      const inboundSeq = journal(`${deliveryKind}-accepted`);
      const opId = outbound(inboundSeq, status);
      const persistence = toTurnFinalizationPersistence(result(
        inboundSeq,
        { kind: deliveryKind, opId },
      ));

      const receipt = durability.finalizeTurnTerminal({
        ...persistence,
        terminal: { ...persistence.terminal, replyGuaranteeDisarmed: true },
      });

      expect(receipt).toMatchObject({ applied: true, replyGuaranteeDisarmed: false });
      expect(durability.getTurnTerminal(inboundSeq, `turn-${inboundSeq}`, 2))
        .toMatchObject({ reply_guarantee_disarmed: 0 });
      expect(db.raw.prepare('SELECT is_terminal FROM outbound_ops WHERE id = ?').get(opId))
        .toEqual({ is_terminal: 1 });
      expect(durability.getInboundStatus(inboundSeq)).toBe('processing');
    },
  );

  it('requires durable echoed status, derives disarm, and marks the evidence op terminal', () => {
    const inboundSeq = journal('echoed-accepted');
    const opId = outbound(inboundSeq, 'echoed');
    const persistence = toTurnFinalizationPersistence(result(
      inboundSeq,
      { kind: 'echoed', opId },
      'finalized_replied',
    ));

    const receipt = durability.finalizeTurnTerminal({
      ...persistence,
      terminal: { ...persistence.terminal, replyGuaranteeDisarmed: false },
    });

    expect(receipt).toMatchObject({ applied: true, replyGuaranteeDisarmed: true });
    expect(db.raw.prepare('SELECT is_terminal FROM outbound_ops WHERE id = ?').get(opId))
      .toEqual({ is_terminal: 1 });
    expect(db.raw.prepare(
      'SELECT processing_status, terminal_reason FROM inbound_events WHERE seq = ?',
    ).get(inboundSeq)).toEqual({
      processing_status: 'complete',
      terminal_reason: 'response_echoed',
    });
  });

  it.each(['markEchoed', 'markTerminal'] as const)(
    'does not let legacy %s re-complete an inbound owned by a terminal record',
    (operation) => {
      const inboundSeq = journal(`owned-${operation}`);
      const opId = outbound(inboundSeq, 'echoed');
      durability.finalizeTurnTerminal(toTurnFinalizationPersistence(result(
        inboundSeq,
        { kind: 'echoed', opId },
        'finalized_replied',
      )));
      db.raw.prepare(
        `UPDATE inbound_events
         SET processing_status = 'processing', terminal_reason = NULL, completed_at = NULL
         WHERE seq = ?`,
      ).run(inboundSeq);

      durability[operation](opId);

      expect(db.raw.prepare(
        'SELECT processing_status, terminal_reason FROM inbound_events WHERE seq = ?',
      ).get(inboundSeq)).toEqual({
        processing_status: 'processing',
        terminal_reason: null,
      });
    },
  );

  it.each(['markEchoed', 'markTerminal'] as const)(
    'fences legacy %s by inbound ownership when a different op follows a no-op transfer',
    (operation) => {
      const suffix = `cross-op-${operation}`;
      const inboundSeq = journal(suffix);
      durability.finalizeTurnTerminal(transferParams(inboundSeq, suffix));
      const legacyOpId = durability.createOutboundOp({
        conversationKey: CONVERSATION_KEY,
        chatJid: DELIVERY_JID,
        opType: 'send_text',
        payload: '{"text":"late legacy reply"}',
        replayPolicy: 'safe',
        sourceInboundSeq: inboundSeq,
      });
      durability.markSending(legacyOpId);
      durability.markSubmitted(legacyOpId, `wa-${suffix}`);

      if (operation === 'markEchoed') {
        durability.markTerminal(legacyOpId);
        durability.markEchoed(legacyOpId);
      } else {
        durability.markEchoed(legacyOpId);
        durability.markTerminal(legacyOpId);
      }

      expect(inboundState(inboundSeq)).toMatchObject({
        processing_status: 'processing',
        terminal_reason: null,
      });
    },
  );

  it.each(['terminal-before-echo', 'echo-before-terminal'] as const)(
    'preserves legacy inbound completion for unowned outbound: %s',
    (ordering) => {
      const inboundSeq = journal(`legacy-${ordering}`);
      const opId = durability.createOutboundOp({
        conversationKey: CONVERSATION_KEY,
        chatJid: DELIVERY_JID,
        opType: 'send_text',
        payload: '{"text":"legacy"}',
        replayPolicy: 'safe',
        sourceInboundSeq: inboundSeq,
      });
      durability.markSending(opId);
      durability.markSubmitted(opId, `wa-legacy-${ordering}`);
      if (ordering === 'terminal-before-echo') {
        durability.markTerminal(opId);
        durability.markEchoed(opId);
      } else {
        durability.markEchoed(opId);
        durability.markTerminal(opId);
      }

      expect(db.raw.prepare(
        'SELECT processing_status, terminal_reason FROM inbound_events WHERE seq = ?',
      ).get(inboundSeq)).toEqual({
        processing_status: 'complete',
        terminal_reason: 'response_sent',
      });
    },
  );

  it('accepts none only with a null op ID', () => {
    const inboundSeq = journal('none-accepted');
    const terminalResult: TurnTerminalResult = {
      ...result(inboundSeq, { kind: 'none' }),
      attemptOutcome: { kind: 'suppressed_by_policy' },
      inboundDisposition: 'finalized_no_reply_policy',
    };

    expect(durability.finalizeTurnTerminal(
      toTurnFinalizationPersistence(terminalResult),
    )).toMatchObject({ applied: true, replyGuaranteeDisarmed: true });
  });

  it.each([
    { deliveryKind: 'none', deliveryOpId: 1 },
    { deliveryKind: 'echoed', deliveryOpId: null },
    { deliveryKind: 'enqueued', deliveryOpId: 0 },
  ])('rejects incoherent delivery primitive %#', ({ deliveryKind, deliveryOpId }) => {
    const inboundSeq = journal(`shape-${deliveryKind}`);
    const persistence = toTurnFinalizationPersistence(result(
      inboundSeq,
      { kind: 'delivery_unknown', opId: 91 },
    ));

    expect(() => durability.finalizeTurnTerminal({
      ...persistence,
      terminal: { ...persistence.terminal, deliveryKind, deliveryOpId },
    })).toThrow('delivery evidence');
    expect(durability.getTurnTerminal(inboundSeq, `turn-${inboundSeq}`, 2)).toBeUndefined();
  });

  it.each(['pending', 'submitted', 'maybe_sent'] as const)(
    'rejects %s outbound status as echoed proof',
    (status) => {
      const inboundSeq = journal(`false-echo-${status}`);
      const opId = outbound(inboundSeq, status);

      expect(() => durability.finalizeTurnTerminal(toTurnFinalizationPersistence(result(
        inboundSeq,
        { kind: 'echoed', opId },
        'finalized_replied',
      )))).toThrow('does not prove echoed');

      expect(durability.getTurnTerminal(inboundSeq, `turn-${inboundSeq}`, 2)).toBeUndefined();
      expect(durability.getInboundStatus(inboundSeq)).toBe('processing');
      expect(db.raw.prepare('SELECT is_terminal FROM outbound_ops WHERE id = ?').get(opId))
        .toEqual({ is_terminal: 0 });
    },
  );

  it('rejects missing delivery op even when the primitive claims echoed', () => {
    const inboundSeq = journal('missing-op');

    expect(() => durability.finalizeTurnTerminal(toTurnFinalizationPersistence(result(
      inboundSeq,
      { kind: 'echoed', opId: 999 },
      'finalized_replied',
    )))).toThrow('delivery outbound op does not exist');
    expect(durability.getTurnTerminal(inboundSeq, `turn-${inboundSeq}`, 2)).toBeUndefined();
  });

  it('validates delivery-op identity without optional bookkeeping', () => {
    const inboundSeq = journal('op-identity');
    const opId = durability.createOutboundOp({
      conversationKey: 'other-conversation',
      chatJid: DELIVERY_JID,
      opType: 'send_text',
      payload: '{}',
      replayPolicy: 'safe',
      sourceInboundSeq: inboundSeq,
    });
    durability.markSending(opId);
    durability.markSubmitted(opId, 'wa-other');
    durability.markEchoed(opId);

    expect(() => durability.finalizeTurnTerminal(toTurnFinalizationPersistence(result(
      inboundSeq,
      { kind: 'echoed', opId },
      'finalized_replied',
    )))).toThrow('outbound identity does not match');
  });

  it('exposes a narrow identity-validated outbound delivery snapshot for runtime evidence', () => {
    const inboundSeq = journal('delivery-snapshot');
    const opId = outbound(inboundSeq, 'pending');
    const identity = {
      conversationKey: CONVERSATION_KEY,
      deliveryJid: DELIVERY_JID,
      sourceInboundSeq: inboundSeq,
    };

    expect(durability.getOutboundDeliverySnapshot(opId, identity)).toEqual({
      opId,
      ...identity,
      status: 'pending',
    });
    durability.markSending(opId);
    expect(durability.getOutboundDeliverySnapshot(opId, identity)?.status).toBe('sending');
    durability.markSubmitted(opId, 'wa-delivery-snapshot');
    expect(durability.getOutboundDeliverySnapshot(opId, identity)?.status).toBe('submitted');
    durability.markEchoed(opId);
    const echoed = durability.getOutboundDeliverySnapshot(opId, identity);
    expect(echoed?.status).toBe('echoed');
    expect(echoed).not.toHaveProperty('payload');
    expect(echoed).not.toHaveProperty('waMessageId');

    expect(() => durability.getOutboundDeliverySnapshot(opId, {
      ...identity,
      deliveryJid: 'different@s.whatsapp.net',
    })).toThrow('identity does not match');
    expect(durability.getOutboundDeliverySnapshot(999_999, identity)).toBeUndefined();
  });

  it('derives checkpoint terminal fields from identity and proven evidence', () => {
    const inboundSeq = journal('checkpoint-derived');
    const opId = outbound(inboundSeq, 'echoed');

    durability.finalizeTurnTerminal({
      ...toTurnFinalizationPersistence(result(
        inboundSeq,
        { kind: 'echoed', opId },
        'finalized_replied',
      )),
      bookkeeping: {
        checkpoint: {
          conversationKey: CONVERSATION_KEY,
          fields: { watchdogState: 'healthy' },
        },
      },
    });

    expect(db.raw.prepare(
      `SELECT active_turn_id, last_inbound_seq, last_flushed_outbound_id,
              completed_inbound_seq, completed_delivery_jid,
              completed_delivery_namespace, completed_scope,
              completed_logical_turn_id, completed_manager_id, completed_generation
       FROM session_checkpoints WHERE conversation_key = ?`,
    ).get(CONVERSATION_KEY)).toEqual({
      active_turn_id: null,
      last_inbound_seq: inboundSeq,
      last_flushed_outbound_id: opId,
      completed_inbound_seq: inboundSeq,
      completed_delivery_jid: DELIVERY_JID,
      completed_delivery_namespace: 's.whatsapp.net',
      completed_scope: 'per_chat',
      completed_logical_turn_id: `turn-${inboundSeq}`,
      completed_manager_id: 'manager-proof',
      completed_generation: 2,
    });
  });

  it('keeps open transfer and retry turns from replacing completed resume identity', () => {
    const completedInbound = journal('checkpoint-completed-proof');
    const completedOp = outbound(completedInbound, 'echoed');
    durability.finalizeTurnTerminal({
      ...toTurnFinalizationPersistence(result(
        completedInbound,
        { kind: 'echoed', opId: completedOp },
        'finalized_replied',
      )),
      bookkeeping: {
        checkpoint: { conversationKey: CONVERSATION_KEY, fields: {} },
      },
    });

    const transferInbound = journal('checkpoint-open-transfer');
    durability.finalizeTurnTerminal({
      ...transferParams(transferInbound, 'checkpoint-open-transfer'),
      bookkeeping: {
        checkpoint: { conversationKey: CONVERSATION_KEY, fields: {} },
      },
    });

    const retryInbound = journal('checkpoint-open-retry');
    durability.finalizeTurnTerminal({
      ...toTurnFinalizationPersistence(result(
        retryInbound,
        { kind: 'none' },
        'unfinalized_retry_owned',
      )),
      bookkeeping: {
        checkpoint: { conversationKey: CONVERSATION_KEY, fields: {} },
      },
    });

    expect(db.raw.prepare(`
      SELECT last_inbound_seq, completed_inbound_seq,
             completed_logical_turn_id, completed_manager_id, completed_generation
      FROM session_checkpoints WHERE conversation_key = ?
    `).get(CONVERSATION_KEY)).toEqual({
      last_inbound_seq: retryInbound,
      completed_inbound_seq: completedInbound,
      completed_logical_turn_id: `turn-${completedInbound}`,
      completed_manager_id: 'manager-proof',
      completed_generation: 2,
    });
  });

  it.each([
    { activeTurnId: 'another-turn' },
    { lastInboundSeq: 999 },
    { lastFlushedOutboundId: 999 },
  ])('rejects contradictory checkpoint terminal fields %#', (fields) => {
    const inboundSeq = journal(`checkpoint-reject-${Object.keys(fields)[0]}`);
    const opId = outbound(inboundSeq, 'echoed');

    expect(() => durability.finalizeTurnTerminal({
      ...toTurnFinalizationPersistence(result(
        inboundSeq,
        { kind: 'echoed', opId },
        'finalized_replied',
      )),
      bookkeeping: {
        checkpoint: { conversationKey: CONVERSATION_KEY, fields },
      },
    })).toThrow('checkpoint');
    expect(durability.getTurnTerminal(inboundSeq, `turn-${inboundSeq}`, 2)).toBeUndefined();
  });

  it.each([
    { completedDeliveryJid: 'wrong@s.whatsapp.net' },
    { completedDeliveryNamespace: 'lid' },
    { completedScope: 'shared' as const },
    { completedLogicalTurnId: 'wrong-turn' },
    { completedManagerId: 'wrong-manager' },
    { completedGeneration: 3 },
  ])('rejects contradictory completed identity field %#', (fields) => {
    const inboundSeq = journal(`completed-identity-${Object.keys(fields)[0]}`);
    const opId = outbound(inboundSeq, 'echoed');

    expect(() => durability.finalizeTurnTerminal({
      ...toTurnFinalizationPersistence(result(
        inboundSeq,
        { kind: 'echoed', opId },
        'finalized_replied',
      )),
      bookkeeping: {
        checkpoint: { conversationKey: CONVERSATION_KEY, fields },
      },
    })).toThrow(/checkpoint.*identity/i);
    expect(durability.getTurnTerminal(inboundSeq, `turn-${inboundSeq}`, 2)).toBeUndefined();
  });

  it.each([
    ['unsupported namespace', 'status@broadcast'],
    ['multiple separators', 'a@b@lid'],
  ])('rejects terminal delivery identity with %s', (_name, deliveryJid) => {
    const inboundSeq = durability.journalInbound(
      `message-invalid-delivery-${_name.replaceAll(' ', '-')}`,
      CONVERSATION_KEY,
      deliveryJid,
      'agent',
    );
    const base = result(inboundSeq, { kind: 'none' });
    const params = toTurnFinalizationPersistence({
      ...base,
      identity: {
        ...base.identity,
        deliveryJid,
      },
      attemptOutcome: { kind: 'suppressed_by_policy' },
      inboundDisposition: 'finalized_no_reply_policy',
    });

    expect(() => durability.finalizeTurnTerminal(params)).toThrow(/delivery|namespace/i);
    expect(durability.getTurnTerminal(inboundSeq, `turn-${inboundSeq}`, 2)).toBeUndefined();
  });

  it('does not expose raw terminal CAS or standalone recovery enqueue writes', () => {
    expect('recordTurnTerminal' in durability).toBe(false);
    expect('enqueueTurnRecoveryJob' in durability).toBe(false);
  });

  it('rejects malformed primitive terminal identity and attempt axes', () => {
    const inboundSeq = journal('primitive-identity');
    const base = toTurnFinalizationPersistence({
      ...result(inboundSeq, { kind: 'none' }),
      attemptOutcome: { kind: 'suppressed_by_policy' },
      inboundDisposition: 'finalized_no_reply_policy',
    });
    const mutations: Array<(params: FinalizeTurnTerminalParams) => FinalizeTurnTerminalParams> = [
      (params) => ({ ...params, terminal: { ...params.terminal, scope: 'invalid' } }),
      (params) => ({
        ...params,
        terminal: { ...params.terminal, conversationKey: 42 as never },
      }),
      (params) => ({ ...params, terminal: { ...params.terminal, conversationKey: '\t\n' } }),
      (params) => ({ ...params, terminal: { ...params.terminal, deliveryJid: ' ' } }),
      (params) => ({ ...params, terminal: { ...params.terminal, logicalTurnId: '' } }),
      (params) => ({ ...params, terminal: { ...params.terminal, managerId: 'x'.repeat(2049) } }),
      (params) => ({ ...params, terminal: { ...params.terminal, inboundSeq: 0 } }),
      (params) => ({ ...params, terminal: { ...params.terminal, generation: 0 } }),
      (params) => ({
        ...params,
        terminal: { ...params.terminal, attemptFailureClass: 'rate-limit' },
      }),
      (params) => ({ ...params, terminal: { ...params.terminal, attemptKind: 'unknown-kind' } }),
    ];

    for (const mutate of mutations) {
      expect(() => durability.finalizeTurnTerminal(mutate(base))).toThrow(/Terminal/);
    }
    expect(durability.getTurnTerminal(inboundSeq, `turn-${inboundSeq}`, 2)).toBeUndefined();
  });

  it.each(['finalized_no_reply_policy', 'failed_terminal'] as const)(
    'rejects raw delivery_unknown paired with %s',
    (inboundDisposition) => {
      const inboundSeq = journal(`unknown-${inboundDisposition}`);
      const opId = outbound(inboundSeq, 'maybe_sent');
      const base = inboundDisposition === 'failed_terminal'
        ? toTurnFinalizationPersistence({
          ...result(inboundSeq, { kind: 'none' }),
          attemptOutcome: { kind: 'failed', class: 'rate-limit' },
          inboundDisposition,
        })
        : toTurnFinalizationPersistence({
          ...result(inboundSeq, { kind: 'none' }),
          attemptOutcome: { kind: 'suppressed_by_policy' },
          inboundDisposition,
        });

      expect(() => durability.finalizeTurnTerminal({
        ...base,
        terminal: {
          ...base.terminal,
          deliveryKind: 'delivery_unknown',
          deliveryOpId: opId,
        },
      })).toThrow('bounded retry owner');
    },
  );

  it('rejects deprecated bookkeeping op selection instead of trusting it', () => {
    const inboundSeq = journal('deprecated-last-op');
    const opId = outbound(inboundSeq, 'echoed');
    const params = toTurnFinalizationPersistence(result(
      inboundSeq,
      { kind: 'echoed', opId },
      'finalized_replied',
    ));

    expect(() => durability.finalizeTurnTerminal({
      ...params,
      bookkeeping: { lastOpId: opId } as never,
    })).toThrow('derives its terminal op');
    expect(durability.getTurnTerminal(inboundSeq, `turn-${inboundSeq}`, 2)).toBeUndefined();
    expect(db.raw.prepare('SELECT is_terminal FROM outbound_ops WHERE id = ?').get(opId))
      .toEqual({ is_terminal: 0 });
  });

  it.each(['replied', 'no_reply', 'failed'] as const)(
    'gates duplicate %s receipts on an exact winner payload',
    (kind) => {
      const inboundSeq = journal(`duplicate-${kind}`);
      let terminalResult: TurnTerminalResult;
      let conflictingResult: TurnTerminalResult;
      if (kind === 'replied') {
        const opId = outbound(inboundSeq, 'echoed');
        const conflictingOpId = outbound(inboundSeq, 'echoed');
        terminalResult = result(
          inboundSeq,
          { kind: 'echoed', opId },
          'finalized_replied',
        );
        conflictingResult = result(
          inboundSeq,
          { kind: 'echoed', opId: conflictingOpId },
          'finalized_replied',
        );
      } else if (kind === 'no_reply') {
        terminalResult = {
          ...result(inboundSeq, { kind: 'none' }),
          attemptOutcome: { kind: 'suppressed_by_policy' },
          inboundDisposition: 'finalized_no_reply_policy',
        };
        conflictingResult = {
          ...result(inboundSeq, { kind: 'none' }),
          attemptOutcome: { kind: 'failed', class: 'rate-limit' },
          inboundDisposition: 'failed_terminal',
        };
      } else {
        terminalResult = {
          ...result(inboundSeq, { kind: 'none' }),
          attemptOutcome: { kind: 'failed', class: 'rate-limit' },
          inboundDisposition: 'failed_terminal',
        };
        conflictingResult = {
          ...result(inboundSeq, { kind: 'none' }),
          attemptOutcome: { kind: 'suppressed_by_policy' },
          inboundDisposition: 'finalized_no_reply_policy',
        };
      }
      const params = toTurnFinalizationPersistence(terminalResult);
      const expectedDisarmed = kind !== 'failed';

      expect(durability.finalizeTurnTerminal(params)).toMatchObject({
        applied: true,
        winnerMatchesRequest: true,
        replyGuaranteeDisarmed: expectedDisarmed,
        effectiveReplyGuaranteeDisarmed: expectedDisarmed,
      });
      expect(durability.finalizeTurnTerminal(params)).toMatchObject({
        applied: false,
        winnerMatchesRequest: true,
        duplicateFinalizeCount: 1,
        replyGuaranteeDisarmed: expectedDisarmed,
        effectiveReplyGuaranteeDisarmed: expectedDisarmed,
      });
      expect(durability.finalizeTurnTerminal(
        toTurnFinalizationPersistence(conflictingResult),
      )).toMatchObject({
        applied: false,
        winnerMatchesRequest: false,
        duplicateFinalizeCount: 2,
        replyGuaranteeDisarmed: false,
        effectiveReplyGuaranteeDisarmed: false,
      });
      expect(durability.getTurnTerminal(inboundSeq, `turn-${inboundSeq}`, 2))
        .toMatchObject({
          inbound_disposition: params.terminal.inboundDisposition,
          delivery_op_id: params.terminal.deliveryOpId,
          duplicate_finalize_count: 2,
        });
    },
  );

  it('deduplicates a null-inbound terminal winner at the durable CAS boundary', () => {
    const terminalResult: TurnTerminalResult = {
      ...result(1, { kind: 'none' }),
      identity: {
        ...result(1, { kind: 'none' }).identity,
        inboundSeq: null,
        logicalTurnId: 'turn-null-inbound',
      },
      attemptOutcome: { kind: 'suppressed_by_policy' },
      inboundDisposition: 'finalized_no_reply_policy',
    };
    const params = toTurnFinalizationPersistence(terminalResult);

    const first = durability.finalizeTurnTerminal(params);
    const duplicate = durability.finalizeTurnTerminal(params);

    expect(first).toMatchObject({ applied: true, replyGuaranteeDisarmed: true });
    expect(duplicate).toMatchObject({
      applied: false,
      recordId: first.recordId,
      duplicateFinalizeCount: 1,
      replyGuaranteeDisarmed: true,
      effectiveReplyGuaranteeDisarmed: true,
    });
  });

  it('treats the same inbound and logical turn in a later generation as a new winner', () => {
    const inboundSeq = journal('later-generation');
    const terminalResult: TurnTerminalResult = {
      ...result(inboundSeq, { kind: 'none' }),
      inboundDisposition: 'unfinalized_retry_owned',
    };
    const firstParams = toTurnFinalizationPersistence(terminalResult);
    const laterParams = toTurnFinalizationPersistence({
      ...terminalResult,
      identity: { ...terminalResult.identity, generation: 3 },
    });

    const first = durability.finalizeTurnTerminal(firstParams);
    const later = durability.finalizeTurnTerminal(laterParams);

    expect(first).toMatchObject({ applied: true, duplicateFinalizeCount: 0 });
    expect(later).toMatchObject({ applied: true, duplicateFinalizeCount: 0 });
    expect(later.recordId).not.toBe(first.recordId);
    expect(durability.finalizeTurnTerminal(firstParams)).toMatchObject({
      applied: false,
      recordId: first.recordId,
      duplicateFinalizeCount: 1,
    });
  });

  it('keeps all restart heuristics away from terminal-record-owned inbounds', () => {
    const noOpProcessing = journal('restart-transfer-processing');
    durability.finalizeTurnTerminal(transferParams(
      noOpProcessing,
      'restart-transfer-processing',
    ));

    const noOpTurnDone = journal('restart-transfer-turn-done');
    durability.markTurnDone(noOpTurnDone);
    durability.finalizeTurnTerminal(transferParams(
      noOpTurnDone,
      'restart-transfer-turn-done',
    ));

    const deliveredRetry = journal('restart-delivered-retry');
    const deliveredOpId = outbound(deliveredRetry, 'maybe_sent');
    durability.finalizeTurnTerminal(toTurnFinalizationPersistence(result(
      deliveredRetry,
      { kind: 'delivery_unknown', opId: deliveredOpId },
      'unfinalized_retry_owned',
    )));
    db.raw.prepare(
      "UPDATE outbound_ops SET status = 'echoed', echoed_at = datetime('now') WHERE id = ?",
    ).run(deliveredOpId);

    durability.preConnectRecovery();

    expect(inboundState(noOpProcessing)).toMatchObject({
      processing_status: 'processing',
      terminal_reason: null,
      failure_class: null,
      continuity_candidate_reason: null,
    });
    expect(inboundState(noOpTurnDone)).toMatchObject({
      processing_status: 'turn_done',
      terminal_reason: null,
    });
    expect(inboundState(deliveredRetry)).toMatchObject({
      processing_status: 'processing',
      terminal_reason: null,
    });
  });

  it('does not stamp a continuity candidate after a terminal record owns the inbound', () => {
    const inboundSeq = journal('continuity-transfer');
    durability.finalizeTurnTerminal(transferParams(inboundSeq, 'continuity-transfer'));

    expect(durability.markContinuityCandidateIfNoTerminalOutbound(
      inboundSeq,
      'runtime_fault_no_terminal_outbound',
      'runtime_fault_disarm',
    )).toBe(false);
    expect(inboundState(inboundSeq)).toMatchObject({
      continuity_candidate_reason: null,
      continuity_candidate_source: null,
    });
  });

  it('excludes terminal-record-owned inbounds from every stuck-sweep bucket', () => {
    const echoedRetry = journal('sweep-echoed-retry');
    const echoedOpId = outbound(echoedRetry, 'maybe_sent');
    durability.finalizeTurnTerminal(toTurnFinalizationPersistence(result(
      echoedRetry,
      { kind: 'delivery_unknown', opId: echoedOpId },
      'unfinalized_retry_owned',
    )));
    db.raw.prepare(
      "UPDATE outbound_ops SET status = 'echoed', echoed_at = datetime('now') WHERE id = ?",
    ).run(echoedOpId);

    const staleTurnDone = journal('sweep-transfer-turn-done');
    durability.markTurnDone(staleTurnDone);
    durability.finalizeTurnTerminal(transferParams(
      staleTurnDone,
      'sweep-transfer-turn-done',
    ));

    const staleProcessing = journal('sweep-transfer-processing');
    durability.finalizeTurnTerminal(transferParams(
      staleProcessing,
      'sweep-transfer-processing',
    ));
    db.raw.prepare(
      "UPDATE inbound_events SET received_at = datetime('now', '-2 days') WHERE seq IN (?, ?, ?)",
    ).run(echoedRetry, staleTurnDone, staleProcessing);

    expect(durability.sweepStuckInbound()).toEqual({
      completedEchoed: 0,
      completedTurnDone: 0,
      failedStale: 0,
      reclaimedRecoveryOwned: 0,
    });
    expect(inboundState(echoedRetry)).toMatchObject({ processing_status: 'processing' });
    expect(inboundState(staleTurnDone)).toMatchObject({ processing_status: 'turn_done' });
    expect(inboundState(staleProcessing)).toMatchObject({ processing_status: 'processing' });
  });
});
