/**
 * W2 (b) — sweepStuckInbound reconciler.
 *
 * preConnectRecovery only runs at process start. Rows that get stranded WHILE the
 * process is live (an inbound whose reply was echoed but whose completion never
 * ran; a turn_done that never finalized; an open row whose turn silently died with
 * no successful reply) stay in a non-terminal processing_status indefinitely, so
 * retention (which deletes only complete/failed) never reclaims them.
 *
 * sweepStuckInbound runs on a slow interval and reconciles three buckets:
 *   1. open (pending/processing/turn_done) with an echoed terminal op, older than
 *      5 minutes  → complete, terminal_reason='recovered_response_sent'
 *   2. turn_done older than 24h with no echoed terminal op
 *      → complete, terminal_reason='recovered_turn_done'
 *   3. pending/processing older than 24h with no echoed terminal op
 *      → failed, terminal_reason='error'
 * The 5-minute / 24h grace windows keep it from racing normal in-flight delivery.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';

describe('sweepStuckInbound — live stuck-inbound reconciler (W2b)', () => {
  let db: Database;
  let engine: DurabilityEngine;
  beforeEach(() => { db = new Database(':memory:'); db.open(); engine = new DurabilityEngine(db); });
  afterEach(() => { db.close(); });

  const status = (seq: number) =>
    (db.raw.prepare('SELECT processing_status FROM inbound_events WHERE seq = ?').get(seq) as { processing_status: string }).processing_status;
  const reason = (seq: number) =>
    (db.raw.prepare('SELECT terminal_reason FROM inbound_events WHERE seq = ?').get(seq) as { terminal_reason: string | null }).terminal_reason;
  const backdate = (seq: number, interval: string) =>
    db.raw.prepare(`UPDATE inbound_events SET received_at = datetime('now', ?) WHERE seq = ?`).run(interval, seq);

  // Set an op to echoed WITHOUT triggering markEchoed's inbound auto-completion,
  // reproducing the QR-102 strand: op echoed+terminal, linked inbound still open.
  const forceEchoedTerminalOp = (conversationKey: string, chatJid: string, seq: number): number => {
    const opId = engine.createOutboundOp({
      conversationKey, chatJid, opType: 'text',
      payload: '{"text":"reply"}', replayPolicy: 'safe', sourceInboundSeq: seq, isTerminal: true,
    });
    db.raw.prepare(`UPDATE outbound_ops SET status = 'echoed', echoed_at = datetime('now') WHERE id = ?`).run(opId);
    return opId;
  };

  it('completes a stale processing inbound whose terminal op is echoed (recovered_response_sent)', () => {
    const seq = engine.journalInbound('m1', 'k1', 'j1@s.whatsapp.net', 'agent');
    forceEchoedTerminalOp('k1', 'j1@s.whatsapp.net', seq);
    backdate(seq, '-2 days');
    expect(status(seq)).toBe('processing');

    const res = engine.sweepStuckInbound();

    expect(status(seq)).toBe('complete');
    expect(reason(seq)).toBe('recovered_response_sent');
    expect(res).toEqual({ completedEchoed: 1, completedTurnDone: 0, failedStale: 0 });
  });

  it('leaves a fresh (<5 min) open inbound with an echoed terminal op untouched', () => {
    const seq = engine.journalInbound('m2', 'k2', 'j2@s.whatsapp.net', 'agent');
    forceEchoedTerminalOp('k2', 'j2@s.whatsapp.net', seq);
    // received_at defaults to now → still inside the 5-minute grace window.

    const res = engine.sweepStuckInbound();

    expect(status(seq)).toBe('processing');
    expect(res).toEqual({ completedEchoed: 0, completedTurnDone: 0, failedStale: 0 });
  });

  it('completes a stale turn_done inbound with no outbound op (recovered_turn_done)', () => {
    const seq = engine.journalInbound('m3', 'k3', 'j3@s.whatsapp.net', 'agent');
    engine.markTurnDone(seq);
    backdate(seq, '-25 hours');

    const res = engine.sweepStuckInbound();

    expect(status(seq)).toBe('complete');
    expect(reason(seq)).toBe('recovered_turn_done');
    expect(res).toEqual({ completedEchoed: 0, completedTurnDone: 1, failedStale: 0 });
  });

  it('fails a stale processing inbound with no outbound op (error)', () => {
    const seq = engine.journalInbound('m4', 'k4', 'j4@s.whatsapp.net', 'agent');
    backdate(seq, '-25 hours');

    const res = engine.sweepStuckInbound();

    expect(status(seq)).toBe('failed');
    expect(reason(seq)).toBe('error');
    expect(res).toEqual({ completedEchoed: 0, completedTurnDone: 0, failedStale: 1 });
  });

  it('fails a stale processing inbound whose only terminal op is quarantined', () => {
    const seq = engine.journalInbound('m5', 'k5', 'j5@s.whatsapp.net', 'agent');
    const opId = engine.createOutboundOp({
      conversationKey: 'k5', chatJid: 'j5@s.whatsapp.net', opType: 'text',
      payload: '{"text":"reply"}', replayPolicy: 'unsafe', sourceInboundSeq: seq, isTerminal: true,
    });
    engine.markQuarantined(opId); // not an echoed success → row must fail
    backdate(seq, '-25 hours');

    const res = engine.sweepStuckInbound();

    expect(status(seq)).toBe('failed');
    expect(reason(seq)).toBe('error');
    expect(res).toEqual({ completedEchoed: 0, completedTurnDone: 0, failedStale: 1 });
  });

  it('leaves an open inbound younger than 24h with no op untouched', () => {
    const seq = engine.journalInbound('m6', 'k6', 'j6@s.whatsapp.net', 'agent'); // fresh processing

    const res = engine.sweepStuckInbound();

    expect(status(seq)).toBe('processing');
    expect(res).toEqual({ completedEchoed: 0, completedTurnDone: 0, failedStale: 0 });
  });

  it('a second sweep makes no further changes (idempotent)', () => {
    const echoedSeq = engine.journalInbound('m7a', 'k7a', 'j7a@s.whatsapp.net', 'agent');
    forceEchoedTerminalOp('k7a', 'j7a@s.whatsapp.net', echoedSeq);
    backdate(echoedSeq, '-2 days');

    const turnDoneSeq = engine.journalInbound('m7b', 'k7b', 'j7b@s.whatsapp.net', 'agent');
    engine.markTurnDone(turnDoneSeq);
    backdate(turnDoneSeq, '-25 hours');

    const failSeq = engine.journalInbound('m7c', 'k7c', 'j7c@s.whatsapp.net', 'agent');
    backdate(failSeq, '-25 hours');

    const first = engine.sweepStuckInbound();
    expect(first).toEqual({ completedEchoed: 1, completedTurnDone: 1, failedStale: 1 });

    const second = engine.sweepStuckInbound();
    expect(second).toEqual({ completedEchoed: 0, completedTurnDone: 0, failedStale: 0 });
  });

  it('does not re-touch rows already finalized by preConnectRecovery', () => {
    const seq = engine.journalInbound('m8', 'k8', 'j8@s.whatsapp.net', 'agent');
    engine.markTurnDone(seq);
    engine.preConnectRecovery(); // finalizes the stranded turn_done to complete
    expect(status(seq)).toBe('complete');
    expect(reason(seq)).toBe('recovered_turn_done');

    const res = engine.sweepStuckInbound();

    expect(res).toEqual({ completedEchoed: 0, completedTurnDone: 0, failedStale: 0 });
    expect(status(seq)).toBe('complete');
    expect(reason(seq)).toBe('recovered_turn_done'); // unchanged
  });
});
