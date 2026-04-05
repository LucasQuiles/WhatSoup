/**
 * Migration safety tests — probe incremental apply, ALTER TABLE data preservation,
 * idempotency, constraint integrity, FTS trigger survival, and ordering.
 *
 * Red-team focus areas:
 *   - Data preservation when migrations are applied to non-empty databases
 *   - Idempotency: re-opening a database must not re-apply already-recorded migrations
 *   - ALTER TABLE (migration 5) does not corrupt existing rows or break FTS triggers
 *   - UNIQUE constraints on new tables survive the migration path
 *   - schema_migrations tracks all migration versions exactly once
 *   - Foreign key behaviour across migration boundaries (no implicit cascade)
 *   - Busy-timeout / WAL mode is active before any migration runs
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { unlinkSync, existsSync } from 'node:fs';
import { Database } from '../../src/core/database.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tmpFile(): string {
  return join(tmpdir(), `whatsoup-mig-${randomBytes(8).toString('hex')}.db`);
}

function cleanup(...paths: string[]): void {
  for (const p of paths) {
    for (const suffix of ['', '-wal', '-shm']) {
      const full = p + suffix;
      if (existsSync(full)) {
        try {
          unlinkSync(full);
        } catch {
          /* ignore */
        }
      }
    }
  }
}

/**
 * Raw migration 1 SQL — extracted verbatim from database.ts.
 * Used to manually bootstrap partial-state databases without Database.open().
 */
const MIGRATION_1_SQL = `
CREATE TABLE IF NOT EXISTS messages (
  pk INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  sender_jid TEXT NOT NULL,
  sender_name TEXT,
  message_id TEXT UNIQUE,
  content TEXT,
  content_type TEXT NOT NULL DEFAULT 'text',
  is_from_me INTEGER NOT NULL DEFAULT 0,
  timestamp INTEGER NOT NULL,
  quoted_message_id TEXT,
  edited_at TEXT,
  deleted_at TEXT,
  enrichment_processed_at TEXT,
  enrichment_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_messages_conversation_ts ON messages(conversation_key, timestamp);
CREATE INDEX idx_messages_chat_jid ON messages(chat_jid);
CREATE INDEX idx_messages_sender ON messages(sender_jid, timestamp);
CREATE INDEX idx_messages_enrichment ON messages(enrichment_processed_at) WHERE enrichment_processed_at IS NULL;

CREATE VIRTUAL TABLE messages_fts USING fts5(content, content=messages, content_rowid=pk);

CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages
  WHEN NEW.content IS NOT NULL AND NEW.deleted_at IS NULL
BEGIN INSERT INTO messages_fts(rowid, content) VALUES (NEW.pk, NEW.content); END;

CREATE TRIGGER messages_fts_update AFTER UPDATE OF content ON messages
BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', OLD.pk, OLD.content);
  INSERT INTO messages_fts(rowid, content)
    SELECT NEW.pk, NEW.content WHERE NEW.content IS NOT NULL AND NEW.deleted_at IS NULL;
END;

CREATE TRIGGER messages_fts_soft_delete AFTER UPDATE OF deleted_at ON messages
  WHEN NEW.deleted_at IS NOT NULL
BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', OLD.pk, OLD.content);
END;

CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages
BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', OLD.pk, OLD.content);
END;

CREATE TABLE IF NOT EXISTS contacts (
  jid TEXT PRIMARY KEY,
  canonical_phone TEXT,
  display_name TEXT,
  notify_name TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_contacts_canonical_phone ON contacts(canonical_phone);
CREATE INDEX idx_contacts_display_name ON contacts(display_name);

CREATE TABLE IF NOT EXISTS access_list (
  subject_type TEXT NOT NULL CHECK (subject_type IN ('phone', 'group')),
  subject_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('allowed', 'blocked', 'pending', 'seen')),
  display_name TEXT,
  requested_at TEXT,
  decided_at TEXT,
  PRIMARY KEY (subject_type, subject_id)
);

CREATE TABLE IF NOT EXISTS agent_sessions (
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

CREATE TABLE IF NOT EXISTS rate_limits (
  sender_jid TEXT NOT NULL,
  response_at TEXT NOT NULL
);
CREATE INDEX idx_rate_limits_sender ON rate_limits(sender_jid, response_at);

CREATE TABLE IF NOT EXISTS enrichment_runs (
  run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  messages_processed INTEGER DEFAULT 0,
  facts_extracted INTEGER DEFAULT 0,
  facts_upserted INTEGER DEFAULT 0,
  error TEXT
);
`;

