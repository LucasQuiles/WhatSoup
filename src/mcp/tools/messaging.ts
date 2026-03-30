// src/mcp/tools/messaging.ts
// Chat-scoped messaging tools: send, reply, react, edit, delete, location,
// contact, poll, pin.

import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import type { ToolRegistry } from '../registry.ts';
import type { SessionContext } from '../types.ts';
import type { ConnectionManager } from '../../transport/connection.ts';
import { formatMentions } from '../../core/mentions.ts';
import type { MessageRow } from '../../core/messages.ts';

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface MessagingDeps {
  connection: ConnectionManager;
  db: DatabaseSync;
}

interface OwnershipResult {
  row?: MessageRow;
  error?: string;
}

function validateMessageOwnership(
  db: DatabaseSync,
  messageId: string,
  session: SessionContext,
): OwnershipResult {
  const row = db
    .prepare('SELECT * FROM messages WHERE message_id = ?')
    .get(messageId) as MessageRow | undefined;

  if (!row) {
    return { error: 'Message not found' };
  }

  if (session.tier === 'chat-scoped') {
    if (!session.conversationKey) {
      return { error: 'Chat-scoped session has no conversation key' };
    }
    if (row.conversation_key !== session.conversationKey) {
      return { error: 'Access denied: message belongs to a different conversation' };
    }
  }

  return { row };
}

// ---------------------------------------------------------------------------
// Register all messaging tools
// ---------------------------------------------------------------------------

