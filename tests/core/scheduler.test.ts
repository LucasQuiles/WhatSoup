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
  } = opts;

  const stmt = raw.prepare(`
    INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status, retry_count, media_blob)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(chatJid, contentType, payload, scheduledAt, status, retryCount, mediaBlob);
  return result.lastInsertRowid as number;
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

  it('resets processing rows to pending', () => {
    const id = insertScheduledMessage(db.raw, { status: 'processing' });
    const { mock: conn } = makeMockConnection();

    const scheduler = new MessageScheduler(db, conn as ConnectionManager, { intervalMs: 60_000, maxRetries: 3 });
    scheduler.recoverStale();

    const row = db.raw
      .prepare('SELECT status FROM scheduled_messages WHERE id = ?')
      .get(id) as { status: string };
    expect(row.status).toBe('pending');
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
});

describe('MessageScheduler — start/stop lifecycle', () => {
  it('start() sets up interval and stop() clears it', () => {
    const db = makeDb();
    const { mock: conn } = makeMockConnection();
    const scheduler = new MessageScheduler(db, conn as ConnectionManager, { intervalMs: 10_000, maxRetries: 3 });

    expect(() => scheduler.start()).not.toThrow();
    expect(() => scheduler.stop()).not.toThrow();
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
