import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import {
  SQLITE_BUSY_TIMEOUT_MS,
  SQLITE_BUSY_TIMEOUT_PRAGMA,
} from '../lib/sqlite-constants.ts';
import { dirname, resolve } from 'node:path';
import { CURRENT_SCHEMA_MIGRATION } from './database-schema-version.ts';
import {
  DatabaseCompatibilityError,
  assertDatabaseIdentity,
  assertSchemaCeiling,
  assertTrustedDatabaseParent,
  createEmptyDatabaseFile,
  databaseRecoveryCompatibilityError,
  databaseWriteCompatibilityError,
  inspectDatabaseIdentity,
  inspectDatabasePathBeforeCreate,
  installReadOnlyRejectionFence,
  normalizeDatabaseCompatibilityError,
  sameDatabaseIdentity,
  sqliteFileUri,
  type DatabaseIdentity,
} from './database-compatibility.ts';
import { createChildLogger } from '../logger.ts';
import { WhatSoupError } from '../errors.ts';
import { toConversationKey } from './conversation-key.ts';
import { MIGRATION_23 as SUBSTRATE_MIGRATION } from './substrate/schema.ts';
import {
  runMigration37 as runMigration37Impl,
  runMigration38 as runMigration38Impl,
  runMigration39 as runMigration39Impl,
  runMigration40 as runMigration40Impl,
} from './database-migrations-37-40.ts';
import { runMigration41 as runMigration41Impl } from './database-migration-41.ts';
import { runMigration42 as runMigration42Impl } from './database-migration-42.ts';
import { runMigration43 as runMigration43Impl } from './database-migration-43.ts';
import { runMigration45 as runMigration45Impl } from './database-migration-45.ts';
import { runMigration46 as runMigration46Impl } from './database-migration-46.ts';
import { runMigration47 as runMigration47Impl } from './database-migration-47.ts';
import { runMigration48 as runMigration48Impl } from './database-migration-48.ts';
import { runMigration49 as runMigration49Impl } from './database-migration-49.ts';
import { runMigration50 as runMigration50Impl } from './database-migration-50.ts';
import { runMigration51 as runMigration51Impl } from './database-migration-51.ts';
import { runMigration52 as runMigration52Impl } from './database-migration-52.ts';
import { runMigration53 as runMigration53Impl } from './database-migration-53.ts';
import { runMigration54 as runMigration54Impl } from './database-migration-54.ts';

export { CURRENT_SCHEMA_MIGRATION } from './database-schema-version.ts';
export {
  DatabaseCompatibilityError,
  isDrainableDatabaseCompatibilityError,
  type DatabaseCompatibilityReason,
} from './database-compatibility.ts';

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
CREATE INDEX idx_messages_timestamp_from_me ON messages(timestamp, is_from_me);
CREATE INDEX idx_messages_timestamp_content_type ON messages(timestamp, content_type);

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
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  source TEXT NOT NULL DEFAULT 'legacy' CHECK (source IN ('online', 'legacy')),
  status TEXT NOT NULL DEFAULT 'legacy_unclassified'
    CHECK (status IN ('no_work', 'completed', 'partial', 'failed', 'legacy_unclassified')),
  failure_code TEXT NOT NULL DEFAULT 'legacy_unclassified'
    CHECK (failure_code IN ('none', 'segment_failed', 'selection_failed', 'message_state_write_failed', 'ledger_write_failed', 'legacy_unclassified')),
  stage TEXT NOT NULL DEFAULT 'none'
    CHECK (stage IN ('none', 'selection', 'segment', 'message_state', 'ledger')),
  retryable INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
  evidence_coverage TEXT NOT NULL DEFAULT 'legacy_unclassified'
    CHECK (evidence_coverage IN ('typed', 'legacy_unclassified')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  success_at TEXT,
  messages_processed INTEGER DEFAULT 0,
  messages_selected INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(messages_selected) = 'integer' AND messages_selected >= 0),
  messages_succeeded INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(messages_succeeded) = 'integer' AND messages_succeeded >= 0),
  messages_deferred INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(messages_deferred) = 'integer' AND messages_deferred >= 0),
  messages_terminal INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(messages_terminal) = 'integer' AND messages_terminal >= 0),
  facts_extracted INTEGER DEFAULT 0,
  facts_upserted INTEGER DEFAULT 0,
  facts_queued INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(facts_queued) = 'integer' AND facts_queued >= 0),
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_enrichment_runs_source_run_id
  ON enrichment_runs(source, run_id DESC);
CREATE INDEX IF NOT EXISTS idx_enrichment_runs_online_success_run_id
  ON enrichment_runs(run_id DESC)
  WHERE source = 'online' AND success_at IS NOT NULL;
`;

// ─── Migration 2: Durability tables ─────────────────────────────────────────

const MIGRATION_2 = `
CREATE TABLE IF NOT EXISTS inbound_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  routed_to TEXT,
  processing_status TEXT NOT NULL DEFAULT 'pending',
  completed_at TEXT,
  terminal_reason TEXT,
  UNIQUE(message_id)
);

CREATE TABLE IF NOT EXISTS outbound_ops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_key TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  op_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  payload_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at TEXT,
  echoed_at TEXT,
  wa_message_id TEXT,
  error TEXT,
  source_inbound_seq INTEGER,
  retry_count INTEGER DEFAULT 0,
  is_terminal INTEGER DEFAULT 0,
  replay_policy TEXT NOT NULL DEFAULT 'unsafe'
);
CREATE INDEX IF NOT EXISTS idx_outbound_ops_status ON outbound_ops(status);
CREATE INDEX IF NOT EXISTS idx_outbound_ops_source ON outbound_ops(source_inbound_seq);

CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_key TEXT NOT NULL,
  session_checkpoint_id INTEGER,
  tool_name TEXT NOT NULL,
  tool_input TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  replay_policy TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  outbound_op_id INTEGER
);

CREATE TABLE IF NOT EXISTS session_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_key TEXT NOT NULL,
  session_id TEXT,
  transcript_path TEXT,
  active_turn_id TEXT,
  last_inbound_seq INTEGER,
  last_flushed_outbound_id INTEGER,
  watchdog_state TEXT,
  workspace_path TEXT,
  claude_pid INTEGER,
  checkpoint_version INTEGER NOT NULL DEFAULT 1,
  session_status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(conversation_key)
);

CREATE TABLE IF NOT EXISTS recovery_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  trigger TEXT NOT NULL,
  inbound_replayed INTEGER DEFAULT 0,
  outbound_reconciled INTEGER DEFAULT 0,
  outbound_replayed INTEGER DEFAULT 0,
  outbound_quarantined INTEGER DEFAULT 0,
  tool_calls_recovered INTEGER DEFAULT 0,
  tool_calls_replayed INTEGER DEFAULT 0,
  tool_calls_quarantined INTEGER DEFAULT 0,
  sessions_restored INTEGER DEFAULT 0,
  notes TEXT
);
`;

// ─── Migration 3: Chat sync tables (Wave 2) ────────────────────────────────

const MIGRATION_3 = `
CREATE TABLE IF NOT EXISTS chats (
  jid TEXT PRIMARY KEY,
  conversation_key TEXT NOT NULL,
  name TEXT,
  unread_count INTEGER DEFAULT 0,
  is_archived INTEGER DEFAULT 0,
  is_pinned INTEGER DEFAULT 0,
  mute_until TEXT,
  ephemeral_duration INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chats_conversation_key ON chats(conversation_key);

CREATE TABLE IF NOT EXISTS reactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  sender_jid TEXT NOT NULL,
  reaction TEXT NOT NULL,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(message_id, sender_jid)
);
CREATE INDEX IF NOT EXISTS idx_reactions_message_id ON reactions(message_id);

