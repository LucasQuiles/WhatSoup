import { DatabaseSync } from 'node:sqlite';
import { createChildLogger } from '../logger.ts';

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

export interface MessageRow {
  pk: number;
  conversation_key: string;
  sender_jid: string;
  sender_name: string | null;
  content: string | null;
  content_type: string;
  timestamp: number;
  is_from_me: number;
}

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
      db = new DatabaseSync(dbPath, { readOnly: true } as any);
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

  /** Get chat list grouped by conversation_key, ordered by last message time. */
  getChats(name: string, dbPath: string, opts: { limit: number; offset: number }): DbResult<ChatSummary[]> {
    return this.query(name, dbPath, (db) => {
      const rows = db.prepare(`
        SELECT
          m.conversation_key,
          m.sender_name,
          COUNT(*) as message_count,
          MAX(m.timestamp) as last_message_at,
          CASE WHEN m.conversation_key LIKE '%_at_g.us' OR m.conversation_key LIKE '%@g.us' THEN 1 ELSE 0 END as is_group
        FROM messages m
        WHERE m.deleted_at IS NULL
        GROUP BY m.conversation_key
        ORDER BY last_message_at DESC
        LIMIT ? OFFSET ?
      `).all(opts.limit, opts.offset) as any[];

      return rows.map((r) => ({
        conversationKey: r.conversation_key,
        senderName: r.sender_name,
        messageCount: r.message_count,
        lastMessageAt: r.last_message_at,
        isGroup: !!r.is_group,
        lastMessagePreview: null,
        lastMessageSender: null,
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
        SELECT pk, conversation_key, sender_jid, sender_name,
               content, content_type, timestamp, is_from_me
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
}
