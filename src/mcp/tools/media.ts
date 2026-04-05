// src/mcp/tools/media.ts
// Media sending tool with filesystem boundary enforcement.

import { z } from 'zod';
import { existsSync, statSync, readFileSync, realpathSync } from 'node:fs';
import { extname } from 'node:path';
import type { MessageRow } from '../../core/messages.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { ToolRegistry } from '../registry.ts';
import type { SessionContext } from '../types.ts';
import type { ConnectionManager } from '../../transport/connection.ts';
import type { OutboundMedia } from '../../core/types.ts';

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface MediaDeps {
  connection: ConnectionManager;
  db: DatabaseSync;
}

// ---------------------------------------------------------------------------
// MIME type inference from extension
// ---------------------------------------------------------------------------

const EXTENSION_MAP: Record<string, { type: OutboundMedia['type']; mime: string }> = {
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

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

// ---------------------------------------------------------------------------
// Register media tools
// ---------------------------------------------------------------------------

export function registerMediaTools(
  registry: ToolRegistry,
  deps: MediaDeps,
): void {
  const { connection, db } = deps;

  registry.register({
    name: 'send_media',
    description:
      'Send a media file (image, document, audio, video, or sticker) from the local filesystem to the current chat.',
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'unsafe',
    schema: z.object({
      chatJid: z.string(),
      filePath: z.string(),
      caption: z.string().optional(),
      filename: z.string().optional(),
      /** Pass true to send audio as a voice note (PTT). */
      ptt: z.boolean().optional(),
      /** Duration in seconds for voice notes. */
      seconds: z.number().int().optional(),
      /** Send video as a round video note (PTV). */
      ptv: z.boolean().optional(),
      /** Auto-loop video as a GIF. */
      gifPlayback: z.boolean().optional(),
      /** Image or video disappears after viewing once. */
      viewOnce: z.boolean().optional(),
      /** Mark a .webp sticker as animated. */
      isAnimated: z.boolean().optional(),
      /** Force media type (auto-detected from extension if omitted). */
      mediaType: z.enum(['image', 'video', 'audio', 'document', 'sticker']).optional(),
    }),
    handler: async (params, session: SessionContext) => {
      const chatJid = params['chatJid'] as string;
      const filePath = params['filePath'] as string;
      const caption = params['caption'] as string | undefined;
      const filenameOverride = params['filename'] as string | undefined;
      const ptt = params['ptt'] as boolean | undefined;
      const seconds = params['seconds'] as number | undefined;
      const ptv = params['ptv'] as boolean | undefined;
      const gifPlayback = params['gifPlayback'] as boolean | undefined;
      const viewOnce = params['viewOnce'] as boolean | undefined;
      const isAnimated = params['isAnimated'] as boolean | undefined;
      const mediaTypeOverride = params['mediaType'] as OutboundMedia['type'] | undefined;

      // ── Filesystem boundary enforcement ────────────────────────────────

      let resolved: string;
      try {
        resolved = realpathSync(filePath);
      } catch {
        return { error: `File not found: ${filePath}` };
      }

      if (session.allowedRoot) {
        if (
          resolved !== session.allowedRoot &&
          !resolved.startsWith(session.allowedRoot + '/')
        ) {
          return { error: `Path outside workspace: ${filePath}` };
        }
      }

      // ── File size check ────────────────────────────────────────────────

      let fileSize: number;
      try {
        const stat = statSync(resolved);
        fileSize = stat.size;
      } catch {
        return { error: `Cannot stat file: ${filePath}` };
      }

      if (fileSize > MAX_FILE_SIZE_BYTES) {
        return {
          error: `File too large: ${(fileSize / 1024 / 1024).toFixed(1)} MB (limit 50 MB)`,
        };
      }

      // ── MIME inference ────────────────────────────────────────────────

      const ext = extname(resolved).toLowerCase();
      const mediaInfo = EXTENSION_MAP[ext];
      if (!mediaInfo) {
        return {
          error: `Unsupported file extension "${ext}". Supported: ${Object.keys(EXTENSION_MAP).join(', ')}`,
        };
      }

      // ── Read file ─────────────────────────────────────────────────────

      let buffer: Buffer;
      try {
        buffer = readFileSync(resolved);
      } catch (err) {
        return { error: `Cannot read file: ${filePath}` };
      }

      // ── Build OutboundMedia ───────────────────────────────────────────

      let media: OutboundMedia;
      const basename = filenameOverride ?? resolved.split('/').pop() ?? 'file';
      const effectiveType = mediaTypeOverride ?? mediaInfo.type;
      const mime = mediaInfo.mime;

      switch (effectiveType) {
        case 'image':
          media = { type: 'image', buffer, caption, mimetype: mime, viewOnce };
          break;
        case 'document':
          media = { type: 'document', buffer, filename: basename, mimetype: mime, caption };
          break;
        case 'audio':
          media = { type: 'audio', buffer, mimetype: mime, ptt, seconds };
          break;
        case 'video':
          media = { type: 'video', buffer, caption, mimetype: mime, ptv, gifPlayback, viewOnce };
          break;
        case 'sticker':
          media = { type: 'sticker', buffer, mimetype: mime, isAnimated };
          break;
      }

      await connection.sendMedia(chatJid, media);

      return {
        sent: true,
        filePath: resolved,
        mediaType: effectiveType,
        mimetype: mime,
        sizeBytes: fileSize,
      };
    },
  });

  // ── download_media ──────────────────��───────────────────────────────────────

  const MEDIA_CONTENT_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker']);

  registry.register({
    name: 'download_media',
    description:
      'Download media from a received WhatsApp message. Returns the local file path. Uses cached path if media was already downloaded.',
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    schema: z.object({
      message_id: z.string().describe('The message ID to download media from'),
    }),
    handler: async (params) => {
      const messageId = params['message_id'] as string;

      // Look up the message
      const row = db.prepare(
        'SELECT message_id, content_type, media_path, raw_message FROM messages WHERE message_id = ?',
      ).get(messageId) as Pick<MessageRow, 'message_id' | 'content_type' | 'media_path'> & { raw_message: string | null } | undefined;

      if (!row) {
        return { error: 'not_found', message: `No message found with ID: ${messageId}` };
      }

      // Reject non-media types
      if (!MEDIA_CONTENT_TYPES.has(row.content_type)) {
        return { error: 'unsupported_type', message: 'Message does not contain downloadable media.' };
      }

      // Return cached path if file still exists on disk
      if (row.media_path && existsSync(row.media_path)) {
        let fileSize = 0;
        try { fileSize = statSync(row.media_path).size; } catch { /* ignore */ }
        return {
          file_path: row.media_path,
          content_type: row.content_type,
          file_size: fileSize,
          cached: true,
        };
      }

      // Need raw_message to attempt download
      if (!row.raw_message) {
        return { error: 'no_raw_message', message: 'Message has no raw data for media download. Media may not have been stored.' };
      }

      // On-demand download will be implemented in Task 6
      return { error: 'not_implemented', message: 'On-demand download not yet available.' };
    },
  });
}
