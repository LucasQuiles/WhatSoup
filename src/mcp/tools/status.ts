import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { z } from 'zod';
import { JID_PERSONAL } from '../../core/jid-constants.ts';
import { rowToMessage, type MessageRow } from '../../core/messages.ts';
import type { Database } from '../../core/database.ts';
import { createChildLogger } from '../../logger.ts';
import { isBaileysEncryptedTmpEnoent } from '../../transport/baileys-media-errors.ts';
import type { ToolRegistry } from '../registry.ts';
import { isPathWithinAllowedRoot, type SessionContext, type ToolDeclaration, type ExtendedBaileysSocket } from '../types.ts';

const STATUS_BROADCAST_JID = 'status@broadcast';
const MAX_STATUS_FILE_SIZE_BYTES = 50 * 1024 * 1024;
const log = createChildLogger('mcp:status');

const STATUS_MEDIA_MAP = {
  '.png': { type: 'image', mimetype: 'image/png' },
  '.jpg': { type: 'image', mimetype: 'image/jpeg' },
  '.jpeg': { type: 'image', mimetype: 'image/jpeg' },
  '.gif': { type: 'image', mimetype: 'image/gif' },
  '.mp4': { type: 'video', mimetype: 'video/mp4' },
  '.mov': { type: 'video', mimetype: 'video/quicktime' },
  '.webm': { type: 'video', mimetype: 'video/webm' },
} as const satisfies Record<string, { type: 'image' | 'video'; mimetype: string }>;

export interface StatusDeps {
  db: Database;
  getSock: () => ExtendedBaileysSocket | null;
}

const PostStatusSchema = z.object({
  text: z.string().optional(),
  filePath: z.string().optional(),
  caption: z.string().optional(),
  backgroundColor: z.string().optional(),
  font: z.number().int().optional(),
});

const ListStatusesSchema = z.object({
  limit: z.number().int().positive().max(200).optional(),
  sender_jid: z.string().optional(),
  mark_read: z.boolean().optional(),
});

type StatusRow = MessageRow & { raw_message: string | null };

function getStatusRecipients(db: Database): string[] {
  const rows = db.raw.prepare(
    `SELECT jid
       FROM contacts
      WHERE jid LIKE ?
      ORDER BY last_seen_at DESC, jid ASC`,
  ).all(`%${JID_PERSONAL}`) as Array<{ jid: string }>;

  return [...new Set(rows.map((row) => row.jid))];
}

function resolveStatusFile(filePath: string, session: SessionContext): {
  resolved: string;
  buffer: Buffer;
  statusType: 'image' | 'video';
  mimetype: string;
} {
  let resolved: string;
  try {
    resolved = realpathSync(filePath);
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }

  if (!isPathWithinAllowedRoot(resolved, session.allowedRoot)) {
      throw new Error(`Path outside workspace: ${filePath}`);
  }

  if (!existsSync(resolved)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const fileSize = statSync(resolved).size;
  if (fileSize > MAX_STATUS_FILE_SIZE_BYTES) {
    throw new Error(`File too large: ${(fileSize / 1024 / 1024).toFixed(1)} MB (limit 50 MB)`);
  }

  const ext = extname(resolved).toLowerCase() as keyof typeof STATUS_MEDIA_MAP;
  const info = STATUS_MEDIA_MAP[ext];
  if (!info) {
    throw new Error(`Unsupported status media extension "${ext}". Supported: ${Object.keys(STATUS_MEDIA_MAP).join(', ')}`);
  }

  return {
    resolved,
    buffer: readFileSync(resolved),
    statusType: info.type,
    mimetype: info.mimetype,
  };
}

function parseStatusKey(row: StatusRow): Record<string, unknown> {
  if (!row.raw_message) {
    return {
      remoteJid: STATUS_BROADCAST_JID,
      id: row.message_id,
      fromMe: Boolean(row.is_from_me),
      participant: row.sender_jid,
    };
  }

  try {
    const parsed = JSON.parse(row.raw_message) as { key?: Record<string, unknown> };
    return {
      remoteJid: STATUS_BROADCAST_JID,
      id: parsed.key?.['id'] ?? row.message_id,
      fromMe: parsed.key?.['fromMe'] ?? Boolean(row.is_from_me),
      participant: parsed.key?.['participant'] ?? row.sender_jid,
    };
  } catch {
    return {
      remoteJid: STATUS_BROADCAST_JID,
      id: row.message_id,
      fromMe: Boolean(row.is_from_me),
      participant: row.sender_jid,
    };
  }
}

async function sendStatusWithRetry(
  sock: ExtendedBaileysSocket,
  content: Record<string, unknown>,
  options: Record<string, unknown>,
  statusType: 'text' | 'image' | 'video',
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await sock.sendMessage(STATUS_BROADCAST_JID, content as any, options as any);
    } catch (err) {
      if (statusType === 'text' || attempt > 0 || !isBaileysEncryptedTmpEnoent(err)) {
        throw err;
      }

      log.warn(
        { statusType, path: err.path },
        'baileys encrypted tmp file vanished during post_status; retrying once',
      );
    }
  }
}

