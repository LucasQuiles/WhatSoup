// src/mcp/tools/chat-operations.ts
// Chat operation tools: clear_chat, delete_chat, delete_message_for_me,
// set_disappearing_messages, send_event_message, mark_chat_read, update_push_name,
// fetch_message_history, request_placeholder_resend, get_reactions, get_message_receipts.

import { z } from 'zod';
import { assertConversationAccess, type SessionContext, type ToolDeclaration } from '../types.ts';
import type { Database } from '../../core/database.ts';
import type { ExtendedBaileysSocket } from '../types.ts';
import { createChildLogger } from '../../logger.ts';
import { type SockToolConfig, registerSockTools } from './sock-tool-factory.ts';
import { config } from '../../config.ts';
import { applyOutboundIdentityGuard } from '../../core/outbound-identity/guard.ts';
import { SqliteIdentityStore } from '../../core/outbound-identity/store.ts';

const log = createChildLogger('chat-operations');

function assertMessageConversationAccess(
  db: Database,
  messageId: string,
  session: SessionContext,
  label: string,
): void {
  if (!session.conversationKey) return;
  const row = db.raw
    .prepare('SELECT conversation_key FROM messages WHERE message_id = ? AND deleted_at IS NULL')
    .get(messageId) as { conversation_key: string } | undefined;
  if (!row) {
    throw new Error(`${label} "${messageId}" not found`);
  }
  assertConversationAccess(row.conversation_key, session, label);
}

// ---------------------------------------------------------------------------
// Sock-only tools (W2-01 .. W2-09): clear_chat, delete_chat,
// delete_message_for_me, set_disappearing_messages, send_event_message,
// mark_chat_read, update_push_name, fetch_message_history,
// request_placeholder_resend
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- configs have heterogeneous ZodRawShape types; shared array requires any; expires 2026-12-31
const chatOperationSockConfigs: SockToolConfig<any>[] = [
  {
    name: 'clear_chat',
    description: 'Clear messages from a WhatsApp chat. Provide the message IDs, fromMe flag, and timestamps of the messages to clear.',
    schema: z.object({
      chatJid: z.string(),
      messages: z.array(
        z.object({
          id: z.string(),
          fromMe: z.boolean(),
          timestamp: z.number(),
        }),
      ),
    }),
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'unsafe',
    call: async ({ chatJid, messages }, sock) => {
      await sock.chatModify({ clear: { messages } } as any, chatJid);
      log.info({ chatJid, count: messages.length }, 'chat cleared');
      return { success: true, jid: chatJid, messagesCleared: messages.length };
    },
  },
  {
    name: 'delete_chat',
    description: 'Delete an entire WhatsApp chat. Requires the last message key and timestamp.',
    schema: z.object({
      chatJid: z.string(),
      last_message_key: z.object({
        id: z.string(),
        fromMe: z.boolean(),
      }),
      last_message_timestamp: z.number(),
    }),
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'unsafe',
    call: async ({ chatJid, last_message_key, last_message_timestamp }, sock) => {
      await sock.chatModify(
        {
          delete: true,
          lastMessages: [{ key: last_message_key, messageTimestamp: last_message_timestamp }],
        },
        chatJid,
      );
      log.info({ chatJid }, 'chat deleted');
      return { success: true, jid: chatJid };
    },
  },
  {
    name: 'delete_message_for_me',
    description: 'Delete a message for yourself only (not for everyone). The message remains visible to others.',
    schema: z.object({
      chatJid: z.string(),
      message_id: z.string(),
      from_me: z.boolean(),
      timestamp: z.number(),
    }),
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'safe',
    call: async ({ chatJid, message_id, from_me, timestamp }, sock) => {
      await sock.chatModify(
        {
          deleteForMe: {
            key: { remoteJid: chatJid, id: message_id, fromMe: from_me },
            timestamp,
            deleteMedia: true,
          },
        } as any,
        chatJid,
      );
      log.info({ chatJid, messageId: message_id }, 'message deleted for me');
      return { success: true, jid: chatJid, messageId: message_id };
    },
  },
  // QR-067: set_disappearing_messages moved to a db-aware guarded factory
  // (makeSetDisappearingMessages) — it sent to a caller-supplied jid via
  // sock.sendMessage directly, bypassing the outbound identity guard.
  {
    name: 'send_event_message',
    description: 'Send a calendar event message to a WhatsApp chat.',
    schema: z.object({
      chatJid: z.string(),
      name: z.string(),
      description: z.string().optional(),
      start_time: z.number().describe('Unix timestamp in seconds'),
      end_time: z.number().describe('Unix timestamp in seconds'),
      location: z.string().optional(),
      call_link: z.string().optional(),
    }),
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'unsafe',
    call: async ({ chatJid, name, description, start_time, end_time, location, call_link }, sock) => {
      const event: Record<string, unknown> = {
        name,
        description: description ?? '',
        startTime: start_time,
        endTime: end_time,
      };
      if (location) event.location = location;
      if (call_link) event.callLink = call_link;

      await sock.sendMessage(chatJid, { event } as any);
      log.info({ chatJid, eventName: name }, 'event message sent');
      return { sent: true, event: name };
    },
  },
  {
    name: 'mark_chat_read',
    description: 'Mark a chat as read or unread. Uses chatModify for whole-chat read state.',
    schema: z.object({
      chatJid: z.string(),
      read: z.boolean(),
      last_message_key: z.object({
        id: z.string(),
        fromMe: z.boolean(),
      }),
      last_message_timestamp: z.number(),
    }),
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'safe',
    call: async ({ chatJid, read, last_message_key, last_message_timestamp }, sock) => {
      await sock.chatModify(
        {
          markRead: read,
          lastMessages: [{ key: last_message_key, messageTimestamp: last_message_timestamp }],
        },
        chatJid,
      );
      log.info({ chatJid, read }, 'chat read state updated');
      return { success: true, jid: chatJid, read };
    },
  },
  {
    name: 'update_push_name',
    description: 'Update your WhatsApp push notification name (the name others see).',
    schema: z.object({
      name: z.string(),
    }),
    replayPolicy: 'safe',
    call: async ({ name }, sock) => {
      // Use the bot's own JID as the target; pushNameSetting is a self-setting
      const botJid = sock.user?.id ?? '';
      await sock.chatModify({ pushNameSetting: name } as any, botJid);
      log.info({ name }, 'push name updated');
      return { success: true, name };
    },
  },
  {
    name: 'fetch_message_history',
    description: 'Request WhatsApp to send additional message history. Results arrive via messaging-history.set event.',
    schema: z.object({
      count: z.number(),
      oldest_message_key: z
        .object({
          remoteJid: z.string(),
          id: z.string(),
          fromMe: z.boolean(),
        })
        .optional(),
      oldest_message_timestamp: z.number().optional(),
    }),
    replayPolicy: 'read_only',
    call: async ({ count, oldest_message_key, oldest_message_timestamp }, sock) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- optional zod fields vs required Baileys params; expires 2026-12-31
      await sock.fetchMessageHistory(count, oldest_message_key as any, oldest_message_timestamp as any);
      log.info({ count }, 'message history fetch requested');
      return { requested: true, count };
    },
  },
  {
    name: 'request_placeholder_resend',
    description: 'Request resend of a placeholder message (message that failed to decrypt).',
    schema: z.object({
      message_key: z.object({
        remoteJid: z.string(),
        id: z.string(),
        fromMe: z.boolean(),
      }),
    }),
    replayPolicy: 'safe',
    call: async ({ message_key }, sock) => {
      await sock.requestPlaceholderResend(message_key);
      log.info({ messageKey: message_key }, 'placeholder resend requested');
      return { requested: true, messageKey: message_key };
    },
  },
];

