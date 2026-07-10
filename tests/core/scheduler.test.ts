/**
 * Tests for MessageScheduler (SP11)
 * TDD: tests written before implementation.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Database } from '../../src/core/database.ts';
import { MessageScheduler } from '../../src/core/scheduler.ts';
import type { ConnectionManager } from '../../src/transport/connection.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function makeMockConnection(): { mock: Partial<ConnectionManager>; sendRawCalls: Array<[string, Record<string, unknown>]>; sendMediaCalls: Array<unknown[]> } {
  const sendRawCalls: Array<[string, Record<string, unknown>]> = [];
  const sendMediaCalls: Array<unknown[]> = [];
  const mock: Partial<ConnectionManager> = {
    sendRaw: vi.fn(async (chatJid: string, content: Record<string, unknown>) => {
      sendRawCalls.push([chatJid, content]);
      return { waMessageId: 'mock-msg-id' };
    }),
    sendMedia: vi.fn(async (...args: unknown[]) => {
      sendMediaCalls.push(args);
      return { waMessageId: 'mock-media-id' };
    }),
  };
  return { mock, sendRawCalls, sendMediaCalls };
}

function insertScheduledMessage(
  raw: DatabaseSync,
  opts: {
    chatJid?: string;
    contentType?: string;
    payload?: string;
    scheduledAt?: number;
    status?: string;
    retryCount?: number;
    mediaBlob?: Buffer | null;
    sendStartedAt?: number | null;
  } = {},
): number {
  const {
    chatJid = '15550100001@s.whatsapp.net',
    contentType = 'text',
    payload = JSON.stringify({ text: 'Hello world' }),
    scheduledAt = Math.floor(Date.now() / 1000) - 10,
    status = 'pending',
    retryCount = 0,
    mediaBlob = null,
    sendStartedAt = null,
  } = opts;

  const stmt = raw.prepare(`
    INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status, retry_count, media_blob, send_started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(chatJid, contentType, payload, scheduledAt, status, retryCount, mediaBlob, sendStartedAt);
  return result.lastInsertRowid as number;
}

type SettlementFaultMode = 'throw_before_once' | 'commit_then_throw_once' | 'throw_before_always';

interface SettlementFault {
  restore: () => void;
  getCalls: () => number;
}

function injectSettlementFault(db: Database, mode: SettlementFaultMode): SettlementFault {
  const realPrepare = db.raw.prepare.bind(db.raw);
  let calls = 0;
  db.raw.prepare = ((sql: string) => {
    const statement = realPrepare(sql);
    const isSettlement =
      sql.includes("SET status = 'sent', sent_at") ||
      sql.includes("SET status = 'pending', sent_at") ||
      sql.includes("SET status = 'failed', sent_at");
    if (!isSettlement) return statement;

    return new Proxy(statement, {
      get(target, property) {
        if (property !== 'run') {
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (...args: Parameters<typeof target.run>) => {
          calls += 1;
          if (mode === 'throw_before_always' || (mode === 'throw_before_once' && calls === 1)) {
            throw new Error('injected post-send settlement failure');
          }
          const result = target.run(...args);
          if (mode === 'commit_then_throw_once' && calls === 1) {
            throw new Error('injected ambiguous local settlement result');
          }
          return result;
        };
      },
    });
  }) as typeof db.raw.prepare;

  return {
    restore: () => { db.raw.prepare = realPrepare; },
    getCalls: () => calls,
  };
}

function insertInvalidRecurringMessage(raw: DatabaseSync): number {
  const now = Math.floor(Date.now() / 1000);
  return Number(raw.prepare(
    `INSERT INTO scheduled_messages
       (chat_jid, content_type, payload, scheduled_at, status, retry_count, recurrence, next_run_at, run_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    '15550100005@s.whatsapp.net',
    'text',
    JSON.stringify({ text: 'invalid recurring settlement' }),
    now - 120,
    'pending',
    0,
    '99 99 99 99 99',
    now - 60,
    0,
  ).lastInsertRowid);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('MessageScheduler — tick()', () => {
  let db: Database;
  let { mock: conn } = makeMockConnection();

  beforeEach(() => {
    db = makeDb();
    const fresh = makeMockConnection();
    conn = fresh.mock;
  });

  it('picks up pending messages whose scheduled_at <= now and sends them', async () => {
    const id = insertScheduledMessage(db.raw, {
      scheduledAt: Math.floor(Date.now() / 1000) - 5,
      status: 'pending',
    });

    const scheduler = new MessageScheduler(db, conn as ConnectionManager, { intervalMs: 60_000, maxRetries: 3 });
    await scheduler.tick();

    const row = db.raw
      .prepare('SELECT status FROM scheduled_messages WHERE id = ?')
      .get(id) as { status: string };
    expect(row.status).toBe('sent');
  });

  it('does not resend a one-shot when the first post-send settlement attempt fails', async () => {
    const id = insertScheduledMessage(db.raw, { status: 'pending', retryCount: 0 });
    const fault = injectSettlementFault(db, 'throw_before_once');
    const scheduler = new MessageScheduler(db, conn as ConnectionManager,
      { intervalMs: 60_000, maxRetries: 3 });

    try {
      await scheduler.tick();
      await scheduler.tick();
    } finally { fault.restore(); }

    expect(conn.sendRaw).toHaveBeenCalledTimes(1);
    expect(fault.getCalls()).toBe(2);
    expect(db.raw.prepare(
      'SELECT status, retry_count, send_started_at FROM scheduled_messages WHERE id = ?',
    ).get(id)).toEqual({ status: 'sent', retry_count: 0, send_started_at: null });
  });

  it('accepts an already-applied one-shot settlement after an ambiguous local result', async () => {
    const id = insertScheduledMessage(db.raw, { status: 'pending', retryCount: 0 });
    const fault = injectSettlementFault(db, 'commit_then_throw_once');
    const scheduler = new MessageScheduler(db, conn as ConnectionManager,
      { intervalMs: 60_000, maxRetries: 3 });
    try { await scheduler.tick(); } finally { fault.restore(); }

    expect(conn.sendRaw).toHaveBeenCalledTimes(1);
    expect(fault.getCalls()).toBe(2);
    expect(db.raw.prepare(
      'SELECT status, retry_count, send_started_at FROM scheduled_messages WHERE id = ?',
    ).get(id)).toEqual({ status: 'sent', retry_count: 0, send_started_at: null });
  });

  it('fails closed after persistent one-shot settlement failures', async () => {
    const id = insertScheduledMessage(db.raw, { status: 'pending', retryCount: 0 });
    const fault = injectSettlementFault(db, 'throw_before_always');
    const scheduler = new MessageScheduler(db, conn as ConnectionManager,
      { intervalMs: 60_000, maxRetries: 3 });

    try {
      await scheduler.tick();
      await scheduler.tick();
    } finally { fault.restore(); }

    expect(conn.sendRaw).toHaveBeenCalledTimes(1);
    expect(fault.getCalls()).toBe(2);
    expect(db.raw.prepare(
      'SELECT status, retry_count, send_started_at FROM scheduled_messages WHERE id = ?',
    ).get(id)).toMatchObject({ status: 'processing', retry_count: 0 });
    expect((db.raw.prepare(
      'SELECT send_started_at FROM scheduled_messages WHERE id = ?',
    ).get(id) as { send_started_at: number | null }).send_started_at).not.toBeNull();

    scheduler.recoverStale();

    expect(db.raw.prepare(
      'SELECT status, retry_count, send_started_at, error FROM scheduled_messages WHERE id = ?',
    ).get(id)).toEqual({
      status: 'failed',
      retry_count: 0,
      send_started_at: null,
      error: 'Recovered after crash during scheduled send; manual verification required before retry',
    });
  });

  it('fails closed after persistent recurring settlement failures', async () => {
    const now = Math.floor(Date.now() / 1000);
    const id = Number(db.raw.prepare(
      `INSERT INTO scheduled_messages
         (chat_jid, content_type, payload, scheduled_at, status, retry_count, recurrence, next_run_at, run_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      '15550100002@s.whatsapp.net',
      'text',
      JSON.stringify({ text: 'recurring' }),
      now - 60,
      'pending',
      0,
      '* * * * *',
      now - 60,
      0,
    ).lastInsertRowid);
    const fault = injectSettlementFault(db, 'throw_before_always');
    const scheduler = new MessageScheduler(db, conn as ConnectionManager,
      { intervalMs: 60_000, maxRetries: 3 });

    try {
      await scheduler.tick();
      await scheduler.tick();
    } finally { fault.restore(); }

    expect(conn.sendRaw).toHaveBeenCalledTimes(1);
    expect(fault.getCalls()).toBe(2);
    const processingRow = db.raw.prepare(
      'SELECT status, retry_count, run_count, send_started_at FROM scheduled_messages WHERE id = ?',
    ).get(id) as { status: string; retry_count: number; run_count: number; send_started_at: number | null };
    expect(processingRow.status).toBe('processing');
    expect(processingRow.retry_count).toBe(0);
    expect(processingRow.run_count).toBe(0);
    expect(processingRow.send_started_at).not.toBeNull();

    scheduler.recoverStale();

    const recoveredRow = db.raw.prepare(
      'SELECT status, retry_count, run_count, send_started_at, next_run_at FROM scheduled_messages WHERE id = ?',
    ).get(id) as {
      status: string;
      retry_count: number;
      run_count: number;
      send_started_at: number | null;
      next_run_at: number;
    };
    expect(recoveredRow.status).toBe('pending');
    expect(recoveredRow.retry_count).toBe(0);
    expect(recoveredRow.run_count).toBe(0);
    expect(recoveredRow.send_started_at).toBeNull();
    expect(recoveredRow.next_run_at).toBeGreaterThan(now);
    expect(conn.sendRaw).toHaveBeenCalledTimes(1);
  });

  it('continues later claimed rows after a persistent post-send settlement failure', async () => {
    const firstId = insertScheduledMessage(db.raw, {
      chatJid: '15550100003@s.whatsapp.net',
      status: 'pending',
    });
    const secondId = insertScheduledMessage(db.raw, {
      chatJid: '15550100004@s.whatsapp.net',
      status: 'pending',
    });
    const fault = injectSettlementFault(db, 'throw_before_always');
    const scheduler = new MessageScheduler(db, conn as ConnectionManager,
      { intervalMs: 60_000, maxRetries: 3 });

    try {
      await scheduler.tick();
    } finally { fault.restore(); }

    expect(conn.sendRaw).toHaveBeenCalledTimes(2);
    expect(fault.getCalls()).toBe(4);
    const rows = db.raw.prepare(
      `SELECT id, status, retry_count, send_started_at
       FROM scheduled_messages WHERE id IN (?, ?) ORDER BY id`,
    ).all(firstId, secondId) as unknown as Array<{
      id: number;
      status: string;
      retry_count: number;
      send_started_at: number | null;
    }>;
    expect(rows).toEqual([
      { id: firstId, status: 'processing', retry_count: 0,
        send_started_at: expect.any(Number) },
      { id: secondId, status: 'processing', retry_count: 0,
        send_started_at: expect.any(Number) },
    ]);
  });

  it('accepts an already-applied invalid-cron settlement after an ambiguous local result', async () => {
    const id = insertInvalidRecurringMessage(db.raw);
    const fault = injectSettlementFault(db, 'commit_then_throw_once');
    const scheduler = new MessageScheduler(db, conn as ConnectionManager,
      { intervalMs: 60_000, maxRetries: 3 });

    try {
      await scheduler.tick();
    } finally { fault.restore(); }

    expect(conn.sendRaw).toHaveBeenCalledTimes(1);
    expect(fault.getCalls()).toBe(2);
    const row = db.raw.prepare(
      `SELECT status, sent_at, error, retry_count, run_count, send_started_at
       FROM scheduled_messages WHERE id = ?`,
    ).get(id) as {
      status: string;
      sent_at: number;
      error: string;
      retry_count: number;
      run_count: number;
      send_started_at: number | null;
    };
    expect(row).toMatchObject({
      status: 'failed',
      sent_at: expect.any(Number),
      error: expect.stringContaining('Invalid recurrence after send:'),
      retry_count: 0,
      run_count: 0,
      send_started_at: null,
    });
  });

  it('fails closed after persistent invalid-cron settlement failures', async () => {
    const id = insertInvalidRecurringMessage(db.raw);
    const fault = injectSettlementFault(db, 'throw_before_always');
    const scheduler = new MessageScheduler(db, conn as ConnectionManager,
      { intervalMs: 60_000, maxRetries: 3 });

    try {
      await scheduler.tick();
      await scheduler.tick();
    } finally { fault.restore(); }

    expect(conn.sendRaw).toHaveBeenCalledTimes(1);
    expect(fault.getCalls()).toBe(2);
    expect(db.raw.prepare(
      `SELECT status, sent_at, error, retry_count, run_count, send_started_at
       FROM scheduled_messages WHERE id = ?`,
    ).get(id)).toMatchObject({
      status: 'processing',
      sent_at: null,
      error: null,
      retry_count: 0,
      run_count: 0,
      send_started_at: expect.any(Number),
    });

    scheduler.recoverStale();

    const recovered = db.raw.prepare(
      `SELECT status, error, retry_count, run_count, send_started_at
       FROM scheduled_messages WHERE id = ?`,
    ).get(id) as {
      status: string;
      error: string;
      retry_count: number;
      run_count: number;
      send_started_at: number | null;
    };
    expect(recovered.status).toBe('failed');
    expect(recovered.error).toMatch(/cannot compute next slot/i);
    expect(recovered.retry_count).toBe(0);
    expect(recovered.run_count).toBe(0);
    expect(recovered.send_started_at).toBeNull();
    expect(conn.sendRaw).toHaveBeenCalledTimes(1);
  });

  it('ignores messages scheduled in the future', async () => {
    const id = insertScheduledMessage(db.raw, {
      scheduledAt: Math.floor(Date.now() / 1000) + 9999,
      status: 'pending',
    });

    const scheduler = new MessageScheduler(db, conn as ConnectionManager, { intervalMs: 60_000, maxRetries: 3 });
    await scheduler.tick();

    const row = db.raw
      .prepare('SELECT status FROM scheduled_messages WHERE id = ?')
      .get(id) as { status: string };
    expect(row.status).toBe('pending');
    expect(conn.sendRaw).not.toHaveBeenCalled();
  });

  it('sets status to sent and records sent_at on success', async () => {
    const before = Math.floor(Date.now() / 1000);
    const id = insertScheduledMessage(db.raw, { status: 'pending' });

    const scheduler = new MessageScheduler(db, conn as ConnectionManager, { intervalMs: 60_000, maxRetries: 3 });
    await scheduler.tick();

    const row = db.raw
      .prepare('SELECT status, sent_at FROM scheduled_messages WHERE id = ?')
      .get(id) as { status: string; sent_at: number };
    expect(row.status).toBe('sent');
    expect(row.sent_at).toBeGreaterThanOrEqual(before);
  });

  it('clears the send-start marker after a successful one-shot send', async () => {
    const id = insertScheduledMessage(db.raw, { status: 'pending' });

    const scheduler = new MessageScheduler(db, conn as ConnectionManager, { intervalMs: 60_000, maxRetries: 3 });
    await scheduler.tick();

    const row = db.raw
      .prepare('SELECT status, send_started_at FROM scheduled_messages WHERE id = ?')
      .get(id) as { status: string; send_started_at: number | null };
    expect(row).toEqual({ status: 'sent', send_started_at: null });
  });

  it('increments retry_count on send failure', async () => {
    const failConn: Partial<ConnectionManager> = {
      sendRaw: vi.fn().mockRejectedValue(new Error('send failed')),
      sendMedia: vi.fn().mockRejectedValue(new Error('send failed')),
    };
    const id = insertScheduledMessage(db.raw, { status: 'pending', retryCount: 0 });

    const scheduler = new MessageScheduler(db, failConn as ConnectionManager, { intervalMs: 60_000, maxRetries: 3 });
    await scheduler.tick();

    const row = db.raw
      .prepare('SELECT status, retry_count FROM scheduled_messages WHERE id = ?')
      .get(id) as { status: string; retry_count: number };
    expect(row.retry_count).toBe(1);
    expect(row.status).toBe('pending');
  });

  it('clears the send-start marker when a send failure returns the row to pending', async () => {
    const failConn: Partial<ConnectionManager> = {
      sendRaw: vi.fn().mockRejectedValue(new Error('send failed')),
      sendMedia: vi.fn().mockRejectedValue(new Error('send failed')),
    };
    const id = insertScheduledMessage(db.raw, { status: 'pending', retryCount: 0 });

    const scheduler = new MessageScheduler(db, failConn as ConnectionManager, { intervalMs: 60_000, maxRetries: 3 });
    await scheduler.tick();

    const row = db.raw
      .prepare('SELECT status, retry_count, send_started_at FROM scheduled_messages WHERE id = ?')
      .get(id) as { status: string; retry_count: number; send_started_at: number | null };
    expect(row).toEqual({ status: 'pending', retry_count: 1, send_started_at: null });
  });

  it('sets status to failed after maxRetries exceeded', async () => {
    const failConn: Partial<ConnectionManager> = {
      sendRaw: vi.fn().mockRejectedValue(new Error('permanent failure')),
      sendMedia: vi.fn().mockRejectedValue(new Error('permanent failure')),
    };
    const id = insertScheduledMessage(db.raw, { status: 'pending', retryCount: 2 });

    const scheduler = new MessageScheduler(db, failConn as ConnectionManager, { intervalMs: 60_000, maxRetries: 3 });
    await scheduler.tick();

    const row = db.raw
      .prepare('SELECT status, error FROM scheduled_messages WHERE id = ?')
      .get(id) as { status: string; error: string };
    expect(row.status).toBe('failed');
    expect(row.error).toContain('permanent failure');
  });

  it('does not pick up rows already in processing status (no double-claim)', async () => {
    const id = insertScheduledMessage(db.raw, {
      status: 'processing',
      scheduledAt: Math.floor(Date.now() / 1000) - 5,
    });

    const scheduler = new MessageScheduler(db, conn as ConnectionManager, { intervalMs: 60_000, maxRetries: 3 });
    await scheduler.tick();

    // Should not have been touched — it was already processing
    const row = db.raw
      .prepare('SELECT status FROM scheduled_messages WHERE id = ?')
      .get(id) as { status: string };
    expect(row.status).toBe('processing');
    expect(conn.sendRaw).not.toHaveBeenCalled();
  });

  it('reconstructs media Buffer from media_blob BLOB column (SP9)', async () => {
    const { mock: conn2, sendMediaCalls } = makeMockConnection();
    const mediaContent = Buffer.from('fake-image-data');
    insertScheduledMessage(db.raw, {
      chatJid: 'media@s.whatsapp.net',
      contentType: 'image',
      payload: JSON.stringify({ type: 'image', caption: 'test', mimetype: 'image/jpeg' }),
      mediaBlob: mediaContent,
    });

    const scheduler = new MessageScheduler(db, conn2 as ConnectionManager, { intervalMs: 60_000, maxRetries: 3 });
    await scheduler.tick();

    expect(sendMediaCalls).toHaveLength(1);
    const [chatJid, media] = sendMediaCalls[0] as [string, { type: string; buffer: Buffer; caption: string; mimetype: string }];
    expect(chatJid).toBe('media@s.whatsapp.net');
    expect(media.type).toBe('image');
    expect(media.caption).toBe('test');
    expect(media.mimetype).toBe('image/jpeg');
    expect(Buffer.isBuffer(media.buffer)).toBe(true);
    expect(media.buffer.toString()).toBe('fake-image-data');
  });

  it('passes correct chatJid and text to sendRaw for text messages', async () => {
    const { mock: conn2, sendRawCalls } = makeMockConnection();
    insertScheduledMessage(db.raw, {
      chatJid: 'test123@s.whatsapp.net',
      contentType: 'text',
      payload: JSON.stringify({ text: 'Test message' }),
    });

    const scheduler = new MessageScheduler(db, conn2 as ConnectionManager, { intervalMs: 60_000, maxRetries: 3 });
    await scheduler.tick();

    expect(sendRawCalls).toHaveLength(1);
    expect(sendRawCalls[0][0]).toBe('test123@s.whatsapp.net');
    expect(sendRawCalls[0][1]).toMatchObject({ text: 'Test message' });
  });
});

describe('MessageScheduler — recoverStale()', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  it('resets processing rows with no started send marker to pending', () => {
    const id = insertScheduledMessage(db.raw, { status: 'processing' });
    const { mock: conn } = makeMockConnection();

    const scheduler = new MessageScheduler(db, conn as ConnectionManager, { intervalMs: 60_000, maxRetries: 3 });
    scheduler.recoverStale();

    const row = db.raw
      .prepare('SELECT status FROM scheduled_messages WHERE id = ?')
      .get(id) as { status: string };
    expect(row.status).toBe('pending');
  });

  it('fails closed instead of re-queueing a processing row whose send already started', () => {
    const id = insertScheduledMessage(db.raw, {
      status: 'processing',
      sendStartedAt: Math.floor(Date.now() / 1000) - 30,
    });
    const { mock: conn } = makeMockConnection();

    const scheduler = new MessageScheduler(db, conn as ConnectionManager, { intervalMs: 60_000, maxRetries: 3 });
    scheduler.recoverStale();

    const row = db.raw
      .prepare('SELECT status, error, send_started_at FROM scheduled_messages WHERE id = ?')
      .get(id) as { status: string; error: string; send_started_at: number | null };
    expect(row).toEqual({
      status: 'failed',
      error: 'Recovered after crash during scheduled send; manual verification required before retry',
      send_started_at: null,
    });
  });

  it('does not touch rows with other statuses', () => {
    const sentId = insertScheduledMessage(db.raw, { status: 'sent' });
    const failedId = insertScheduledMessage(db.raw, { status: 'failed' });
    const pendingId = insertScheduledMessage(db.raw, { status: 'pending' });
    const { mock: conn } = makeMockConnection();

    const scheduler = new MessageScheduler(db, conn as ConnectionManager, { intervalMs: 60_000, maxRetries: 3 });
    scheduler.recoverStale();

    const rows = db.raw
      .prepare('SELECT id, status FROM scheduled_messages ORDER BY id')
      .all() as Array<{ id: number; status: string }>;
    const statusMap = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    expect(statusMap[sentId]).toBe('sent');
    expect(statusMap[failedId]).toBe('failed');
    expect(statusMap[pendingId]).toBe('pending');
  });

  // #1069 hardening: a crash mid-send of a RECURRING occurrence must not destroy
  // the whole schedule. The in-tick retry path already skips a failed occurrence
  // to the next slot (keeping the schedule alive); recoverStale() must mirror that
  // for the uncertain-send case — fail closed on REPLAY (do not re-send the
  // uncertain occurrence) while keeping the recurring schedule pending for its
  // next slot. Previously this row was marked 'failed', silently killing it.
  it('keeps a recurring schedule alive (skips the uncertain occurrence to the next slot) instead of failing it permanently', () => {
    const now = Math.floor(Date.now() / 1000);
    db.raw
      .prepare(
        `INSERT INTO scheduled_messages
           (chat_jid, content_type, payload, scheduled_at, status, retry_count, recurrence, next_run_at, run_count, send_started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        '15550900001@s.whatsapp.net',
        'text',
        JSON.stringify({ text: 'daily recurring' }),
        now - 120,
        'processing',
        2, // mid-flight retry count must be reset so failures don't accumulate across occurrences
        '* * * * *', // valid cron — every minute
        now - 60, // the occurrence that was being sent when the crash hit
        7,
        now - 30, // send_started_at set → uncertain whether it actually delivered
      );
    const { mock: conn, sendRawCalls } = makeMockConnection();

    const scheduler = new MessageScheduler(db, conn as ConnectionManager, { intervalMs: 60_000, maxRetries: 3 });
    scheduler.recoverStale();

    const row = db.raw
      .prepare('SELECT status, send_started_at, next_run_at, retry_count, run_count, error FROM scheduled_messages WHERE id = ?')
      .get(1) as {
        status: string;
        send_started_at: number | null;
        next_run_at: number;
        retry_count: number;
        run_count: number;
        error: string | null;
      };
    expect(row.status).toBe('pending'); // schedule survives
    expect(row.send_started_at).toBeNull(); // marker cleared
    expect(row.next_run_at).toBeGreaterThan(now); // advanced PAST the uncertain occurrence
    expect(row.retry_count).toBe(0); // reset so per-occurrence failures don't accumulate
    expect(row.run_count).toBe(7); // unchanged — the uncertain occurrence is NOT counted as sent
    expect(row.error).toMatch(/crash|uncertain|skipped/i);
    // Fail closed on replay: recoverStale must never re-send the uncertain occurrence.
    expect(sendRawCalls).toHaveLength(0);
  });

  it('marks a recurring uncertain-send row failed only when the next slot is uncomputable (invalid cron)', () => {
    const now = Math.floor(Date.now() / 1000);
    db.raw
      .prepare(
        `INSERT INTO scheduled_messages
           (chat_jid, content_type, payload, scheduled_at, status, retry_count, recurrence, next_run_at, run_count, send_started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        '15550900002@s.whatsapp.net',
        'text',
        JSON.stringify({ text: 'bad cron recurring' }),
        now - 120,
        'processing',
        0,
        '99 99 99 99 99', // out-of-range cron → nextCronRun throws → cannot keep alive
        now - 60,
        0,
        now - 30,
      );
    const { mock: conn } = makeMockConnection();

    const scheduler = new MessageScheduler(db, conn as ConnectionManager, { intervalMs: 60_000, maxRetries: 3 });
    scheduler.recoverStale();

    const row = db.raw
      .prepare('SELECT status, send_started_at, error FROM scheduled_messages WHERE id = ?')
      .get(1) as { status: string; send_started_at: number | null; error: string | null };
    expect(row.status).toBe('failed'); // graceful degradation: cannot compute a next slot
    expect(row.send_started_at).toBeNull();
    expect(row.error).toMatch(/cron|recurrence|next slot/i);
  });
});

describe('MessageScheduler — start/stop lifecycle', () => {
  it('start() sets up interval and stop() clears it', () => {
    const db = makeDb();
    const { mock: conn } = makeMockConnection();
    const scheduler = new MessageScheduler(db, conn as ConnectionManager, { intervalMs: 10_000, maxRetries: 3 });

    expect(() => scheduler.start()).not.toThrow();
    expect(() => scheduler.stop()).not.toThrow();
  });

  it('start() is idempotent — a second call does not arm a second interval', () => {
    const db = makeDb();
    const { mock: conn } = makeMockConnection();
    const scheduler = new MessageScheduler(db, conn as ConnectionManager, { intervalMs: 10_000, maxRetries: 3 });
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    scheduler.start();
    scheduler.start(); // double-start must be a no-op, not an orphaned second interval

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    scheduler.stop();
    setIntervalSpy.mockRestore();
  });

  it('logs and suppresses rejected immediate and interval ticks', async () => {
    const log = {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
    };
    vi.resetModules();
    vi.doMock('../../src/logger.ts', () => ({
      createChildLogger: vi.fn(() => log),
      default: log,
      flushLogger: vi.fn(async () => undefined),
    }));
    const [{ Database: IsolatedDatabase }, { MessageScheduler: IsolatedMessageScheduler }] = await Promise.all([
      import('../../src/core/database.ts'),
      import('../../src/core/scheduler.ts'),
    ]);
    vi.useFakeTimers();
    const db = new IsolatedDatabase(':memory:');
    db.open();
    const { mock: conn } = makeMockConnection();
    const scheduler = new IsolatedMessageScheduler(db, conn as ConnectionManager, { intervalMs: 10_000, maxRetries: 3 });
    const tickSpy = vi.spyOn(scheduler, 'tick').mockRejectedValue(new Error('tick failed'));

    try {
      scheduler.start();
      await Promise.resolve();
      await Promise.resolve();

      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'scheduler initial tick failed',
      );
      expect(tickSpy).toHaveBeenCalledTimes(1);
      log.error.mockClear();

      await vi.advanceTimersByTimeAsync(10_000);

      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'scheduler tick failed',
      );
      expect(tickSpy).toHaveBeenCalledTimes(2);
    } finally {
      scheduler.stop();
      tickSpy.mockRestore();
      db.close();
      vi.useRealTimers();
      vi.doUnmock('../../src/logger.ts');
      vi.resetModules();
    }
  });
});
describe('MessageScheduler — recurring message scheduling', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });




  it('does not pick up recurring rows when next_run_at is NULL even if scheduled_at has passed', async () => {
    const { mock: conn2, sendRawCalls } = makeMockConnection();
    const stmt = db.raw.prepare(`
      INSERT INTO scheduled_messages
        (chat_jid, content_type, payload, scheduled_at, status, retry_count, recurrence, media_blob)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      '15550600003@s.whatsapp.net',
      'text',
      JSON.stringify({ text: 'no next run' }),
      Math.floor(Date.now() / 1000) - 120,
      'pending',
      0,
      '* * * * *',
      null,
    );

    const scheduler = new MessageScheduler(db, conn2 as ConnectionManager, { intervalMs: 60_000, maxRetries: 3 });
    await scheduler.tick();

    expect(sendRawCalls).toHaveLength(0);
    const row = db.raw
      .prepare('SELECT status FROM scheduled_messages')
      .get() as { status: string };
    expect(row.status).toBe('pending');
  });
});

// ─── Additional tests: executeSend media fallback paths ───────────────────────

describe('MessageScheduler — executeSend media fallback paths', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });



  it('treats a media row with no buffer and no media_blob as a send failure and applies the retry path', async () => {
    const { mock: conn2, sendMediaCalls } = makeMockConnection();
    const id = insertScheduledMessage(db.raw, {
      chatJid: '15550600006@s.whatsapp.net',
      contentType: 'image',
      payload: JSON.stringify({ type: 'image', caption: 'no buffer' }),
      mediaBlob: null,
      retryCount: 0,
    });

    const scheduler = new MessageScheduler(db, conn2 as ConnectionManager, { intervalMs: 60_000, maxRetries: 3 });
    await scheduler.tick();

    expect(sendMediaCalls).toHaveLength(0);
    const row = db.raw
      .prepare('SELECT status, retry_count FROM scheduled_messages WHERE id = ?')
      .get(id) as { status: string; retry_count: number };
    expect(row.status).toBe('pending');
    expect(row.retry_count).toBe(1);
  });

  it('permanently fails a media row (no buffer, no media_blob) once retries are exhausted, embedding the row id in the error', async () => {
    const { mock: conn2, sendMediaCalls } = makeMockConnection();
    const id = insertScheduledMessage(db.raw, {
      chatJid: '15550600007@s.whatsapp.net',
      contentType: 'audio',
      payload: JSON.stringify({ type: 'audio' }),
      mediaBlob: null,
      retryCount: 2,
    });

    const scheduler = new MessageScheduler(db, conn2 as ConnectionManager, { intervalMs: 60_000, maxRetries: 3 });
    await scheduler.tick();

    expect(sendMediaCalls).toHaveLength(0);
    const row = db.raw
      .prepare('SELECT status, error FROM scheduled_messages WHERE id = ?')
      .get(id) as { status: string; error: string };
    expect(row.status).toBe('failed');
    expect(row.error).toContain('no media_blob and no buffer in payload');
    expect(row.error).toContain(`id=${id}`);
  });

  it('routes every non-text content type (image, video, audio, document, sticker) through sendMedia and never sendRaw', async () => {
    const { mock: conn2, sendMediaCalls, sendRawCalls } = makeMockConnection();
    const types = ['image', 'video', 'audio', 'document', 'sticker'];
    for (const t of types) {
      insertScheduledMessage(db.raw, {
        chatJid: '15550600008@s.whatsapp.net',
        contentType: t,
        payload: JSON.stringify({ type: t }),
        mediaBlob: Buffer.from('payload-bytes'),
      });
    }

    const scheduler = new MessageScheduler(db, conn2 as ConnectionManager, { intervalMs: 60_000, maxRetries: 3 });
    await scheduler.tick();

    expect(sendMediaCalls).toHaveLength(types.length);
    expect(sendRawCalls).toHaveLength(0);
  });

});

// ─── Additional tests: tick() edge cases ──────────────────────────────────────

describe('MessageScheduler — tick() additional edge cases', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  it('processes multiple due messages in a single tick', async () => {
    const { mock: conn2, sendRawCalls } = makeMockConnection();
    insertScheduledMessage(db.raw, { chatJid: '15550700001@s.whatsapp.net' });
    insertScheduledMessage(db.raw, { chatJid: '15550700002@s.whatsapp.net' });
    insertScheduledMessage(db.raw, { chatJid: '15550700003@s.whatsapp.net' });

    const scheduler = new MessageScheduler(db, conn2 as ConnectionManager, { intervalMs: 60_000, maxRetries: 3 });
    await scheduler.tick();

    expect(sendRawCalls).toHaveLength(3);
    const statuses = db.raw
      .prepare('SELECT status FROM scheduled_messages ORDER BY id')
      .all() as Array<{ status: string }>;
    expect(statuses.every((r) => r.status === 'sent')).toBe(true);
  });

  it('treats a malformed JSON payload as a send failure and applies the retry path', async () => {
    const { mock: conn2, sendRawCalls } = makeMockConnection();
    const id = insertScheduledMessage(db.raw, {
      chatJid: '15550700004@s.whatsapp.net',
      payload: '{not valid json',
    });

    const scheduler = new MessageScheduler(db, conn2 as ConnectionManager, { intervalMs: 60_000, maxRetries: 3 });
    await scheduler.tick();

    expect(sendRawCalls).toHaveLength(0);
    const row = db.raw
      .prepare('SELECT status, retry_count FROM scheduled_messages WHERE id = ?')
      .get(id) as { status: string; retry_count: number };
    expect(row.status).toBe('pending');
    expect(row.retry_count).toBe(1);
  });

  it('serializes a non-Error rejection into the error column via String(err)', async () => {
    const failConn: Partial<ConnectionManager> = {
      sendRaw: vi.fn().mockRejectedValue('string-thrown-not-an-Error'),
      sendMedia: vi.fn().mockRejectedValue('string-thrown-not-an-Error'),
    };
    const id = insertScheduledMessage(db.raw, {
      chatJid: '15550700005@s.whatsapp.net',
      retryCount: 2,
    });

    const scheduler = new MessageScheduler(db, failConn as ConnectionManager, { intervalMs: 60_000, maxRetries: 3 });
    await scheduler.tick();

    const row = db.raw
      .prepare('SELECT status, error FROM scheduled_messages WHERE id = ?')
      .get(id) as { status: string; error: string };
    expect(row.status).toBe('failed');
    expect(row.error).toBe('string-thrown-not-an-Error');
  });

  it('resolves without sending when there are no scheduled_messages rows at all (early-return path)', async () => {
    const { mock: conn2, sendRawCalls } = makeMockConnection();
    const scheduler = new MessageScheduler(db, conn2 as ConnectionManager, { intervalMs: 60_000, maxRetries: 3 });
    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(sendRawCalls).toHaveLength(0);
  });

  it('continues processing subsequent rows after one row fails mid-tick (per-row try/catch isolation)', async () => {
    let firstCall = true;
    const mixedConn: Partial<ConnectionManager> = {
      sendRaw: vi.fn(async () => {
        if (firstCall) {
          firstCall = false;
          throw new Error('first row fails');
        }
        return { waMessageId: 'ok' };
      }),
      sendMedia: vi.fn(async () => ({ waMessageId: 'ok' })),
    };
    const failingId = insertScheduledMessage(db.raw, { chatJid: '15550700006@s.whatsapp.net' });
    const okId = insertScheduledMessage(db.raw, { chatJid: '15550700007@s.whatsapp.net' });

    const scheduler = new MessageScheduler(db, mixedConn as ConnectionManager, { intervalMs: 60_000, maxRetries: 3 });
    await scheduler.tick();

    const rows = db.raw
      .prepare('SELECT id, status, retry_count FROM scheduled_messages ORDER BY id')
      .all() as Array<{ id: number; status: string; retry_count: number }>;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[failingId].status).toBe('pending');
    expect(byId[failingId].retry_count).toBe(1);
    expect(byId[okId].status).toBe('sent');
    expect(byId[okId].retry_count).toBe(0);
  });
});

// ─── Additional tests: recoverStale() with multiple stale rows ────────────────

describe('MessageScheduler — recoverStale() multi-row', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  it('recovers every processing row in one call while leaving others untouched', () => {
    const { mock: conn } = makeMockConnection();
    const stale1 = insertScheduledMessage(db.raw, { status: 'processing' });
    const stale2 = insertScheduledMessage(db.raw, { status: 'processing' });
    const pendingId = insertScheduledMessage(db.raw, { status: 'pending' });
    const sentId = insertScheduledMessage(db.raw, { status: 'sent' });

    const scheduler = new MessageScheduler(db, conn as ConnectionManager, { intervalMs: 60_000, maxRetries: 3 });
    scheduler.recoverStale();

    const rows = db.raw
      .prepare('SELECT id, status FROM scheduled_messages ORDER BY id')
      .all() as Array<{ id: number; status: string }>;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    expect(byId[stale1]).toBe('pending');
    expect(byId[stale2]).toBe('pending');
    expect(byId[pendingId]).toBe('pending');
    expect(byId[sentId]).toBe('sent');
  });

  it('is a no-op (and does not throw) when no rows are in processing status', () => {
    const { mock: conn } = makeMockConnection();
    insertScheduledMessage(db.raw, { status: 'pending' });
    insertScheduledMessage(db.raw, { status: 'sent' });
    insertScheduledMessage(db.raw, { status: 'failed' });

    const scheduler = new MessageScheduler(db, conn as ConnectionManager, { intervalMs: 60_000, maxRetries: 3 });
    expect(() => scheduler.recoverStale()).not.toThrow();

    const rows = db.raw
      .prepare('SELECT status FROM scheduled_messages ORDER BY id')
      .all() as Array<{ status: string }>;
    expect(rows.map((r) => r.status)).toEqual(['pending', 'sent', 'failed']);
  });
});

// ─── scheduler.ts uncovered-branch coverage ──────────────────────────────────

describe('scheduler.ts uncovered-branch coverage', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  // Cover line 136: recurring message happy path — send succeeds, nextCronRun
  // succeeds, row is re-armed with status='pending', updated next_run_at and
  // an incremented run_count.
  it('re-arms a recurring row (valid cron, due next_run_at) by keeping it pending, bumping run_count, and advancing next_run_at', async () => {
    const { mock: conn2, sendRawCalls } = makeMockConnection();
    const now = Math.floor(Date.now() / 1000);
    db.raw
      .prepare(
        `INSERT INTO scheduled_messages
           (chat_jid, content_type, payload, scheduled_at, status, retry_count, recurrence, next_run_at, run_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        '15550800001@s.whatsapp.net',
        'text',
        JSON.stringify({ text: 'recurring tick' }),
        now - 120,
        'pending',
        0,
        '* * * * *', // every minute — valid cron, always due
        now - 60, // next_run_at in the past → eligible
        0,
      );

    const scheduler = new MessageScheduler(db, conn2 as ConnectionManager, { intervalMs: 60_000, maxRetries: 3 });
    await scheduler.tick();

    expect(sendRawCalls).toHaveLength(1);
    expect(sendRawCalls[0][0]).toBe('15550800001@s.whatsapp.net');
    const row = db.raw
      .prepare('SELECT status, run_count, next_run_at, sent_at FROM scheduled_messages WHERE id = ?')
      .get(1) as { status: string; run_count: number; next_run_at: number; sent_at: number };
    expect(row.status).toBe('pending');
    expect(row.run_count).toBe(1);
    expect(row.sent_at).toBeGreaterThanOrEqual(now);
    expect(row.next_run_at).toBeGreaterThan(now);
  });

  // Cover the cronErr catch block (lines 118-128): a recurring row whose
  // recurrence cannot be parsed is marked permanently 'failed' after the send
  // itself succeeds, with the cron error embedded in the error column.
  it('marks a recurring row as failed when nextCronRun throws after a successful send (invalid recurrence)', async () => {
    const { mock: conn2, sendRawCalls } = makeMockConnection();
    const now = Math.floor(Date.now() / 1000);
    db.raw
      .prepare(
        `INSERT INTO scheduled_messages
           (chat_jid, content_type, payload, scheduled_at, status, retry_count, recurrence, next_run_at, run_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        '15550800002@s.whatsapp.net',
        'text',
        JSON.stringify({ text: 'bad cron' }),
        now - 120,
        'pending',
        0,
        '99 99 99 99 99', // syntactically out-of-range cron → nextCronRun throws
        now - 60,
        0,
      );

    const scheduler = new MessageScheduler(db, conn2 as ConnectionManager, { intervalMs: 60_000, maxRetries: 3 });
    await scheduler.tick();

    // The send itself happened, but the row was marked failed by the cron-error branch.
    expect(sendRawCalls).toHaveLength(1);
    const row = db.raw
      .prepare('SELECT status, error FROM scheduled_messages WHERE id = ?')
      .get(1) as { status: string; error: string };
    expect(row.status).toBe('failed');
    expect(row.error).toContain('Invalid recurrence after send:');
  });

  it('fails a retry-exhausted recurring row when the next retry slot cannot be computed', async () => {
    const failConn: Partial<ConnectionManager> = {
      sendRaw: vi.fn().mockRejectedValue(new Error('send still failing')),
      sendMedia: vi.fn().mockRejectedValue(new Error('send still failing')),
    };
    const now = Math.floor(Date.now() / 1000);
    const result = db.raw
      .prepare(
        `INSERT INTO scheduled_messages
           (chat_jid, content_type, payload, scheduled_at, status, retry_count, recurrence, next_run_at, run_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        '15550800006@s.whatsapp.net',
        'text',
        JSON.stringify({ text: 'bad retry cron' }),
        now - 120,
        'pending',
        2,
        '99 99 99 99 99',
        now - 60,
        0,
      );
    const id = Number(result.lastInsertRowid);

    const scheduler = new MessageScheduler(db, failConn as ConnectionManager, { intervalMs: 60_000, maxRetries: 3 });
    await scheduler.tick();

    expect(failConn.sendRaw).toHaveBeenCalledTimes(1);
    const row = db.raw
      .prepare('SELECT status, retry_count, error, send_started_at, next_run_at FROM scheduled_messages WHERE id = ?')
      .get(id) as {
        status: string;
        retry_count: number;
        error: string | null;
        send_started_at: number | null;
        next_run_at: number;
      };
    expect(row.status).toBe('failed');
    expect(row.retry_count).toBe(3);
    expect(row.send_started_at).toBeNull();
    expect(row.next_run_at).toBe(now - 60);
    expect(row.error).toBe('Recurring failed (cannot compute next slot): send still failing');
  });

  // Cover line 194: legacy fallback that deserialises a Buffer encoded in JSON
  // as { type: 'Buffer', data: number[] } when there is no media_blob.
  it('exercises the legacy { type: "Buffer", data: [] } media fallback (no media_blob) and marks the row sent', async () => {
    const { mock: conn2, sendMediaCalls } = makeMockConnection();
    const bytes = [104, 105, 33]; // 'hi!'
    db.raw
      .prepare(
        `INSERT INTO scheduled_messages
           (chat_jid, content_type, payload, scheduled_at, status, retry_count, recurrence, next_run_at, media_blob)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      )
      .run(
        '15550800003@s.whatsapp.net',
        'image',
        JSON.stringify({ type: 'image', caption: 'legacy-typed', buffer: { type: 'Buffer', data: bytes } }),
        Math.floor(Date.now() / 1000) - 10,
        'pending',
        0,
      );

    const scheduler = new MessageScheduler(db, conn2 as ConnectionManager, { intervalMs: 60_000, maxRetries: 3 });
    await scheduler.tick();

    // sendMedia is invoked (proving the typed-Buffer fallback branch ran
    // rather than the no-buffer throw path).
    expect(sendMediaCalls).toHaveLength(1);
    const [chatJid, media] = sendMediaCalls[0] as [string, { type: string; caption: string; buffer: unknown }];
    expect(chatJid).toBe('15550800003@s.whatsapp.net');
    expect(media.type).toBe('image');
    // Line 200: non-buffer legacy fields are merged back into the send payload.
    expect(media.caption).toBe('legacy-typed');
    const row = db.raw
      .prepare('SELECT status FROM scheduled_messages WHERE id = ?')
      .get(1) as { status: string };
    expect(row.status).toBe('sent');
  });

  // Cover line 196: legacy fallback where bufferData is a bare number[] (not
  // the { type: 'Buffer', data: [] } shape) and there is no media_blob.
  it('exercises the legacy bare-number[] media fallback (no media_blob) and marks the row sent', async () => {
    const { mock: conn2, sendMediaCalls } = makeMockConnection();
    const bytes = [65, 66, 67]; // 'ABC'
    db.raw
      .prepare(
        `INSERT INTO scheduled_messages
           (chat_jid, content_type, payload, scheduled_at, status, retry_count, recurrence, next_run_at, media_blob)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      )
      .run(
        '15550800004@s.whatsapp.net',
        'document',
        JSON.stringify({ type: 'document', filename: 'doc.bin', buffer: bytes }),
        Math.floor(Date.now() / 1000) - 10,
        'pending',
        0,
      );

    const scheduler = new MessageScheduler(db, conn2 as ConnectionManager, { intervalMs: 60_000, maxRetries: 3 });
    await scheduler.tick();

    expect(sendMediaCalls).toHaveLength(1);
    const [chatJid, media] = sendMediaCalls[0] as [string, { type: string; filename: string; buffer: unknown }];
    expect(chatJid).toBe('15550800004@s.whatsapp.net');
    expect(media.type).toBe('document');
    // Line 200: non-buffer legacy fields are merged back into the send payload.
    expect(media.filename).toBe('doc.bin');
    const row = db.raw
      .prepare('SELECT status FROM scheduled_messages WHERE id = ?')
      .get(1) as { status: string };
    expect(row.status).toBe('sent');
  });

  // NOTE: The `cronErr instanceof Error ? ... : String(cronErr)` ternary's
  // String(cronErr) branch is unreachable from this test surface without
  // mocking nextCronRun, because cron.ts only ever throws `new Error(...)`.
  // See the FINAL REPORT for the unreachable-branches rationale.
});

// ─── advanceRecurringRun catch-up / skip-count coverage (#1330) ────────────────
// The missed-occurrence skip loop and its MISSED_OCCURRENCE_SCAN_CAP bound were
// untested: the other recurring tests only exercise the immediate-next-slot case
// (0–1 skips). These drive the catch-up path after real downtime.
describe('MessageScheduler — recurring catch-up after downtime', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  it('skips all missed occurrences to the next future slot after downtime (sends once, run_count +1)', async () => {
    const { mock: conn, sendRawCalls } = makeMockConnection();
    const now = Math.floor(Date.now() / 1000);
    db.raw
      .prepare(
        `INSERT INTO scheduled_messages
           (chat_jid, content_type, payload, scheduled_at, status, retry_count, recurrence, next_run_at, run_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        '15551000001@s.whatsapp.net',
        'text',
        JSON.stringify({ text: 'every-minute, machine was down an hour' }),
        now - 7200,
        'pending',
        0,
        '* * * * *', // every minute
        now - 3600, // next_run_at one hour in the past → ~60 missed occurrences
        4,
      );

    const scheduler = new MessageScheduler(db, conn as ConnectionManager, { intervalMs: 60_000, maxRetries: 3 });
    await scheduler.tick();

    // Catch-up must collapse the whole missed backlog into a SINGLE send, not
    // one send per missed minute.
    expect(sendRawCalls).toHaveLength(1);
    const row = db.raw
      .prepare('SELECT status, run_count, next_run_at FROM scheduled_messages WHERE id = ?')
      .get(1) as { status: string; run_count: number; next_run_at: number };
    expect(row.status).toBe('pending');
    expect(row.run_count).toBe(5); // exactly one increment despite ~60 skipped slots
    expect(row.next_run_at).toBeGreaterThan(now); // advanced past every missed slot
  });

  it('reschedules a pathologically ancient backlog without unbounded work (MISSED_OCCURRENCE_SCAN_CAP)', async () => {
    const { mock: conn, sendRawCalls } = makeMockConnection();
    const now = Math.floor(Date.now() / 1000);
    // next_run_at far enough back that the missed count exceeds the 10,000 scan
    // cap, forcing the capped branch (compute next slot directly from sentAt).
    db.raw
      .prepare(
        `INSERT INTO scheduled_messages
           (chat_jid, content_type, payload, scheduled_at, status, retry_count, recurrence, next_run_at, run_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        '15551000002@s.whatsapp.net',
        'text',
        JSON.stringify({ text: 'every-minute, weeks of downtime' }),
        now - 10_001 * 60,
        'pending',
        0,
        '* * * * *',
        now - 10_001 * 60, // > 10,000 every-minute occurrences in the past
        0,
      );

    const scheduler = new MessageScheduler(db, conn as ConnectionManager, { intervalMs: 60_000, maxRetries: 3 });
    await scheduler.tick();

    expect(sendRawCalls).toHaveLength(1);
    const row = db.raw
      .prepare('SELECT status, run_count, next_run_at FROM scheduled_messages WHERE id = ?')
      .get(1) as { status: string; run_count: number; next_run_at: number };
    expect(row.status).toBe('pending'); // schedule survives the cap path
    expect(row.run_count).toBe(1);
    expect(row.next_run_at).toBeGreaterThan(now); // still re-armed into the future
  });
});
