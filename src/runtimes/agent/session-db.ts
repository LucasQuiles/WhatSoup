import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { Database } from '../../core/database.ts';
import { canonicalChatKey } from '../../core/workspace.ts';
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
): number {
  const result = db.raw
    .prepare(
      `INSERT INTO agent_sessions (claude_pid, started_in_directory, chat_jid, workspace_key, started_at, status)
       VALUES (?, ?, ?, ?, datetime('now'), 'active')`,
    )
    .run(pid, cwd, chatJid ?? null, workspaceKey ?? null) as { lastInsertRowid: number | bigint };
  return Number(result.lastInsertRowid);
}

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

/** Set the Claude session_id on an existing session row. */
export function updateSessionId(db: Database, rowId: number, sessionId: string): void {
  log.info({ rowId }, 'session: id-assigned');
  db.raw
    .prepare(`UPDATE agent_sessions SET session_id = ? WHERE id = ?`)
    .run(sessionId, rowId);
}

/** Stamp last_message_at to now on an existing session row. */
export function updateLastMessage(db: Database, rowId: number): void {
  db.raw
    .prepare(`UPDATE agent_sessions SET last_message_at = datetime('now') WHERE id = ?`)
    .run(rowId);
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

/** Update the status of an existing session row to any arbitrary status string. */
export function updateSessionStatus(db: Database, rowId: number, status: string): void {
  db.raw.prepare('UPDATE agent_sessions SET status = ? WHERE id = ?').run(status, rowId);
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

  for (const row of rows) {
    const dir = row.started_in_directory ?? '';
    const isRootSession =
      dir === resolvedCwd ||
      (!dir.includes('/users/') && !dir.includes('/groups/'));

    if (isRootSession) {
      db.raw
        .prepare(`UPDATE agent_sessions SET status = 'ended' WHERE id = ?`)
        .run(row.id);
    } else {
      const key = canonicalChatKey(row.chat_jid);
      db.raw
        .prepare(`UPDATE agent_sessions SET workspace_key = ? WHERE id = ?`)
        .run(key, row.id);
    }
  }
}

/** Mark a session as orphaned (process disappeared unexpectedly). */
export function markOrphaned(db: Database, id: number): void {
  log.info({ id }, 'session: orphaned');
  db.raw.prepare(`UPDATE agent_sessions SET status = 'orphaned' WHERE id = ?`).run(id);
}

/**
 * Return all active sessions for orphan-sweep checking.
 * The runtime should verify each PID is still alive and call markOrphaned() if not.
 */
export function sweepOrphanedSessions(db: Database): { id: number; claude_pid: number }[] {
  return db.raw
    .prepare(
      `SELECT id, claude_pid FROM agent_sessions WHERE status = 'active'`,
    )
    .all() as { id: number; claude_pid: number }[];
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
