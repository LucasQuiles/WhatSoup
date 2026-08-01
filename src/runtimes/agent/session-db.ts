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

/**
 * #1774 schema note — token column semantics, and a documented discontinuity:
 *
 * `total_input_tokens` used to accumulate each turn's FULL provider-reported
 * input (base + cache_creation + cache_read) — since cache_read_input_tokens
 * is essentially the entire prior context re-read every turn, that made the
 * column grow roughly O(turns²) and inflated it far beyond genuine
 * consumption (a single event was observed at 140M+ tokens on live fleet
 * data). As of migration to this column pair, `total_input_tokens`
 * accumulates ONLY the genuinely-new portion of each turn (base +
 * cache_creation); `total_cache_read_tokens` accumulates the cache-read
 * portion separately. Unlike the old conflated column, letting
 * total_cache_read_tokens grow with turn count is expected and correct — it
 * is honestly labeled as cumulative re-read volume, not "input consumed".
 *
 * Discontinuity: this is NOT backfilled. Rows written before this pair
 * existed keep their old (inflated, cache-read-inclusive) total_input_tokens
 * value with total_cache_read_tokens = 0 for that history — rewriting
 * historical totals from the coarser `agent_token_events` log is out of
 * scope for a live-fix migration. Any consumer comparing pre/post totals
 * must account for this before treating them as the same series.
 *
 * `last_compact_cache_read_tokens` is the compaction-baseline twin of
 * `last_compact_input_tokens` — both are snapshotted together in
 * markSessionCompacted() so a delta computed as
 * (total_input_tokens + total_cache_read_tokens) - (last_compact_input_tokens
 * + last_compact_cache_read_tokens) reproduces exactly what the old
 * undivided total_input_tokens delta would have been (see
 * maybeStartAutoCompact in runtime.ts, which deliberately reads the combined
 * value for this reason).
 */

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
    ['total_cache_read_tokens', 'INTEGER DEFAULT 0'],
    ['last_compact_cache_read_tokens', 'INTEGER DEFAULT 0'],
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
    `UPDATE agent_sessions
     SET provider = ?
     WHERE provider IS NULL AND session_id IS NULL`
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
export function getActiveSession(db: Database, provider: string): {
  id: number;
  session_id: string | null;
  claude_pid: number;
  status: string;
  chat_jid: string | null;
  workspace_key: string | null;
  started_at: string;
  last_message_at: string | null;
  message_count: number;
} | null {
  const row = db.raw
    .prepare(
      `SELECT candidate.id, candidate.session_id, candidate.claude_pid,
              candidate.status, candidate.chat_jid, candidate.workspace_key,
              candidate.started_at, candidate.last_message_at, candidate.message_count
       FROM agent_sessions AS candidate
       WHERE candidate.status IN ('active', 'suspended')
         AND candidate.session_id IS NOT NULL
         AND candidate.provider = ?
         AND NOT EXISTS (
           SELECT 1
           FROM completed_delivery_identity_admissions AS admission
           WHERE admission.target_kind = 'agent_session'
             AND admission.target_id = candidate.id
             AND admission.state = 'quarantined'
         )
         AND NOT EXISTS (
           SELECT 1
           FROM completed_delivery_identity_admissions AS admission
           JOIN session_checkpoints AS checkpoint
             ON checkpoint.id = admission.target_id
           WHERE admission.target_kind = 'checkpoint'
             AND admission.state = 'quarantined'
             AND checkpoint.session_id = candidate.session_id
             AND (
               candidate.workspace_key IS NULL
               OR checkpoint.conversation_key = candidate.workspace_key
             )
         )
         AND NOT EXISTS (
           SELECT 1
           FROM agent_sessions AS conflicting
           WHERE conflicting.session_id = candidate.session_id
             AND (conflicting.provider IS NULL OR conflicting.provider != ?)
         )
       ORDER BY candidate.id DESC
       LIMIT 1`,
    )
    .get(provider, provider) as
    | {
        id: number;
        session_id: string | null;
        claude_pid: number;
        status: string;
        chat_jid: string | null;
        workspace_key: string | null;
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

/**
 * Accumulate token usage for a session row (adds to existing totals).
 * `inputTokens` is the genuinely-new portion only (base + cache_creation) —
 * callers must have already subtracted cache_read via
 * stream-parser.ts's splitInputTokenUsage(). `cacheReadTokens` accumulates
 * separately; see the #1774 schema note above ensureAgentSchema.
 */
export function accumulateSessionTokens(
  db: Database,
  rowId: number,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
): void {
  db.raw
    .prepare(
      `UPDATE agent_sessions
       SET total_input_tokens = total_input_tokens + ?,
           total_output_tokens = total_output_tokens + ?,
           total_cache_read_tokens = total_cache_read_tokens + ?
       WHERE id = ?`,
    )
    .run(inputTokens, outputTokens, cacheReadTokens, rowId);
}

/**
 * Record a timestamped token usage event for granular metrics.
 * `inputTokens` here is the same genuinely-new-only value written to
 * total_input_tokens — this table does not carry a separate cache-read
 * column, so a consumer reading `agent_token_events.input_tokens` (e.g.
 * metrics-collector's agent_tokens_in baseline) now gets the corrected,
 * non-inflated figure as a natural consequence of the split.
 */
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
  cacheReadTokens: number,
): void {
  db.raw.exec('BEGIN IMMEDIATE');
  try {
    accumulateSessionTokens(db, rowId, inputTokens, outputTokens, cacheReadTokens);
    insertTokenEvent(db, rowId, inputTokens, outputTokens);
    db.raw.exec('COMMIT');
  } catch (err) {
    try { db.raw.exec('ROLLBACK'); } catch { /* best-effort rollback */ }
    log.error({ agentSessionId: rowId, inputTokens, outputTokens, cacheReadTokens, err }, 'token_event.write_fail');
    throw err;
  }
}

export interface SessionTokenSnapshot {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  lastCompactInputTokens: number;
  lastCompactOutputTokens: number;
  lastCompactCacheReadTokens: number;
}

/** Return token totals for compaction budgeting, or null when the row is gone. */
export function getSessionTokenSnapshot(db: Database, rowId: number): SessionTokenSnapshot | null {
  const row = db.raw
    .prepare(
      `SELECT total_input_tokens, total_output_tokens, total_cache_read_tokens,
              last_compact_input_tokens, last_compact_output_tokens,
              last_compact_cache_read_tokens
       FROM agent_sessions
       WHERE id = ?`,
    )
    .get(rowId) as
    | {
        total_input_tokens: number | null;
        total_output_tokens: number | null;
        total_cache_read_tokens: number | null;
        last_compact_input_tokens: number | null;
        last_compact_output_tokens: number | null;
        last_compact_cache_read_tokens: number | null;
      }
    | undefined;

  if (!row) return null;
  return {
    totalInputTokens: row.total_input_tokens ?? 0,
    totalOutputTokens: row.total_output_tokens ?? 0,
    totalCacheReadTokens: row.total_cache_read_tokens ?? 0,
    lastCompactInputTokens: row.last_compact_input_tokens ?? 0,
    lastCompactOutputTokens: row.last_compact_output_tokens ?? 0,
    lastCompactCacheReadTokens: row.last_compact_cache_read_tokens ?? 0,
  };
}

/**
 * Mark the current token totals as the baseline for future compaction
 * checks. Snapshots total_cache_read_tokens alongside total_input_tokens so
 * the combined (total_input_tokens + total_cache_read_tokens) delta
 * maybeStartAutoCompact reads reproduces the pre-split arithmetic exactly —
 * see the #1774 schema note above ensureAgentSchema.
 */
export function markSessionCompacted(db: Database, rowId: number): void {
  db.raw
    .prepare(
      `UPDATE agent_sessions
       SET last_compact_at = datetime('now'),
           last_compact_input_tokens = total_input_tokens,
           last_compact_output_tokens = total_output_tokens,
           last_compact_cache_read_tokens = total_cache_read_tokens
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

/** Update a resumed row only while its immutable provider/session identity still matches. */
export function updateResumedSessionStatus(
  db: Database,
  rowId: number,
  providerSessionId: string,
  provider: string,
  status: string,
): void {
  let result: { changes: number | bigint };
  if (TERMINAL_STATUSES.has(status)) {
    const endedAt = new Date().toISOString();
    result = db.raw.prepare(
      `UPDATE agent_sessions
       SET status = ?, ended_at = ?
       WHERE id = ? AND session_id = ? AND provider = ?`,
    ).run(status, endedAt, rowId, providerSessionId, provider);
    if (Number(result.changes) === 1) {
      log.info({ agentSessionId: rowId, status, endedAt }, 'session.ended');
    }
  } else if (status === 'active') {
    result = db.raw.prepare(
      `UPDATE agent_sessions
       SET status = ?, ended_at = NULL
       WHERE id = ? AND session_id = ? AND provider = ?`,
    ).run(status, rowId, providerSessionId, provider);
  } else {
    result = db.raw.prepare(
      `UPDATE agent_sessions
       SET status = ?
       WHERE id = ? AND session_id = ? AND provider = ?`,
    ).run(status, rowId, providerSessionId, provider);
  }
  if (Number(result.changes) !== 1) {
    throw new Error('Exact resumed agent session provider identity no longer matches');
  }
}

export type ResidentSessionRestoreResult = 'restored' | 'already_active' | 'refused';

/**
 * Repair an orphan tombstone only when the durable checkpoint still proves
 * that this exact resident provider session is authoritative.
 */
export function restoreOrphanedResidentSessionStatus(
  db: Database,
  rowId: number,
  providerSessionId: string,
  provider: string,
  residentPid?: number,
): ResidentSessionRestoreResult {
  const pidPredicate = residentPid === undefined
    ? ''
    : ' AND agent_sessions.claude_pid = ? AND cp.claude_pid = ?';
  const pidArgs = residentPid === undefined ? [] : [residentPid, residentPid];
  const result = db.raw.prepare(
    `UPDATE agent_sessions
     SET status = 'active', ended_at = NULL
     WHERE id = ?
       AND session_id = ?
       AND provider = ?
       AND status = 'orphaned'
       AND workspace_key IS NOT NULL
       AND EXISTS (
         SELECT 1
         FROM session_checkpoints AS cp
         WHERE cp.conversation_key = agent_sessions.workspace_key
           AND cp.session_status = 'active'
           AND cp.session_id = agent_sessions.session_id
           ${pidPredicate}
       )`,
  ).run(rowId, providerSessionId, provider, ...pidArgs) as { changes: number | bigint };
  if (Number(result.changes) === 1) return 'restored';

  const compatible = db.raw.prepare(
    `SELECT agent_sessions.status
     FROM agent_sessions
     JOIN session_checkpoints AS cp
       ON cp.conversation_key = agent_sessions.workspace_key
      AND cp.session_status = 'active'
      AND cp.session_id = agent_sessions.session_id
     WHERE agent_sessions.id = ?
       AND agent_sessions.session_id = ?
       AND agent_sessions.provider = ?
       ${pidPredicate}`,
  ).get(rowId, providerSessionId, provider, ...pidArgs) as { status: string } | undefined;
  return compatible?.status === 'active' ? 'already_active' : 'refused';
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
  provider: string,
): { id: number; session_id: string; chat_jid: string } | null {
  const row = db.raw
    .prepare(
      `SELECT candidate.id, candidate.session_id, candidate.chat_jid
       FROM agent_sessions AS candidate
       WHERE candidate.workspace_key = ?
         AND candidate.provider = ?
         AND candidate.status IN ('suspended', 'orphaned')
         AND candidate.session_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
           FROM completed_delivery_identity_admissions AS admission
           WHERE admission.target_kind = 'agent_session'
             AND admission.target_id = candidate.id
             AND admission.state = 'quarantined'
         )
         AND NOT EXISTS (
           SELECT 1
           FROM completed_delivery_identity_admissions AS admission
           JOIN session_checkpoints AS checkpoint
             ON checkpoint.id = admission.target_id
           WHERE admission.target_kind = 'checkpoint'
             AND admission.state = 'quarantined'
             AND checkpoint.conversation_key = candidate.workspace_key
             AND checkpoint.session_id = candidate.session_id
         )
         AND NOT EXISTS (
           SELECT 1
           FROM agent_sessions AS conflicting
           WHERE conflicting.session_id = candidate.session_id
             AND (conflicting.provider IS NULL OR conflicting.provider != ?)
         )
       ORDER BY candidate.id DESC
       LIMIT 1`,
    )
    .get(workspaceKey, provider, provider) as
    | { id: number; session_id: string; chat_jid: string }
    | undefined;
  return row ?? null;
}

export interface ResolveResumableAgentSessionInput {
  provider: string;
  providerSessionId: string;
  agentSessionRowId?: number;
  workspaceKey?: string;
}

export interface ResolvedResumableAgentSession {
  id: number;
  provider: string;
  workspace_key: string | null;
}

/**
 * Resolve the immutable persisted identity for a resume before any provider I/O.
 * Checkpoints deliberately have no provider column, so an opaque session ID
 * present in another (or unknown) provider namespace is never resumable.
 */
export function resolveResumableAgentSession(
  db: Database,
  input: ResolveResumableAgentSessionInput,
): ResolvedResumableAgentSession {
  if (input.provider.length === 0) {
    throw new Error('Resume provider must not be empty');
  }
  if (input.providerSessionId.length === 0) {
    throw new Error('Provider session ID must not be empty');
  }
  if (
    input.agentSessionRowId !== undefined
    && (!Number.isSafeInteger(input.agentSessionRowId) || input.agentSessionRowId <= 0)
  ) {
    throw new RangeError('Agent session row ID must be a positive safe integer');
  }
  if (input.workspaceKey !== undefined && input.workspaceKey.length === 0) {
    throw new Error('Resume conversation identity must not be empty');
  }

  const namespaces = db.raw.prepare(
    `SELECT DISTINCT provider
     FROM agent_sessions
     WHERE session_id = ?`,
  ).all(input.providerSessionId) as Array<{ provider: string | null }>;
  if (namespaces.length === 0) {
    throw new Error('No persisted agent session matches the resume identity');
  }
  if (
    namespaces.length !== 1
    || namespaces[0]!.provider === null
    || namespaces[0]!.provider !== input.provider
  ) {
    throw new Error('Provider session ownership is foreign, unknown, or ambiguous');
  }

  const rowPredicates = [
    `session_id = ?`,
    `provider = ?`,
    `status IN ('active', 'suspended', 'orphaned', 'crashed')`,
    `NOT EXISTS (
      SELECT 1
      FROM completed_delivery_identity_admissions AS admission
      WHERE admission.target_kind = 'agent_session'
        AND admission.target_id = agent_sessions.id
        AND admission.state = 'quarantined'
    )`,
  ];
  const rowBindings: Array<string | number> = [input.providerSessionId, input.provider];
  if (input.agentSessionRowId !== undefined) {
    rowPredicates.push('id = ?');
    rowBindings.push(input.agentSessionRowId);
  }
  if (input.workspaceKey !== undefined) {
    rowPredicates.push('workspace_key = ?');
    rowBindings.push(input.workspaceKey);
  }

  const rows = db.raw.prepare(
    `SELECT id, provider, workspace_key
     FROM agent_sessions
     WHERE ${rowPredicates.join('\n       AND ')}
     ORDER BY id`,
  ).all(...rowBindings) as unknown as ResolvedResumableAgentSession[];
  if (rows.length !== 1) {
    throw new Error(
      `Expected exactly one resumable agent row for the provider and conversation, found ${rows.length}`,
    );
  }

  const row = rows[0]!;
  const conversationKey = input.workspaceKey ?? row.workspace_key;
  if (conversationKey === null || conversationKey.length === 0) {
    throw new Error('Resumable agent row has no conversation provenance');
  }
  const checkpoint = db.raw.prepare(
    `SELECT id
     FROM session_checkpoints
     WHERE conversation_key = ?
       AND session_id = ?
       AND session_status IN ('active', 'suspended', 'orphaned')
       AND NOT EXISTS (
         SELECT 1
         FROM completed_delivery_identity_admissions AS admission
         WHERE admission.target_kind = 'checkpoint'
           AND admission.target_id = session_checkpoints.id
           AND admission.state = 'quarantined'
       )`,
  ).get(conversationKey, input.providerSessionId) as { id: number } | undefined;
  if (checkpoint === undefined) {
    throw new Error('No resumable checkpoint matches the provider session and conversation');
  }

  return row;
}
