import { DatabaseSync } from 'node:sqlite';
import { createChildLogger } from '../logger.ts';
import { isGroupConversationKey } from '../core/conversation-key.ts';

const log = createChildLogger('fleet:db-reader');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatSummary {
  conversationKey: string;
  senderName: string | null;
  messageCount: number;
  lastMessageAt: number | null;
  isGroup: boolean;
  lastMessagePreview: string | null;
  lastMessageSender: string | null;
}

/** Full message row — includes raw_message for chat view. */
export interface MessageRow {
  pk: number;
  conversation_key: string;
  chat_jid: string;
  sender_jid: string;
  sender_name: string | null;
  message_id: string | null;
  content: string | null;
  content_type: string;
  timestamp: number;
  is_from_me: number;
  raw_message: string | null;
}

/** Feed-path message row — raw_message intentionally excluded. */
type FeedMessageRow = Omit<MessageRow, 'raw_message'>;

export interface AccessEntry {
  subjectType: string;
  subjectId: string;
  status: string;
  displayName: string | null;
  requestedAt: string | null;
  decidedAt: string | null;
}

export interface DbStats {
  messageCount: number;
  chatCount: number;
  pendingAccess: number;
}

export type DbResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** SQLite `datetime('now')` emits 'YYYY-MM-DD HH:MM:SS' (UTC, no marker).
 *  Normalize to ISO-8601 UTC so browser `new Date()` parsing is unambiguous. */
function sqliteUtcToIso(value: string): string {
  return `${value.replace(' ', 'T')}Z`;
}

/** Row shape for the checkpoint browser surface (GET /api/lines/:name/checkpoints). */
export interface CheckpointRow {
  conversationKey: string;
  sessionId: string | null;
  sessionStatus: string;
  checkpointVersion: number;
  claudePid: number | null;
  workspacePath: string | null;
  createdAt: string;
  updatedAt: string;
  completedScope: string | null;
  completedDeliveryJid: string | null;
  completedLogicalTurnId: string | null;
  /** Engine's exact resumable filter (src/core/durability.ts:501-506):
   *  session_status IN ('active','suspended') AND session_id IS NOT NULL. */
  resumable: boolean;
}

/** Fraction of the configured limit at which a sender counts as "near
 *  limit" (amber band below the throttled bucket). */
export const NEAR_LIMIT_RATIO = 0.8;

/** Windowed throttle aggregate for one instance (see getRateLimits). */
export interface RateLimitsData {
  /** False when the rate_limits table is absent (legacy DBs). */
  supported: boolean;
  /** Senders whose windowed response count meets/exceeds the limit. */
  throttled: number;
  /** Senders at ≥ NEAR_LIMIT_RATIO of the limit but under it. */
  nearLimit: number;
  /** Top 5 senders by windowed count. */
  topSenders: Array<{ senderJid: string; count: number }>;
  windowedResponses: number;
  windowedAttempts: number;
  /** max(0, attempts − responses) — retry/token-storm waste (#1864 class). */
  excessAttempts: number;
}

/** One question inside a pending poll (AskUserQuestion). */
export interface PendingQuestion {
  question: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

/** A pending decision the runtime is waiting on (D-4 approval queue). */
export interface PendingPollEntry {
  mapKey: string;
  chatJid: string;
  mode: 'poll' | 'textFallback';
  source: 'askuser' | 'send_poll';
  questions: PendingQuestion[];
  currentQuestionIndex: number;
  answersCollected: Record<number, string>;
  createdAt: number;
  timeoutMs: number;
  hardClosesAt: number | null;
}

/** The pending-polls read result (see getPendingPolls). */
export interface PendingPollsData {
  /** False when the pending_polls table is absent (legacy DBs). */
  supported: boolean;
  pending: PendingPollEntry[];
  /** Rows whose payload JSON failed to parse — fail-visible, never silently
   *  treated as valid or as absent. */
  parseErrors: number;
}

const READ_ONLY_DATABASE_OPTIONS: ConstructorParameters<typeof DatabaseSync>[1] = {
  readOnly: true,
};

// ---------------------------------------------------------------------------
// FTS query safety
// ---------------------------------------------------------------------------

export function buildSafeFtsMatchQuery(query: string): string {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    throw new Error('Invalid FTS MATCH query: query must not be empty');
  }

