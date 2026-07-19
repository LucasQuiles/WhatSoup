/**
 * Tests for durable outbound delivery idempotency (M1):
 *  - migration 45: outbound_op_message_ids side table (schema + backfill) and
 *    the (chat_jid, payload_hash, status) support index;
 *  - markSubmitted records every historical wa_message_id (resends no longer
 *    destroy the echo-reconciliation key) and never downgrades an echoed op;
 *  - matchEcho confirms an op via ANY historical submission id;
 *  - postConnectRecovery: confirms maybe_sent via any historical id, consults
 *    the delivered-set before reset-to-pending, terminalizes ephemeral ops,
 *    and enforces the replay cap instead of resetting forever.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';

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

function getSideTableIds(db: Database, opId: number): string[] {
  return (db.raw.prepare(
    'SELECT wa_message_id FROM outbound_op_message_ids WHERE op_id = ? ORDER BY wa_message_id',
  ).all(opId) as Array<{ wa_message_id: string }>).map((r) => r.wa_message_id);
}

/** Insert a raw message into the messages table (simulating an ingest echo). */
function insertMessage(db: Database, messageId: string, chatJid = 'jid-1@s.whatsapp.net'): void {
  db.raw.prepare(
    `INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content_type, is_from_me, timestamp)
     VALUES (?, ?, ?, ?, 'text', 1, ?)`,
  ).run(chatJid, chatJid, 'bot@s.whatsapp.net', messageId, Date.now());
}

function makeTextOp(
  engine: DurabilityEngine,
  opts: { chatJid?: string; text?: string; replayPolicy?: 'safe' | 'unsafe' | 'read_only' | 'ephemeral' } = {},
): number {
  const chatJid = opts.chatJid ?? 'jid-1@s.whatsapp.net';
  return engine.createOutboundOp({
    conversationKey: chatJid,
    chatJid,
    opType: 'text',
    payload: JSON.stringify({ text: opts.text ?? 'hello' }),
    replayPolicy: opts.replayPolicy ?? 'safe',
  });
}

// ---------------------------------------------------------------------------
// Migration 45
// ---------------------------------------------------------------------------

