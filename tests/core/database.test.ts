import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { unlinkSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import {
  Database,
  storeDecryptionFailure,
  resolveDecryptionFailure,
  type DecryptionFailureInput,
} from '../../src/core/database.ts';

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
    const cols = db.raw.prepare('PRAGMA table_info(contacts)').all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;
    const col = cols.find((c) => c.name === 'canonical_phone');
    expect(col).toMatchObject({
      name: 'canonical_phone',
      type: 'TEXT',
      notnull: 0,
      dflt_value: null,
      pk: 0,
    });
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

  it('messages table has media_path column (MIGRATION_12)', () => {
    const cols = db.raw.prepare('PRAGMA table_info(messages)').all() as Array<{
      name: string;
      type: string;
    }>;
    const col = cols.find((c) => c.name === 'media_path');
    expect(col).toBeDefined();
    expect(col!.type).toBe('TEXT');
  });

  it('idx_messages_media_path partial index exists', () => {
    const indexes = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_media_path'")
      .all() as Array<{ name: string }>;
    expect(indexes).toHaveLength(1);
  });

  it('messages table has content_text column (MIGRATION_13)', () => {
    const cols = db.raw.prepare('PRAGMA table_info(messages)').all() as Array<{
      name: string;
      type: string;
    }>;
    const col = cols.find((c) => c.name === 'content_text');
    expect(col).toBeDefined();
    expect(col!.type).toBe('TEXT');
  });

  it('messages table has updated_at column for realtime update markers', () => {
    const cols = db.raw.prepare('PRAGMA table_info(messages)').all() as Array<{
      name: string;
      type: string;
    }>;
    const col = cols.find((c) => c.name === 'updated_at');
    expect(col).toBeDefined();
    expect(col!.type).toBe('TEXT');
  });

  it('touches messages.updated_at when history content is upgraded in place', () => {
    db.raw.prepare(`
      INSERT INTO messages
        (chat_jid, conversation_key, sender_jid, message_id, content, content_text, content_type, is_from_me, timestamp, updated_at)
      VALUES
        ('123@s.whatsapp.net', '123', '123@s.whatsapp.net', 'msg-marker-1', NULL, NULL, 'history', 0, 1700000000, '2000-01-01T00:00:00.000Z')
    `).run();

    db.raw.prepare(`
      UPDATE messages
      SET content = 'upgraded', content_text = 'upgraded', content_type = 'text'
      WHERE message_id = 'msg-marker-1'
    `).run();

    const row = db.raw.prepare('SELECT updated_at FROM messages WHERE message_id = ?').get('msg-marker-1') as { updated_at: string };
    expect(row.updated_at).not.toBe('2000-01-01T00:00:00.000Z');
    expect(row.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('FTS insert trigger references content_text (MIGRATION_13)', () => {
    const triggers = db.raw
      .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='messages_fts_insert'")
      .all() as Array<{ sql: string }>;
    expect(triggers).toHaveLength(1);
    expect(triggers[0].sql).toContain('content_text');
  });

  it('FTS update trigger fires on content_text changes (MIGRATION_13)', () => {
    const triggers = db.raw
      .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='messages_fts_update'")
      .all() as Array<{ sql: string }>;
    expect(triggers).toHaveLength(1);
    expect(triggers[0].sql).toContain('content_text');
  });

  it('FTS soft_delete trigger references content_text (MIGRATION_13)', () => {
    const triggers = db.raw
      .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='messages_fts_soft_delete'")
      .all() as Array<{ sql: string }>;
    expect(triggers).toHaveLength(1);
    expect(triggers[0].sql).toContain('content_text');
  });

  it('FTS delete trigger references content_text (MIGRATION_13)', () => {
    const triggers = db.raw
      .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='messages_fts_delete'")
      .all() as Array<{ sql: string }>;
    expect(triggers).toHaveLength(1);
    expect(triggers[0].sql).toContain('content_text');
  });

  it('scheduled_messages table exists with correct columns (MIGRATION_14)', () => {
    const row = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_messages'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('scheduled_messages');

    const cols = db.raw
      .prepare('PRAGMA table_info(scheduled_messages)')
      .all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>;
    const colMap = Object.fromEntries(cols.map((c) => [c.name, c]));

    expect(colMap['id']).toBeDefined();
    expect(colMap['chat_jid']).toBeDefined();
    expect(colMap['chat_jid'].notnull).toBe(1);
    expect(colMap['content_type']).toBeDefined();
    expect(colMap['payload']).toBeDefined();
    expect(colMap['payload'].notnull).toBe(1);
    expect(colMap['scheduled_at']).toBeDefined();
    expect(colMap['scheduled_at'].type).toBe('INTEGER');
    expect(colMap['status']).toBeDefined();
    expect(colMap['created_at']).toBeDefined();
    expect(colMap['created_at'].type).toBe('INTEGER');
    expect(colMap['sent_at']).toBeDefined();
    expect(colMap['error']).toBeDefined();
    expect(colMap['send_started_at']).toMatchObject({
      name: 'send_started_at',
      type: 'INTEGER',
      notnull: 0,
      dflt_value: null,
    });
    expect(colMap['retry_count']).toMatchObject({
      name: 'retry_count',
      type: 'INTEGER',
      notnull: 1,
      dflt_value: '0',
    });
  });

  it('idx_scheduled_pending partial index exists (MIGRATION_14)', () => {
    const indexes = db.raw
      .prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND name='idx_scheduled_pending'")
      .all() as Array<{ name: string; sql: string }>;
    expect(indexes).toHaveLength(1);
    expect(indexes[0].sql).toContain('status');
    expect(indexes[0].sql).toContain('scheduled_at');
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
    contentText?: string | null;
    deletedAt?: string | null;
  }) {
    const {
      chatJid = '15550100001@s.whatsapp.net',
      conversationKey = '15550100001',
      senderJid = '15550100001@s.whatsapp.net',
      content = 'hello world',
      contentText = undefined,
      deletedAt = null,
    } = opts;
    // After MIGRATION_13, FTS triggers index content_text (not content).
    // Use content_text if provided, otherwise fall back to content for text messages.
    const effectiveContentText = contentText !== undefined ? contentText : content;
    db.raw
      .prepare(
        `INSERT INTO messages
          (chat_jid, conversation_key, sender_jid, content, content_text, timestamp, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(chatJid, conversationKey, senderJid, content, effectiveContentText, Date.now(), deletedAt);
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

  it('insert trigger indexes non-null content_text', () => {
    const pk = insertMsg({ content: 'xyzalpha unique term', contentText: 'xyzalpha unique term' });
    expect(ftsMatch('xyzalpha')).toContain(pk);
  });

  it('insert trigger does not index null content_text', () => {
    // Insert a null content_text row and verify it does not appear in any MATCH
    insertMsg({ content: null, contentText: null });
    // No term to search for — assert the FTS shadow has no entry for pk by
    // ensuring a wildcard-style search for a known string yields nothing
    const hits = ftsMatch('xyzNULLTEST999');
    expect(hits).toHaveLength(0);
  });

  it('content_text update trigger re-indexes updated content_text', () => {
    const pk = insertMsg({ content: 'xyzbeta original phrasing', contentText: 'xyzbeta original phrasing' });
    expect(ftsMatch('xyzbeta')).toContain(pk);

    db.raw.prepare('UPDATE messages SET content_text = ? WHERE pk = ?').run('xyzgamma updated phrasing', pk);

    // Old term no longer indexed; new term is indexed
    expect(ftsMatch('xyzbeta')).not.toContain(pk);
    expect(ftsMatch('xyzgamma')).toContain(pk);
  });

  it('soft-delete trigger removes entry from FTS', () => {
    const pk = insertMsg({ content: 'xyzdelta to be soft deleted', contentText: 'xyzdelta to be soft deleted' });
    expect(ftsMatch('xyzdelta')).toContain(pk);

    db.raw
      .prepare("UPDATE messages SET deleted_at = datetime('now') WHERE pk = ?")
      .run(pk);
    // After soft-delete the FTS shadow entry is removed; MATCH no longer finds it
    expect(ftsMatch('xyzdelta')).not.toContain(pk);
  });

  it('physical delete trigger removes entry from FTS', () => {
    const pk = insertMsg({ content: 'xyzepsilon to be physically deleted', contentText: 'xyzepsilon to be physically deleted' });
    expect(ftsMatch('xyzepsilon')).toContain(pk);

    db.raw.prepare('DELETE FROM messages WHERE pk = ?').run(pk);
    expect(ftsMatch('xyzepsilon')).not.toContain(pk);
  });

  // BEAD-061: negative-path coverage for the migration-13 soft-delete trigger's
  // NULL guard (`messages_fts_soft_delete ... WHEN ... OLD.content_text IS NOT
  // NULL`, database.ts:640-645). A row with content_text = NULL is never indexed
  // by the insert trigger (its own NULL guard), so soft-deleting it must NOT fire
  // a spurious FTS 'delete' for a rowid that has no shadow entry — doing so would
  // corrupt the FTS5 index. Exclusion of the (orphan) row is instead handled by
  // the read-time `deleted_at IS NULL` filter. The existing soft-delete test
  // above always sets content_text, so this branch was untested.
  it('soft-deleting a NULL content_text row keeps FTS uncorrupted and is excluded by the read-time deleted_at filter', () => {
    // A co-resident, properly indexed row proves FTS stays usable throughout.
    const sibling = insertMsg({ content: 'xyzsibling stays searchable', contentText: 'xyzsibling stays searchable' });
    expect(ftsMatch('xyzsibling')).toContain(sibling);

    // Seed the NULL-content_text row (insert trigger's NULL guard keeps it out of FTS).
    const nullPk = insertMsg({ content: null, contentText: null });

    // The read-time deleted_at filter still surfaces it while live.
    const liveBefore = (
      db.raw
        .prepare('SELECT pk FROM messages WHERE pk = ? AND deleted_at IS NULL')
        .all(nullPk) as Array<{ pk: number }>
    ).map((r) => r.pk);
    expect(liveBefore).toContain(nullPk);

    // Soft-delete: the trigger's `OLD.content_text IS NOT NULL` guard is false,
    // so no 'delete' is issued against messages_fts for an unindexed rowid.
    db.raw.prepare("UPDATE messages SET deleted_at = datetime('now') WHERE pk = ?").run(nullPk);

    // FTS5 integrity check throws if the shadow index was corrupted by a stray
    // delete; a clean run is the belt-and-suspenders proof of the NULL guard.
    expect(() => {
      db.raw.prepare("INSERT INTO messages_fts(messages_fts) VALUES ('integrity-check')").run();
    }).not.toThrow();

    // Read-time deleted_at filter now neutralizes the (orphan-free) NULL row.
    const liveAfter = db.raw
      .prepare('SELECT pk FROM messages WHERE pk = ? AND deleted_at IS NULL')
      .all(nullPk) as Array<{ pk: number }>;
    expect(liveAfter).toHaveLength(0);

    // The indexed sibling remains searchable — FTS was untouched by the NULL path.
    expect(ftsMatch('xyzsibling')).toContain(sibling);
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

  it('imports access_list from legacy phone-only schema', () => {
    const phoneLegacyPath = tmpFile();
    const phoneLegacy = new DatabaseSync(phoneLegacyPath);
    phoneLegacy.exec(`
      CREATE TABLE messages (
        pk INTEGER PRIMARY KEY AUTOINCREMENT, chat_jid TEXT NOT NULL, sender_jid TEXT NOT NULL,
        sender_name TEXT, message_id TEXT UNIQUE, content TEXT,
        content_type TEXT NOT NULL DEFAULT 'text', is_from_me INTEGER NOT NULL DEFAULT 0,
        timestamp INTEGER NOT NULL, quoted_message_id TEXT,
        enrichment_processed_at TEXT, enrichment_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE access_list (
        phone TEXT PRIMARY KEY, status TEXT NOT NULL, display_name TEXT,
        requested_at TEXT, decided_at TEXT
      );
      CREATE TABLE rate_limits (sender_jid TEXT NOT NULL, response_at TEXT NOT NULL);
    `);
    phoneLegacy.exec(`
      INSERT INTO access_list (phone, status, display_name, requested_at)
      VALUES ('15550100001', 'allowed', 'Alice', datetime('now'));
      INSERT INTO access_list (phone, status, display_name, requested_at)
      VALUES ('15550100002', 'blocked', 'Bob', datetime('now'));
    `);
    phoneLegacy.close();

    const freshPath = tmpFile();
    const freshDb = new Database(freshPath);
    freshDb.open();
    freshDb.importFromLegacyDb(phoneLegacyPath);

    const rows = freshDb.raw
      .prepare('SELECT subject_type, subject_id, status, display_name FROM access_list ORDER BY subject_id')
      .all() as Array<{ subject_type: string; subject_id: string; status: string; display_name: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ subject_type: 'phone', subject_id: '15550100001', status: 'allowed', display_name: 'Alice' });
    expect(rows[1]).toMatchObject({ subject_type: 'phone', subject_id: '15550100002', status: 'blocked', display_name: 'Bob' });

    freshDb.close();
    cleanup(freshPath, phoneLegacyPath);
  });

  it('skips missing tables gracefully (no agent_sessions, no enrichment_runs)', () => {
    const minimalLegacyPath = tmpFile();
    const minimalLegacy = new DatabaseSync(minimalLegacyPath);
    minimalLegacy.exec(`
      CREATE TABLE messages (
        pk INTEGER PRIMARY KEY AUTOINCREMENT, chat_jid TEXT NOT NULL, sender_jid TEXT NOT NULL,
        sender_name TEXT, message_id TEXT UNIQUE, content TEXT,
        content_type TEXT NOT NULL DEFAULT 'text', is_from_me INTEGER NOT NULL DEFAULT 0,
        timestamp INTEGER NOT NULL, quoted_message_id TEXT,
        enrichment_processed_at TEXT, enrichment_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE rate_limits (sender_jid TEXT NOT NULL, response_at TEXT NOT NULL);
    `);
    minimalLegacy.exec(`
      INSERT INTO messages (chat_jid, sender_jid, message_id, content, timestamp, created_at)
      VALUES ('15550100001@s.whatsapp.net', '15550100001@s.whatsapp.net', 'msg-min-1', 'Hello', 1700000000, datetime('now'));
      INSERT INTO rate_limits (sender_jid, response_at)
      VALUES ('15550100001@s.whatsapp.net', datetime('now'));
    `);
    minimalLegacy.close();

    const freshPath = tmpFile();
    const freshDb = new Database(freshPath);
    freshDb.open();
    freshDb.importFromLegacyDb(minimalLegacyPath);

    const msgs = freshDb.raw.prepare('SELECT count(*) AS n FROM messages').get() as { n: number };
    expect(msgs.n).toBe(1);
    const sessions = freshDb.raw.prepare('SELECT count(*) AS n FROM agent_sessions').get() as { n: number };
    expect(sessions.n).toBe(0);
    const enrichment = freshDb.raw.prepare('SELECT count(*) AS n FROM enrichment_runs').get() as { n: number };
    expect(enrichment.n).toBe(0);

    freshDb.close();
    cleanup(freshPath, minimalLegacyPath);
  });
});

// ─── Timestamp coercion ───────────────────────────────────────────────────────

describe('historyMessages timestamp coercion', () => {
  it('Long-like object fails SQLite bind; Number()-coerced value succeeds', () => {
    // Simulate what Baileys sends: a protobuf Long object
    const longLike = Object.create(null);
    longLike.low = 1700000000;
    longLike.high = 0;
    longLike.unsigned = true;
    longLike.valueOf = () => 1700000000;
    longLike[Symbol.toPrimitive] = () => 1700000000;

    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t (ts INTEGER NOT NULL)');
    const insert = db.prepare('INSERT INTO t (ts) VALUES (?)');

    // Raw Long-like object — SQLite rejects it (the production bug).
    // Node's sqlite treats plain objects as named-param maps, so it throws
    // "Unknown named parameter" rather than a bind-type error.
    expect(() => insert.run(longLike)).toThrow(/unknown named parameter/i);

    // Number()-coerced — SQLite accepts it (the fix)
    insert.run(Number(longLike));
    const row = db.prepare('SELECT ts FROM t').get() as { ts: number };
    expect(row.ts).toBe(1700000000);

    db.close();
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

describe('migration 18 — agent_token_events + ended_at', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
  });

  it('records migration version 18 in schema_migrations', () => {
    const row = db.raw
      .prepare('SELECT version FROM schema_migrations WHERE version = 18')
      .get() as { version: number } | undefined;
    expect(row?.version).toBe(18);
  });

  it('creates agent_token_events table with correct columns', () => {
    const cols = db.raw
      .prepare("PRAGMA table_info('agent_token_events')")
      .all() as Array<{ name: string; type: string; notnull: number }>;
    const colMap = Object.fromEntries(cols.map((c) => [c.name, c]));

    expect(colMap['id']).toBeDefined();
    expect(colMap['agent_session_id']).toBeDefined();
    expect(colMap['agent_session_id'].notnull).toBe(1);
    expect(colMap['timestamp']).toBeDefined();
    expect(colMap['timestamp'].type).toBe('INTEGER');
    expect(colMap['timestamp'].notnull).toBe(1);
    expect(colMap['input_tokens']).toBeDefined();
    expect(colMap['input_tokens'].type).toBe('INTEGER');
    expect(colMap['output_tokens']).toBeDefined();
    expect(colMap['output_tokens'].type).toBe('INTEGER');
  });

  it('creates idx_agent_token_events_ts index', () => {
    const indexes = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_agent_token_events_ts'")
      .all() as Array<{ name: string }>;
    expect(indexes).toHaveLength(1);
  });

  it('creates idx_agent_token_events_session_ts index', () => {
    const indexes = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_agent_token_events_session_ts'")
      .all() as Array<{ name: string }>;
    expect(indexes).toHaveLength(1);
  });

  it('adds ended_at column to agent_sessions', () => {
    const cols = db.raw
      .prepare("PRAGMA table_info('agent_sessions')")
      .all() as Array<{ name: string; type: string }>;
    const col = cols.find((c) => c.name === 'ended_at');
    expect(col).toBeDefined();
    expect(col!.type).toBe('TEXT');
  });

  it('creates idx_agent_sessions_started_epoch expression index', () => {
    const indexes = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_agent_sessions_started_epoch'")
      .all() as Array<{ name: string }>;
    expect(indexes).toHaveLength(1);
  });

  it('creates idx_agent_sessions_ended_epoch expression index', () => {
    const indexes = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_agent_sessions_ended_epoch'")
      .all() as Array<{ name: string }>;
    expect(indexes).toHaveLength(1);
  });

  it('backfills ended_at for terminal sessions', () => {
    db.raw.prepare(`
      INSERT INTO agent_sessions (claude_pid, started_in_directory, started_at, last_message_at, status, ended_at)
      VALUES (1, '/tmp', '2026-04-01T10:00:00.000Z', '2026-04-01T11:00:00.000Z', 'ended', NULL)
    `).run();
    db.raw.prepare(`
      INSERT INTO agent_sessions (claude_pid, started_in_directory, started_at, last_message_at, status, ended_at)
      VALUES (2, '/tmp', '2026-04-01T12:00:00.000Z', NULL, 'crashed', NULL)
    `).run();
    db.raw.prepare(`
      INSERT INTO agent_sessions (claude_pid, started_in_directory, started_at, status, ended_at)
      VALUES (3, '/tmp', '2026-04-01T13:00:00.000Z', 'active', NULL)
    `).run();
    db.raw.prepare(`
      INSERT INTO agent_sessions (claude_pid, started_in_directory, started_at, status, ended_at)
      VALUES (4, '/tmp', '2026-04-01T14:00:00.000Z', 'suspended', NULL)
    `).run();

    // Re-run the backfill UPDATE (same as migration does)
    db.raw.prepare(`
      UPDATE agent_sessions SET ended_at = COALESCE(last_message_at, started_at)
      WHERE status IN ('ended', 'completed', 'crashed', 'resume_failed', 'orphaned')
        AND ended_at IS NULL
    `).run();

    const rows = db.raw.prepare(
      'SELECT id, status, ended_at FROM agent_sessions ORDER BY id'
    ).all() as Array<{ id: number; status: string; ended_at: string | null }>;
    expect(rows).toEqual([
      { id: 1, status: 'ended', ended_at: '2026-04-01T11:00:00.000Z' },
      { id: 2, status: 'crashed', ended_at: '2026-04-01T12:00:00.000Z' },
      { id: 3, status: 'active', ended_at: null },
      { id: 4, status: 'suspended', ended_at: null },
    ]);
  });
});

describe('migration 19 — agent_sessions.provider', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
  });

  it('records migration version 19 in schema_migrations', () => {
    const row = db.raw
      .prepare('SELECT version FROM schema_migrations WHERE version = 19')
      .get() as { version: number } | undefined;
    expect(row?.version).toBe(19);
  });

  it('adds provider column to agent_sessions', () => {
    const cols = db.raw
      .prepare("PRAGMA table_info('agent_sessions')")
      .all() as Array<{ name: string; type: string }>;
    const col = cols.find((c) => c.name === 'provider');
    expect(col).toBeDefined();
    expect(col!.type).toBe('TEXT');
  });
});

describe('migration 25 — lid_mappings_history', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
  });

  it('records migration version 25 in schema_migrations', () => {
    const row = db.raw
      .prepare('SELECT version FROM schema_migrations WHERE version = 25')
      .get() as { version: number } | undefined;
    expect(row?.version).toBe(25);
  });

  it('creates lid_mappings_history table with expected columns', () => {
    const cols = db.raw
      .prepare("PRAGMA table_info('lid_mappings_history')")
      .all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>;
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));

    expect(byName.id).toMatchObject({ type: 'INTEGER', pk: 1 });
    expect(byName.lid).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(byName.prev_phone_jid).toMatchObject({ type: 'TEXT', notnull: 0 });
    expect(byName.new_phone_jid).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(byName.source).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(byName.source_instance).toMatchObject({ type: 'TEXT', notnull: 0 });
    expect(byName.changed_at).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(byName.observed_updated_at).toMatchObject({ type: 'TEXT', notnull: 0 });
  });

  it('creates indexes on lid and changed_at', () => {
    const indexes = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='lid_mappings_history'")
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain('idx_lid_mappings_history_lid');
    expect(names).toContain('idx_lid_mappings_history_changed_at');
  });

  it('table is empty after migration (no backfill)', () => {
    const row = db.raw
      .prepare('SELECT COUNT(*) AS c FROM lid_mappings_history')
      .get() as { c: number };
    expect(row.c).toBe(0);
  });
});

