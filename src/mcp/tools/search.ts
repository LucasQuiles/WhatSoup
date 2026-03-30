// src/mcp/tools/search.ts
// FTS5 search tools: search_messages, search_chat_messages, search_contacts.

import { z } from 'zod';
import type { ToolDeclaration } from '../types.ts';
import type { SessionContext } from '../types.ts';
import type { Database } from '../../core/database.ts';
import { type MessageRow, rowToMessage } from '../../core/messages.ts';

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
    handler: async (params, session: SessionContext) => {
      const { conversation_key: caller_key, query, limit = 20 } = SearchChatMessagesSchema.parse(params);
      // For chat-scoped sessions, ignore caller-supplied key and force session key
      const conversation_key = session.tier === 'chat-scoped' ? session.conversationKey! : caller_key;

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
