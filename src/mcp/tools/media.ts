// src/mcp/tools/media.ts
// Media sending tool with filesystem boundary enforcement.

import { z } from 'zod';
import { existsSync, statSync, readFileSync, realpathSync } from 'node:fs';
import { extname, normalize } from 'node:path';
import type { MessageRow } from '../../core/messages.ts';
import { downloadMedia as coreDownloadMedia, writeTempFile } from '../../core/media-download.ts';
import { extractRawMime, EXTENSION_MEDIA_MAP } from '../../core/media-mime.ts';
import { extractQuotedMedia } from '../../core/quoted-media.ts';
import { updateMediaPath, updateTranscription } from '../../core/messages.ts';
import { createChildLogger } from '../../logger.ts';
import { config } from '../../config.ts';
import type { Database } from '../../core/database.ts';
import type { ToolRegistry } from '../registry.ts';
import { assertConversationAccess, isPathWithinAllowedRoot, toolError, type SessionContext } from '../types.ts';
import type { RuntimeConnection } from '../../transport/runtime-connection.ts';
import { isBaileysEncryptedTmpEnoent, createMediaReadStream } from '../../transport/baileys-media-errors.ts';
import type { OutboundMedia } from '../../core/types.ts';
import { destroyOutboundMediaStream } from '../../core/media-stream.ts';
import { errorMessage } from '../../lib/error-message.ts';
import { redactInternalArtifacts, resolveOutboundAudience } from '../../core/outbound-message-safety.ts';

const log = createChildLogger('mcp:media');

function errorResult<T extends Record<string, unknown>>(payload: T) {
  return toolError(payload);
}

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface MediaDeps {
  connection: RuntimeConnection;
  db: Database;
}

// ---------------------------------------------------------------------------
// MIME type inference from extension
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