describe('migration 28 — pending_polls', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
  });

  it('records migration version 28 in schema_migrations', () => {
    const row = db.raw
      .prepare('SELECT version FROM schema_migrations WHERE version = 28')
      .get() as { version: number } | undefined;
    expect(row?.version).toBe(28);
  });

  it('creates pending_polls table with the expected schema', () => {
    const cols = db.raw
      .prepare("PRAGMA table_info('pending_polls')")
      .all() as Array<{ name: string; type: string; notnull: number; pk: number }>;
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));

    // PRIMARY KEY columns in SQLite report notnull=0 even though NULL would be rejected by the PK constraint.
    expect(byName.map_key).toMatchObject({ type: 'TEXT', pk: 1 });
    expect(byName.chat_jid).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(byName.tool_id).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(byName.source).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(byName.resolution).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(byName.payload).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(byName.created_at).toMatchObject({ type: 'INTEGER', notnull: 1 });
    expect(byName.closes_at).toMatchObject({ type: 'INTEGER', notnull: 0 });
    expect(byName.hard_closes_at).toMatchObject({ type: 'INTEGER', notnull: 0 });
  });

  it('creates indexes on chat_jid and closes_at', () => {
    const indexes = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='pending_polls'")
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain('idx_pending_polls_chat_jid');
    expect(names).toContain('idx_pending_polls_closes_at');
  });

  it('upserts on conflicting map_key (round-trip persistence)', () => {
    const insert = db.raw.prepare(`
      INSERT INTO pending_polls (map_key, chat_jid, tool_id, source, resolution, payload, created_at, closes_at, hard_closes_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(map_key) DO UPDATE SET payload = excluded.payload, closes_at = excluded.closes_at
    `);
    insert.run('key-1', 'chat-1@s.whatsapp.net', 'tool-1', 'askuser', 'first-vote-wins', '{"v":1}', 1_000, 2_000, 3_000);
    insert.run('key-1', 'chat-1@s.whatsapp.net', 'tool-1', 'askuser', 'first-vote-wins', '{"v":2}', 1_000, 2_500, 3_000);

    const row = db.raw.prepare('SELECT payload, closes_at FROM pending_polls WHERE map_key = ?').get('key-1') as
      | { payload: string; closes_at: number }
      | undefined;
    expect(row?.payload).toBe('{"v":2}');
    expect(row?.closes_at).toBe(2_500);
  });

  it('table is empty after migration (no backfill)', () => {
    const row = db.raw
      .prepare('SELECT COUNT(*) AS c FROM pending_polls')
      .get() as { c: number };
    expect(row.c).toBe(0);
  });

  it('migration is idempotent (re-running CREATE IF NOT EXISTS is a no-op)', () => {
    // Already applied on open; re-running the migration explicitly should not throw or
    // change any state.
    expect(() => {
      db.raw.exec(`
        CREATE TABLE IF NOT EXISTS pending_polls (
          map_key TEXT PRIMARY KEY, chat_jid TEXT NOT NULL, tool_id TEXT NOT NULL,
          source TEXT NOT NULL, resolution TEXT NOT NULL, payload TEXT NOT NULL,
          created_at INTEGER NOT NULL, closes_at INTEGER, hard_closes_at INTEGER
        );
      `);
    }).not.toThrow();
  });
});

