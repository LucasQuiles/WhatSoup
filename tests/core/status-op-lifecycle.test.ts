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
});