CREATE TABLE IF NOT EXISTS receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  recipient_jid TEXT NOT NULL,
  type TEXT NOT NULL,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(message_id, recipient_jid, type)
);
CREATE INDEX IF NOT EXISTS idx_receipts_message_id ON receipts(message_id);
`;

// ─── Migration 4: Labels tables (Wave 6) ────────────────────────────────────

const MIGRATION_4 = `
CREATE TABLE IF NOT EXISTS labels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color INTEGER,
  predefined_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS label_associations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label_id TEXT NOT NULL,
  type TEXT NOT NULL,
  chat_jid TEXT NOT NULL DEFAULT '',
  message_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(label_id, type, chat_jid, message_id)
);
`;

// ─── Migration 5: raw_message column for forward_message support ─────────────
// SQLite has no ALTER TABLE ... ADD COLUMN IF NOT EXISTS, so we guard
// programmatically to make this migration idempotent (safe to re-run).

// ─── Migration 6: blocklist and LID mapping persistence ──────────────────────

const MIGRATION_6 = `
CREATE TABLE IF NOT EXISTS blocklist (
  jid TEXT PRIMARY KEY,
  blocked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lid_mappings (
  lid TEXT PRIMARY KEY,
  phone_jid TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// ─── Migration 7: groups table for group metadata persistence ────────────────

const MIGRATION_7 = `
CREATE TABLE IF NOT EXISTS groups (
  jid TEXT PRIMARY KEY,
  subject TEXT,
  description TEXT,
  owner TEXT,
  creation_time INTEGER,
  participant_count INTEGER,
  restrict_mode INTEGER DEFAULT 0,
  announce_mode INTEGER DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// ─── Migration 9: decryption_failures table ──────────────────────────────────

const MIGRATION_9 = `
CREATE TABLE IF NOT EXISTS decryption_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  chat_jid TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  sender_jid TEXT NOT NULL,
  error_message TEXT,
  raw_key TEXT NOT NULL,
  seen_count INTEGER DEFAULT 1,
  resolved INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_df_unresolved ON decryption_failures (resolved, created_at);
CREATE INDEX IF NOT EXISTS idx_df_conversation ON decryption_failures (conversation_key, created_at);
`;

// ─── Migration 10: self-healing control plane tables ────────────────────────

const MIGRATION_10 = `
CREATE TABLE IF NOT EXISTS control_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT UNIQUE,
  direction TEXT NOT NULL,
  peer_jid TEXT NOT NULL,
  protocol TEXT NOT NULL,
  report_id TEXT,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS heal_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id TEXT NOT NULL UNIQUE,
  error_class TEXT NOT NULL,
  error_type TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'attempt_1',
  attempt_count INTEGER DEFAULT 0,
  cooldown_until TEXT,
  origin_chat_jid TEXT,
  context TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_hr_active_class ON heal_reports (error_class)
  WHERE state NOT IN ('resolved');

CREATE TABLE IF NOT EXISTS pending_heal_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id TEXT NOT NULL UNIQUE,
  error_class TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'attempt_1',
  context TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_phr_active_class ON pending_heal_reports (error_class)
  WHERE state != 'resolved';
`;

// ─── Migration 11: token usage tracking ──────────────────────────────────────

// Add token columns to messages (per-response) and agent_sessions (per-session).
// Using ALTER TABLE with idempotency guards (SQLite lacks ADD COLUMN IF NOT EXISTS).

// ─── Migration 18: agent_token_events + agent_sessions.ended_at ─────────────

const MIGRATION_18 = `
CREATE TABLE IF NOT EXISTS agent_token_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_session_id INTEGER NOT NULL REFERENCES agent_sessions(id),
  timestamp INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_agent_token_events_ts ON agent_token_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_agent_token_events_session_ts ON agent_token_events(agent_session_id, timestamp);
`;

// ─── Migration 20: fact_export_queue for WhatsApp → mw-mind export ──────────

const MIGRATION_20 = `
CREATE TABLE IF NOT EXISTS fact_export_queue (
  id INTEGER PRIMARY KEY,
  fact_id TEXT UNIQUE NOT NULL,
  chat_jid TEXT NOT NULL,
  sender_jid TEXT,
  namespace TEXT NOT NULL DEFAULT 'whatsapp-facts',
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  exported_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_fact_export_queue_pending ON fact_export_queue(status, id)
  WHERE status = 'pending';
`;

const MIGRATION_21 = `
CREATE TABLE IF NOT EXISTS chat_aliases (
  alias TEXT NOT NULL PRIMARY KEY,
  chat_jid TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const MIGRATION_22 = `
CREATE TABLE IF NOT EXISTS outbound_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line TEXT NOT NULL,
  caller TEXT NOT NULL CHECK (caller IN ('mcp', 'health', 'rgp')),
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

CREATE INDEX IF NOT EXISTS idx_outbound_sends_created_at
  ON outbound_sends(created_at);

CREATE INDEX IF NOT EXISTS idx_outbound_sends_status_created
  ON outbound_sends(status, created_at);

CREATE INDEX IF NOT EXISTS idx_outbound_sends_chat_created
  ON outbound_sends(chat_jid, created_at);

CREATE INDEX IF NOT EXISTS idx_outbound_sends_alias_created
  ON outbound_sends(alias, created_at)
  WHERE alias IS NOT NULL;
`;

// ─── Migration 25: LID mapping history (audit trail for #251) ────────────────
//
// Append-only history of every LID→phone change. Written by the unified
// writeLidMapping seam in lid-resolver.ts whenever a flip is detected (i.e.
// the new phone differs from the existing row). Retention is enforced by the
// seam, not a trigger: cap at 1000 rows per LID AND 90 days, whichever first.

const MIGRATION_25 = `
CREATE TABLE IF NOT EXISTS lid_mappings_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lid TEXT NOT NULL,
  prev_phone_jid TEXT,
  new_phone_jid TEXT NOT NULL,
  source TEXT NOT NULL,
  source_instance TEXT,
  changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  observed_updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_lid_mappings_history_lid
  ON lid_mappings_history(lid);

CREATE INDEX IF NOT EXISTS idx_lid_mappings_history_changed_at
  ON lid_mappings_history(changed_at);
`;

const MIGRATION_28_PENDING_POLLS = `
CREATE TABLE IF NOT EXISTS pending_polls (
  map_key         TEXT PRIMARY KEY,
  chat_jid        TEXT NOT NULL,
  tool_id         TEXT NOT NULL,
  source          TEXT NOT NULL,
  resolution      TEXT NOT NULL,
  payload         TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  closes_at       INTEGER,
  hard_closes_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_pending_polls_chat_jid
  ON pending_polls(chat_jid);

CREATE INDEX IF NOT EXISTS idx_pending_polls_closes_at
  ON pending_polls(closes_at);
`;

const MIGRATION_26_OUTBOUND_SENDS = `
CREATE TABLE outbound_sends_v26 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line TEXT NOT NULL,
  caller TEXT NOT NULL CHECK (caller IN ('mcp', 'health', 'rgp')),
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

INSERT INTO outbound_sends_v26 (
  id,
  line,
  caller,
  chat_jid,
  target_kind,
  alias,
  profile,
  text_hash,
  text_length,
  link_preview_mode,
  status,
  error,
  transport_message_id,
  created_at,
  completed_at
)
SELECT
  id,
  line,
  caller,
  chat_jid,
  target_kind,
  alias,
  profile,
  text_hash,
  text_length,
  link_preview_mode,
  status,
  error,
  transport_message_id,
  created_at,
  completed_at
FROM outbound_sends;

DROP TABLE outbound_sends;
ALTER TABLE outbound_sends_v26 RENAME TO outbound_sends;

CREATE INDEX IF NOT EXISTS idx_outbound_sends_created_at
  ON outbound_sends(created_at);

CREATE INDEX IF NOT EXISTS idx_outbound_sends_status_created
  ON outbound_sends(status, created_at);

CREATE INDEX IF NOT EXISTS idx_outbound_sends_chat_created
  ON outbound_sends(chat_jid, created_at);

CREATE INDEX IF NOT EXISTS idx_outbound_sends_alias_created
  ON outbound_sends(alias, created_at)
  WHERE alias IS NOT NULL;
`;

// ─── Known migrations ────────────────────────────────────────────────────────

type MigrationFn = (db: DatabaseSync) => void;

const MIGRATIONS: Map<number, MigrationFn> = new Map([
  [1, (db: DatabaseSync) => { db.exec(MIGRATION_1); }],
  [2, (db: DatabaseSync) => { db.exec(MIGRATION_2); }],
  [3, (db: DatabaseSync) => { db.exec(MIGRATION_3); }],
  [4, (db: DatabaseSync) => { db.exec(MIGRATION_4); }],
  [5, (db: DatabaseSync) => {
    // Check if raw_message column already exists (idempotency guard).
    // SQLite has no ALTER TABLE ... ADD COLUMN IF NOT EXISTS.
    const cols = db.prepare("PRAGMA table_info('messages')").all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'raw_message')) {
      db.exec('ALTER TABLE messages ADD COLUMN raw_message TEXT');
    }
  }],
  [6, (db: DatabaseSync) => { db.exec(MIGRATION_6); }],
  [7, (db: DatabaseSync) => { db.exec(MIGRATION_7); }],
  [8, (db: DatabaseSync) => {
    // Persist enrichment retry counters across restarts (was in-memory only).
    const cols = db.prepare("PRAGMA table_info('messages')").all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'enrichment_retries')) {
      db.exec('ALTER TABLE messages ADD COLUMN enrichment_retries INTEGER DEFAULT 0');
    }
  }],
  [9, (db: DatabaseSync) => { db.exec(MIGRATION_9); }],
  [10, (db: DatabaseSync) => { db.exec(MIGRATION_10); }],
  [11, (db: DatabaseSync) => {
    const msgCols = db.prepare("PRAGMA table_info('messages')").all() as Array<{ name: string }>;
    if (!msgCols.some(c => c.name === 'input_tokens')) {
      db.exec('ALTER TABLE messages ADD COLUMN input_tokens INTEGER DEFAULT 0');
    }
    if (!msgCols.some(c => c.name === 'output_tokens')) {
      db.exec('ALTER TABLE messages ADD COLUMN output_tokens INTEGER DEFAULT 0');
    }
    if (!msgCols.some(c => c.name === 'model_used')) {
      db.exec("ALTER TABLE messages ADD COLUMN model_used TEXT");
    }
    const sesCols = db.prepare("PRAGMA table_info('agent_sessions')").all() as Array<{ name: string }>;
    if (!sesCols.some(c => c.name === 'total_input_tokens')) {
      db.exec('ALTER TABLE agent_sessions ADD COLUMN total_input_tokens INTEGER DEFAULT 0');
    }
    if (!sesCols.some(c => c.name === 'total_output_tokens')) {
      db.exec('ALTER TABLE agent_sessions ADD COLUMN total_output_tokens INTEGER DEFAULT 0');
    }
  }],
  [12, (db: DatabaseSync) => {
    const cols = db.prepare("PRAGMA table_info('messages')").all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'media_path')) {
      db.exec('ALTER TABLE messages ADD COLUMN media_path TEXT');
      db.exec('CREATE INDEX idx_messages_media_path ON messages(media_path) WHERE media_path IS NOT NULL');
    }
  }],
  [13, (db: DatabaseSync) => {
    const cols = db.prepare("PRAGMA table_info('messages')").all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'content_text')) {
      db.exec('ALTER TABLE messages ADD COLUMN content_text TEXT');
    }

    // Rebuild all 4 FTS triggers to index content_text instead of content.
    // Must DROP all first, then re-CREATE — atomic within the migration transaction.
    db.exec(`
      DROP TRIGGER IF EXISTS messages_fts_insert;
      DROP TRIGGER IF EXISTS messages_fts_update;
      DROP TRIGGER IF EXISTS messages_fts_soft_delete;
      DROP TRIGGER IF EXISTS messages_fts_delete;

      CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages
        WHEN NEW.content_text IS NOT NULL AND NEW.deleted_at IS NULL
      BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (NEW.pk, NEW.content_text);
      END;

      CREATE TRIGGER messages_fts_update AFTER UPDATE OF content_text ON messages
      BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content)
          SELECT 'delete', OLD.pk, OLD.content_text
          WHERE OLD.content_text IS NOT NULL;
        INSERT INTO messages_fts(rowid, content)
          SELECT NEW.pk, NEW.content_text
          WHERE NEW.content_text IS NOT NULL AND NEW.deleted_at IS NULL;
      END;

      CREATE TRIGGER messages_fts_soft_delete AFTER UPDATE OF deleted_at ON messages
        WHEN NEW.deleted_at IS NOT NULL AND OLD.content_text IS NOT NULL
      BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content)
          VALUES ('delete', OLD.pk, OLD.content_text);
      END;

      CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages
        WHEN OLD.content_text IS NOT NULL
      BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content)
          VALUES ('delete', OLD.pk, OLD.content_text);
      END;
    `);
  }],
  [14, (db: DatabaseSync) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_jid TEXT NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'text',
        payload TEXT NOT NULL,
        scheduled_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        sent_at INTEGER,
        error TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_scheduled_pending ON scheduled_messages(status, scheduled_at)
        WHERE status IN ('pending', 'processing');
    `);
  }],
  [15, (db: DatabaseSync) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS metrics_hourly (
        bucket TEXT NOT NULL,
        metric TEXT NOT NULL,
        value REAL NOT NULL,
        PRIMARY KEY (bucket, metric)
      );
      CREATE INDEX IF NOT EXISTS idx_metrics_hourly_bucket ON metrics_hourly(bucket);
    `);
  }],
  [16, (db: DatabaseSync) => {
    db.exec(`ALTER TABLE scheduled_messages ADD COLUMN media_blob BLOB`);
  }],
  [17, (db: DatabaseSync) => {
    db.exec(`ALTER TABLE scheduled_messages ADD COLUMN chat_name TEXT`);
    db.exec(`ALTER TABLE scheduled_messages ADD COLUMN recurrence TEXT`);
    db.exec(`ALTER TABLE scheduled_messages ADD COLUMN next_run_at INTEGER`);
    db.exec(`ALTER TABLE scheduled_messages ADD COLUMN run_count INTEGER NOT NULL DEFAULT 0`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_scheduled_next_run ON scheduled_messages(status, next_run_at) WHERE status = 'pending' AND next_run_at IS NOT NULL`);
  }],
  [18, (db: DatabaseSync) => {
    db.exec(MIGRATION_18);

    // Add ended_at column (idempotency guard)
    const cols = db.prepare("PRAGMA table_info('agent_sessions')").all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'ended_at')) {
      db.exec('ALTER TABLE agent_sessions ADD COLUMN ended_at TEXT');
    }

    // Expression indexes for unixepoch() predicates in metrics queries
    db.exec('CREATE INDEX IF NOT EXISTS idx_agent_sessions_started_epoch ON agent_sessions(unixepoch(started_at))');
    db.exec('CREATE INDEX IF NOT EXISTS idx_agent_sessions_ended_epoch ON agent_sessions(unixepoch(ended_at))');

    // Backfill ended_at for existing terminal sessions
    db.prepare(`
      UPDATE agent_sessions SET ended_at = COALESCE(last_message_at, started_at)
      WHERE status IN ('ended', 'completed', 'crashed', 'resume_failed', 'orphaned')
        AND ended_at IS NULL
    `).run();
  }],
  [19, (db: DatabaseSync) => {
    const cols = db.prepare("PRAGMA table_info('agent_sessions')").all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'provider')) {
      db.exec('ALTER TABLE agent_sessions ADD COLUMN provider TEXT');
    }
  }],
  [20, runMigration20],
  [21, (db: DatabaseSync) => { db.exec(MIGRATION_21); }],
  [22, (db: DatabaseSync) => { db.exec(MIGRATION_22); }],
  [23, runMigration23],
  [24, runMigration24],
  [25, runMigration25],
  [26, runMigration26],
  [27, runMigration27],
  [28, runMigration28],
  [29, runMigration29],
  [30, runMigration30],
  [31, runMigration31],
  [32, runMigration32],
  [33, runMigration33],
  [34, runMigration34],
  [35, runMigration35],
  [36, runMigration36],
  [37, runMigration37],
  [38, runMigration38],
  [39, runMigration39],
  [40, runMigration40],
  [41, runMigration41],
  [42, runMigration42],
  [43, runMigration43],
  [44, runMigration44],
  [45, runMigration45],
  [46, runMigration46],
  [47, runMigration47],
  [48, runMigration48],
  [49, runMigration49],
  [50, runMigration50],
  [51, runMigration51],
  [52, runMigration52],
  [53, runMigration53],
  [54, runMigration54],
]);

if (Math.max(...MIGRATIONS.keys()) !== CURRENT_SCHEMA_MIGRATION) {
  throw new Error('database migration registry is out of sync with CURRENT_SCHEMA_MIGRATION');
}

function runMigration25(db: DatabaseSync): void {
  db.exec(MIGRATION_25);
}

function runMigration26(db: DatabaseSync): void {
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'outbound_sends'")
    .get() as { sql: string } | undefined;
  if (!table || table.sql.includes("'rgp'")) return;
  db.exec(MIGRATION_26_OUTBOUND_SENDS);
}

function runMigration28(db: DatabaseSync): void {
  db.exec(MIGRATION_28_PENDING_POLLS);
}

function runMigration29(db: DatabaseSync): void {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
    .get() as { name: string } | undefined;
  if (!table) return;

  db.exec(`
    UPDATE messages
    SET timestamp = CAST(timestamp / 1000 AS INTEGER)
    WHERE timestamp >= 100000000000
  `);
}

// #1067: per-row IANA timezone for recurring schedules. NULL = UTC (back-compat),
// so existing rows keep firing on their original UTC cron interpretation.
function runMigration30(db: DatabaseSync): void {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scheduled_messages'")
    .get() as { name: string } | undefined;
  if (!table) return;
  const cols = db
    .prepare("PRAGMA table_info('scheduled_messages')")
    .all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'timezone')) {
    db.exec('ALTER TABLE scheduled_messages ADD COLUMN timezone TEXT');
  }
}

// audit 1065: track LLM attempts separately from the user response rate-limit.
// rate_limits records only successful responses; llm_attempts records every LLM
// invocation (including ones whose send later fails), so outage retry cost is
// observable without charging the user's response allowance.
function runMigration31(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_attempts (
      sender_jid TEXT NOT NULL,
      attempt_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_llm_attempts_sender ON llm_attempts(sender_jid, attempt_at);
  `);
}

function runMigration32(db: DatabaseSync): void {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scheduled_messages'")
    .get() as { name: string } | undefined;
  if (!table) return;

  const cols = db
    .prepare("PRAGMA table_info('scheduled_messages')")
    .all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'send_started_at')) {
    db.exec('ALTER TABLE scheduled_messages ADD COLUMN send_started_at INTEGER');
  }

  db.exec(`
    UPDATE scheduled_messages
    SET send_started_at = unixepoch()
    WHERE status = 'processing' AND send_started_at IS NULL
  `);
}

