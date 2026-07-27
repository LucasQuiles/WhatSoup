import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import { registerSearchTools } from '../../../src/mcp/tools/search.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function globalSession(): SessionContext {
  return { tier: 'global' };
}

function chatSession(conversationKey: string): SessionContext {
  return { tier: 'chat-scoped', conversationKey, deliveryJid: `${conversationKey}@s.whatsapp.net` };
}

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function seedMessages(db: Database) {
  db.raw.exec(`
    INSERT INTO contacts (jid, canonical_phone, display_name, notify_name)
    VALUES ('111@s.whatsapp.net', '111', 'Alice Smith', 'Alice');

    INSERT INTO contacts (jid, canonical_phone, display_name, notify_name)
    VALUES ('222@s.whatsapp.net', '222', 'Bob Jones', 'Bob');

    INSERT INTO messages
      (chat_jid, conversation_key, sender_jid, sender_name, message_id, content, content_text, content_type, is_from_me, timestamp, media_path)
    VALUES
      ('111@s.whatsapp.net', '111', '111@s.whatsapp.net', 'Alice', 'msg1', 'Hello world', 'Hello world', 'text', 0, 1000, NULL),
      ('111@s.whatsapp.net', '111', '111@s.whatsapp.net', 'Alice', 'msg2', 'FTS search test', 'FTS search test', 'text', 0, 2000, NULL),
      ('222@s.whatsapp.net', '222', '222@s.whatsapp.net', 'Bob',   'msg3', 'Another world message', 'Another world message', 'text', 0, 3000, NULL),
      ('222@s.whatsapp.net', '222', '222@s.whatsapp.net', 'Bob',   'msg4', 'Secret content', 'Secret content', 'text', 0, 4000, NULL),
      ('111@s.whatsapp.net', '111', '111@s.whatsapp.net', 'Alice', 'msg5', '{"type":"image"}', 'Check out this photo', 'image', 0, 5000, '/tmp/whatsoup-media/abc.jpg'),
      ('222@s.whatsapp.net', '222', '222@s.whatsapp.net', 'Bob',   'msg6', '{"type":"audio","duration":12}', NULL, 'audio', 0, 6000, '/tmp/whatsoup-media/voice.ogg'),
      ('111@s.whatsapp.net', '111', '111@s.whatsapp.net', 'Alice', 'msg7', '{"type":"location","latitude":47.6}', 'Location: Downtown Seattle', 'location', 0, 7000, NULL),
      ('222@s.whatsapp.net', '222', '222@s.whatsapp.net', 'Bob',   'msg8', '{"type":"document"}', 'Document: report.pdf', 'document', 0, 8000, '/tmp/whatsoup-media/report.pdf');
  `);
}

const globalSearchToolNames = [
  'search_chat_messages',
  'search_contacts',
  'search_messages',
  'search_messages_advanced',
];

