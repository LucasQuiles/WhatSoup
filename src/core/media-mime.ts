import type { OutboundMedia } from './types.ts';

/** File-extension → outbound media {type, mime} inference, shared by the
 *  media-send and scheduling tools so the two cannot drift (BEAD-037/CQ-25). */
export const EXTENSION_MEDIA_MAP: Record<string, { type: OutboundMedia['type']; mime: string }> = {
  '.png':  { type: 'image',    mime: 'image/png' },
  '.jpg':  { type: 'image',    mime: 'image/jpeg' },
  '.jpeg': { type: 'image',    mime: 'image/jpeg' },
  '.gif':  { type: 'image',    mime: 'image/gif' },
  '.webp': { type: 'sticker',  mime: 'image/webp' },
  '.pdf':  { type: 'document', mime: 'application/pdf' },
  '.doc':  { type: 'document', mime: 'application/msword' },
  '.docx': { type: 'document', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  '.xlsx': { type: 'document', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  '.csv':  { type: 'document', mime: 'text/csv' },
  '.txt':  { type: 'document', mime: 'text/plain' },
  '.zip':  { type: 'document', mime: 'application/zip' },
  '.mp3':  { type: 'audio',    mime: 'audio/mpeg' },
  '.ogg':  { type: 'audio',    mime: 'audio/ogg; codecs=opus' },
  '.m4a':  { type: 'audio',    mime: 'audio/mp4' },
  '.wav':  { type: 'audio',    mime: 'audio/wav' },
  '.mp4':  { type: 'video',    mime: 'video/mp4' },
  '.mov':  { type: 'video',    mime: 'video/quicktime' },
  '.webm': { type: 'video',    mime: 'video/webm' },
};

/** Baileys message key for each content type. */
const RAW_MSG_KEY: Record<string, string> = {
  image: 'imageMessage',
  audio: 'audioMessage',
  video: 'videoMessage',
  document: 'documentMessage',
};

/**
 * Extract the MIME type from a raw Baileys message for a given content type.
 * Returns undefined when the MIME cannot be determined from the raw message.
 */
export function extractRawMime(rawMessage: unknown, contentType: string): string | undefined {
  if (!rawMessage) return undefined;
  const raw = rawMessage as any;
  const key = RAW_MSG_KEY[contentType];
  if (!key) return undefined;
  let msgNode = raw?.message?.[key];
  // documentWithCaptionMessage wraps the real documentMessage one level deeper
  if (contentType === 'document' && !msgNode) {
    msgNode = raw?.message?.documentWithCaptionMessage?.message?.documentMessage;
  }
  return msgNode?.mimetype as string | undefined;
}

/**
 * QR-057: Extract the SERVER-DECLARED byte size (`fileLength`) from a raw Baileys message,
 * so an oversized media can be rejected BEFORE downloadMediaMessage buffers the whole blob
 * into memory. Baileys carries fileLength as a Long (long.js), a number, or a numeric string;
 * coerce robustly. Returns undefined when absent/unparseable (caller then falls back to the
 * existing post-download byte cap). NOTE: this is the attacker-DECLARED size — it stops honest
 * large media (and a naive over-declarer) but a sender who understates fileLength is still
 * bounded only by the 30s download timeout + WhatsApp's server-side upload ceiling.
 */
export function extractRawFileLength(rawMessage: unknown, contentType: string): number | undefined {
  if (!rawMessage) return undefined;
  const raw = rawMessage as any;
  const key = RAW_MSG_KEY[contentType];
  if (!key) return undefined;
  let msgNode = raw?.message?.[key];
  if (contentType === 'document' && !msgNode) {
    msgNode = raw?.message?.documentWithCaptionMessage?.message?.documentMessage;
  }
  const fileLength: unknown = msgNode?.fileLength;
  if (fileLength == null) return undefined;
  const n =
    typeof fileLength === 'object' && typeof (fileLength as { toNumber?: unknown }).toNumber === 'function'
      ? (fileLength as { toNumber: () => number }).toNumber()
      : Number(fileLength);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
