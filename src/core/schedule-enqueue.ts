import { closeSync, fstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import type { Database } from './database.ts';
import type { OutboundMedia } from './types.ts';
import { isPathWithinAllowedRoot } from '../lib/path-boundary.ts';
import { parseCron } from './cron.ts';
import { EXTENSION_MEDIA_MAP } from './media-mime.ts';

const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;

/** Validate a string is a real IANA timezone (shared by the MCP schema and the HTTP path). */
export function isValidIanaTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface EnqueueMessageParams {
  chatJid: string;
  scheduled_at: number;
  text?: string;
  filePath?: string;
  caption?: string;
  filename?: string;
  ptt?: boolean;
  seconds?: number;
  ptv?: boolean;
  gifPlayback?: boolean;
  viewOnce?: boolean;
  isAnimated?: boolean;
  mediaType?: 'image' | 'video' | 'audio' | 'document' | 'sticker';
  recurrence?: string;
  timezone?: string;
  chatName?: string;
}

export interface EnqueueResult {
  id: number;
  chatJid: string;
  contentType: string;
  scheduledAt: number;
  status: 'pending';
}

/** Resolve + validate a media file path against a filesystem root (fail-closed). */
export function resolveScheduledFile(
  filePath: string,
  allowedRoot: string | undefined,
): { resolved: string; info: { type: OutboundMedia['type']; mime: string }; buffer: Buffer } {
  // QR-090 fd-pin TOCTOU guard: open the path ONCE, then verify the actually-opened
  // inode against the canonical path within allowedRoot before trusting any bytes, and
  // read off the pinned fd. Re-opening by name (realpath → statSync → readFileSync) let
  // a symlink swap between the check and the read escape allowedRoot; the fd pin closes
  // that window (mirrors createMediaReadStream in src/transport/baileys-media-errors.ts).
  let fd: number;
  try {
    fd = openSync(filePath, 'r');
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }
  try {
    const opened = fstatSync(fd);
    let resolved: string;
    try {
      resolved = realpathSync(filePath);
    } catch {
      throw new Error(`File not found: ${filePath}`);
    }
    if (!isPathWithinAllowedRoot(resolved, allowedRoot)) {
      throw new Error(`Path outside workspace: ${filePath}`);
    }
    const canonicalStat = statSync(resolved);
    if (canonicalStat.dev !== opened.dev || canonicalStat.ino !== opened.ino) {
      // The name we validated no longer resolves to the inode we opened — a swap
      // raced the check. Fail closed rather than read the swapped target.
      throw new Error(`Path outside workspace: ${filePath}`);
    }
    if (opened.size > MAX_FILE_SIZE_BYTES) {
      throw new Error(`File too large: ${(opened.size / 1024 / 1024).toFixed(1)} MB (limit 25 MB)`);
    }
    const info = EXTENSION_MEDIA_MAP[extname(resolved).toLowerCase()];
    if (!info) {
      throw new Error(`Unsupported file extension "${extname(resolved)}". Supported: ${Object.keys(EXTENSION_MEDIA_MAP).join(', ')}`);
    }
    return { resolved, info, buffer: readFileSync(fd) };
  } finally {
    closeSync(fd);
  }
}

/** Build the content_type + JSON payload + media blob for a scheduled row. */
export function buildScheduledPayload(
  params: EnqueueMessageParams,
  allowedRoot: string | undefined,
): { contentType: string; payload: Record<string, unknown>; mediaBlob: Buffer | null } {
  const { text, filePath, caption, filename, ptt, seconds, ptv, gifPlayback, viewOnce, isAnimated, mediaType } = params;

  if (!text && !filePath) {
    throw new Error('Provide text for a scheduled text message or filePath for scheduled media');
  }

  if (!filePath) {
    return { contentType: 'text', payload: { text: text! }, mediaBlob: null };
  }

  const { resolved, info, buffer } = resolveScheduledFile(filePath, allowedRoot);
  const effectiveType = mediaType ?? info.type;
  const basename = filename ?? resolved.split('/').pop() ?? 'file';

  switch (effectiveType) {
    case 'image':
      return { contentType: 'image', payload: { type: 'image', caption: caption ?? text, mimetype: info.mime, viewOnce }, mediaBlob: buffer };
    case 'document':
      return { contentType: 'document', payload: { type: 'document', filename: basename, mimetype: info.mime, caption: caption ?? text }, mediaBlob: buffer };
    case 'audio':
      return { contentType: 'audio', payload: { type: 'audio', mimetype: info.mime, ptt, seconds }, mediaBlob: buffer };
    case 'video':
      return { contentType: 'video', payload: { type: 'video', caption: caption ?? text, mimetype: info.mime, ptv, gifPlayback, viewOnce }, mediaBlob: buffer };
    case 'sticker':
      return { contentType: 'sticker', payload: { type: 'sticker', mimetype: info.mime, isAnimated }, mediaBlob: buffer };
    default:
      // Hardening over the MCP path (which is zod-enum-validated upstream): the HTTP
      // route accepts an unvalidated mediaType, so reject an unknown value explicitly
      // instead of silently returning undefined.
      throw new Error(`Unsupported media type: ${String(effectiveType)}`);
  }
}

/**
 * Turn a schedule request into a validated `scheduled_messages` row (status 'pending').
 * Single source of truth for both the `schedule_message` MCP tool and the POST /schedule route.
 */
export function enqueueScheduledMessage(
  db: Database,
  params: EnqueueMessageParams,
  opts: { allowedRoot: string | undefined; now: number },
): EnqueueResult {
  if (params.scheduled_at <= opts.now) {
    throw new Error('scheduled_at must be a future UTC unix timestamp');
  }
  if (params.recurrence) {
    parseCron(params.recurrence); // validate cron expression before inserting
  }
  if (params.timezone !== undefined && !isValidIanaTimeZone(params.timezone)) {
    // Parity with the MCP schema's refine: the HTTP path passes timezone through
    // unvalidated, which would silently kill a recurring row after its first send.
    throw new Error(`Invalid IANA timezone: ${params.timezone}`);
  }

  const { contentType, payload, mediaBlob } = buildScheduledPayload(params, opts.allowedRoot);
  const nextRunAt = params.recurrence ? params.scheduled_at : null;
  const result = db.raw.prepare(
    `INSERT INTO scheduled_messages (chat_jid, chat_name, content_type, payload, scheduled_at, recurrence, timezone, next_run_at, status, media_blob)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(params.chatJid, params.chatName ?? null, contentType, JSON.stringify(payload), params.scheduled_at, params.recurrence ?? null, params.timezone ?? null, nextRunAt, mediaBlob);

  return {
    id: Number(result.lastInsertRowid),
    chatJid: params.chatJid,
    contentType,
    scheduledAt: params.scheduled_at,
    status: 'pending',
  };
}
