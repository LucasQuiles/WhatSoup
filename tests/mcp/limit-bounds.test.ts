// tests/mcp/limit-bounds.test.ts
// Issue #390: MCP read tools accept user-provided `limit` and bind it into
// SQLite `LIMIT ?`. Negative values bypass the cap (SQLite treats `LIMIT -1`
// as unlimited); large positives DoS the host. Each read tool must reject
// non-positive, non-integer, and over-cap limits via Zod validation, while
// still allowing `limit: undefined` (default behavior).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { ToolRegistry } from '../../src/mcp/registry.ts';
import { registerSearchTools } from '../../src/mcp/tools/search.ts';
import { registerChatManagementTools } from '../../src/mcp/tools/chat-management.ts';
import { registerBusinessTools } from '../../src/mcp/tools/business.ts';
import type { SessionContext } from '../../src/mcp/types.ts';
import type { WhatsAppSocket } from '../../src/transport/connection.ts';

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

function makeMockSock(): WhatsAppSocket {
  return {
    getCatalog: vi.fn().mockResolvedValue({ products: [], cursor: null }),
    getCollections: vi.fn().mockResolvedValue({ collections: [] }),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    chatModify: vi.fn().mockResolvedValue(undefined),
    readMessages: vi.fn().mockResolvedValue(undefined),
  } as unknown as WhatsAppSocket;
}

// Tools that read from the local SQLite messages/contacts tables. Their limit
// is bound directly into a `LIMIT ?` placeholder; cap at 1000 rows.
interface ListSearchCase {
  name: string;
  args: Record<string, unknown>;
  session: () => SessionContext;
}

const LIST_SEARCH_TOOLS: ListSearchCase[] = [
  { name: 'search_messages', args: { query: 'hello' }, session: globalSession },
  { name: 'search_chat_messages', args: { conversation_key: '111', query: 'hello' }, session: () => chatSession('111') },
  { name: 'search_contacts', args: { query: 'alice' }, session: globalSession },
  { name: 'search_messages_advanced', args: { query: 'hello' }, session: globalSession },
  { name: 'list_messages', args: { conversation_key: '111' }, session: () => chatSession('111') },
  { name: 'list_chats', args: {}, session: globalSession },
];

const LIST_SEARCH_CAP = 1000;

// Tools that round-trip through Baileys/whatsmeow upstream — catalog rows are
// heavier than message rows. Cap at 100 rows.
interface CatalogCase {
  name: string;
  args: Record<string, unknown>;
}

const CATALOG_TOOLS: CatalogCase[] = [
  { name: 'get_catalog', args: { jid: 'biz@s.whatsapp.net' } },
  { name: 'get_collections', args: { jid: 'biz@s.whatsapp.net' } },
];

const CATALOG_CAP = 100;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCP read tools — limit parameter bounds (issue #390)', () => {
  let db: Database;
  let registry: ToolRegistry;
  let mockSock: WhatsAppSocket;

  beforeEach(() => {
    db = makeDb();
    mockSock = makeMockSock();
    registry = new ToolRegistry();
    registerSearchTools(db, (tool) => registry.register(tool));
    registerChatManagementTools(db, () => mockSock, (tool) => registry.register(tool));
    registerBusinessTools(() => mockSock, (tool) => registry.register(tool));
  });

  // ---- list/search tools (cap 1000) ----
  describe.each(LIST_SEARCH_TOOLS)('$name', ({ name, args, session }) => {
    it('rejects limit: -1 (would bypass cap in SQLite)', async () => {
      const res = await registry.call(name, { ...args, limit: -1 }, session());
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toMatch(/Invalid parameters/i);
    });

    it('rejects limit: 0 (not positive)', async () => {
      const res = await registry.call(name, { ...args, limit: 0 }, session());
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toMatch(/Invalid parameters/i);
    });

    it(`rejects limit: ${LIST_SEARCH_CAP + 1} (over cap)`, async () => {
      const res = await registry.call(name, { ...args, limit: LIST_SEARCH_CAP + 1 }, session());
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toMatch(/Invalid parameters/i);
    });

    it('rejects non-integer limit: 1.5', async () => {
      const res = await registry.call(name, { ...args, limit: 1.5 }, session());
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toMatch(/Invalid parameters/i);
    });

    it('accepts limit: undefined (uses default)', async () => {
      const res = await registry.call(name, args, session());
      expect(res.isError).toBeFalsy();
      // Successful read must not surface the schema-validation error string.
      expect(JSON.stringify(res.content)).not.toMatch(/Invalid parameters/i);
    });

    it(`accepts limit: ${LIST_SEARCH_CAP} (at cap)`, async () => {
      const res = await registry.call(name, { ...args, limit: LIST_SEARCH_CAP }, session());
      expect(res.isError).toBeFalsy();
      expect(JSON.stringify(res.content)).not.toMatch(/Invalid parameters/i);
    });
  });

  // ---- catalog tools (cap 100) ----
  describe.each(CATALOG_TOOLS)('$name', ({ name, args }) => {
    it('rejects limit: -1 (would bypass cap)', async () => {
      const res = await registry.call(name, { ...args, limit: -1 }, globalSession());
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toMatch(/Invalid parameters/i);
    });

    it('rejects limit: 0 (not positive)', async () => {
      const res = await registry.call(name, { ...args, limit: 0 }, globalSession());
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toMatch(/Invalid parameters/i);
    });

    it(`rejects limit: ${CATALOG_CAP + 1} (over cap)`, async () => {
      const res = await registry.call(name, { ...args, limit: CATALOG_CAP + 1 }, globalSession());
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toMatch(/Invalid parameters/i);
    });

    it('rejects non-integer limit: 1.5', async () => {
      const res = await registry.call(name, { ...args, limit: 1.5 }, globalSession());
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toMatch(/Invalid parameters/i);
    });

    it('accepts limit: undefined (uses default)', async () => {
      const res = await registry.call(name, args, globalSession());
      expect(res.isError).toBeFalsy();
      expect(JSON.stringify(res.content)).not.toMatch(/Invalid parameters/i);
    });

    it(`accepts limit: ${CATALOG_CAP} (at cap)`, async () => {
      const res = await registry.call(name, { ...args, limit: CATALOG_CAP }, globalSession());
      expect(res.isError).toBeFalsy();
      expect(JSON.stringify(res.content)).not.toMatch(/Invalid parameters/i);
    });
  });
});