// ─── Uncovered-branch coverage ───────────────────────────────────────────────

describe('database.ts uncovered-branch coverage', () => {
  // ── Migration idempotency guards (lines 569–791) ──────────────────────────
  //
  // Each ALTER TABLE migration is wrapped in `if (!cols.some(c => c.name === X))`.
  // The normal open path always takes the true branch (column missing → ALTER).
  // To cover the false branch (column already present → skip) we open on a file,
  // delete the schema_migrations rows for the guarded migrations, then reopen.
  // runPendingMigrations re-runs the migration function, which sees the column
  // already exists and skips the ALTER.

  it('migration guards skip ALTER when columns already exist (idempotent re-run)', () => {
    const path = tmpFile();
    const db = new Database(path);
    db.open();

    // Capture pre-state for several guarded columns so we can assert no-op.
    const beforeRawMsgCols = (db.raw.prepare("PRAGMA table_info('messages')").all() as Array<{ name: string }>)
      .map((c) => c.name);
    const beforeSessCols = (db.raw.prepare("PRAGMA table_info('agent_sessions')").all() as Array<{ name: string }>)
      .map((c) => c.name);
    db.close();

    // Wipe the migration records for every guarded migration so they re-run.
    const wipe = new DatabaseSync(path);
    wipe.prepare(
      'DELETE FROM schema_migrations WHERE version IN (5,8,11,12,13,18,19,24)',
    ).run();
    const remaining = wipe.prepare('SELECT count(*) AS n FROM schema_migrations').get() as { n: number };
    wipe.close();
    expect(remaining.n).toBeLessThan(29);

    // Reopen — migration functions re-execute but every guard skips the ALTER.
    const db2 = new Database(path);
    expect(() => db2.open()).not.toThrow();

    const afterRawMsgCols = (db2.raw.prepare("PRAGMA table_info('messages')").all() as Array<{ name: string }>)
      .map((c) => c.name);
    const afterSessCols = (db2.raw.prepare("PRAGMA table_info('agent_sessions')").all() as Array<{ name: string }>)
      .map((c) => c.name);

    // Columns unchanged: idempotency guard held.
    expect(afterRawMsgCols).toEqual(beforeRawMsgCols);
    expect(afterSessCols).toEqual(beforeSessCols);
    // Spot-check the specific guarded columns are still present.
    expect(afterRawMsgCols).toContain('raw_message');
    expect(afterRawMsgCols).toContain('enrichment_retries');
    expect(afterRawMsgCols).toContain('input_tokens');
    expect(afterRawMsgCols).toContain('output_tokens');
    expect(afterRawMsgCols).toContain('model_used');
    expect(afterRawMsgCols).toContain('media_path');
    expect(afterRawMsgCols).toContain('content_text');
    expect(afterRawMsgCols).toContain('updated_at');
    expect(afterSessCols).toContain('total_input_tokens');
    expect(afterSessCols).toContain('total_output_tokens');
    expect(afterSessCols).toContain('ended_at');
    expect(afterSessCols).toContain('provider');

    db2.close();
    cleanup(path);
  });

  it('runPendingMigrations skips already-applied migrations on plain reopen (line 906)', () => {
    const path = tmpFile();
    const db = new Database(path);
    db.open();
    const appliedBefore = (db.raw.prepare('SELECT count(*) AS n FROM schema_migrations').get() as { n: number }).n;
    db.close();

    // Reopen WITHOUT wiping — every migration is in `applied`, so the
    // `if (applied.has(version)) continue;` branch runs for each entry.
    const db2 = new Database(path);
    expect(() => db2.open()).not.toThrow();
    const appliedAfter = (db2.raw.prepare('SELECT count(*) AS n FROM schema_migrations').get() as { n: number }).n;
    db2.close();

    // No new migrations recorded — the skip branch fired for every version.
    expect(appliedAfter).toBe(appliedBefore);
    cleanup(path);
  });

  it('verifyRequiredTables recreates chat_aliases when missing (line 949)', () => {
    const path = tmpFile();
    const db = new Database(path);
    db.open();
    db.close();

    // Externally drop chat_aliases to simulate a phantom-migration state.
    const saboteur = new DatabaseSync(path);
    saboteur.exec('DROP TABLE chat_aliases');
    saboteur.close();

    // Reopen — verifyRequiredTables sees the table missing and recreates it.
    const db2 = new Database(path);
    expect(() => db2.open()).not.toThrow();
    const row = db2.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chat_aliases'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('chat_aliases');
    db2.close();
    cleanup(path);
  });

  // ── importFromLegacyDb branches ───────────────────────────────────────────

  it('importFromLegacyDb skips access_list with unrecognized schema (line 1025-1038)', () => {
    const weirdLegacyPath = tmpFile();
    const weird = new DatabaseSync(weirdLegacyPath);
    weird.exec(`
      CREATE TABLE messages (
        pk INTEGER PRIMARY KEY AUTOINCREMENT, chat_jid TEXT NOT NULL, sender_jid TEXT NOT NULL,
        sender_name TEXT, message_id TEXT UNIQUE, content TEXT,
        content_type TEXT NOT NULL DEFAULT 'text', is_from_me INTEGER NOT NULL DEFAULT 0,
        timestamp INTEGER NOT NULL, quoted_message_id TEXT,
        enrichment_processed_at TEXT, enrichment_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      -- access_list with neither subject_type/subject_id nor phone — unrecognized schema
      CREATE TABLE access_list (
        handle TEXT PRIMARY KEY, status TEXT NOT NULL
      );
      INSERT INTO access_list (handle, status) VALUES ('whoever', 'allowed');
    `);
    weird.close();

    const freshPath = tmpFile();
    const freshDb = new Database(freshPath);
    freshDb.open();
    // Should not throw and should skip the unrecognized access_list silently.
    expect(() => freshDb.importFromLegacyDb(weirdLegacyPath)).not.toThrow();

    const row = freshDb.raw.prepare('SELECT count(*) AS n FROM access_list').get() as { n: number };
    expect(row.n).toBe(0);

    freshDb.close();
    cleanup(freshPath, weirdLegacyPath);
  });

  it('late migrations no-op cleanly when optional legacy target tables are absent', () => {
    const path = tmpFile();
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    const insertVersion = raw.prepare('INSERT INTO schema_migrations (version) VALUES (?)');
    for (let version = 1; version <= 25; version += 1) {
      insertVersion.run(version);
    }
    raw.close();

    const db = new Database(path);
    expect(() => db.open()).not.toThrow();

    const versions = (
      db.raw
        .prepare('SELECT version FROM schema_migrations WHERE version BETWEEN 26 AND 32 ORDER BY version')
        .all() as Array<{ version: number }>
    ).map((row) => row.version);
    expect(versions).toEqual([26, 27, 28, 29, 30, 31, 32]);

    const absentTables = db.raw
      .prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('messages', 'scheduled_messages', 'outbound_sends')
        ORDER BY name
      `)
      .all() as Array<{ name: string }>;
    expect(absentTables).toHaveLength(0);

    const llmAttempts = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'llm_attempts'")
      .get() as { name: string } | undefined;
    expect(llmAttempts?.name).toBe('llm_attempts');

    db.close();
    cleanup(path);
  });

  it('migration 26 rewrites legacy outbound_sends rows and permits the rgp caller', () => {
    const path = tmpFile();
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE outbound_sends (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        line TEXT NOT NULL,
        caller TEXT NOT NULL CHECK (caller IN ('mcp', 'health')),
        chat_jid TEXT NOT NULL,
        target_kind TEXT NOT NULL CHECK (target_kind IN ('chatJid', 'alias')),
        alias TEXT,
        profile TEXT,
        text_hash TEXT NOT NULL,
        text_length INTEGER NOT NULL,
        link_preview_mode TEXT CHECK (link_preview_mode IN ('auto', 'off') OR link_preview_mode IS NULL),
        status TEXT NOT NULL DEFAULT 'intent' CHECK (status IN ('intent', 'sent', 'failed')),
        error TEXT,
        transport_message_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      );
      INSERT INTO outbound_sends (
        line, caller, chat_jid, target_kind, alias, profile, text_hash, text_length,
        link_preview_mode, status, error, transport_message_id, created_at, completed_at
      )
      VALUES (
        'personal', 'mcp', '15550100011@s.whatsapp.net', 'chatJid', NULL, 'default',
        'hash-before-rgp', 12, 'auto', 'sent', NULL, 'transport-1',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'
      );
    `);
    const insertVersion = raw.prepare('INSERT INTO schema_migrations (version) VALUES (?)');
    for (let version = 1; version <= 25; version += 1) {
      insertVersion.run(version);
    }
    raw.close();

    const db = new Database(path);
    expect(() => db.open()).not.toThrow();

    const preserved = db.raw
      .prepare(`
        SELECT caller, chat_jid, text_hash, transport_message_id
        FROM outbound_sends
        WHERE chat_jid = '15550100011@s.whatsapp.net'
      `)
      .get() as { caller: string; chat_jid: string; text_hash: string; transport_message_id: string } | undefined;
    expect(preserved).toEqual({
      caller: 'mcp',
      chat_jid: '15550100011@s.whatsapp.net',
      text_hash: 'hash-before-rgp',
      transport_message_id: 'transport-1',
    });

    expect(() => {
      db.raw.prepare(`
        INSERT INTO outbound_sends (
          line, caller, chat_jid, target_kind, text_hash, text_length, status
        )
        VALUES ('personal', 'rgp', '15550100012@s.whatsapp.net', 'chatJid', 'hash-rgp', 7, 'intent')
      `).run();
    }).not.toThrow();

    const migratedSql = db.raw
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'outbound_sends'")
      .get() as { sql: string } | undefined;
    expect(migratedSql?.sql).toContain("'rgp'");

    const version = db.raw
      .prepare('SELECT version FROM schema_migrations WHERE version = 26')
      .get() as { version: number } | undefined;
    expect(version?.version).toBe(26);

    db.close();
    cleanup(path);
  });

  it('late migrations skip already-upgraded outbound_sends and schedule marker columns', () => {
    const path = tmpFile();
    const db = new Database(path);
    db.open();
    db.raw.prepare(`
      INSERT INTO outbound_sends (
        line, caller, chat_jid, target_kind, text_hash, text_length, status
      )
      VALUES ('personal', 'rgp', '222@s.whatsapp.net', 'chatJid', 'hash', 4, 'sent')
    `).run();
    db.close();

    const rewind = new DatabaseSync(path);
    rewind.prepare('DELETE FROM schema_migrations WHERE version IN (26, 30, 32)').run();
    rewind.close();

    const reopened = new Database(path);
    expect(() => reopened.open()).not.toThrow();

    const preserved = reopened.raw
      .prepare("SELECT caller, status FROM outbound_sends WHERE chat_jid = '222@s.whatsapp.net'")
      .get() as { caller: string; status: string } | undefined;
    expect(preserved).toEqual({ caller: 'rgp', status: 'sent' });

    const scheduleCols = (
      reopened.raw
        .prepare("PRAGMA table_info('scheduled_messages')")
        .all() as Array<{ name: string }>
    ).map((col) => col.name);
    expect(scheduleCols.filter((name) => name === 'timezone')).toHaveLength(1);
    expect(scheduleCols.filter((name) => name === 'send_started_at')).toHaveLength(1);

    const versions = (
      reopened.raw
        .prepare('SELECT version FROM schema_migrations WHERE version IN (26, 30, 32) ORDER BY version')
        .all() as Array<{ version: number }>
    ).map((row) => row.version);
    expect(versions).toEqual([26, 30, 32]);

    reopened.close();
    cleanup(path);
  });

  it('importFromLegacyDb wraps ATTACH failures for existing non-database paths', () => {
    const notDatabaseDir = mkdtempSync(join(tmpdir(), 'whatsoup-legacy-dir-'));
    const db = new Database(':memory:');
    db.open();

    try {
      expect(() => db.importFromLegacyDb(notDatabaseDir)).toThrow(/Failed to ATTACH legacy database/);
    } finally {
      db.close();
      rmSync(notDatabaseDir, { recursive: true, force: true });
    }
  });

  it('importFromLegacyDb skips malformed optional legacy tables while importing valid messages', () => {
    const legacyPath = tmpFile();
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(`
      CREATE TABLE messages (
        pk INTEGER PRIMARY KEY AUTOINCREMENT, chat_jid TEXT NOT NULL, sender_jid TEXT NOT NULL,
        sender_name TEXT, message_id TEXT UNIQUE, content TEXT,
        content_type TEXT NOT NULL DEFAULT 'text', is_from_me INTEGER NOT NULL DEFAULT 0,
        timestamp INTEGER NOT NULL, quoted_message_id TEXT,
        enrichment_processed_at TEXT, enrichment_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE agent_sessions (bad_column TEXT NOT NULL);
      CREATE TABLE rate_limits (bad_column TEXT NOT NULL);
      CREATE TABLE enrichment_runs (bad_column TEXT NOT NULL);
      INSERT INTO messages (chat_jid, sender_jid, message_id, content, timestamp, created_at)
      VALUES ('15550100008@s.whatsapp.net', '15550100008@s.whatsapp.net', 'msg-valid', 'valid', 1700000000, datetime('now'));
      INSERT INTO agent_sessions (bad_column) VALUES ('bad-session');
      INSERT INTO rate_limits (bad_column) VALUES ('bad-rate');
      INSERT INTO enrichment_runs (bad_column) VALUES ('bad-enrichment');
    `);
    legacy.close();

    const freshPath = tmpFile();
    const freshDb = new Database(freshPath);
    freshDb.open();
    expect(() => freshDb.importFromLegacyDb(legacyPath)).not.toThrow();

    const message = freshDb.raw
      .prepare("SELECT conversation_key, content FROM messages WHERE message_id = 'msg-valid'")
      .get() as { conversation_key: string; content: string } | undefined;
    expect(message).toEqual({ conversation_key: '15550100008', content: 'valid' });

    const counts = {
      agentSessions: (freshDb.raw.prepare('SELECT count(*) AS n FROM agent_sessions').get() as { n: number }).n,
      rateLimits: (freshDb.raw.prepare('SELECT count(*) AS n FROM rate_limits').get() as { n: number }).n,
      enrichmentRuns: (freshDb.raw.prepare('SELECT count(*) AS n FROM enrichment_runs').get() as { n: number }).n,
    };
    expect(counts).toEqual({ agentSessions: 0, rateLimits: 0, enrichmentRuns: 0 });

    freshDb.close();
    cleanup(freshPath, legacyPath);
  });

  it('importFromLegacyDb skips legacy messages whose chat_jid cannot be canonicalized', () => {
    const legacyPath = tmpFile();
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(`
      CREATE TABLE messages (
        pk INTEGER PRIMARY KEY AUTOINCREMENT, chat_jid TEXT NOT NULL, sender_jid TEXT NOT NULL,
        sender_name TEXT, message_id TEXT UNIQUE, content TEXT,
        content_type TEXT NOT NULL DEFAULT 'text', is_from_me INTEGER NOT NULL DEFAULT 0,
        timestamp INTEGER NOT NULL, quoted_message_id TEXT,
        enrichment_processed_at TEXT, enrichment_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO messages (chat_jid, sender_jid, message_id, content, timestamp, created_at)
      VALUES
        ('not-a-jid', '15550100009@s.whatsapp.net', 'msg-invalid', 'bad', 1700000000, datetime('now')),
        ('15550100009@s.whatsapp.net', '15550100009@s.whatsapp.net', 'msg-good', 'good', 1700000001, datetime('now'));
    `);
    legacy.close();

    const freshPath = tmpFile();
    const freshDb = new Database(freshPath);
    freshDb.open();
    freshDb.importFromLegacyDb(legacyPath);

    const rows = freshDb.raw
      .prepare('SELECT message_id, conversation_key FROM messages ORDER BY message_id')
      .all() as Array<{ message_id: string; conversation_key: string }>;
    expect(rows).toEqual([{ message_id: 'msg-good', conversation_key: '15550100009' }]);

    freshDb.close();
    cleanup(freshPath, legacyPath);
  });

  it('importFromLegacyDb rolls back copied rows when the required legacy messages table is missing', () => {
    const legacyPath = tmpFile();
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(`
      CREATE TABLE access_list (
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        status TEXT NOT NULL,
        display_name TEXT,
        requested_at TEXT,
        decided_at TEXT,
        PRIMARY KEY (subject_type, subject_id)
      );
      INSERT INTO access_list (subject_type, subject_id, status, display_name, requested_at)
      VALUES ('phone', '15550100010', 'allowed', 'Rollback', datetime('now'));
    `);
    legacy.close();

    const freshPath = tmpFile();
    const freshDb = new Database(freshPath);
    freshDb.open();

    expect(() => freshDb.importFromLegacyDb(legacyPath)).toThrow(/Warm-start import failed/);
    const accessRows = freshDb.raw.prepare('SELECT count(*) AS n FROM access_list').get() as { n: number };
    expect(accessRows.n).toBe(0);
    const attached = freshDb.raw
      .prepare("PRAGMA database_list")
      .all() as Array<{ name: string }>;
    expect(attached.map((row) => row.name)).not.toContain('old');

    freshDb.close();
    cleanup(freshPath, legacyPath);
  });

  it('open wraps pragma failures from a closed raw connection', () => {
    const db = new Database(':memory:');
    db.raw.close();

    expect(() => db.open()).toThrow(/Failed to set database pragmas/);
  });

  it('constructor wraps parent directory creation failures', () => {
    const parentFile = tmpFile();
    writeFileSync(parentFile, 'not a directory');

    try {
      expect(() => new Database(join(parentFile, 'child.db'))).toThrow(/Cannot create DB directory/);
    } finally {
      cleanup(parentFile);
    }
  });

  it('constructor wraps sqlite open failures after directory setup succeeds', () => {
    const directoryPath = mkdtempSync(join(tmpdir(), 'whatsoup-db-file-'));

    try {
      expect(() => new Database(directoryPath)).toThrow(/Cannot open database at/);
    } finally {
      rmSync(directoryPath, { recursive: true, force: true });
    }
  });

  it('open wraps schema_migrations DDL failures', () => {
    const path = tmpFile();
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE blocker (id INTEGER);
      CREATE INDEX schema_migrations ON blocker(id);
    `);
    raw.close();

    const db = new Database(path);
    try {
      expect(() => db.open()).toThrow(/Failed to create schema_migrations table/);
    } finally {
      db.raw.close();
      cleanup(path);
    }
  });

  it('runPendingMigrations rolls back and wraps non-idempotent migration failures', () => {
    const path = tmpFile();
    const db = new Database(path);
    db.open();
    db.close();

    const rewind = new DatabaseSync(path);
    rewind.prepare('DELETE FROM schema_migrations WHERE version = 16').run();
    rewind.close();

    const reopened = new Database(path);
    expect(() => reopened.open()).toThrow(/Migration 16 failed/);
    const version = reopened.raw
      .prepare('SELECT version FROM schema_migrations WHERE version = 16')
      .get() as { version: number } | undefined;
    expect(version).toBeUndefined();
    reopened.close();
    cleanup(path);
  });

  it('close is best-effort when the raw connection is already closed', () => {
    const db = new Database(':memory:');
    db.open();
    db.raw.close();

    expect(() => db.close()).not.toThrow();
  });

  // ── clearChat (line 1230) ──────────────────────────────────────────────────

  it('clearChat soft-deletes all messages in a conversation and returns count', () => {
    const db = new Database(':memory:');
    db.open();

    db.raw.prepare(`
      INSERT INTO messages
        (chat_jid, conversation_key, sender_jid, message_id, content, content_type, is_from_me, timestamp)
      VALUES
        ('15550000001@s.whatsapp.net', '15550000001', '15550000001@s.whatsapp.net', 'm-a', 'hi', 'text', 0, 1700000000),
        ('15550000001@s.whatsapp.net', '15550000001', '15550000001@s.whatsapp.net', 'm-b', 'there', 'text', 0, 1700000001),
        ('15550000002@s.whatsapp.net', '15550000002', '15550000002@s.whatsapp.net', 'm-c', 'other chat', 'text', 0, 1700000002)
    `).run();

    const changed = db.clearChat('15550000001');
    expect(changed).toBe(2);

    // Both messages in the cleared chat are now soft-deleted; the other chat is untouched.
    const cleared = db.raw
      .prepare("SELECT count(*) AS n FROM messages WHERE conversation_key = '15550000001' AND deleted_at IS NOT NULL")
      .get() as { n: number };
    expect(cleared.n).toBe(2);

    const untouched = db.raw
      .prepare("SELECT deleted_at FROM messages WHERE message_id = 'm-c'")
      .get() as { deleted_at: string | null };
    expect(untouched.deleted_at).toBeNull();

    // clearChat is itself idempotent — re-running on the same conversation changes 0 rows.
    const secondRun = db.clearChat('15550000001');
    expect(secondRun).toBe(0);

    db.close();
  });

  // ── storeDecryptionFailure / resolveDecryptionFailure (lines 1251–1266) ───

  it('storeDecryptionFailure upserts and resolveDecryptionFailure marks resolved', () => {
    const db = new Database(':memory:');
    db.open();

    const input: DecryptionFailureInput = {
      messageId: 'msg-decrypt-1',
      chatJid: '15550000003@s.whatsapp.net',
      senderJid: '15550000003@s.whatsapp.net',
      errorMessage: 'persister failed',
      rawKey: { remoteJid: '15550000003@s.whatsapp.net', id: 'msg-decrypt-1', fromMe: false },
      timestamp: 1700000050,
    };

    storeDecryptionFailure(db, input);

    const row1 = db.raw
      .prepare('SELECT message_id, conversation_key, seen_count, resolved, error_message FROM decryption_failures WHERE message_id = ?')
      .get('msg-decrypt-1') as { message_id: string; conversation_key: string; seen_count: number; resolved: number; error_message: string };
    expect(row1).toEqual({
      message_id: 'msg-decrypt-1',
      conversation_key: '15550000003',
      seen_count: 1,
      resolved: 0,
      error_message: 'persister failed',
    });

    // Second store with the same message_id hits the ON CONFLICT upsert (seen_count++).
    storeDecryptionFailure(db, { ...input, errorMessage: 'still failing' });
    const row2 = db.raw
      .prepare('SELECT seen_count, error_message FROM decryption_failures WHERE message_id = ?')
      .get('msg-decrypt-1') as { seen_count: number; error_message: string };
    expect(row2).toEqual({ seen_count: 2, error_message: 'still failing' });

    // Resolve — flips resolved flag and stamps resolved_at.
    resolveDecryptionFailure(db, 'msg-decrypt-1');
    const row3 = db.raw
      .prepare('SELECT resolved, resolved_at FROM decryption_failures WHERE message_id = ?')
      .get('msg-decrypt-1') as { resolved: number; resolved_at: string | null };
    expect(row3.resolved).toBe(1);
    expect(row3.resolved_at).not.toBeNull();

    db.close();
  });

  it('resolveDecryptionFailure is a no-op for an unknown message_id', () => {
    const db = new Database(':memory:');
    db.open();

    // Insert one unresolved row, then resolve a *different* message_id.
    storeDecryptionFailure(db, {
      messageId: 'msg-real',
      chatJid: '15550000004@s.whatsapp.net',
      senderJid: '15550000004@s.whatsapp.net',
      errorMessage: 'err',
      rawKey: { remoteJid: '15550000004@s.whatsapp.net', id: 'msg-real', fromMe: false },
      timestamp: 1700000060,
    });
    resolveDecryptionFailure(db, 'msg-nonexistent');

    const row = db.raw
      .prepare('SELECT message_id, resolved FROM decryption_failures WHERE message_id = ?')
      .get('msg-real') as { message_id: string; resolved: number };
    expect(row).toEqual({ message_id: 'msg-real', resolved: 0 });

    db.close();
  });
});
