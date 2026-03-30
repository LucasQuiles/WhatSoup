// src/mcp/tools/media.ts
// Media sending tool with filesystem boundary enforcement.

import { z } from 'zod';
import { statSync, readFileSync, realpathSync } from 'node:fs';
import { extname } from 'node:path';
import type { ToolRegistry } from '../registry.ts';
import type { SessionContext } from '../types.ts';
import type { ConnectionManager } from '../../transport/connection.ts';
import type { OutboundMedia } from '../../core/types.ts';

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface MediaDeps {
  connection: ConnectionManager;
}

// ---------------------------------------------------------------------------
// MIME type inference from extension
// ---------------------------------------------------------------------------

const EXTENSION_MAP: Record<string, { type: OutboundMedia['type']; mime: string }> = {
  '.png':  { type: 'image',    mime: 'image/png' },
  '.jpg':  { type: 'image',    mime: 'image/jpeg' },
  '.jpeg': { type: 'image',    mime: 'image/jpeg' },
  '.gif':  { type: 'image',    mime: 'image/gif' },
  '.webp': { type: 'image',    mime: 'image/webp' },

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
  const { connection } = deps;

  registry.register({
    name: 'send_media',
    description:
      'Send a media file (image, document, audio, or video) from the local filesystem to the current chat.',
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'unsafe',
    schema: z.object({
      chatJid: z.string(),
      filePath: z.string(),
      caption: z.string().optional(),
      filename: z.string().optional(),
    }),
    handler: async (params, session: SessionContext) => {
      const chatJid = params['chatJid'] as string;
      const filePath = params['filePath'] as string;
      const caption = params['caption'] as string | undefined;
      const filenameOverride = params['filename'] as string | undefined;

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

      switch (mediaInfo.type) {
        case 'image':
          media = {
            type: 'image',
            buffer,
            caption,
            mimetype: mediaInfo.mime,
          };
          break;
        case 'document':
          media = {
            type: 'document',
            buffer,
            filename: basename,
            mimetype: mediaInfo.mime,
            caption,
          };
          break;
        case 'audio':
          media = {
            type: 'audio',
            buffer,
            mimetype: mediaInfo.mime,
          };
          break;
        case 'video':
          media = {
            type: 'video',
            buffer,
            caption,
            mimetype: mediaInfo.mime,
          };
          break;
      }

      await connection.sendMedia(chatJid, media);

      return {
        sent: true,
        filePath: resolved,
        mediaType: mediaInfo.type,
        mimetype: mediaInfo.mime,
        sizeBytes: fileSize,
      };
    },
  });
}
