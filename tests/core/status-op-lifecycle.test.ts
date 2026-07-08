/**
 * Tests for status-op lifecycle hardening (PR-C) — the "Agent back online" storm.
 *
 * The back-online pings are enqueued as op_type='status_ping' + replayPolicy='unsafe'.
 * Three layers keep them structurally storm-proof:
 *   1. unsafe replay policy — postConnectRecovery quarantines a failed ping instead
 *      of resetting it to `pending` (so the drain never re-sends it),
 *   2. supersede-on-enqueue — one outstanding status_ping per chat,
 *   3. TTL age-out at drain — a status_ping stranded in `pending` past
 *      STATUS_OP_TTL_MS is quarantined + alerted, never re-sent.
 *
 * Scope guard: supersede + TTL key ONLY on op_type='status_ping'. Normal 'text'
 * ops (user replies, admin command responses, isResume continuity messages) are
 * provably untouched — see the explicit exemption tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine, sendTracked, drainPendingOutbound } from '../../src/core/durability.ts';
import type { Messenger, SubmissionReceipt } from '../../src/core/types.ts';

const emitAlert = vi.hoisted(() => vi.fn(() => true));
const clearAlertSource = vi.hoisted(() => vi.fn(() => true));

vi.mock('../../src/lib/emit-alert.ts', () => ({
  emitAlert,
  emitAlertChecked: emitAlert,
  clearAlertSource,
  clearAlertSourceChecked: clearAlertSource,
}));

const CHAT = 'chat1@s.whatsapp.net';
const OTHER_CHAT = 'chat2@s.whatsapp.net';

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

describe('status-op lifecycle (PR-C)', () => {
  let db: Database;
  let durability: DurabilityEngine;

  beforeEach(() => {
    db = makeDb();
    durability = new DurabilityEngine(db);
    emitAlert.mockClear();
    clearAlertSource.mockClear();
  });

  afterEach(() => { db.close(); });

  // ── Task 1: sendTracked opType plumbing ──

  it('sendTracked stamps op_type status_ping when requested, text by default', async () => {
    const cm = makeMessenger(async () => ({ waMessageId: 'WA1' }));
    await sendTracked(cm, CHAT, 'ping', durability, { replayPolicy: 'unsafe', opType: 'status_ping' });
    await sendTracked(cm, CHAT, 'hello', durability, { replayPolicy: 'safe' });
    const rows = db.raw.prepare(`SELECT op_type, payload FROM outbound_ops ORDER BY id`).all() as Array<{ op_type: string; payload: string }>;
    expect(rows[0].op_type).toBe('status_ping');
    expect(rows[1].op_type).toBe('text');
  });

  // ── Task 2: drain treats status_ping as text-reconstructable ──

  it('drain re-sends a pending status_ping op (reconstructable), does not quarantine it', async () => {
    const opId = durability.createOutboundOp({
      conversationKey: 'k1', chatJid: CHAT, opType: 'status_ping',
      payload: JSON.stringify({ text: '*Agent back online* ✓' }), replayPolicy: 'unsafe',
    });
    expect(getOutbound(db, opId)['status']).toBe('pending');

    const messenger = makeMessenger(async () => ({ waMessageId: 'WA_PING_1' }));
    await drainPendingOutbound(messenger, durability);

    expect(messenger.sendMessage).toHaveBeenCalledTimes(1);
    expect(messenger.sendMessage).toHaveBeenCalledWith(CHAT, '*Agent back online* ✓');
    const row = getOutbound(db, opId);
    expect(row['status']).toBe('submitted');
    expect(row['wa_message_id']).toBe('WA_PING_1');
    expect(emitAlert).not.toHaveBeenCalled();
  });

  // ── Task 3: supersede-on-enqueue (one outstanding status ping per chat) ──

  /** Enqueue a status_ping whose send fails, leaving it non-terminal (maybe_sent). */
  async function sendFailingPing(chatJid: string, text: string): Promise<void> {
    const failing = makeMessenger(async () => { throw new Error('send failed'); });
    await expect(
      sendTracked(failing, chatJid, text, durability, { replayPolicy: 'unsafe', opType: 'status_ping' }),
    ).rejects.toThrow('send failed');
  }

  it('second status ping supersedes the outstanding one for the same chat only', async () => {
    const cm = makeMessenger(async () => ({ waMessageId: 'WA_OK' }));
    await sendFailingPing(CHAT, 'ping1');       // CHAT ping → maybe_sent (non-terminal)
    await sendTracked(cm, OTHER_CHAT, 'pingX', durability, { replayPolicy: 'unsafe', opType: 'status_ping' });
    await sendTracked(cm, CHAT, 'ping2', durability, { replayPolicy: 'unsafe', opType: 'status_ping' });

    const rows = db.raw.prepare(
      `SELECT chat_jid, status, error FROM outbound_ops WHERE op_type='status_ping' ORDER BY id`,
    ).all() as Array<{ chat_jid: string; status: string; error: string | null }>;

    // ping1 (CHAT) superseded by ping2 (CHAT).
    expect(rows[0]).toMatchObject({ chat_jid: CHAT, status: 'failed_permanent', error: 'superseded' });
    // pingX (OTHER_CHAT) untouched — different chat.
    expect(rows[1].chat_jid).toBe(OTHER_CHAT);
    expect(rows[1].status).not.toBe('failed_permanent');
    // ping2 (CHAT) is the survivor — delivered, not superseded.
    expect(rows[2].chat_jid).toBe(CHAT);
    expect(rows[2].status).toBe('submitted');
  });

  it('SCOPE GUARD: enqueueing a status_ping never supersedes a pending text op in the same chat', async () => {
    // A stale, undelivered user/admin reply sitting in `pending` for CHAT.
    const textId = durability.createOutboundOp({
      conversationKey: 'k1', chatJid: CHAT, opType: 'text',
      payload: JSON.stringify({ text: 'important user reply' }), replayPolicy: 'safe',
    });
    expect(getOutbound(db, textId)['status']).toBe('pending');

    // Enqueue a status_ping for the SAME chat.
    const cm = makeMessenger(async () => ({ waMessageId: 'WA_OK' }));
    await sendTracked(cm, CHAT, '*Agent back online* ✓', durability, { replayPolicy: 'unsafe', opType: 'status_ping' });

    // The text op is provably untouched: still pending, no 'superseded' error.
    const textRow = getOutbound(db, textId);
    expect(textRow).toMatchObject({ status: 'pending', error: null });
  });

  // ── Task 4: TTL age-out at drain (status class only) ──

  it('drain TTL-expires a stale status_ping, sends a fresh one, never expires a stale text op', async () => {
    // Stale status_ping, backdated past STATUS_OP_TTL_MS (30 min).
    const staleId = durability.createOutboundOp({
      conversationKey: 'k1', chatJid: CHAT, opType: 'status_ping',
      payload: JSON.stringify({ text: 'stale back online' }), replayPolicy: 'unsafe',
    });
    db.raw.prepare(`UPDATE outbound_ops SET created_at = datetime('now','-31 minutes') WHERE id = ?`).run(staleId);

    // Fresh status_ping, within TTL. Different chat so supersede-on-enqueue does
    // not touch the stale one (this test isolates the drain-time TTL, not supersede).
    const freshId = durability.createOutboundOp({
      conversationKey: 'k2', chatJid: OTHER_CHAT, opType: 'status_ping',
      payload: JSON.stringify({ text: 'fresh back online' }), replayPolicy: 'unsafe',
    });

    // Stale text op, backdated identically — must be EXEMPT from TTL and still re-sent.
    const textId = durability.createOutboundOp({
      conversationKey: 'k3', chatJid: 'chat3@s.whatsapp.net', opType: 'text',
      payload: JSON.stringify({ text: 'old user reply' }), replayPolicy: 'safe',
    });
    db.raw.prepare(`UPDATE outbound_ops SET created_at = datetime('now','-31 minutes') WHERE id = ?`).run(textId);

    const messenger = makeMessenger(async () => ({ waMessageId: 'WA_SENT' }));
    const { resent, expired } = await drainPendingOutbound(messenger, durability);

    // Stale ping: quarantined + TTL alert, never sent.
    expect(getOutbound(db, staleId)['status']).toBe('quarantined');
    expect(messenger.sendMessage).not.toHaveBeenCalledWith(CHAT, 'stale back online');
    expect(emitAlert).toHaveBeenCalledWith(
      'Loops',
      'outbound_quarantined',
      expect.any(String),
      expect.stringContaining('status_op_ttl_expired'),
    );
    // Fresh ping: re-sent.
    expect(getOutbound(db, freshId)['status']).toBe('submitted');
    expect(messenger.sendMessage).toHaveBeenCalledWith(OTHER_CHAT, 'fresh back online');
    // SCOPE GUARD: stale text op is re-sent, NEVER TTL-expired.
    expect(getOutbound(db, textId)['status']).toBe('submitted');
    expect(messenger.sendMessage).toHaveBeenCalledWith('chat3@s.whatsapp.net', 'old user reply');
    // Counters: fresh ping + text op re-sent; stale ping expired.
    expect(resent).toBe(2);
    expect(expired).toBe(1);
  });
});