function makePostStatus(deps: StatusDeps): ToolDeclaration {
  const { db, getSock } = deps;

  return {
    name: 'post_status',
    description:
      'Post a WhatsApp Status update to all known contacts. Supports text statuses and image/video statuses from local files (global).',
    schema: PostStatusSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'unsafe',
    handler: async (params, session) => {
      const { text, filePath, caption, backgroundColor, font } = PostStatusSchema.parse(params);
      if (!text && !filePath) {
        throw new Error('Provide text for a text status or filePath for an image/video status');
      }

      const recipients = getStatusRecipients(db);
      if (recipients.length === 0) {
        throw new Error('No status recipients found in contacts table');
      }

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      let content: Record<string, unknown>;
      let statusType: 'text' | 'image' | 'video';

      if (filePath) {
        const media = resolveStatusFile(filePath, session);
        const effectiveCaption = caption ?? text;
        statusType = media.statusType;
        content = media.statusType === 'image'
          ? { image: media.buffer, caption: effectiveCaption, mimetype: media.mimetype }
          : { video: media.buffer, caption: effectiveCaption, mimetype: media.mimetype };
      } else {
        statusType = 'text';
        content = { text: text! };
      }

      const options: Record<string, unknown> = { statusJidList: recipients };
      if (statusType === 'text') {
        if (backgroundColor) options['backgroundColor'] = backgroundColor;
        if (font !== undefined) options['font'] = font;
      }

      const result = await sendStatusWithRetry(sock, content, options, statusType);

      return {
        sent: true,
        statusType,
        recipientCount: recipients.length,
        messageId: result?.key?.id ?? null,
      };
    },
  };
}

function makeListStatuses(deps: StatusDeps): ToolDeclaration {
  const { db, getSock } = deps;

  return {
    name: 'list_statuses',
    description:
      'List stored WhatsApp Status messages grouped by sender. Optionally mark the returned statuses as read (global).',
    schema: ListStatusesSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { limit = 50, sender_jid, mark_read = false } = ListStatusesSchema.parse(params);

      const rows = sender_jid
        ? db.raw.prepare(
          `SELECT *
             FROM messages
            WHERE chat_jid = ?
              AND sender_jid = ?
              AND deleted_at IS NULL
            ORDER BY timestamp DESC, pk DESC
            LIMIT ?`,
        ).all(STATUS_BROADCAST_JID, sender_jid, limit) as unknown as StatusRow[]
        : db.raw.prepare(
          `SELECT *
             FROM messages
            WHERE chat_jid = ?
              AND deleted_at IS NULL
            ORDER BY timestamp DESC, pk DESC
            LIMIT ?`,
        ).all(STATUS_BROADCAST_JID, limit) as unknown as StatusRow[];

      if (mark_read && rows.length > 0) {
        const sock = getSock();
        if (!sock) {
          throw new Error('WhatsApp is not connected');
        }
        const keys = rows.map(parseStatusKey);
        await sock.readMessages(keys as any);
      }

      const grouped = new Map<string, {
        senderJid: string;
        senderName: string | null;
        count: number;
        statuses: ReturnType<typeof rowToMessage>[];
      }>();

      for (const row of rows) {
        const existing = grouped.get(row.sender_jid);
        if (existing) {
          existing.count += 1;
          existing.statuses.push(rowToMessage(row));
          continue;
        }

        grouped.set(row.sender_jid, {
          senderJid: row.sender_jid,
          senderName: row.sender_name ?? null,
          count: 1,
          statuses: [rowToMessage(row)],
        });
      }

      return {
        count: rows.length,
        markedRead: mark_read ? rows.length : 0,
        senders: [...grouped.values()],
      };
    },
  };
}

export function registerStatusTools(registry: ToolRegistry, deps: StatusDeps): void {
  registry.register(makePostStatus(deps));
  registry.register(makeListStatuses(deps));
}
