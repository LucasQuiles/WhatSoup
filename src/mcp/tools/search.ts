// src/mcp/tools/search.ts
// FTS5 search tools: search_messages, search_chat_messages, search_contacts.

import { z } from 'zod';
import type { ToolDeclaration, SessionContext } from '../types.ts';
import { resolveConversationKey } from '../types.ts';
import type { Database } from '../../core/database.ts';
import { type MessageRow, rowToMessage } from '../../core/messages.ts';

// ---------------------------------------------------------------------------
// search_messages — global FTS5 across all conversations
// ---------------------------------------------------------------------------
// NOTE: search_messages (scope: 'global') and search_chat_messages (scope: 'chat')
// are intentionally separate tools. Scope is not just a label — the ToolRegistry
// routes each scope to a different MCP socket/session surface (global vs chat-scoped).
// Merging them into one tool would require a single scope declaration, which would
// either block the tool from chat sessions entirely or expose unrestricted global
// search to sandboxed chat-scoped agents. Keep them separate.

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
    replayPolicy: 'read_only',
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
    replayPolicy: 'read_only',
    handler: async (params, session: SessionContext) => {
      const { conversation_key: caller_key, query, limit = 20 } = SearchChatMessagesSchema.parse(params);
      const conversation_key = resolveConversationKey(session, caller_key);

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
    replayPolicy: 'read_only',
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
// search_messages_advanced — dual-path metadata + FTS search
// ---------------------------------------------------------------------------

const SearchAdvancedSchema = z.object({
  query: z.string().optional().describe('FTS text search query. When absent, only metadata filters apply.'),
  sender_jid: z.string().optional().describe('Filter by sender JID'),
  content_type: z.string().optional().describe('Filter by content type (text, image, audio, video, document, sticker, location, contact, poll)'),
  conversation_key: z.string().optional().describe('Filter by conversation'),
  after: z.number().optional().describe('Unix timestamp — messages after this time'),
  before: z.number().optional().describe('Unix timestamp — messages before this time'),
  has_media: z.boolean().optional().describe('Filter for messages with (true) or without (false) media'),
  limit: z.number().optional().describe('Max results to return (default 20)'),
});

function makeSearchMessagesAdvanced(db: Database): ToolDeclaration {
  return {
    name: 'search_messages_advanced',
    description:
      'Advanced message search with metadata filters (sender, date range, content type, conversation, media presence) and optional full-text search. When a text query is provided, uses FTS5 for ranking. When absent, filters on metadata only.',
    schema: SearchAdvancedSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    handler: async (params) => {
      const {
        query,
        sender_jid: sender,
        content_type: contentType,
        conversation_key: conv,
        after,
        before,
        has_media: hasMedia,
        limit = 20,
      } = SearchAdvancedSchema.parse(params);

      const bindings: unknown[] = [];
      const conditions: string[] = ['m.deleted_at IS NULL'];

      // Metadata filters
      if (sender) {
        conditions.push('m.sender_jid = ?');
        bindings.push(sender);
      }
      if (contentType) {
        conditions.push('m.content_type = ?');
        bindings.push(contentType);
      }
      if (conv) {
        conditions.push('m.conversation_key = ?');
        bindings.push(conv);
      }
      if (after != null) {
        conditions.push('m.timestamp >= ?');
        bindings.push(after);
      }
      if (before != null) {
        conditions.push('m.timestamp <= ?');
        bindings.push(before);
      }
      if (hasMedia === true) {
        conditions.push('m.media_path IS NOT NULL');
      } else if (hasMedia === false) {
        conditions.push('m.media_path IS NULL');
      }

      const where = conditions.join(' AND ');

      let sql: string;
      if (query) {
        // FTS-first path: join through messages_fts for text matching
        sql = `SELECT m.*
               FROM messages_fts fts
               JOIN messages m ON m.pk = fts.rowid
               WHERE fts.content MATCH ?
                 AND ${where}
               ORDER BY m.timestamp DESC
               LIMIT ?`;
        bindings.unshift(query);
      } else {
        // Metadata-only path: query messages directly
        sql = `SELECT m.*
               FROM messages m
               WHERE ${where}
               ORDER BY m.timestamp DESC
               LIMIT ?`;
      }
      bindings.push(limit);

      const rows = db.raw.prepare(sql).all(...bindings as Array<string | number | null>) as unknown as MessageRow[];

      return { messages: rows.map(rowToMessage), total: rows.length };
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
  register(makeSearchMessagesAdvanced(db));
}
