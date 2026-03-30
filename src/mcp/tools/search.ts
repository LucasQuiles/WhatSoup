// src/mcp/tools/search.ts
// FTS5 search tools: search_messages, search_chat_messages, search_contacts.

import { z } from 'zod';
import type { ToolDeclaration } from '../types.ts';
import type { Database } from '../../core/database.ts';

// ---------------------------------------------------------------------------
// Helper — map raw DB row to public-facing shape
// ---------------------------------------------------------------------------

interface MessageRow {
  pk: number;
  message_id: string;
  conversation_key: string;
  chat_jid: string;
  sender_jid: string;
  sender_name: string | null;
  content: string | null;
  content_type: string;
  is_from_me: number;
  timestamp: number;
  quoted_message_id: string | null;
  created_at: string;
}

function rowToMessage(row: MessageRow) {
  return {
    pk: row.pk,
    messageId: row.message_id,
    conversationKey: row.conversation_key,
    chatJid: row.chat_jid,
    senderJid: row.sender_jid,
    senderName: row.sender_name ?? null,
    content: row.content ?? null,
    contentType: row.content_type,
    isFromMe: Boolean(row.is_from_me),
    timestamp: row.timestamp,
    quotedMessageId: row.quoted_message_id ?? null,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// search_messages — global FTS5 across all conversations
// ---------------------------------------------------------------------------

const SearchMessagesSchema = z.object({
  query: z.string(),
  limit: z.number().optional(),
});

function makeSearchMessages(db: Database): ToolDeclaration {
  return {
    name: 'search_messages',
    description:
      'Full-text search across all WhatsApp messages (global). Returns messages matching the query, excluding deleted messages.',
    schema: SearchMessagesSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    handler: async (params) => {
      const { query, limit = 20 } = SearchMessagesSchema.parse(params);

      const rows = db.raw
        .prepare(
          `SELECT m.*
           FROM messages_fts fts
           JOIN messages m ON m.pk = fts.rowid
           WHERE messages_fts MATCH ?
             AND m.deleted_at IS NULL
           ORDER BY m.timestamp DESC
           LIMIT ?`,
        )
        .all(query, limit) as unknown as MessageRow[];

      return { results: rows.map(rowToMessage), total: rows.length };
    },
  };
}

// ---------------------------------------------------------------------------
// search_chat_messages — FTS5 within a single conversation
// ---------------------------------------------------------------------------

const SearchChatMessagesSchema = z.object({
  conversation_key: z.string(),
  query: z.string(),
  limit: z.number().optional(),
});

function makeSearchChatMessages(db: Database): ToolDeclaration {
  return {
    name: 'search_chat_messages',
    description:
      'Full-text search within a specific WhatsApp conversation. Returns messages matching the query in the given conversation_key, excluding deleted messages.',
    schema: SearchChatMessagesSchema,
    scope: 'chat',
    targetMode: 'caller-supplied',
    handler: async (params) => {
      const { conversation_key, query, limit = 20 } = SearchChatMessagesSchema.parse(params);

      const rows = db.raw
        .prepare(
          `SELECT m.*
           FROM messages_fts fts
           JOIN messages m ON m.pk = fts.rowid
           WHERE messages_fts MATCH ?
             AND m.deleted_at IS NULL
             AND m.conversation_key = ?
           ORDER BY m.timestamp DESC
           LIMIT ?`,
        )
        .all(query, conversation_key, limit) as unknown as MessageRow[];

      return { results: rows.map(rowToMessage), total: rows.length };
    },
  };
}

// ---------------------------------------------------------------------------
// search_contacts — contact lookup by display_name or phone
// ---------------------------------------------------------------------------

const SearchContactsSchema = z.object({
  query: z.string(),
  limit: z.number().optional(),
});

interface ContactRow {
  jid: string;
  canonical_phone: string | null;
  display_name: string | null;
  notify_name: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

function makeSearchContacts(db: Database): ToolDeclaration {
  return {
    name: 'search_contacts',
    description:
      'Search contacts by display name or phone number (global). Returns matching contacts from the contacts table.',
    schema: SearchContactsSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    handler: async (params) => {
      const { query, limit = 20 } = SearchContactsSchema.parse(params);

      const likeParam = `%${query}%`;
      const rows = db.raw
        .prepare(
          `SELECT *
           FROM contacts
           WHERE display_name LIKE ?
              OR notify_name LIKE ?
              OR canonical_phone LIKE ?
              OR jid LIKE ?
           ORDER BY last_seen_at DESC
           LIMIT ?`,
        )
        .all(likeParam, likeParam, likeParam, likeParam, limit) as unknown as ContactRow[];

      const contacts = rows.map((row) => ({
        jid: row.jid,
        canonicalPhone: row.canonical_phone ?? null,
        displayName: row.display_name ?? null,
        notifyName: row.notify_name ?? null,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
      }));

      return { results: contacts, total: contacts.length };
    },
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function registerSearchTools(db: Database, register: (tool: ToolDeclaration) => void): void {
  register(makeSearchMessages(db));
  register(makeSearchChatMessages(db));
  register(makeSearchContacts(db));
}
