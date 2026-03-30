// src/mcp/tools/chat-operations.ts
// Chat operation tools: clear_chat, delete_chat, delete_message_for_me,
// set_disappearing_messages, send_event_message, mark_chat_read, update_push_name,
// fetch_message_history, request_placeholder_resend, get_reactions, get_message_receipts.

import { z } from 'zod';
import type { ToolDeclaration } from '../types.ts';
import type { Database } from '../../core/database.ts';
import type { WhatsAppSocket } from '../../transport/connection.ts';
import { createChildLogger } from '../../logger.ts';

const log = createChildLogger('chat-operations');

// ---------------------------------------------------------------------------
// W2-01: clear_chat
// ---------------------------------------------------------------------------

const ClearChatSchema = z.object({
  jid: z.string(),
  messages: z.array(
    z.object({
      id: z.string(),
      fromMe: z.boolean(),
      timestamp: z.number(),
    }),
  ),
});

function makeClearChat(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'clear_chat',
    description: 'Clear messages from a WhatsApp chat. Provide the message IDs, fromMe flag, and timestamps of the messages to clear.',
    schema: ClearChatSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'unsafe',
    handler: async (params) => {
      const { jid, messages } = ClearChatSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');

      await sock.chatModify({ clear: { messages } }, jid);
      log.info({ jid, count: messages.length }, 'chat cleared');
      return { success: true, jid, messagesCleared: messages.length };
    },
  };
}

// ---------------------------------------------------------------------------
// W2-02: delete_chat
// ---------------------------------------------------------------------------

const DeleteChatSchema = z.object({
  jid: z.string(),
  last_message_key: z.object({
    id: z.string(),
    fromMe: z.boolean(),
  }),
  last_message_timestamp: z.number(),
});

function makeDeleteChat(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'delete_chat',
    description: 'Delete an entire WhatsApp chat. Requires the last message key and timestamp.',
    schema: DeleteChatSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'unsafe',
    handler: async (params) => {
      const { jid, last_message_key, last_message_timestamp } = DeleteChatSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');

      await sock.chatModify(
        {
          delete: true,
          lastMessages: [{ key: last_message_key, messageTimestamp: last_message_timestamp }],
        },
        jid,
      );
      log.info({ jid }, 'chat deleted');
      return { success: true, jid };
    },
  };
}

// ---------------------------------------------------------------------------
// W2-03: delete_message_for_me
// ---------------------------------------------------------------------------

const DeleteMessageForMeSchema = z.object({
  jid: z.string(),
  message_id: z.string(),
  from_me: z.boolean(),
  timestamp: z.number(),
});

function makeDeleteMessageForMe(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'delete_message_for_me',
    description: 'Delete a message for yourself only (not for everyone). The message remains visible to others.',
    schema: DeleteMessageForMeSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { jid, message_id, from_me, timestamp } = DeleteMessageForMeSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');

      await sock.chatModify(
        {
          deleteForMe: {
            key: { remoteJid: jid, id: message_id, fromMe: from_me },
            timestamp,
          },
        },
        jid,
      );
      log.info({ jid, messageId: message_id }, 'message deleted for me');
      return { success: true, jid, messageId: message_id };
    },
  };
}

// ---------------------------------------------------------------------------
// W2-04: set_disappearing_messages
// ---------------------------------------------------------------------------

const SetDisappearingSchema = z.object({
  jid: z.string(),
  duration: z.number().describe('Seconds: 0=off, 86400=24h, 604800=7d, 7776000=90d'),
});

function makeSetDisappearingMessages(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'set_disappearing_messages',
    description: 'Enable or disable disappearing messages for a chat. Duration in seconds: 0=off, 86400=24h, 604800=7d, 7776000=90d.',
    schema: SetDisappearingSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { jid, duration } = SetDisappearingSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');

      const value = duration === 0 ? false : duration;
      await sock.sendMessage(jid, { disappearingMessagesInChat: value } as any);
      log.info({ jid, duration }, 'disappearing messages set');
      return { success: true, jid, duration };
    },
  };
}

// ---------------------------------------------------------------------------
// W2-05: send_event_message
// ---------------------------------------------------------------------------

const SendEventSchema = z.object({
  chatJid: z.string(),
  name: z.string(),
  description: z.string().optional(),
  start_time: z.number().describe('Unix timestamp in seconds'),
  end_time: z.number().describe('Unix timestamp in seconds'),
  location: z.string().optional(),
  call_link: z.string().optional(),
});

