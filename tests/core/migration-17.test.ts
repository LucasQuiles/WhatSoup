import { describe, expect, it, afterEach } from 'vitest';
import { Database } from '../../src/core/database.ts';

describe('migration 17 — recurrence columns', () => {
  let db: Database;

  afterEach(() => { db.raw.close(); });

  it('adds recurrence, next_run_at, run_count, and chat_name columns', () => {
    db = new Database(':memory:');
    db.open();

    db.raw.prepare(
      `INSERT INTO scheduled_messages (chat_jid, chat_name, content_type, payload, scheduled_at, recurrence, next_run_at, run_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('123@s.whatsapp.net', 'Test Chat', 'text', '{"text":"hi"}', 1700000000, '0 9 * * 1', 1700086400, 0);

    const row = db.raw.prepare('SELECT chat_name, recurrence, next_run_at, run_count FROM scheduled_messages WHERE id = 1').get() as {
      chat_name: string;
      recurrence: string;
      next_run_at: number;
      run_count: number;
    };

    expect(row.chat_name).toBe('Test Chat');
    expect(row.recurrence).toBe('0 9 * * 1');
    expect(row.next_run_at).toBe(1700086400);
    expect(row.run_count).toBe(0);
  });

  it('existing rows have NULL recurrence and next_run_at, 0 run_count', () => {
    db = new Database(':memory:');
    db.open();

    db.raw.prepare(
      `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at)
       VALUES (?, ?, ?, ?)`,
    ).run('123@s.whatsapp.net', 'text', '{"text":"old"}', 1700000000);

    const row = db.raw.prepare('SELECT recurrence, next_run_at, run_count FROM scheduled_messages WHERE id = 1').get() as {
      recurrence: string | null;
      next_run_at: number | null;
      run_count: number;
    };

    expect(row.recurrence).toBeNull();
    expect(row.next_run_at).toBeNull();
    expect(row.run_count).toBe(0);
  });
});
