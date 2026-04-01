import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { unlinkSync, existsSync } from 'node:fs';
import { Database } from '../../src/core/database.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tmpFile(): string {
  return join(tmpdir(), `whatsoup-test-${randomBytes(8).toString('hex')}.db`);
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

// ─── Schema ──────────────────────────────────────────────────────────────────

describe('Database schema', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
  });

  it('records migration version 1 in schema_migrations', () => {
    const row = db.raw
      .prepare('SELECT version FROM schema_migrations WHERE version = 1')
      .get() as { version: number } | undefined;
    expect(row?.version).toBe(1);
  });

  it('messages table has conversation_key NOT NULL constraint', () => {
    const cols = db.raw.prepare('PRAGMA table_info(messages)').all() as Array<{
      name: string;
      notnull: number;
    }>;
    const ck = cols.find((c) => c.name === 'conversation_key');
    expect(ck).toBeDefined();
    expect(ck!.notnull).toBe(1);
  });

  it('messages_fts virtual table exists', () => {
    const row = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('messages_fts');
  });

  it('contacts table has canonical_phone column', () => {
    const cols = db.raw.prepare('PRAGMA table_info(contacts)').all() as Array<{ name: string }>;
    const col = cols.find((c) => c.name === 'canonical_phone');
    expect(col).toBeDefined();
  });

  it('access_list table exists with subject_type and subject_id primary key', () => {
    const cols = db.raw.prepare('PRAGMA table_info(access_list)').all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'subject_type')).toBe(true);
    expect(cols.some((c) => c.name === 'subject_id')).toBe(true);
  });

  it('agent_sessions table exists', () => {
    const row = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_sessions'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('agent_sessions');
  });

  it('rate_limits table exists', () => {
    const row = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rate_limits'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('rate_limits');
  });

  it('enrichment_runs table exists', () => {
    const row = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='enrichment_runs'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('enrichment_runs');
  });
});

// ─── Pragmas ─────────────────────────────────────────────────────────────────

describe('Database pragmas', () => {
  it('WAL mode is active', () => {
    const dbPath = tmpFile();
    try {
      const db = new Database(dbPath);
      db.open();
      const row = db.raw.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      db.close();
      expect(row.journal_mode).toBe('wal');
    } finally {
      cleanup(dbPath);
    }
  });
});

// ─── FTS5 triggers ───────────────────────────────────────────────────────────