/** Insert a test message directly via raw SQL. Returns the pk. */
function insertTestMessage(
  raw: DatabaseSync,
  overrides: { content?: string; messageId?: string; idx?: number; contentText?: string | null } = {},
): number {
  const idx = overrides.idx ?? 1;
  const content = overrides.content ?? `test message ${idx}`;
  const messageId = overrides.messageId ?? `msg-test-${idx}-${randomBytes(4).toString('hex')}`;
  // After MIGRATION_13, FTS triggers index content_text instead of content.
  // Default content_text to content so FTS indexing works for text messages.
  const contentText = overrides.contentText !== undefined ? overrides.contentText : content;
  // Use content_text column if it exists (post MIGRATION_13), otherwise fall back to content-only insert
  const cols = raw.prepare("PRAGMA table_info('messages')").all() as Array<{ name: string }>;
  const hasContentText = cols.some((c) => c.name === 'content_text');
  if (hasContentText) {
    raw
      .prepare(
        `INSERT INTO messages
           (chat_jid, conversation_key, sender_jid, content, content_text, message_id, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        '15550100001@s.whatsapp.net',
        '15550100001',
        '15550100001@s.whatsapp.net',
        content,
        contentText,
        messageId,
        Date.now() + idx,
      );
  } else {
    raw
      .prepare(
        `INSERT INTO messages
           (chat_jid, conversation_key, sender_jid, content, message_id, timestamp)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        '15550100001@s.whatsapp.net',
        '15550100001',
        '15550100001@s.whatsapp.net',
        content,
        messageId,
        Date.now() + idx,
      );
  }
  const row = raw.prepare('SELECT pk FROM messages ORDER BY pk DESC LIMIT 1').get() as {
    pk: number;
  };
  return row.pk;
}

// ─── Test 1: Migrations apply incrementally on a non-empty database ───────────

describe('Test 1 — incremental migration apply preserves existing data', () => {
  let dbPath: string;

  afterEach(() => cleanup(dbPath));

  it('messages inserted after migration 1 survive migrations 2-10', () => {
    dbPath = tmpFile();

    // Step 1: Bootstrap DB with only migration 1 applied, insert data
    {
      const raw = new DatabaseSync(dbPath);
      raw.exec('PRAGMA journal_mode = WAL');
      raw.exec('PRAGMA foreign_keys = ON');
      raw.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      raw.exec(MIGRATION_1_SQL);
      raw.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(1);
      insertTestMessage(raw, { content: 'pre-existing message alpha', idx: 1, messageId: 'pre-msg-1' });
      insertTestMessage(raw, { content: 'pre-existing message beta', idx: 2, messageId: 'pre-msg-2' });
      raw.close();
    }

    // Step 2: Open via Database class — should apply migrations 2-10
    const db = new Database(dbPath);
    expect(() => db.open()).not.toThrow();

    // Step 3: Verify pre-existing messages are preserved
    const rows = db.raw
      .prepare('SELECT message_id, content FROM messages ORDER BY pk')
      .all() as Array<{ message_id: string; content: string }>;

    expect(rows).toHaveLength(2);
    expect(rows[0].message_id).toBe('pre-msg-1');
    expect(rows[0].content).toBe('pre-existing message alpha');
    expect(rows[1].message_id).toBe('pre-msg-2');
    expect(rows[1].content).toBe('pre-existing message beta');

    // Step 4: Verify new tables from migrations 2-10 were created
    const tableNames = (
      db.raw
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);

    for (const expected of [
      'inbound_events',
      'outbound_ops',
      'chats',
      'reactions',
      'receipts',
      'labels',
      'label_associations',
      'blocklist',
      'control_messages',
      'lid_mappings',
      'heal_reports',
      'pending_heal_reports',
    ]) {
      expect(tableNames, `Expected table '${expected}' to exist after incremental migration`).toContain(expected);
    }

    // Step 5: Verify raw_message column from migration 5 exists
    const cols = db.raw.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name), 'raw_message column should exist after migration 5').toContain('raw_message');

    db.close();
  });
});

