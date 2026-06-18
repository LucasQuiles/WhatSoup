import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { MessageScheduler } from '../../src/core/scheduler.ts';
import type { ConnectionManager } from '../../src/transport/connection.ts';

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function mockConnection(): ConnectionManager {
  return {
    sendRaw: vi.fn().mockResolvedValue({ key: { id: 'msg1' } }),
    sendMedia: vi.fn().mockResolvedValue({ key: { id: 'msg2' } }),
  } as unknown as ConnectionManager;
}

describe('scheduler recurrence', () => {
  let db: Database;
  let conn: ConnectionManager;
  let scheduler: MessageScheduler;

  beforeEach(() => {
    db = makeDb();
    conn = mockConnection();
    scheduler = new MessageScheduler(db, conn, { intervalMs: 60_000, maxRetries: 3 });
  });

  afterEach(() => { db.raw.close(); });

  it('recurring message stays pending after send with updated next_run_at and run_count', async () => {
    const now = Math.floor(Date.now() / 1000);
    db.raw.prepare(
      `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, recurrence, next_run_at, run_count, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('123@s.whatsapp.net', 'text', '{"text":"weekly update"}', now - 120, '0 9 * * 1', now - 60, 0, 'pending');

    await scheduler.tick();

    const row = db.raw.prepare('SELECT status, run_count, next_run_at, sent_at FROM scheduled_messages WHERE id = 1').get() as {
      status: string; run_count: number; next_run_at: number; sent_at: number;
    };

    expect(row.status).toBe('pending');
    expect(row.run_count).toBe(1);
    expect(row.next_run_at).toBeGreaterThan(now);
    expect(row.sent_at).toBeGreaterThan(0);
    expect(conn.sendRaw).toHaveBeenCalledWith('123@s.whatsapp.net', { text: 'weekly update' });
  });

  it('one-shot message still transitions to sent', async () => {
    const now = Math.floor(Date.now() / 1000);
    db.raw.prepare(
      `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('123@s.whatsapp.net', 'text', '{"text":"once"}', now - 60, 'pending');

    await scheduler.tick();

    const row = db.raw.prepare('SELECT status FROM scheduled_messages WHERE id = 1').get() as { status: string };
    expect(row.status).toBe('sent');
  });

  it('cancelled recurring message does not send', async () => {
    const now = Math.floor(Date.now() / 1000);
    db.raw.prepare(
      `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, recurrence, next_run_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('123@s.whatsapp.net', 'text', '{"text":"nope"}', now - 120, '0 9 * * *', now - 60, 'cancelled');

    await scheduler.tick();

    expect(conn.sendRaw).not.toHaveBeenCalled();
  });

  it('recurring message that fails still retries', async () => {
    const now = Math.floor(Date.now() / 1000);
    db.raw.prepare(
      `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, recurrence, next_run_at, status, retry_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('123@s.whatsapp.net', 'text', '{"text":"flaky"}', now - 120, '0 9 * * *', now - 60, 'pending', 0);

    (conn.sendRaw as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network error'));
    await scheduler.tick();

    const row = db.raw.prepare('SELECT status, retry_count FROM scheduled_messages WHERE id = 1').get() as { status: string; retry_count: number };
    expect(row.status).toBe('pending');
    expect(row.retry_count).toBe(1);
  });

  it('recurring message is NOT permanently failed at maxRetries — skips to next slot and resets retry_count', async () => {
    const now = Math.floor(Date.now() / 1000);
    // retry_count=2 with maxRetries=3: one more failure hits the limit.
    db.raw.prepare(
      `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, recurrence, next_run_at, status, retry_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('123@s.whatsapp.net', 'text', '{"text":"daily"}', now - 120, '0 9 * * *', now - 60, 'pending', 2);

    (conn.sendRaw as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('transient outage'));
    await scheduler.tick();

    const row = db.raw.prepare('SELECT status, retry_count, next_run_at FROM scheduled_messages WHERE id = 1').get() as {
      status: string; retry_count: number; next_run_at: number;
    };
    // The recurring schedule survives: not 'failed', counter reset, advanced to the next slot.
    expect(row.status).toBe('pending');
    expect(row.retry_count).toBe(0);
    expect(row.next_run_at).toBeGreaterThan(now);
  });

  it('successful recurring send resets accumulated retry_count to 0', async () => {
    const now = Math.floor(Date.now() / 1000);
    db.raw.prepare(
      `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, recurrence, next_run_at, status, retry_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('123@s.whatsapp.net', 'text', '{"text":"daily"}', now - 120, '0 9 * * *', now - 60, 'pending', 2);

    await scheduler.tick(); // default mock resolves

    const row = db.raw.prepare('SELECT status, retry_count FROM scheduled_messages WHERE id = 1').get() as {
      status: string; retry_count: number;
    };
    expect(row.status).toBe('pending');
    expect(row.retry_count).toBe(0);
  });

  it('one-shot message is still marked failed at maxRetries (regression guard)', async () => {
    const now = Math.floor(Date.now() / 1000);
    db.raw.prepare(
      `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status, retry_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('123@s.whatsapp.net', 'text', '{"text":"once"}', now - 60, 'pending', 2);

    (conn.sendRaw as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('permanent failure'));
    await scheduler.tick();

    const row = db.raw.prepare('SELECT status, retry_count FROM scheduled_messages WHERE id = 1').get() as {
      status: string; retry_count: number;
    };
    expect(row.status).toBe('failed');
    expect(row.retry_count).toBe(3);
  });
});