const chatSearchToolNames = ['search_chat_messages'];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('search tools', () => {
  let db: Database;
  let registry: ToolRegistry;

  beforeEach(() => {
    db = makeDb();
    registry = new ToolRegistry();
    registerSearchTools(db, (tool) => registry.register(tool));
    seedMessages(db);
  });

  // --- search_messages ---

  describe('search_messages', () => {
    it('is registered as global scope', () => {
      const tools = registry.listTools(globalSession());
      expect(tools.map((t) => t.name)).toEqual(globalSearchToolNames);
    });

    it('is NOT visible in chat-scoped session', () => {
      const tools = registry.listTools(chatSession('111'));
      expect(tools.map((t) => t.name)).toEqual(chatSearchToolNames);
    });

    it('is rejected when called from a chat-scoped session', async () => {
      const result = await registry.call(
        'search_messages',
        { query: 'world' },
        chatSession('111'),
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not available in a chat-scoped session/);
    });

    it('finds messages matching the query across all conversations', async () => {
      const result = await registry.call('search_messages', { query: 'world' }, globalSession());
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text) as { results: Array<{ messageId: string }> };
      const ids = data.results.map((r) => r.messageId);
      expect(ids).toContain('msg1');
      expect(ids).toContain('msg3');
      expect(ids).not.toContain('msg2');
    });

    it('respects limit parameter', async () => {
      const result = await registry.call('search_messages', { query: 'world', limit: 1 }, globalSession());
      const data = JSON.parse(result.content[0].text) as { results: unknown[] };
      expect(data.results).toHaveLength(1);
    });

    it.each([
      ['negative', -1],
      ['zero', 0],
      ['fractional', 1.5],
      ['oversized', 1001],
    ])('rejects %s limit values', async (_name, limit) => {
      const result = await registry.call('search_messages', { query: 'world', limit }, globalSession());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/Invalid parameters/);
      expect(result.content[0].text).toMatch(/limit/);
    });

    it('excludes soft-deleted messages', async () => {
      db.raw.exec(`UPDATE messages SET deleted_at = datetime('now') WHERE message_id = 'msg1'`);
      const result = await registry.call('search_messages', { query: 'Hello world' }, globalSession());
      const data = JSON.parse(result.content[0].text) as { results: Array<{ messageId: string }> };
      expect(data.results.map((r) => r.messageId)).not.toContain('msg1');
    });

    it('treats MATCH operators as literal text instead of query syntax', async () => {
      const result = await registry.call(
        'search_messages',
        { query: 'world OR secret' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text) as { results: Array<{ messageId: string }> };
      expect(data.results).toHaveLength(0);
      expect(data.results.map((r) => r.messageId)).not.toContain('msg4');
    });
  });

  // --- search_chat_messages ---

  describe('search_chat_messages', () => {
    it('is registered as chat scope', () => {
      const tools = registry.listTools(globalSession());
      expect(tools.map((t) => t.name)).toEqual(globalSearchToolNames);
    });

    it('is visible in chat-scoped session', () => {
      const tools = registry.listTools(chatSession('111'));
      expect(tools.map((t) => t.name)).toEqual(chatSearchToolNames);
    });

    it('filters results to the given conversation_key', async () => {
      const result = await registry.call(
        'search_chat_messages',
        { query: 'world', conversation_key: '111' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text) as { results: Array<{ messageId: string }> };
      const ids = data.results.map((r) => r.messageId);
      // msg1 is in conversation 111 and matches 'world'; msg3 is in 222
      expect(ids).toContain('msg1');
      expect(ids).not.toContain('msg3');
    });

    it('returns empty results when query matches no messages in conversation', async () => {
      const result = await registry.call(
        'search_chat_messages',
        { query: 'zzznomatch', conversation_key: '111' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { results: unknown[] };
      expect(data.results).toHaveLength(0);
    });

    it('excludes soft-deleted messages', async () => {
      db.raw.exec(`UPDATE messages SET deleted_at = datetime('now') WHERE message_id = 'msg2'`);
      const result = await registry.call(
        'search_chat_messages',
        { query: 'FTS search', conversation_key: '111' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { results: Array<{ messageId: string }> };
      expect(data.results.map((r) => r.messageId)).not.toContain('msg2');
    });
  });

  // --- search_contacts ---

  describe('search_contacts', () => {
    it('is registered as global scope', () => {
      const tools = registry.listTools(globalSession());
      expect(tools.map((t) => t.name)).toEqual(globalSearchToolNames);
    });

    it('is rejected in chat-scoped session', async () => {
      const result = await registry.call('search_contacts', { query: 'Alice' }, chatSession('111'));
      expect(result.isError).toBe(true);
    });

    it('finds contacts by display_name', async () => {
      const result = await registry.call('search_contacts', { query: 'Alice' }, globalSession());
      const data = JSON.parse(result.content[0].text) as { results: Array<{ jid: string }> };
      expect(data.results.map((r) => r.jid)).toContain('111@s.whatsapp.net');
    });

    it('finds contacts by notify_name', async () => {
      const result = await registry.call('search_contacts', { query: 'Bob' }, globalSession());
      const data = JSON.parse(result.content[0].text) as { results: Array<{ jid: string }> };
      expect(data.results.map((r) => r.jid)).toContain('222@s.whatsapp.net');
    });

    it('finds contacts by canonical_phone', async () => {
      const result = await registry.call('search_contacts', { query: '111' }, globalSession());
      const data = JSON.parse(result.content[0].text) as { results: Array<{ jid: string }> };
      expect(data.results.map((r) => r.jid)).toContain('111@s.whatsapp.net');
    });

    it('returns empty when no match', async () => {
      const result = await registry.call('search_contacts', { query: 'zzznobody' }, globalSession());
      const data = JSON.parse(result.content[0].text) as { results: unknown[] };
      expect(data.results).toHaveLength(0);
    });

    // --- SQL LIKE wildcard escaping (issue #2177) ---
    // `%`, `_`, and `\` in the caller's query must be treated as literal
    // characters, not as LIKE pattern metacharacters. All four searched fields
    // share a single escaped parameter, so exercising display_name covers the
    // shared code path.

    it('treats an underscore query as a literal character, not a single-char wildcard', async () => {
      db.raw.exec(
        `INSERT INTO contacts (jid, canonical_phone, display_name, notify_name)
         VALUES ('333@s.whatsapp.net', '333', 'Anna_Bell', 'Anna')`,
      );
      const result = await registry.call('search_contacts', { query: '_' }, globalSession());
      const data = JSON.parse(result.content[0].text) as { results: Array<{ jid: string }> };
      const jids = data.results.map((r) => r.jid);
      // Only the contact with a literal underscore matches.
      expect(jids).toContain('333@s.whatsapp.net');
      expect(jids).not.toContain('111@s.whatsapp.net'); // 'Alice Smith' has no underscore
      expect(jids).not.toContain('222@s.whatsapp.net'); // 'Bob Jones' has no underscore
    });

    it('treats a percent query as a literal character, not a multi-char wildcard', async () => {
      db.raw.exec(
        `INSERT INTO contacts (jid, canonical_phone, display_name, notify_name)
         VALUES ('444@s.whatsapp.net', '444', 'Sale 100%', 'Sale')`,
      );
      const result = await registry.call('search_contacts', { query: '%' }, globalSession());
      const data = JSON.parse(result.content[0].text) as { results: Array<{ jid: string }> };
      const jids = data.results.map((r) => r.jid);
      // Only the contact with a literal percent matches.
      expect(jids).toContain('444@s.whatsapp.net');
      expect(jids).not.toContain('111@s.whatsapp.net');
      expect(jids).not.toContain('222@s.whatsapp.net');
    });

    it('treats a backslash query as a literal character under the ESCAPE clause', async () => {
      db.raw.exec(
        `INSERT INTO contacts (jid, canonical_phone, display_name, notify_name)
         VALUES ('555@s.whatsapp.net', '555', 'a\\b', 'slash')`,
      );
      const result = await registry.call('search_contacts', { query: 'a\\b' }, globalSession());
      const data = JSON.parse(result.content[0].text) as { results: Array<{ jid: string }> };
      const jids = data.results.map((r) => r.jid);
      expect(jids).toContain('555@s.whatsapp.net');
    });
  });

  // --- search_messages_advanced ---

  describe('search_messages_advanced', () => {
    // -- Registration --

    it('is registered as global scope', () => {
      const tools = registry.listTools(globalSession());
      expect(tools.map((t) => t.name)).toEqual(globalSearchToolNames);
    });

    it('is rejected in chat-scoped session', async () => {
      const result = await registry.call(
        'search_messages_advanced',
        { query: 'world' },
        chatSession('111'),
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not available in a chat-scoped session/);
    });

    // -- FTS-path tests --

    it('FTS: finds messages matching the text query', async () => {
      const result = await registry.call(
        'search_messages_advanced',
        { query: 'world' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text) as { messages: Array<{ messageId: string }> };
      const ids = data.messages.map((r) => r.messageId);
      expect(ids).toContain('msg1');
      expect(ids).toContain('msg3');
      expect(ids).toHaveLength(2);
    });

    it('FTS + sender_jid: narrows results to a single sender', async () => {
      const result = await registry.call(
        'search_messages_advanced',
        { query: 'world', sender_jid: '111@s.whatsapp.net' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { messages: Array<{ messageId: string }> };
      const ids = data.messages.map((r) => r.messageId);
      expect(ids).toContain('msg1');
      expect(ids).not.toContain('msg3');
    });

    it('FTS + conversation_key: limits results to one conversation', async () => {
      const result = await registry.call(
        'search_messages_advanced',
        { query: 'world', conversation_key: '222' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { messages: Array<{ messageId: string }> };
      const ids = data.messages.map((r) => r.messageId);
      expect(ids).toContain('msg3');
      expect(ids).not.toContain('msg1');
    });

    it('FTS + date range: filters by timestamp', async () => {
      const result = await registry.call(
        'search_messages_advanced',
        { query: 'world', after: 2000, before: 4000 },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { messages: Array<{ messageId: string }> };
      const ids = data.messages.map((r) => r.messageId);
      expect(ids).toContain('msg3');
      expect(ids).not.toContain('msg1');
    });

    it('FTS: excludes soft-deleted messages', async () => {
      db.raw.exec(`UPDATE messages SET deleted_at = datetime('now') WHERE message_id = 'msg1'`);
      const result = await registry.call(
        'search_messages_advanced',
        { query: 'world' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { messages: Array<{ messageId: string }> };
      expect(data.messages.map((r) => r.messageId)).not.toContain('msg1');
      // msg3 should still appear
      expect(data.messages.map((r) => r.messageId)).toContain('msg3');
    });

    it('FTS + content_type: filters by message type', async () => {
      const result = await registry.call(
        'search_messages_advanced',
        { query: 'Seattle', content_type: 'location' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { messages: Array<{ messageId: string }> };
      expect(data.messages.map((r) => r.messageId)).toContain('msg7');
      expect(data.messages).toHaveLength(1);
    });

    it('FTS: respects limit parameter', async () => {
      const result = await registry.call(
        'search_messages_advanced',
        { query: 'world', limit: 1 },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { messages: unknown[] };
      expect(data.messages).toHaveLength(1);
    });

    it.each([
      ['negative', -1],
      ['zero', 0],
      ['fractional', 1.5],
      ['oversized', 1001],
    ])('rejects %s limit values', async (_name, limit) => {
      const result = await registry.call('search_messages_advanced', { query: 'world', limit }, globalSession());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/Invalid parameters/);
      expect(result.content[0].text).toMatch(/limit/);
    });

    it('FTS: returns empty results for no matches', async () => {
      const result = await registry.call(
        'search_messages_advanced',
        { query: 'zzznomatchever' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { messages: unknown[] };
      expect(data.messages).toHaveLength(0);
    });

    it('rejects invalid MATCH syntax before hitting SQLite', async () => {
      const result = await registry.call(
        'search_messages_advanced',
        { query: 'bad "quote' },
        globalSession(),
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/Invalid FTS MATCH query/i);
    });

    // -- Metadata-only tests --

    it('metadata: returns all messages when no filters are set', async () => {
      const result = await registry.call(
        'search_messages_advanced',
        {},
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { messages: Array<{ messageId: string }> };
      expect(data.messages).toHaveLength(8);
      // Should be ordered by timestamp DESC
      expect(data.messages[0].messageId).toBe('msg8');
      expect(data.messages[7].messageId).toBe('msg1');
    });

    it('metadata: filter by sender_jid only', async () => {
      const result = await registry.call(
        'search_messages_advanced',
        { sender_jid: '222@s.whatsapp.net' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { messages: Array<{ messageId: string }> };
      const ids = data.messages.map((r) => r.messageId);
      expect(ids).toEqual(['msg8', 'msg6', 'msg4', 'msg3']);
    });

    it('metadata: filter by content_type only', async () => {
      const result = await registry.call(
        'search_messages_advanced',
        { content_type: 'image' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { messages: Array<{ messageId: string }> };
      expect(data.messages).toHaveLength(1);
      expect(data.messages[0].messageId).toBe('msg5');
    });

    it('metadata: filter by date range', async () => {
      const result = await registry.call(
        'search_messages_advanced',
        { after: 4000, before: 6000 },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { messages: Array<{ messageId: string }> };
      const ids = data.messages.map((r) => r.messageId);
      expect(ids).toEqual(['msg6', 'msg5', 'msg4']);
    });

    it('metadata: filter by conversation_key', async () => {
      const result = await registry.call(
        'search_messages_advanced',
        { conversation_key: '111' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { messages: Array<{ messageId: string }> };
      const ids = data.messages.map((r) => r.messageId);
      expect(ids).toEqual(['msg7', 'msg5', 'msg2', 'msg1']);
    });

    it('metadata: has_media=true returns only messages with media_path', async () => {
      const result = await registry.call(
        'search_messages_advanced',
        { has_media: true },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { messages: Array<{ messageId: string }> };
      const ids = data.messages.map((r) => r.messageId);
      expect(ids).toEqual(['msg8', 'msg6', 'msg5']);
    });

    it('metadata: has_media=false returns only messages without media_path', async () => {
      const result = await registry.call(
        'search_messages_advanced',
        { has_media: false },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { messages: Array<{ messageId: string }> };
      const ids = data.messages.map((r) => r.messageId);
      expect(ids).toEqual(['msg7', 'msg4', 'msg3', 'msg2', 'msg1']);
    });

    it('metadata: combined filters (sender + content_type + date range)', async () => {
      const result = await registry.call(
        'search_messages_advanced',
        { sender_jid: '222@s.whatsapp.net', content_type: 'text', after: 3000, before: 5000 },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { messages: Array<{ messageId: string }> };
      const ids = data.messages.map((r) => r.messageId);
      expect(ids).toEqual(['msg4', 'msg3']);
    });

    it('metadata: respects limit', async () => {
      const result = await registry.call(
        'search_messages_advanced',
        { limit: 3 },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { messages: unknown[] };
      expect(data.messages).toHaveLength(3);
    });

    it('metadata: excludes soft-deleted messages', async () => {
      db.raw.exec(`UPDATE messages SET deleted_at = datetime('now') WHERE message_id = 'msg4'`);
      const result = await registry.call(
        'search_messages_advanced',
        { sender_jid: '222@s.whatsapp.net' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { messages: Array<{ messageId: string }> };
      const ids = data.messages.map((r) => r.messageId);
      expect(ids).not.toContain('msg4');
      expect(ids).toContain('msg3');
    });

    it('metadata: returns empty for impossible filter combination', async () => {
      const result = await registry.call(
        'search_messages_advanced',
        { sender_jid: '111@s.whatsapp.net', content_type: 'audio' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { messages: unknown[] };
      expect(data.messages).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // residual-branch coverage
  // -------------------------------------------------------------------------
  //
  // search_contacts maps nullable columns (canonical_phone, display_name,
  // notify_name) through `row.col ?? null`. The existing seed only contains
  // rows where every column is non-null, so the `??` fallback branches at
  // src/mcp/tools/search.ts:147-149 are never taken. Inserting a row with
  // all three columns explicitly NULL exercises the null-side of each `??`.

  describe('residual-branch coverage', () => {
    it('search_contacts: ?? fallback returns null for null canonical_phone/display_name/notify_name', async () => {
      db.raw.exec(`
        INSERT INTO contacts (jid, canonical_phone, display_name, notify_name)
        VALUES ('333@s.whatsapp.net', NULL, NULL, NULL);
      `);

      const result = await registry.call(
        'search_contacts',
        { query: '333' },
        globalSession(),
      );

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text) as {
        results: Array<{
          jid: string;
          canonicalPhone: string | null;
          displayName: string | null;
          notifyName: string | null;
          firstSeenAt: string;
          lastSeenAt: string;
        }>;
      };

      expect(data.results).toHaveLength(1);
      expect(data.results[0]).toEqual({
        jid: '333@s.whatsapp.net',
        canonicalPhone: null,
        displayName: null,
        notifyName: null,
        firstSeenAt: expect.any(String),
        lastSeenAt: expect.any(String),
      });
    });
  });
});
