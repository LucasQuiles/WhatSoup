/**
 * History-sync message ingestion.
 *
 * Extracted from `src/main.ts` `historyMessages` handler so the behavior is
 * directly testable against an in-memory DB.
 *
 * Baileys delivers a `messaging-history.set` batch when a new line first links
 * or when history is backfilled. Each entry may be:
 *   - envelope-only (no decrypted body)  →  placeholder row with content_type='history'
 *   - fully parsed (body present)        →  full row (or upgrade of a prior placeholder)
 *
 * The per-message logic is wrapped in a single SQLite transaction at the batch
 * level so a mid-sync crash leaves a consistent state.
 *
 * Known gap (tracked, not fixed here): if the live `messages.upsert` path later
 * receives the same message_id, `INSERT OR IGNORE` no-ops and the placeholder
 * stays stuck at content_type='history' until a future history-sync cycle
 * re-delivers it. A follow-up should add an upgrade hook on the live path.
 */
import type { Logger } from 'pino';
import type { Database } from './database.ts';
import { parseIncomingMessage } from '../transport/connection.ts';
import { toConversationKey } from './conversation-key.ts';
import { nowUnixSec } from '../fleet/time-utils.ts';

/** Raw Baileys WAMessage shape we rely on. Cast through unknown at the boundary. */
export interface HistoryInput {
  key?: { id?: string; remoteJid?: string; fromMe?: boolean; participant?: string };
  messageTimestamp?: number;
  message?: unknown;
}

export type HistoryAction =
  | 'inserted'     // full-body row inserted (no prior row)
  | 'upgraded'     // prior placeholder upgraded to full body
  | 'placeholder'  // envelope-only row inserted
  | 'skipped_no_key' // missing message_id or remoteJid
  | 'skipped_null_parse' // hasBody=true but parseIncomingMessage returned null
  | 'noop';        // row already exists at a real content_type (not 'history')

export interface HistorySyncStats {
  parsed: number;      // bodies inserted or upgraded
  inserted: number;
  upgraded: number;
  placeholders: number;
  skipped: number;
}

interface Statements {
  check: ReturnType<Database['raw']['prepare']>;
  upsertBody: ReturnType<Database['raw']['prepare']>;
  insertPlaceholder: ReturnType<Database['raw']['prepare']>;
}

/**
 * The upsert:
 *   - If no row with this message_id exists, inserts the full body.
 *   - If a row exists and its content_type is 'history', upgrades in place.
 *   - If a row exists and its content_type is not 'history' (live-path row),
 *     the DO UPDATE's WHERE clause causes it to no-op — the live row wins.
 *
 * This replaces the prior SELECT-then-UPDATE pair, closing the race where a
 * live `messages.upsert` could land between the two statements.
 */
const UPSERT_BODY_SQL = `
  INSERT INTO messages
    (chat_jid, conversation_key, sender_jid, sender_name, message_id, content, content_text,
     content_type, is_from_me, timestamp, quoted_message_id, raw_message)
  VALUES
    (@chat_jid, @conversation_key, @sender_jid, @sender_name, @message_id, @content, @content_text,
     @content_type, @is_from_me, @timestamp, @quoted_message_id, @raw_message)
  ON CONFLICT(message_id) DO UPDATE SET
    content = excluded.content,
    content_text = excluded.content_text,
    content_type = excluded.content_type,
    sender_name = excluded.sender_name,
    sender_jid = excluded.sender_jid,
    raw_message = excluded.raw_message,
    quoted_message_id = excluded.quoted_message_id,
    timestamp = excluded.timestamp
  WHERE messages.content_type = 'history'
`;

const INSERT_PLACEHOLDER_SQL = `
  INSERT OR IGNORE INTO messages
    (chat_jid, conversation_key, sender_jid, message_id, content_type, is_from_me, timestamp)
  VALUES
    (?, ?, ?, ?, 'history', ?, ?)
`;

const CHECK_SQL = 'SELECT content_type FROM messages WHERE message_id = ?';