const MIGRATION_33_AUTH_LOSS_SIGNAL = `
CREATE TABLE IF NOT EXISTS auth_loss_signal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance TEXT NOT NULL,
  host TEXT NOT NULL,
  classifier TEXT NOT NULL CHECK (classifier IN ('logged_out', 'weak_logged_out_signal')),
  reason TEXT NOT NULL CHECK (reason IN (
    'explicit_auth_loss',
    'weak_signal_persisted',
    'whatsapp_auth_loss_with_disconnect_corroboration'
  )),
  confidence TEXT NOT NULL CHECK (confidence IN ('confirmed', 'inferred', 'ambiguous')),
  observed_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_reason TEXT CHECK (resolved_reason IN ('stable_authenticated_open') OR resolved_reason IS NULL),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_auth_loss_signal_instance_created
  ON auth_loss_signal(instance, created_at);

CREATE INDEX IF NOT EXISTS idx_auth_loss_signal_instance_classifier
  ON auth_loss_signal(instance, classifier, created_at);
`;

function runMigration33(db: DatabaseSync): void {
  db.exec(MIGRATION_33_AUTH_LOSS_SIGNAL);
}

function runMigration34(db: DatabaseSync): void {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'inbound_events'")
    .get() as { name: string } | undefined;
  if (!table) return;

  const cols = db
    .prepare("PRAGMA table_info('inbound_events')")
    .all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));

  if (!names.has('continuity_candidate_reason')) {
    db.exec(`
      ALTER TABLE inbound_events
      ADD COLUMN continuity_candidate_reason TEXT
      CHECK (
        continuity_candidate_reason IS NULL OR
        continuity_candidate_reason IN ('crash_reclaim_no_terminal_outbound', 'runtime_fault_no_terminal_outbound')
      )
    `);
  }

  if (!names.has('continuity_candidate_source')) {
    db.exec(`
      ALTER TABLE inbound_events
      ADD COLUMN continuity_candidate_source TEXT
      CHECK (
        continuity_candidate_source IS NULL OR
        continuity_candidate_source IN ('pre_connect_recovery', 'runtime_fault_disarm')
      )
    `);
  }

  if (!names.has('continuity_candidate_marked_at')) {
    db.exec('ALTER TABLE inbound_events ADD COLUMN continuity_candidate_marked_at TEXT');
  }
}

