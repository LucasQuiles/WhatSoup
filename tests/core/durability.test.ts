import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import type { OutboundOpParams } from '../../src/core/durability.ts';

const BASE_OP: OutboundOpParams = {
  conversationKey: 'key-1',
  chatJid: 'jid-1@s.whatsapp.net',
  opType: 'send_text',
  payload: '{"text":"hello"}',
  replayPolicy: 'safe',
};

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

  describe('sweepStaleSubmitted()', () => {
    it('returns 0 when there are no outbound ops', () => {
      expect(engine.sweepStaleSubmitted()).toBe(0);
    });

    it('returns 0 when submitted ops are recent (< 30 s)', () => {
      const id = engine.createOutboundOp(BASE_OP);
      engine.markSending(id);
      engine.markSubmitted(id, 'wa-msg-recent');
      // submitted_at just set to now — should not be swept
      expect(engine.sweepStaleSubmitted()).toBe(0);
      const row = db.raw.prepare('SELECT status FROM outbound_ops WHERE id = ?').get(id) as any;
      expect(row.status).toBe('submitted');
    });

    it('promotes a stale submitted op (> 30 s) to maybe_sent with echo_timeout error', () => {
      const id = engine.createOutboundOp(BASE_OP);
      engine.markSending(id);
      // Back-date submitted_at to 60 s ago to simulate a stale echo
      db.raw
        .prepare(
          `UPDATE outbound_ops SET status = 'submitted', wa_message_id = 'wa-stale', submitted_at = datetime('now', '-60 seconds') WHERE id = ?`,
        )
        .run(id);

      expect(engine.sweepStaleSubmitted()).toBe(1);

      const row = db.raw.prepare('SELECT status, error FROM outbound_ops WHERE id = ?').get(id) as any;
      expect(row.status).toBe('maybe_sent');
      expect(row.error).toBe('echo_timeout');
    });

    it('sweeps multiple stale ops in one call', () => {
      const ids = [0, 1, 2].map(() => {
        const id = engine.createOutboundOp(BASE_OP);
        engine.markSending(id);
        db.raw
          .prepare(
            `UPDATE outbound_ops SET status = 'submitted', submitted_at = datetime('now', '-90 seconds') WHERE id = ?`,
          )
          .run(id);
        return id;
      });

      expect(engine.sweepStaleSubmitted()).toBe(3);
      for (const id of ids) {
        const row = db.raw.prepare('SELECT status FROM outbound_ops WHERE id = ?').get(id) as any;
        expect(row.status).toBe('maybe_sent');
      }
    });

    it('only sweeps ops older than 30 s and leaves recent ones untouched', () => {
      // Stale op
      const staleId = engine.createOutboundOp(BASE_OP);
      engine.markSending(staleId);
      db.raw
        .prepare(
          `UPDATE outbound_ops SET status = 'submitted', submitted_at = datetime('now', '-31 seconds') WHERE id = ?`,
        )
        .run(staleId);

      // Recent op — submitted just now
      const recentId = engine.createOutboundOp(BASE_OP);
      engine.markSending(recentId);
      engine.markSubmitted(recentId, 'wa-new');

      expect(engine.sweepStaleSubmitted()).toBe(1);

      const staleRow = db.raw.prepare('SELECT status FROM outbound_ops WHERE id = ?').get(staleId) as any;
      expect(staleRow.status).toBe('maybe_sent');

      const recentRow = db.raw.prepare('SELECT status FROM outbound_ops WHERE id = ?').get(recentId) as any;
      expect(recentRow.status).toBe('submitted');
    });

    it('does not touch pending, sending, echoed, or already-maybe_sent ops', () => {
      const pending = engine.createOutboundOp(BASE_OP);

      const sending = engine.createOutboundOp(BASE_OP);
      engine.markSending(sending);

      const echoed = engine.createOutboundOp(BASE_OP);
      engine.markSending(echoed);
      engine.markSubmitted(echoed, 'wa-echo');
      engine.markEchoed(echoed);

      const maybeSent = engine.createOutboundOp(BASE_OP);
      engine.markMaybeSent(maybeSent, 'prior_error');

      expect(engine.sweepStaleSubmitted()).toBe(0);

      const rows = [pending, sending, echoed, maybeSent].map((id) => {
        const r = db.raw.prepare('SELECT status FROM outbound_ops WHERE id = ?').get(id) as any;
        return r.status as string;
      });
      expect(rows).toEqual(['pending', 'sending', 'echoed', 'maybe_sent']);
    });
  });
});
