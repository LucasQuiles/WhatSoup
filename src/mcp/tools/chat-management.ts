// src/mcp/tools/chat-management.ts
// Chat management tools: list_messages, get_message_context, list_chats,
// get_chat, forward_message, archive_chat, pin_chat, mute_chat,
// mark_messages_read, star_message.

import { z } from 'zod';
import type { ToolDeclaration, SessionContext } from '../types.ts';
import { assertConversationAccess, resolveConversationKey } from '../types.ts';
import type { Database } from '../../core/database.ts';
import type { ExtendedBaileysSocket } from '../types.ts';
import { type MessageRow, rowToMessage } from '../../core/messages.ts';
import { createChildLogger } from '../../logger.ts';
import { nowUnixSec } from '../../fleet/time-utils.ts';
import { conversationRefToKey, toConversationKey } from '../../core/conversation-key.ts';
import { DOMAIN_PERSONAL, DOMAIN_LID, DOMAIN_GROUP } from '../../core/jid-constants.ts';
import { type SockToolConfig, registerSockTools } from './sock-tool-factory.ts';
import { config } from '../../config.ts';
import { SqliteIdentityStore } from '../../core/outbound-identity/store.ts';
import { applyOutboundIdentityGuard } from '../../core/outbound-identity/guard.ts';

const log = createChildLogger('chat-management');
const SQLITE_READ_LIMIT_MAX = 1000;
const LIST_CHATS_PAGE_MAX = 100_000;
const SqliteReadLimitSchema = z.number().int().positive().max(SQLITE_READ_LIMIT_MAX);
const ListChatsPageSchema = z.number().int().nonnegative().max(LIST_CHATS_PAGE_MAX);

// ---------------------------------------------------------------------------
// list_messages — paginated messages in a conversation (scope: chat)
// ---------------------------------------------------------------------------

const ListMessagesSchema = z.object({
  conversation_key: z.string(),
  limit: SqliteReadLimitSchema.optional(),
  before_pk: z.number().optional(),
});

function makeListMessages(db: Database): ToolDeclaration {
  return {
    name: 'list_messages',
    description:
      'List messages in a WhatsApp conversation (paginated). Use before_pk for cursor-based pagination. Returns messages ordered oldest-first within the page.',
    schema: ListMessagesSchema,
    scope: 'chat',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    handler: async (params, session: SessionContext) => {
      const { conversation_key: caller_key, limit = 50, before_pk } = ListMessagesSchema.parse(params);
      const conversation_key = resolveConversationKey(session, caller_key);

      let rows: MessageRow[];
      if (before_pk !== undefined) {
        rows = db.raw
          .prepare(
            `SELECT * FROM messages
             WHERE conversation_key = ?
               AND pk < ?
               AND deleted_at IS NULL
             ORDER BY pk DESC
             LIMIT ?`,
          )
          .all(conversation_key, before_pk, limit) as unknown as MessageRow[];
      } else {
        rows = db.raw
          .prepare(
            `SELECT * FROM messages
             WHERE conversation_key = ?
               AND deleted_at IS NULL
             ORDER BY pk DESC
             LIMIT ?`,
          )
          .all(conversation_key, limit) as unknown as MessageRow[];
      }

      // Return chronologically
      rows.reverse();
      return { messages: rows.map(rowToMessage), count: rows.length };
    },
  };
}

// ---------------------------------------------------------------------------
// get_message_context — messages surrounding a specific message (scope: chat)
// ---------------------------------------------------------------------------

const GetMessageContextSchema = z.object({
  message_id: z.string(),
  conversation_key: z.string(),
  context_size: z.number().optional(),
});