// W1: bounded inbound failure taxonomy. Add a nullable, content-free
// failure_class column so the telemetry miner can split the collapsed
// terminal_reason='error' rows by driver. Deliberately NO CHECK constraint (the
// vocabulary is gated in src/core/inbound-failure-class.ts so it can evolve
// without a migration), NO default, NO backfill, NO index. Pre-taxonomy rows
// keep failure_class NULL; classified-but-unattributable rows get 'unknown'.
function runMigration36(db: DatabaseSync): void {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'inbound_events'")
    .get() as { name: string } | undefined;
  if (!table) return;

  const cols = db
    .prepare("PRAGMA table_info('inbound_events')")
    .all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'failure_class')) {
    db.exec('ALTER TABLE inbound_events ADD COLUMN failure_class TEXT');
  }
}

// ─── Migrations 37–40: turn lifecycle (implementations in ./database-migrations-37-40.ts) ──
// Thin real-function wrappers keep the ordered MIGRATIONS map and the static
// migration-numbering guard anchored to declarations in this file.

function runMigration37(db: DatabaseSync): void {
  runMigration37Impl(db);
}

function runMigration38(db: DatabaseSync): void {
  runMigration38Impl(db);
}

function runMigration39(db: DatabaseSync): void {
  runMigration39Impl(db);
}

function runMigration40(db: DatabaseSync): void {
  runMigration40Impl(db);
}

const MIGRATION_41_OBJECT_HASHES = [
  ['index', 'idx_inbound_disposition_closure_unique', ['03fbba479036a6f115e13bcad8d56d26405115051a8e608e566f8f247af6f8a8']],
  ['index', 'idx_inbound_disposition_open', ['bb3d5efcb27586492f5c9c2d46e6812aa6b19ecd8e80ea5017b7e89c8251dd30']],
  ['index', 'idx_inbound_disposition_pending_unique', ['34c7357d4eb63960a4fbbaf96261e10b1b3d1db432564234398dd428ef34ab2b']],
  ['table', 'inbound_disposition_links', ['d4166768063199235aac2789a43cb2cdba2d656b5527c8e491decc6b76369094']],
  ['table', 'recovery_plans', ['d3d60b9fa5f5e0b4c1a9764fb6e28f40a8d8ad872f5fe0e281987334288c3cba']],
  ['table', 'turn_delivery_corroboration', ['3dfa476668f875483cfc26fc24bd1376df297d9f39a567c7a4c3d94ab8f8ce08']],
  ['trigger', 'corroborated_selected_outbound_proof_immutable', ['60e84a8df1709cbdcc3ef824f38d634b1b95702221f5ea6867147ba3bf729373']],
  ['trigger', 'corroborated_selected_outbound_proof_retain', ['7db5598b2250e9e746949fffcaa064608ac5f2c0764dce760bd332b0115d7d75']],
  ['trigger', 'corroborated_terminal_proof_immutable', ['9faa85459495b6b550a0567e49a1f21db66570752a53636869e39dc3677b6865']],
  ['trigger', 'corroborated_terminal_proof_retain', ['844cfab758fcbb146c3e956f977a25b26c00d496d9c868e4d9041090ad653a14']],
  ['trigger', 'corroborating_outbound_proof_immutable', ['c45d5449721c0c33f84cb640859924366ec0b0a0b10b06bd9140f51bab14e62a']],
  ['trigger', 'corroborating_outbound_proof_retain', ['b132c15d8712299496c74bde2b17b84b4f3adfe0b59110ae81c081dbea034158']],
  ['trigger', 'disposition_inbound_proof_immutable', ['59b0bcb67b2995d247f2a8f57eabe50a7bd9059adaee790250e9afc0fcf8d543']],
  ['trigger', 'disposition_inbound_proof_retain', ['4a95a741a8d0e288b2853cac1dad891b97392cb0f6dc242a196ccc2596177d05']],
  ['trigger', 'inbound_disposition_closure_validate_insert', [
    '01857c86bf7cc9fc71d61aaa40e781dfee68988e2dea98f0c7bd1bd56e5ada99',
    'd68b783a0b75ae5d0306cfc0c24a022d8d08113662cc0d437de0fa1a52e605fe',
  ]],
  ['trigger', 'inbound_disposition_links_append_only_delete', ['40e838dd9efc6d95dad89dab256667d68e7b426b67a7b8abf9f5d3ab71230768']],
  ['trigger', 'inbound_disposition_links_append_only_update', ['debda1f051b336f7987e7f56d1bf79c074431c9d3d311284cf32296ab4350fca']],
  ['trigger', 'operator_catchup_selected_outbound_proof_immutable', [
    'd46fb908bf974e7ca4fca52a8bb14573027300cc256912e2fa62d19219945b3f',
    '846d787797c8ae5741433340aaf662e8bec19e5b95b75ea00f3dac4e16db5690',
  ]],
  ['trigger', 'operator_catchup_selected_outbound_proof_retain', [
    '667dd96693d25b48928649307eda0ba0e01ca633db33e67c3d58dc892c8f2b04',
    '38ba7bddc5c2a8151deb907d8f545d79fc73f03189b9066a445b8cf8a5fea81b',
  ]],
  ['trigger', 'operator_catchup_terminal_proof_immutable', [
    '646a68559790081f7c07ead40bdf0946ffaf033c2a4fa3206751aac003e9d176',
    '223c469f70414f1c131ca2361c6ee5e7d0be5c3b47e1598aec92b232cab1b88b',
  ]],
  ['trigger', 'operator_catchup_terminal_proof_retain', [
    '1249873bab3b905ed509a9d6a115340c4a8c725cf7dd17ae7416176465e9fa3e',
    '4c32a90667b09de0d304bf58ccf871bab37cbc0602ebefa084dd8a7e94172428',
  ]],
  ['trigger', 'recovery_plans_append_only_delete', ['4204eb2fc858c2fc8243867af639781da0572a8cfab2489132a3b369726f7a0f']],
  ['trigger', 'recovery_plans_append_only_update', ['a648f95d8c683d990db345a05ba4636fd8edebdc24903fe669630caa457b99c3']],
  ['trigger', 'turn_delivery_corroboration_append_only_delete', ['226f4ce4eac2b43da158146a29712c15663dd8d14ec9d55d498f76dd3dc1573f']],
  ['trigger', 'turn_delivery_corroboration_append_only_update', ['0ee6134e339c73a95fef089bd0c95d85200dad88a0d8798ab39ffcf02c43b19e']],
  ['trigger', 'turn_delivery_corroboration_validate_insert', ['fd4681e141af215772341620ce60003c4799b66654f21aec0582b20a464ca511']],
] as const;

