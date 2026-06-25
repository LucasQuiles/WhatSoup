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
