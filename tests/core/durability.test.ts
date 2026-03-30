import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';

describe('DurabilityEngine', () => {
  let db: Database;
  let engine: DurabilityEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    engine = new DurabilityEngine(db);
  });

  afterEach(() => { db.close(); });

  describe('inbound_events', () => {
    it('journalInbound creates a row with processing status', () => {
      const seq = engine.journalInbound('msg-1', 'key-1', 'jid-1@s.whatsapp.net', 'agent');
      expect(seq).toBeGreaterThan(0);
      const row = db.raw.prepare('SELECT * FROM inbound_events WHERE seq = ?').get(seq) as any;
      expect(row.processing_status).toBe('processing');
      expect(row.routed_to).toBe('agent');
    });

    it('markTurnDone transitions processing → turn_done', () => {
      const seq = engine.journalInbound('msg-1', 'key-1', 'jid-1', 'agent');
      engine.markTurnDone(seq);
      const row = db.raw.prepare('SELECT processing_status FROM inbound_events WHERE seq = ?').get(seq) as any;
      expect(row.processing_status).toBe('turn_done');
    });

    it('markInboundComplete transitions turn_done → complete', () => {
      const seq = engine.journalInbound('msg-1', 'key-1', 'jid-1', 'agent');
      engine.markTurnDone(seq);
      engine.markInboundComplete(seq, 'response_sent');
      const row = db.raw.prepare('SELECT * FROM inbound_events WHERE seq = ?').get(seq) as any;
      expect(row.processing_status).toBe('complete');
      expect(row.terminal_reason).toBe('response_sent');
      expect(row.completed_at).not.toBeNull();
    });

    it('duplicate message_id is rejected', () => {
      engine.journalInbound('msg-1', 'key-1', 'jid-1', 'agent');
      expect(() => engine.journalInbound('msg-1', 'key-1', 'jid-1', 'agent')).toThrow();
    });
  });

  describe('outbound_ops', () => {
    it('createOutboundOp returns id with pending status', () => {
      const id = engine.createOutboundOp({
        conversationKey: 'key-1',
        chatJid: 'jid-1',
        opType: 'text',
        payload: '{"text":"hello"}',
        replayPolicy: 'unsafe',
      });
      expect(id).toBeGreaterThan(0);
      const row = db.raw.prepare('SELECT * FROM outbound_ops WHERE id = ?').get(id) as any;
      expect(row.status).toBe('pending');
      expect(row.replay_policy).toBe('unsafe');
    });

    it('markSending transitions pending → sending', () => {
      const id = engine.createOutboundOp({ conversationKey: 'k', chatJid: 'j', opType: 'text', payload: '{}', replayPolicy: 'unsafe' });
      engine.markSending(id);
      const row = db.raw.prepare('SELECT status FROM outbound_ops WHERE id = ?').get(id) as any;
      expect(row.status).toBe('sending');
    });

    it('markSubmitted records wa_message_id and transitions to submitted', () => {
      const id = engine.createOutboundOp({ conversationKey: 'k', chatJid: 'j', opType: 'text', payload: '{}', replayPolicy: 'unsafe' });
      engine.markSending(id);
      engine.markSubmitted(id, 'WA_MSG_123');
      const row = db.raw.prepare('SELECT * FROM outbound_ops WHERE id = ?').get(id) as any;
      expect(row.status).toBe('submitted');
      expect(row.wa_message_id).toBe('WA_MSG_123');
    });

    it('markEchoed transitions submitted → echoed and completes linked inbound', () => {
      const seq = engine.journalInbound('msg-1', 'key-1', 'jid-1', 'agent');
      const id = engine.createOutboundOp({ conversationKey: 'key-1', chatJid: 'jid-1', opType: 'text', payload: '{}', replayPolicy: 'unsafe', sourceInboundSeq: seq, isTerminal: true });
      engine.markSending(id);
      engine.markSubmitted(id, 'WA_MSG_1');
      engine.markTurnDone(seq);
      engine.markEchoed(id);
      const outRow = db.raw.prepare('SELECT status FROM outbound_ops WHERE id = ?').get(id) as any;
      expect(outRow.status).toBe('echoed');
      const inRow = db.raw.prepare('SELECT processing_status FROM inbound_events WHERE seq = ?').get(seq) as any;
      expect(inRow.processing_status).toBe('complete');
    });

    it('markMaybeSent transitions sending → maybe_sent', () => {
      const id = engine.createOutboundOp({ conversationKey: 'k', chatJid: 'j', opType: 'text', payload: '{}', replayPolicy: 'unsafe' });
      engine.markSending(id);
      engine.markMaybeSent(id, 'EPIPE');
      const row = db.raw.prepare('SELECT * FROM outbound_ops WHERE id = ?').get(id) as any;
      expect(row.status).toBe('maybe_sent');
      expect(row.error).toBe('EPIPE');
    });
  });
});
