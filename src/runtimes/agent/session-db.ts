import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { Database } from '../../core/database.ts';
import { toConversationKey } from '../../core/conversation-key.ts';
import { createChildLogger } from '../../logger.ts';

const log = createChildLogger('agent-session-db');

const AGENT_SESSION_DDL = `
CREATE TABLE IF NOT EXISTS agent_sessions (
  id INTEGER PRIMARY KEY,
  session_id TEXT,
  claude_pid INTEGER,
  started_in_directory TEXT,
  transcript_path TEXT,
  started_at TEXT NOT NULL,
  last_message_at TEXT,
  status TEXT NOT NULL DEFAULT 'active'
);
`;

/** Ensure agent-specific tables exist in the given database. Idempotent. */
export function ensureAgentSchema(db: Database): void {
  db.raw.exec(AGENT_SESSION_DDL);
  // Idempotent column migrations
  for (const [col, def] of [
    ['chat_jid', 'TEXT'],
    ['message_count', 'INTEGER DEFAULT 0'],
    ['workspace_key', 'TEXT'],
    ['total_input_tokens', 'INTEGER DEFAULT 0'],
    ['total_output_tokens', 'INTEGER DEFAULT 0'],
    ['last_compact_at', 'TEXT'],
    ['last_compact_input_tokens', 'INTEGER DEFAULT 0'],
    ['last_compact_output_tokens', 'INTEGER DEFAULT 0'],
    ['provider', 'TEXT'],
  ] as [string, string][]) {
    try {
      db.raw.exec(`ALTER TABLE agent_sessions ADD COLUMN ${col} ${def}`);
    } catch (err) {
      // SQLite raises "duplicate column name: <col>" when the column already
      // exists — that is the only error we want to swallow here.
      if (!(err instanceof Error) || !err.message.includes('duplicate column name')) {
        throw err;
      }
    }
  }
}

/**
 * Insert a new agent session row with status='active'.
 * Returns the row id (> 0).
 */
export function createSession(
  db: Database,
  pid: number,
  cwd: string,
  chatJid?: string,
  workspaceKey?: string,
  provider?: string,
): number {
  const result = db.raw
    .prepare(
      `INSERT INTO agent_sessions (claude_pid, started_in_directory, chat_jid, workspace_key, started_at, status, provider)
       VALUES (?, ?, ?, ?, datetime('now'), 'active', ?)`,
    )
    .run(pid, cwd, chatJid ?? null, workspaceKey ?? null, provider ?? null) as { lastInsertRowid: number | bigint };
  return Number(result.lastInsertRowid);
}

/** Backfill provider on existing sessions that have no provider set. Idempotent. */
export function backfillSessionProvider(db: Database, provider: string): void {
  const result = db.raw.prepare(
    `UPDATE agent_sessions SET provider = ? WHERE provider IS NULL`
  ).run(provider);
  const changes = (result as { changes: number }).changes;
  if (changes > 0) {
    log.info({ provider, updated: changes }, 'backfilled session provider');
  }
}

// NOTE: getActiveSession and getResumableSessionForChat are intentionally separate.
// They are NOT the same query with different filters:
//   - getActiveSession: no workspace filter; status IN ('active','suspended'); returns
//     the current runtime's running session (for startup/continuity checks).
//   - getResumableSessionForChat: filters by workspace_key; status IN ('suspended','orphaned');
//     returns a specific chat's handoff session (for per-chat resume flows).
// Different status sets, different filter dimensions, and different return shapes
// (getActiveSession includes message_count/last_message_at; getResumableSessionForChat
// does not). Merging them would obscure the two distinct call-sites' intent.

/**
 * Return the single active session, or null if none exists.
 */
