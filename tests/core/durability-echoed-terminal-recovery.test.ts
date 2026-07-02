/**
 * QR-102 (recovery-site half) — the echo path finalizes the linked inbound in
 * autocommit statements: markEchoed.run (op → 'echoed') then completeInbound
 * (markTurnDone.run + markInboundComplete.run). A hard-kill (SIGKILL/OOM/power
 * loss) between markEchoed.run and the inbound-completion runs leaves the op at
 * is_terminal=1 + status='echoed' while the inbound is still 'processing' (crash
 * before markTurnDone) or 'turn_done' (crash after markTurnDone, before
 * markInboundComplete).
 *
 * On such a restart, preConnectRecovery Step 4 (processing) and Step 4b
 * (turn_done, QR-035) both DEFER an inbound that has a terminal op to
 * postConnect — but postConnectRecovery only reconciles 'submitted'/'maybe_sent'
 * ops and never revisits an 'echoed' op, so the inbound is never finalized and
 * remains a live/transient state forever → retention (deletes only
 * complete/failed) never reclaims it (leak). Delivery already happened (the op is
 * echoed), so the correct action is to FINALIZE the inbound to complete.
 *
 * The crash is simulated by directly setting the op's status to 'echoed' via raw
 * SQL — engine.markEchoed() would itself complete the inbound and defeat the
 * setup (that is exactly the completion that the crash interrupts).
 *
 * Synthetic JIDs only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';

describe('preConnectRecovery — echoed-terminal inbound finalization (QR-102 recovery site)', () => {
  let db: Database;
  let engine: DurabilityEngine;
  beforeEach(() => { db = new Database(':memory:'); db.open(); engine = new DurabilityEngine(db); });
  afterEach(() => { db.close(); });

  const status = (seq: number) =>
    (db.raw.prepare('SELECT processing_status FROM inbound_events WHERE seq = ?').get(seq) as { processing_status: string }).processing_status;

  // Create a terminal outbound op linked to `seq`, drive it to a durable
  // status='echoed' WITHOUT running the inbound completion (the crash window).
  function echoedTerminalOp(seq: number, key: string, jid: string): number {
    const opId = engine.createOutboundOp({
      conversationKey: key, chatJid: jid, opType: 'text',
      payload: '{"text":"reply"}', replayPolicy: 'safe', sourceInboundSeq: seq, isTerminal: true,
    });
    engine.markSending(opId);
    engine.markSubmitted(opId, 'WA-1');
    // Simulate: markEchoed.run committed (op → echoed) but the process died
    // before completeInbound ran.
    db.raw.prepare("UPDATE outbound_ops SET status = 'echoed' WHERE id = ?").run(opId);
    return opId;
  }

  it('finalizes a PROCESSING inbound whose terminal op is already echoed', () => {
    const seq = engine.journalInbound('m1', 'k1', 'j1@s.whatsapp.net', 'agent');
    echoedTerminalOp(seq, 'k1', 'j1@s.whatsapp.net');
    expect(status(seq)).toBe('processing');

    engine.preConnectRecovery();

    expect(status(seq)).toBe('complete');
  });

  it('finalizes a TURN_DONE inbound whose terminal op is already echoed', () => {
    const seq = engine.journalInbound('m2', 'k2', 'j2@s.whatsapp.net', 'agent');
    engine.markTurnDone(seq); // crash landed after markTurnDone, before markInboundComplete
    echoedTerminalOp(seq, 'k2', 'j2@s.whatsapp.net');
    expect(status(seq)).toBe('turn_done');

    engine.preConnectRecovery();

    expect(status(seq)).toBe('complete');
  });

  it('records response_sent as the terminal_reason on the finalized row', () => {
    const seq = engine.journalInbound('m3', 'k3', 'j3@s.whatsapp.net', 'agent');
    echoedTerminalOp(seq, 'k3', 'j3@s.whatsapp.net');
    engine.preConnectRecovery();
    const row = db.raw.prepare('SELECT terminal_reason FROM inbound_events WHERE seq = ?').get(seq) as { terminal_reason: string | null };
    expect(row.terminal_reason).toBe('response_sent');
  });

  it('no regression: PROCESSING inbound whose terminal op is NOT yet echoed (submitted) is still left for postConnect', () => {
    const seq = engine.journalInbound('m4', 'k4', 'j4@s.whatsapp.net', 'agent');
    const opId = engine.createOutboundOp({
      conversationKey: 'k4', chatJid: 'j4@s.whatsapp.net', opType: 'text',
      payload: '{"text":"reply"}', replayPolicy: 'safe', sourceInboundSeq: seq, isTerminal: true,
    });
    engine.markSending(opId);
    engine.markSubmitted(opId, 'WA-2'); // status='submitted', not echoed

    engine.preConnectRecovery();

    // unconfirmed delivery — postConnect owns it; must NOT be prematurely completed
    expect(status(seq)).toBe('processing');
  });

  it('no regression: TURN_DONE inbound whose terminal op is NOT echoed is still left for postConnect', () => {
    const seq = engine.journalInbound('m5', 'k5', 'j5@s.whatsapp.net', 'agent');
    engine.markTurnDone(seq);
    const opId = engine.createOutboundOp({
      conversationKey: 'k5', chatJid: 'j5@s.whatsapp.net', opType: 'text',
      payload: '{"text":"reply"}', replayPolicy: 'safe', sourceInboundSeq: seq, isTerminal: true,
    });
    engine.markSending(opId);
    engine.markSubmitted(opId, 'WA-3');

    engine.preConnectRecovery();

    expect(status(seq)).toBe('turn_done');
  });

  it('no regression: PROCESSING inbound with NO terminal op is still marked failed', () => {
    const seq = engine.journalInbound('m6', 'k6', 'j6@s.whatsapp.net', 'agent');
    engine.preConnectRecovery();
    expect(status(seq)).toBe('failed');
  });
});