// ─── Test 2: ALTER TABLE (migration 5) preserves existing rows ────────────────

describe('Test 2 — ALTER TABLE ADD COLUMN preserves 100 pre-existing messages', () => {
  let dbPath: string;

  afterEach(() => cleanup(dbPath));

  it('all 100 messages survive migration 5 with raw_message = NULL', () => {
    dbPath = tmpFile();

    // Apply migrations 1-4 manually, insert 100 messages, then let DB.open() apply 5+6+7
    {
      const raw = new DatabaseSync(dbPath);
      raw.exec('PRAGMA journal_mode = WAL');
      raw.exec('PRAGMA foreign_keys = ON');
      raw.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);

      raw.exec(MIGRATION_1_SQL);
      raw.prepare('INSERT INTO schema_migrations (version) VALUES (1)').run();

      raw.exec(`
        CREATE TABLE IF NOT EXISTS inbound_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, conversation_key TEXT NOT NULL, chat_jid TEXT NOT NULL, received_at TEXT NOT NULL DEFAULT (datetime('now')), routed_to TEXT, processing_status TEXT NOT NULL DEFAULT 'pending', completed_at TEXT, terminal_reason TEXT, UNIQUE(message_id));
        CREATE TABLE IF NOT EXISTS outbound_ops (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_key TEXT NOT NULL, chat_jid TEXT NOT NULL, op_type TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')), submitted_at TEXT, echoed_at TEXT, wa_message_id TEXT, error TEXT, source_inbound_seq INTEGER, retry_count INTEGER DEFAULT 0, is_terminal INTEGER DEFAULT 0, replay_policy TEXT NOT NULL DEFAULT 'unsafe');
        CREATE INDEX IF NOT EXISTS idx_outbound_ops_status ON outbound_ops(status);
        CREATE INDEX IF NOT EXISTS idx_outbound_ops_source ON outbound_ops(source_inbound_seq);
        CREATE TABLE IF NOT EXISTS tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_key TEXT NOT NULL, session_checkpoint_id INTEGER, tool_name TEXT NOT NULL, tool_input TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', result TEXT, replay_policy TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT, outbound_op_id INTEGER);
        CREATE TABLE IF NOT EXISTS session_checkpoints (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_key TEXT NOT NULL, session_id TEXT, transcript_path TEXT, active_turn_id TEXT, last_inbound_seq INTEGER, last_flushed_outbound_id INTEGER, watchdog_state TEXT, workspace_path TEXT, claude_pid INTEGER, checkpoint_version INTEGER NOT NULL DEFAULT 1, session_status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(conversation_key));
        CREATE TABLE IF NOT EXISTS recovery_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT, trigger TEXT NOT NULL, inbound_replayed INTEGER DEFAULT 0, outbound_reconciled INTEGER DEFAULT 0, outbound_replayed INTEGER DEFAULT 0, outbound_quarantined INTEGER DEFAULT 0, tool_calls_recovered INTEGER DEFAULT 0, tool_calls_replayed INTEGER DEFAULT 0, tool_calls_quarantined INTEGER DEFAULT 0, sessions_restored INTEGER DEFAULT 0, notes TEXT);
      `);
      raw.prepare('INSERT INTO schema_migrations (version) VALUES (2)').run();

      raw.exec(`
        CREATE TABLE IF NOT EXISTS chats (jid TEXT PRIMARY KEY, conversation_key TEXT NOT NULL, name TEXT, unread_count INTEGER DEFAULT 0, is_archived INTEGER DEFAULT 0, is_pinned INTEGER DEFAULT 0, mute_until TEXT, ephemeral_duration INTEGER, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE INDEX IF NOT EXISTS idx_chats_conversation_key ON chats(conversation_key);
        CREATE TABLE IF NOT EXISTS reactions (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, conversation_key TEXT NOT NULL, sender_jid TEXT NOT NULL, reaction TEXT NOT NULL, timestamp TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(message_id, sender_jid));
        CREATE INDEX IF NOT EXISTS idx_reactions_message_id ON reactions(message_id);
        CREATE TABLE IF NOT EXISTS receipts (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, recipient_jid TEXT NOT NULL, type TEXT NOT NULL, timestamp TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(message_id, recipient_jid, type));
        CREATE INDEX IF NOT EXISTS idx_receipts_message_id ON receipts(message_id);
      `);
      raw.prepare('INSERT INTO schema_migrations (version) VALUES (3)').run();

      raw.exec(`
        CREATE TABLE IF NOT EXISTS labels (id TEXT PRIMARY KEY, name TEXT NOT NULL, color INTEGER, predefined_id TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE IF NOT EXISTS label_associations (id INTEGER PRIMARY KEY AUTOINCREMENT, label_id TEXT NOT NULL, type TEXT NOT NULL, chat_jid TEXT NOT NULL DEFAULT '', message_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(label_id, type, chat_jid, message_id));
      `);
      raw.prepare('INSERT INTO schema_migrations (version) VALUES (4)').run();

      // Insert 100 messages BEFORE migration 5
      const insert = raw.prepare(
        `INSERT INTO messages (chat_jid, conversation_key, sender_jid, content, message_id, timestamp)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (let i = 1; i <= 100; i++) {
        insert.run(
          '15550100001@s.whatsapp.net',
          '15550100001',
          '15550100001@s.whatsapp.net',
          `message content ${i}`,
          `batch-msg-${i}`,
          1700000000 + i,
        );
      }

      raw.close();
    }

    // Database.open() should apply migrations 5, 6, and 7
    const db = new Database(dbPath);
    expect(() => db.open()).not.toThrow();

    const count = (db.raw.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }).n;
    expect(count, '100 messages must survive the ALTER TABLE migration').toBe(100);

    const nullCount = (
      db.raw.prepare('SELECT count(*) AS n FROM messages WHERE raw_message IS NULL').get() as { n: number }
    ).n;
    expect(nullCount, 'raw_message must be NULL for all pre-existing rows').toBe(100);

    // Spot-check first and last rows
    const first = db.raw
      .prepare('SELECT content FROM messages WHERE message_id = ?')
      .get('batch-msg-1') as { content: string } | undefined;
    expect(first?.content).toBe('message content 1');

    const last = db.raw
      .prepare('SELECT content FROM messages WHERE message_id = ?')
      .get('batch-msg-100') as { content: string } | undefined;
    expect(last?.content).toBe('message content 100');

    db.close();
  });
});

// ─── Test 3: Idempotency ──────────────────────────────────────────────────────

describe('Test 3 — migrations are idempotent (reopen does not throw)', () => {
  let dbPath: string;

  afterEach(() => cleanup(dbPath));

  it('opening a fully-migrated file DB a second time does not throw', () => {
    dbPath = tmpFile();

    // First open — applies all known migrations
    {
      const db = new Database(dbPath);
      db.open();
      db.close();
    }

    // Second open — schema_migrations has all known versions; migration 5 must NOT re-run
    const db2 = new Database(dbPath);
    expect(() => db2.open()).not.toThrow();

    const versions = (
      db2.raw
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all() as Array<{ version: number }>
    ).map((r) => r.version);
    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);

    db2.close();
  });

  it('opening :memory: DB twice via separate instances is idempotent within each', () => {
    // Each :memory: instance is isolated — both should open cleanly
    const db1 = new Database(':memory:');
    expect(() => db1.open()).not.toThrow();
    db1.close();

    const db2 = new Database(':memory:');
    expect(() => db2.open()).not.toThrow();
    db2.close();
  });
});

// ─── Test 4: UNIQUE constraints on new tables ─────────────────────────────────

describe('Test 4 — UNIQUE constraints on Wave 2/4 tables fire correctly', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
  });

  it('reactions UNIQUE(message_id, sender_jid) rejects duplicate', () => {
    db.raw
      .prepare('INSERT INTO reactions (message_id, conversation_key, sender_jid, reaction) VALUES (?,?,?,?)')
      .run('m1', 'conv1', 'alice@s.whatsapp.net', '\u{1F44D}');

    expect(() => {
      db.raw
        .prepare('INSERT INTO reactions (message_id, conversation_key, sender_jid, reaction) VALUES (?,?,?,?)')
        .run('m1', 'conv1', 'alice@s.whatsapp.net', '\u{2764}\u{FE0F}');
    }).toThrow(/UNIQUE constraint failed/);
  });

  it('reactions allows same message_id from different senders', () => {
    db.raw
      .prepare('INSERT INTO reactions (message_id, conversation_key, sender_jid, reaction) VALUES (?,?,?,?)')
      .run('m2', 'conv1', 'alice@s.whatsapp.net', '\u{1F44D}');

    expect(() => {
      db.raw
        .prepare('INSERT INTO reactions (message_id, conversation_key, sender_jid, reaction) VALUES (?,?,?,?)')
        .run('m2', 'conv1', 'bob@s.whatsapp.net', '\u{1F44D}');
    }).not.toThrow();
  });

  it('receipts UNIQUE(message_id, recipient_jid, type) rejects exact duplicate', () => {
    db.raw
      .prepare('INSERT INTO receipts (message_id, recipient_jid, type) VALUES (?,?,?)')
      .run('m3', 'alice@s.whatsapp.net', 'delivery');

    expect(() => {
      db.raw
        .prepare('INSERT INTO receipts (message_id, recipient_jid, type) VALUES (?,?,?)')
        .run('m3', 'alice@s.whatsapp.net', 'delivery');
    }).toThrow(/UNIQUE constraint failed/);
  });

  it('receipts allows same message_id + recipient with different type', () => {
    db.raw
      .prepare('INSERT INTO receipts (message_id, recipient_jid, type) VALUES (?,?,?)')
      .run('m4', 'alice@s.whatsapp.net', 'delivery');

    expect(() => {
      db.raw
        .prepare('INSERT INTO receipts (message_id, recipient_jid, type) VALUES (?,?,?)')
        .run('m4', 'alice@s.whatsapp.net', 'read');
    }).not.toThrow();
  });

  it('label_associations UNIQUE(label_id, type, chat_jid, message_id) rejects duplicate', () => {
    db.raw
      .prepare('INSERT INTO label_associations (label_id, type, chat_jid, message_id) VALUES (?,?,?,?)')
      .run('lbl1', 'chat', 'jid1@s.whatsapp.net', '');

    expect(() => {
      db.raw
        .prepare('INSERT INTO label_associations (label_id, type, chat_jid, message_id) VALUES (?,?,?,?)')
        .run('lbl1', 'chat', 'jid1@s.whatsapp.net', '');
    }).toThrow(/UNIQUE constraint failed/);
  });
});

// ─── Test 5: schema_migrations version tracking ───────────────────────────────

describe('Test 5 — schema_migrations version tracking', () => {
  it('records all migration versions in order', () => {
    const db = new Database(':memory:');
    db.open();

    const rows = db.raw
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: number }>;

    expect(rows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);

    db.close();
  });

  it('each version appears exactly once (no duplicates)', () => {
    const db = new Database(':memory:');
    db.open();

    const rows = db.raw
      .prepare('SELECT version, count(*) AS cnt FROM schema_migrations GROUP BY version')
      .all() as Array<{ version: number; cnt: number }>;

    for (const row of rows) {
      expect(row.cnt, `Version ${row.version} should appear exactly once`).toBe(1);
    }

    db.close();
  });

  it('applied_at is recorded for all versions', () => {
    const db = new Database(':memory:');
    db.open();

    const rows = db.raw
      .prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: number; applied_at: string }>;

    for (const row of rows) {
      expect(row.applied_at, `Version ${row.version} should have applied_at set`).toBeTruthy();
    }

    db.close();
  });
});

// ─── Test 6: FTS triggers survive ALTER TABLE ADD COLUMN ─────────────────────

describe('Test 6 — FTS triggers survive migration 5 ALTER TABLE', () => {
  let dbPath: string;

  afterEach(() => cleanup(dbPath));

  it('FTS search works for messages inserted before and after migration 5', () => {
    dbPath = tmpFile();

    // Setup: migrations 1-4 applied with messages inserted, then open() adds 5+6
    {
      const raw = new DatabaseSync(dbPath);
      raw.exec('PRAGMA journal_mode = WAL');
      raw.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      raw.exec(MIGRATION_1_SQL);
      raw.prepare('INSERT INTO schema_migrations (version) VALUES (1)').run();

      // Minimal stubs for migrations 2-4 so open() only needs to apply 5+6
      raw.exec(`
        CREATE TABLE IF NOT EXISTS inbound_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, conversation_key TEXT NOT NULL, chat_jid TEXT NOT NULL, received_at TEXT NOT NULL DEFAULT (datetime('now')), routed_to TEXT, processing_status TEXT NOT NULL DEFAULT 'pending', completed_at TEXT, terminal_reason TEXT, UNIQUE(message_id));
        CREATE TABLE IF NOT EXISTS outbound_ops (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_key TEXT NOT NULL, chat_jid TEXT NOT NULL, op_type TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')), submitted_at TEXT, echoed_at TEXT, wa_message_id TEXT, error TEXT, source_inbound_seq INTEGER, retry_count INTEGER DEFAULT 0, is_terminal INTEGER DEFAULT 0, replay_policy TEXT NOT NULL DEFAULT 'unsafe');
        CREATE TABLE IF NOT EXISTS tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_key TEXT NOT NULL, session_checkpoint_id INTEGER, tool_name TEXT NOT NULL, tool_input TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', result TEXT, replay_policy TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT, outbound_op_id INTEGER);
        CREATE TABLE IF NOT EXISTS session_checkpoints (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_key TEXT NOT NULL, session_id TEXT, transcript_path TEXT, active_turn_id TEXT, last_inbound_seq INTEGER, last_flushed_outbound_id INTEGER, watchdog_state TEXT, workspace_path TEXT, claude_pid INTEGER, checkpoint_version INTEGER NOT NULL DEFAULT 1, session_status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(conversation_key));
        CREATE TABLE IF NOT EXISTS recovery_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT, trigger TEXT NOT NULL, inbound_replayed INTEGER DEFAULT 0, outbound_reconciled INTEGER DEFAULT 0, outbound_replayed INTEGER DEFAULT 0, outbound_quarantined INTEGER DEFAULT 0, tool_calls_recovered INTEGER DEFAULT 0, tool_calls_replayed INTEGER DEFAULT 0, tool_calls_quarantined INTEGER DEFAULT 0, sessions_restored INTEGER DEFAULT 0, notes TEXT);
        CREATE TABLE IF NOT EXISTS chats (jid TEXT PRIMARY KEY, conversation_key TEXT NOT NULL, name TEXT, unread_count INTEGER DEFAULT 0, is_archived INTEGER DEFAULT 0, is_pinned INTEGER DEFAULT 0, mute_until TEXT, ephemeral_duration INTEGER, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE IF NOT EXISTS reactions (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, conversation_key TEXT NOT NULL, sender_jid TEXT NOT NULL, reaction TEXT NOT NULL, timestamp TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(message_id, sender_jid));
        CREATE TABLE IF NOT EXISTS receipts (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, recipient_jid TEXT NOT NULL, type TEXT NOT NULL, timestamp TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(message_id, recipient_jid, type));
        CREATE TABLE IF NOT EXISTS labels (id TEXT PRIMARY KEY, name TEXT NOT NULL, color INTEGER, predefined_id TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE IF NOT EXISTS label_associations (id INTEGER PRIMARY KEY AUTOINCREMENT, label_id TEXT NOT NULL, type TEXT NOT NULL, chat_jid TEXT NOT NULL DEFAULT '', message_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(label_id, type, chat_jid, message_id));
      `);
      raw.prepare('INSERT INTO schema_migrations (version) VALUES (2)').run();
      raw.prepare('INSERT INTO schema_migrations (version) VALUES (3)').run();
      raw.prepare('INSERT INTO schema_migrations (version) VALUES (4)').run();

      // Insert a message BEFORE migration 5
      raw
        .prepare(
          `INSERT INTO messages (chat_jid, conversation_key, sender_jid, content, message_id, timestamp)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          '15550100001@s.whatsapp.net',
          '15550100001',
          '15550100001@s.whatsapp.net',
          'fts-probe-unique-term-xyzalt',
          'fts-pre-msg-1',
          1700000001,
        );

      raw.close();
    }

    const db = new Database(dbPath);
    db.open();

    // FTS for pre-migration message
    const preHits = db.raw
      .prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'xyzalt'")
      .all() as Array<{ rowid: number }>;
    expect(preHits, 'FTS must find message inserted before migration 5').toHaveLength(1);

    // Insert message AFTER migration 5 — trigger must fire
    const newPk = insertTestMessage(db.raw, {
      content: 'post-migration-fts-term-xyzpost',
      messageId: 'fts-post-msg-1',
      idx: 99,
    });

    const postHits = db.raw
      .prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'xyzpost'")
      .all() as Array<{ rowid: number }>;
    expect(postHits, 'FTS trigger must fire after migration 5').toHaveLength(1);
    expect(postHits[0].rowid).toBe(newPk);

    // raw_message column is writable
    db.raw
      .prepare('UPDATE messages SET raw_message = ? WHERE message_id = ?')
      .run('{"key":"value"}', 'fts-post-msg-1');
    const updated = db.raw
      .prepare('SELECT raw_message FROM messages WHERE message_id = ?')
      .get('fts-post-msg-1') as { raw_message: string } | undefined;
    expect(updated?.raw_message).toBe('{"key":"value"}');

    db.close();
  });
});