export function getActiveSession(db: Database): {
  id: number;
  session_id: string | null;
  claude_pid: number;
  status: string;
  chat_jid: string | null;
  started_at: string;
  last_message_at: string | null;
  message_count: number;
} | null {
  const row = db.raw
    .prepare(
      `SELECT id, session_id, claude_pid, status, chat_jid, started_at, last_message_at, message_count
       FROM agent_sessions
       WHERE status IN ('active', 'suspended') AND session_id IS NOT NULL
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get() as
    | {
        id: number;
        session_id: string | null;
        claude_pid: number;
        status: string;
        chat_jid: string | null;
        started_at: string;
        last_message_at: string | null;
        message_count: number;
      }
    | undefined;
  return row ?? null;
}

/**
 * Enumerate currently-active session rows for the background handoff distiller.
 * Returns one {conversationKey, rowId} per active row that has a workspace_key
 * (the canonical conversation_key). Rows without a workspace_key are skipped —
 * the distiller keys artifacts on conversation_key, so an unkeyed row has no
 * target. Read-only; safe to call on every sweep tick.
 */
export function listActiveSessionRows(
  db: Database,
): Array<{ conversationKey: string; rowId: number }> {
  const rows = db.raw
    .prepare(
      `SELECT id, workspace_key
       FROM agent_sessions
       WHERE status = 'active' AND workspace_key IS NOT NULL AND workspace_key != ''`,
    )
    .all() as Array<{ id: number; workspace_key: string }>;
  return rows.map((r) => ({ conversationKey: r.workspace_key, rowId: r.id }));
}

/** Set the Claude session_id on an existing session row. */
export function updateSessionId(db: Database, rowId: number, sessionId: string): void {
  log.info({ rowId }, 'session: id-assigned');
  db.raw
    .prepare(`UPDATE agent_sessions SET session_id = ? WHERE id = ?`)
    .run(sessionId, rowId);
}

/** Increment message_count and stamp last_message_at on an existing session row. */
export function incrementMessageCount(db: Database, rowId: number): void {
  db.raw
    .prepare(
      `UPDATE agent_sessions
       SET message_count = message_count + 1, last_message_at = datetime('now')
       WHERE id = ?`,
    )
    .run(rowId);
}

/** Accumulate token usage for a session row (adds to existing totals). */
export function accumulateSessionTokens(
  db: Database,
  rowId: number,
  inputTokens: number,
  outputTokens: number,
): void {
  db.raw
    .prepare(
      `UPDATE agent_sessions
       SET total_input_tokens = total_input_tokens + ?,
           total_output_tokens = total_output_tokens + ?
       WHERE id = ?`,
    )
    .run(inputTokens, outputTokens, rowId);
}

/** Record a timestamped token usage event for granular metrics. */
export function insertTokenEvent(
  db: Database,
  agentSessionId: number,
  inputTokens: number,
  outputTokens: number,
): void {
  db.raw
    .prepare(
      `INSERT INTO agent_token_events (agent_session_id, timestamp, input_tokens, output_tokens)
       VALUES (?, unixepoch('now'), ?, ?)`,
    )
    .run(agentSessionId, inputTokens, outputTokens);
}

/** Atomically accumulate session tokens and record a token event in one transaction. */
export function accumulateTokensWithEvent(
  db: Database,
  rowId: number,
  inputTokens: number,
  outputTokens: number,
): void {
  db.raw.exec('BEGIN IMMEDIATE');
  try {
    accumulateSessionTokens(db, rowId, inputTokens, outputTokens);
    insertTokenEvent(db, rowId, inputTokens, outputTokens);
    db.raw.exec('COMMIT');
  } catch (err) {
    try { db.raw.exec('ROLLBACK'); } catch { /* best-effort rollback */ }
    log.error({ agentSessionId: rowId, inputTokens, outputTokens, err }, 'token_event.write_fail');
    throw err;
  }
}

export interface SessionTokenSnapshot {
  totalInputTokens: number;
  totalOutputTokens: number;
  lastCompactInputTokens: number;
  lastCompactOutputTokens: number;
}

/** Return token totals for compaction budgeting, or null when the row is gone. */
export function getSessionTokenSnapshot(db: Database, rowId: number): SessionTokenSnapshot | null {
  const row = db.raw
    .prepare(
      `SELECT total_input_tokens, total_output_tokens,
              last_compact_input_tokens, last_compact_output_tokens
       FROM agent_sessions
       WHERE id = ?`,
    )
    .get(rowId) as
    | {
        total_input_tokens: number | null;
        total_output_tokens: number | null;
        last_compact_input_tokens: number | null;
        last_compact_output_tokens: number | null;
      }
    | undefined;

  if (!row) return null;
  return {
    totalInputTokens: row.total_input_tokens ?? 0,
    totalOutputTokens: row.total_output_tokens ?? 0,
    lastCompactInputTokens: row.last_compact_input_tokens ?? 0,
    lastCompactOutputTokens: row.last_compact_output_tokens ?? 0,
  };
}

/** Mark the current token totals as the baseline for future compaction checks. */
export function markSessionCompacted(db: Database, rowId: number): void {
  db.raw
    .prepare(
      `UPDATE agent_sessions
       SET last_compact_at = datetime('now'),
           last_compact_input_tokens = total_input_tokens,
           last_compact_output_tokens = total_output_tokens
       WHERE id = ?`,
    )
    .run(rowId);
}

const TERMINAL_STATUSES = new Set(['ended', 'completed', 'crashed', 'resume_failed', 'orphaned']);

/** Update the status of an existing session row to any arbitrary status string. */
export function updateSessionStatus(db: Database, rowId: number, status: string): void {
  if (TERMINAL_STATUSES.has(status)) {
    const endedAt = new Date().toISOString();
    db.raw
      .prepare(
        `UPDATE agent_sessions SET status = ?, ended_at = ? WHERE id = ?`,
      )
      .run(status, endedAt, rowId);
    log.info({ agentSessionId: rowId, status, endedAt }, 'session.ended');
  } else {
    if (status === 'active') {
      db.raw.prepare(
        'UPDATE agent_sessions SET status = ?, ended_at = NULL WHERE id = ?',
      ).run(status, rowId);
    } else {
      db.raw.prepare('UPDATE agent_sessions SET status = ? WHERE id = ?').run(status, rowId);
    }
  }
}

/** Persist the local transcript file path on an existing session row. */
export function updateTranscriptPath(db: Database, rowId: number, path: string): void {
  db.raw.prepare('UPDATE agent_sessions SET transcript_path = ? WHERE id = ?').run(path, rowId);
}

/**
 * Backfill workspace_key for existing rows that have chat_jid but no workspace_key.
 *
 * Rows whose started_in_directory equals the instance root (instanceCwd) or whose
 * started_in_directory does NOT contain '/users/' or '/groups/' are pre-isolation
 * shared sessions and are marked as 'ended' (must not be resumed).
 * All other rows get workspace_key derived from chat_jid via canonicalChatKey().
 */
export function backfillWorkspaceKeys(db: Database, instanceCwd: string): void {
  const resolvedCwd = resolve(instanceCwd.replace(/^~/, homedir()));
  const rows = db.raw
    .prepare(
      `SELECT id, chat_jid, started_in_directory FROM agent_sessions
       WHERE workspace_key IS NULL AND chat_jid IS NOT NULL`,
    )
    .all() as { id: number; chat_jid: string; started_in_directory: string | null }[];
  let ended = 0;
  let updated = 0;

  for (const row of rows) {
    const dir = row.started_in_directory ?? '';
    const isRootSession =
      dir === resolvedCwd ||
      (!dir.includes('/users/') && !dir.includes('/groups/'));

    if (isRootSession) {
      db.raw
        .prepare(`UPDATE agent_sessions SET status = 'ended' WHERE id = ?`)
        .run(row.id);
      ended += 1;
    } else {
      let key: string;
      try {
        key = toConversationKey(row.chat_jid);
      } catch {
        key = row.chat_jid;
      }
      db.raw
        .prepare(`UPDATE agent_sessions SET workspace_key = ? WHERE id = ?`)
        .run(key, row.id);
      updated += 1;
    }
  }

  log.info({ processed: rows.length, ended: ended, updated: updated }, 'backfilled workspace keys');
}

/** Mark a session as orphaned (process disappeared unexpectedly). */
export function markOrphaned(db: Database, id: number): void {
  updateSessionStatus(db, id, 'orphaned');
}

/**
 * Return the newest suspended or orphaned session for a given workspace key,
 * or null if none exists.
 */
export function getResumableSessionForChat(
  db: Database,
  workspaceKey: string,
): { id: number; session_id: string; chat_jid: string } | null {
  const row = db.raw
    .prepare(
      `SELECT id, session_id, chat_jid FROM agent_sessions
       WHERE workspace_key = ?
         AND status IN ('suspended', 'orphaned')
         AND session_id IS NOT NULL
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(workspaceKey) as
    | { id: number; session_id: string; chat_jid: string }
    | undefined;
  return row ?? null;
}