function buildSendMediaPayload(
  type: OutboundMedia['type'],
  resolved: string,
  basename: string,
  mime: string,
  params: {
    caption?: string;
    viewOnce?: boolean;
    ptt?: boolean;
    seconds?: number;
    ptv?: boolean;
    gifPlayback?: boolean;
    isAnimated?: boolean;
  },
): OutboundMedia {
  switch (type) {
    case 'image':
      return { type: 'image', stream: createMediaReadStream(resolved, log), caption: params.caption, mimetype: mime, viewOnce: params.viewOnce };
    case 'document':
      return { type: 'document', stream: createMediaReadStream(resolved, log), filename: basename, mimetype: mime, caption: params.caption };
    case 'audio':
      return { type: 'audio', stream: createMediaReadStream(resolved, log), mimetype: mime, ptt: params.ptt, seconds: params.seconds };
    case 'video':
      return { type: 'video', stream: createMediaReadStream(resolved, log), caption: params.caption, mimetype: mime, ptv: params.ptv, gifPlayback: params.gifPlayback, viewOnce: params.viewOnce };
    case 'sticker':
      return { type: 'sticker', stream: createMediaReadStream(resolved, log), mimetype: mime, isAnimated: params.isAnimated };
  }
}

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
      const rawCaption = params['caption'] as string | undefined;
      // Client-safety guardrail: a media caption is agent free-text bound for the
      // client, so mask internal-artifact leaks (redaction-only — there is no
      // sensible "divert" for a media send). Ops-channel captions stay verbatim.
      const caption = rawCaption !== undefined && resolveOutboundAudience(chatJid) === 'client'
        ? redactInternalArtifacts(rawCaption).text
        : rawCaption;
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
        return errorResult({ error: `File not found: ${filePath}` });
      }

      if (!isPathWithinAllowedRoot(resolved, session.allowedRoot)) {
        return errorResult({ error: `Path outside workspace: ${filePath}` });
      }

      // ── File size check ────────────────────────────────────────────────

      let fileSize: number;
      try {
        const stat = statSync(resolved);
        fileSize = stat.size;
      } catch {
        return errorResult({ error: `Cannot stat file: ${filePath}` });
      }

      if (fileSize > MAX_FILE_SIZE_BYTES) {
        return errorResult({
          error: `File too large: ${(fileSize / 1024 / 1024).toFixed(1)} MB (limit 50 MB)`,
        });
      }

      // ── MIME inference ────────────────────────────────────────────────

      const ext = extname(resolved).toLowerCase();
      const mediaInfo = EXTENSION_MEDIA_MAP[ext];
      if (!mediaInfo) {
        return errorResult({
          error: `Unsupported file extension "${ext}". Supported: ${Object.keys(EXTENSION_MEDIA_MAP).join(', ')}`,
        });
      }

      // ── Build OutboundMedia ───────────────────────────────────────────

      const basename = filenameOverride ?? resolved.split('/').pop() ?? 'file';
      const effectiveType = mediaTypeOverride ?? mediaInfo.type;
      const mime = mediaInfo.mime;
      const mediaParams = { caption, viewOnce, ptt, seconds, ptv, gifPlayback, isAnimated };

      for (let attempt = 0; ; attempt += 1) {
        const media = buildSendMediaPayload(effectiveType, resolved, basename, mime, mediaParams);
        try {
          await connection.sendMedia(chatJid, media);
          break;
        } catch (err) {
          destroyOutboundMediaStream(media);
          if (attempt > 0 || !isBaileysEncryptedTmpEnoent(err)) throw err;
          log.warn(
            { chatJid, mediaType: effectiveType, path: err.path },
            'baileys encrypted tmp file vanished during send_media; retrying with fresh stream',
          );
        }
      }

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
      quoted: z.boolean().optional().describe('When true, download media from the quoted message instead of the message itself.'),
    }),
    handler: async (params, session) => {
      const messageId = params['message_id'] as string;
      const quoted = params['quoted'] as boolean | undefined;

      // Look up the message
      const row = db.raw.prepare(
        'SELECT message_id, conversation_key, content_type, media_path, raw_message FROM messages WHERE message_id = ?',
      ).get(messageId) as Pick<MessageRow, 'message_id' | 'conversation_key' | 'content_type' | 'media_path'> & { raw_message: string | null } | undefined;

      if (!row) {
        return errorResult({ error: 'not_found', message: `No message found with ID: ${messageId}` });
      }

      assertConversationAccess(row.conversation_key, session, 'Media message');

      // Reject non-media types unless we are explicitly targeting quoted media.
      if (!quoted && !MEDIA_CONTENT_TYPES.has(row.content_type)) {
        return errorResult({ error: 'unsupported_type', message: 'Message does not contain downloadable media.' });
      }

      // Return cached path if file still exists on disk — but only if it's under the managed
      // media directory. A path pointing elsewhere (e.g. /etc/passwd) is treated as stale/invalid
      // to prevent path-confinement escapes from poisoned DB rows.
      if (!quoted && row.media_path) {
        const normalizedPath = normalize(row.media_path);
        const mediaBase = normalize(config.mediaDir);
        const isConfined =
          normalizedPath === mediaBase ||
          normalizedPath.startsWith(mediaBase + '/');
        if (!isConfined) {
          log.warn({ media_path: row.media_path, mediaBase }, 'download_media: cached path is outside managed media dir — treating as stale');
          // fall through to re-download
        } else if (existsSync(normalizedPath)) {
          let fileSize = 0;
          try { fileSize = statSync(normalizedPath).size; } catch { /* ignore */ }
          return {
            file_path: normalizedPath,
            content_type: row.content_type,
            file_size: fileSize,
            cached: true,
          };
        }
      }

      // Need raw_message to attempt download
      if (!row.raw_message) {
        return errorResult({ error: 'no_raw_message', message: 'Message has no raw data for media download. Media may not have been stored.' });
      }

      // Parse raw_message and attempt download
      let rawMsg: unknown;
      try {
        rawMsg = JSON.parse(row.raw_message);
      } catch {
        return errorResult({ error: 'no_raw_message', message: 'Cannot parse raw message data.' });
      }

      const quotedMedia = quoted ? extractQuotedMedia(rawMsg) : null;
      if (quoted && !quotedMedia) {
        return errorResult({ error: 'no_quoted_media', message: 'Message does not quote downloadable media.' });
      }

      const effectiveContentType = quotedMedia?.contentType ?? row.content_type;
      const downloadTarget = quotedMedia?.message ?? rawMsg;

      // Determine MIME type and file extension
      const mimeMap: Record<string, { defaultMime: string; ext: string }> = {
        image:    { defaultMime: 'image/jpeg', ext: 'jpg' },
        sticker:  { defaultMime: 'image/webp', ext: 'webp' },
        audio:    { defaultMime: 'audio/ogg',  ext: 'ogg' },
        video:    { defaultMime: 'video/mp4',  ext: 'mp4' },
        document: { defaultMime: 'application/octet-stream', ext: 'bin' },
      };

      const typeInfo = mimeMap[effectiveContentType];
      if (!typeInfo) {
        return errorResult({ error: 'unsupported_type', message: 'Message does not contain downloadable media.' });
      }

      const mime = extractRawMime(downloadTarget, effectiveContentType) ?? typeInfo.defaultMime;

      // Build download function using Baileys
      const downloadFn = async (): Promise<Buffer> => {
        const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
        return downloadMediaMessage(downloadTarget as any, 'buffer', {}) as Promise<Buffer>;
      };

      // Attempt download with timeout and size checks
      let result: Awaited<ReturnType<typeof coreDownloadMedia>>;
      try {
        result = await coreDownloadMedia(downloadFn, mime);
      } catch (err) {
        const msg = errorMessage(err);
        if (/timed? ?out/i.test(msg)) {
          return errorResult({ error: 'download_timeout', message: 'Media download timed out after 30s.' });
        }
        if (/404|410|gone|expired/i.test(msg)) {
          return errorResult({ error: 'media_expired', message: 'WhatsApp media URL has expired. Media is only available for download within hours of receipt.' });
        }
        log.error({ err, messageId }, 'download_media failed');
        return errorResult({ error: 'download_failed', message: 'Media download failed.' });
      }

      if (!result) {
        return errorResult({ error: 'download_failed', message: 'Media download failed. The URL may have expired or the file exceeds the 25MB limit.' });
      }

      // Determine file extension — for documents, try original filename
      let ext = typeInfo.ext;
      if (effectiveContentType === 'document') {
        const docMsg = (downloadTarget as any)?.message?.documentMessage
          ?? (downloadTarget as any)?.message?.documentWithCaptionMessage?.message?.documentMessage;
        const fileName = docMsg?.fileName as string | undefined;
        if (fileName) {
          const dotIdx = fileName.lastIndexOf('.');
          if (dotIdx > 0) ext = fileName.substring(dotIdx + 1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) || 'bin';
        }
      }

      // Save to disk
      const filePath = writeTempFile(result.buffer, ext);

      // Persist path only for the message's own media. Quoted media has no canonical row to attach to.
      if (!quoted) {
        updateMediaPath(db, messageId, filePath);
      }

      return {
        file_path: filePath,
        mime_type: result.mimeType,
        file_size: result.buffer.length,
        content_type: effectiveContentType,
        cached: false,
      };
    },
  });

  // ── transcribe_audio ─────────────────────────────────────────────────────────

  registry.register({
    name: 'transcribe_audio',
    description:
      'Transcribe an audio/voice message using the shared transcription chain. Downloads the audio if needed, transcribes it, and persists the transcription. Returns cached transcription if already transcribed.',
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    schema: z.object({
      message_id: z.string().describe('The audio message ID to transcribe'),
    }),
    handler: async (params, session) => {
      const messageId = params['message_id'] as string;

      // Look up the message
      const row = db.raw.prepare(
        'SELECT message_id, conversation_key, content_type, content, content_text, media_path, raw_message FROM messages WHERE message_id = ?',
      ).get(messageId) as {
        message_id: string;
        conversation_key: string;
        content_type: string;
        content: string | null;
        content_text: string | null;
        media_path: string | null;
        raw_message: string | null;
      } | undefined;

      if (!row) {
        return errorResult({ error: 'not_found', message: `No message found with ID: ${messageId}` });
      }

      assertConversationAccess(row.conversation_key, session, 'Audio message');

      if (row.content_type !== 'audio') {
        return errorResult({ error: 'not_audio', message: `Message is type "${row.content_type}", not audio.` });
      }

      // Check for cached transcription in content_text
      if (row.content_text && row.content_text.length > 0) {
        if (!row.content_text.includes('transcription unavailable')) {
          return { transcription: row.content_text, cached: true };
        }
      }

      // Also check structured content for existing transcription
      if (row.content) {
        try {
          const parsed = JSON.parse(row.content);
          if (parsed.transcription && !parsed.transcription.includes('transcription unavailable')) {
            return { transcription: parsed.transcription, cached: true };
          }
        } catch { /* not JSON, continue */ }
      }

      // Need audio data — try media_path first, then download_media fallback
      let audioBuffer: Buffer | null = null;
      let audioMime = 'audio/ogg';

      if (row.media_path && existsSync(row.media_path)) {
        audioBuffer = readFileSync(row.media_path) as unknown as Buffer;
        const ext = row.media_path.split('.').pop()?.toLowerCase();
        if (ext === 'mp3') audioMime = 'audio/mpeg';
        else if (ext === 'm4a') audioMime = 'audio/mp4';
        else if (ext === 'wav') audioMime = 'audio/wav';
        else if (ext === 'webm') audioMime = 'audio/webm';
      } else if (row.raw_message) {
        let rawMsg: unknown;
        try {
          rawMsg = JSON.parse(row.raw_message);
        } catch {
          return errorResult({ error: 'no_audio_data', message: 'Cannot parse raw message data for audio download.' });
        }

        const mime = extractRawMime(rawMsg, 'audio') ?? 'audio/ogg';

        const downloadFn = async (): Promise<Buffer> => {
          const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
          return downloadMediaMessage(rawMsg as any, 'buffer', {}) as Promise<Buffer>;
        };

        try {
          const result = await coreDownloadMedia(downloadFn, mime);
          if (result) {
            audioBuffer = result.buffer;
            audioMime = result.mimeType;

            // Save to disk and persist path
            const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : 'webm';
            const filePath = writeTempFile(result.buffer, ext);
            updateMediaPath(db, messageId, filePath);
          }
        } catch (err) {
          const msg = errorMessage(err);
          if (/404|410|gone|expired/i.test(msg)) {
            return errorResult({ error: 'media_expired', message: 'Audio media URL has expired.' });
          }
          return errorResult({ error: 'download_failed', message: 'Failed to download audio for transcription.' });
        }
      }

      if (!audioBuffer) {
        return errorResult({ error: 'no_audio_data', message: 'No audio data available. Media path missing and raw message unavailable.' });
      }

      // Transcribe via the shared transcription chain
      const { transcribeAudio } = await import('../../runtimes/chat/providers/whisper.ts');
      const transcription = await transcribeAudio(audioBuffer, audioMime);

      if (!transcription || transcription.includes('transcription unavailable')) {
        return errorResult({ error: 'transcription_failed', message: 'Transcription failed or is unavailable.' });
      }

      // Persist transcription
      updateTranscription(db, messageId, transcription);

      // Extract duration from structured content if available
      let duration: number | null = null;
      try {
        const parsed = JSON.parse(row.content || '{}');
        duration = parsed.duration ?? null;
      } catch { /* ignore */ }

      return {
        transcription,
        duration,
        cached: false,
      };
    },
  });
}
