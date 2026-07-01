import { afterEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import type { RecoveryStats } from '../../src/core/durability.ts';
import { canonicalizeChatJid } from '../../src/core/lid-resolver.ts';

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

describe('prepared statement caching', () => {
  const openedDbs: Database[] = [];

  afterEach(() => {
    while (openedDbs.length > 0) {
      openedDbs.pop()?.close();
    }
  });

  it('DurabilityEngine prepares fixed SQL once in the constructor and reuses them across methods', () => {
    const db = makeDb();
    openedDbs.push(db);

    const prepareSpy = vi.spyOn(db.raw, 'prepare');
    const engine = new DurabilityEngine(db);

    expect(prepareSpy).toHaveBeenCalledTimes(46);
    prepareSpy.mockClear();

    const seq = engine.journalInbound('msg-1', 'conv-1', 'jid-1@s.whatsapp.net', 'agent');
    engine.markTurnDone(seq);
    engine.markInboundComplete(seq, 'response_sent');

    const failedSeq = engine.journalInbound('msg-2', 'conv-1', 'jid-1@s.whatsapp.net', 'agent');
    engine.markInboundFailed(failedSeq);

    const skippedSeq = engine.journalInbound('msg-3', 'conv-1', 'jid-1@s.whatsapp.net', 'agent');
    engine.markInboundSkipped(skippedSeq, 'duplicate');

    const completeSeq = engine.journalInbound('msg-4', 'conv-1', 'jid-1@s.whatsapp.net', 'agent');
    engine.completeInbound(completeSeq, 'response_sent');

    const outboundId = engine.createOutboundOp({
      conversationKey: 'conv-1',
      chatJid: 'jid-1@s.whatsapp.net',
      opType: 'text',
      payload: '{"text":"hello"}',
      replayPolicy: 'safe',
    });
    engine.markSending(outboundId);
    engine.markSubmitted(outboundId, 'wa-1');
    engine.matchEcho('wa-1');

    const maybeSentId = engine.createOutboundOp({
      conversationKey: 'conv-2',
      chatJid: 'jid-2@s.whatsapp.net',
      opType: 'text',
      payload: '{"text":"later"}',
      replayPolicy: 'unsafe',
    });
    engine.markMaybeSent(maybeSentId, 'network_down');

    const failedOpId = engine.createOutboundOp({
      conversationKey: 'conv-3',
      chatJid: 'jid-3@s.whatsapp.net',
      opType: 'text',
      payload: '{"text":"boom"}',
      replayPolicy: 'unsafe',
    });
    engine.markFailedPermanent(failedOpId, 'fatal');

    const quarantinedOpId = engine.createOutboundOp({
      conversationKey: 'conv-4',
      chatJid: 'jid-4@s.whatsapp.net',
      opType: 'text',
      payload: '{"text":"hold"}',
      replayPolicy: 'read_only',
    });
    engine.markQuarantined(quarantinedOpId);
    engine.markTerminal(quarantinedOpId);

    const toolCallId = engine.recordToolCall('conv-1', 'send_message', '{"text":"hi"}', 'unsafe');
    engine.markToolExecuting(toolCallId);
    engine.markToolComplete(toolCallId, '{"sent":true}');

    engine.upsertSessionCheckpoint('conv-1', { sessionId: 'sess-1', sessionStatus: 'active' });
    engine.getSessionCheckpoint('conv-1');
    engine.getAllActiveCheckpoints();
    engine.getResumableCheckpoints();
    engine.markSessionOrphaned('conv-1');
    engine.getPendingInbound();
    engine.getOutboundByStatus('pending');
    // Insert a dummy agent_sessions row so insertTokenEvent FK constraint is satisfied.
    // Use exec (not prepare) to avoid triggering the prepareSpy.
    db.raw.exec(
      `INSERT INTO agent_sessions (id, claude_pid, started_in_directory, started_at, status)
       VALUES (999, 0, '/tmp', datetime('now'), 'active')`,
    );
    engine.completeTurn({
      sessionTokens: {
        dbRowId: 999,
        inputTokens: 1,
        outputTokens: 2,
      },
      checkpoint: {
        conversationKey: 'conv-1',
        fields: {
          activeTurnId: null,
          lastInboundSeq: completeSeq,
          lastFlushedOutboundId: quarantinedOpId,
        },
      },
      inbound: {
        seq: completeSeq,
        terminalReason: 'response_sent',
      },
      lastOpId: quarantinedOpId,
    });

    engine.preConnectRecovery();
    engine.postConnectRecovery();
    engine.sweepStaleSubmitted();
    engine.getHealthStats();

    const emptyStats: RecoveryStats = {
      inboundReplayed: 0,
      outboundReconciled: 0,
      outboundReplayed: 0,
      outboundQuarantined: 0,
      toolCallsRecovered: 0,
      toolCallsReplayed: 0,
      toolCallsQuarantined: 0,
      sessionsRestored: 0,
    };
    engine.logRecoveryRun('manual', emptyStats);

    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it('canonicalizeChatJid caches the LID lookup statement per database instance', () => {
    const db1 = makeDb();
    const db2 = makeDb();
    openedDbs.push(db1, db2);

    db1.raw.prepare(
      `INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, datetime('now'))`,
    ).run('12345', '15551234567@s.whatsapp.net');

    db2.raw.prepare(
      `INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, datetime('now'))`,
    ).run('99999', '18889999999@s.whatsapp.net');

    const prepareSpy1 = vi.spyOn(db1.raw, 'prepare');
    expect(canonicalizeChatJid('12345@lid', db1)).toBe('15551234567@s.whatsapp.net');
    expect(canonicalizeChatJid('12345:77@lid', db1)).toBe('15551234567@s.whatsapp.net');
    expect(prepareSpy1).toHaveBeenCalledTimes(1);

    const prepareSpy2 = vi.spyOn(db2.raw, 'prepare');
    expect(canonicalizeChatJid('99999@lid', db2)).toBe('18889999999@s.whatsapp.net');
    expect(canonicalizeChatJid('99999:42@lid', db2)).toBe('18889999999@s.whatsapp.net');
    expect(prepareSpy2).toHaveBeenCalledTimes(1);
  });
});
