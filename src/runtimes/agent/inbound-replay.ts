import type { IncomingMessage } from '../../core/types.ts';
import type { ReplayableInboundRow } from '../../core/durability.ts';
import { isGroupJid } from '../../core/jid-constants.ts';

export interface InboundReplayStats {
  attempted: number;
  accepted: number;
  failed: number;
  suppressed: number;
  firstSeq: number | null;
  lastSeq: number | null;
}

const CONTENT_TYPES = new Set([
  'text', 'image', 'video', 'audio', 'document', 'sticker', 'location',
  'live_location', 'contact', 'poll', 'group_invite', 'product', 'pin',
  'interactive', 'unknown',
]);

function parseRawMessage(raw: string | null): unknown {
  if (raw === null) return undefined;
  return JSON.parse(raw) as unknown;
}

/**
 * Reconstruct the canonical runtime envelope for a definitely-undispatched
 * journal row. Queued agent rows are text-only because their replay path skips
 * media/imperative preprocessing; pending rows re-enter the full pipeline.
 */
export function reconstructReplayableInbound(row: ReplayableInboundRow): IncomingMessage {
  if (!CONTENT_TYPES.has(row.content_type)) {
    throw new Error('Replayable inbound has an unsupported content type');
  }
  if (row.processing_status === 'queued' && row.content_type !== 'text') {
    throw new Error('Prepared media inbound cannot be reconstructed exactly');
  }
  if (row.content_type === 'text' && (row.content === null || row.content.trim() === '')) {
    throw new Error('Replayable text inbound has no content');
  }

  return {
    messageId: row.message_id,
    chatJid: row.chat_jid,
    senderJid: row.sender_jid,
    senderName: row.sender_name,
    content: row.content,
    contentText: row.content_text,
    contentType: row.content_type,
    isFromMe: false,
    isGroup: isGroupJid(row.chat_jid),
    mentionedJids: [],
    timestamp: row.timestamp,
    quotedMessageId: row.quoted_message_id,
    isResponseWorthy: true,
    ...(row.processing_status === 'pending'
      ? { rawMessage: parseRawMessage(row.raw_message), durableAdmission: 'pending' as const }
      : { durableAdmission: 'queued_replay' as const }),
    inboundSeq: row.seq,
  };
}
