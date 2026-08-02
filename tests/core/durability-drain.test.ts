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
import { DurabilityEngine, drainPendingOutbound, drainPendingOutboundLocked } from '../../src/core/durability.ts';
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
    const { resent } = await drainPendingOutbound(messenger, engine);

    expect(messenger.sendMessage).toHaveBeenCalledWith('j1@s.whatsapp.net', 'hello world');
    expect(resent).toBe(1);
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
    const { resent } = await drainPendingOutbound(messenger, engine);

    expect(messenger.sendMessage).not.toHaveBeenCalled();
    expect(resent).toBe(0);
    expect(getOutbound(db, opId)).toMatchObject({
      status: 'quarantined',
      quarantine_disposition: 'record_unreconstructable',
      quarantine_evidence_coverage: 'partial',
    });
    expect(emitAlert).toHaveBeenCalledWith(
      'Loops',
      'outbound_record_unreconstructable',
      expect.any(String),
      expect.stringContaining('pending_replay_unreconstructable'),
      'warning',
    );
  });

  it('quarantines a text op whose payload does not parse to {text}', async () => {
    const opId = engine.createOutboundOp({
      conversationKey: 'k1', chatJid: 'j1@s.whatsapp.net', opType: 'text',
      payload: JSON.stringify({ notText: 1 }), replayPolicy: 'safe',
    });

    const messenger = makeMessenger(async () => ({ waMessageId: 'NOPE' }));
    const { resent } = await drainPendingOutbound(messenger, engine);

    expect(messenger.sendMessage).not.toHaveBeenCalled();
    expect(resent).toBe(0);
    expect(getOutbound(db, opId)['status']).toBe('quarantined');
  });

  it('leaves a failing send recoverable (maybe_sent), not lost', async () => {
    const opId = engine.createOutboundOp({
      conversationKey: 'k1', chatJid: 'j1@s.whatsapp.net', opType: 'text',
      payload: JSON.stringify({ text: 'retry me' }), replayPolicy: 'safe',
    });

    const messenger = makeMessenger(async () => { throw new Error('socket closed'); });
    const { resent } = await drainPendingOutbound(messenger, engine);

    expect(resent).toBe(0);
    const row = getOutbound(db, opId);
    expect(row['status']).toBe('maybe_sent');
    expect(JSON.parse(row['error'] as string)).toMatchObject({
      failure_code: 'outbound.unknown_failure',
      mutation_state: 'ambiguous',
    });
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
    const { resent } = await drainPendingOutbound(messenger, engine);

    expect(resent).toBe(1);
    expect(getOutbound(db, failId)['status']).toBe('maybe_sent');
    expect(getOutbound(db, okId)['status']).toBe('submitted');
  });

  it('returns 0 and sends nothing when there are no pending ops', async () => {
    const messenger = makeMessenger(async () => ({ waMessageId: 'X' }));
    const { resent } = await drainPendingOutbound(messenger, engine);
    expect(resent).toBe(0);
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

  // #2813: caller identity does not survive the DB round-trip. sendTracked
  // persists only { text } — even when the original send carried a QR-086
  // infra caller ('health') — so the replay must go out as a plain 2-arg
  // sendMessage with NO caller option: the default, most restrictive guard
  // path (no cold-floor bypass). This test pins that default-to-agent
  // decision explicitly.
  it('replays without a caller token even when the original send carried one (#2813 default-to-agent)', async () => {
    // Exactly what sendTracked writes for a caller: 'health' send — the
    // caller is NOT part of the persisted payload.
    const opId = engine.createOutboundOp({
      conversationKey: 'k1', chatJid: 'j1@s.whatsapp.net', opType: 'text',
      payload: JSON.stringify({ text: 'health status ping' }), replayPolicy: 'safe',
    });
    expect(getOutbound(db, opId)['status']).toBe('pending');

    const messenger = makeMessenger(async () => ({ waMessageId: 'WA_REPLAY_NO_CALLER' }));
    const { resent } = await drainPendingOutbound(messenger, engine);

    expect(resent).toBe(1);
    // Exact-args assertion: a third { caller } argument would fail this.
    expect(messenger.sendMessage).toHaveBeenCalledWith('j1@s.whatsapp.net', 'health status ping');
    expect(vi.mocked(messenger.sendMessage).mock.calls[0]).toHaveLength(2);
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

  // #2903: replay-storm bound — an op that has cycled through crash-in-flight
  // recovery (sending → maybe_sent → pending) many times must be quarantined
  // instead of re-sent indefinitely. Without this bound, a crash-loop produces
  // ~hundreds of duplicate notices/sec.
  it('quarantines an op that exceeded MAX_OUTBOUND_REPLAY_ATTEMPTS instead of re-sending it', async () => {
    const opId = engine.createOutboundOp({
      conversationKey: 'k1', chatJid: 'j1@s.whatsapp.net', opType: 'text',
      payload: JSON.stringify({ text: 'storm victim' }), replayPolicy: 'safe',
    });
    // Simulate 50 prior crash-loop cycles by bumping retry_count past the cap.
    db.raw.prepare('UPDATE outbound_ops SET retry_count = 50 WHERE id = ?').run(opId);
    expect(getOutbound(db, opId)['retry_count']).toBe(50);

    const messenger = makeMessenger(async () => ({ waMessageId: 'SHOULD_NOT_SEND' }));
    const { resent, expired } = await drainPendingOutbound(messenger, engine);

    // The op must NOT have been re-sent.
    expect(messenger.sendMessage).not.toHaveBeenCalled();
    expect(resent).toBe(0);
    expect(expired).toBe(0);

    // The op must be quarantined (terminal state, not pending).
    // Note: quarantine does not set is_terminal=1 in the drain path — it matches
    // the existing pattern for deferral_limit_exceeded quarantine.
    const row = getOutbound(db, opId);
    expect(row['status']).toBe('quarantined');

    // An alert must have been emitted for operator visibility.
    expect(emitAlert).toHaveBeenCalled();
  });

  it('still re-sends an op that is under MAX_OUTBOUND_REPLAY_ATTEMPTS', async () => {
    const opId = engine.createOutboundOp({
      conversationKey: 'k1', chatJid: 'j1@s.whatsapp.net', opType: 'text',
      payload: JSON.stringify({ text: 'under cap' }), replayPolicy: 'safe',
    });
    // 49 attempts — one under the cap of 50.
    db.raw.prepare('UPDATE outbound_ops SET retry_count = 49 WHERE id = ?').run(opId);

    const messenger = makeMessenger(async () => ({ waMessageId: 'WA_OK' }));
    const { resent } = await drainPendingOutbound(messenger, engine);

    expect(messenger.sendMessage).toHaveBeenCalledWith('j1@s.whatsapp.net', 'under cap');
    expect(resent).toBe(1);
    expect(getOutbound(db, opId)['status']).toBe('submitted');
  });

  // #2903: drainPendingOutboundLocked prevents concurrent drain invocations
  // from overlapping on the same pending snapshot.
  it('drainPendingOutboundLocked skips a concurrent drain invocation', async () => {
    engine.createOutboundOp({
      conversationKey: 'k1', chatJid: 'j1@s.whatsapp.net', opType: 'text',
      payload: JSON.stringify({ text: 'lock test' }), replayPolicy: 'safe',
    });

    let sendResolve: (() => void) | undefined;
    const messenger = makeMessenger(
      () => new Promise<SubmissionReceipt>((resolve) => {
        sendResolve = () => resolve({ waMessageId: 'WA_LOCK' });
      }),
    );

    // Start first drain — it will hang on the unresolved sendMessage.
    const first = drainPendingOutboundLocked(messenger, engine);
    // Start second drain concurrently — must be skipped (lock held).
    const second = drainPendingOutboundLocked(messenger, engine);
    const secondResult = await second;

    // Second drain returned immediately with zero work.
    expect(secondResult).toEqual({ resent: 0, expired: 0 });

    // Release the first drain.
    sendResolve!();
    const firstResult = await first;
    expect(firstResult.resent).toBe(1);
  });
});
