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
 * Transaction semantics: the whole batch runs inside one transaction via
 * `withTransaction` (src/core/db-tx.ts). Per-message errors are caught and
 * counted as `skipped` so one malformed record does not poison the rest of
 * a 50k-message sync — the batch commits with partial success. ROLLBACK
 * fires only if a BEGIN/COMMIT failure or a non-caught throw escapes the
 * withTransaction callback. `prepareStatements` runs before withTransaction
 * by design, so a statement-prepare failure never leaves a transaction open.
 *
 * Live message ingest also upgrades these placeholders when a body arrives
 * through the real-time path before history sync replays it.
 */
import type { Logger } from 'pino';
import type { Database } from './database.ts';
import { parseIncomingMessage } from './message-parser.ts';
import { withTransaction } from './db-tx.ts';
import { canonicalConversationKey } from './access-list.ts';
import { normalizeUnixTimestampSeconds } from './substrate/time.ts';

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

function stringifyWaMsg(waMsg: unknown, log?: Logger, msgId?: string): string {
  try {
    return JSON.stringify(waMsg, bufferSafeReplacer);
  } catch (err) {
    // Pathological payload (cyclic ref, BigInt, etc.) — store a marker so
    // downstream tools can see that raw_message was lost here rather than
    // the row failing to insert. Log so operators can diagnose the pattern.
    log?.warn({ err, msgId }, 'historyMessages: raw_message stringify failed, storing sentinel');
    return JSON.stringify({ $raw_message_error: 'stringify_failed' });
  }
}

/**
 * Sentinel value for the `content_type` column when a message is known to exist
 * (message_id delivered) but its body has not yet been decrypted and parsed.
 * Placeholders are replaced in place by the first body that arrives for them.
 * Single source of truth — do not inline this literal in SQL or comparisons.
 */
const PLACEHOLDER_CONTENT_TYPE = 'history';

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
  WHERE messages.content_type = '${PLACEHOLDER_CONTENT_TYPE}'
`;

const INSERT_PLACEHOLDER_SQL = `
  INSERT OR IGNORE INTO messages
    (chat_jid, conversation_key, sender_jid, message_id, content_type, is_from_me, timestamp)
  VALUES
    (?, ?, ?, ?, '${PLACEHOLDER_CONTENT_TYPE}', ?, ?)
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

  // QR-037: key a LID DM by the resolved phone (canonicalConversationKey mirrors
  // live ingest), so history rows share one thread with the phone-keyed live
  // messages instead of splitting under the raw LID number.
  const conversationKey = canonicalConversationKey(chatJid, db);
  const hasBody = !!waMsg.message;

  if (hasBody) {
    // HistoryInput is a structural subset of Baileys' WAMessage. parseIncomingMessage
    // (src/core/message-parser.ts) imports WAMessage directly; we keep HistoryInput
    // narrow to avoid a cross-module type dependency from this module. The cast is
    // safe because parseIncomingMessage's only preconditions (`msg.message` and
    // `msg.key?.remoteJid`) are already guaranteed by the hasBody / chatJid guards
    // above.
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
      raw_message: stringifyWaMsg(waMsg, log, msgId),
    });

    if (!before) return 'inserted';
    // A row existed. If it was a placeholder the WHERE clause just upgraded it.
    // If it was a live-path row the WHERE clause suppressed the update.
    if (before.content_type === PLACEHOLDER_CONTENT_TYPE && result.changes > 0) return 'upgraded';
    if (before.content_type === PLACEHOLDER_CONTENT_TYPE && result.changes === 0) {
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

  const timestamp = normalizeUnixTimestampSeconds(waMsg.messageTimestamp);
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
  // Semantic guardrail: prepareStatements runs BEFORE withTransaction opens
  // BEGIN. A statement-prepare failure (e.g. schema mismatch) therefore
  // propagates without leaving a transaction open — matching the prior
  // hand-rolled behavior that this migration replaced.
  const stmts = prepareStatements(db);

  withTransaction(db, () => {
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
  });

  return stats;
}
