/**
 * Tests for outbound replay termination in drainPendingOutbound() (M1).
 *
 * The production failure: safe/read_only ops cycled pending→sending→maybe_sent→
 * (restart)→pending forever — 81k+ `outbound_replayed` re-sends, 403 duplicate
 * notices into one DM. These tests pin the termination mechanisms:
 *  - retry_count is live: incremented per drain replay attempt, capped at 5,
 *    past the cap the op terminalizes to failed_permanent + alert;
 *  - replay backoff: an op re-attempted too recently is skipped (left pending);
 *  - durable duplicate suppression: a pending op whose (chat_jid, payload_hash)
 *    is already `echoed` is terminalized, never re-sent;
 *  - ephemeral replay policy: prior-generation ephemeral ops are expired, not
 *    re-sent;
 *  - drain serialization: overlapping drains do not interleave — the second
 *    returns early.
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

function setRetryCount(db: Database, id: number, count: number): void {
  db.raw.prepare('UPDATE outbound_ops SET retry_count = ? WHERE id = ?').run(count, id);
}

/** Backdate created_at so the op reads as created by a previous process generation. */
function backdateCreatedAt(db: Database, id: number, seconds: number): void {
  db.raw.prepare(
    `UPDATE outbound_ops SET created_at = datetime('now', '-' || ? || ' seconds') WHERE id = ?`,
  ).run(seconds, id);
}

