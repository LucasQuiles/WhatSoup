/**
 * QR-035 — preConnectRecovery Step 4 reconciled only `processing` inbound events
 * (getProcessingInboundEvents). The lifecycle is processing → turn_done →
 * complete, so a crash in the markTurnDone..markInboundComplete window strands a
 * row at `turn_done` — never reconciled to a terminal status, and retention
 * (which deletes only complete/failed) never reclaims it → unbounded growth.
 *
 * A stranded turn_done means the turn DID complete (markTurnDone ran), so recovery
 * finalizes it to `complete` (not `failed`); its reply's outbound op is reconciled
 * independently. turn_done is NOT added to retention — it is a live transient
 * state during normal operation.
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
    expect(row.terminal_reason).toBeTruthy();
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
});
