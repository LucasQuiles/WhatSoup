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
  [34, runMigration34],
  [35, runMigration35],
  [36, runMigration36],
  [37, runMigration37],
  [38, runMigration38],
  [39, runMigration39],
  [40, runMigration40],
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

const TURN_TERMINAL_TABLE_DDL = `
    CREATE TABLE IF NOT EXISTS turn_terminal_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      conversation_key TEXT NOT NULL,
      delivery_jid TEXT NOT NULL,
      inbound_seq INTEGER CHECK (inbound_seq IS NULL OR inbound_seq > 0),
      inbound_seq_key INTEGER NOT NULL
        CHECK (inbound_seq_key = COALESCE(inbound_seq, -1)),
      logical_turn_id TEXT NOT NULL,
      manager_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      attempt_kind TEXT NOT NULL,
      attempt_failure_class TEXT,
      inbound_disposition TEXT NOT NULL,
      delivery_kind TEXT NOT NULL,
      delivery_op_id INTEGER,
      recovery_owner_logical_turn_id TEXT,
      recovery_owner_manager_id TEXT,
      recovery_owner_generation INTEGER,
      reply_guarantee_disarmed INTEGER NOT NULL
        CHECK (reply_guarantee_disarmed IN (0, 1)),
      duplicate_finalize_count INTEGER NOT NULL DEFAULT 0
        CHECK (duplicate_finalize_count >= 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_duplicate_at TEXT,
      CONSTRAINT turn_terminal_owner_coherence CHECK (
        (
          inbound_disposition = 'transferred_to_recovery_owner'
          AND recovery_owner_logical_turn_id IS NOT NULL
          AND length(trim(replace(replace(replace(
            recovery_owner_logical_turn_id, char(9), ' '
          ), char(10), ' '), char(13), ' '))) > 0
          AND recovery_owner_manager_id IS NOT NULL
          AND length(trim(replace(replace(replace(
            recovery_owner_manager_id, char(9), ' '
          ), char(10), ' '), char(13), ' '))) > 0
          AND typeof(recovery_owner_generation) = 'integer'
          AND recovery_owner_generation BETWEEN 1 AND 9007199254740991
        )
        OR
        (
          inbound_disposition <> 'transferred_to_recovery_owner'
          AND recovery_owner_logical_turn_id IS NULL
          AND recovery_owner_manager_id IS NULL
          AND recovery_owner_generation IS NULL
        )
      ),
      CONSTRAINT turn_terminal_disarm_evidence CHECK (
        reply_guarantee_disarmed = 0
        OR delivery_kind = 'echoed'
        OR inbound_disposition = 'finalized_no_reply_policy'
      ),
      CONSTRAINT turn_terminal_unknown_stays_armed CHECK (
        delivery_kind <> 'delivery_unknown'
        OR reply_guarantee_disarmed = 0
      ),
      UNIQUE (inbound_seq_key, logical_turn_id, generation)
    );
`;

