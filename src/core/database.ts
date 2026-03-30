import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createChildLogger } from '../logger.ts';
import { WhatSoupError } from '../errors.ts';
import { toConversationKey } from './conversation-key.ts';

const log = createChildLogger('database');

// ─── Migration 1: Full schema DDL ───────────────────────────────────────────

const MIGRATION_1 = `
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

// ─── Known migrations ────────────────────────────────────────────────────────

type MigrationFn = (db: DatabaseSync) => void;

const MIGRATIONS: Map<number, MigrationFn> = new Map([
  [
    1,
    (db: DatabaseSync) => {
      db.exec(MIGRATION_1);
    },
  ],
]);

// ─── Database class ──────────────────────────────────────────────────────────

export class Database {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      try {
        mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
      } catch (err) {
        throw new WhatSoupError(
          `Cannot create DB directory: ${dirname(dbPath)}`,
          'DATABASE_ERROR',
          err,
        );
      }
    }

    try {
      this.db = new DatabaseSync(dbPath);
    } catch (err) {
      throw new WhatSoupError(`Cannot open database at ${dbPath}`, 'DATABASE_ERROR', err);
    }
  }

  /**
   * Apply pragmas and run pending migrations. Call once after construction.
   * No admin phone seeding — that belongs in main.ts.
   */
  open(): void {
    try {
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA busy_timeout = 5000');
      this.db.exec('PRAGMA foreign_keys = ON');
      this.db.exec('PRAGMA synchronous = NORMAL');
    } catch (err) {
      throw new WhatSoupError('Failed to set database pragmas', 'DATABASE_ERROR', err);
    }

    // Verify WAL mode took effect
    const journalMode = (
      this.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string } | undefined
    )?.journal_mode;
    if (journalMode !== 'wal') {
      log.warn({ journalMode }, 'Expected WAL journal mode but got something else');
    }

    // Ensure schema_migrations exists before running migrations
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
    } catch (err) {
      throw new WhatSoupError(
        'Failed to create schema_migrations table',
        'DATABASE_ERROR',
        err,
      );
    }

    this.runPendingMigrations();
    log.info('Database opened and schema initialised');
  }

  /** Run any migrations not yet recorded in schema_migrations. */
  private runPendingMigrations(): void {
    const applied = new Set<number>(
      (
        this.db.prepare('SELECT version FROM schema_migrations').all() as Array<{
          version: number;
        }>
      ).map((r) => r.version),
    );

    const insertVersion = this.db.prepare(
      `INSERT INTO schema_migrations (version) VALUES (?)`,
    );

    for (const [version, migrateFn] of MIGRATIONS) {
      if (applied.has(version)) continue;

      log.info({ version }, 'Applying migration');
      try {
        this.db.exec('BEGIN');
        migrateFn(this.db);
        insertVersion.run(version);
        this.db.exec('COMMIT');
        log.info({ version }, 'Migration applied');
      } catch (err) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // best effort
        }
        throw new WhatSoupError(`Migration ${version} failed`, 'DATABASE_ERROR', err);
      }
    }
  }

  /**
   * Import data from a legacy whatsapp-bot database.
   *
   * The legacy schema has messages WITHOUT conversation_key; this method
   * backfills the column using toConversationKey(chat_jid).
   *
   * Tables fully copied: access_list, agent_sessions, rate_limits, enrichment_runs.
   * FTS5 is auto-populated by the INSERT trigger on messages.
   */
  importFromLegacyDb(oldDbPath: string): void {
    if (!existsSync(oldDbPath)) {
      throw new WhatSoupError(
        `Legacy DB not found: ${oldDbPath}`,
        'DATABASE_ERROR',
      );
    }

    log.info({ oldDbPath }, 'Starting warm-start import from legacy DB');

    const escapedPath = oldDbPath.replace(/'/g, "''");
    try {
      this.db.exec(`ATTACH DATABASE '${escapedPath}' AS old`);
    } catch (err) {
      throw new WhatSoupError('Failed to ATTACH legacy database', 'DATABASE_ERROR', err);
    }

    try {
      this.db.exec('BEGIN');

      const counts: Record<string, number> = {};

      // ── access_list ──────────────────────────────────────────────────────
      try {
        this.db.exec(`
          INSERT OR IGNORE INTO main.access_list
            (subject_type, subject_id, status, display_name, requested_at, decided_at)
          SELECT subject_type, subject_id, status, display_name, requested_at, decided_at
          FROM old.access_list
        `);
        const row = this.db.prepare('SELECT changes() AS n').get() as { n: number };
        counts['access_list'] = row.n;
      } catch {
        counts['access_list'] = 0;
      }

      // ── agent_sessions ───────────────────────────────────────────────────
      try {
        this.db.exec(`
          INSERT OR IGNORE INTO main.agent_sessions
            (id, session_id, claude_pid, started_in_directory, chat_jid, workspace_key,
             transcript_path, message_count, started_at, last_message_at, status)
          SELECT id, session_id, claude_pid, started_in_directory, chat_jid, workspace_key,
                 transcript_path, message_count, started_at, last_message_at, status
          FROM old.agent_sessions
        `);
        const row = this.db.prepare('SELECT changes() AS n').get() as { n: number };
        counts['agent_sessions'] = row.n;
      } catch {
        counts['agent_sessions'] = 0;
      }

      // ── rate_limits ──────────────────────────────────────────────────────
      try {
        this.db.exec(`
          INSERT INTO main.rate_limits (sender_jid, response_at)
          SELECT sender_jid, response_at FROM old.rate_limits
          WHERE NOT EXISTS (
            SELECT 1 FROM main.rate_limits r
            WHERE r.sender_jid = old.rate_limits.sender_jid
            AND r.response_at = old.rate_limits.response_at
          )
        `);
        const row = this.db.prepare('SELECT changes() AS n').get() as { n: number };
        counts['rate_limits'] = row.n;
      } catch {
        counts['rate_limits'] = 0;
      }

      // ── enrichment_runs ──────────────────────────────────────────────────
      try {
        this.db.exec(`
          INSERT OR IGNORE INTO main.enrichment_runs
            (run_id, started_at, completed_at, messages_processed,
             facts_extracted, facts_upserted, error)
          SELECT run_id, started_at, completed_at, messages_processed,
                 facts_extracted, facts_upserted, error
          FROM old.enrichment_runs
        `);
        const row = this.db.prepare('SELECT changes() AS n').get() as { n: number };
        counts['enrichment_runs'] = row.n;
      } catch {
        counts['enrichment_runs'] = 0;
      }

      // ── messages (with conversation_key backfill) ────────────────────────
      // Legacy columns: pk, chat_jid, sender_jid, sender_name, message_id,
      //   content, content_type, is_from_me, timestamp, quoted_message_id,
      //   enrichment_processed_at, enrichment_error, created_at
      // FTS5 insert trigger fires automatically for non-null, non-deleted content.

      type LegacyMessage = {
        pk: number;
        chat_jid: string;
        sender_jid: string;
        sender_name: string | null;
        message_id: string | null;
        content: string | null;
        content_type: string;
        is_from_me: number;
        timestamp: number;
        quoted_message_id: string | null;
        enrichment_processed_at: string | null;
        enrichment_error: string | null;
        created_at: string;
      };

      const legacyRows = this.db
        .prepare(
          `SELECT pk, chat_jid, sender_jid, sender_name, message_id, content,
                  content_type, is_from_me, timestamp, quoted_message_id,
                  enrichment_processed_at, enrichment_error, created_at
           FROM old.messages`,
        )
        .all() as LegacyMessage[];

      const insertMsg = this.db.prepare(`
        INSERT OR IGNORE INTO main.messages
          (pk, chat_jid, conversation_key, sender_jid, sender_name, message_id,
           content, content_type, is_from_me, timestamp, quoted_message_id,
           enrichment_processed_at, enrichment_error, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      let msgCount = 0;
      for (const row of legacyRows) {
        let conversationKey: string;
        try {
          conversationKey = toConversationKey(row.chat_jid);
        } catch {
          log.warn({ chat_jid: row.chat_jid }, 'Cannot compute conversation_key, skipping message');
          continue;
        }
        insertMsg.run(
          row.pk,
          row.chat_jid,
          conversationKey,
          row.sender_jid,
          row.sender_name,
          row.message_id,
          row.content,
          row.content_type,
          row.is_from_me,
          row.timestamp,
          row.quoted_message_id,
          row.enrichment_processed_at,
          row.enrichment_error,
          row.created_at,
        );
        msgCount++;
      }
      counts['messages'] = msgCount;

      this.db.exec('COMMIT');
      log.info(counts, 'Warm-start import complete');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // best effort
      }
      try {
        this.db.exec('DETACH DATABASE old');
      } catch {
        // best effort
      }
      throw new WhatSoupError('Warm-start import failed', 'DATABASE_ERROR', err);
    }

    try {
      this.db.exec('DETACH DATABASE old');
    } catch (err) {
      log.warn({ err }, 'Failed to DETACH legacy database');
    }
  }

  /** WAL checkpoint and close the connection. */
  close(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (err) {
      log.warn({ err }, 'WAL checkpoint failed during close');
    }
    try {
      this.db.close();
    } catch (err) {
      log.warn({ err }, 'Error closing database');
    }
    log.info('Database closed');
  }

  /**
   * Soft-delete all messages in a conversation (clear-chat event).
   * Sets deleted_at on every non-deleted message matching the conversation_key.
   * The messages_fts_soft_delete trigger removes them from FTS automatically.
   */
  clearChat(conversationKey: string): number {
    this.db.prepare(
      `UPDATE messages SET deleted_at = datetime('now')
       WHERE conversation_key = ? AND deleted_at IS NULL`,
    ).run(conversationKey);
    const row = this.db.prepare('SELECT changes() AS n').get() as { n: number };
    return row.n;
  }

  /** Expose the underlying DatabaseSync for query modules. */
  get raw(): DatabaseSync {
    return this.db;
  }
}
