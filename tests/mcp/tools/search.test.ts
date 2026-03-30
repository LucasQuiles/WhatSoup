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
      (chat_jid, conversation_key, sender_jid, sender_name, message_id, content, content_type, is_from_me, timestamp)
    VALUES
      ('111@s.whatsapp.net', '111', '111@s.whatsapp.net', 'Alice', 'msg1', 'Hello world', 'text', 0, 1000),
      ('111@s.whatsapp.net', '111', '111@s.whatsapp.net', 'Alice', 'msg2', 'FTS search test', 'text', 0, 2000),
      ('222@s.whatsapp.net', '222', '222@s.whatsapp.net', 'Bob',   'msg3', 'Another world message', 'text', 0, 3000),
      ('222@s.whatsapp.net', '222', '222@s.whatsapp.net', 'Bob',   'msg4', 'Secret content', 'text', 0, 4000);
  `);
}

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
      const tool = tools.find((t) => t.name === 'search_messages');
      expect(tool).toBeDefined();
    });

    it('is NOT visible in chat-scoped session', () => {
      const tools = registry.listTools(chatSession('111'));
      const tool = tools.find((t) => t.name === 'search_messages');
      expect(tool).toBeUndefined();
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

    it('excludes soft-deleted messages', async () => {
      db.raw.exec(`UPDATE messages SET deleted_at = datetime('now') WHERE message_id = 'msg1'`);
      const result = await registry.call('search_messages', { query: 'Hello world' }, globalSession());
      const data = JSON.parse(result.content[0].text) as { results: Array<{ messageId: string }> };
      expect(data.results.map((r) => r.messageId)).not.toContain('msg1');
    });
  });

  // --- search_chat_messages ---

  describe('search_chat_messages', () => {
    it('is registered as chat scope', () => {
      const tools = registry.listTools(globalSession());
      const tool = tools.find((t) => t.name === 'search_chat_messages');
      expect(tool).toBeDefined();
    });

    it('is visible in chat-scoped session', () => {
      const tools = registry.listTools(chatSession('111'));
      const tool = tools.find((t) => t.name === 'search_chat_messages');
      expect(tool).toBeDefined();
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
      const tool = tools.find((t) => t.name === 'search_contacts');
      expect(tool).toBeDefined();
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
  });
});
