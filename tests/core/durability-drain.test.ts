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
import {
  DurabilityEngine,
  drainPendingOutbound,
  sendTrackedOperatorReport,
} from '../../src/core/durability.ts';
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

  it.each(['health', 'scheduler', 'reply-guarantee', 'report-channel'] as const)(
    'quarantines a generic payload that self-attests privileged caller %s',
    async (caller) => {
    const opId = engine.createOutboundOp({
      conversationKey: 'k1', chatJid: 'admin@s.whatsapp.net', opType: 'text',
        payload: JSON.stringify({ text: 'operator notice', caller }), replayPolicy: 'safe',
    });

      const messenger = makeMessenger(async () => ({ waMessageId: 'MUST_NOT_SEND' }));
    const { resent } = await drainPendingOutbound(messenger, engine);

      expect(messenger.sendMessage).not.toHaveBeenCalled();
      expect(resent).toBe(0);
      expect(getOutbound(db, opId)['status']).toBe('quarantined');
    },
  );

  it('rejects the reserved report operation through generic creation', () => {
    expect(() => engine.createOutboundOp({
      conversationKey: 'k1',
      chatJid: 'admin@s.whatsapp.net',
      opType: 'operator_report_v1',
      payload: JSON.stringify({ text: 'operator notice' }),
      replayPolicy: 'safe',
    })).toThrow(/reserved/);
    expect(() => engine.createOutboundOp({
      conversationKey: 'k1',
      chatJid: 'admin@s.whatsapp.net',
      opType: 'text',
      payload: JSON.stringify({ text: 'operator notice', operatorReport: { version: 1 } }),
      replayPolicy: 'safe',
    })).toThrow(/reserved/);
  });

  it('replays a dedicated report once with report-channel authority after provider recovery', async () => {
    const target = 'admin@s.whatsapp.net';
    const reportEngine = new DurabilityEngine(db, {
      resolveOperatorReportTargets: () => new Set([target]),
    });
    const messenger = makeMessenger(vi.fn()
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValueOnce({ waMessageId: 'WA_TRUSTED_REPLAY' }));

    await expect(sendTrackedOperatorReport(
      messenger,
      target,
      'operator notice',
      reportEngine,
      { replayPolicy: 'safe' },
    )).rejects.toThrow('provider unavailable');
    reportEngine.postConnectRecovery();

    await expect(drainPendingOutbound(messenger, reportEngine)).resolves.toEqual({ resent: 1, expired: 0 });
    expect(messenger.sendMessage).toHaveBeenNthCalledWith(2, target, 'operator notice', {
      caller: 'report-channel',
    });
  });

  it('rejects a dedicated report to a nonconfigured target before journaling or send', async () => {
    const reportEngine = new DurabilityEngine(db, {
      resolveOperatorReportTargets: () => new Set(['admin@s.whatsapp.net']),
    });
    const messenger = makeMessenger(async () => ({ waMessageId: 'MUST_NOT_SEND' }));

    await expect(sendTrackedOperatorReport(
      messenger,
      'cold@s.whatsapp.net',
      'operator notice',
      reportEngine,
      { replayPolicy: 'safe' },
    )).rejects.toThrow(/currently configured admin/);
    expect(messenger.sendMessage).not.toHaveBeenCalled();
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM outbound_ops').get()).toMatchObject({ count: 0 });
  });

  it('quarantines a dedicated report whose stored target no longer matches its chat', async () => {
    const target = 'admin@s.whatsapp.net';
    const reportEngine = new DurabilityEngine(db, {
      resolveOperatorReportTargets: () => new Set([target, 'other@s.whatsapp.net']),
    });
    const opId = reportEngine.createOperatorReportOp({
      chatJid: target,
      text: 'operator notice',
      reportType: 'text',
      replayPolicy: 'safe',
    });
    db.raw.prepare('UPDATE outbound_ops SET chat_jid = ? WHERE id = ?')
      .run('other@s.whatsapp.net', opId);
    const messenger = makeMessenger(async () => ({ waMessageId: 'MUST_NOT_SEND' }));

    await drainPendingOutbound(messenger, reportEngine);
    expect(messenger.sendMessage).not.toHaveBeenCalled();
    expect(getOutbound(db, opId)['status']).toBe('quarantined');
  });

  it('quarantines a dedicated report after admin rotation', async () => {
    const targets = new Set(['admin@s.whatsapp.net']);
    const reportEngine = new DurabilityEngine(db, {
      resolveOperatorReportTargets: () => targets,
    });
    const opId = reportEngine.createOperatorReportOp({
      chatJid: 'admin@s.whatsapp.net',
      text: 'operator notice',
      reportType: 'text',
      replayPolicy: 'safe',
    });
    targets.clear();
    targets.add('rotated@s.whatsapp.net');
    const messenger = makeMessenger(async () => ({ waMessageId: 'MUST_NOT_SEND' }));

    await drainPendingOutbound(messenger, reportEngine);
    expect(messenger.sendMessage).not.toHaveBeenCalled();
    expect(getOutbound(db, opId)['status']).toBe('quarantined');
  });

  it.each([
    { operatorReport: { version: 2, target: 'admin@s.whatsapp.net', reportType: 'text' } },
    { operatorReport: { version: 1, target: 'admin@s.whatsapp.net', reportType: 'unknown' } },
    { operatorReport: null },
  ])('quarantines malformed or unknown reserved report metadata %#', async (metadata) => {
    const target = 'admin@s.whatsapp.net';
    const reportEngine = new DurabilityEngine(db, {
      resolveOperatorReportTargets: () => new Set([target]),
    });
    const opId = reportEngine.createOperatorReportOp({
      chatJid: target,
      text: 'operator notice',
      reportType: 'text',
      replayPolicy: 'safe',
    });
    db.raw.prepare('UPDATE outbound_ops SET payload = ? WHERE id = ?')
      .run(JSON.stringify({ text: 'operator notice', ...metadata }), opId);
    const messenger = makeMessenger(async () => ({ waMessageId: 'MUST_NOT_SEND' }));

    await drainPendingOutbound(messenger, reportEngine);
    expect(messenger.sendMessage).not.toHaveBeenCalled();
    expect(getOutbound(db, opId)['status']).toBe('quarantined');
  });

  it('does not let malformed reserved payloads block a later status report', async () => {
    const target = 'admin@s.whatsapp.net';
    const reportEngine = new DurabilityEngine(db, {
      resolveOperatorReportTargets: () => new Set([target]),
    });
    const malformedId = reportEngine.createOperatorReportOp({
      chatJid: target,
      text: 'old operator notice',
      reportType: 'text',
      replayPolicy: 'safe',
    });
    db.raw.prepare('UPDATE outbound_ops SET payload = ? WHERE id = ?').run('{', malformedId);

    const statusId = reportEngine.createOperatorReportOp({
      chatJid: target,
      text: 'back online',
      reportType: 'status_ping',
      replayPolicy: 'safe',
    });
    const messenger = makeMessenger(async () => ({ waMessageId: 'WA_STATUS' }));

    await expect(drainPendingOutbound(messenger, reportEngine)).resolves.toEqual({ resent: 1, expired: 0 });
    expect(messenger.sendMessage).toHaveBeenCalledTimes(1);
    expect(messenger.sendMessage).toHaveBeenCalledWith(
      target,
      'back online',
      { caller: 'report-channel' },
    );
    expect(getOutbound(db, malformedId)['status']).toBe('quarantined');
    expect(getOutbound(db, statusId)['status']).toBe('submitted');
  });

  it('quarantines a pending text op with unrecognized caller provenance', async () => {
    const opId = engine.createOutboundOp({
      conversationKey: 'k1', chatJid: 'admin@s.whatsapp.net', opType: 'text',
      payload: JSON.stringify({ text: 'operator notice', caller: 'external' }), replayPolicy: 'safe',
    });

    const messenger = makeMessenger(async () => ({ waMessageId: 'MUST_NOT_SEND' }));
    const { resent } = await drainPendingOutbound(messenger, engine);

    expect(messenger.sendMessage).not.toHaveBeenCalled();
    expect(resent).toBe(0);
    expect(getOutbound(db, opId)['status']).toBe('quarantined');
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