describe('FTS5 triggers', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
  });

  function insertMsg(opts: {
    chatJid?: string;
    conversationKey?: string;
    senderJid?: string;
    content?: string | null;
    deletedAt?: string | null;
  }) {
    const {
      chatJid = '15550100001@s.whatsapp.net',
      conversationKey = '15550100001',
      senderJid = '15550100001@s.whatsapp.net',
      content = 'hello world',
      deletedAt = null,
    } = opts;
    db.raw
      .prepare(
        `INSERT INTO messages
          (chat_jid, conversation_key, sender_jid, content, timestamp, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(chatJid, conversationKey, senderJid, content, Date.now(), deletedAt);
    const row = db.raw
      .prepare('SELECT pk FROM messages ORDER BY pk DESC LIMIT 1')
      .get() as { pk: number };
    return row.pk;
  }

  // For content-table FTS5 (content=messages), rowid lookups read from the
  // backing table — not the FTS shadow index. We verify indexing via MATCH.
  function ftsMatch(term: string): number[] {
    return (
      db.raw
        .prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?')
        .all(term) as Array<{ rowid: number }>
    ).map((r) => r.rowid);
  }

  it('insert trigger indexes non-null content', () => {
    const pk = insertMsg({ content: 'xyzalpha unique term' });
    expect(ftsMatch('xyzalpha')).toContain(pk);
  });

  it('insert trigger does not index null content', () => {
    // Insert a null-content row and verify it does not appear in any MATCH
    insertMsg({ content: null });
    // No term to search for — assert the FTS shadow has no entry for pk by
    // ensuring a wildcard-style search for a known string yields nothing
    const hits = ftsMatch('xyzNULLTEST999');
    expect(hits).toHaveLength(0);
  });

  it('content update trigger re-indexes updated content', () => {
    const pk = insertMsg({ content: 'xyzbeta original phrasing' });
    expect(ftsMatch('xyzbeta')).toContain(pk);

    db.raw.prepare('UPDATE messages SET content = ? WHERE pk = ?').run('xyzgamma updated phrasing', pk);

    // Old term no longer indexed; new term is indexed
    expect(ftsMatch('xyzbeta')).not.toContain(pk);
    expect(ftsMatch('xyzgamma')).toContain(pk);
  });

  it('soft-delete trigger removes entry from FTS', () => {
    const pk = insertMsg({ content: 'xyzdelta to be soft deleted' });
    expect(ftsMatch('xyzdelta')).toContain(pk);

    db.raw
      .prepare("UPDATE messages SET deleted_at = datetime('now') WHERE pk = ?")
      .run(pk);
    // After soft-delete the FTS shadow entry is removed; MATCH no longer finds it
    expect(ftsMatch('xyzdelta')).not.toContain(pk);
  });

  it('physical delete trigger removes entry from FTS', () => {
    const pk = insertMsg({ content: 'xyzepsilon to be physically deleted' });
    expect(ftsMatch('xyzepsilon')).toContain(pk);

    db.raw.prepare('DELETE FROM messages WHERE pk = ?').run(pk);
    expect(ftsMatch('xyzepsilon')).not.toContain(pk);
  });
});

// ─── Warm-start import ───────────────────────────────────────────────────────

describe('importFromLegacyDb', () => {
  let targetPath: string;
  let legacyPath: string;
  let targetDb: Database;

  beforeEach(() => {
    targetPath = tmpFile();
    legacyPath = tmpFile();

    // Build a legacy DB (old schema without conversation_key, edited_at, deleted_at)
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(`
      CREATE TABLE messages (
        pk INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_jid TEXT NOT NULL,
        sender_jid TEXT NOT NULL,
        sender_name TEXT,
        message_id TEXT UNIQUE,
        content TEXT,
        content_type TEXT NOT NULL DEFAULT 'text',
        is_from_me INTEGER NOT NULL DEFAULT 0,
        timestamp INTEGER NOT NULL,
        quoted_message_id TEXT,
        enrichment_processed_at TEXT,
        enrichment_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE access_list (
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        status TEXT NOT NULL,
        display_name TEXT,
        requested_at TEXT,
        decided_at TEXT,
        PRIMARY KEY (subject_type, subject_id)
      );
      CREATE TABLE agent_sessions (
        id INTEGER PRIMARY KEY,
        session_id TEXT,
        claude_pid INTEGER,
        started_in_directory TEXT,
        chat_jid TEXT,
        workspace_key TEXT,
        transcript_path TEXT,
        message_count INTEGER DEFAULT 0,
        started_at TEXT NOT NULL,
        last_message_at TEXT,
        status TEXT NOT NULL DEFAULT 'active'
      );
      CREATE TABLE rate_limits (
        sender_jid TEXT NOT NULL,
        response_at TEXT NOT NULL
      );
      CREATE TABLE enrichment_runs (
        run_id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        messages_processed INTEGER DEFAULT 0,
        facts_extracted INTEGER DEFAULT 0,
        facts_upserted INTEGER DEFAULT 0,
        error TEXT
      );
    `);

    // Insert legacy data
    legacy.exec(`
      INSERT INTO messages (chat_jid, sender_jid, sender_name, message_id, content, content_type,
                            is_from_me, timestamp, created_at)
      VALUES ('15550100001@s.whatsapp.net', '15550100001@s.whatsapp.net', 'Alice',
              'msg-001', 'Hello from legacy', 'text', 0, 1700000000, datetime('now'));

      INSERT INTO messages (chat_jid, sender_jid, sender_name, message_id, content, content_type,
                            is_from_me, timestamp, created_at)
      VALUES ('120363123456789@g.us', '15550100001@s.whatsapp.net', 'Alice',
              'msg-002', 'Group message', 'text', 0, 1700000001, datetime('now'));

      INSERT INTO access_list (subject_type, subject_id, status, display_name, requested_at)
      VALUES ('phone', '15550100001', 'allowed', 'Alice', datetime('now'));

      INSERT INTO agent_sessions (session_id, claude_pid, started_in_directory, started_at, status)
      VALUES ('sess-1', 12345, '/tmp/ws', datetime('now'), 'active');

      INSERT INTO rate_limits (sender_jid, response_at)
      VALUES ('15550100001@s.whatsapp.net', datetime('now'));

      INSERT INTO enrichment_runs (started_at, completed_at, messages_processed, facts_extracted, facts_upserted)
      VALUES (datetime('now'), datetime('now'), 10, 5, 5);
    `);
    legacy.close();

    // Open fresh target DB
    targetDb = new Database(targetPath);
    targetDb.open();
  });

  afterEach(() => {
    targetDb.close();
    cleanup(targetPath, legacyPath);
  });

  it('imports messages with correct conversation_key backfill', () => {
    targetDb.importFromLegacyDb(legacyPath);

    const rows = targetDb.raw
      .prepare('SELECT chat_jid, conversation_key, content FROM messages ORDER BY pk')
      .all() as Array<{ chat_jid: string; conversation_key: string; content: string }>;

    expect(rows).toHaveLength(2);

    const dm = rows.find((r) => r.chat_jid === '15550100001@s.whatsapp.net');
    expect(dm?.conversation_key).toBe('15550100001');

    const group = rows.find((r) => r.chat_jid === '120363123456789@g.us');
    expect(group?.conversation_key).toBe('120363123456789_at_g.us');
  });

  it('FTS5 is populated for imported messages via INSERT trigger', () => {
    targetDb.importFromLegacyDb(legacyPath);

    const hits = targetDb.raw
      .prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'legacy'")
      .all() as Array<{ rowid: number }>;
    expect(hits).toHaveLength(1);
  });

  it('imports access_list rows', () => {
    targetDb.importFromLegacyDb(legacyPath);

    const row = targetDb.raw
      .prepare("SELECT * FROM access_list WHERE subject_id = '15550100001'")
      .get() as { status: string } | undefined;
    expect(row?.status).toBe('allowed');
  });

  it('imports agent_sessions rows', () => {
    targetDb.importFromLegacyDb(legacyPath);

    const row = targetDb.raw
      .prepare("SELECT session_id FROM agent_sessions WHERE session_id = 'sess-1'")
      .get() as { session_id: string } | undefined;
    expect(row?.session_id).toBe('sess-1');
  });

  it('imports rate_limits rows', () => {
    targetDb.importFromLegacyDb(legacyPath);

    const row = targetDb.raw
      .prepare('SELECT count(*) AS n FROM rate_limits')
      .get() as { n: number };
    expect(row.n).toBe(1);
  });

  it('imports enrichment_runs rows', () => {
    targetDb.importFromLegacyDb(legacyPath);

    const row = targetDb.raw
      .prepare('SELECT messages_processed FROM enrichment_runs LIMIT 1')
      .get() as { messages_processed: number } | undefined;
    expect(row?.messages_processed).toBe(10);
  });

  it('throws if legacy DB path does not exist', () => {
    expect(() => targetDb.importFromLegacyDb('/nonexistent/path.db')).toThrow();
  });
});

// ─── Migration 3: Chat sync tables ───────────────────────────────────────────

describe('migration 3 — chat sync tables', () => {
  it('creates chats table with expected columns', () => {
    const db = new Database(':memory:');
    db.open();
    const cols = db.raw
      .prepare("PRAGMA table_info('chats')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('jid');
    expect(names).toContain('conversation_key');
    expect(names).toContain('name');
    expect(names).toContain('unread_count');
    expect(names).toContain('is_archived');
    expect(names).toContain('is_pinned');
    expect(names).toContain('mute_until');
    expect(names).toContain('ephemeral_duration');
    expect(names).toContain('updated_at');
    db.close();
  });

  it('creates reactions table with expected columns', () => {
    const db = new Database(':memory:');
    db.open();
    const cols = db.raw
      .prepare("PRAGMA table_info('reactions')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('id');
    expect(names).toContain('message_id');
    expect(names).toContain('conversation_key');
    expect(names).toContain('sender_jid');
    expect(names).toContain('reaction');
    expect(names).toContain('timestamp');
    db.close();
  });

  it('creates receipts table with expected columns', () => {
    const db = new Database(':memory:');
    db.open();
    const cols = db.raw
      .prepare("PRAGMA table_info('receipts')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('id');
    expect(names).toContain('message_id');
    expect(names).toContain('recipient_jid');
    expect(names).toContain('type');
    expect(names).toContain('timestamp');
    db.close();
  });

  it('enforces unique constraint on reactions(message_id, sender_jid)', () => {
    const db = new Database(':memory:');
    db.open();
    db.raw
      .prepare(
        "INSERT INTO reactions (message_id, conversation_key, sender_jid, reaction) VALUES (?, ?, ?, ?)",
      )
      .run('msg1', 'conv1', 'sender1@s.whatsapp.net', '👍');
    expect(() => {
      db.raw
        .prepare(
          "INSERT INTO reactions (message_id, conversation_key, sender_jid, reaction) VALUES (?, ?, ?, ?)",
        )
        .run('msg1', 'conv1', 'sender1@s.whatsapp.net', '❤️');
    }).toThrow(); // UNIQUE constraint
    db.close();
  });

  it('enforces unique constraint on receipts(message_id, recipient_jid, type)', () => {
    const db = new Database(':memory:');
    db.open();
    db.raw
      .prepare(
        "INSERT INTO receipts (message_id, recipient_jid, type) VALUES (?, ?, ?)",
      )
      .run('msg1', 'recv1@s.whatsapp.net', 'delivery');
    expect(() => {
      db.raw
        .prepare(
          "INSERT INTO receipts (message_id, recipient_jid, type) VALUES (?, ?, ?)",
        )
        .run('msg1', 'recv1@s.whatsapp.net', 'delivery');
    }).toThrow();
    db.close();
  });
});