function schemaObjectHash(sql: string): string {
  return createHash('sha256').update(sql.replace(/\s+/g, ' ').trim()).digest('hex');
}

function assertMigration41Attested(db: DatabaseSync): void {
  const requiredTables = [
    'inbound_events',
    'outbound_ops',
    'turn_terminal_records',
    'recovery_runs',
    'recovery_plans',
    'inbound_disposition_links',
    'turn_delivery_corroboration',
  ];
  const presentTables = new Set(
    (db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table'
        AND name IN (
          'inbound_events', 'outbound_ops', 'turn_terminal_records', 'recovery_runs',
          'recovery_plans', 'inbound_disposition_links', 'turn_delivery_corroboration'
        )
    `).all() as Array<{ name: string }>).map((row) => row.name),
  );
  const missingTables = requiredTables.filter((table) => !presentTables.has(table));
  if (missingTables.length > 0) {
    throw new Error(
      `migration 41 incomplete because required tables are missing: ${missingTables.join(', ')}`,
    );
  }

  const requiredParentColumns = new Map<string, readonly string[]>([
    ['inbound_events', [
      'seq', 'message_id', 'conversation_key', 'chat_jid',
      'processing_status', 'completed_at',
    ]],
    ['outbound_ops', [
      'id', 'conversation_key', 'chat_jid', 'op_type', 'payload', 'payload_hash',
      'status', 'created_at', 'submitted_at', 'echoed_at', 'wa_message_id',
      'error', 'source_inbound_seq', 'retry_count', 'is_terminal', 'replay_policy',
    ]],
    ['turn_terminal_records', [
      'id', 'scope', 'conversation_key', 'delivery_jid', 'inbound_seq',
      'inbound_seq_key', 'logical_turn_id', 'manager_id', 'generation',
      'attempt_kind', 'attempt_failure_class', 'inbound_disposition',
      'delivery_kind', 'delivery_op_id', 'recovery_owner_logical_turn_id',
      'recovery_owner_manager_id', 'recovery_owner_generation',
      'reply_guarantee_disarmed', 'created_at',
    ]],
  ]);
  const malformedParents: string[] = [];
  for (const [table, requiredColumns] of requiredParentColumns) {
    const columns = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{
      name: string;
      pk: number;
    }>;
    const byName = new Map(columns.map((column) => [column.name, column]));
    const missingColumns = requiredColumns.filter((column) => !byName.has(column));
    const identity = table === 'inbound_events' ? 'seq' : 'id';
    if (missingColumns.length > 0 || (byName.get(identity)?.pk ?? 0) === 0) {
      malformedParents.push(
        `${table}${missingColumns.length > 0 ? `(${missingColumns.join(',')})` : '(primary key)'}`,
      );
    }
  }
  if (malformedParents.length > 0) {
    throw new Error(
      `migration 41 required parent tables are malformed: ${malformedParents.join(', ')}`,
    );
  }

  const recoveryRunColumns = db.prepare("PRAGMA table_info('recovery_runs')")
    .all() as Array<{ name: string; type: string }>;
  const recoveryPlanColumn = recoveryRunColumns.find(
    (column) => column.name === 'recovery_plan_id',
  );
  const recoveryPlanForeignKey = (
    db.prepare("PRAGMA foreign_key_list('recovery_runs')").all() as Array<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>
  ).find((foreignKey) => foreignKey.from === 'recovery_plan_id');
  if (
    recoveryPlanColumn?.type.toUpperCase() !== 'TEXT'
    || recoveryPlanForeignKey?.table !== 'recovery_plans'
    || recoveryPlanForeignKey.to !== 'plan_id'
    || recoveryPlanForeignKey.on_delete.toUpperCase() !== 'RESTRICT'
  ) {
    throw new Error('migration 41 recovery_runs.recovery_plan_id is not canonically bound');
  }

  const selectObject = db.prepare('SELECT type, sql FROM sqlite_master WHERE name = ?');
  const invalidObjects = MIGRATION_41_OBJECT_HASHES.filter(([type, name, allowedHashes]) => {
    const row = selectObject.get(name) as { type: string; sql: string | null } | undefined;
    return row?.type !== type
      || row.sql === null
      || !(allowedHashes as readonly string[]).includes(schemaObjectHash(row.sql));
  }).map(([, name]) => name);
  if (invalidObjects.length > 0) {
    throw new Error(
      `migration 41 required objects are missing or drifted: ${invalidObjects.join(', ')}`,
    );
  }
}

function runMigration41(db: DatabaseSync): void {
  runMigration41Impl(db);
  assertMigration41Attested(db);
}

function runMigration42(db: DatabaseSync): void {
  runMigration42Impl(db);
}

function runMigration43(db: DatabaseSync): void {
  runMigration43Impl(db);
}

function runMigration45(db: DatabaseSync): void {
  runMigration45Impl(db);
}

function runMigration46(db: DatabaseSync): void {
  runMigration46Impl(db);
}

function runMigration47(db: DatabaseSync): void {
  runMigration47Impl(db);
}

function runMigration48(db: DatabaseSync): void {
  runMigration48Impl(db);
}

function runMigration49(db: DatabaseSync): void {
  runMigration49Impl(db);
}

function runMigration50(db: DatabaseSync): void {
  runMigration50Impl(db);
}

function runMigration51(db: DatabaseSync): void {
  runMigration51Impl(db);
}

function runMigration52(db: DatabaseSync): void {
  runMigration52Impl(db);
}

function runMigration53(db: DatabaseSync): void {
  runMigration53Impl(db);
}

function runMigration54(db: DatabaseSync): void {
  runMigration54Impl(db);
}

// #1774: total_input_tokens historically accumulated a turn's FULL
// provider-reported input (base + cache_creation + cache_read_input_tokens).
// cache_read is essentially the entire prior context re-read every turn, so
// summing it every turn made the column grow ~O(turns²) and inflated it far
// beyond genuine consumption (a single agent_token_events row was observed
// at 140M+ tokens on live fleet data). From this migration forward,
// total_input_tokens accumulates ONLY the genuinely-new portion (base +
// cache_creation); total_cache_read_tokens accumulates the cache-read
// portion separately and is EXPECTED to grow with turn count — unlike the
// old conflated column, that growth is now honestly labeled as cumulative
// re-read volume, not "input consumed". last_compact_cache_read_tokens is
// the compaction-baseline twin of last_compact_input_tokens (see
// session-db.ts's markSessionCompacted and runtime.ts's
// maybeStartAutoCompact, which deliberately reads total_input_tokens +
// total_cache_read_tokens combined so its trigger threshold is unaffected by
// this split). Deliberately NO backfill: historical rows keep their old
// (inflated) total_input_tokens with total_cache_read_tokens = 0 for that
// history — see the fuller schema note above ensureAgentSchema in
// session-db.ts.
function runMigration44(db: DatabaseSync): void {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_sessions'")
    .get() as { name: string } | undefined;
  if (!table) return;

  const cols = db.prepare("PRAGMA table_info('agent_sessions')").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'total_cache_read_tokens')) {
    db.exec('ALTER TABLE agent_sessions ADD COLUMN total_cache_read_tokens INTEGER DEFAULT 0');
  }
  if (!cols.some((c) => c.name === 'last_compact_cache_read_tokens')) {
    db.exec('ALTER TABLE agent_sessions ADD COLUMN last_compact_cache_read_tokens INTEGER DEFAULT 0');
  }
}


/**
 * QR-115: guard the FTS `'delete'` command against a since-soft-deleted row on
 * BOTH triggers that emit it. The `messages_fts_soft_delete` trigger already
 * removes a row from FTS when `deleted_at` is set; if `messages_fts_delete`
 * (AFTER DELETE) or `messages_fts_update` (AFTER UPDATE OF content_text) then
 * fires a second `'delete'` for the same rowid, SQLite throws
 * "database disk image is malformed" at the DML statement — retention pruning
 * (deleteOldMessages) crashes on any hard-delete of a soft-deleted row, and
 * transcription updates (updateTranscription) crash on any since-revoked audio.
 * Fix: add `AND OLD.deleted_at IS NULL` to `messages_fts_delete`'s WHEN clause
 * and to `messages_fts_update`'s delete-half WHERE clause. The insert-halves
 * already correctly gate on `NEW.deleted_at IS NULL`, so live↔soft-deleted
 * transitions remain consistent.
 */
function runMigration35(db: DatabaseSync): void {
  // Skip if the messages table or the messages_fts virtual table is not
  // present (fresh install running in an order where the initial schema hasn't
  // been executed yet, or a partial install). Both FTS triggers rewritten
  // below reference messages_fts, so recreating them without that table would
  // install triggers that fail on the next content_text UPDATE / row DELETE.
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
    .get() as { name: string } | undefined;
  if (!table) return;
  const fts = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'")
    .get() as { name: string } | undefined;
  if (!fts) return;

  db.exec(`
    DROP TRIGGER IF EXISTS messages_fts_update;
    DROP TRIGGER IF EXISTS messages_fts_delete;

    CREATE TRIGGER messages_fts_update AFTER UPDATE OF content_text ON messages
    BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content)
        SELECT 'delete', OLD.pk, OLD.content_text
        WHERE OLD.content_text IS NOT NULL AND OLD.deleted_at IS NULL;
      INSERT INTO messages_fts(rowid, content)
        SELECT NEW.pk, NEW.content_text
        WHERE NEW.content_text IS NOT NULL AND NEW.deleted_at IS NULL;
    END;

    CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages
      WHEN OLD.content_text IS NOT NULL AND OLD.deleted_at IS NULL
    BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content)
        VALUES ('delete', OLD.pk, OLD.content_text);
    END;
  `);
}

function runMigration27(db: DatabaseSync): void {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
    .get() as { name: string } | undefined;
  if (!table) return;

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp_from_me ON messages(timestamp, is_from_me);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp_content_type ON messages(timestamp, content_type);
  `);
  const cols = db.prepare("PRAGMA table_info('messages')").all() as Array<{ name: string }>;
  const names = new Set(cols.map(c => c.name));
  if (names.has('input_tokens')) {
    db.exec('CREATE INDEX IF NOT EXISTS idx_messages_timestamp_input_tokens ON messages(timestamp, input_tokens)');
  }
  if (names.has('output_tokens')) {
    db.exec('CREATE INDEX IF NOT EXISTS idx_messages_timestamp_output_tokens ON messages(timestamp, output_tokens)');
  }
}

