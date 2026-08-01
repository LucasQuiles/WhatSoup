import { z } from 'zod';
import { toConversationKey } from '../../core/conversation-key.ts';
import type { Database } from '../../core/database.ts';
import type { ToolRegistry } from '../registry.ts';
import { conversationBoundKey, type SessionContext } from '../types.ts';
import { parseCron, nextCronRun } from '../../core/cron.ts';
import { nowUnixSec } from '../../core/substrate/time.ts';
import { enqueueScheduledMessage, isValidIanaTimeZone } from '../../core/schedule-enqueue.ts';

// #1067: validate a recurrence timezone is a real IANA zone before storing it.
// `isValidIanaTimeZone` is the single source in schedule-enqueue.ts, shared with the
// HTTP /schedule path so both entry points reject bogus zones identically.

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
  timezone: z
    .string()
    .refine(isValidIanaTimeZone, { message: 'Invalid IANA timezone' })
    .optional()
    .describe('IANA timezone (e.g. America/New_York) the recurrence is evaluated in; defaults to UTC'),
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
  timezone: string | null;
  next_run_at: number | null;
  run_count: number;
  status: string;
  created_at: number;
  sent_at: number | null;
  error: string | null;
  retry_count: number;
}

function assertSessionAccess(rowChatJid: string, session: SessionContext): void {
  // Confined sessions: chat-scoped, or conversation-bound (per-chat actor
  // socket — tier:'global' with a binding). Unbound global sessions —
  // including turn-pinned operator sessions — keep full visibility.
  const boundKey = conversationBoundKey(session);
  if (boundKey === undefined && session.tier !== 'chat-scoped') return;
  const enforcedKey = boundKey ?? session.conversationKey;
  if (!enforcedKey) {
    throw new Error('Chat-scoped session has no conversation key');
  }

  let conversationKey: string;
  try {
    conversationKey = toConversationKey(rowChatJid);
  } catch {
    throw new Error('Scheduled message has invalid chat target');
  }

  if (conversationKey !== enforcedKey) {
    throw new Error('Access denied: scheduled message belongs to a different conversation');
  }
}

function rowToScheduledMessage(row: ScheduledMessageRow) {
  // Guarded parse: list/get/update map EVERY row through this function, so
  // one corrupt persisted payload must not brick the read tools wholesale.
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    payload = { corrupt: true };
  }
  return {
    id: row.id,
    chatJid: row.chat_jid,
    chatName: row.chat_name,
    contentType: row.content_type,
    payload,
    scheduledAt: row.scheduled_at,
    recurrence: row.recurrence,
    timezone: row.timezone,
    nextRunAt: row.next_run_at,
    runCount: row.run_count,
    status: row.status,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    error: row.error,
    retryCount: row.retry_count,
  };
}

export interface ListScheduledMessagesParams {
  chatJid?: string;
  limit?: number;
  status?: 'pending' | 'processing' | 'failed' | 'cancelled' | 'sent';
}

function listScheduledMessages(
  db: Database,
  params: ListScheduledMessagesParams,
  session: SessionContext,
): { count: number; messages: ReturnType<typeof rowToScheduledMessage>[] } {
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
      return enqueueScheduledMessage(db, parsed, { allowedRoot: session.allowedRoot, now: nowUnixSec() });
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
      return listScheduledMessages(db, params, session);
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

      if (scheduled_at !== undefined && scheduled_at <= nowUnixSec()) {
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
        // Anchor next_run_at to the new scheduled_at if both are changing,
        // otherwise use the supplied scheduled_at or wall-clock now.
        const base = scheduled_at ?? nowUnixSec() - 60;
        const nextRun = nextCronRun(recurrence, base, row.timezone ?? 'UTC');
        updates.push('next_run_at = ?');
        values.push(nextRun);
      } else if (scheduled_at !== undefined && row.recurrence) {
        // scheduled_at changed on an already-recurring row — recompute next_run_at
        // so the scheduler fires at the new time, not the stale next_run_at.
        const nextRun = nextCronRun(row.recurrence, scheduled_at - 60, row.timezone ?? 'UTC');
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