function createTurnTerminalIndex(db: DatabaseSync): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_turn_terminal_conversation_created
      ON turn_terminal_records(conversation_key, created_at);
  `);
}

function runMigration37(db: DatabaseSync): void {
  db.exec(TURN_TERMINAL_TABLE_DDL);
  createTurnTerminalIndex(db);
}

function requiredRecoveryIdentity(column: string): string {
  return `length(trim(replace(replace(replace(
          ${column}, char(9), ' '
        ), char(10), ' '), char(13), ' '))) > 0`;
}

const TURN_RECOVERY_TABLE_DDL = `
    CREATE TABLE IF NOT EXISTS turn_recovery_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      terminal_record_id INTEGER NOT NULL UNIQUE
        REFERENCES turn_terminal_records(id) ON DELETE RESTRICT,
      scope TEXT NOT NULL CHECK (scope IN ('per_chat', 'shared', 'singleton')),
      conversation_key TEXT NOT NULL,
      delivery_jid TEXT NOT NULL,
      source_inbound_seq INTEGER NOT NULL
        CHECK (typeof(source_inbound_seq) = 'integer'
          AND source_inbound_seq BETWEEN 1 AND 9007199254740991),
      source_inbound_seq_key INTEGER NOT NULL
        CHECK (source_inbound_seq_key = source_inbound_seq),
      source_logical_turn_id TEXT NOT NULL,
      source_manager_id TEXT NOT NULL,
      source_generation INTEGER NOT NULL
        CHECK (typeof(source_generation) = 'integer'
          AND source_generation BETWEEN 1 AND 9007199254740991),
      source_message_id TEXT NOT NULL,
      owner_logical_turn_id TEXT NOT NULL,
      owner_manager_id TEXT NOT NULL,
      owner_generation INTEGER NOT NULL
        CHECK (typeof(owner_generation) = 'integer'
          AND owner_generation BETWEEN 1 AND 9007199254740991),
      assigned_owner_logical_turn_id TEXT NOT NULL,
      assigned_owner_manager_id TEXT NOT NULL,
      assigned_owner_generation INTEGER NOT NULL
        CHECK (typeof(assigned_owner_generation) = 'integer'
          AND assigned_owner_generation BETWEEN 1 AND 9007199254740991),
      replay_safe INTEGER NOT NULL CHECK (replay_safe IN (0, 1)),
      replay_safety_proof_id TEXT,
      sender_jid TEXT NOT NULL,
      sender_name TEXT,
      replay_text TEXT NOT NULL,
      is_group INTEGER NOT NULL CHECK (is_group IN (0, 1)),
      group_name TEXT,
      state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('blocked_unsafe', 'pending', 'claimed', 'completed', 'exhausted')),
      attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (attempt_count BETWEEN 0 AND 5),
      claim_epoch INTEGER NOT NULL DEFAULT 0
        CHECK (claim_epoch = attempt_count),
      assignment_epoch INTEGER NOT NULL DEFAULT 0
        CHECK (assignment_epoch BETWEEN 0 AND 9007199254740991),
      claim_token TEXT,
      claim_expires_at TEXT,
      last_requeue_claim_token_hash TEXT,
      last_requeue_claim_epoch INTEGER,
      last_requeue_backoff_seconds INTEGER,
      next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
      duplicate_enqueue_count INTEGER NOT NULL DEFAULT 0
        CHECK (duplicate_enqueue_count >= 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      claimed_at TEXT,
      completed_at TEXT,
      CONSTRAINT turn_recovery_replay_safe CHECK (
        replay_safe = 0 OR replay_safety_proof_id IS NULL
      ),
      CONSTRAINT turn_recovery_required_identity CHECK (
        ${requiredRecoveryIdentity('conversation_key')}
        AND ${requiredRecoveryIdentity('delivery_jid')}
        AND ${requiredRecoveryIdentity('source_logical_turn_id')}
        AND ${requiredRecoveryIdentity('source_manager_id')}
        AND ${requiredRecoveryIdentity('source_message_id')}
        AND ${requiredRecoveryIdentity('owner_logical_turn_id')}
        AND ${requiredRecoveryIdentity('owner_manager_id')}
        AND ${requiredRecoveryIdentity('assigned_owner_logical_turn_id')}
        AND ${requiredRecoveryIdentity('assigned_owner_manager_id')}
        AND ${requiredRecoveryIdentity('sender_jid')}
      ),
      CONSTRAINT turn_recovery_payload_bounds CHECK (
        length(CAST(conversation_key AS BLOB)) <= 2048
        AND length(CAST(delivery_jid AS BLOB)) <= 2048
        AND length(CAST(source_logical_turn_id AS BLOB)) <= 2048
        AND length(CAST(source_manager_id AS BLOB)) <= 2048
        AND length(CAST(source_message_id AS BLOB)) <= 2048
        AND length(CAST(owner_logical_turn_id AS BLOB)) <= 2048
        AND length(CAST(owner_manager_id AS BLOB)) <= 2048
        AND length(CAST(assigned_owner_logical_turn_id AS BLOB)) <= 2048
        AND length(CAST(assigned_owner_manager_id AS BLOB)) <= 2048
        AND length(CAST(sender_jid AS BLOB)) <= 2048
        AND (replay_safety_proof_id IS NULL
          OR length(CAST(replay_safety_proof_id AS BLOB)) <= 2048)
        AND (sender_name IS NULL OR length(CAST(sender_name AS BLOB)) <= 4096)
        AND length(trim(replace(replace(replace(
          replay_text, char(9), ' '
        ), char(10), ' '), char(13), ' '))) > 0
        AND length(CAST(replay_text AS BLOB)) <= 262144
        AND (group_name IS NULL OR length(CAST(group_name AS BLOB)) <= 4096)
      ),
      CONSTRAINT turn_recovery_group_coherence CHECK (
        is_group = 1 OR group_name IS NULL
      ),
      CONSTRAINT turn_recovery_owner_separation CHECK (
        NOT (
          source_logical_turn_id = owner_logical_turn_id
          AND source_manager_id = owner_manager_id
          AND source_generation = owner_generation
        )
        AND NOT (
          source_logical_turn_id = assigned_owner_logical_turn_id
          AND source_manager_id = assigned_owner_manager_id
          AND source_generation = assigned_owner_generation
        )
      ),
      CONSTRAINT turn_recovery_last_requeue_coherence CHECK (
        (
          last_requeue_claim_token_hash IS NULL
          AND last_requeue_claim_epoch IS NULL
          AND last_requeue_backoff_seconds IS NULL
        )
        OR (
          state IN ('pending', 'exhausted')
          AND last_requeue_claim_token_hash IS NOT NULL
          AND length(last_requeue_claim_token_hash) = 64
          AND last_requeue_claim_token_hash NOT GLOB '*[^0-9a-f]*'
          AND last_requeue_claim_epoch = claim_epoch
          AND last_requeue_claim_epoch BETWEEN 1 AND 5
          AND last_requeue_backoff_seconds BETWEEN 0 AND 3600
        )
      ),
      CONSTRAINT turn_recovery_state_coherence CHECK (
        (
          state = 'blocked_unsafe'
          AND replay_safe = 0
          AND replay_safety_proof_id IS NULL
          AND attempt_count = 0
          AND claim_token IS NULL
          AND claimed_at IS NULL
          AND claim_expires_at IS NULL
          AND completed_at IS NULL
        )
        OR (
          state = 'pending'
          AND attempt_count < 5
          AND (
            replay_safe = 1
            OR (
              replay_safety_proof_id IS NOT NULL
              AND ${requiredRecoveryIdentity('replay_safety_proof_id')}
            )
          )
          AND claim_token IS NULL
          AND claimed_at IS NULL
          AND claim_expires_at IS NULL
          AND completed_at IS NULL
        )
        OR (
          state = 'claimed'
          AND attempt_count BETWEEN 1 AND 5
          AND (
            replay_safe = 1
            OR (
              replay_safety_proof_id IS NOT NULL
              AND ${requiredRecoveryIdentity('replay_safety_proof_id')}
            )
          )
          AND claim_token IS NOT NULL
          AND ${requiredRecoveryIdentity('claim_token')}
          AND claimed_at IS NOT NULL
          AND claim_expires_at IS NOT NULL
          AND completed_at IS NULL
        )
        OR (
          state = 'completed'
          AND attempt_count BETWEEN 1 AND 5
          AND (
            replay_safe = 1
            OR (
              replay_safety_proof_id IS NOT NULL
              AND ${requiredRecoveryIdentity('replay_safety_proof_id')}
            )
          )
          AND claim_token IS NOT NULL
          AND ${requiredRecoveryIdentity('claim_token')}
          AND claimed_at IS NOT NULL
          AND claim_expires_at IS NOT NULL
          AND completed_at IS NOT NULL
        )
        OR (
          state = 'exhausted'
          AND attempt_count = 5
          AND (
            replay_safe = 1
            OR (
              replay_safety_proof_id IS NOT NULL
              AND ${requiredRecoveryIdentity('replay_safety_proof_id')}
            )
          )
          AND claim_token IS NULL
          AND claimed_at IS NULL
          AND claim_expires_at IS NULL
          AND completed_at IS NULL
        )
      ),
      UNIQUE (source_inbound_seq_key, source_logical_turn_id, source_generation)
    );