function makeGetMessageContext(db: Database): ToolDeclaration {
  return {
    name: 'get_message_context',
    description:
      'Get messages surrounding a specific message in a conversation. Validates that the message belongs to the given conversation_key.',
    schema: GetMessageContextSchema,
    scope: 'chat',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    handler: async (params, session: SessionContext) => {
      const { message_id, conversation_key: caller_key, context_size = 5 } = GetMessageContextSchema.parse(params);
      const conversation_key = resolveConversationKey(session, caller_key);

      const target = session.tier === 'chat-scoped'
        ? db.raw
            .prepare(
              `SELECT * FROM messages
               WHERE message_id = ?
                 AND conversation_key = ?
                 AND deleted_at IS NULL`,
            )
            .get(message_id, conversation_key) as unknown as MessageRow | undefined
        : db.raw
            .prepare(
              `SELECT * FROM messages
               WHERE message_id = ?
                 AND deleted_at IS NULL`,
            )
            .get(message_id) as unknown as MessageRow | undefined;

      if (!target) {
        throw new Error(`Message "${message_id}" not found`);
      }

      if (target.conversation_key !== conversation_key) {
        throw new Error(
          `Message "${message_id}" belongs to conversation "${target.conversation_key}", not "${conversation_key}"`,
        );
      }

      const before = db.raw
        .prepare(
          `SELECT * FROM messages
           WHERE conversation_key = ?
             AND pk < ?
             AND deleted_at IS NULL
           ORDER BY pk DESC
           LIMIT ?`,
        )
        .all(conversation_key, target.pk, context_size) as unknown as MessageRow[];

      const after = db.raw
        .prepare(
          `SELECT * FROM messages
           WHERE conversation_key = ?
             AND pk > ?
             AND deleted_at IS NULL
           ORDER BY pk ASC
           LIMIT ?`,
        )
        .all(conversation_key, target.pk, context_size) as unknown as MessageRow[];

      before.reverse();

      return {
        before: before.map(rowToMessage),
        target: rowToMessage(target),
        after: after.map(rowToMessage),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// list_chats — all distinct conversations with last activity (scope: global)
// ---------------------------------------------------------------------------

const ListChatsSchema = z.object({
  limit: SqliteReadLimitSchema.optional(),
  page: ListChatsPageSchema.optional(),
  query: z.string().optional(),
  sort_by: z.enum(['last_active', 'name']).optional(),
  include_last_message: z.boolean().optional(),
});

function contentPreview(contentText: string | null, content: string | null): string | null {
  const text = contentText ?? content;
  if (text === null) return null;
  return text.length > 100 ? `${text.slice(0, 97)}...` : text;
}

function escapeSqlLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function makeListChats(db: Database): ToolDeclaration {
  return {
    name: 'list_chats',
    description:
      'List WhatsApp conversations with optional query filtering, pagination, sorting, and last-message previews (global).',
    schema: ListChatsSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    handler: async (params) => {
      const {
        limit = 100,
        page = 0,
        query,
        sort_by = 'last_active',
        include_last_message = false,
      } = ListChatsSchema.parse(params);
      const trimmedQuery = query?.trim();
      const likeQuery = trimmedQuery ? `%${escapeSqlLikePattern(trimmedQuery.toLowerCase())}%` : null;
      const offset = page * limit;

      const rows = db.raw
        .prepare(
          `WITH base_conversation_rows AS (
             SELECT m.conversation_key,
                    COALESCE(c.jid, (
                      SELECT m2.chat_jid
                      FROM messages m2
                      WHERE m2.conversation_key = m.conversation_key
                        AND m2.deleted_at IS NULL
                      ORDER BY m2.timestamp DESC, m2.pk DESC
                      LIMIT 1
                    )) AS chat_jid,
                    MAX(m.timestamp) AS last_timestamp,
                    COUNT(*) AS message_count,
                    c.name,
                    c.unread_count,
                    c.is_archived,
                    c.is_pinned,
                    c.mute_until,
                    c.ephemeral_duration
             FROM messages m
             LEFT JOIN chats c ON c.conversation_key = m.conversation_key
             WHERE m.deleted_at IS NULL
             GROUP BY m.conversation_key

             UNION ALL

             SELECT c2.conversation_key,
                    c2.jid AS chat_jid,
                    NULL AS last_timestamp,
                    0 AS message_count,
                    c2.name,
                    c2.unread_count,
                    c2.is_archived,
                    c2.is_pinned,
                    c2.mute_until,
                    c2.ephemeral_duration
             FROM chats c2
             WHERE c2.conversation_key NOT IN (
               SELECT DISTINCT conversation_key FROM messages WHERE deleted_at IS NULL
             )
           ), conversation_rows AS (
             SELECT b.*, lm.phone_jid
             FROM base_conversation_rows b
             LEFT JOIN lid_mappings lm
               ON b.chat_jid = lm.lid || '@lid'
               OR (
                 instr(b.chat_jid, ':') > 1
                 AND substr(b.chat_jid, 1, instr(b.chat_jid, ':') - 1) = lm.lid
                 AND length(b.chat_jid) > instr(b.chat_jid, ':') + 4
                 AND substr(b.chat_jid, -4) = '@lid'
               )
           ), filtered_rows AS (
             SELECT *
             FROM conversation_rows
             WHERE ? IS NULL
                OR lower(conversation_key) LIKE ? ESCAPE '\\'
                OR lower(chat_jid) LIKE ? ESCAPE '\\'
                OR lower(COALESCE(name, '')) LIKE ? ESCAPE '\\'
                OR lower(COALESCE(phone_jid, '')) LIKE ? ESCAPE '\\'
           ), paged_rows AS (
             SELECT *
             FROM filtered_rows
             ORDER BY
               CASE WHEN ? = 'name' THEN lower(COALESCE(name, conversation_key)) END ASC,
               CASE WHEN ? = 'last_active' THEN last_timestamp END DESC NULLS LAST,
               conversation_key ASC
             LIMIT ? OFFSET ?
           ), latest_messages AS (
             SELECT *
             FROM (
               SELECT m.*,
                      ROW_NUMBER() OVER (
                        PARTITION BY m.conversation_key
                        ORDER BY m.timestamp DESC, m.pk DESC
                      ) AS rn
               FROM messages m
               WHERE m.deleted_at IS NULL
                 AND m.conversation_key IN (SELECT conversation_key FROM paged_rows)
             ) latest_ranked
             WHERE rn = 1
           )
           SELECT paged_rows.*,
                  latest.message_id AS last_message_id,
                  latest.sender_name AS last_sender_name,
                  latest.content AS last_content,
                  latest.content_text AS last_content_text,
                  latest.content_type AS last_content_type,
                  latest.timestamp AS last_message_timestamp
           FROM paged_rows
           LEFT JOIN latest_messages latest
             ON latest.conversation_key = paged_rows.conversation_key
           ORDER BY
             CASE WHEN ? = 'name' THEN lower(COALESCE(name, paged_rows.conversation_key)) END ASC,
             CASE WHEN ? = 'last_active' THEN last_timestamp END DESC NULLS LAST,
             paged_rows.conversation_key ASC`,
        )
        .all(
          likeQuery,
          likeQuery,
          likeQuery,
          likeQuery,
          likeQuery,
          sort_by,
          sort_by,
          limit,
          offset,
          sort_by,
          sort_by,
        ) as Array<{
          conversation_key: string;
          chat_jid: string;
          last_timestamp: number | null;
          message_count: number;
          name: string | null;
          unread_count: number | null;
          is_archived: number | null;
          is_pinned: number | null;
          mute_until: string | null;
          ephemeral_duration: number | null;
          last_message_id: string | null;
          last_sender_name: string | null;
          last_content: string | null;
          last_content_text: string | null;
          last_content_type: MessageRow['content_type'] | null;
          last_message_timestamp: number | null;
        }>;

      log.debug({
        hasQuery: likeQuery !== null,
        limit,
        page,
        sortBy: sort_by,
        includeLastMessage: include_last_message,
        resultCount: rows.length,
      }, 'list_chats completed');

      return {
        chats: rows.map((r) => ({
          conversationKey: r.conversation_key,
          chatJid: r.chat_jid,
          lastTimestamp: r.last_timestamp ?? undefined,
          messageCount: r.message_count,
          name: r.name ?? undefined,
          unreadCount: r.unread_count ?? undefined,
          isArchived: r.is_archived ? true : undefined,
          isPinned: r.is_pinned ? true : undefined,
          muteUntil: r.mute_until ?? undefined,
          ephemeralDuration: r.ephemeral_duration ?? undefined,
          ...(include_last_message ? {
            lastMessage: r.last_message_id ? {
              messageId: r.last_message_id,
              senderName: r.last_sender_name ?? null,
              contentPreview: contentPreview(r.last_content_text, r.last_content),
              contentType: r.last_content_type,
              timestamp: r.last_message_timestamp,
            } : null,
          } : {}),
        })),
        count: rows.length,
        page,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// get_chat — single conversation details (scope: global)
// ---------------------------------------------------------------------------

const GetChatSchema = z.object({
  conversation_key: z.string(),
});

function makeGetChat(db: Database): ToolDeclaration {
  return {
    name: 'get_chat',
    description: 'Get details for a single WhatsApp conversation (global).',
    schema: GetChatSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    handler: async (params) => {
      const { conversation_key: rawKey } = GetChatSchema.parse(params);
      // Accept a raw transport JID or an already-canonical DB key without
      // double-encoding AppleID keys that contain their own @.
      const conversation_key = conversationRefToKey(rawKey);

      const row = db.raw
        .prepare(
          `SELECT conversation_key,
                  chat_jid,
                  MAX(timestamp) AS last_timestamp,
                  COUNT(*) AS message_count,
                  MIN(timestamp) AS first_timestamp
           FROM messages
           WHERE conversation_key = ?
             AND deleted_at IS NULL`,
        )
        .get(conversation_key) as {
          conversation_key: string;
          chat_jid: string;
          last_timestamp: number | null;
          message_count: number;
          first_timestamp: number | null;
        } | undefined;

      if (!row || row.last_timestamp === null) {
        throw new Error(`Conversation "${conversation_key}" not found`);
      }

      return {
        conversationKey: row.conversation_key,
        chatJid: row.chat_jid,
        lastTimestamp: row.last_timestamp,
        firstTimestamp: row.first_timestamp,
        messageCount: row.message_count,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// forward_message — forward a stored message to another chat (scope: global)
// ---------------------------------------------------------------------------

// QR-109: forward_message is a scope:'global' egress tool. Validate to_jid at the
// tool boundary instead of accepting any z.string(). toConversationKey is
// non-injective (a personal local part containing the '_at_' separator collides
// with a group conversation key), so an unvalidated to_jid could pass the
// cross-conversation access check under a key it doesn't actually route to. Reject
// anything that isn't a well-formed, routable WhatsApp JID: <local>@<domain> for a
// known domain, non-empty local part with no whitespace/'@', and no '_at_'
// separator. Real forward targets (<digits>@s.whatsapp.net, <lid>@lid,
// <group>@g.us) never contain '_at_', so this has no legitimate-traffic impact.
const FORWARDABLE_DOMAINS = new Set<string>([DOMAIN_PERSONAL, DOMAIN_LID, DOMAIN_GROUP]);
export function isForwardableJid(jid: string): boolean {
  const at = jid.lastIndexOf('@');
  if (at <= 0) return false;
  const local = jid.slice(0, at);
  const domain = jid.slice(at + 1);
  if (!FORWARDABLE_DOMAINS.has(domain)) return false;
  if (local.length === 0 || local.includes('@') || /\s/.test(local)) return false;
  if (local.includes('_at_')) return false; // conversation-key separator collision
  return true;
}

const ForwardMessageSchema = z.object({
  message_id: z.string(),
  to_jid: z.string().refine(isForwardableJid, {
    message: 'to_jid must be a routable WhatsApp JID (<local>@s.whatsapp.net|lid|g.us, no "_at_")',
  }),
});

function makeForwardMessage(db: Database, getSock: () => ExtendedBaileysSocket | null): ToolDeclaration {
  return {
    name: 'forward_message',
    description:
      'Forward a WhatsApp message (by message_id) to another chat JID (global).',
    schema: ForwardMessageSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'unsafe',
    handler: async (params, session) => {
      const { message_id, to_jid } = ForwardMessageSchema.parse(params);

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      // Look up the stored message to get its raw content for forwarding
      const row = db.raw
        .prepare(`SELECT * FROM messages WHERE message_id = ? AND deleted_at IS NULL`)
        .get(message_id) as MessageRow | undefined;

      if (!row) {
        throw new Error(`Message "${message_id}" not found`);
      }

      if (session.conversationKey) {
        assertConversationAccess(row.conversation_key, session, 'Forwarded message');
        let targetConversationKey: string;
        try {
          targetConversationKey = toConversationKey(to_jid);
        } catch {
          throw new Error(`Invalid to_jid "${to_jid}": must be a valid JID`);
        }
        assertConversationAccess(targetConversationKey, session, 'Forward target');
      }

      // Outbound identity floor: forward_message is a free-recipient raw-socket
      // egress that bypasses the Messenger methods, so guard it here. One call
      // covers both the native-forward and the text-fallback sends below.
      applyOutboundIdentityGuard(
        to_jid,
        { caller: 'mcp', mode: config.outboundIdentityMode },
        new SqliteIdentityStore(db.raw),
      );

      // Try true forward via raw Baileys proto (raw_message column may not exist yet)
      let rawMessage: string | null = null;
      try {
        const rawRow = db.raw
          .prepare('SELECT raw_message FROM messages WHERE message_id = ?')
          .get(message_id) as { raw_message: string | null } | undefined;
        rawMessage = rawRow?.raw_message ?? null;
      } catch (err) {
        log.debug({ err, messageId: message_id }, 'raw_message lookup failed — falling back to text forward');
      }

      if (rawMessage) {
        try {
          const waMessage = JSON.parse(rawMessage);
          await sock.sendMessage(to_jid, { forward: waMessage, force: true } as any);
          return { forwarded: true, messageId: message_id, toJid: to_jid, method: 'native' };
        } catch (err) {
          log.warn({ err, messageId: message_id }, 'native forward failed, falling back to text');
        }
      }

      // Fallback: re-send as plain text
      const text = row.content ?? `[${row.content_type} message]`;
      await sock.sendMessage(to_jid, { text });

      return { forwarded: true, messageId: message_id, toJid: to_jid, method: 'text' };
    },
  };
}

// ---------------------------------------------------------------------------
// Sock-only tools: archive_chat, pin_chat, mute_chat, mark_messages_read,
// star_message (all scope: global)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- configs have heterogeneous ZodRawShape types; shared array requires any; expires 2026-12-31
const chatManagementSockConfigs: SockToolConfig<any>[] = [
  {
    name: 'archive_chat',
    description: 'Archive or unarchive a WhatsApp chat (global).',
    schema: z.object({
      jid: z.string(),
      archive: z.boolean(),
    }),
    replayPolicy: 'safe',
    call: async ({ jid, archive }, sock) => {
      await sock.chatModify({ archive, lastMessages: [] }, jid);
      return { success: true, jid, archive };
    },
  },
  {
    name: 'pin_chat',
    description: 'Pin or unpin a WhatsApp chat (global).',
    schema: z.object({
      jid: z.string(),
      pin: z.boolean(),
    }),
    replayPolicy: 'safe',
    call: async ({ jid, pin }, sock) => {
      await sock.chatModify({ pin }, jid);
      return { success: true, jid, pin };
    },
  },
  {
    name: 'mute_chat',
    description: 'Mute or unmute a WhatsApp chat (global). Provide until (unix seconds) for timed mute.',
    schema: z.object({
      jid: z.string(),
      mute: z.boolean(),
      /** Unix timestamp (seconds) until which to mute; 0 means unmute */
      until: z.number().optional(),
    }),
    replayPolicy: 'safe',
    call: async ({ jid, mute, until }, sock) => {
      if (mute) {
        const muteEndTime = until ?? (nowUnixSec() + 8 * 3600); // default 8h
        await sock.chatModify({ mute: muteEndTime }, jid);
      } else {
        await sock.chatModify({ mute: null }, jid);
      }

      return { success: true, jid, mute };
    },
  },
  {
    name: 'mark_messages_read',
    description:
      'Mark WhatsApp messages as read (send blue ticks) for the given JID (global).',
    schema: z.object({
      jid: z.string(),
      message_ids: z.array(z.string()),
      from_me: z.boolean().optional(),
    }),
    replayPolicy: 'safe',
    call: async ({ jid, message_ids, from_me = false }, sock) => {
      const keys = message_ids.map((id: string) => ({
        remoteJid: jid,
        id,
        fromMe: from_me,
      }));

      await sock.readMessages(keys);
      return { success: true, jid, count: message_ids.length };
    },
  },
  {
    name: 'star_message',
    description: 'Star or unstar WhatsApp messages (global).',
    schema: z.object({
      jid: z.string(),
      message_ids: z.array(z.string()),
      star: z.boolean(),
      from_me: z.boolean().optional(),
    }),
    replayPolicy: 'safe',
    call: async ({ jid, message_ids, star, from_me = false }, sock) => {
      const messages = message_ids.map((id: string) => ({ id, fromMe: from_me }));
      await sock.star(jid, messages, star);
      return { success: true, jid, count: message_ids.length, star };
    },
  },
];

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function registerChatManagementTools(
  db: Database,
  getSock: () => ExtendedBaileysSocket | null,
  register: (tool: ToolDeclaration) => void,
): void {
  register(makeListMessages(db));
  register(makeGetMessageContext(db));
  register(makeListChats(db));
  register(makeGetChat(db));
  register(makeForwardMessage(db, getSock));
  registerSockTools(getSock, chatManagementSockConfigs, register);
}
