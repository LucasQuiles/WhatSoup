import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import { storeMessageIfNew } from '../../src/core/messages.ts';
import { processHistoryBatch } from '../../src/core/history-sync.ts';
import { upsertLidMapping } from '../../src/core/lid-resolver.ts';
import { canonicalConversationKey } from '../../src/core/access-list.ts';

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
    { name: 'peer placeholder upgraded to self', initialFromMe: false, bodyFromMe: true, placeholder: true, status: 'echoed' },
    { name: 'unknown placeholder upgraded to self', initialFromMe: undefined, bodyFromMe: true, placeholder: true, status: 'echoed' },
    { name: 'self placeholder upgraded to peer', initialFromMe: true, bodyFromMe: false, placeholder: true, status: 'quarantined' },
    { name: 'existing peer body preserved against self history', initialFromMe: false, bodyFromMe: true, placeholder: false, status: 'quarantined' },
    { name: 'existing self body preserved against peer history', initialFromMe: true, bodyFromMe: false, placeholder: false, status: 'echoed' },
  ] as const)('$name retains the full message authorship', ({ initialFromMe, bodyFromMe, placeholder, status }) => {
    const chatJid = 'peer@s.whatsapp.net';
    const conversationKey = canonicalConversationKey(chatJid, db);
    const seq = engine.journalInbound('request', conversationKey, chatJid, 'agent');
    const op = engine.createOutboundOp({
      conversationKey, chatJid, opType: 'text', payload: '{"text":"answer"}',
      replayPolicy: 'safe', sourceInboundSeq: seq, isTerminal: true,
    });
    expect(engine.markSending(op)).toBe(true);
    expect(engine.markMaybeSent(op, 'transport interrupted', 'receipt')).toBe(true);
    expect(processHistoryBatch(db, [{
      key: { id: 'receipt', remoteJid: chatJid, ...(initialFromMe === undefined ? {} : { fromMe: initialFromMe }) },
      messageTimestamp: 1,
      ...(placeholder ? {} : { message: { conversation: 'original body' } }),
    }])).toMatchObject({ placeholders: placeholder ? 1 : 0, inserted: placeholder ? 0 : 1, failed: 0 });
    expect(processHistoryBatch(db, [{
      key: { id: 'receipt', remoteJid: chatJid, fromMe: bodyFromMe },
      messageTimestamp: 2,
      message: { conversation: 'full history body' },
    }])).toMatchObject({ upgraded: placeholder ? 1 : 0, failed: 0 });

    let recovery;
    if (phase === 'startup') {
      db.close();
      db = new Database(join(directory, 'test.db'));
      db.open();
      engine = new DurabilityEngine(db);
      recovery = engine.postConnectRecovery();
    } else {
      db.raw.prepare("UPDATE outbound_ops SET ambiguity_at = datetime('now', '-60 seconds') WHERE id = ?").run(op);
      recovery = engine.reconcileLiveMaybeSent();
    }

    expect(db.raw.prepare('SELECT status FROM outbound_ops WHERE id = ?').get(op)).toEqual({ status });
    expect(engine.getInboundStatus(seq)).toBe(status === 'echoed' ? 'complete' : 'processing');
    expect(recovery.outboundReplayed).toBe(0);
    expect(recovery.outboundQuarantined).toBe(status === 'quarantined' ? 1 : 0);
    expect(db.raw.prepare('SELECT content, content_type, is_from_me FROM messages WHERE message_id = ?').get('receipt')).toEqual({
      content: placeholder ? 'full history body' : 'original body',
      content_type: 'text',
      is_from_me: (placeholder ? bodyFromMe : initialFromMe) ? 1 : 0,
    });
  });

  it.each(['safe', 'unsafe'] as const)('recovers a %s send after the same chat gains a phone mapping', (replayPolicy) => {
    const chatJid = 'peer-a@lid';
    const op = engine.createOutboundOp({
      conversationKey: 'peer-a', chatJid, opType: 'text',
      payload: '{"text":"answer"}', replayPolicy,
    });
    expect(engine.markSending(op)).toBe(true);
    expect(engine.markMaybeSent(op, 'transport interrupted', 'mapped-receipt')).toBe(true);
    upsertLidMapping(db, 'peer-a', '15550000003@s.whatsapp.net');
    expect(processHistoryBatch(db, [{
      key: { id: 'mapped-receipt', remoteJid: chatJid, fromMe: true },
      messageTimestamp: 1, message: { conversation: 'answer' },
    }])).toMatchObject({ inserted: 1, failed: 0 });
    expect(db.raw.prepare('SELECT conversation_key FROM messages WHERE message_id = ?').get('mapped-receipt'))
      .toEqual({ conversation_key: '15550000003' });

    let recovery;
    if (phase === 'startup') {
      db.close();
      db = new Database(join(directory, 'test.db'));
      db.open();
      engine = new DurabilityEngine(db);
      recovery = engine.postConnectRecovery();
    } else {
      db.raw.prepare("UPDATE outbound_ops SET ambiguity_at = datetime('now', '-60 seconds') WHERE id = ?").run(op);
      recovery = engine.reconcileLiveMaybeSent();
    }

    expect(db.raw.prepare('SELECT status FROM outbound_ops WHERE id = ?').get(op)).toEqual({ status: 'echoed' });
    expect(recovery.outboundReplayed).toBe(0);
    expect(recovery.outboundQuarantined).toBe(0);
  });

  it.each([
    { name: 'peer row cannot confirm an unsafe send', isFromMe: false, replayPolicy: 'unsafe', status: 'quarantined', chatJid: 'peer@signal', contentType: 'text', storedId: 'receipt' },
    { name: 'peer row blocks safe replay', isFromMe: false, replayPolicy: 'safe', status: 'quarantined', chatJid: 'peer@s.whatsapp.net', contentType: 'text', storedId: 'receipt' },
    { name: 'peer row blocks read-only replay', isFromMe: false, replayPolicy: 'read_only', status: 'quarantined', chatJid: 'peer@imessage', contentType: 'text', storedId: 'receipt' },
    { name: 'self row confirms the matching send', isFromMe: true, replayPolicy: 'unsafe', status: 'echoed', chatJid: 'peer@signal', contentType: 'text', storedId: 'receipt' },
    { name: 'self history confirms the matching send', isFromMe: true, replayPolicy: 'safe', status: 'echoed', chatJid: 'peer@s.whatsapp.net', contentType: 'history', storedId: 'receipt' },
    { name: 'peer history cannot confirm the matching send', isFromMe: false, replayPolicy: 'unsafe', status: 'quarantined', chatJid: 'peer@s.whatsapp.net', contentType: 'history', storedId: 'receipt' },
    { name: 'peer history blocks safe replay', isFromMe: false, replayPolicy: 'safe', status: 'quarantined', chatJid: 'peer@s.whatsapp.net', contentType: 'history', storedId: 'receipt' },
    { name: 'peer history blocks read-only replay', isFromMe: false, replayPolicy: 'read_only', status: 'quarantined', chatJid: 'peer@s.whatsapp.net', contentType: 'history', storedId: 'receipt' },
    { name: 'absent matching ID preserves safe replay', isFromMe: false, replayPolicy: 'safe', status: 'pending', chatJid: 'peer@signal', contentType: 'text', storedId: 'different-receipt' },
    { name: 'absent matching ID preserves read-only replay', isFromMe: true, replayPolicy: 'read_only', status: 'pending', chatJid: 'peer@imessage', contentType: 'text', storedId: 'different-receipt' },
    { name: 'self row with a different ID does not confirm the send', isFromMe: true, replayPolicy: 'unsafe', status: 'quarantined', chatJid: 'peer@imessage', contentType: 'text', storedId: 'different-receipt' },
  ] as const)('$name', ({ isFromMe, replayPolicy, status, chatJid, contentType, storedId }) => {
    const conversationKey = canonicalConversationKey(chatJid, db);
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

    let recovery;
    if (phase === 'startup') {
      db.close();
      db = new Database(join(directory, 'test.db'));
      db.open();
      engine = new DurabilityEngine(db);
      recovery = engine.postConnectRecovery();
    } else {
      // Move only the ambiguity clock beyond the live loop's late-echo grace.
      db.raw.prepare("UPDATE outbound_ops SET ambiguity_at = datetime('now', '-60 seconds') WHERE id = ?").run(op);
      recovery = engine.reconcileLiveMaybeSent();
    }

    expect(db.raw.prepare('SELECT status FROM outbound_ops WHERE id = ?').get(op)).toEqual({ status });
    expect(engine.getInboundStatus(seq)).toBe(status === 'echoed' ? 'complete' : 'processing');
    expect(recovery.outboundReplayed).toBe(status === 'pending' ? 1 : 0);
    expect(recovery.outboundQuarantined).toBe(status === 'quarantined' ? 1 : 0);
  });

  // The lookup is bound to the send's chat, so a row in another chat never confirms it.
  // That row still occupies the provider ID, so it is conflicting evidence, not
  // permission to replay, whoever authored it.
  it.each([
    { replayPolicy: 'safe', isFromMe: false },
    { replayPolicy: 'safe', isFromMe: true },
    { replayPolicy: 'read_only', isFromMe: false },
    { replayPolicy: 'read_only', isFromMe: true },
  ] as const)('a $replayPolicy send whose ID another chat holds is quarantined, not replayed (self row: $isFromMe)', ({ replayPolicy, isFromMe }) => {
    const chatJid = 'peer@s.whatsapp.net';
    const otherChatJid = 'other-peer@s.whatsapp.net';
    const conversationKey = canonicalConversationKey(chatJid, db);
    const seq = engine.journalInbound('request', conversationKey, chatJid, 'agent');
    const op = engine.createOutboundOp({
      conversationKey, chatJid, opType: 'text', payload: '{"text":"answer"}',
      replayPolicy, sourceInboundSeq: seq, isTerminal: true,
    });
    expect(engine.markSending(op)).toBe(true);
    expect(engine.markMaybeSent(op, 'transport interrupted', 'receipt')).toBe(true);
    expect(storeMessageIfNew(db, {
      chatJid: otherChatJid, conversationKey: canonicalConversationKey(otherChatJid, db),
      senderJid: isFromMe ? 'self' : otherChatJid, messageId: 'receipt', isFromMe,
      timestamp: 1, contentType: 'text', content: 'answer',
    })).toBe(true);

    let recovery;
    if (phase === 'startup') {
      db.close();
      db = new Database(join(directory, 'test.db'));
      db.open();
      engine = new DurabilityEngine(db);
      recovery = engine.postConnectRecovery();
    } else {
      db.raw.prepare("UPDATE outbound_ops SET ambiguity_at = datetime('now', '-60 seconds') WHERE id = ?").run(op);
      recovery = engine.reconcileLiveMaybeSent();
    }

    expect(db.raw.prepare('SELECT status FROM outbound_ops WHERE id = ?').get(op)).toEqual({ status: 'quarantined' });
    expect(engine.getInboundStatus(seq)).toBe('processing');
    expect(recovery.outboundReplayed).toBe(0);
    expect(recovery.outboundQuarantined).toBe(1);
    expect(db.raw.prepare('SELECT chat_jid, is_from_me FROM messages WHERE message_id = ?').get('receipt'))
      .toEqual({ chat_jid: otherChatJid, is_from_me: isFromMe ? 1 : 0 });
  });
});
