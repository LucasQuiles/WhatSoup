import type { Database } from './database.ts';

export interface StoredMessage {
  pk: number;
  chatJid: string;
  conversationKey: string;
  senderJid: string;
  senderName: string | null;
  messageId: string;
  content: string | null;
  contentType: string;
  isFromMe: boolean;
  timestamp: number; // unix epoch seconds
  quotedMessageId: string | null;
  enrichmentProcessedAt: string | null;
  createdAt: string;
}

export interface StoreMessageInput {
  chatJid: string;
  conversationKey: string;
  senderJid: string;
  senderName?: string | null;
  messageId: string;
  content?: string | null;
  contentType?: string;
  isFromMe: boolean;
  timestamp: number; // unix epoch seconds
  quotedMessageId?: string | null;
}

// --- Row mapping ---

function rowToStoredMessage(row: Record<string, unknown>): StoredMessage {
  return {
    pk: row.pk as number,
    chatJid: row.chat_jid as string,
    conversationKey: row.conversation_key as string,
    senderJid: row.sender_jid as string,
    senderName: (row.sender_name as string | null) ?? null,
    messageId: row.message_id as string,
    content: (row.content as string | null) ?? null,
    contentType: (row.content_type as string) ?? 'text',
    isFromMe: Boolean(row.is_from_me),
    timestamp: row.timestamp as number,
    quotedMessageId: (row.quoted_message_id as string | null) ?? null,
    enrichmentProcessedAt: (row.enrichment_processed_at as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

// --- Write path ---

function toInsertParams(msg: StoreMessageInput): Record<string, null | number | string> {
  return {
    chat_jid: msg.chatJid,
    conversation_key: msg.conversationKey,
    sender_jid: msg.senderJid,
    sender_name: msg.senderName ?? null,
    message_id: msg.messageId,
    content: msg.content ?? null,
    content_type: msg.contentType ?? 'text',
    is_from_me: msg.isFromMe ? 1 : 0,
    timestamp: msg.timestamp,
    quoted_message_id: msg.quotedMessageId ?? null,
  };
}

/**
 * Upsert a message. Uses ON CONFLICT(message_id) DO UPDATE so re-delivering
 * the same message_id is idempotent. Content fields are updated on conflict so
 * edits (content changes) are reflected.
 */
export function storeMessage(db: Database, msg: StoreMessageInput): void {
  db.raw.prepare(`
    INSERT INTO messages
      (chat_jid, conversation_key, sender_jid, sender_name, message_id, content, content_type,
       is_from_me, timestamp, quoted_message_id)
    VALUES
      (@chat_jid, @conversation_key, @sender_jid, @sender_name, @message_id, @content, @content_type,
       @is_from_me, @timestamp, @quoted_message_id)
    ON CONFLICT(message_id) DO UPDATE SET
      sender_name      = COALESCE(excluded.sender_name, sender_name),
      content          = excluded.content,
      content_type     = excluded.content_type,
      is_from_me       = excluded.is_from_me,
      timestamp        = excluded.timestamp,
      quoted_message_id = COALESCE(excluded.quoted_message_id, quoted_message_id)
  `).run(toInsertParams(msg));
}

/**
 * Insert a message only if no row with the same message_id exists.
 * Uses INSERT OR IGNORE for an atomic check-and-insert.
 * Returns true if the row was inserted, false if it already existed.
 */
export function storeMessageIfNew(db: Database, msg: StoreMessageInput): boolean {
  const result = db.raw.prepare(`
    INSERT OR IGNORE INTO messages
      (chat_jid, conversation_key, sender_jid, sender_name, message_id, content, content_type,
       is_from_me, timestamp, quoted_message_id)
    VALUES
      (@chat_jid, @conversation_key, @sender_jid, @sender_name, @message_id, @content, @content_type,
       @is_from_me, @timestamp, @quoted_message_id)
  `).run(toInsertParams(msg));
  return (result.changes as number) > 0;
}

// --- Read path ---

/**
 * Return the last `limit` messages in a conversation, ordered chronologically (ASC).
 * Fetches DESC for efficiency, reverses in JS.
 * Queries on conversation_key for stable identity across JID aliasing.
 */
export function getRecentMessages(db: Database, conversationKey: string, limit: number): StoredMessage[] {
  const rows = db.raw.prepare(`
    SELECT * FROM messages
    WHERE conversation_key = @conversation_key
    ORDER BY timestamp DESC, pk DESC
    LIMIT @limit
  `).all({ conversation_key: conversationKey, limit }) as Record<string, unknown>[];

  return rows.map(rowToStoredMessage).reverse();
}

/**
 * Return messages that have not yet been enrichment-processed, ordered ASC
 * so enrichment runs in arrival order.
 */
export function getUnprocessedMessages(db: Database, limit: number): StoredMessage[] {
  const rows = db.raw.prepare(`
    SELECT * FROM messages
    WHERE enrichment_processed_at IS NULL
    ORDER BY timestamp ASC, pk ASC
    LIMIT @limit
  `).all({ limit }) as Record<string, unknown>[];

  return rows.map(rowToStoredMessage);
}

/** Mark a batch of messages as enrichment-processed (by primary key). */
export function markMessagesProcessed(db: Database, pks: number[]): void {
  if (pks.length === 0) return;

  // Build a single UPDATE with a VALUES list for efficiency.
  // node:sqlite DatabaseSync does not support array bindings, so we use a
  // parameterised IN clause built from positional ?-placeholders.
  const placeholders = pks.map(() => '?').join(', ');
  db.raw.prepare(`
    UPDATE messages
    SET enrichment_processed_at = datetime('now')
    WHERE pk IN (${placeholders})
  `).run(...pks);
}

/** Total number of messages stored. */
export function getMessageCount(db: Database): number {
  const row = db.raw.prepare('SELECT COUNT(*) AS cnt FROM messages').get() as { cnt: number };
  return row.cnt;
}

/**
 * Delete messages older than retentionDays. Returns the number of rows deleted.
 */
export function deleteOldMessages(db: Database, retentionDays: number): number {
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400;
  const result = db.raw.prepare(
    'DELETE FROM messages WHERE timestamp < ?'
  ).run(cutoff);
  return result.changes as number;
}


/**
 * Mark a batch of messages as failed enrichment (by primary key).
 * Sets enrichment_processed_at and enrichment_error. No-op if pks is empty.
 */
export function markMessagesWithError(db: Database, pks: number[], error: string): void {
  if (pks.length === 0) return;
  const placeholders = pks.map(() => '?').join(', ');
  db.raw.prepare(
    `UPDATE messages
     SET enrichment_processed_at = datetime('now'), enrichment_error = ?
     WHERE pk IN (${placeholders})`
  ).run(error, ...pks);
}

/**
 * Return all inbound messages (is_from_me = 0) from a given sender JID,
 * ordered chronologically ASC.
 */
export function getMessagesBySender(db: Database, senderJid: string, limit = 50): StoredMessage[] {
  const rows = db.raw.prepare(
    `SELECT * FROM messages
     WHERE sender_jid = ? AND is_from_me = 0
     ORDER BY timestamp ASC
     LIMIT ?`
  ).all(senderJid, limit) as Record<string, unknown>[];
  return rows.map(rowToStoredMessage);
}