export function registerMessagingTools(
  registry: ToolRegistry,
  deps: MessagingDeps,
): void {
  const { connection, db } = deps;

  // ── send_message ──────────────────────────────────────────────────────────

  registry.register({
    name: 'send_message',
    description: 'Send a text message to the current chat. Supports @name and @number mentions.',
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'unsafe',
    schema: z.object({
      chatJid: z.string(),
      text: z.string(),
    }),
    handler: async (params, _session: SessionContext) => {
      const chatJid = params['chatJid'] as string;
      const text = params['text'] as string;

      const { text: formatted, jids: mentions, hasMentions } = formatMentions(
        text,
        connection.contactsDir.contacts,
      );

      try {
        if (hasMentions) {
          await connection.sendRaw(chatJid, { text: formatted, mentions });
        } else {
          await connection.sendRaw(chatJid, { text: formatted });
        }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }

      return { sent: true, text: formatted };
    },
  });

  // ── reply_message ─────────────────────────────────────────────────────────

  registry.register({
    name: 'reply_message',
    description: 'Reply to a specific message by its ID.',
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'unsafe',
    schema: z.object({
      chatJid: z.string(),
      messageId: z.string(),
      text: z.string(),
    }),
    handler: async (params, session: SessionContext) => {
      const chatJid = params['chatJid'] as string;
      const messageId = params['messageId'] as string;
      const text = params['text'] as string;

      const { row, error } = validateMessageOwnership(db, messageId, session);
      if (error) return { error };

      try {
        await connection.sendRaw(chatJid, {
          text,
          contextInfo: {
            stanzaId: row!.message_id,
            participant: row!.sender_jid,
            quotedMessage: { conversation: row!.content ?? '' },
          },
        });
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }

      return { sent: true, quotedMessageId: messageId };
    },
  });

  // ── react_message ─────────────────────────────────────────────────────────

  registry.register({
    name: 'react_message',
    description: 'React to a message with an emoji. Pass empty string to remove reaction.',
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'safe',
    schema: z.object({
      chatJid: z.string(),
      messageId: z.string(),
      emoji: z.string(),
    }),
    handler: async (params, session: SessionContext) => {
      const chatJid = params['chatJid'] as string;
      const messageId = params['messageId'] as string;
      const emoji = params['emoji'] as string;

      const { row, error } = validateMessageOwnership(db, messageId, session);
      if (error) return { error };

      try {
        await connection.sendRaw(chatJid, {
          react: {
            text: emoji,
            key: {
              remoteJid: chatJid,
              id: row!.message_id,
              fromMe: Boolean(row!.is_from_me),
            },
          },
        });
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }

      return { sent: true, emoji, messageId };
    },
  });

  // ── edit_message ──────────────────────────────────────────────────────────

  registry.register({
    name: 'edit_message',
    description: 'Edit a message you previously sent.',
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'safe',
    schema: z.object({
      chatJid: z.string(),
      messageId: z.string(),
      newText: z.string(),
    }),
    handler: async (params, session: SessionContext) => {
      const chatJid = params['chatJid'] as string;
      const messageId = params['messageId'] as string;
      const newText = params['newText'] as string;

      const { row, error } = validateMessageOwnership(db, messageId, session);
      if (error) return { error };

      if (!row!.is_from_me) {
        return { error: 'Can only edit your own messages' };
      }

      try {
        await connection.sendRaw(chatJid, {
          text: newText,
          edit: {
            remoteJid: chatJid,
            id: row!.message_id,
            fromMe: true,
          },
        });
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }

      return { edited: true, messageId, newText };
    },
  });

  // ── delete_message ────────────────────────────────────────────────────────

  registry.register({
    name: 'delete_message',
    description: 'Delete a message (for everyone). Only works on your own messages unless you are a group admin.',
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'safe',
    schema: z.object({
      chatJid: z.string(),
      messageId: z.string(),
    }),
    handler: async (params, session: SessionContext) => {
      const chatJid = params['chatJid'] as string;
      const messageId = params['messageId'] as string;

      const { row, error } = validateMessageOwnership(db, messageId, session);
      if (error) return { error };

      try {
        await connection.sendRaw(chatJid, {
          delete: {
            remoteJid: chatJid,
            id: row!.message_id,
            fromMe: Boolean(row!.is_from_me),
          },
        });
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }

      return { deleted: true, messageId };
    },
  });

  // ── send_location ─────────────────────────────────────────────────────────

  registry.register({
    name: 'send_location',
    description: 'Send a location pin to the current chat.',
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'unsafe',
    schema: z.object({
      chatJid: z.string(),
      latitude: z.number(),
      longitude: z.number(),
      name: z.string().optional(),
      address: z.string().optional(),
    }),
    handler: async (params, _session: SessionContext) => {
      const chatJid = params['chatJid'] as string;
      const latitude = params['latitude'] as number;
      const longitude = params['longitude'] as number;
      const name = params['name'] as string | undefined;
      const address = params['address'] as string | undefined;

      try {
        await connection.sendRaw(chatJid, {
          location: {
            degreesLatitude: latitude,
            degreesLongitude: longitude,
            name,
            address,
          },
        });
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }

      return { sent: true, latitude, longitude };
    },
  });

  // ── send_contact ──────────────────────────────────────────────────────────

  registry.register({
    name: 'send_contact',
    description: 'Send a contact card to the current chat.',
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'unsafe',
    schema: z.object({
      chatJid: z.string(),
      displayName: z.string(),
      phone: z.string(),
    }),
    handler: async (params, _session: SessionContext) => {
      const chatJid = params['chatJid'] as string;
      const displayName = params['displayName'] as string;
      const phone = params['phone'] as string;

      // vCard format required by Baileys contact message
      const vcard =
        `BEGIN:VCARD\n` +
        `VERSION:3.0\n` +
        `FN:${displayName}\n` +
        `TEL;type=CELL;type=VOICE;waid=${phone.replace(/\D/g, '')}:+${phone.replace(/\D/g, '')}\n` +
        `END:VCARD`;

      try {
        await connection.sendRaw(chatJid, {
          contacts: {
            displayName,
            contacts: [{ vcard }],
          },
        });
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }

      return { sent: true, displayName, phone };
    },
  });

  // ── send_poll ─────────────────────────────────────────────────────────────

  registry.register({
    name: 'send_poll',
    description: 'Send a poll to the current chat.',
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'unsafe',
    schema: z.object({
      chatJid: z.string(),
      question: z.string(),
      options: z.array(z.string()),
      selectableCount: z.number().optional(),
    }),
    handler: async (params, _session: SessionContext) => {
      const chatJid = params['chatJid'] as string;
      const question = params['question'] as string;
      const options = params['options'] as string[];
      const selectableCount = params['selectableCount'] as number | undefined;

      if (options.length < 2) {
        return { error: 'Poll requires at least 2 options' };
      }

      if (options.length > 12) {
        return { error: 'Poll allows at most 12 options' };
      }

      try {
        await connection.sendRaw(chatJid, {
          poll: {
            name: question,
            values: options,
            selectableCount: selectableCount ?? 1,
          },
        });
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }

      return { sent: true, question, options };
    },
  });

  // ── pin_message ───────────────────────────────────────────────────────────

  registry.register({
    name: 'pin_message',
    description: 'Pin or unpin a message in the current chat.',
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'safe',
    schema: z.object({
      chatJid: z.string(),
      messageId: z.string(),
      pin: z.boolean(),
      duration: z.enum(['24h', '7d', '30d']).optional(),
    }),
    handler: async (params, session: SessionContext) => {
      const chatJid = params['chatJid'] as string;
      const messageId = params['messageId'] as string;
      const pin = params['pin'] as boolean;
      const duration = (params['duration'] as string | undefined) ?? '7d';

      const { row, error } = validateMessageOwnership(db, messageId, session);
      if (error) return { error };

      // Duration in seconds mapping
      const durationSeconds: Record<string, 86400 | 604800 | 2592000> = {
        '24h': 86400,
        '7d': 604800,
        '30d': 2592000,
      };

      // proto.PinInChat.Type — 1 = pin, 2 = unpin
      const pinType = pin ? 1 : 2;

      try {
        await connection.sendRaw(chatJid, {
          pin: {
            remoteJid: chatJid,
            id: row!.message_id,
            fromMe: Boolean(row!.is_from_me),
          },
          type: pinType,
          time: pin ? durationSeconds[duration] : undefined,
        });
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }

      return { pinned: pin, messageId, duration: pin ? duration : undefined };
    },
  });
}
