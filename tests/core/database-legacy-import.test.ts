import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { Database } from '../../src/core/database.ts';

function tmpFile(prefix: string): string {
  return join(tmpdir(), `${prefix}-${randomBytes(8).toString('hex')}.db`);
}

function cleanup(...paths: string[]): void {
  for (const p of paths) {
    for (const suffix of ['', '-wal', '-shm']) {
      const full = p + suffix;
      if (existsSync(full)) {
        try { unlinkSync(full); } catch { /* ignore */ }
      }
    }
  }
}

function createLegacyDb(path: string): void {
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE messages (
      pk INTEGER PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      sender_jid TEXT NOT NULL,
      sender_name TEXT,
      message_id TEXT,
      content TEXT,
      content_type TEXT NOT NULL,
      is_from_me INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      quoted_message_id TEXT,
      enrichment_processed_at TEXT,
      enrichment_error TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE access_list (
      phone TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      display_name TEXT,
      requested_at TEXT,
      decided_at TEXT
    );
    CREATE TABLE agent_sessions (
      id INTEGER PRIMARY KEY,
      session_id TEXT,
      claude_pid INTEGER,
      started_in_directory TEXT,
      chat_jid TEXT,
      workspace_key TEXT,
      transcript_path TEXT,
      message_count INTEGER,
      started_at TEXT NOT NULL,
      last_message_at TEXT,
      status TEXT NOT NULL
    );
    CREATE TABLE rate_limits (
      sender_jid TEXT NOT NULL,
      response_at TEXT NOT NULL
    );
    CREATE TABLE enrichment_runs (
      run_id INTEGER PRIMARY KEY,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      messages_processed INTEGER,
      facts_extracted INTEGER,
      facts_upserted INTEGER,
      error TEXT
    );
  `);

  legacy.prepare(`
    INSERT INTO messages
      (pk, chat_jid, sender_jid, sender_name, message_id, content, content_type,
       is_from_me, timestamp, quoted_message_id, enrichment_processed_at, enrichment_error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    1,
    '15550100001@s.whatsapp.net',
    '15550100002@s.whatsapp.net',
    'Alice',
    'legacy-msg-1',
    'legacy hello',
    'text',
    0,
    1700000000,
    null,
    null,
    null,
    '2026-01-01T00:00:00.000Z',
  );
  legacy.prepare(`
    INSERT INTO messages
      (pk, chat_jid, sender_jid, sender_name, message_id, content, content_type,
       is_from_me, timestamp, quoted_message_id, enrichment_processed_at, enrichment_error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    2,
    'not-a-jid',
    '15550100003@s.whatsapp.net',
    'Bad',
    'legacy-bad-jid',
    'should skip',
    'text',
    0,
    1700000001,
    null,
    null,
    null,
    '2026-01-01T00:00:01.000Z',
  );
  legacy.prepare(`
    INSERT INTO access_list (phone, status, display_name, requested_at, decided_at)
    VALUES (?, ?, ?, ?, ?)
  `).run('15550100001', 'allowed', 'Alice', '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z');
  legacy.prepare(`
    INSERT INTO agent_sessions
      (id, session_id, claude_pid, started_in_directory, chat_jid, workspace_key,
       transcript_path, message_count, started_at, last_message_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(7, 'legacy-session', 1234, '/tmp/old', '15550100001@s.whatsapp.net', 'wk', '/tmp/transcript', 3, '2026-01-01T00:00:00.000Z', null, 'active');
  legacy.prepare('INSERT INTO rate_limits (sender_jid, response_at) VALUES (?, ?)').run('15550100001@s.whatsapp.net', '2026-01-01T00:00:00.000Z');
  legacy.prepare('INSERT INTO rate_limits (sender_jid, response_at) VALUES (?, ?)').run('15550100001@s.whatsapp.net', '2026-01-01T00:00:00.000Z');
  legacy.prepare(`
    INSERT INTO enrichment_runs
      (run_id, started_at, completed_at, messages_processed, facts_extracted, facts_upserted, error)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(11, '2026-01-01T00:00:00.000Z', '2026-01-01T00:02:00.000Z', 5, 2, 1, null);
  legacy.close();
}

describe('Database legacy import', () => {
  let dbPath = '';
  let legacyPath = '';

  afterEach(() => cleanup(dbPath, legacyPath));

  it('fails closed when the legacy database path does not exist', () => {
    dbPath = tmpFile('whatsoup-current');
    legacyPath = tmpFile('whatsoup-missing-legacy');
    const db = new Database(dbPath);
    db.open();

    expect(() => db.importFromLegacyDb(legacyPath)).toThrow(/Legacy DB not found/);

    db.close();
  });

  it('imports legacy rows with conversation keys and keeps incompatible rows out of FTS', () => {
    dbPath = tmpFile('whatsoup-current');
    legacyPath = tmpFile('whatsoup-legacy');
    createLegacyDb(legacyPath);
    const db = new Database(dbPath);
    db.open();

    db.importFromLegacyDb(legacyPath);

    const message = db.raw.prepare(`
      SELECT chat_jid, conversation_key, sender_jid, sender_name, message_id, content, content_text
      FROM messages
      WHERE message_id = 'legacy-msg-1'
    `).get() as {
      chat_jid: string;
      conversation_key: string;
      sender_jid: string;
      sender_name: string;
      message_id: string;
      content: string;
      content_text: string;
    } | undefined;
    expect(message).toMatchObject({
      chat_jid: '15550100001@s.whatsapp.net',
      conversation_key: '15550100001',
      sender_jid: '15550100002@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'legacy hello',
      content_text: 'legacy hello',
    });
    expect(db.raw.prepare("SELECT count(*) AS n FROM messages WHERE message_id = 'legacy-bad-jid'").get()).toEqual({ n: 0 });
    expect(db.raw.prepare("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'legacy'").get()).toEqual({ n: 1 });

    expect(db.raw.prepare('SELECT subject_type, subject_id, status FROM access_list').get()).toEqual({
      subject_type: 'phone',
      subject_id: '15550100001',
      status: 'allowed',
    });
    expect(db.raw.prepare('SELECT session_id, message_count FROM agent_sessions WHERE id = 7').get()).toEqual({
      session_id: 'legacy-session',
      message_count: 3,
    });
    expect(db.raw.prepare('SELECT count(*) AS n FROM rate_limits').get()).toEqual({ n: 1 });
    expect(db.raw.prepare('SELECT run_id, facts_upserted FROM enrichment_runs WHERE run_id = 11').get()).toEqual({
      run_id: 11,
      facts_upserted: 1,
    });

    db.close();
  });
});
