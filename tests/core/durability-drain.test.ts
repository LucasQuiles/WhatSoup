/**
 * Tests for drainPendingOutbound() — the systemic pending-op drainer (BEAD-057).
 *
 * postConnectRecovery resets unconfirmed safe/read_only ops to `status='pending'`
 * but never re-sends them. drainPendingOutbound closes that silent-drop gap:
 *  - reconstructable text ops ({text}) are re-sent via the messenger,
 *  - non-reconstructable ops are quarantined + alerted (never left pending forever),
 *  - send failures fall back to maybe_sent (recoverable, not lost).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine, drainPendingOutbound } from '../../src/core/durability.ts';
import type { Messenger, SubmissionReceipt } from '../../src/core/types.ts';

const emitAlert = vi.hoisted(() => vi.fn(() => true));
const clearAlertSource = vi.hoisted(() => vi.fn(() => true));

vi.mock('../../src/lib/emit-alert.ts', () => ({
  emitAlert,
  emitAlertChecked: emitAlert,
  clearAlertSource,
  clearAlertSourceChecked: clearAlertSource,
}));

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function getOutbound(db: Database, id: number): Record<string, unknown> {
  return db.raw.prepare('SELECT * FROM outbound_ops WHERE id = ?').get(id) as Record<string, unknown>;
}

/** Mock Messenger whose sendMessage is a controllable spy. */
function makeMessenger(
  sendImpl: (chatJid: string, text: string) => Promise<SubmissionReceipt>,
): Messenger {
  return {
    sendMessage: vi.fn(sendImpl),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  } as unknown as Messenger;
}