  for (const token of tokens) {
    if (/["\u0000-\u001f\u007f]/u.test(token)) {
      throw new Error('Invalid FTS MATCH query: unsafe characters are not allowed');
    }
  }

  return tokens.map((token) => `"${token}"`).join(' AND ');
}

// ---------------------------------------------------------------------------
// FleetDbReader
// ---------------------------------------------------------------------------

export class FleetDbReader {
  private selfName: string;
  private selfDb: DatabaseSync;

  constructor(selfName: string, selfDb: DatabaseSync) {
    this.selfName = selfName;
    this.selfDb = selfDb;
  }

  /**
   * Open a readonly connection, run the query callback, then close immediately.
   * For the self-instance, reuses the already-open selfDb handle instead.
   */
  query<T>(instanceName: string, dbPath: string, fn: (db: DatabaseSync) => T): DbResult<T> {
    if (instanceName === this.selfName) {
      try {
        return { ok: true, data: fn(this.selfDb) };
      } catch (err) {
        const msg = (err as Error).message;
        log.warn({ instance: instanceName, error: msg }, 'self-db query failed');
        return { ok: false, error: msg };
      }
    }

    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(dbPath, READ_ONLY_DATABASE_OPTIONS);
      const result = fn(db);
      return { ok: true, data: result };
    } catch (err) {
      const msg = (err as Error).message;
      log.warn({ instance: instanceName, dbPath, error: msg }, 'remote db query failed');
      return { ok: false, error: msg };
    } finally {
      try { db?.close(); } catch { /* already closed or never opened */ }
    }
  }