function runMigration20(db: DatabaseSync): void {
  db.exec(MIGRATION_20);
}

function runMigration23(db: DatabaseSync): void {
  db.exec(SUBSTRATE_MIGRATION);
}

function runMigration24(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info('messages')").all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === 'updated_at')) {
    db.exec('ALTER TABLE messages ADD COLUMN updated_at TEXT');
    db.exec(`
      UPDATE messages
      SET updated_at = COALESCE(created_at, datetime(timestamp, 'unixepoch'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      WHERE updated_at IS NULL
    `);
  }

  db.exec(`
    DROP TRIGGER IF EXISTS messages_touch_updated_at_insert;
    DROP TRIGGER IF EXISTS messages_touch_updated_at_update;

    CREATE TRIGGER messages_touch_updated_at_insert AFTER INSERT ON messages
      WHEN NEW.updated_at IS NULL
    BEGIN
      UPDATE messages SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE pk = NEW.pk;
    END;

    CREATE TRIGGER messages_touch_updated_at_update
      AFTER UPDATE OF content, content_text, content_type, sender_name, sender_jid,
                      raw_message, quoted_message_id, timestamp, deleted_at, media_path
      ON messages
      WHEN NEW.updated_at IS OLD.updated_at
    BEGIN
      UPDATE messages SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE pk = NEW.pk;
    END;
  `);
}

// ─── Database class ──────────────────────────────────────────────────────────

/**
 * Snapshot the schema a fully-migrated database is expected to have, by
 * replaying every migration against a throwaway in-memory database. This is the
 * registry-driven source of truth for {@link Database.verifyRequiredTables} — it
 * means any table a future migration adds is protected automatically, without a
 * hand-maintained allowlist (#1778).
 *
 * Returns a map of user-table name → the `CREATE TABLE` SQL that builds it plus
 * the `CREATE INDEX` SQL for every index that belongs to it. SQLite-internal
 * objects and FTS shadow tables (whose `sql` is NULL) are excluded; the base
 * virtual table keeps its recreatable DDL.
 */
export function migratedSchemaSnapshot(): Map<string, { createSql: string; indexes: string[] }> {
  const ref = new DatabaseSync(':memory:');
  try {
    ref.exec('PRAGMA foreign_keys = ON');
    ref.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    for (const [, migrateFn] of MIGRATIONS) {
      migrateFn(ref);
    }

    const snapshot = new Map<string, { createSql: string; indexes: string[] }>();
    for (const { name, sql } of ref
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'",
      )
      .all() as Array<{ name: string; sql: string }>) {
      snapshot.set(name, { createSql: sql, indexes: [] });
    }
    for (const { tbl_name, sql } of ref
      .prepare(
        "SELECT tbl_name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'",
      )
      .all() as Array<{ tbl_name: string; sql: string }>) {
      snapshot.get(tbl_name)?.indexes.push(sql);
    }
    return snapshot;
  } finally {
    ref.close();
  }
}

/**
 * Last-resort table DDL, used only if {@link migratedSchemaSnapshot} itself
 * throws — guarantees the historically-critical `chat_aliases` table is still
 * healed, so generalising the integrity guard is strictly additive and never
 * worse than the pre-#1778 one-table allowlist.
 */
const CRITICAL_FALLBACK_TABLES: Array<{ table: string; ddl: string }> = [
  {
    table: 'chat_aliases',
    ddl: `CREATE TABLE IF NOT EXISTS chat_aliases (
  alias TEXT NOT NULL PRIMARY KEY,
  chat_jid TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`,
  },
];

export class Database {
  private db!: DatabaseSync;
  private readonly dbPath: string;
  private expectedIdentity: DatabaseIdentity | null = null;
  private schemaCeilingRejected = false;
  private schemaCeilingRejection: DatabaseCompatibilityError | null = null;
  private connectionClosed = false;
  private writableReady = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    let existedBeforeConstruction = false;
    if (dbPath !== ':memory:') {
      const absolutePath = resolve(dbPath);
      this.expectedIdentity = inspectDatabasePathBeforeCreate(absolutePath);
      existedBeforeConstruction = this.expectedIdentity !== null;
      if (!this.expectedIdentity) {
        try {
          mkdirSync(dirname(absolutePath), { recursive: true, mode: 0o700 });
        } catch (err) {
          const rejection = databaseWriteCompatibilityError(this.dbPath, err);
          if (rejection) throw rejection;
          throw new WhatSoupError(
            `Cannot create DB directory: ${dirname(absolutePath)}`,
            'DATABASE_ERROR',
            err,
          );
        }
        const appearedBeforeCreate = inspectDatabasePathBeforeCreate(absolutePath);
        if (appearedBeforeCreate) {
          throw new DatabaseCompatibilityError(
            'database_identity_changed',
            `Database appeared before exclusive create at ${absolutePath}`,
          );
        }
        assertTrustedDatabaseParent(absolutePath);
        this.expectedIdentity = createEmptyDatabaseFile(absolutePath);
      }
    }