describe('drainPendingOutbound()', () => {
  let db: Database;
  let engine: DurabilityEngine;

  beforeEach(() => {
    db = makeDb();
    engine = new DurabilityEngine(db);
    emitAlert.mockClear();
    clearAlertSource.mockClear();
  });

  afterEach(() => { db.close(); });

  it('re-sends a reconstructable text pending op and transitions it out of pending (markSubmitted)', async () => {
    // Mirror a maybe_sent safe op that postConnectRecovery reset to pending.
    const opId = engine.createOutboundOp({
      conversationKey: 'k1', chatJid: 'j1@s.whatsapp.net', opType: 'text',
      payload: JSON.stringify({ text: 'hello world' }), replayPolicy: 'safe',
    });
    expect(getOutbound(db, opId)['status']).toBe('pending');

    const messenger = makeMessenger(async () => ({ waMessageId: 'WA_REPLAYED_1' }));
    const count = await drainPendingOutbound(messenger, engine);

    expect(messenger.sendMessage).toHaveBeenCalledWith('j1@s.whatsapp.net', 'hello world');
    expect(count).toBe(1);
    const row = getOutbound(db, opId);
    expect(row['status']).toBe('submitted');
    expect(row['wa_message_id']).toBe('WA_REPLAYED_1');
  });

  it('quarantines + alerts a non-text (unreconstructable) pending op instead of leaving it pending', async () => {
    const opId = engine.createOutboundOp({
      conversationKey: 'k1', chatJid: 'j1@s.whatsapp.net', opType: 'reaction',
      payload: JSON.stringify({ emoji: '👍' }), replayPolicy: 'safe',
    });

    const messenger = makeMessenger(async () => ({ waMessageId: 'SHOULD_NOT_BE_CALLED' }));
    const count = await drainPendingOutbound(messenger, engine);

    expect(messenger.sendMessage).not.toHaveBeenCalled();
    expect(count).toBe(0);
    expect(getOutbound(db, opId)['status']).toBe('quarantined');
    expect(emitAlert).toHaveBeenCalledWith(
      'Loops',
      'outbound_quarantined',
      expect.any(String),
      expect.stringContaining('pending_replay_unreconstructable'),
    );
  });

  it('quarantines a text op whose payload does not parse to {text}', async () => {
    const opId = engine.createOutboundOp({
      conversationKey: 'k1', chatJid: 'j1@s.whatsapp.net', opType: 'text',
      payload: JSON.stringify({ notText: 1 }), replayPolicy: 'safe',
    });

    const messenger = makeMessenger(async () => ({ waMessageId: 'NOPE' }));
    const count = await drainPendingOutbound(messenger, engine);

    expect(messenger.sendMessage).not.toHaveBeenCalled();
    expect(count).toBe(0);
    expect(getOutbound(db, opId)['status']).toBe('quarantined');
  });

  it('leaves a failing send recoverable (maybe_sent), not lost', async () => {
    const opId = engine.createOutboundOp({
      conversationKey: 'k1', chatJid: 'j1@s.whatsapp.net', opType: 'text',
      payload: JSON.stringify({ text: 'retry me' }), replayPolicy: 'safe',
    });

    const messenger = makeMessenger(async () => { throw new Error('socket closed'); });
    const count = await drainPendingOutbound(messenger, engine);

    expect(count).toBe(0);
    const row = getOutbound(db, opId);
    expect(row['status']).toBe('maybe_sent');
    expect(row['error']).toBe('socket closed');
  });

  it('one failing op does not abort the rest of the drain', async () => {
    const failId = engine.createOutboundOp({
      conversationKey: 'k1', chatJid: 'jfail@s.whatsapp.net', opType: 'text',
      payload: JSON.stringify({ text: 'boom' }), replayPolicy: 'safe',
    });
    const okId = engine.createOutboundOp({
      conversationKey: 'k2', chatJid: 'jok@s.whatsapp.net', opType: 'text',
      payload: JSON.stringify({ text: 'fine' }), replayPolicy: 'safe',
    });

    const messenger = makeMessenger(async (chatJid: string) => {
      if (chatJid === 'jfail@s.whatsapp.net') throw new Error('transient');
      return { waMessageId: 'WA_OK' };
    });
    const count = await drainPendingOutbound(messenger, engine);

    expect(count).toBe(1);
    expect(getOutbound(db, failId)['status']).toBe('maybe_sent');
    expect(getOutbound(db, okId)['status']).toBe('submitted');
  });

  it('returns 0 and sends nothing when there are no pending ops', async () => {
    const messenger = makeMessenger(async () => ({ waMessageId: 'X' }));
    const count = await drainPendingOutbound(messenger, engine);
    expect(count).toBe(0);
    expect(messenger.sendMessage).not.toHaveBeenCalled();
  });

  // BEAD-057 double-send race: two un-serialized drivers (the awaited recover
  // callback + the fire-and-forget 10s echo-timeout interval) can each run
  // drainPendingOutbound over an OVERLAPPING stale snapshot. Without a CAS on
  // markSending, both drains claim+send the same pending op → DOUBLE SEND.
  // This reproduces the interval drain firing DURING the recover drain's send
  // by having opA's send synchronously re-enter a second drain before resolving.
  it('does not double-send when a second drain fires during the first drain (concurrent-drain CAS)', async () => {
    const JID_A = 'ja@s.whatsapp.net';
    const JID_B = 'jb@s.whatsapp.net';
    // Two pending safe ops, exactly as postConnectRecovery would reset them.
    engine.createOutboundOp({
      conversationKey: 'kA', chatJid: JID_A, opType: 'text',
      payload: JSON.stringify({ text: 'msg A' }), replayPolicy: 'safe',
    });
    engine.createOutboundOp({
      conversationKey: 'kB', chatJid: JID_B, opType: 'text',
      payload: JSON.stringify({ text: 'msg B' }), replayPolicy: 'safe',
    });

    // Count opB sends across BOTH drains/messengers — must be exactly 1.
    let opBSendCount = 0;
    let reentered = false;

    // messenger2 = the interval drain's messenger. It only ever sees opB
    // (opA is already 'sending' when this drain snapshots pending).
    const messenger2 = makeMessenger(async (chatJid: string) => {
      if (chatJid === JID_B) opBSendCount += 1;
      return { waMessageId: 'WA_VIA_INTERVAL' };
    });

    // messenger1 = the recover-callback drain's messenger. opA's send (the
    // first op in the stale snapshot) re-enters a second concurrent drain
    // BEFORE resolving — simulating the interval firing mid-send.
    const messenger1 = makeMessenger(async (chatJid: string) => {
      if (chatJid === JID_A && !reentered) {
        reentered = true;
        await drainPendingOutbound(messenger2, engine);
        return { waMessageId: 'WA_A' };
      }
      if (chatJid === JID_B) opBSendCount += 1;
      return { waMessageId: 'WA_VIA_RECOVER' };
    });

    await drainPendingOutbound(messenger1, engine);

    // opB must be sent exactly once across both drains (CAS skip in the loser).
    expect(opBSendCount).toBe(1);
    // opB ends submitted (delivered once), never re-sent by the stale snapshot.
    expect(getOutbound(db, 2)['status']).toBe('submitted');
  });

  it('markSending is a CAS: true on a pending op (→sending), false on an already-sending op (no-op)', () => {
    const opId = engine.createOutboundOp({
      conversationKey: 'k1', chatJid: 'j1@s.whatsapp.net', opType: 'text',
      payload: JSON.stringify({ text: 'cas' }), replayPolicy: 'safe',
    });
    expect(getOutbound(db, opId)['status']).toBe('pending');

    // First claim wins: pending → sending.
    expect(engine.markSending(opId)).toBe(true);
    expect(getOutbound(db, opId)['status']).toBe('sending');

    // Second claim loses: op is no longer pending, no state change.
    expect(engine.markSending(opId)).toBe(false);
    expect(getOutbound(db, opId)['status']).toBe('sending');
  });
});
