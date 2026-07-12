import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import {
  toTurnFinalizationPersistence,
  type TurnTerminalResult,
} from '../../src/runtimes/agent/turn-terminal.ts';

const IDENTITY = {
  scope: 'per_chat',
  conversationKey: 'conversation-atomic',
  deliveryJid: '15550100001:7@s.whatsapp.net',
  inboundSeq: 1,
  logicalTurnId: 'turn-atomic',
  managerId: 'manager-primary',
  generation: 2,
} as const;

function replied(inboundSeq: number, opId = 81): TurnTerminalResult {
  return {
    identity: { ...IDENTITY, inboundSeq },
    attemptOutcome: { kind: 'completed' },
    inboundDisposition: 'finalized_replied',
    deliveryEvidence: { kind: 'echoed', opId },
  };
}

function noReply(inboundSeq: number): TurnTerminalResult {
  return {
    identity: { ...IDENTITY, inboundSeq },
    attemptOutcome: { kind: 'suppressed_by_policy' },
    inboundDisposition: 'finalized_no_reply_policy',
    deliveryEvidence: { kind: 'none' },
  };
}

describe('atomic terminal finalization', () => {
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

  it('commits the terminal CAS, inbound disposition, and optional bookkeeping together', () => {
    const inboundSeq = durability.journalInbound(
      'message-atomic',
      IDENTITY.conversationKey,
      IDENTITY.deliveryJid,
      'agent',
    );
    const outboundId = durability.createOutboundOp({
      conversationKey: IDENTITY.conversationKey,
      chatJid: IDENTITY.deliveryJid,
      opType: 'send_text',
      payload: '{"text":"done"}',
      replayPolicy: 'safe',
      sourceInboundSeq: inboundSeq,
    });
    const sessionId = Number(db.raw.prepare(
      `INSERT INTO agent_sessions (claude_pid, started_in_directory, started_at, status)
       VALUES (?, ?, datetime('now'), 'active')`,
    ).run(111, '/tmp/atomic').lastInsertRowid);
    durability.markSending(outboundId);
    durability.markSubmitted(outboundId, 'wa-atomic');
    durability.markEchoed(outboundId);
    const execSpy = vi.spyOn(db.raw, 'exec');

    const result = durability.finalizeTurnTerminal({
      ...toTurnFinalizationPersistence(replied(inboundSeq, outboundId)),
      bookkeeping: {
        sessionTokens: { dbRowId: sessionId, inputTokens: 13, outputTokens: 5 },
        checkpoint: {
          conversationKey: IDENTITY.conversationKey,
          fields: { lastInboundSeq: inboundSeq, lastFlushedOutboundId: outboundId },
        },
      },
    });

    expect(result).toMatchObject({ applied: true, duplicateFinalizeCount: 0 });
    expect(execSpy.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN IMMEDIATE', 'COMMIT']);
    expect(durability.getTurnTerminal(inboundSeq, IDENTITY.logicalTurnId, 2)).toBeDefined();
    expect(db.raw.prepare(
      'SELECT processing_status, terminal_reason FROM inbound_events WHERE seq = ?',
    ).get(inboundSeq)).toEqual({
      processing_status: 'complete',
      terminal_reason: 'response_echoed',
    });
    expect(db.raw.prepare(
      'SELECT total_input_tokens, total_output_tokens FROM agent_sessions WHERE id = ?',
    ).get(sessionId)).toEqual({ total_input_tokens: 13, total_output_tokens: 5 });
    expect(db.raw.prepare(
      'SELECT checkpoint_version FROM session_checkpoints WHERE conversation_key = ?',
    ).get(IDENTITY.conversationKey)).toEqual({ checkpoint_version: 1 });
    expect(db.raw.prepare('SELECT is_terminal FROM outbound_ops WHERE id = ?').get(outboundId))
      .toEqual({ is_terminal: 1 });
  });

  it('records a duplicate CAS but repeats none of the selected writes', () => {
    const inboundSeq = durability.journalInbound(
      'message-duplicate',
      IDENTITY.conversationKey,
      IDENTITY.deliveryJid,
      'agent',
    );
    const firstOutbound = durability.createOutboundOp({
      conversationKey: IDENTITY.conversationKey,
      chatJid: IDENTITY.deliveryJid,
      opType: 'send_text',
      payload: '{"text":"winner"}',
      replayPolicy: 'safe',
      sourceInboundSeq: inboundSeq,
    });
    const duplicateOutbound = durability.createOutboundOp({
      conversationKey: IDENTITY.conversationKey,
      chatJid: IDENTITY.deliveryJid,
      opType: 'send_text',
      payload: '{"text":"duplicate"}',
      replayPolicy: 'safe',
      sourceInboundSeq: inboundSeq,
    });
    const sessionId = Number(db.raw.prepare(
      `INSERT INTO agent_sessions (claude_pid, started_in_directory, started_at, status)
       VALUES (?, ?, datetime('now'), 'active')`,
    ).run(222, '/tmp/duplicate').lastInsertRowid);
    const persistence = toTurnFinalizationPersistence(replied(inboundSeq, firstOutbound));
    durability.markSending(firstOutbound);
    durability.markSubmitted(firstOutbound, 'wa-duplicate-winner');
    durability.markEchoed(firstOutbound);

    durability.finalizeTurnTerminal({
      ...persistence,
      bookkeeping: {
        sessionTokens: { dbRowId: sessionId, inputTokens: 3, outputTokens: 2 },
        checkpoint: {
          conversationKey: IDENTITY.conversationKey,
          fields: { lastInboundSeq: inboundSeq },
        },
      },
    });
    const duplicate = durability.finalizeTurnTerminal({
      ...persistence,
      bookkeeping: {
        sessionTokens: { dbRowId: sessionId, inputTokens: 99, outputTokens: 88 },
        checkpoint: {
          conversationKey: IDENTITY.conversationKey,
          fields: { lastInboundSeq: inboundSeq },
        },
      },
    });

    expect(duplicate).toMatchObject({ applied: false, duplicateFinalizeCount: 1 });
    expect(db.raw.prepare(
      'SELECT total_input_tokens, total_output_tokens FROM agent_sessions WHERE id = ?',
    ).get(sessionId)).toEqual({ total_input_tokens: 3, total_output_tokens: 2 });
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM agent_token_events').get())
      .toEqual({ count: 1 });
    expect(db.raw.prepare(
      'SELECT checkpoint_version FROM session_checkpoints WHERE conversation_key = ?',
    ).get(IDENTITY.conversationKey)).toEqual({ checkpoint_version: 1 });
    expect(db.raw.prepare('SELECT is_terminal FROM outbound_ops WHERE id = ?').get(duplicateOutbound))
      .toEqual({ is_terminal: 0 });
  });

  it('rolls back the terminal winner and every earlier write, then rethrows', () => {
    const inboundSeq = durability.journalInbound(
      'message-rollback',
      IDENTITY.conversationKey,
      IDENTITY.deliveryJid,
      'agent',
    );
    const sessionId = Number(db.raw.prepare(
      `INSERT INTO agent_sessions (claude_pid, started_in_directory, started_at, status)
       VALUES (?, ?, datetime('now'), 'active')`,
    ).run(333, '/tmp/rollback').lastInsertRowid);
    db.raw.exec(`
      CREATE TRIGGER fail_atomic_token_event
      BEFORE INSERT ON agent_token_events
      BEGIN
        SELECT RAISE(ABORT, 'atomic token event denied');
      END
    `);
    const execSpy = vi.spyOn(db.raw, 'exec');

    expect(() => durability.finalizeTurnTerminal({
      ...toTurnFinalizationPersistence(noReply(inboundSeq)),
      bookkeeping: {
        sessionTokens: { dbRowId: sessionId, inputTokens: 3, outputTokens: 2 },
      },
    })).toThrow('atomic token event denied');

    expect(execSpy.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK']);
    expect(durability.getTurnTerminal(inboundSeq, IDENTITY.logicalTurnId, 2)).toBeUndefined();
    expect(db.raw.prepare('SELECT processing_status FROM inbound_events WHERE seq = ?').get(inboundSeq))
      .toEqual({ processing_status: 'processing' });
    expect(db.raw.prepare(
      'SELECT total_input_tokens, total_output_tokens FROM agent_sessions WHERE id = ?',
    ).get(sessionId)).toEqual({ total_input_tokens: 0, total_output_tokens: 0 });
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM agent_token_events').get())
      .toEqual({ count: 0 });
  });

  it('rolls back when the selected inbound row does not exist', () => {
    const missingSeq = 999;

    expect(() => durability.finalizeTurnTerminal(
      toTurnFinalizationPersistence(replied(missingSeq)),
    )).toThrow('does not exist');

    expect(durability.getTurnTerminal(missingSeq, IDENTITY.logicalTurnId, 2)).toBeUndefined();
  });

  it('rejects a companion inbound mutation for a different terminal identity', () => {
    const inboundSeq = durability.journalInbound(
      'message-mismatched',
      IDENTITY.conversationKey,
      IDENTITY.deliveryJid,
      'agent',
    );
    const persistence = toTurnFinalizationPersistence(replied(inboundSeq));

    expect(() => durability.finalizeTurnTerminal({
      ...persistence,
      inbound: { ...persistence.inbound!, seq: inboundSeq + 1 },
    })).toThrow('must match the terminal identity');
    expect(durability.getTurnTerminal(inboundSeq, IDENTITY.logicalTurnId, 2)).toBeUndefined();
  });

  it('rejects primitive bypasses that contradict the terminal disposition', () => {
    const inboundSeq = durability.journalInbound(
      'message-primitive-bypass',
      IDENTITY.conversationKey,
      IDENTITY.deliveryJid,
      'agent',
    );
    const reply = toTurnFinalizationPersistence(replied(inboundSeq));
    const noReply = toTurnFinalizationPersistence({
      ...replied(inboundSeq),
      attemptOutcome: { kind: 'suppressed_by_policy' },
      inboundDisposition: 'finalized_no_reply_policy',
      deliveryEvidence: { kind: 'none' },
    });
    const failed = toTurnFinalizationPersistence({
      ...replied(inboundSeq),
      attemptOutcome: { kind: 'failed', class: 'rate-limit' },
      inboundDisposition: 'failed_terminal',
      deliveryEvidence: { kind: 'none' },
    });
    const unfinalized = toTurnFinalizationPersistence({
      ...replied(inboundSeq),
      inboundDisposition: 'unfinalized_retry_owned',
      deliveryEvidence: { kind: 'none' },
    });

    const invalid = [
      {
        ...reply,
        inbound: { kind: 'complete', seq: inboundSeq, terminalReason: 'response_sent' },
      },
      {
        ...reply,
        inbound: { kind: 'failed', seq: inboundSeq, failureClass: 'unknown' },
      },
      {
        ...noReply,
        inbound: { kind: 'complete', seq: inboundSeq, terminalReason: 'response_echoed' },
      },
      {
        ...failed,
        inbound: { kind: 'complete', seq: inboundSeq, terminalReason: 'response_echoed' },
      },
      {
        ...failed,
        inbound: { kind: 'failed', seq: inboundSeq, failureClass: 'unknown' },
      },
      {
        ...failed,
        terminal: { ...failed.terminal, attemptFailureClass: 'unbounded-provider-class' },
      },
      {
        ...unfinalized,
        inbound: { kind: 'complete', seq: inboundSeq, terminalReason: 'response_echoed' },
      },
      {
        ...reply,
        terminal: { ...reply.terminal, deliveryKind: 'flushed' },
      },
    ] as unknown as Array<Parameters<typeof durability.finalizeTurnTerminal>[0]>;

    for (const params of invalid) {
      expect(() => durability.finalizeTurnTerminal(params)).toThrow(/[Tt]erminal/);
    }
    expect(durability.getTurnTerminal(inboundSeq, IDENTITY.logicalTurnId, 2)).toBeUndefined();
    expect(durability.getInboundStatus(inboundSeq)).toBe('processing');
  });

  it('rejects checkpoint identity mismatches before the CAS', () => {
    const inboundSeq = durability.journalInbound(
      'message-bookkeeping-bypass',
      IDENTITY.conversationKey,
      IDENTITY.deliveryJid,
      'agent',
    );
    const persistence = toTurnFinalizationPersistence(replied(inboundSeq, 81));

    expect(() => durability.finalizeTurnTerminal({
      ...persistence,
      bookkeeping: {
        checkpoint: { conversationKey: 'different-conversation', fields: {} },
      },
    })).toThrow('checkpoint conversation');
    expect(durability.getTurnTerminal(inboundSeq, IDENTITY.logicalTurnId, 2)).toBeUndefined();
  });

  it('rolls back when the selected inbound row is already terminal', () => {
    const inboundSeq = durability.journalInbound(
      'message-ineligible',
      IDENTITY.conversationKey,
      IDENTITY.deliveryJid,
      'agent',
    );
    durability.completeInbound(inboundSeq, 'prior_terminal');

    expect(() => durability.finalizeTurnTerminal(
      toTurnFinalizationPersistence(replied(inboundSeq)),
    )).toThrow('not eligible');

    expect(durability.getTurnTerminal(inboundSeq, IDENTITY.logicalTurnId, 2)).toBeUndefined();
    expect(db.raw.prepare(
      'SELECT processing_status, terminal_reason FROM inbound_events WHERE seq = ?',
    ).get(inboundSeq)).toEqual({
      processing_status: 'complete',
      terminal_reason: 'prior_terminal',
    });
  });

  it('rolls back when the selected inbound belongs to another conversation identity', () => {
    const otherSeq = durability.journalInbound(
      'message-other-conversation',
      'other-conversation',
      '15550999999@s.whatsapp.net',
      'agent',
    );

    expect(() => durability.finalizeTurnTerminal(
      toTurnFinalizationPersistence(replied(otherSeq)),
    )).toThrow('inbound identity does not match');

    expect(durability.getTurnTerminal(otherSeq, IDENTITY.logicalTurnId, 2)).toBeUndefined();
    expect(durability.getInboundStatus(otherSeq)).toBe('processing');
  });

  it('rolls back when the selected outbound belongs to another source identity', () => {
    const inboundSeq = durability.journalInbound(
      'message-outbound-mismatch',
      IDENTITY.conversationKey,
      IDENTITY.deliveryJid,
      'agent',
    );
    const wrongOutbound = durability.createOutboundOp({
      conversationKey: 'other-conversation',
      chatJid: '15550999999@s.whatsapp.net',
      opType: 'send_text',
      payload: '{"text":"wrong owner"}',
      replayPolicy: 'safe',
      sourceInboundSeq: inboundSeq + 1,
    });
    durability.markSending(wrongOutbound);
    durability.markSubmitted(wrongOutbound, 'wa-wrong-owner');
    durability.markEchoed(wrongOutbound);

    expect(() => durability.finalizeTurnTerminal(
      toTurnFinalizationPersistence(replied(inboundSeq, wrongOutbound)),
    )).toThrow('outbound identity does not match');

    expect(durability.getTurnTerminal(inboundSeq, IDENTITY.logicalTurnId, 2)).toBeUndefined();
    expect(durability.getInboundStatus(inboundSeq)).toBe('processing');
    expect(db.raw.prepare('SELECT is_terminal FROM outbound_ops WHERE id = ?').get(wrongOutbound))
      .toEqual({ is_terminal: 0 });
  });

  it('keeps the exact class in terminal truth and uses the bounded inbound taxonomy', () => {
    const inboundSeq = durability.journalInbound(
      'message-failed',
      IDENTITY.conversationKey,
      IDENTITY.deliveryJid,
      'agent',
    );
    const failed: TurnTerminalResult = {
      identity: { ...IDENTITY, inboundSeq },
      attemptOutcome: { kind: 'failed', class: 'rate-limit' },
      inboundDisposition: 'failed_terminal',
      deliveryEvidence: { kind: 'none' },
    };

    durability.finalizeTurnTerminal(toTurnFinalizationPersistence(failed));

    expect(db.raw.prepare(
      'SELECT processing_status, terminal_reason, failure_class FROM inbound_events WHERE seq = ?',
    ).get(inboundSeq)).toEqual({
      processing_status: 'failed',
      terminal_reason: 'error',
      failure_class: 'provider_failure',
    });
    expect(durability.getTurnTerminal(inboundSeq, IDENTITY.logicalTurnId, 2))
      .toMatchObject({ attempt_failure_class: 'rate-limit' });
  });

  it('persists a textless unknown terminal error without inventing a provider class', () => {
    const inboundSeq = durability.journalInbound(
      'message-unknown-terminal',
      IDENTITY.conversationKey,
      IDENTITY.deliveryJid,
      'agent',
    );
    const failed: TurnTerminalResult = {
      identity: { ...IDENTITY, inboundSeq },
      attemptOutcome: { kind: 'failed', class: 'unknown_terminal' },
      inboundDisposition: 'failed_terminal',
      deliveryEvidence: { kind: 'none' },
    };

    const receipt = durability.finalizeTurnTerminal(toTurnFinalizationPersistence(failed));

    expect(receipt).toMatchObject({ applied: true, replyGuaranteeDisarmed: false });
    expect(durability.getTurnTerminal(inboundSeq, IDENTITY.logicalTurnId, 2)).toMatchObject({
      attempt_kind: 'failed',
      attempt_failure_class: 'unknown_terminal',
    });
    expect(db.raw.prepare(
      'SELECT processing_status, failure_class FROM inbound_events WHERE seq = ?',
    ).get(inboundSeq)).toEqual({
      processing_status: 'failed',
      failure_class: 'unknown',
    });
  });

});