function setSubmittedAt(db: Database, id: number, secondsAgo: number): void {
  db.raw.prepare(
    `UPDATE outbound_ops SET submitted_at = datetime('now', '-' || ? || ' seconds') WHERE id = ?`,
  ).run(secondsAgo, id);
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

function makePendingTextOp(
  engine: DurabilityEngine,
  opts: { chatJid?: string; text?: string; replayPolicy?: 'safe' | 'read_only' | 'ephemeral' } = {},
): number {
  return engine.createOutboundOp({
    conversationKey: opts.chatJid ?? 'j1@s.whatsapp.net',
    chatJid: opts.chatJid ?? 'j1@s.whatsapp.net',
    opType: 'text',
    payload: JSON.stringify({ text: opts.text ?? 'replay me' }),
    replayPolicy: opts.replayPolicy ?? 'safe',
  });
}

/** Create an already-echoed op (delivered evidence) for duplicate-suppression cases. */
function makeEchoedOp(engine: DurabilityEngine, chatJid: string, text: string, waId: string): number {
  const id = engine.createOutboundOp({
    conversationKey: chatJid,
    chatJid,
    opType: 'text',
    payload: JSON.stringify({ text }),
    replayPolicy: 'safe',
  });
  engine.markSending(id);
  engine.markSubmitted(id, waId);
  engine.markEchoed(id);
  return id;
}

describe('drainPendingOutbound() — replay termination (M1)', () => {
  let db: Database;
  let engine: DurabilityEngine;

  beforeEach(() => {
    db = makeDb();
    engine = new DurabilityEngine(db);
    emitAlert.mockClear();
    clearAlertSource.mockClear();
  });

  afterEach(() => { db.close(); });

  // ── A. retry_count activation + cap ─────────────────────────────────────

  it('increments retry_count on each drain replay attempt', async () => {
    const opId = makePendingTextOp(engine);
    expect(getOutbound(db, opId)['retry_count']).toBe(0);

    const messenger = makeMessenger(async () => ({ waMessageId: 'WA_1' }));
    await drainPendingOutbound(messenger, engine);

    expect(getOutbound(db, opId)['retry_count']).toBe(1);
    expect(getOutbound(db, opId)['status']).toBe('submitted');
  });

  it('terminalizes an op at the replay cap (5) with failed_permanent + alert instead of sending', async () => {
    const opId = makePendingTextOp(engine);
    setRetryCount(db, opId, 5);

    const messenger = makeMessenger(async () => ({ waMessageId: 'SHOULD_NOT_SEND' }));
    const count = await drainPendingOutbound(messenger, engine);

    expect(messenger.sendMessage).not.toHaveBeenCalled();
    expect(count).toBe(0);
    const row = getOutbound(db, opId);
    expect(row['status']).toBe('failed_permanent');
    expect(String(row['error'])).toContain('replay_attempts_exhausted');
    expect(emitAlert).toHaveBeenCalledWith(
      'Loops',
      'outbound_replay_exhausted',
      expect.any(String),
      expect.stringContaining(`op=${opId}`),
    );
  });

  it('still sends an op below the replay cap', async () => {
    const opId = makePendingTextOp(engine);
    setRetryCount(db, opId, 4);
    // Last attempt long ago — outside any backoff window.
    setSubmittedAt(db, opId, 3600);

    const messenger = makeMessenger(async () => ({ waMessageId: 'WA_BELOW_CAP' }));
    const count = await drainPendingOutbound(messenger, engine);

    expect(count).toBe(1);
    expect(getOutbound(db, opId)['status']).toBe('submitted');
    expect(getOutbound(db, opId)['retry_count']).toBe(5);
  });

  // ── A. backoff ───────────────────────────────────────────────────────────

  it('skips (leaves pending) an op re-attempted within its backoff window', async () => {
    const opId = makePendingTextOp(engine);
    setRetryCount(db, opId, 1);
    setSubmittedAt(db, opId, 1); // just attempted — inside the 30s base window

    const messenger = makeMessenger(async () => ({ waMessageId: 'TOO_SOON' }));
    const count = await drainPendingOutbound(messenger, engine);

    expect(messenger.sendMessage).not.toHaveBeenCalled();
    expect(count).toBe(0);
    expect(getOutbound(db, opId)['status']).toBe('pending');
    expect(getOutbound(db, opId)['retry_count']).toBe(1);
  });

  it('re-sends an op whose backoff window has elapsed', async () => {
    const opId = makePendingTextOp(engine);
    setRetryCount(db, opId, 1);
    setSubmittedAt(db, opId, 120); // 30s * 2^0 = 30s window — long past

    const messenger = makeMessenger(async () => ({ waMessageId: 'WA_AFTER_BACKOFF' }));
    const count = await drainPendingOutbound(messenger, engine);

    expect(count).toBe(1);
    expect(getOutbound(db, opId)['status']).toBe('submitted');
  });

  // ── B. durable duplicate suppression ─────────────────────────────────────

  it('suppresses a pending op whose (chat_jid, payload_hash) is already echoed — no send', async () => {
    const chatJid = 'dup@s.whatsapp.net';
    const echoedId = makeEchoedOp(engine, chatJid, 'notice text', 'WA_DELIVERED');
    const dupId = makePendingTextOp(engine, { chatJid, text: 'notice text' });

    const messenger = makeMessenger(async () => ({ waMessageId: 'SHOULD_NOT_SEND' }));
    const count = await drainPendingOutbound(messenger, engine);

    expect(messenger.sendMessage).not.toHaveBeenCalled();
    expect(count).toBe(0);
    const row = getOutbound(db, dupId);
    expect(row['status']).toBe('failed_permanent');
    expect(row['error']).toBe(`duplicate_suppressed:${echoedId}`);
  });

  it('does not suppress the same payload for a different chat', async () => {
    makeEchoedOp(engine, 'a@s.whatsapp.net', 'shared text', 'WA_A');
    const otherId = makePendingTextOp(engine, { chatJid: 'b@s.whatsapp.net', text: 'shared text' });

    const messenger = makeMessenger(async () => ({ waMessageId: 'WA_B' }));
    const count = await drainPendingOutbound(messenger, engine);

    expect(count).toBe(1);
    expect(getOutbound(db, otherId)['status']).toBe('submitted');
  });

  // ── D. ephemeral replay policy in the drain ──────────────────────────────

  it('expires a prior-generation ephemeral op instead of re-sending it', async () => {
    const opId = makePendingTextOp(engine, { replayPolicy: 'ephemeral', text: '*Agent back online* ✓' });
    backdateCreatedAt(db, opId, 60); // created before this process generation

    const messenger = makeMessenger(async () => ({ waMessageId: 'SHOULD_NOT_SEND' }));
    const count = await drainPendingOutbound(messenger, engine);

    expect(messenger.sendMessage).not.toHaveBeenCalled();
    expect(count).toBe(0);
    const row = getOutbound(db, opId);
    expect(row['status']).toBe('failed_permanent');
    expect(row['error']).toBe('ephemeral_expired');
  });

  it('sends a current-generation ephemeral op normally', async () => {
    const opId = makePendingTextOp(engine, { replayPolicy: 'ephemeral', text: 'fresh ping' });

    const messenger = makeMessenger(async () => ({ waMessageId: 'WA_FRESH' }));
    const count = await drainPendingOutbound(messenger, engine);

    expect(count).toBe(1);
    expect(getOutbound(db, opId)['status']).toBe('submitted');
  });

  // ── E. drain serialization ───────────────────────────────────────────────

  it('serializes overlapping drains: the second returns early and nothing is double-sent', async () => {
    makePendingTextOp(engine, { chatJid: 'ser1@s.whatsapp.net', text: 'first' });
    makePendingTextOp(engine, { chatJid: 'ser2@s.whatsapp.net', text: 'second' });

    // Deferred gate: the FIRST send blocks until the test releases it, holding
    // drain #1 mid-send while drain #2 is invoked — no wall-clock waits.
    let releaseFirstSend: (() => void) | undefined;
    const firstSendGate = new Promise<void>((resolve) => { releaseFirstSend = resolve; });

    const sends: string[] = [];
    const messenger = makeMessenger(async (chatJid: string) => {
      sends.push(chatJid);
      if (sends.length === 1) await firstSendGate;
      return { waMessageId: `WA_${sends.length}` };
    });

    const first = drainPendingOutbound(messenger, engine);   // blocks on op 1's send
    const second = drainPendingOutbound(messenger, engine);  // overlapping invocation
    releaseFirstSend!();
    const [firstCount, secondCount] = await Promise.all([first, second]);

    expect(secondCount).toBe(0); // latch: concurrent caller yields without draining
    expect(firstCount).toBe(2);
    expect(sends.sort()).toEqual(['ser1@s.whatsapp.net', 'ser2@s.whatsapp.net']);
  });
});

// ---------------------------------------------------------------------------
// Production storm shape
// ---------------------------------------------------------------------------

describe('drainPendingOutbound() — production storm shape (359 ops / 118 distinct / 241 duplicates)', () => {
  let db: Database;
  let engine: DurabilityEngine;

  beforeEach(() => {
    db = makeDb();
    engine = new DurabilityEngine(db);
    emitAlert.mockClear();
    clearAlertSource.mockClear();
  });

  afterEach(() => { db.close(); });

  // Live incident (fleet, one DM): a single inbound produced 359 outbound ops
  // of which only 118 carried distinct payloads — 241 were true duplicate
  // re-sends of payloads the user had ALREADY received. This test reproduces
  // that exact backlog shape: one echoed (delivered) op per distinct payload,
  // plus 241 pending duplicate copies distributed across those payloads. The
  // fixed drain must suppress every duplicate via the durable
  // (chat_jid, payload_hash) delivered-set — zero re-sends — and a second
  // drain pass must find nothing left to do (the storm terminates instead of
  // looping). Pre-fix, the drain re-sent all 241 pending copies.
  it('suppresses all 241 pending duplicates of already-delivered payloads — zero re-sends, storm terminates', async () => {
    const chatJid = 'storm-victim@s.whatsapp.net';
    const DISTINCT = 118;
    const TOTAL_OPS = 359;
    const DUPLICATES = TOTAL_OPS - DISTINCT; // 241

    // One delivered (echoed) op per distinct payload — the copies the user got.
    const echoedIds: number[] = [];
    for (let i = 0; i < DISTINCT; i++) {
      echoedIds.push(makeEchoedOp(engine, chatJid, `storm payload ${i}`, `WA_STORM_${i}`));
    }

    // 241 pending duplicate copies, cycling across the distinct payloads —
    // the replay-loop backlog that produced the duplicate sends in production.
    const pendingIds: number[] = [];
    for (let j = 0; j < DUPLICATES; j++) {
      pendingIds.push(makePendingTextOp(engine, { chatJid, text: `storm payload ${j % DISTINCT}` }));
    }
    expect(echoedIds.length + pendingIds.length).toBe(TOTAL_OPS);

    const messenger = makeMessenger(async () => ({ waMessageId: 'SHOULD_NEVER_SEND' }));
    const resent = await drainPendingOutbound(messenger, engine);

    // Zero duplicate deliveries — the durable delivered-set gates every copy.
    expect(messenger.sendMessage).not.toHaveBeenCalled();
    expect(resent).toBe(0);

    // Every duplicate terminalized against an echoed twin, none left pending.
    const rows = db.raw.prepare(
      `SELECT status, error FROM outbound_ops WHERE id IN (${pendingIds.join(',')})`,
    ).all() as Array<{ status: string; error: string | null }>;
    expect(rows).toHaveLength(DUPLICATES);
    expect(rows.every((r) => r.status === 'failed_permanent')).toBe(true);
    expect(rows.every((r) => String(r.error).startsWith('duplicate_suppressed:'))).toBe(true);

    // The delivered copies are untouched.
    const echoedRows = db.raw.prepare(
      `SELECT COUNT(*) AS n FROM outbound_ops WHERE status = 'echoed'`,
    ).get() as { n: number };
    expect(echoedRows.n).toBe(DISTINCT);

    // Second pass: the storm is terminal — nothing pending, nothing sent.
    const secondPass = await drainPendingOutbound(messenger, engine);
    expect(secondPass).toBe(0);
    expect(messenger.sendMessage).not.toHaveBeenCalled();
  });
});