function makeSendEventMessage(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'send_event_message',
    description: 'Send a calendar event message to a WhatsApp chat.',
    schema: SendEventSchema,
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'unsafe',
    handler: async (params) => {
      const { chatJid, name, description, start_time, end_time, location, call_link } =
        SendEventSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');

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
  };
}

// ---------------------------------------------------------------------------
// W2-06: mark_chat_read
// ---------------------------------------------------------------------------

const MarkChatReadSchema = z.object({
  jid: z.string(),
  read: z.boolean(),
  last_message_key: z.object({
    id: z.string(),
    fromMe: z.boolean(),
  }),
  last_message_timestamp: z.number(),
});

function makeMarkChatRead(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'mark_chat_read',
    description: 'Mark a chat as read or unread. Uses chatModify for whole-chat read state.',
    schema: MarkChatReadSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { jid, read, last_message_key, last_message_timestamp } = MarkChatReadSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');

      await sock.chatModify(
        {
          markRead: read,
          lastMessages: [{ key: last_message_key, messageTimestamp: last_message_timestamp }],
        },
        jid,
      );
      log.info({ jid, read }, 'chat read state updated');
      return { success: true, jid, read };
    },
  };
}

// ---------------------------------------------------------------------------
// W2-07: update_push_name
// ---------------------------------------------------------------------------

const UpdatePushNameSchema = z.object({
  name: z.string(),
});

function makeUpdatePushName(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'update_push_name',
    description: 'Update your WhatsApp push notification name (the name others see).',
    schema: UpdatePushNameSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { name } = UpdatePushNameSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');

      await sock.chatModify({ pushNameSetting: name } as any, '');
      log.info({ name }, 'push name updated');
      return { success: true, name };
    },
  };
}

// ---------------------------------------------------------------------------
// W2-08: fetch_message_history
// ---------------------------------------------------------------------------

const FetchHistorySchema = z.object({
  count: z.number(),
  oldest_message_key: z
    .object({
      remoteJid: z.string(),
      id: z.string(),
      fromMe: z.boolean(),
    })
    .optional(),
  oldest_message_timestamp: z.number().optional(),
});

function makeFetchMessageHistory(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'fetch_message_history',
    description: 'Request WhatsApp to send additional message history. Results arrive via messaging-history.set event.',
    schema: FetchHistorySchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    handler: async (params) => {
      const { count, oldest_message_key, oldest_message_timestamp } = FetchHistorySchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');

      await (sock as any).fetchMessageHistory(count, oldest_message_key, oldest_message_timestamp);
      log.info({ count }, 'message history fetch requested');
      return { requested: true, count };
    },
  };
}

// ---------------------------------------------------------------------------
// W2-09: request_placeholder_resend
// ---------------------------------------------------------------------------

const PlaceholderResendSchema = z.object({
  message_key: z.object({
    remoteJid: z.string(),
    id: z.string(),
    fromMe: z.boolean(),
  }),
});

function makeRequestPlaceholderResend(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'request_placeholder_resend',
    description: 'Request resend of a placeholder message (message that failed to decrypt).',
    schema: PlaceholderResendSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { message_key } = PlaceholderResendSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');

      await (sock as any).requestPlaceholderResend(message_key);
      log.info({ messageKey: message_key }, 'placeholder resend requested');
      return { requested: true, messageKey: message_key };
    },
  };
}

// ---------------------------------------------------------------------------
// W2-10: get_reactions (read-only query)
// ---------------------------------------------------------------------------

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
    handler: async (params) => {
      const { message_id } = GetReactionsSchema.parse(params);

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
    handler: async (params) => {
      const { message_id } = GetReceiptsSchema.parse(params);

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
  getSock: () => WhatsAppSocket | null,
  register: (tool: ToolDeclaration) => void,
): void {
  register(makeClearChat(getSock));
  register(makeDeleteChat(getSock));
  register(makeDeleteMessageForMe(getSock));
  register(makeSetDisappearingMessages(getSock));
  register(makeSendEventMessage(getSock));
  register(makeMarkChatRead(getSock));
  register(makeUpdatePushName(getSock));
  register(makeFetchMessageHistory(getSock));
  register(makeRequestPlaceholderResend(getSock));
  register(makeGetReactions(db));
  register(makeGetMessageReceipts(db));
}