// ─── Test 7: FK behaviour across migration boundaries ────────────────────────

describe('Test 7 — FK behaviour: reactions/receipts do not cascade-delete', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
  });

  it('reaction can be inserted referencing a valid message_id', () => {
    const pk = insertTestMessage(db.raw, { content: 'fk-test message', idx: 1, messageId: 'fk-msg-1' });
    expect(pk).toBeGreaterThan(0);

    expect(() => {
      db.raw
        .prepare('INSERT INTO reactions (message_id, conversation_key, sender_jid, reaction) VALUES (?,?,?,?)')
        .run('fk-msg-1', '15550100001', 'alice@s.whatsapp.net', '\u{1F44D}');
    }).not.toThrow();

    const rxn = db.raw
      .prepare('SELECT reaction FROM reactions WHERE message_id = ?')
      .get('fk-msg-1') as { reaction: string } | undefined;
    expect(rxn?.reaction).toBe('\u{1F44D}');
  });

  it('deleting message does NOT cascade-delete reactions (no FK cascade by design)', () => {
    insertTestMessage(db.raw, { content: 'cascade-test', idx: 2, messageId: 'fk-msg-2' });
    db.raw
      .prepare('INSERT INTO reactions (message_id, conversation_key, sender_jid, reaction) VALUES (?,?,?,?)')
      .run('fk-msg-2', '15550100001', 'alice@s.whatsapp.net', '\u{2764}\u{FE0F}');

    db.raw.prepare('DELETE FROM messages WHERE message_id = ?').run('fk-msg-2');

    const rxn = db.raw
      .prepare('SELECT reaction FROM reactions WHERE message_id = ?')
      .get('fk-msg-2') as { reaction: string } | undefined;
    expect(rxn?.reaction, 'Reaction should persist — no FK cascade by design').toBe('\u{2764}\u{FE0F}');
  });

  it('receipts also survive message deletion (same no-cascade design)', () => {
    insertTestMessage(db.raw, { content: 'receipt-test', idx: 3, messageId: 'fk-msg-3' });
    db.raw
      .prepare('INSERT INTO receipts (message_id, recipient_jid, type) VALUES (?,?,?)')
      .run('fk-msg-3', 'alice@s.whatsapp.net', 'delivery');

    db.raw.prepare('DELETE FROM messages WHERE message_id = ?').run('fk-msg-3');

    const receipt = db.raw
      .prepare('SELECT type FROM receipts WHERE message_id = ?')
      .get('fk-msg-3') as { type: string } | undefined;
    expect(receipt?.type, 'Receipt should persist — no FK cascade by design').toBe('delivery');
  });
});