`;

function runMigration38(db: DatabaseSync): void {
  db.exec(TURN_RECOVERY_TABLE_DDL);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS turn_recovery_immutable_envelope
    BEFORE UPDATE OF
      terminal_record_id, scope, conversation_key, delivery_jid,
      source_inbound_seq, source_inbound_seq_key, source_logical_turn_id,
      source_manager_id, source_generation, source_message_id,
      owner_logical_turn_id, owner_manager_id, owner_generation,
      replay_safe, sender_jid, sender_name, replay_text, is_group, group_name,
      created_at
    ON turn_recovery_jobs
    WHEN NEW.terminal_record_id IS NOT OLD.terminal_record_id
      OR NEW.scope IS NOT OLD.scope
      OR NEW.conversation_key IS NOT OLD.conversation_key
      OR NEW.delivery_jid IS NOT OLD.delivery_jid
      OR NEW.source_inbound_seq IS NOT OLD.source_inbound_seq
      OR NEW.source_inbound_seq_key IS NOT OLD.source_inbound_seq_key
      OR NEW.source_logical_turn_id IS NOT OLD.source_logical_turn_id
      OR NEW.source_manager_id IS NOT OLD.source_manager_id
      OR NEW.source_generation IS NOT OLD.source_generation
      OR NEW.source_message_id IS NOT OLD.source_message_id
      OR NEW.owner_logical_turn_id IS NOT OLD.owner_logical_turn_id
      OR NEW.owner_manager_id IS NOT OLD.owner_manager_id
      OR NEW.owner_generation IS NOT OLD.owner_generation
      OR NEW.replay_safe IS NOT OLD.replay_safe
      OR NEW.sender_jid IS NOT OLD.sender_jid
      OR NEW.sender_name IS NOT OLD.sender_name
      OR NEW.replay_text IS NOT OLD.replay_text
      OR NEW.is_group IS NOT OLD.is_group
      OR NEW.group_name IS NOT OLD.group_name
      OR NEW.created_at IS NOT OLD.created_at
    BEGIN
      SELECT RAISE(ABORT, 'turn recovery immutable envelope');
    END;

    CREATE TRIGGER IF NOT EXISTS turn_recovery_immutable_promotion_proof
    BEFORE UPDATE OF replay_safety_proof_id ON turn_recovery_jobs
    WHEN OLD.replay_safety_proof_id IS NOT NULL
      AND NEW.replay_safety_proof_id IS NOT OLD.replay_safety_proof_id
    BEGIN
      SELECT RAISE(ABORT, 'turn recovery immutable promotion proof');
    END;

    CREATE TRIGGER IF NOT EXISTS turn_recovery_assignment_epoch_fence
    BEFORE UPDATE OF
      assigned_owner_logical_turn_id, assigned_owner_manager_id,
      assigned_owner_generation, assignment_epoch
    ON turn_recovery_jobs
    WHEN (
      (
        NEW.assigned_owner_logical_turn_id IS NOT OLD.assigned_owner_logical_turn_id
        OR NEW.assigned_owner_manager_id IS NOT OLD.assigned_owner_manager_id
        OR NEW.assigned_owner_generation IS NOT OLD.assigned_owner_generation
      )
      AND NEW.assignment_epoch <> OLD.assignment_epoch + 1
    ) OR (
      NEW.assigned_owner_logical_turn_id IS OLD.assigned_owner_logical_turn_id
      AND NEW.assigned_owner_manager_id IS OLD.assigned_owner_manager_id
      AND NEW.assigned_owner_generation IS OLD.assigned_owner_generation
      AND NEW.assignment_epoch <> OLD.assignment_epoch
    )
    BEGIN
      SELECT RAISE(ABORT, 'turn recovery assignment epoch fence');
    END;

    CREATE INDEX IF NOT EXISTS idx_turn_terminal_delivery_op
      ON turn_terminal_records(delivery_op_id)
      WHERE delivery_op_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_turn_recovery_state_id
      ON turn_recovery_jobs(state, id);
    CREATE INDEX IF NOT EXISTS idx_turn_recovery_owner_state
      ON turn_recovery_jobs(
        assigned_owner_logical_turn_id, assigned_owner_manager_id,
        assigned_owner_generation, state, next_attempt_at, id
      );
    CREATE INDEX IF NOT EXISTS idx_turn_recovery_stale_claim
      ON turn_recovery_jobs(state, claim_expires_at, id);
  `);
}

