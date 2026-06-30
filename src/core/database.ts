import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createChildLogger } from '../logger.ts';
import { WhatSoupError } from '../errors.ts';
import { toConversationKey } from './conversation-key.ts';
import { MIGRATION_23 as SUBSTRATE_MIGRATION } from './substrate/schema.ts';

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
  started_at TEXT NOT NULL,
  completed_at TEXT,
  messages_processed INTEGER DEFAULT 0,
  facts_extracted INTEGER DEFAULT 0,
  facts_upserted INTEGER DEFAULT 0,
  error TEXT
);
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
]);

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

function runMigration33(db: DatabaseSync): void {
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

export const CURRENT_SCHEMA_MIGRATION = Math.max(...MIGRATIONS.keys());

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
    this.verifyRequiredTables();
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
   * Guard against phantom migrations — a migration recorded as applied but
   * whose DDL is missing (e.g. table was dropped externally). Re-runs the
   * idempotent DDL for critical tables that use CREATE TABLE IF NOT EXISTS.
   */
  private verifyRequiredTables(): void {
    const requiredIdempotentDDL: Array<{ table: string; ddl: string }> = [
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

    for (const { table, ddl } of requiredIdempotentDDL) {
      const exists = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(table) as { name: string } | undefined;
      if (!exists) {
        log.warn({ table }, 'Required table missing despite migration recorded — recreating');
        this.db.exec(ddl);
      }
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
    const result = this.db.prepare(
      `UPDATE messages SET deleted_at = datetime('now')
       WHERE conversation_key = ? AND deleted_at IS NULL`,
    ).run(conversationKey);
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