// ─── Test 8: Happy path — empty DB gets all migrations at once ────────────────

describe('Test 8 — fresh :memory: DB receives all migrations', () => {
  it('all tables exist and all versions are recorded', () => {
    const db = new Database(':memory:');
    db.open();

    const versions = (
      db.raw
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all() as Array<{ version: number }>
    ).map((r) => r.version);
    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);

    const tables = (
      db.raw
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);

    const expectedTables = [
      'access_list',
      'agent_sessions',
      'blocklist',
      'chats',
      'control_messages',
      'contacts',
      'enrichment_runs',
      'groups',
      'heal_reports',
      'inbound_events',
      'label_associations',
      'labels',
      'lid_mappings',
      'messages',
      'outbound_ops',
      'pending_heal_reports',
      'rate_limits',
      'reactions',
      'receipts',
      'recovery_runs',
      'schema_migrations',
      'session_checkpoints',
      'tool_calls',
    ];

    for (const t of expectedTables) {
      expect(tables, `Table '${t}' should exist after fresh open()`).toContain(t);
    }

    // raw_message column present after migration 5
    const cols = db.raw.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('raw_message');

    db.close();
  });
});

// ─── Test 9: Migration ordering — partial state ───────────────────────────────

describe('Test 9 — migration ordering: only version 1 recorded, 2-10 apply in order', () => {
  let dbPath: string;

  afterEach(() => cleanup(dbPath));

  it('opens cleanly and applies 2-10 when only version 1 is in schema_migrations', () => {
    dbPath = tmpFile();

    {
      const raw = new DatabaseSync(dbPath);
      raw.exec('PRAGMA journal_mode = WAL');
      raw.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      raw.exec(MIGRATION_1_SQL);
      raw.prepare('INSERT INTO schema_migrations (version) VALUES (1)').run();
      raw.close();
    }

    const db = new Database(dbPath);
    expect(() => db.open()).not.toThrow();

    const versions = (
      db.raw
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all() as Array<{ version: number }>
    ).map((r) => r.version);

    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);

    // raw_message column from migration 5
    const cols = db.raw.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('raw_message');

    // blocklist and lid_mappings from migration 6
    const tables = (
      db.raw
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables).toContain('blocklist');
    expect(tables).toContain('lid_mappings');

    // groups table from migration 7
    expect(tables).toContain('groups');

    db.close();
  });

  it('applying migration 5 without migration 1 base table would fail', () => {
    // This verifies the ordering constraint: migration 5 (ALTER TABLE messages)
    // depends on migration 1 (CREATE TABLE messages). We probe this by trying
    // to apply migration 5 SQL on a DB that has no messages table.
    const raw = new DatabaseSync(':memory:');
    expect(() => {
      raw.exec('ALTER TABLE messages ADD COLUMN raw_message TEXT');
    }).toThrow(); // "no such table: messages"
    raw.close();
  });
});