    if (existedBeforeConstruction && this.expectedIdentity) {
      let inspectionDb: DatabaseSync;
      try {
        inspectionDb = new DatabaseSync(
          sqliteFileUri(this.expectedIdentity.canonicalPath, 'ro'),
          {
            readOnly: true,
            timeout: SQLITE_BUSY_TIMEOUT_MS,
            enableForeignKeyConstraints: false,
          },
        );
      } catch (err) {
        const rejection = databaseRecoveryCompatibilityError(this.dbPath, err);
        if (rejection) throw rejection;
        throw new WhatSoupError(
          `Cannot open database at ${dbPath} for read-only schema preflight`,
          'DATABASE_ERROR',
          err,
        );
      }

      this.db = inspectionDb;
      try {
        assertSchemaCeiling(this.db, this.dbPath);
      } catch (err) {
        const rejection = normalizeDatabaseCompatibilityError(this.dbPath, err);
        if (rejection) {
          this.installReadOnlyRejectionFence(rejection);
          return;
        }
        try {
          inspectionDb.close();
          this.connectionClosed = true;
        } catch (closeError) {
          throw new WhatSoupError(
            `Failed to close database schema preflight at ${dbPath}`,
            'DATABASE_ERROR',
            new AggregateError([err, closeError]),
          );
        }
        throw err;
      }

      try {
        inspectionDb.close();
        this.connectionClosed = true;
      } catch (err) {
        throw new WhatSoupError(
          `Failed to close database schema preflight at ${dbPath}`,
          'DATABASE_ERROR',
          err,
        );
      }

      const identityAfterInspection = inspectDatabaseIdentity(dbPath);
      if (!sameDatabaseIdentity(this.expectedIdentity, identityAfterInspection)) {
        throw new DatabaseCompatibilityError(
          'database_identity_changed',
          `Database identity changed after read-only schema inspection at ${dbPath}`,
        );
      }
    }

    try {
      const writerPath = this.expectedIdentity
        ? sqliteFileUri(this.expectedIdentity.canonicalPath, 'rw')
        : dbPath;
      this.db = new DatabaseSync(writerPath, {
        timeout: SQLITE_BUSY_TIMEOUT_MS,
      });
      this.connectionClosed = false;
    } catch (err) {
      const rejection = databaseWriteCompatibilityError(this.dbPath, err);
      if (rejection) throw rejection;
      const qualifier = this.expectedIdentity ? 'existing database' : 'database';
      throw new WhatSoupError(`Cannot open ${qualifier} at ${dbPath}`, 'DATABASE_ERROR', err);
    }