function prepareStatements(db: Database): Statements {
  return {
    check: db.raw.prepare(CHECK_SQL),
    upsertBody: db.raw.prepare(UPSERT_BODY_SQL),
    insertPlaceholder: db.raw.prepare(INSERT_PLACEHOLDER_SQL),
  };
}

/**
 * Process one history-sync message. Synchronous against better-sqlite3.
 * Safe to call from inside a transaction.
 */
export function processHistoryMessage(
  db: Database,
  stmts: Statements,
  waMsg: HistoryInput,
  log?: Logger,
): HistoryAction {
  const msgId = waMsg.key?.id;
  const chatJid = waMsg.key?.remoteJid;
  if (!msgId || !chatJid) {
    log?.debug({ msg: typeof waMsg }, 'historyMessages: skipping message with missing key fields');
    return 'skipped_no_key';
  }

  const conversationKey = toConversationKey(chatJid);
  const hasBody = !!waMsg.message;

  if (hasBody) {
    const parsedMsg = parseIncomingMessage(waMsg as any);
    if (!parsedMsg) {
      log?.debug({ msgId }, 'historyMessages: parseIncomingMessage returned null for message with body');
      return 'skipped_null_parse';
    }

    const before = stmts.check.get(msgId) as { content_type?: string } | undefined;
    const result = stmts.upsertBody.run({
      chat_jid: parsedMsg.chatJid,
      conversation_key: conversationKey,
      sender_jid: parsedMsg.senderJid,
      sender_name: parsedMsg.senderName ?? null,
      message_id: parsedMsg.messageId,
      content: parsedMsg.content ?? null,
      content_text: parsedMsg.contentText ?? null,
      content_type: parsedMsg.contentType,
      is_from_me: parsedMsg.isFromMe ? 1 : 0,
      timestamp: parsedMsg.timestamp,
      quoted_message_id: parsedMsg.quotedMessageId ?? null,
      raw_message: JSON.stringify(waMsg),
    });

    if (!before) return 'inserted';
    // A row existed. If it was a placeholder the WHERE clause just upgraded it.
    // If it was a live-path row the WHERE clause suppressed the update.
    if (before.content_type === 'history' && result.changes > 0) return 'upgraded';
    return 'noop';
  }

  // Envelope-only: insert a placeholder if nothing exists.
  const existing = stmts.check.get(msgId);
  if (existing) return 'noop';

  const timestamp = Number(waMsg.messageTimestamp ?? nowUnixSec());
  const senderJid = waMsg.key?.participant ?? chatJid;
  stmts.insertPlaceholder.run(
    chatJid,
    conversationKey,
    senderJid,
    msgId,
    waMsg.key?.fromMe ? 1 : 0,
    timestamp,
  );
  return 'placeholder';
}

/**
 * Process a full history-sync batch inside a single transaction.
 * Per-message errors are logged and swallowed so one bad message does not
 * poison the whole sync.
 */
export function processHistoryBatch(
  db: Database,
  messages: readonly HistoryInput[],
  log?: Logger,
): HistorySyncStats {
  const stmts = prepareStatements(db);
  const stats: HistorySyncStats = { parsed: 0, inserted: 0, upgraded: 0, placeholders: 0, skipped: 0 };
  const begin = db.raw.prepare('BEGIN');
  const commit = db.raw.prepare('COMMIT');
  const rollback = db.raw.prepare('ROLLBACK');

  begin.run();
  try {
    for (const msg of messages) {
      try {
        const action = processHistoryMessage(db, stmts, msg, log);
        switch (action) {
          case 'inserted': stats.inserted++; stats.parsed++; break;
          case 'upgraded': stats.upgraded++; stats.parsed++; break;
          case 'placeholder': stats.placeholders++; break;
          case 'skipped_no_key':
          case 'skipped_null_parse': stats.skipped++; break;
          case 'noop': break;
        }
      } catch (err) {
        log?.error({ err }, 'historyMessages: failed to store message');
        stats.skipped++;
      }
    }
    commit.run();
  } catch (err) {
    rollback.run();
    throw err;
  }

  return stats;
}
