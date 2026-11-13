/**
 * QR-035 — preConnectRecovery Step 4 reconciled only `processing` inbound events
 * (getProcessingInboundEvents). The lifecycle is processing → turn_done →
 * complete, so a crash in the markTurnDone..markInboundComplete window strands a
 * row at `turn_done` — never reconciled to a terminal status, and retention
 * (which deletes only complete/failed) never reclaims it → unbounded growth.
 *
 * A stranded turn_done can finish as no-reply only when no terminal outbound
 * exists. An attempted reply retains its delivery obligation; failed delivery
 * requires operator recovery. turn_done remains a live transient state.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';

describe('preConnectRecovery — stranded turn_done reconciliation (QR-035)', () => {
  let db: Database;
  let engine: DurabilityEngine;
  beforeEach(() => { db = new Database(':memory:'); db.open(); engine = new DurabilityEngine(db); });
  afterEach(() => { db.close(); });

  const status = (seq: number) =>
    (db.raw.prepare('SELECT processing_status FROM inbound_events WHERE seq = ?').get(seq) as { processing_status: string }).processing_status;

  it('finalizes a stranded turn_done inbound to complete', () => {
    const seq = engine.journalInbound('m1', 'k1', 'j1@s.whatsapp.net', 'agent');
    engine.markTurnDone(seq); // crash before markInboundComplete
    expect(status(seq)).toBe('turn_done');

    engine.preConnectRecovery();

    expect(status(seq)).toBe('complete');
  });

  it('records a recovery terminal_reason on the finalized row', () => {
    const seq = engine.journalInbound('m2', 'k2', 'j2@s.whatsapp.net', 'agent');
    engine.markTurnDone(seq);
    engine.preConnectRecovery();
    const row = db.raw.prepare('SELECT terminal_reason FROM inbound_events WHERE seq = ?').get(seq) as { terminal_reason: string | null };
    expect(row.terminal_reason).toBe('recovered_turn_done');
  });

  it('still marks a stranded processing inbound (no terminal op) as failed (no regression)', () => {
    const seq = engine.journalInbound('m3', 'k3', 'j3@s.whatsapp.net', 'agent');
    // left at 'processing' (crash mid-turn, no markTurnDone)
    engine.preConnectRecovery();
    expect(status(seq)).toBe('failed');
  });

  it('LEAVES a turn_done inbound that has a terminal outbound op (postConnect resolves it after delivery)', () => {
    const seq = engine.journalInbound('m5', 'k5', 'j5@s.whatsapp.net', 'agent');
    engine.markTurnDone(seq);
    const opId = engine.createOutboundOp({
      conversationKey: 'k5', chatJid: 'j5@s.whatsapp.net', opType: 'text',
      payload: '{"text":"reply"}', replayPolicy: 'safe', sourceInboundSeq: seq, isTerminal: true,
    });
    engine.markSending(opId);
    engine.markSubmitted(opId, 'WA-1');

    engine.preConnectRecovery();

    // Not prematurely completed — its reply is still unconfirmed; postConnect owns it.
    expect(status(seq)).toBe('turn_done');
  });

  it('does not touch an already-complete inbound', () => {
    const seq = engine.journalInbound('m4', 'k4', 'j4@s.whatsapp.net', 'agent');
    engine.markTurnDone(seq);
    engine.markInboundComplete(seq, 'response_sent');
    engine.preConnectRecovery();
    expect(status(seq)).toBe('complete');
  });

  it.each(['quarantined', 'failed_permanent'] as const)('does not mistake a %s reply for a no-reply turn', (deliveryStatus) => {
    const seq = engine.journalInbound('failed-reply', 'conversation', 'peer@s.whatsapp.net', 'chat');
    const op = engine.createOutboundOp({
      conversationKey: 'conversation', chatJid: 'peer@s.whatsapp.net', opType: 'text',
      payload: '{"text":"reply"}', replayPolicy: 'unsafe', sourceInboundSeq: seq, isTerminal: true,
    });
    engine.markTurnDone(seq);
    if (deliveryStatus === 'quarantined') engine.markQuarantined(op);
    else engine.markFailedPermanent(op, 'rejected');

    engine.preConnectRecovery();

    expect(status(seq)).toBe('failed');
    expect(db.raw.prepare('SELECT terminal_reason, failure_class FROM inbound_events WHERE seq = ?').get(seq))
      .toEqual({ terminal_reason: 'error', failure_class: 'transport_send_failed' });
    expect(db.raw.prepare('SELECT status FROM outbound_ops WHERE id = ?').get(op)).toEqual({ status: deliveryStatus });
    expect(db.raw.prepare('SELECT disposition FROM inbound_disposition_links WHERE inbound_seq = ?').all(seq))
      .toEqual([{ disposition: 'recovery_pending_operator_catchup' }]);
    expect(engine.preConnectRecovery().outboundReplayed).toBe(0);
    expect(status(seq)).toBe('failed');
  });

  it.each(['complete', 'failed'] as const)('late turn completion cannot reopen a %s inbound', (terminalStatus) => {
    const seq = engine.journalInbound('terminal', 'conversation', 'peer@s.whatsapp.net', 'chat');
    if (terminalStatus === 'complete') engine.completeInbound(seq, 'response_sent');
    else engine.markInboundFailed(seq, 'stale_reclaim');
    const before = db.raw.prepare('SELECT * FROM inbound_events WHERE seq = ?').get(seq);

    engine.markTurnDone(seq);

    expect(db.raw.prepare('SELECT * FROM inbound_events WHERE seq = ?').get(seq)).toEqual(before);
  });

  it('retains active delivery ownership when an earlier terminal attempt failed', () => {
    const seq = engine.journalInbound('multiple-attempts', 'conversation', 'peer@s.whatsapp.net', 'chat');
    const params = {
      conversationKey: 'conversation', chatJid: 'peer@s.whatsapp.net', opType: 'text' as const,
      replayPolicy: 'unsafe' as const, sourceInboundSeq: seq, isTerminal: true,
    };
    const rejected = engine.createOutboundOp({ ...params, payload: '{"text":"first"}' });
    engine.markFailedPermanent(rejected, 'rejected');
    const active = engine.createOutboundOp({ ...params, payload: '{"text":"second"}' });
    engine.markSending(active);
    engine.markSubmitted(active, 'active-receipt');
    engine.markTurnDone(seq);

    engine.preConnectRecovery();
    expect(status(seq)).toBe('turn_done');
    expect(db.raw.prepare('SELECT disposition FROM inbound_disposition_links WHERE inbound_seq = ?').all(seq)).toEqual([]);
    engine.matchEcho('active-receipt');
    engine.preConnectRecovery();
    expect(status(seq)).toBe('complete');
  });

  it('keeps the inbound open when operator recovery evidence cannot be persisted', () => {
    const seq = engine.journalInbound('evidence-fault', 'conversation', 'peer@s.whatsapp.net', 'chat');
    const op = engine.createOutboundOp({
      conversationKey: 'conversation', chatJid: 'peer@s.whatsapp.net', opType: 'text',
      payload: '{"text":"reply"}', replayPolicy: 'unsafe', sourceInboundSeq: seq, isTerminal: true,
    });
    engine.markTurnDone(seq);
    engine.markQuarantined(op);
    db.raw.exec(`CREATE TRIGGER reject_catchup BEFORE INSERT ON inbound_disposition_links
      BEGIN SELECT RAISE(ABORT, 'injected evidence fault'); END`);

    expect(() => engine.preConnectRecovery()).toThrow('injected evidence fault');
    expect(status(seq)).toBe('turn_done');
    expect(db.raw.prepare('SELECT status FROM outbound_ops WHERE id = ?').get(op)).toEqual({ status: 'quarantined' });
    db.raw.exec('DROP TRIGGER reject_catchup');

    engine.preConnectRecovery();
    engine.preConnectRecovery();
    expect(status(seq)).toBe('failed');
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM inbound_disposition_links WHERE inbound_seq = ?').get(seq))
      .toEqual({ count: 1 });
  });
});
