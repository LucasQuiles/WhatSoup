/**
 * media-prep.ts — message → agent content preparation + workspace media relocation.
 *
 * Extracted from AgentRuntime's module scope as a slice of the god-class decomposition.
 * These are stateless module-level helpers (the only state is the process-local
 * createdMediaDirs LRU guard), not AgentRuntime methods — `prepareContentForAgent`
 * already only needed the db passed in. AgentRuntime imports the two functions for its
 * inbound pipeline and re-exports the public surface (prepareContentForAgent + the
 * __*ForTests helpers) so existing consumers and the prepare-content test suite (which
 * namespace-imports from runtime.ts) are unchanged. Behavior is identical to the prior
 * inline implementation — see prepare-content.test.ts and media-bridge.test.ts.
 */
import { mkdirSync, copyFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { config } from '../../config.ts';
import { createChildLogger } from '../../logger.ts';
import type { IncomingMessage } from '../../core/types.ts';
import type { Database } from '../../core/database.ts';
import { extractRawMime } from '../../core/media-mime.ts';
import { updateMediaPath, updateTranscription } from '../../core/messages.ts';

const log = createChildLogger('agent-runtime');

/** Tracks workspace media directories already created — avoids redundant mkdirSync calls. */
const MAX_MEDIA_DIRS = 5_000;
const createdMediaDirs = new Set<string>();

function rememberCreatedMediaDir(mediaDestDir: string): void {
  createdMediaDirs.add(mediaDestDir);
  if (createdMediaDirs.size > MAX_MEDIA_DIRS) {
    const oldest = createdMediaDirs.values().next().value;
    if (oldest !== undefined) {
      createdMediaDirs.delete(oldest);
    }
  }
}

/** Test-only helpers for LEAK-10 coverage. */
export function __resetCreatedMediaDirsForTests(): void {
  createdMediaDirs.clear();
}

/** Test-only helpers for LEAK-10 coverage. */
export function __rememberCreatedMediaDirForTests(mediaDestDir: string): void {
  rememberCreatedMediaDir(mediaDestDir);
}

/** Test-only helpers for LEAK-10 coverage. */
export function __getCreatedMediaDirsSizeForTests(): number {
  return createdMediaDirs.size;
}

/** Test-only helpers for LEAK-10 coverage. */
export function __hasCreatedMediaDirForTests(mediaDestDir: string): boolean {
  return createdMediaDirs.has(mediaDestDir);
}

/**
 * Prepare a plain-text content string for the agent runtime from any message type.
 *
 * Media files (images, audio, video, documents, stickers) are saved to disk so the
 * agent can use its Read tool to view them. The agent receives the file path in brackets.
 * Audio is also transcribed via the shared transcription chain so the agent gets the text without having to
 * open the file. Non-downloadable types (location, contact, poll) return descriptive text.
 *
 * OpenAI is used when configured; local faster-whisper and whisper.cpp fallbacks are used when installed.
 */
export async function prepareContentForAgent(msg: IncomingMessage, db?: Database, messageId?: string): Promise<string> {
  const { contentType, content } = msg;

  // Text messages: use as-is
  if (contentType === 'text') {
    return content ?? '';
  }

  // Build download function from rawMessage
  const downloadFn = msg.rawMessage
    ? async () => {
        const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
        return downloadMediaMessage(msg.rawMessage as any, 'buffer', {}) as Promise<Buffer>;
      }
    : null;

  const { downloadMedia, writeTempFile } = await import('../../core/media-download.ts');

  // Map content type to mime and extension
  const mimeMap: Record<string, { mime: string; ext: string }> = {
    image: { mime: 'image/jpeg', ext: 'jpg' },
    sticker: { mime: 'image/webp', ext: 'webp' },
    audio: { mime: 'audio/ogg', ext: 'ogg' },
    video: { mime: 'video/mp4', ext: 'mp4' },
    document: { mime: 'application/octet-stream', ext: 'bin' },
  };

  const typeInfo = mimeMap[contentType];

  // For non-downloadable types, return descriptive text
  if (!typeInfo || !downloadFn) {
    if (contentType === 'location') return content ? `[Location: ${content}]` : '[Location shared]';
    if (contentType === 'contact') return content ? `[Contact: ${content}]` : '[Contact shared]';
    if (contentType === 'poll') return content ? `[Poll: ${content}]` : '[Poll]';
    return content || `[${contentType} message received]`;
  }

  // QR-061: extract the real MIME from the raw WhatsApp message for ANY downloadable media
  // type (image/audio/video/document), mirroring the chat runtime (processor.ts, #1074).
  // extractRawMime returns undefined for types it does not cover (e.g. sticker) → falls back
  // to the mimeMap default. Previously only documents used the real MIME, so an M4A/WebM voice
  // note was pinned to the hardcoded 'audio/ogg' and uploaded to OpenAI Whisper mislabeled,
  // degrading transcription (result.mimeType flows from this into transcribeAudio).
  const downloadMime = extractRawMime(msg.rawMessage, contentType) ?? typeInfo.mime;

  // Download the file
  const result = await downloadMedia(downloadFn, downloadMime);
  if (!result) {
    return `[${contentType} — download failed]${content ? '\n' + content : ''}`;
  }

  // For documents, try to preserve the original extension from the filename
  let ext = typeInfo.ext;
  if (contentType === 'document' && content) {
    const dotIdx = content.lastIndexOf('.');
    if (dotIdx > 0) ext = content.substring(dotIdx + 1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) || 'bin';
  }

  // Save to disk — do NOT clean up immediately; agent needs time to read the file
  const filePath = writeTempFile(result.buffer, ext);

  // Persist media path to database for MCP access
  if (db && messageId) {
    try {
      updateMediaPath(db, messageId, filePath);
    } catch (err) {
      createChildLogger('agent:media').warn({ err, messageId }, 'Failed to persist media_path');
    }
  }

  switch (contentType) {
    case 'audio': {
      const { transcribeAudio } = await import('../chat/providers/whisper.ts');
      const transcript = await transcribeAudio(result.buffer, result.mimeType);

      // Persist transcription to DB for MCP access and FTS search
      if (db && messageId && transcript && !transcript.includes('transcription unavailable')) {
        try {
          updateTranscription(db, messageId, transcript);
        } catch (err) {
          createChildLogger('agent:transcription').warn({ err, messageId }, 'Failed to persist transcription');
        }
      }

      return `[Voice note transcription]: ${transcript}\n[Audio file: ${filePath}]`;
    }
    case 'image':
      return content ? `[Image: ${filePath}]\n${content}` : `[Image: ${filePath}]`;
    case 'sticker':
      return `[Sticker: ${filePath}]`;
    case 'video':
      return content ? `[Video: ${filePath}]\n${content}` : `[Video: ${filePath}]`;
    case 'document': {
      const { extractDocumentText } = await import('../chat/media/documents.ts');
      const text = await extractDocumentText(result.buffer, result.mimeType, content ?? 'document');
      return `[Document: ${filePath}]\n${text}`;
    }
    default:
      return content || `[${contentType}: ${filePath}]`;
  }
}

/**
 * Relocate media files from the global temp dir into the user's workspace.
 * Rewrites file paths in the content string so the agent can read them
 * within its sandbox-allowed directory.
 */
export function relocateMediaToWorkspace(content: string, workspacePath: string): string {
  const mediaTmpDir = config.mediaDir;
  if (!mediaTmpDir || !content.includes(mediaTmpDir)) return content;

  const mediaDestDir = join(workspacePath, 'media');
  if (!createdMediaDirs.has(mediaDestDir)) {
    try {
      mkdirSync(mediaDestDir, { recursive: true, mode: 0o700 });
      rememberCreatedMediaDir(mediaDestDir);
    } catch (err) {
      log.warn({ err, mediaDestDir }, 'failed to create workspace media directory');
      return content;
    }
  }

  // Match file paths from the global media temp dir
  const regex = new RegExp(mediaTmpDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/[\\w.-]+', 'g');
  return content.replace(regex, (match) => {
    const destPath = join(mediaDestDir, basename(match));
    try {
      copyFileSync(match, destPath);
      return destPath;
    } catch {
      return match; // keep original path if copy fails
    }
  });
}