  /**
   * Open a writable connection, run the callback, then close.
   * For self-instance, reuses the already-open handle.
   * Use sparingly — only for cross-instance sync operations (e.g. LID mapping sync).
   */
  queryWrite<T>(instanceName: string, dbPath: string, fn: (db: DatabaseSync) => T): DbResult<T> {
    if (instanceName === this.selfName) {
      try {
        return { ok: true, data: fn(this.selfDb) };
      } catch (err) {
        const msg = (err as Error).message;
        log.warn({ instance: instanceName, error: msg }, 'self-db write query failed');
        return { ok: false, error: msg };
      }
    }

    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(dbPath);
      // busy_timeout for safe concurrent access — WAL mode is already set by the
      // running instance at startup (database.ts), we just need patience for locks.
      db.prepare('PRAGMA busy_timeout = 5000').run();
      const result = fn(db);
      return { ok: true, data: result };
    } catch (err) {
      const msg = (err as Error).message;
      log.warn({ instance: instanceName, dbPath, error: msg }, 'remote db write query failed');
      return { ok: false, error: msg };
    } finally {
      try { db?.close(); } catch { /* already closed or never opened */ }
    }
  }

  /** Get chat list grouped by conversation_key, ordered by last message time. */
  getChats(name: string, dbPath: string, opts: { limit: number; offset: number }): DbResult<ChatSummary[]> {
    return this.query(name, dbPath, (db) => {
      const rows = db.prepare(`
        SELECT
          m.conversation_key,
          m.sender_name,
          COUNT(*) as message_count,
          MAX(m.timestamp) as last_message_at
        FROM messages m
        WHERE m.deleted_at IS NULL
          AND length(m.conversation_key) >= 5
        GROUP BY m.conversation_key
        ORDER BY last_message_at DESC
        LIMIT ? OFFSET ?
      `).all(opts.limit, opts.offset) as any[];

      return rows.map((r) => ({
        conversationKey: r.conversation_key,
        senderName: r.sender_name,
        messageCount: r.message_count,
        lastMessageAt: r.last_message_at,
        isGroup: isGroupConversationKey(r.conversation_key),
        lastMessagePreview: null,
        lastMessageSender: null,
      }));
    });
  }

  /** List session_checkpoints for the checkpoint browser tab — newest first,
   *  capped at 500. Read-only; the `resumable` flag mirrors the durability
   *  engine's exact startup-resume filter so the console never invents its
   *  own definition of what would resume on restart. */
  getCheckpoints(name: string, dbPath: string): DbResult<CheckpointRow[]> {
    return this.query(name, dbPath, (db) => {
      const rows = db.prepare(`
        SELECT
          conversation_key, session_id, session_status, checkpoint_version,
          claude_pid, workspace_path, created_at, updated_at,
          completed_scope, completed_delivery_jid, completed_logical_turn_id,
          CASE WHEN session_status IN ('active','suspended') AND session_id IS NOT NULL
               THEN 1 ELSE 0 END AS resumable
        FROM session_checkpoints
        ORDER BY updated_at DESC
        LIMIT 500
      `).all() as Array<Record<string, unknown>>;

      return rows.map((r) => ({
        conversationKey: String(r.conversation_key),
        sessionId: r.session_id === null ? null : String(r.session_id),
        sessionStatus: String(r.session_status),
        checkpointVersion: Number(r.checkpoint_version),
        claudePid: r.claude_pid === null ? null : Number(r.claude_pid),
        workspacePath: r.workspace_path === null ? null : String(r.workspace_path),
        createdAt: sqliteUtcToIso(String(r.created_at)),
        updatedAt: sqliteUtcToIso(String(r.updated_at)),
        completedScope: r.completed_scope === null ? null : String(r.completed_scope),
        completedDeliveryJid: r.completed_delivery_jid === null ? null : String(r.completed_delivery_jid),
        completedLogicalTurnId: r.completed_logical_turn_id === null ? null : String(r.completed_logical_turn_id),
        resumable: r.resumable === 1,
      }));
    });
  }

  /** Get messages for a conversation with cursor-based pagination (before pk). */
  getMessages(
    name: string,
    dbPath: string,
    opts: { conversationKey: string; beforePk?: number; limit: number },
  ): DbResult<MessageRow[]> {
    return this.query(name, dbPath, (db) => {
      const wherePk = opts.beforePk != null ? 'AND m.pk < ?' : '';
      const params: any[] = [opts.conversationKey];
      if (opts.beforePk != null) params.push(opts.beforePk);
      params.push(opts.limit);

      return db.prepare(`
        SELECT pk, conversation_key, chat_jid, sender_jid, sender_name,
               message_id, content, content_type, timestamp, is_from_me, raw_message
        FROM messages m
        WHERE m.conversation_key = ? AND m.deleted_at IS NULL ${wherePk}
          AND m.pk = (
            SELECT MIN(m2.pk) FROM messages m2
            WHERE m2.conversation_key = m.conversation_key
              AND m2.content IS m.content
              AND m2.timestamp = m.timestamp
              AND m2.is_from_me = m.is_from_me
              AND m2.deleted_at IS NULL
          )
        ORDER BY m.pk DESC
        LIMIT ?
      `).all(...params) as unknown as MessageRow[];
    });
  }

  /** Get access list entries, newest first. */
  getAccessList(name: string, dbPath: string): DbResult<AccessEntry[]> {
    return this.query(name, dbPath, (db) => {
      const rows = db.prepare(`
        SELECT subject_type, subject_id, status, display_name, requested_at, decided_at
        FROM access_list
        ORDER BY requested_at DESC
      `).all() as any[];

      return rows.map((r) => ({
        subjectType: r.subject_type,
        subjectId: r.subject_id,
        status: r.status,
        displayName: r.display_name,
        requestedAt: r.requested_at,
        decidedAt: r.decided_at,
      }));
    });
  }

  /**
   * Pending decision queue (D-4 approval queue): rows of `pending_polls`
   * with the serialized PendingPollQuestion payload deserialized
   * server-side. Read-only — resolution flows through the instance's
   * health endpoint (never a fleet-side row write behind the runtime's
   * back). Unparseable payloads are skipped and counted (fail-visible).
   */
  getPendingPolls(name: string, dbPath: string): DbResult<PendingPollsData> {
    return this.query(name, dbPath, (db) => {
      const tables = new Set(
        (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
          .map((r) => r.name),
      );
      if (!tables.has('pending_polls')) {
        return { supported: false, pending: [], parseErrors: 0 };
      }
      const rows = db.prepare(`
        SELECT map_key, chat_jid, payload, hard_closes_at
        FROM pending_polls
        ORDER BY rowid ASC
        LIMIT 200
      `).all() as Array<{ map_key: string; chat_jid: string; payload: string; hard_closes_at: number | null }>;

      const pending: PendingPollEntry[] = [];
      let parseErrors = 0;
      for (const row of rows) {
        try {
          const p = JSON.parse(row.payload) as Record<string, unknown>;
          const questions = (p.questions as Array<Record<string, unknown>>).map((q) => ({
            question: String(q.question ?? ''),
            options: ((q.options as Array<Record<string, unknown>>) ?? []).map((o) => ({
              label: String(o.label ?? ''),
              description: String(o.description ?? ''),
            })),
            multiSelect: Boolean(q.multiSelect),
          }));
          pending.push({
            mapKey: row.map_key,
            chatJid: String(p.chatJid ?? row.chat_jid),
            mode: p.mode === 'textFallback' ? 'textFallback' : 'poll',
            source: p.source === 'send_poll' ? 'send_poll' : 'askuser',
            questions,
            currentQuestionIndex: Number(p.currentQuestionIndex ?? 0),
            answersCollected: (p.answersCollected ?? {}) as Record<number, string>,
            createdAt: Number(p.createdAt ?? 0),
            timeoutMs: Number(p.timeoutMs ?? 0),
            hardClosesAt: row.hard_closes_at,
          });
        } catch {
          parseErrors += 1;
        }
      }
      return { supported: true, pending, parseErrors };
    });
  }

  /** Full-text search within an instance's messages using FTS5. */
  searchMessages(
    name: string,
    dbPath: string,
    opts: { query: string; conversationKey?: string; limit: number },
  ): DbResult<MessageRow[]> {
    return this.query(name, dbPath, (db) => {
      const matchQuery = buildSafeFtsMatchQuery(opts.query);

      if (opts.conversationKey) {
        return db.prepare(`
          SELECT m.pk, m.conversation_key, m.chat_jid, m.sender_jid, m.sender_name,
                 m.message_id, m.content, m.content_type, m.timestamp, m.is_from_me, m.raw_message
          FROM messages_fts fts
          JOIN messages m ON m.pk = fts.rowid
          WHERE messages_fts MATCH ?
            AND m.deleted_at IS NULL
            AND m.conversation_key = ?
          ORDER BY m.timestamp DESC
          LIMIT ?
        `).all(matchQuery, opts.conversationKey, opts.limit) as unknown as MessageRow[];
      }
      return db.prepare(`
        SELECT m.pk, m.conversation_key, m.chat_jid, m.sender_jid, m.sender_name,
               m.message_id, m.content, m.content_type, m.timestamp, m.is_from_me, m.raw_message
        FROM messages_fts fts
        JOIN messages m ON m.pk = fts.rowid
        WHERE messages_fts MATCH ?
          AND m.deleted_at IS NULL
        ORDER BY m.timestamp DESC
        LIMIT ?
      `).all(matchQuery, opts.limit) as unknown as MessageRow[];
    });
  }

  /** Fetch hourly metrics for an instance within a time range. */
  getMetrics(
    name: string,
    dbPath: string,
    opts: { range: '24h' | '7d' | '30d' },
  ): DbResult<{
    messageVolume: { bucket: string; inbound: number; outbound: number; media: number }[];
    tokenUsage: { bucket: string; input: number; output: number }[];
    sessionActivity: { bucket: string; active: number; started: number }[];
    activeHours: number[][];
    activeHoursByDate: { date: string; hours: number[] }[];
    hasMessageData: boolean;
    hasTokenData: boolean;
    hasSessionData: boolean;
    tokenUsageByProvider: Record<string, { bucket: string; input: number; output: number }[]>;
    sessionActivityByProvider: Record<string, { bucket: string; active: number; started: number }[]>;
    providers: string[];
  }> {
    const rangeHours = opts.range === '24h' ? 24 : opts.range === '7d' ? 168 : 720;
    const cutoff = new Date(Date.now() - rangeHours * 60 * 60 * 1000).toISOString();

    return this.query(name, dbPath, (db) => {
      // Read all 9 metrics from metrics_hourly
      const allRows = db.prepare(`
        SELECT bucket, metric, value FROM metrics_hourly
        WHERE bucket >= ? AND metric IN (
          'messages_in', 'messages_out', 'messages_media',
          'agent_tokens_in', 'agent_tokens_out', 'chat_tokens_in', 'chat_tokens_out',
          'sessions_started', 'sessions_active'
        )
        ORDER BY bucket ASC
      `).all(cutoff) as { bucket: string; metric: string; value: number }[];

      // Build a map of bucket -> metric -> value
      const dataMap = new Map<string, Map<string, number>>();
      for (const row of allRows) {
        let metrics = dataMap.get(row.bucket);
        if (!metrics) {
          metrics = new Map();
          dataMap.set(row.bucket, metrics);
        }
        metrics.set(row.metric, row.value);
      }

      // Generate full bucket sequence (densification)
      const nowHour = new Date(Date.now());
      nowHour.setUTCMinutes(0, 0, 0);
      const bucketSequence: string[] = [];
      for (let i = rangeHours - 1; i >= 0; i--) {
        const t = new Date(nowHour.getTime() - i * 60 * 60 * 1000);
        bucketSequence.push(t.toISOString());
      }

      // Helper to read a metric from the map
      const getVal = (bucket: string, metric: string): number => {
        return dataMap.get(bucket)?.get(metric) ?? 0;
      };

      // Densify into arrays
      let hasMessageData = false;
      let hasTokenData = false;
      let hasSessionData = false;

      const messageVolume = bucketSequence.map(bucket => {
        const inbound = getVal(bucket, 'messages_in');
        const outbound = getVal(bucket, 'messages_out');
        const media = getVal(bucket, 'messages_media');
        if (inbound > 0 || outbound > 0 || media > 0) hasMessageData = true;
        return { bucket, inbound, outbound, media };
      });

      const tokenUsage = bucketSequence.map(bucket => {
        const input = getVal(bucket, 'agent_tokens_in') + getVal(bucket, 'chat_tokens_in');
        const output = getVal(bucket, 'agent_tokens_out') + getVal(bucket, 'chat_tokens_out');
        if (input > 0 || output > 0) hasTokenData = true;
        return { bucket, input, output };
      });

      const sessionActivity = bucketSequence.map(bucket => {
        const active = getVal(bucket, 'sessions_active');
        const started = getVal(bucket, 'sessions_started');
        if (active > 0 || started > 0) hasSessionData = true;
        return { bucket, active, started };
      });

      // Active hours heatmap from raw messages
      const cutoffUnix = Math.floor(new Date(cutoff).getTime() / 1000);

      // 7×24 dow grid (skip for 30d — per-date view replaces it)
      let activeHours: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
      if (opts.range !== '30d') {
        const heatmapRows = db.prepare(`
          SELECT
            CAST(strftime('%w', timestamp, 'unixepoch') AS INTEGER) AS dow,
            CAST(strftime('%H', timestamp, 'unixepoch') AS INTEGER) AS hour,
            COUNT(*) AS cnt
          FROM messages
          WHERE timestamp >= ? AND deleted_at IS NULL
          GROUP BY dow, hour
        `).all(cutoffUnix) as { dow: number; hour: number; cnt: number }[];

        for (const row of heatmapRows) {
          activeHours[row.dow][row.hour] = row.cnt;
        }
      }

      // Per-date heatmap for 30d range
      let activeHoursByDate: { date: string; hours: number[] }[] = [];
      if (opts.range === '30d') {
        const dateHeatmapRows = db.prepare(`
          SELECT
            date(timestamp, 'unixepoch') AS dt,
            CAST(strftime('%H', timestamp, 'unixepoch') AS INTEGER) AS hour,
            COUNT(*) AS cnt
          FROM messages
          WHERE timestamp >= ? AND deleted_at IS NULL
          GROUP BY dt, hour
          ORDER BY dt ASC
        `).all(cutoffUnix) as { dt: string; hour: number; cnt: number }[];

        const dateMap = new Map<string, number[]>();
        for (const row of dateHeatmapRows) {
          let hours = dateMap.get(row.dt);
          if (!hours) { hours = new Array(24).fill(0); dateMap.set(row.dt, hours); }
          hours[row.hour] = row.cnt;
        }
        for (const date of [...dateMap.keys()].sort()) {
          activeHoursByDate.push({ date, hours: dateMap.get(date)! });
        }
      }

      // Query per-provider suffixed metrics (e.g. agent_tokens_in:claude-cli)
      const providerRows = db.prepare(`
        SELECT bucket, metric, value FROM metrics_hourly
        WHERE bucket >= ? AND metric LIKE '%:%'
        ORDER BY bucket ASC
      `).all(cutoff) as { bucket: string; metric: string; value: number }[];

      const providerTokenMap = new Map<string, Map<string, { input: number; output: number }>>();
      const providerSessionMap = new Map<string, Map<string, { started: number; active: number }>>();
      const providerSet = new Set<string>();

      for (const row of providerRows) {
        const colonIdx = row.metric.indexOf(':');
        if (colonIdx === -1) continue;
        const base = row.metric.slice(0, colonIdx);
        const provider = row.metric.slice(colonIdx + 1);
        providerSet.add(provider);

        if (base === 'agent_tokens_in' || base === 'agent_tokens_out') {
          if (!providerTokenMap.has(provider)) providerTokenMap.set(provider, new Map());
          const bucketMap = providerTokenMap.get(provider)!;
          const existing = bucketMap.get(row.bucket) ?? { input: 0, output: 0 };
          if (base === 'agent_tokens_in') existing.input = row.value;
          else existing.output = row.value;
          bucketMap.set(row.bucket, existing);
        } else if (base === 'sessions_started' || base === 'sessions_active') {
          if (!providerSessionMap.has(provider)) providerSessionMap.set(provider, new Map());
          const bucketMap = providerSessionMap.get(provider)!;
          const existing = bucketMap.get(row.bucket) ?? { started: 0, active: 0 };
          if (base === 'sessions_started') existing.started = row.value;
          else existing.active = row.value;
          bucketMap.set(row.bucket, existing);
        }
      }

      const tokenUsageByProvider: Record<string, { bucket: string; input: number; output: number }[]> = {};
      for (const [provider, bucketMap] of providerTokenMap) {
        tokenUsageByProvider[provider] = bucketSequence.map(bucket => {
          const vals = bucketMap.get(bucket);
          return { bucket, input: vals?.input ?? 0, output: vals?.output ?? 0 };
        });
      }

      const sessionActivityByProvider: Record<string, { bucket: string; active: number; started: number }[]> = {};
      for (const [provider, bucketMap] of providerSessionMap) {
        sessionActivityByProvider[provider] = bucketSequence.map(bucket => {
          const vals = bucketMap.get(bucket);
          return { bucket, active: vals?.active ?? 0, started: vals?.started ?? 0 };
        });
      }

      const providers = Array.from(providerSet).sort();

      return { messageVolume, tokenUsage, sessionActivity, activeHours, activeHoursByDate, hasMessageData, hasTokenData, hasSessionData, tokenUsageByProvider, sessionActivityByProvider, providers };
    });
  }

  /** Lightweight markers for realtime snapshot-diff (O(1) indexed queries). */
  getLatestMarkers(
    name: string,
    dbPath: string,
  ): DbResult<{ latestMessagePk: number | null; latestMessageMarker: string | null; latestAccessMarker: string | null }> {
    return this.query(name, dbPath, (db) => {
      const columns = db.prepare("PRAGMA table_info('messages')").all() as Array<{ name: string }>;
      const hasUpdatedAt = columns.some((column) => column.name === 'updated_at');
      const msgRow = db.prepare(
        hasUpdatedAt
          ? 'SELECT MAX(pk) AS pk, MAX(updated_at) AS updatedAt FROM messages'
          : 'SELECT MAX(pk) AS pk, NULL AS updatedAt FROM messages',
      ).get() as { pk: number | null; updatedAt: string | null } | undefined;

      const accessRow = db.prepare(
        'SELECT MAX(COALESCE(decided_at, requested_at)) AS marker FROM access_list',
      ).get() as { marker: string | null } | undefined;

      const latestMessagePk = msgRow?.pk ?? null;
      const latestMessageUpdatedAt = msgRow?.updatedAt ?? null;

      return {
        latestMessagePk,
        latestMessageMarker: latestMessagePk == null
          ? null
          : `${latestMessagePk}:${latestMessageUpdatedAt ?? ''}`,
        latestAccessMarker: accessRow?.marker ?? null,
      };
    });
  }

  /** Fetch messages by a set of message_ids (for feed preview enrichment). */
  getMessagesByIds(name: string, dbPath: string, messageIds: string[]): DbResult<FeedMessageRow[]> {
    if (messageIds.length === 0) return { ok: true, data: [] };
    return this.query(name, dbPath, (db) => {
      const placeholders = messageIds.map(() => '?').join(', ');
      return db.prepare(`
        SELECT pk, conversation_key, chat_jid, sender_jid, sender_name,
               message_id, content, content_type, timestamp, is_from_me
        FROM messages
        WHERE message_id IN (${placeholders})
          AND deleted_at IS NULL
      `).all(...messageIds) as unknown as FeedMessageRow[];
    });
  }

  /** Fetch recent messages by conversation + direction + time window (fallback for missing messageId). */
  getRecentMessagesByChat(
    name: string,
    dbPath: string,
    conversationKey: string,
    direction: 'inbound' | 'outbound',
    aroundTimestamp: number,
    limit = 3,
  ): DbResult<FeedMessageRow[]> {
    const isFromMe = direction === 'outbound' ? 1 : 0;
    const windowSec = 5;
    return this.query(name, dbPath, (db) => {
      return db.prepare(`
        SELECT pk, conversation_key, chat_jid, sender_jid, sender_name,
               message_id, content, content_type, timestamp, is_from_me
        FROM messages
        WHERE conversation_key = ? AND is_from_me = ? AND deleted_at IS NULL
          AND timestamp BETWEEN ? AND ?
        ORDER BY ABS(timestamp - ?) ASC
        LIMIT ?
      `).all(
        conversationKey, isFromMe,
        aroundTimestamp - windowSec, aroundTimestamp + windowSec,
        aroundTimestamp, limit,
      ) as unknown as FeedMessageRow[];
    });
  }

  /** Get summary stats for an instance database. */
  getSummaryStats(name: string, dbPath: string): DbResult<DbStats> {
    return this.query(name, dbPath, (db) => {
      const msgCount =
        (db.prepare('SELECT COUNT(*) as c FROM messages WHERE deleted_at IS NULL').get() as any)
          ?.c ?? 0;
      const chatCount =
        (db.prepare(
          'SELECT COUNT(DISTINCT conversation_key) as c FROM messages WHERE deleted_at IS NULL',
        ).get() as any)?.c ?? 0;

      // access_list may not exist in older schemas
      let pendingAccess = 0;
      try {
        pendingAccess =
          (db.prepare(
            "SELECT COUNT(*) as c FROM access_list WHERE status = 'pending'",
          ).get() as any)?.c ?? 0;
      } catch {
        /* table doesn't exist */
      }

      return { messageCount: msgCount, chatCount: chatCount, pendingAccess };
    });
  }

  /**
   * Windowed per-sender throttle aggregate (D-5; the `rate_limits` table
   * is per-SENDER chat throttling — successful responses — and
   * `llm_attempts` every LLM invocation, audit 1065). `limit`/`windowMs`
   * are supplied by the caller (the fleet resolves them from the
   * instance's config.json; env overrides are fleet-invisible).
   * `excessAttempts` (attempts − responses, floored 0) is the
   * retry/token-storm signal (#1864 class).
   * `supported:false` (zeroed, NOT an error) when the tables are absent.
   */
  getRateLimits(
    name: string,
    dbPath: string,
    opts: { limit: number; windowMs: number },
  ): DbResult<RateLimitsData> {
    return this.query(name, dbPath, (db) => {
      const tables = new Set(
        (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
          .map((r) => r.name),
      );
      const zero: RateLimitsData = {
        supported: false,
        throttled: 0,
        nearLimit: 0,
        topSenders: [],
        windowedResponses: 0,
        windowedAttempts: 0,
        excessAttempts: 0,
      };
      if (!tables.has('rate_limits')) return zero;

      const windowSec = Math.floor(opts.windowMs / 1000);
      const offset = `-${windowSec} seconds`;
      const perSender = db.prepare(`
        SELECT sender_jid, COUNT(*) AS cnt
        FROM rate_limits
        WHERE response_at >= datetime('now', ?)
        GROUP BY sender_jid
        ORDER BY cnt DESC, sender_jid ASC
      `).all(offset) as Array<{ sender_jid: string; cnt: number }>;

      const nearFloor = Math.max(1, Math.floor(opts.limit * NEAR_LIMIT_RATIO));
      let throttled = 0;
      let nearLimit = 0;
      for (const row of perSender) {
        if (row.cnt >= opts.limit) throttled += 1;
        else if (row.cnt >= nearFloor) nearLimit += 1;
      }

      const windowedResponses = perSender.reduce((sum, r) => sum + r.cnt, 0);
      let windowedAttempts = 0;
      if (tables.has('llm_attempts')) {
        const attemptRow = db.prepare(`
          SELECT COUNT(*) AS cnt FROM llm_attempts
          WHERE attempt_at >= datetime('now', ?)
        `).get(offset) as { cnt: number };
        windowedAttempts = attemptRow.cnt;
      }

      return {
        supported: true,
        throttled,
        nearLimit,
        topSenders: perSender.slice(0, 5).map((r) => ({ senderJid: r.sender_jid, count: r.cnt })),
        windowedResponses,
        windowedAttempts,
        excessAttempts: Math.max(0, windowedAttempts - windowedResponses),
      };
    });
  }
}
