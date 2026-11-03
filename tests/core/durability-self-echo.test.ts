import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import { storeMessageIfNew } from '../../src/core/messages.ts';
import { processHistoryBatch } from '../../src/core/history-sync.ts';

describe.each(['startup', 'live'] as const)('%s stored echo reconciliation', (phase) => {
  let directory: string;
  let db: Database;
  let engine: DurabilityEngine;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'durability-self-echo-'));
    db = new Database(join(directory, 'test.db'));
    db.open();
    engine = new DurabilityEngine(db);
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it.each([
    { name: 'peer row cannot confirm an unsafe send', isFromMe: false, replayPolicy: 'unsafe', status: 'quarantined', chatJid: 'peer@signal', contentType: 'text', storedId: 'receipt' },
    { name: 'peer row preserves safe replay policy', isFromMe: false, replayPolicy: 'safe', status: 'pending', chatJid: 'peer@s.whatsapp.net', contentType: 'text', storedId: 'receipt' },
    { name: 'peer row preserves read-only replay policy', isFromMe: false, replayPolicy: 'read_only', status: 'pending', chatJid: 'peer@imessage', contentType: 'text', storedId: 'receipt' },
    { name: 'self row confirms the matching send', isFromMe: true, replayPolicy: 'unsafe', status: 'echoed', chatJid: 'peer@signal', contentType: 'text', storedId: 'receipt' },
    { name: 'self history confirms the matching send', isFromMe: true, replayPolicy: 'safe', status: 'echoed', chatJid: 'peer@s.whatsapp.net', contentType: 'history', storedId: 'receipt' },
    { name: 'peer history cannot confirm the matching send', isFromMe: false, replayPolicy: 'unsafe', status: 'quarantined', chatJid: 'peer@s.whatsapp.net', contentType: 'history', storedId: 'receipt' },
    { name: 'self row with a different ID does not confirm the send', isFromMe: true, replayPolicy: 'unsafe', status: 'quarantined', chatJid: 'peer@imessage', contentType: 'text', storedId: 'different-receipt' },
  ] as const)('$name', ({ isFromMe, replayPolicy, status, chatJid, contentType, storedId }) => {
    const conversationKey = 'conversation';
    const seq = engine.journalInbound('request', conversationKey, chatJid, 'agent');
    const op = engine.createOutboundOp({
      conversationKey, chatJid, opType: 'text', payload: '{"text":"answer"}',
      replayPolicy, sourceInboundSeq: seq, isTerminal: true,
    });
    expect(engine.markSending(op)).toBe(true);
    expect(engine.markMaybeSent(op, 'transport interrupted', 'receipt')).toBe(true);
    if (contentType === 'history') {
      expect(processHistoryBatch(db, [{
        key: { id: storedId, remoteJid: chatJid, fromMe: isFromMe },
        messageTimestamp: 1,
      }])).toMatchObject({ placeholders: 1, failed: 0 });
    } else {
      expect(storeMessageIfNew(db, {
        chatJid, conversationKey, senderJid: isFromMe ? 'self' : chatJid,
        messageId: storedId, isFromMe, timestamp: 1, contentType, content: 'answer',
      })).toBe(true);
    }

    if (phase === 'startup') {
      db.close();
      db = new Database(join(directory, 'test.db'));
      db.open();
      engine = new DurabilityEngine(db);
      engine.postConnectRecovery();
    } else {
      // Move only the ambiguity clock beyond the live loop's late-echo grace.
      db.raw.prepare("UPDATE outbound_ops SET ambiguity_at = datetime('now', '-60 seconds') WHERE id = ?").run(op);
      engine.reconcileLiveMaybeSent();
    }

    expect(db.raw.prepare('SELECT status FROM outbound_ops WHERE id = ?').get(op)).toEqual({ status });
    expect(engine.getInboundStatus(seq)).toBe(status === 'echoed' ? 'complete' : 'processing');
  });
});