function runMigration39(db: DatabaseSync): void {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_checkpoints'")
    .get() as { name: string } | undefined;
  if (!table) return;

  const columns: ReadonlyArray<readonly [string, 'TEXT' | 'INTEGER']> = [
    ['completed_inbound_seq', 'INTEGER'],
    ['completed_delivery_jid', 'TEXT'],
    ['completed_delivery_namespace', 'TEXT'],
    ['completed_scope', 'TEXT'],
    ['completed_logical_turn_id', 'TEXT'],
    ['completed_manager_id', 'TEXT'],
    ['completed_generation', 'INTEGER'],
  ];
  const existing = new Set(
    (db.prepare("PRAGMA table_info('session_checkpoints')").all() as Array<{ name: string }>)
      .map((column) => column.name),
  );
  for (const [name, type] of columns) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE session_checkpoints ADD COLUMN ${name} ${type}`);
    }
  }
  const partialBundle = `
    ((completed_inbound_seq IS NOT NULL)
      + (completed_delivery_jid IS NOT NULL)
      + (completed_delivery_namespace IS NOT NULL)
      + (completed_scope IS NOT NULL)
      + (completed_logical_turn_id IS NOT NULL)
      + (completed_manager_id IS NOT NULL)
      + (completed_generation IS NOT NULL)) NOT IN (0, 7)
  `;
  db.exec(`
    DROP TRIGGER IF EXISTS session_checkpoints_completed_identity_bundle_insert;
    DROP TRIGGER IF EXISTS session_checkpoints_completed_identity_bundle_update;

    CREATE TRIGGER IF NOT EXISTS session_checkpoints_completed_identity_bundle_insert
    BEFORE INSERT ON session_checkpoints
    WHEN ${partialBundle.replaceAll('completed_', 'NEW.completed_')}
    BEGIN
      SELECT RAISE(ABORT, 'session checkpoint completed identity bundle must be all-or-none');
    END;

    CREATE TRIGGER IF NOT EXISTS session_checkpoints_completed_identity_bundle_update
    BEFORE UPDATE OF
      completed_inbound_seq, completed_delivery_jid,
      completed_delivery_namespace, completed_scope,
      completed_logical_turn_id, completed_manager_id, completed_generation
    ON session_checkpoints
    WHEN ${partialBundle.replaceAll('completed_', 'NEW.completed_')}
    BEGIN
      SELECT RAISE(ABORT, 'session checkpoint completed identity bundle must be all-or-none');
    END;
  `);
}

function runMigration40(db: DatabaseSync): void {
  // Migration 39 originally omitted the inbound sequence from the completed
  // resume identity. Re-run its idempotent shape first so an already-recorded
  // v39 database receives the dedicated field and the seven-field trigger.
  runMigration39(db);
  const checkpointTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_checkpoints'",
  ).get() as { name: string } | undefined;
  if (checkpointTable) {
    // A six-field legacy bundle may already have been mixed with a newer
    // last_inbound_seq. Clear it rather than fabricating unsafe resume proof;
    // the next genuinely terminal turn repopulates the complete bundle.
    db.exec(`
      UPDATE session_checkpoints
      SET completed_inbound_seq = NULL,
          completed_delivery_jid = NULL,
          completed_delivery_namespace = NULL,
          completed_scope = NULL,
          completed_logical_turn_id = NULL,
          completed_manager_id = NULL,
          completed_generation = NULL
      WHERE completed_inbound_seq IS NULL
        AND (
          completed_delivery_jid IS NOT NULL
          OR completed_delivery_namespace IS NOT NULL
          OR completed_scope IS NOT NULL
          OR completed_logical_turn_id IS NOT NULL
          OR completed_manager_id IS NOT NULL
          OR completed_generation IS NOT NULL
        )
    `);
  }

  const requiredTables = ['inbound_events', 'outbound_ops', 'turn_terminal_records', 'turn_recovery_jobs'];
  const presentTables = new Set(
    (db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('inbound_events', 'outbound_ops', 'turn_terminal_records', 'turn_recovery_jobs')
    `).all() as Array<{ name: string }>).map((row) => row.name),
  );
  // Historical/partial-schema fixtures can legitimately omit the durability
  // substrate. There is no recovery boundary to harden in that shape.
  if (requiredTables.some((table) => !presentTables.has(table))) return;

  const recoveryColumns = new Set(
    (db.prepare("PRAGMA table_info('turn_recovery_jobs')").all() as Array<{ name: string }>)
      .map((column) => column.name),
  );
  const completionColumns: ReadonlyArray<readonly [string, string]> = [
    ['completion_kind', "TEXT CHECK (completion_kind IS NULL OR completion_kind IN ('worker', 'echo'))"],
    ['completion_proof_id', 'TEXT'],
    ['echo_conflict_at', 'TEXT'],
    ['echo_conflict_reason', 'TEXT'],
  ];
  for (const [name, type] of completionColumns) {
    if (!recoveryColumns.has(name)) {
      db.exec(`ALTER TABLE turn_recovery_jobs ADD COLUMN ${name} ${type}`);
    }
  }
  db.exec(`
    UPDATE turn_recovery_jobs
    SET completion_kind = 'worker',
        completion_proof_id = 'legacy-worker:' || id || ':' || claim_epoch
    WHERE state = 'completed' AND completion_kind IS NULL
  `);

  const invalidExisting = db.prepare(`
    SELECT t.id
    FROM turn_terminal_records t
    LEFT JOIN outbound_ops o ON o.id = t.delivery_op_id
    WHERE t.inbound_disposition = 'transferred_to_recovery_owner'
      AND (
        t.delivery_kind NOT IN ('enqueued', 'flushed', 'delivery_unknown')
        OR t.inbound_seq IS NULL
        OR t.delivery_op_id IS NULL
        OR o.id IS NULL
        OR o.conversation_key <> t.conversation_key
        OR o.chat_jid <> t.delivery_jid
        OR o.source_inbound_seq IS NOT t.inbound_seq
      )
    LIMIT 1
  `).get() as { id: number } | undefined;
  if (invalidExisting) {
    throw new Error(
      `turn recovery transfer ${invalidExisting.id} lacks matching unresolved delivery evidence`,
    );
  }

  const orphanTransfer = db.prepare(`
    SELECT t.id
    FROM turn_terminal_records t
    LEFT JOIN turn_recovery_jobs j ON j.terminal_record_id = t.id
    WHERE t.inbound_disposition = 'transferred_to_recovery_owner'
      AND j.id IS NULL
    LIMIT 1
  `).get() as { id: number } | undefined;
  if (orphanTransfer) {
    throw new Error(
      `turn recovery transfer ${orphanTransfer.id} has no linked recovery job`,
    );
  }

  const invalidRecoveryLink = db.prepare(`
    SELECT j.id
    FROM turn_recovery_jobs j
    LEFT JOIN turn_terminal_records t ON t.id = j.terminal_record_id
    LEFT JOIN inbound_events i ON i.seq = j.source_inbound_seq
    LEFT JOIN outbound_ops o ON o.id = t.delivery_op_id
    WHERE t.id IS NULL
      OR t.inbound_disposition <> 'transferred_to_recovery_owner'
      OR t.scope IS NOT j.scope
      OR t.conversation_key IS NOT j.conversation_key
      OR t.delivery_jid IS NOT j.delivery_jid
      OR t.inbound_seq IS NOT j.source_inbound_seq
      OR t.inbound_seq_key IS NOT j.source_inbound_seq_key
      OR t.logical_turn_id IS NOT j.source_logical_turn_id
      OR t.manager_id IS NOT j.source_manager_id
      OR t.generation IS NOT j.source_generation
      OR t.recovery_owner_logical_turn_id IS NOT j.owner_logical_turn_id
      OR t.recovery_owner_manager_id IS NOT j.owner_manager_id
      OR t.recovery_owner_generation IS NOT j.owner_generation
      OR t.delivery_kind NOT IN ('enqueued', 'flushed', 'delivery_unknown')
      OR i.seq IS NULL
      OR i.message_id IS NOT j.source_message_id
      OR i.conversation_key IS NOT j.conversation_key
      OR i.chat_jid IS NOT j.delivery_jid
      OR o.id IS NULL
      OR o.source_inbound_seq IS NOT j.source_inbound_seq
      OR o.conversation_key IS NOT j.conversation_key
      OR o.chat_jid IS NOT j.delivery_jid
    LIMIT 1
  `).get() as { id: number } | undefined;
  if (invalidRecoveryLink) {
    throw new Error(
      `turn recovery job ${invalidRecoveryLink.id} has an inconsistent proof link`,
    );
  }

  const invalidCompletedRecovery = db.prepare(`
    SELECT j.id
    FROM turn_recovery_jobs j
    JOIN inbound_events i ON i.seq = j.source_inbound_seq
    JOIN turn_terminal_records t ON t.id = j.terminal_record_id
    JOIN outbound_ops o ON o.id = t.delivery_op_id
    WHERE j.state = 'completed'
      AND (
        i.processing_status NOT IN ('complete', 'failed')
        OR o.status NOT IN ('echoed', 'failed_permanent', 'quarantined')
      )
    LIMIT 1
  `).get() as { id: number } | undefined;
  if (invalidCompletedRecovery) {
    throw new Error(
      `turn recovery job ${invalidCompletedRecovery.id} is completed without terminal source and delivery proof`,
    );
  }

  const duplicateSelectedDelivery = db.prepare(`
    SELECT delivery_op_id
    FROM turn_terminal_records
    WHERE inbound_disposition = 'transferred_to_recovery_owner'
      AND delivery_op_id IS NOT NULL
    GROUP BY delivery_op_id
    HAVING COUNT(*) > 1
    LIMIT 1
  `).get() as { delivery_op_id: number } | undefined;
  if (duplicateSelectedDelivery) {
    throw new Error(
      `turn recovery delivery ${duplicateSelectedDelivery.delivery_op_id} has multiple terminal owners`,
    );
  }

  const invalidTransfer = `
    NEW.inbound_disposition = 'transferred_to_recovery_owner'
    AND (
      NEW.delivery_kind NOT IN ('enqueued', 'flushed', 'delivery_unknown')
      OR NEW.inbound_seq IS NULL
      OR NEW.delivery_op_id IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM outbound_ops o
        WHERE o.id = NEW.delivery_op_id
          AND o.conversation_key = NEW.conversation_key
          AND o.chat_jid = NEW.delivery_jid
          AND o.source_inbound_seq IS NEW.inbound_seq
          AND (
            (NEW.delivery_kind = 'enqueued' AND o.status = 'pending')
            OR (NEW.delivery_kind = 'flushed' AND o.status = 'submitted')
            OR (NEW.delivery_kind = 'delivery_unknown' AND o.status = 'maybe_sent')
          )
      )
    )
  `;
  db.exec(`
    DROP TRIGGER IF EXISTS turn_terminal_transfer_requires_delivery;
    DROP TRIGGER IF EXISTS turn_terminal_transfer_requires_delivery_update;
    DROP TRIGGER IF EXISTS turn_terminal_recovery_envelope_immutable;
    DROP TRIGGER IF EXISTS turn_recovery_selected_delivery_identity_immutable;
    DROP TRIGGER IF EXISTS turn_recovery_source_inbound_identity_immutable;
    DROP TRIGGER IF EXISTS turn_recovery_completion_requires_terminal_source;
    DROP TRIGGER IF EXISTS turn_recovery_completion_requires_terminal_source_insert;
    DROP TRIGGER IF EXISTS turn_recovery_completion_metadata_coherent;
    DROP TRIGGER IF EXISTS turn_recovery_completion_metadata_coherent_insert;
    DROP TRIGGER IF EXISTS turn_recovery_completion_requires_terminal_delivery;
    DROP TRIGGER IF EXISTS turn_recovery_completion_requires_terminal_delivery_insert;
    DROP TRIGGER IF EXISTS turn_recovery_completed_source_stays_terminal;
    DROP TRIGGER IF EXISTS turn_recovery_completed_delivery_stays_terminal;
    DROP TRIGGER IF EXISTS turn_recovery_retain_source_inbound;
    DROP TRIGGER IF EXISTS turn_recovery_retain_selected_delivery;

    DROP INDEX IF EXISTS idx_turn_terminal_delivery_op;
    CREATE UNIQUE INDEX idx_turn_terminal_delivery_op
      ON turn_terminal_records(delivery_op_id)
      WHERE inbound_disposition = 'transferred_to_recovery_owner'
        AND delivery_op_id IS NOT NULL;

    CREATE TRIGGER IF NOT EXISTS turn_terminal_transfer_requires_delivery
    BEFORE INSERT ON turn_terminal_records
    WHEN ${invalidTransfer}
      AND NOT EXISTS (
        SELECT 1 FROM turn_terminal_records existing
        WHERE existing.inbound_seq_key = NEW.inbound_seq_key
          AND existing.logical_turn_id = NEW.logical_turn_id
          AND existing.generation = NEW.generation
      )
    BEGIN
      SELECT RAISE(ABORT, 'turn recovery transfer requires matching unresolved delivery evidence');
    END;

    CREATE TRIGGER IF NOT EXISTS turn_terminal_transfer_requires_delivery_update
    BEFORE UPDATE OF
      inbound_disposition, delivery_kind, delivery_op_id,
      conversation_key, delivery_jid, inbound_seq
    ON turn_terminal_records
    WHEN ${invalidTransfer}
    BEGIN
      SELECT RAISE(ABORT, 'turn recovery transfer requires matching unresolved delivery evidence');
    END;

    CREATE TRIGGER IF NOT EXISTS turn_terminal_recovery_envelope_immutable
    BEFORE UPDATE ON turn_terminal_records
    WHEN EXISTS (
      SELECT 1 FROM turn_recovery_jobs j WHERE j.terminal_record_id = OLD.id
    ) AND (
      NEW.scope IS NOT OLD.scope
      OR NEW.conversation_key IS NOT OLD.conversation_key
      OR NEW.delivery_jid IS NOT OLD.delivery_jid
      OR NEW.inbound_seq IS NOT OLD.inbound_seq
      OR NEW.inbound_seq_key IS NOT OLD.inbound_seq_key
      OR NEW.logical_turn_id IS NOT OLD.logical_turn_id
      OR NEW.manager_id IS NOT OLD.manager_id
      OR NEW.generation IS NOT OLD.generation
      OR NEW.attempt_kind IS NOT OLD.attempt_kind
      OR NEW.attempt_failure_class IS NOT OLD.attempt_failure_class
      OR NEW.inbound_disposition IS NOT OLD.inbound_disposition
      OR NEW.delivery_kind IS NOT OLD.delivery_kind
      OR NEW.delivery_op_id IS NOT OLD.delivery_op_id
      OR NEW.recovery_owner_logical_turn_id IS NOT OLD.recovery_owner_logical_turn_id
      OR NEW.recovery_owner_manager_id IS NOT OLD.recovery_owner_manager_id
      OR NEW.recovery_owner_generation IS NOT OLD.recovery_owner_generation
      OR NEW.reply_guarantee_disarmed IS NOT OLD.reply_guarantee_disarmed
      OR NEW.created_at IS NOT OLD.created_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'linked turn recovery terminal envelope is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS turn_recovery_selected_delivery_identity_immutable
    BEFORE UPDATE OF conversation_key, chat_jid, source_inbound_seq ON outbound_ops
    WHEN EXISTS (
      SELECT 1
      FROM turn_recovery_jobs j
      JOIN turn_terminal_records t ON t.id = j.terminal_record_id
      WHERE t.delivery_op_id = OLD.id
    ) AND (
      NEW.conversation_key IS NOT OLD.conversation_key
      OR NEW.chat_jid IS NOT OLD.chat_jid
      OR NEW.source_inbound_seq IS NOT OLD.source_inbound_seq
    )
    BEGIN
      SELECT RAISE(ABORT, 'selected turn recovery delivery identity is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS turn_recovery_source_inbound_identity_immutable
    BEFORE UPDATE OF message_id, conversation_key, chat_jid ON inbound_events
    WHEN EXISTS (
      SELECT 1 FROM turn_recovery_jobs j WHERE j.source_inbound_seq = OLD.seq
    ) AND (
      NEW.message_id IS NOT OLD.message_id
      OR NEW.conversation_key IS NOT OLD.conversation_key
      OR NEW.chat_jid IS NOT OLD.chat_jid
    )
    BEGIN
      SELECT RAISE(ABORT, 'turn recovery source inbound identity is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS turn_recovery_completion_requires_terminal_source
    BEFORE UPDATE OF state ON turn_recovery_jobs
    WHEN NEW.state = 'completed'
      AND OLD.state <> 'completed'
      AND NOT EXISTS (
        SELECT 1 FROM inbound_events i
        WHERE i.seq = NEW.source_inbound_seq
          AND i.processing_status IN ('complete', 'failed')
      )
    BEGIN
      SELECT RAISE(ABORT, 'recovery source inbound must be terminal before completion');
    END;

    CREATE TRIGGER IF NOT EXISTS turn_recovery_completion_requires_terminal_source_insert
    BEFORE INSERT ON turn_recovery_jobs
    WHEN NEW.state = 'completed'
      AND NOT EXISTS (
        SELECT 1 FROM inbound_events i
        WHERE i.seq = NEW.source_inbound_seq
          AND i.processing_status IN ('complete', 'failed')
      )
    BEGIN
      SELECT RAISE(ABORT, 'recovery source inbound must be terminal before completion');
    END;

    CREATE TRIGGER IF NOT EXISTS turn_recovery_completion_metadata_coherent
    BEFORE UPDATE OF state, completion_kind, completion_proof_id ON turn_recovery_jobs
    WHEN (
      NEW.state = 'completed'
      AND (
        NEW.completion_kind NOT IN ('worker', 'echo')
        OR NEW.completion_proof_id IS NULL
        OR length(trim(NEW.completion_proof_id)) = 0
        OR length(CAST(NEW.completion_proof_id AS BLOB)) > 2048
      )
    ) OR (
      NEW.state <> 'completed'
      AND (NEW.completion_kind IS NOT NULL OR NEW.completion_proof_id IS NOT NULL)
    )
    BEGIN
      SELECT RAISE(ABORT, 'recovery completion metadata is incoherent');
    END;

    CREATE TRIGGER IF NOT EXISTS turn_recovery_completion_metadata_coherent_insert
    BEFORE INSERT ON turn_recovery_jobs
    WHEN (
      NEW.state = 'completed'
      AND (
        NEW.completion_kind NOT IN ('worker', 'echo')
        OR NEW.completion_proof_id IS NULL
        OR length(trim(NEW.completion_proof_id)) = 0
        OR length(CAST(NEW.completion_proof_id AS BLOB)) > 2048
      )
    ) OR (
      NEW.state <> 'completed'
      AND (NEW.completion_kind IS NOT NULL OR NEW.completion_proof_id IS NOT NULL)
    )
    BEGIN
      SELECT RAISE(ABORT, 'recovery completion metadata is incoherent');
    END;

    CREATE TRIGGER IF NOT EXISTS turn_recovery_completion_requires_terminal_delivery
    BEFORE UPDATE OF state ON turn_recovery_jobs
    WHEN NEW.state = 'completed'
      AND OLD.state <> 'completed'
      AND NOT EXISTS (
        SELECT 1
        FROM turn_terminal_records t
        JOIN outbound_ops o ON o.id = t.delivery_op_id
        WHERE t.id = NEW.terminal_record_id
          AND t.inbound_disposition = 'transferred_to_recovery_owner'
          AND t.scope = NEW.scope
          AND t.inbound_seq = NEW.source_inbound_seq
          AND t.conversation_key = NEW.conversation_key
          AND t.delivery_jid = NEW.delivery_jid
          AND o.source_inbound_seq = NEW.source_inbound_seq
          AND o.conversation_key = NEW.conversation_key
          AND o.chat_jid = NEW.delivery_jid
          AND o.status IN ('echoed', 'failed_permanent', 'quarantined')
      )
    BEGIN
      SELECT RAISE(ABORT, 'recovery selected delivery must be terminal before completion');
    END;

    CREATE TRIGGER IF NOT EXISTS turn_recovery_completion_requires_terminal_delivery_insert
    BEFORE INSERT ON turn_recovery_jobs
    WHEN NEW.state = 'completed'
      AND NOT EXISTS (
        SELECT 1
        FROM turn_terminal_records t
        JOIN outbound_ops o ON o.id = t.delivery_op_id
        WHERE t.id = NEW.terminal_record_id
          AND t.inbound_disposition = 'transferred_to_recovery_owner'
          AND t.scope = NEW.scope
          AND t.inbound_seq = NEW.source_inbound_seq
          AND t.conversation_key = NEW.conversation_key
          AND t.delivery_jid = NEW.delivery_jid
          AND o.source_inbound_seq = NEW.source_inbound_seq
          AND o.conversation_key = NEW.conversation_key
          AND o.chat_jid = NEW.delivery_jid
          AND o.status IN ('echoed', 'failed_permanent', 'quarantined')
      )
    BEGIN
      SELECT RAISE(ABORT, 'recovery selected delivery must be terminal before completion');
    END;

    CREATE TRIGGER IF NOT EXISTS turn_recovery_completed_source_stays_terminal
    BEFORE UPDATE OF processing_status ON inbound_events
    WHEN NEW.processing_status NOT IN ('complete', 'failed')
      AND EXISTS (
        SELECT 1 FROM turn_recovery_jobs j
        WHERE j.source_inbound_seq = OLD.seq AND j.state = 'completed'
      )
    BEGIN
      SELECT RAISE(ABORT, 'completed recovery source inbound must stay terminal');
    END;

    CREATE TRIGGER IF NOT EXISTS turn_recovery_completed_delivery_stays_terminal
    BEFORE UPDATE OF status ON outbound_ops
    WHEN NEW.status NOT IN ('echoed', 'failed_permanent', 'quarantined')
      AND EXISTS (
        SELECT 1
        FROM turn_recovery_jobs j
        JOIN turn_terminal_records t ON t.id = j.terminal_record_id
        WHERE t.delivery_op_id = OLD.id AND j.state = 'completed'
      )
    BEGIN
      SELECT RAISE(ABORT, 'completed recovery selected delivery must stay terminal');
    END;

    CREATE TRIGGER IF NOT EXISTS turn_recovery_retain_source_inbound
    BEFORE DELETE ON inbound_events
    WHEN EXISTS (
      SELECT 1 FROM turn_recovery_jobs j
      WHERE j.source_inbound_seq = OLD.seq
    )
    BEGIN
      SELECT RAISE(ABORT, 'cannot delete outstanding recovery proof source inbound');
    END;

    CREATE TRIGGER IF NOT EXISTS turn_recovery_retain_selected_delivery
    BEFORE DELETE ON outbound_ops
    WHEN EXISTS (
      SELECT 1
      FROM turn_recovery_jobs j
      JOIN turn_terminal_records t ON t.id = j.terminal_record_id
      WHERE t.delivery_op_id = OLD.id
    )
    BEGIN
      SELECT RAISE(ABORT, 'cannot delete outstanding recovery proof selected delivery');
    END;
  `);
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