// ---------------------------------------------------------------------------
// W2-10: get_reactions (read-only query)
// ---------------------------------------------------------------------------

const SetDisappearingMessagesSchema = z.object({
  jid: z.string(),
  duration: z.number().describe('Seconds: 0=off, 86400=24h, 604800=7d, 7776000=90d'),
});

/**
 * QR-067: set_disappearing_messages sends to a caller-supplied jid, so it floors
 * the egress through the outbound identity guard first (db-aware factory, mirrors
 * relay_message). db omitted → null store → no block (prior behavior).
 */
function makeSetDisappearingMessages(getSock: () => ExtendedBaileysSocket | null, db?: Database): ToolDeclaration {
  return {
    name: 'set_disappearing_messages',
    description: 'Enable or disable disappearing messages for a chat. Duration in seconds: 0=off, 86400=24h, 604800=7d, 7776000=90d.',
    schema: SetDisappearingMessagesSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { jid, duration } = SetDisappearingMessagesSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      applyOutboundIdentityGuard(jid, { caller: 'mcp', mode: config.outboundIdentityMode }, db ? new SqliteIdentityStore(db.raw) : null);
      const value = duration === 0 ? false : duration;
      await sock.sendMessage(jid, { disappearingMessagesInChat: value } as Parameters<ExtendedBaileysSocket['sendMessage']>[1]);
      log.info({ jid, duration }, 'disappearing messages set');
      return { success: true, jid, duration };
    },
  };
}

const GetReactionsSchema = z.object({
  message_id: z.string(),
});

function makeGetReactions(db: Database): ToolDeclaration {
  return {
    name: 'get_reactions',
    description: 'Get all reactions for a specific message.',
    schema: GetReactionsSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    handler: async (params, session) => {
      const { message_id } = GetReactionsSchema.parse(params);
      assertMessageConversationAccess(db, message_id, session, 'Message reactions');

      const rows = db.raw
        .prepare('SELECT sender_jid, reaction, timestamp FROM reactions WHERE message_id = ? ORDER BY timestamp')
        .all(message_id) as Array<{ sender_jid: string; reaction: string; timestamp: string }>;

      return { reactions: rows, count: rows.length };
    },
  };
}

// ---------------------------------------------------------------------------
// W2-11: get_message_receipts (read-only query)
// ---------------------------------------------------------------------------

const GetReceiptsSchema = z.object({
  message_id: z.string(),
});

function makeGetMessageReceipts(db: Database): ToolDeclaration {
  return {
    name: 'get_message_receipts',
    description: 'Get delivery/read receipts for a specific message.',
    schema: GetReceiptsSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    handler: async (params, session) => {
      const { message_id } = GetReceiptsSchema.parse(params);
      assertMessageConversationAccess(db, message_id, session, 'Message receipts');

      const rows = db.raw
        .prepare('SELECT recipient_jid, type, timestamp FROM receipts WHERE message_id = ? ORDER BY timestamp')
        .all(message_id) as Array<{ recipient_jid: string; type: string; timestamp: string }>;

      return { receipts: rows, count: rows.length };
    },
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function registerChatOperationTools(
  db: Database,
  getSock: () => ExtendedBaileysSocket | null,
  register: (tool: ToolDeclaration) => void,
): void {
  registerSockTools(getSock, chatOperationSockConfigs, register);
  register(makeSetDisappearingMessages(getSock, db)); // QR-067: guarded caller-jid egress
  register(makeGetReactions(db));
  register(makeGetMessageReceipts(db));
}
