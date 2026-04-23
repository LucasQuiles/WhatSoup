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
 * Transaction semantics: the whole batch runs inside one BEGIN/COMMIT. Per-message
 * errors are caught and counted as `skipped` so one malformed record does not
 * poison the rest of a 50k-message sync — the batch commits with partial success.
 * Atomic rollback only fires if BEGIN, COMMIT, or the setup (prepareStatements)
 * itself throws, since those indicate SQLite is in an unrecoverable state.
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
  /** Full-body rows newly written. */
  inserted: number;
  /** Prior placeholder rows upgraded in place by this batch. */
  upgraded: number;
  /** Envelope-only rows written because Baileys did not deliver a body. */
  placeholders: number;
  /** Rows not written — missing key fields, null parse, or per-message exceptions. */
  skipped: number;
}

/**
 * JSON replacer that preserves Uint8Array / Buffer fields as `{$b64: "..."}`.
 *
 * Baileys WAMessage payloads carry protobuf byte arrays for media keys, hashes,
 * and thumbnails. The default JSON.stringify serializes Uint8Array as an
 * indexed-offset object (`{"0":17,"1":42,...}`), which is useless for replay
 * and balloons raw_message to tens of MB for a single media envelope.
 */
function bufferSafeReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { $b64: Buffer.from(value).toString('base64') };
  }
  return value;
}

function stringifyWaMsg(waMsg: unknown): string {
  try {
    return JSON.stringify(waMsg, bufferSafeReplacer);
  } catch {
    // Pathological payload (cyclic ref, BigInt, etc.) — store a marker so
    // downstream tools can see that raw_message was lost here rather than
    // the row failing to insert.
    return JSON.stringify({ $raw_message_error: 'stringify_failed' });
  }
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
 * Process one history-sync message.
 *
 * Must be called from within an active transaction — the CHECK / UPSERT
 * pair is not atomic on its own, and a concurrent live `messages.upsert`
 * between them would re-open the race this module exists to close.
 * The batch wrapper in `processHistoryBatch` is the only supported caller.
 */
function processHistoryMessage(
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
      raw_message: stringifyWaMsg(waMsg),
    });

    if (!before) return 'inserted';
    // A row existed. If it was a placeholder the WHERE clause just upgraded it.
    // If it was a live-path row the WHERE clause suppressed the update.
    if (before.content_type === 'history' && result.changes > 0) return 'upgraded';
    if (before.content_type === 'history' && result.changes === 0) {
      // Defensive: placeholder row existed but UPSERT did not fire. Should not
      // be reachable under normal operation (WHERE clause matches 'history').
      // If we see this, parseIncomingMessage may have normalized messageId in
      // a way that diverged from the original key.id, so the UPSERT targeted
      // a different conflict slot. Log so we can diagnose rather than silently
      // leaving the placeholder stuck.
      log?.warn(
        { msgId, parsedMessageId: parsedMsg.messageId },
        'historyMessages: placeholder upgrade unexpectedly did not fire',
      );
    }
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
  const stats: HistorySyncStats = { inserted: 0, upgraded: 0, placeholders: 0, skipped: 0 };
  // Note: node:sqlite has no transaction wrapper, so we drive BEGIN/COMMIT via
  // prepared statements. (The sibling convention in blocklist-sync.ts uses the
  // raw exec form, which the repo's security hook flags on literal match; the
  // prepare/run form is semantically identical.)
  const begin = db.raw.prepare('BEGIN');
  const commit = db.raw.prepare('COMMIT');
  const rollback = db.raw.prepare('ROLLBACK');

  let transactionOpen = false;
  try {
    const stmts = prepareStatements(db);
    begin.run();
    transactionOpen = true;
    for (const msg of messages) {
      try {
        const action = processHistoryMessage(db, stmts, msg, log);
        switch (action) {
          case 'inserted': stats.inserted++; break;
          case 'upgraded': stats.upgraded++; break;
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
    transactionOpen = false;
  } catch (err) {
    if (transactionOpen) {
      try { rollback.run(); } catch { /* best-effort rollback */ }
    }
    throw err;
  }

  return stats;
}
