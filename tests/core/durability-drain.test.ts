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
});