    if (this.expectedIdentity) {
      try {
        this.assertDatabaseIdentity();
      } catch (err) {
        try {
          this.db.close();
          this.connectionClosed = true;
        } catch {
          // Best effort: constructor is already failing closed.
        }
        throw err;
      }
    }
  }

  /**
   * Apply pragmas and run pending migrations. Call once after construction.
   * No admin phone seeding — that belongs in main.ts.
   */
  open(): void {
    if (this.schemaCeilingRejection) throw this.schemaCeilingRejection;
    if (this.connectionClosed) {
      throw new WhatSoupError('Cannot open a closed database connection', 'DATABASE_ERROR');
    }

    try {
      this.db.exec(SQLITE_BUSY_TIMEOUT_PRAGMA);
      this.db.exec('PRAGMA foreign_keys = ON');
    } catch (err) {
      const rejection = databaseWriteCompatibilityError(this.dbPath, err);
      if (rejection) {
        this.installReadOnlyRejectionFence(rejection);
        throw rejection;
      }
      throw new WhatSoupError(
        'Failed to inspect schema migration ceiling because database connection setup failed',
        'DATABASE_ERROR',
        err,
      );
    }

    let transactionOpen = false;
    try {
      this.assertDatabaseIdentity();
      this.db.exec('BEGIN IMMEDIATE');
      transactionOpen = true;
      this.assertDatabaseIdentity();
      assertSchemaCeiling(this.db, this.dbPath);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      this.runPendingMigrations();
      this.verifyRequiredTables();
      this.assertDatabaseIdentity();
      this.db.exec('COMMIT');
      transactionOpen = false;
    } catch (err) {
      if (transactionOpen) {
        try {
          this.db.exec('ROLLBACK');
        } catch (rollbackErr) {
          throw new WhatSoupError(
            'Database initialization failed and the schema transaction could not roll back',
            'DATABASE_ERROR',
            new AggregateError([err, rollbackErr]),
          );
        }
      }
      const rejection = err instanceof DatabaseCompatibilityError
        ? err
        : databaseWriteCompatibilityError(this.dbPath, err);
      if (rejection) {
        this.installReadOnlyRejectionFence(rejection);
        throw rejection;
      }
      throw err instanceof WhatSoupError
        ? err
        : new WhatSoupError('Failed to initialize database schema transaction', 'DATABASE_ERROR', err);
    }

    try {
      // SQLite forbids changing journal mode while a transaction is active.
      // Schema writes commit under the database's existing mode; WAL conversion
      // is therefore deliberately last.
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');
    } catch (err) {
      const rejection = databaseWriteCompatibilityError(this.dbPath, err);
      if (rejection) {
        this.installReadOnlyRejectionFence(rejection);
        throw rejection;
      }
      throw new WhatSoupError(
        'Database schema committed but post-commit WAL configuration failed',
        'DATABASE_ERROR',
        err,
      );
    }

    const journalMode = (
      this.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string } | undefined
    )?.journal_mode;
    if (journalMode !== 'wal') {
      log.warn({ journalMode }, 'Expected WAL journal mode but got something else');
    }

    this.writableReady = true;
    log.info('Database opened and schema initialised');
  }

  private installReadOnlyRejectionFence(rejection: DatabaseCompatibilityError): void {
    this.schemaCeilingRejected = true;
    this.schemaCeilingRejection = rejection;
    this.writableReady = false;
    installReadOnlyRejectionFence(this.db, rejection, () => {
      this.connectionClosed = true;
    });
  }

  private assertDatabaseIdentity(): void {
    assertDatabaseIdentity(this.db, this.dbPath, this.expectedIdentity);
  }

  assertWritableCompatibility(): void {
    if (this.schemaCeilingRejection) throw this.schemaCeilingRejection;
    if (!this.writableReady || this.connectionClosed) {
      throw new DatabaseCompatibilityError(
        'database_not_writable',
        'Database is not in a writable, schema-compatible runtime state',
      );
    }
    try {
      this.assertDatabaseIdentity();
      // Re-read the canonical migration ledger at every provider/runtime
      // admission boundary. Path and inode checks alone cannot detect a newer
      // cooperative writer advancing the schema on the same database file.
      assertSchemaCeiling(this.db, this.dbPath);
    } catch (err) {
      const rejection = normalizeDatabaseCompatibilityError(this.dbPath, err);
      if (rejection) {
        this.installReadOnlyRejectionFence(rejection);
        throw rejection;
      }
      throw err;
    }
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
        migrateFn(this.db);
        insertVersion.run(version);
        log.info({ version }, 'Migration applied');
      } catch (err) {
        throw new WhatSoupError(`Migration ${version} failed`, 'DATABASE_ERROR', err);
      }
    }
  }


  /**
   * Guard against phantom migrations — a migration recorded as applied but whose
   * table is missing (dropped externally, transaction-boundary/partial-failure
   * drift, file replacement). Rather than a hand-maintained one-table allowlist,
   * the expected table set is derived from the migration registry (see
   * {@link migratedSchemaSnapshot}), so EVERY migrated table is protected — the
   * next missing table is found by this guard, not by a health-probe error storm
   * (#1778). Any table present in the canonical snapshot but missing from the
   * live database is recreated idempotently along with its indexes. Recreation is
   * best-effort per object so one failure cannot abort healing the rest or block
   * startup.
   */
  private verifyRequiredTables(): void {
    const live = new Set(
      (
        this.db
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all() as Array<{ name: string }>
      ).map((r) => r.name),
    );

    let snapshot: Map<string, { createSql: string; indexes: string[] }> | undefined;
    try {
      snapshot = migratedSchemaSnapshot();
    } catch (err) {
      // Deriving the canonical schema must never block startup. Fall back to the
      // hardcoded critical-table DDL so we are never worse than the pre-#1778
      // one-table guard.
      log.error(
        { err },
        'Failed to derive canonical schema for integrity check — falling back to critical-table DDL',
      );
    }

    if (snapshot) {
      for (const [table, { createSql, indexes }] of snapshot) {
        if (live.has(table)) continue;
        log.warn({ table }, 'Required table missing despite migration recorded — recreating');
        this.recreateSchemaObject(table, createSql);
        for (const indexSql of indexes) {
          this.recreateSchemaObject(`${table} (index)`, indexSql);
        }
      }
      return;
    }

    for (const { table, ddl } of CRITICAL_FALLBACK_TABLES) {
      if (live.has(table)) continue;
      log.warn({ table }, 'Required table missing despite migration recorded — recreating');
      this.recreateSchemaObject(table, ddl);
    }
  }

  /** Recreate one schema object (table or index) best-effort; never throws. */
  private recreateSchemaObject(label: string, ddl: string): void {
    try {
      this.db.exec(ddl);
    } catch (err) {
      log.error(
        { err, object: label },
        'Failed to recreate missing schema object during integrity check',
      );
    }
  }

  private legacyTableInfo(
    schema: string,
    table: string,
    requiredColumns?: string[],
  ): { exists: boolean; hasColumns: boolean; columns: string[] } {
    const tableRow = this.db
      .prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type='table' AND name=?`)
      .get(table) as { name: string } | undefined;
    if (!tableRow) return { exists: false, hasColumns: false, columns: [] };

    const verifiedName = tableRow.name; // from sqlite_master, not raw input
    const cols = this.db
      .prepare(`PRAGMA ${schema}.table_info('${verifiedName}')`)
      .all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);

    const hasColumns = requiredColumns
      ? requiredColumns.every((col) => colNames.includes(col))
      : true;

    return { exists: true, hasColumns, columns: colNames };
  }

  /**
   * Import data from a legacy database (pre-WhatSoup format).
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
      {
        const info = this.legacyTableInfo('old', 'access_list', ['subject_type', 'subject_id']);
        if (!info.exists) {
          log.info('legacy DB has no access_list table, skipping');
          counts['access_list'] = 0;
        } else if (info.hasColumns) {
          this.db.exec(`
            INSERT OR IGNORE INTO main.access_list
              (subject_type, subject_id, status, display_name, requested_at, decided_at)
            SELECT subject_type, subject_id, status, display_name, requested_at, decided_at
            FROM old.access_list
          `);
          const row = this.db.prepare('SELECT changes() AS n').get() as { n: number };
          counts['access_list'] = row.n;
        } else if (info.columns.includes('phone')) {
          log.info('legacy access_list uses phone-only schema, mapping to subject_type/subject_id');
          this.db.exec(`
            INSERT OR IGNORE INTO main.access_list
              (subject_type, subject_id, status, display_name, requested_at, decided_at)
            SELECT 'phone', phone, status, display_name, requested_at, decided_at
            FROM old.access_list
          `);
          const row = this.db.prepare('SELECT changes() AS n').get() as { n: number };
          counts['access_list'] = row.n;
        } else {
          log.info({ columns: info.columns }, 'legacy access_list has unrecognized schema, skipping');
          counts['access_list'] = 0;
        }
      }

      // ── agent_sessions ───────────────────────────────────────────────────
      {
        const info = this.legacyTableInfo('old', 'agent_sessions');
        if (!info.exists) {
          log.info('legacy DB has no agent_sessions table, skipping');
          counts['agent_sessions'] = 0;
        } else {
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
          } catch (err) {
            log.info({ err, table: 'agent_sessions' }, 'legacy agent_sessions schema mismatch, skipping');
            counts['agent_sessions'] = 0;
          }
        }
      }

      // ── rate_limits ──────────────────────────────────────────────────────
      {
        const info = this.legacyTableInfo('old', 'rate_limits');
        if (!info.exists) {
          log.info('legacy DB has no rate_limits table, skipping');
          counts['rate_limits'] = 0;
        } else {
          try {
            this.db.exec(`
              INSERT INTO main.rate_limits (sender_jid, response_at)
              SELECT sender_jid, response_at FROM old.rate_limits
              GROUP BY sender_jid, response_at
            `);
            const row = this.db.prepare('SELECT changes() AS n').get() as { n: number };
            counts['rate_limits'] = row.n;
          } catch (err) {
            log.info({ err, table: 'rate_limits' }, 'legacy rate_limits schema mismatch, skipping');
            counts['rate_limits'] = 0;
          }
        }
      }

      // ── enrichment_runs ──────────────────────────────────────────────────
      {
        const info = this.legacyTableInfo('old', 'enrichment_runs');
        if (!info.exists) {
          log.info('legacy DB has no enrichment_runs table, skipping');
          counts['enrichment_runs'] = 0;
        } else {
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
          } catch (err) {
            log.info({ err, table: 'enrichment_runs' }, 'legacy enrichment_runs schema mismatch, skipping');
            counts['enrichment_runs'] = 0;
          }
        }
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
           enrichment_processed_at, enrichment_error, created_at, content_text)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          row.content, // content_text falls back to content for legacy text messages
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
    if (this.connectionClosed) {
      log.info('Database closed');
      return;
    }
    if (this.writableReady && !this.schemaCeilingRejected) {
      try {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch (err) {
        log.warn({ err }, 'WAL checkpoint failed during close');
      }
    }
    if (!this.connectionClosed) {
      try {
        this.db.close();
        this.connectionClosed = true;
      } catch (err) {
        log.warn({ err }, 'Error closing database');
        return;
      }
    }
    log.info('Database closed');
  }

  /**
   * Soft-delete all messages in a conversation (clear-chat event).
   * Sets deleted_at on every non-deleted message matching the conversation_key.
   * The messages_fts_soft_delete trigger removes them from FTS automatically.
   */
  clearChat(conversationKey: string): number {
    const result = this.db.prepare(
      `UPDATE messages SET deleted_at = datetime('now')
       WHERE conversation_key = ? AND deleted_at IS NULL`,
    ).run(conversationKey);
    return Number(result.changes);
  }

  /**
   * Soft-delete specific messages by WhatsApp message id (revoke /
   * "delete for everyone"). Sets deleted_at on each currently-live match; the
   * messages_fts_soft_delete trigger drops them from FTS automatically, so the
   * revoked content can no longer be recalled. Returns the number of rows newly
   * soft-deleted (already-deleted ids are not re-counted). An empty id list is a
   * no-op.
   */
  markMessagesDeleted(messageIds: string[]): number {
    if (messageIds.length === 0) return 0;
    const placeholders = messageIds.map(() => '?').join(',');
    const result = this.db.prepare(
      `UPDATE messages SET deleted_at = datetime('now')
       WHERE message_id IN (${placeholders}) AND deleted_at IS NULL`,
    ).run(...messageIds);
    return Number(result.changes);
  }

  /**
   * Apply a WhatsApp message EDIT by WhatsApp message id. Overwrites both
   * `content` and `content_text` with the new (plain-text) body and stamps
   * `edited_at`; updating content_text fires the messages_fts_update trigger so
   * the FTS index reflects the corrected text (old text is no longer recallable).
   * Only currently-live rows are edited (`deleted_at IS NULL`) so a revoked
   * message cannot be resurrected via a late edit. Returns the number of rows
   * updated (0 for an unknown or already-deleted id — a safe no-op). This is the
   * edit-half counterpart to markMessagesDeleted (the revoke half).
   */
  markMessageEdited(messageId: string, newContent: string): number {
    const result = this.db.prepare(
      `UPDATE messages SET content = ?, content_text = ?, edited_at = datetime('now')
       WHERE message_id = ? AND deleted_at IS NULL`,
    ).run(newContent, newContent, messageId);
    return Number(result.changes);
  }

  /** Expose the underlying DatabaseSync for query modules. */
  get raw(): DatabaseSync {
    return this.db;
  }
}

// ─── Decryption failure helpers ──────────────────────────────────────────────

export interface DecryptionFailureInput {
  messageId: string;
  chatJid: string;
  senderJid: string;
  errorMessage: string;
  rawKey: { remoteJid: string; id: string; fromMe: boolean };
  timestamp: number;
}

export function storeDecryptionFailure(db: Database, input: DecryptionFailureInput): void {
  const conversationKey = toConversationKey(input.chatJid);
  db.raw.prepare(`
    INSERT INTO decryption_failures (message_id, chat_jid, conversation_key, sender_jid, error_message, raw_key)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET
      seen_count = seen_count + 1,
      last_seen_at = datetime('now'),
      error_message = excluded.error_message
  `).run(
    input.messageId, input.chatJid, conversationKey, input.senderJid,
    input.errorMessage, JSON.stringify(input.rawKey),
  );
}

export function resolveDecryptionFailure(db: Database, messageId: string): void {
  db.raw.prepare(`
    UPDATE decryption_failures SET resolved = 1, resolved_at = datetime('now')
    WHERE message_id = ? AND resolved = 0
  `).run(messageId);
}
