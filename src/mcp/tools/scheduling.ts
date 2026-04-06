import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { z } from 'zod';
import { toConversationKey } from '../../core/conversation-key.ts';
import type { Database } from '../../core/database.ts';
import type { OutboundMedia } from '../../core/types.ts';
import type { ToolRegistry } from '../registry.ts';
import type { SessionContext } from '../types.ts';
import { parseCron, nextCronRun } from '../../core/cron.ts';

const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;

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

export interface SchedulingDeps {
  db: Database;
}

const ScheduleMessageSchema = z.object({
  chatJid: z.string(),
  scheduled_at: z.number().int().describe('UTC unix timestamp in seconds'),
  text: z.string().optional(),
  filePath: z.string().optional(),
  caption: z.string().optional(),
  filename: z.string().optional(),
  ptt: z.boolean().optional(),
  seconds: z.number().int().optional(),
  ptv: z.boolean().optional(),
  gifPlayback: z.boolean().optional(),
  viewOnce: z.boolean().optional(),
  isAnimated: z.boolean().optional(),
  mediaType: z.enum(['image', 'video', 'audio', 'document', 'sticker']).optional(),
  recurrence: z.string().optional().describe('5-field cron expression for recurring messages'),
  chatName: z.string().optional().describe('Display name for the target chat'),
});

const ListScheduledSchema = z.object({
  chatJid: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
  status: z.enum(['pending', 'processing', 'failed', 'cancelled', 'sent']).optional(),
});

const CancelScheduledSchema = z.object({
  id: z.number().int().positive(),
});

const GetScheduledSchema = z.object({
  id: z.number().int().positive(),
});

const UpdateScheduledSchema = z.object({
  id: z.number().int().positive(),
  scheduled_at: z.number().int().optional(),
  text: z.string().optional(),
  recurrence: z.string().optional(),
});

interface ScheduledMessageRow {
  id: number;
  chat_jid: string;
  chat_name: string | null;
  content_type: string;
  payload: string;
  scheduled_at: number;
  recurrence: string | null;
  next_run_at: number | null;
  run_count: number;
  status: string;
  created_at: number;
  sent_at: number | null;
  error: string | null;
  retry_count: number;
}

function assertSessionAccess(rowChatJid: string, session: SessionContext): void {
  if (session.tier !== 'chat-scoped') return;
  if (!session.conversationKey) {
    throw new Error('Chat-scoped session has no conversation key');
  }

  let conversationKey: string;
  try {
    conversationKey = toConversationKey(rowChatJid);
  } catch {
    throw new Error('Scheduled message has invalid chat target');
  }

  if (conversationKey !== session.conversationKey) {
    throw new Error('Access denied: scheduled message belongs to a different conversation');
  }
}

