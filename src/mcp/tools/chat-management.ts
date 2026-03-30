// src/mcp/tools/chat-management.ts
// Chat management tools: list_messages, get_message_context, list_chats,
// get_chat, forward_message, archive_chat, pin_chat, mute_chat,
// mark_messages_read, star_message.

import { z } from 'zod';
import type { ToolDeclaration, SessionContext } from '../types.ts';
import { resolveConversationKey } from '../types.ts';
import type { Database } from '../../core/database.ts';
import type { WhatsAppSocket } from '../../transport/connection.ts';
import { type MessageRow, rowToMessage } from '../../core/messages.ts';

// ---------------------------------------------------------------------------
// list_messages — paginated messages in a conversation (scope: chat)
// ---------------------------------------------------------------------------

const ListMessagesSchema = z.object({
  conversation_key: z.string(),
  limit: z.number().optional(),
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
    handler: async (params, session: SessionContext) => {
      const { message_id, conversation_key: caller_key, context_size = 5 } = GetMessageContextSchema.parse(params);
      const conversation_key = resolveConversationKey(session, caller_key);

      // Fetch the target message and validate ownership
      const target = db.raw
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
  limit: z.number().optional(),
});

function makeListChats(db: Database): ToolDeclaration {
  return {
    name: 'list_chats',
    description:
      'List all WhatsApp conversations with their last message timestamp (global). Returns conversations ordered by most recent activity.',
    schema: ListChatsSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    handler: async (params) => {
      const { limit = 100 } = ListChatsSchema.parse(params);

      const rows = db.raw
        .prepare(
          `SELECT conversation_key,
                  chat_jid,
                  MAX(timestamp) AS last_timestamp,
                  COUNT(*) AS message_count
           FROM messages
           WHERE deleted_at IS NULL
           GROUP BY conversation_key
           ORDER BY last_timestamp DESC
           LIMIT ?`,
        )
        .all(limit) as Array<{
          conversation_key: string;
          chat_jid: string;
          last_timestamp: number;
          message_count: number;
        }>;

      return {
        chats: rows.map((r) => ({
          conversationKey: r.conversation_key,
          chatJid: r.chat_jid,
          lastTimestamp: r.last_timestamp,
          messageCount: r.message_count,
        })),
        count: rows.length,
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
    handler: async (params) => {
      const { conversation_key } = GetChatSchema.parse(params);

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

const ForwardMessageSchema = z.object({
  message_id: z.string(),
  to_jid: z.string(),
});

function makeForwardMessage(db: Database, getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'forward_message',
    description:
      'Forward a WhatsApp message (by message_id) to another chat JID (global).',
    schema: ForwardMessageSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    handler: async (params) => {
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

      // Forward by re-sending the text content (simple forward)
      const text = row.content ?? `[${row.content_type} message]`;
      await sock.sendMessage(to_jid, { text });

      return { forwarded: true, messageId: message_id, toJid: to_jid };
    },
  };
}

// ---------------------------------------------------------------------------
// archive_chat — archive or unarchive a chat (scope: global)
// ---------------------------------------------------------------------------

const ArchiveChatSchema = z.object({
  jid: z.string(),
  archive: z.boolean(),
});

function makeArchiveChat(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'archive_chat',
    description: 'Archive or unarchive a WhatsApp chat (global).',
    schema: ArchiveChatSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    handler: async (params) => {
      const { jid, archive } = ArchiveChatSchema.parse(params);

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      await sock.chatModify({ archive, lastMessages: [] }, jid);
      return { success: true, jid, archive };
    },
  };
}

// ---------------------------------------------------------------------------
// pin_chat — pin or unpin a chat (scope: global)
// ---------------------------------------------------------------------------

const PinChatSchema = z.object({
  jid: z.string(),
  pin: z.boolean(),
});

function makePinChat(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'pin_chat',
    description: 'Pin or unpin a WhatsApp chat (global).',
    schema: PinChatSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    handler: async (params) => {
      const { jid, pin } = PinChatSchema.parse(params);

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      await sock.chatModify({ pin }, jid);
      return { success: true, jid, pin };
    },
  };
}

// ---------------------------------------------------------------------------
// mute_chat — mute or unmute a chat (scope: global)
// ---------------------------------------------------------------------------

const MuteChatSchema = z.object({
  jid: z.string(),
  mute: z.boolean(),
  /** Unix timestamp (seconds) until which to mute; 0 means unmute */
  until: z.number().optional(),
});

function makeMuteChat(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'mute_chat',
    description: 'Mute or unmute a WhatsApp chat (global). Provide until (unix seconds) for timed mute.',
    schema: MuteChatSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    handler: async (params) => {
      const { jid, mute, until } = MuteChatSchema.parse(params);

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      if (mute) {
        const muteEndTime = until ?? (Date.now() / 1000 + 8 * 3600); // default 8h
        await sock.chatModify({ mute: muteEndTime }, jid);
      } else {
        await sock.chatModify({ mute: null }, jid);
      }

      return { success: true, jid, mute };
    },
  };
}

// ---------------------------------------------------------------------------
// mark_messages_read — send read receipts (blue ticks) (scope: global)
// ---------------------------------------------------------------------------

const MarkMessagesReadSchema = z.object({
  jid: z.string(),
  message_ids: z.array(z.string()),
  from_me: z.boolean().optional(),
});

function makeMarkMessagesRead(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'mark_messages_read',
    description:
      'Mark WhatsApp messages as read (send blue ticks) for the given JID (global).',
    schema: MarkMessagesReadSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    handler: async (params) => {
      const { jid, message_ids, from_me = false } = MarkMessagesReadSchema.parse(params);

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      const keys = message_ids.map((id) => ({
        remoteJid: jid,
        id,
        fromMe: from_me,
      }));

      await sock.readMessages(keys);
      return { success: true, jid, count: message_ids.length };
    },
  };
}

// ---------------------------------------------------------------------------
// star_message — star or unstar messages (scope: global)
// ---------------------------------------------------------------------------

const StarMessageSchema = z.object({
  jid: z.string(),
  message_ids: z.array(z.string()),
  star: z.boolean(),
  from_me: z.boolean().optional(),
});

function makeStarMessage(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'star_message',
    description: 'Star or unstar WhatsApp messages (global).',
    schema: StarMessageSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    handler: async (params) => {
      const { jid, message_ids, star, from_me = false } = StarMessageSchema.parse(params);

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      const messages = message_ids.map((id) => ({ id, fromMe: from_me }));
      await sock.star(jid, messages, star);
      return { success: true, jid, count: message_ids.length, star };
    },
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function registerChatManagementTools(
  db: Database,
  getSock: () => WhatsAppSocket | null,
  register: (tool: ToolDeclaration) => void,
): void {
  register(makeListMessages(db));
  register(makeGetMessageContext(db));
  register(makeListChats(db));
  register(makeGetChat(db));
  register(makeForwardMessage(db, getSock));
  register(makeArchiveChat(getSock));
  register(makePinChat(getSock));
  register(makeMuteChat(getSock));
  register(makeMarkMessagesRead(getSock));
  register(makeStarMessage(getSock));
}