// ─── Test 10: WAL mode + busy_timeout active ──────────────────────────────────

describe('Test 10 — WAL mode and busy_timeout are set before migrations run', () => {
  let dbPath: string;

  afterEach(() => cleanup(dbPath));

  it('WAL journal_mode is active on a freshly opened file DB', () => {
    dbPath = tmpFile();
    const db = new Database(dbPath);
    db.open();

    const row = db.raw.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(row.journal_mode).toBe('wal');

    db.close();
  });

  it('busy_timeout is set to 5000ms', () => {
    dbPath = tmpFile();
    const db = new Database(dbPath);
    db.open();

    const row = db.raw.prepare('PRAGMA busy_timeout').get() as { timeout: number };
    expect(row.timeout).toBe(5000);

    db.close();
  });

  it('foreign_keys pragma is ON', () => {
    dbPath = tmpFile();
    const db = new Database(dbPath);
    db.open();

    const row = db.raw.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(row.foreign_keys).toBe(1);

    db.close();
  });

  it(':memory: DB also opens without throwing (WAL may downgrade gracefully)', () => {
    // SQLite :memory: may silently keep journal_mode=memory when WAL is set.
    // We verify the DB opens and is functional regardless.
    const db = new Database(':memory:');
    expect(() => db.open()).not.toThrow();
    const row = db.raw.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    // Accept 'wal' or 'memory' — both are valid for in-memory DBs
    expect(['wal', 'memory']).toContain(row.journal_mode);
    db.close();
  });
});
