import { createHash } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { LinkPreviewMode } from './send-pipeline.ts';

export type OutboundSendCaller = 'mcp' | 'health' | 'rgp';
export type OutboundSendTargetKind = 'chatJid' | 'alias';

export interface OutboundSendIntentInput {
  caller: OutboundSendCaller;
  chatJid: string;
  targetKind: OutboundSendTargetKind;
  alias?: string;
  profile?: string;
  text: string;
  linkPreviewMode?: LinkPreviewMode;
}

export interface OutboundSendListOptions {
  limit?: number;
  chatJid?: string;
}

export interface OutboundSendReadRow {
  id: number;
  chat_jid: string;
  text_hash: string;
  text_length: number;
  status: string;
  profile?: string;
  transport_id?: string;
  error_text?: string;
  created_at: string;
  sent_at?: string;
}

export interface OutboundSendsWriter {
  writeIntent(input: OutboundSendIntentInput): number;
  markSuccess(id: number, transportMessageId?: string | null): void;
  markFailure(id: number, errorMessage: string): void;
  listRecent(options?: OutboundSendListOptions): OutboundSendReadRow[];
}

export function createOutboundSendsWriter({
  db,
  line,
}: {
  db: DatabaseSync;
  line: string;
}): OutboundSendsWriter {
  const insertIntent = db.prepare(`
    INSERT INTO outbound_sends (
      line,
      caller,
      chat_jid,
      target_kind,
      alias,
      profile,
      text_hash,
      text_length,
      link_preview_mode
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const markSent = db.prepare(`
    UPDATE outbound_sends
       SET status = 'sent',
           transport_message_id = ?,
           completed_at = datetime('now')
     WHERE id = ?
       AND status = 'intent'
  `);
  const markFailed = db.prepare(`
    UPDATE outbound_sends
       SET status = 'failed',
           error = ?,
           completed_at = datetime('now')
     WHERE id = ?
       AND status = 'intent'
  `);
  const selectStatus = db.prepare('SELECT status FROM outbound_sends WHERE id = ?');
  const listRecent = db.prepare(`
    SELECT
      id,
      chat_jid,
      text_hash,
      text_length,
      status,
      profile,
      transport_message_id AS transport_id,
      error AS error_text,
      created_at,
      completed_at AS sent_at
    FROM outbound_sends
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `);
  const listRecentByChatJid = db.prepare(`
    SELECT
      id,
      chat_jid,
      text_hash,
      text_length,
      status,
      profile,
      transport_message_id AS transport_id,
      error AS error_text,
      created_at,
      completed_at AS sent_at
    FROM outbound_sends
    WHERE chat_jid = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `);

  return {
    writeIntent(input: OutboundSendIntentInput): number {
      const result = insertIntent.run(
        line,
        input.caller,
        input.chatJid,
        input.targetKind,
        input.alias ?? null,
        input.profile ?? null,
        sha256(input.text),
        input.text.length,
        input.linkPreviewMode ?? null,
      );
      return Number(result.lastInsertRowid);
    },

    markSuccess(id: number, transportMessageId?: string | null): void {
      finalizeAuditRow(markSent, selectStatus, id, transportMessageId ?? null);
    },

    markFailure(id: number, errorMessage: string): void {
      finalizeAuditRow(markFailed, selectStatus, id, sanitizeErrorText(errorMessage));
    },

    listRecent(options: OutboundSendListOptions = {}): OutboundSendReadRow[] {
      const limit = normalizeLimit(options.limit);
      const rows = options.chatJid
        ? listRecentByChatJid.all(options.chatJid, limit)
        : listRecent.all(limit);
      return (rows as unknown as RawOutboundSendReadRow[]).map(toOutboundSendReadRow);
    },
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function sanitizeErrorText(errorMessage: string): string {
  return errorMessage.slice(0, 1000);
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isInteger(limit)) {
    throw new Error('limit must be an integer');
  }
  if (limit < 1) {
    throw new Error('limit must be at least 1');
  }
  return Math.min(limit, 100);
}

interface RawOutboundSendReadRow {
  id: number;
  chat_jid: string;
  text_hash: string;
  text_length: number;
  status: string;
  profile: string | null;
  transport_id: string | null;
  error_text: string | null;
  created_at: string;
  sent_at: string | null;
}

function toOutboundSendReadRow(row: RawOutboundSendReadRow): OutboundSendReadRow {
  return {
    id: row.id,
    chat_jid: row.chat_jid,
    text_hash: row.text_hash,
    text_length: row.text_length,
    status: row.status,
    ...(row.profile ? { profile: row.profile } : {}),
    ...(row.transport_id ? { transport_id: row.transport_id } : {}),
    ...(row.error_text ? { error_text: row.error_text } : {}),
    created_at: row.created_at,
    ...(row.sent_at ? { sent_at: row.sent_at } : {}),
  };
}

function finalizeAuditRow(
  statement: StatementSync,
  selectStatus: StatementSync,
  id: number,
  value: string | null,
): void {
  const result = statement.run(value, id);
  if (Number(result.changes) === 1) return;

  const row = selectStatus.get(id) as { status: string } | undefined;
  if (!row) {
    throw new Error(`outbound send audit row not found: ${id}`);
  }
  throw new Error(`outbound send audit row ${id} is already finalized with status ${row.status}`);
}