describe('Migration v45 — outbound_op_message_ids + payload-hash index', () => {
  let db: Database;

  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  it('creates outbound_op_message_ids with op_id/wa_message_id/submitted_at', () => {
    const cols = db.raw.prepare('PRAGMA table_info(outbound_op_message_ids)').all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('op_id');
    expect(names).toContain('wa_message_id');
    expect(names).toContain('submitted_at');
  });

  it('enforces (op_id, wa_message_id) uniqueness and indexes wa_message_id', () => {
    db.raw.prepare(
      `INSERT INTO outbound_ops (conversation_key, chat_jid, op_type, payload, status) VALUES ('k', 'j', 'text', '{}', 'submitted')`,
    ).run();
    db.raw.prepare(
      `INSERT INTO outbound_op_message_ids (op_id, wa_message_id, submitted_at) VALUES (1, 'WA_X', datetime('now'))`,
    ).run();
    expect(() => {
      db.raw.prepare(
        `INSERT INTO outbound_op_message_ids (op_id, wa_message_id, submitted_at) VALUES (1, 'WA_X', datetime('now'))`,
      ).run();
    }).toThrow();

    const indexes = db.raw.prepare('PRAGMA index_list(outbound_op_message_ids)').all() as Array<{ name: string }>;
    const indexedCols = indexes.flatMap((ix) =>
      (db.raw.prepare(`PRAGMA index_info(${ix.name})`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    expect(indexedCols).toContain('wa_message_id');
  });

  it('adds a (chat_jid, payload_hash, status) index on outbound_ops', () => {
    const indexes = db.raw.prepare('PRAGMA index_list(outbound_ops)').all() as Array<{ name: string }>;
    const shapes = indexes.map((ix) =>
      (db.raw.prepare(`PRAGMA index_info(${ix.name})`).all() as Array<{ name: string }>)
        .map((c) => c.name)
        .join(','),
    );
    expect(shapes).toContain('chat_jid,payload_hash,status');
  });

  it('backfills existing non-NULL wa_message_id rows into the side table', () => {
    // Simulate a pre-migration database state: an outbound op with a
    // wa_message_id but no side-table row, and migration 45 unapplied.
    db.raw.prepare(
      `INSERT INTO outbound_ops (conversation_key, chat_jid, op_type, payload, status, wa_message_id, submitted_at)
       VALUES ('k', 'j', 'text', '{"text":"legacy"}', 'submitted', 'WA_LEGACY', datetime('now'))`,
    ).run();
    db.raw.exec('DELETE FROM outbound_op_message_ids');
    db.raw.exec('DELETE FROM schema_migrations WHERE version = 45');

    db.open(); // re-runs pending migrations — 45 must backfill

    const rows = db.raw.prepare('SELECT op_id, wa_message_id FROM outbound_op_message_ids').all() as Array<{
      op_id: number; wa_message_id: string;
    }>;
    expect(rows).toEqual([{ op_id: 1, wa_message_id: 'WA_LEGACY' }]);
  });
});

// ---------------------------------------------------------------------------
// Multi-id echo reconciliation
// ---------------------------------------------------------------------------

describe('DurabilityEngine — multi-id echo reconciliation', () => {
  let db: Database;
  let engine: DurabilityEngine;

  beforeEach(() => {
    db = makeDb();
    engine = new DurabilityEngine(db);
    emitAlert.mockClear();
    clearAlertSource.mockClear();
  });

  afterEach(() => { db.close(); });

  it('markSubmitted records every historical wa_message_id in the side table', () => {
    const opId = makeTextOp(engine);
    engine.markSending(opId);
    engine.markSubmitted(opId, 'WA_FIRST');
    engine.markSubmitted(opId, 'WA_SECOND'); // resend overwrote the main column

    expect(getOutbound(db, opId)['wa_message_id']).toBe('WA_SECOND'); // latest, for compat
    expect(getSideTableIds(db, opId)).toEqual(['WA_FIRST', 'WA_SECOND']);
  });

  it('matchEcho confirms an op via an EARLIER submission id after a resubmit', () => {
    const opId = makeTextOp(engine);
    engine.markSending(opId);
    engine.markSubmitted(opId, 'WA_A');
    engine.markSubmitted(opId, 'WA_B'); // resent — previously destroyed the key for WA_A

    expect(engine.matchEcho('WA_A')).toBe(true);
    expect(getOutbound(db, opId)['status']).toBe('echoed');
  });

  it('markSubmitted never downgrades an echoed op back to submitted', () => {
    const opId = makeTextOp(engine);
    engine.markSending(opId);
    engine.markSubmitted(opId, 'WA_A');
    engine.markEchoed(opId);

    engine.markSubmitted(opId, 'WA_C'); // late resubmit racing the echo

    expect(getOutbound(db, opId)['status']).toBe('echoed');
    expect(getSideTableIds(db, opId)).toEqual(['WA_A', 'WA_C']);
  });
});

// ---------------------------------------------------------------------------
// postConnectRecovery — delivered-set consultation + termination
// ---------------------------------------------------------------------------

describe('DurabilityEngine — postConnectRecovery replay termination (M1)', () => {
  let db: Database;
  let engine: DurabilityEngine;

  beforeEach(() => {
    db = makeDb();
    engine = new DurabilityEngine(db);
    emitAlert.mockClear();
    clearAlertSource.mockClear();
  });

  afterEach(() => { db.close(); });

  it('confirms a maybe_sent op via ANY historical wa_message_id, not just the latest', () => {
    const opId = makeTextOp(engine);
    engine.markSending(opId);
    engine.markSubmitted(opId, 'WA_OLD');   // this copy was delivered
    engine.markSubmitted(opId, 'WA_NEW');   // resend overwrote the main column
    engine.markMaybeSent(opId, 'echo_timeout');
    insertMessage(db, 'WA_OLD');            // echo evidence for the FIRST submission

    const stats = engine.postConnectRecovery();

    expect(getOutbound(db, opId)['status']).toBe('echoed');
    expect(stats.outboundReplayed).toBe(0);
  });

  it('terminalizes a maybe_sent duplicate of an already-echoed payload instead of resetting to pending', () => {
    const chatJid = 'jid-1@s.whatsapp.net';
    const echoedId = makeTextOp(engine, { chatJid, text: 'same notice' });
    engine.markSending(echoedId);
    engine.markSubmitted(echoedId, 'WA_DELIVERED');
    engine.markEchoed(echoedId);

    const dupId = makeTextOp(engine, { chatJid, text: 'same notice' });
    engine.markSending(dupId);
    engine.markMaybeSent(dupId, 'send_failed');

    const stats = engine.postConnectRecovery();

    const row = getOutbound(db, dupId);
    expect(row['status']).toBe('failed_permanent');
    expect(row['error']).toBe(`duplicate_suppressed:${echoedId}`);
    expect(stats.outboundReplayed).toBe(0);
  });

  it('terminalizes maybe_sent ephemeral ops with ephemeral_expired — never resets, never quarantines', () => {
    const opId = makeTextOp(engine, { replayPolicy: 'ephemeral', text: '*Agent back online* ✓' });
    engine.markSending(opId);
    engine.markMaybeSent(opId, 'crash-in-flight');

    const stats = engine.postConnectRecovery();

    const row = getOutbound(db, opId);
    expect(row['status']).toBe('failed_permanent');
    expect(row['error']).toBe('ephemeral_expired');
    expect(stats.outboundReplayed).toBe(0);
    expect(stats.outboundQuarantined).toBe(0);
  });

  it('terminalizes prior-generation pending ephemeral ops during recovery', () => {
    const opId = makeTextOp(engine, { replayPolicy: 'ephemeral', text: 'stale ping' });
    // Op predates this process generation (crash left it pending).
    db.raw.prepare(
      `UPDATE outbound_ops SET created_at = datetime('now', '-60 seconds') WHERE id = ?`,
    ).run(opId);

    engine.postConnectRecovery();

    const row = getOutbound(db, opId);
    expect(row['status']).toBe('failed_permanent');
    expect(row['error']).toBe('ephemeral_expired');
  });

  it('terminalizes a maybe_sent op at the replay cap instead of resetting it to pending', () => {
    const opId = makeTextOp(engine, { text: 'give up already' });
    engine.markSending(opId);
    engine.markMaybeSent(opId, 'send_failed');
    db.raw.prepare('UPDATE outbound_ops SET retry_count = 5 WHERE id = ?').run(opId);

    const stats = engine.postConnectRecovery();

    const row = getOutbound(db, opId);
    expect(row['status']).toBe('failed_permanent');
    expect(String(row['error'])).toContain('replay_attempts_exhausted');
    expect(stats.outboundReplayed).toBe(0);
    expect(emitAlert).toHaveBeenCalledWith(
      'Loops',
      'outbound_replay_exhausted',
      expect.any(String),
      expect.stringContaining(`op=${opId}`),
    );
  });

  it('still resets an unconfirmed, un-capped, non-duplicate safe op to pending (baseline preserved)', () => {
    const opId = makeTextOp(engine, { text: 'genuinely undelivered' });
    engine.markSending(opId);
    engine.markMaybeSent(opId, 'send_failed');

    const stats = engine.postConnectRecovery();

    expect(getOutbound(db, opId)['status']).toBe('pending');
    expect(stats.outboundReplayed).toBe(1);
  });
});
