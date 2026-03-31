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
// Error sanitization — prevent raw API/protocol errors from leaking to agents
// ---------------------------------------------------------------------------

function sanitizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Map known error patterns to user-friendly messages
  if (/not connected|connection closed|socket|ECONNRESET/i.test(raw)) {
    return 'WhatsApp is temporarily disconnected. Try again in a moment.';
  }
  if (/timeout|ETIMEDOUT/i.test(raw)) {
    return 'The request timed out. Try again.';
  }
  if (/rate.?limit|429|too many/i.test(raw)) {
    return 'Too many requests. Wait a moment and try again.';
  }
  if (/not found|404/i.test(raw)) {
    return 'The requested resource was not found.';
  }
  if (/unauthorized|forbidden|403|401/i.test(raw)) {
    return 'Permission denied for this operation.';
  }
  // Generic fallback — don't expose raw error details
  return 'Operation failed. Try again.';
}

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface MessagingDeps {
  connection: ConnectionManager;
  db: DatabaseSync;
}

type OwnershipRow = Pick<MessageRow, 'conversation_key' | 'is_from_me' | 'chat_jid' | 'message_id' | 'sender_jid' | 'content'>;

interface OwnershipResult {
  row?: OwnershipRow;
  error?: string;
}

function validateMessageOwnership(
  db: DatabaseSync,
  messageId: string,
  session: SessionContext,
): OwnershipResult {
  const row = db
    .prepare('SELECT conversation_key, is_from_me, chat_jid, message_id, sender_jid, content FROM messages WHERE message_id = ?')
    .get(messageId) as OwnershipRow | undefined;

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
      viewOnce: z.boolean().optional().describe('Send as a view-once message that disappears after viewing.'),
    }),
    handler: async (params, _session: SessionContext) => {
      const chatJid = params['chatJid'] as string;
      const text = params['text'] as string;
      const viewOnce = params['viewOnce'] as boolean | undefined;

      const { text: formatted, jids: mentions, hasMentions } = formatMentions(
        text,
        connection.contactsDir.contacts,
      );

      try {
        const content: Record<string, unknown> = hasMentions
          ? { text: formatted, mentions }
          : { text: formatted };
        if (viewOnce) content['viewOnce'] = true;
        await connection.sendRaw(chatJid, content);
      } catch (err) {
        return { error: sanitizeError(err) };
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
        return { error: sanitizeError(err) };
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
        return { error: sanitizeError(err) };
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
        return { error: sanitizeError(err) };
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
        return { error: sanitizeError(err) };
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
      viewOnce: z.boolean().optional().describe('Send as a view-once message that disappears after viewing.'),
    }),
    handler: async (params, _session: SessionContext) => {
      const chatJid = params['chatJid'] as string;
      const latitude = params['latitude'] as number;
      const longitude = params['longitude'] as number;
      const name = params['name'] as string | undefined;
      const address = params['address'] as string | undefined;
      const viewOnce = params['viewOnce'] as boolean | undefined;

      try {
        const content: Record<string, unknown> = {
          location: {
            degreesLatitude: latitude,
            degreesLongitude: longitude,
            name,
            address,
          },
        };
        if (viewOnce) content['viewOnce'] = true;
        await connection.sendRaw(chatJid, content);
      } catch (err) {
        return { error: sanitizeError(err) };
      }

      return { sent: true, latitude, longitude };
    },
  });

  // ── send_contact ──────────────────────────────────────────────────────────

  registry.register({
    name: 'send_contact',
    description: 'Send one or more contact cards to the current chat.',
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'unsafe',
    schema: z.object({
      chatJid: z.string(),
      contacts: z
        .array(
          z.object({
            displayName: z.string().describe('Contact display name'),
            phone: z.string().describe('Phone number (digits, optionally with +)'),
          }),
        )
        .min(1)
        .describe('One or more contacts to send'),
      viewOnce: z.boolean().optional().describe('Send as a view-once message that disappears after viewing.'),
    }),
    handler: async (params, _session: SessionContext) => {
      const chatJid = params['chatJid'] as string;
      const contacts = params['contacts'] as Array<{ displayName: string; phone: string }>;
      const viewOnce = params['viewOnce'] as boolean | undefined;

      const contactCards = contacts.map((c) => {
        const digits = c.phone.replace(/\D/g, '');
        return {
          vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${c.displayName}\nTEL;type=CELL;type=VOICE;waid=${digits}:+${digits}\nEND:VCARD`,
        };
      });

      const displayName =
        contactCards.length === 1 ? contacts[0].displayName : `${contactCards.length} contacts`;

      try {
        const content: Record<string, unknown> = {
          contacts: { displayName, contacts: contactCards },
        };
        if (viewOnce) content['viewOnce'] = true;
        await connection.sendRaw(chatJid, content);
      } catch (err) {
        return { error: sanitizeError(err) };
      }

      return { sent: true, count: contactCards.length };
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
        return { error: sanitizeError(err) };
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
        return { error: sanitizeError(err) };
      }

      return { pinned: pin, messageId, duration: pin ? duration : undefined };
    },
  });
}