function resolveFile(filePath: string, session: SessionContext): { resolved: string; info: { type: OutboundMedia['type']; mime: string }; buffer: Buffer } {
  let resolved: string;
  try {
    resolved = realpathSync(filePath);
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }

  if (session.allowedRoot) {
    if (resolved !== session.allowedRoot && !resolved.startsWith(session.allowedRoot + '/')) {
      throw new Error(`Path outside workspace: ${filePath}`);
    }
  }

  if (!existsSync(resolved)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const stat = statSync(resolved);
  if (stat.size > MAX_FILE_SIZE_BYTES) {
    throw new Error(`File too large: ${(stat.size / 1024 / 1024).toFixed(1)} MB (limit 25 MB)`);
  }

  const info = EXTENSION_MAP[extname(resolved).toLowerCase()];
  if (!info) {
    throw new Error(`Unsupported file extension "${extname(resolved)}". Supported: ${Object.keys(EXTENSION_MAP).join(', ')}`);
  }

  return { resolved, info, buffer: readFileSync(resolved) };
}

function buildScheduledPayload(params: z.infer<typeof ScheduleMessageSchema>, session: SessionContext): { contentType: string; payload: Record<string, unknown>; mediaBlob: Buffer | null } {
  const {
    text,
    filePath,
    caption,
    filename,
    ptt,
    seconds,
    ptv,
    gifPlayback,
    viewOnce,
    isAnimated,
    mediaType,
  } = params;

  if (!text && !filePath) {
    throw new Error('Provide text for a scheduled text message or filePath for scheduled media');
  }

  if (!filePath) {
    return {
      contentType: 'text',
      payload: { text: text! },
      mediaBlob: null,
    };
  }

  const { resolved, info, buffer } = resolveFile(filePath, session);
  const effectiveType = mediaType ?? info.type;
  const basename = filename ?? resolved.split('/').pop() ?? 'file';

  switch (effectiveType) {
    case 'image':
      return {
        contentType: 'image',
        payload: { type: 'image', caption: caption ?? text, mimetype: info.mime, viewOnce },
        mediaBlob: buffer,
      };
    case 'document':
      return {
        contentType: 'document',
        payload: { type: 'document', filename: basename, mimetype: info.mime, caption: caption ?? text },
        mediaBlob: buffer,
      };
    case 'audio':
      return {
        contentType: 'audio',
        payload: { type: 'audio', mimetype: info.mime, ptt, seconds },
        mediaBlob: buffer,
      };
    case 'video':
      return {
        contentType: 'video',
        payload: { type: 'video', caption: caption ?? text, mimetype: info.mime, ptv, gifPlayback, viewOnce },
        mediaBlob: buffer,
      };
    case 'sticker':
      return {
        contentType: 'sticker',
        payload: { type: 'sticker', mimetype: info.mime, isAnimated },
        mediaBlob: buffer,
      };
  }
}

function rowToScheduledMessage(row: ScheduledMessageRow) {
  return {
    id: row.id,
    chatJid: row.chat_jid,
    chatName: row.chat_name,
    contentType: row.content_type,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    scheduledAt: row.scheduled_at,
    recurrence: row.recurrence,
    nextRunAt: row.next_run_at,
    runCount: row.run_count,
    status: row.status,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    error: row.error,
    retryCount: row.retry_count,
  };
}

export function registerSchedulingTools(registry: ToolRegistry, deps: SchedulingDeps): void {
  const { db } = deps;

  registry.register({
    name: 'schedule_message',
    description: 'Schedule a text or media message to be sent later. In chat sessions, the current chat is used automatically.',
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'unsafe',
    schema: ScheduleMessageSchema,
    handler: async (params, session) => {
      const parsed = ScheduleMessageSchema.parse(params);
      const now = Math.floor(Date.now() / 1000);
      if (parsed.scheduled_at <= now) {
        throw new Error('scheduled_at must be a future UTC unix timestamp');
      }

      const { contentType, payload, mediaBlob } = buildScheduledPayload(parsed, session);
      const nextRunAt = parsed.recurrence ? parsed.scheduled_at : null;
      const result = db.raw.prepare(
        `INSERT INTO scheduled_messages (chat_jid, chat_name, content_type, payload, scheduled_at, recurrence, next_run_at, status, media_blob)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      ).run(parsed.chatJid, parsed.chatName ?? null, contentType, JSON.stringify(payload), parsed.scheduled_at, parsed.recurrence ?? null, nextRunAt, mediaBlob);

      return {
        id: Number(result.lastInsertRowid),
        chatJid: parsed.chatJid,
        contentType,
        scheduledAt: parsed.scheduled_at,
        status: 'pending',
      };
    },
  });

  registry.register({
    name: 'list_scheduled',
    description: 'List scheduled messages. Chat-scoped sessions only see messages for the current conversation.',
    scope: 'chat',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    schema: ListScheduledSchema,
    handler: async (params, session) => {
      const { chatJid, limit = 100, status } = ListScheduledSchema.parse(params);

      let rows: ScheduledMessageRow[];
      if (status) {
        rows = db.raw.prepare(
          `SELECT * FROM scheduled_messages
           WHERE status = ?
           ORDER BY scheduled_at ASC, id ASC
           LIMIT ?`,
        ).all(status, limit) as unknown as ScheduledMessageRow[];
      } else {
        rows = db.raw.prepare(
          `SELECT * FROM scheduled_messages
           WHERE status IN ('pending', 'processing')
           ORDER BY scheduled_at ASC, id ASC
           LIMIT ?`,
        ).all(limit) as unknown as ScheduledMessageRow[];
      }

      if (chatJid) {
        const requestedConversation = toConversationKey(chatJid);
        rows = rows.filter((row) => {
          try {
            return toConversationKey(row.chat_jid) === requestedConversation;
          } catch {
            return false;
          }
        });
      }

      rows = rows.filter((row) => {
        try {
          assertSessionAccess(row.chat_jid, session);
          return true;
        } catch {
          return false;
        }
      });

      return {
        count: rows.length,
        messages: rows.map(rowToScheduledMessage),
      };
    },
  });

  registry.register({
    name: 'cancel_scheduled',
    description: 'Cancel a pending scheduled message by ID.',
    scope: 'chat',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    schema: CancelScheduledSchema,
    handler: async (params, session) => {
      const { id } = CancelScheduledSchema.parse(params);
      const row = db.raw.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(id) as ScheduledMessageRow | undefined;
      if (!row) {
        throw new Error(`Scheduled message ${id} not found`);
      }

      assertSessionAccess(row.chat_jid, session);

      if (row.status !== 'pending') {
        throw new Error(`Scheduled message ${id} is ${row.status} and cannot be cancelled`);
      }

      db.raw.prepare(
        `UPDATE scheduled_messages
         SET status = 'cancelled'
         WHERE id = ?`,
      ).run(id);

      return { cancelled: true, id };
    },
  });

  registry.register({
    name: 'get_scheduled',
    description: 'Get details of a single scheduled message by ID.',
    scope: 'chat',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    schema: GetScheduledSchema,
    handler: async (params, session) => {
      const { id } = GetScheduledSchema.parse(params);
      const row = db.raw.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(id) as ScheduledMessageRow | undefined;
      if (!row) throw new Error(`Scheduled message ${id} not found`);
      assertSessionAccess(row.chat_jid, session);
      return rowToScheduledMessage(row);
    },
  });

  registry.register({
    name: 'update_scheduled',
    description: 'Update a pending scheduled message. Can change time, text, or recurrence.',
    scope: 'chat',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    schema: UpdateScheduledSchema,
    handler: async (params, session) => {
      const { id, scheduled_at, text, recurrence } = UpdateScheduledSchema.parse(params);
      const row = db.raw.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(id) as ScheduledMessageRow | undefined;
      if (!row) throw new Error(`Scheduled message ${id} not found`);
      assertSessionAccess(row.chat_jid, session);
      if (row.status !== 'pending') throw new Error(`Scheduled message ${id} is ${row.status} and cannot be updated`);

      if (scheduled_at !== undefined && scheduled_at <= Math.floor(Date.now() / 1000)) {
        throw new Error('scheduled_at must be a future UTC unix timestamp');
      }

      const updates: string[] = [];
      const values: unknown[] = [];

      if (scheduled_at !== undefined) {
        updates.push('scheduled_at = ?');
        values.push(scheduled_at);
      }
      if (text !== undefined) {
        updates.push('payload = ?');
        values.push(JSON.stringify({ text }));
        updates.push("content_type = 'text'");
      }
      if (recurrence !== undefined) {
        parseCron(recurrence); // throws if invalid
        updates.push('recurrence = ?');
        values.push(recurrence);
        const nextRun = nextCronRun(recurrence, Math.floor(Date.now() / 1000) - 60);
        updates.push('next_run_at = ?');
        values.push(nextRun);
      }

      if (updates.length === 0) throw new Error('No fields to update');

      values.push(id);
      db.raw.prepare(`UPDATE scheduled_messages SET ${updates.join(', ')} WHERE id = ?`).run(...(values as import('node:sqlite').SQLInputValue[]));

      const updated = db.raw.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(id) as unknown as ScheduledMessageRow;
      return rowToScheduledMessage(updated);
    },
  });
}
