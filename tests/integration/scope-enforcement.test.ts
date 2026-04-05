/**
 * Integration: Scope Enforcement
 *
 * End-to-end tests using a real in-memory SQLite DB.
 * Verifies that chat-scoped sessions see only their own conversation,
 * global-scope tools are blocked in chat sessions, and global sessions
 * can query across all conversations.
 *
 * ConnectionManager is mocked — we test DB integration, not transport.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { ToolRegistry } from '../../src/mcp/registry.ts';
import { registerChatManagementTools } from '../../src/mcp/tools/chat-management.ts';
import { registerSearchTools } from '../../src/mcp/tools/search.ts';
import { registerMessagingTools, type MessagingDeps } from '../../src/mcp/tools/messaging.ts';
import { registerGroupTools } from '../../src/mcp/tools/groups.ts';
import type { SessionContext } from '../../src/mcp/types.ts';
import type { WhatsAppSocket } from '../../src/transport/connection.ts';
import type { ConnectionManager } from '../../src/transport/connection.ts';

// ---------------------------------------------------------------------------
// JIDs / conversation keys used throughout
// ---------------------------------------------------------------------------

const ALICE_JID = '15551110001@s.whatsapp.net';
const ALICE_KEY = '15551110001'; // toConversationKey(ALICE_JID)

const BOB_JID = '15552220002@s.whatsapp.net';
const BOB_KEY = '15552220002'; // toConversationKey(BOB_JID)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function seedMessages(db: Database): void {
  db.raw.exec(`
    INSERT INTO messages
      (chat_jid, conversation_key, sender_jid, sender_name, message_id, content, content_text, content_type, is_from_me, timestamp)
    VALUES
      ('${ALICE_JID}', '${ALICE_KEY}', '${ALICE_JID}', 'Alice', 'alice-msg-1', 'Hello from Alice', 'Hello from Alice', 'text', 0, 1000),
      ('${ALICE_JID}', '${ALICE_KEY}', '${ALICE_JID}', 'Alice', 'alice-msg-2', 'Another Alice message', 'Another Alice message', 'text', 0, 2000),
      ('${BOB_JID}', '${BOB_KEY}', '${BOB_JID}', 'Bob',   'bob-msg-1',   'Hello from Bob', 'Hello from Bob', 'text', 0, 3000),
      ('${BOB_JID}', '${BOB_KEY}', '${BOB_JID}', 'Bob',   'bob-msg-2',   'Bob second message', 'Bob second message', 'text', 0, 4000)
  `);
}

function makeMockSock(): WhatsAppSocket {
  return {
    sendMessage: async () => undefined,
    chatModify: async () => undefined,
    readMessages: async () => undefined,
    star: async () => undefined,
    groupFetchAllParticipating: async () => ({}),
  } as unknown as WhatsAppSocket;
}

function makeMockConnection(): ConnectionManager {
  return {
    contactsDir: {
      contacts: new Map<string, string>(),
    },
    sendRaw: async (_jid: string, _content: unknown) => ({ waMessageId: null }),
    sendMedia: async (_jid: string, _media: unknown) => ({ waMessageId: null }),
    botJid: null,
    botLid: null,
  } as unknown as ConnectionManager;
}

function chatSession(conversationKey: string, deliveryJid: string): SessionContext {
  return { tier: 'chat-scoped', conversationKey, deliveryJid };
}

function globalSession(): SessionContext {
  return { tier: 'global' };
}

function makeRegistry(db: Database, mockSock: WhatsAppSocket, mockConn: ConnectionManager): ToolRegistry {
  const registry = new ToolRegistry();
  const getSock = () => mockSock;

  registerChatManagementTools(db, getSock, (tool) => registry.register(tool));
  registerSearchTools(db, (tool) => registry.register(tool));
  registerGroupTools(getSock, (tool) => registry.register(tool));

  const messagingDeps: MessagingDeps = {
    connection: mockConn,
    db: db.raw,
  };
  registerMessagingTools(registry, messagingDeps);

  return registry;
}

// ---------------------------------------------------------------------------
// Tests: Chat-scoped session
// ---------------------------------------------------------------------------

describe('chat-scoped session', () => {
  let db: Database;
  let registry: ToolRegistry;
  const aliceSession = chatSession(ALICE_KEY, ALICE_JID);

  beforeEach(() => {
    db = makeDb();
    seedMessages(db);
    registry = makeRegistry(db, makeMockSock(), makeMockConnection());
  });

  it('list_messages only returns messages for the queried conversation_key', async () => {
    const result = await registry.call(
      'list_messages',
      { conversation_key: ALICE_KEY },
      aliceSession,
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text) as { messages: Array<{ conversationKey: string }> };
    expect(data.messages.length).toBe(2);
    for (const msg of data.messages) {
      expect(msg.conversationKey).toBe(ALICE_KEY);
    }
  });

  it('list_messages ignores caller-supplied conversation_key and forces session key in a chat-scoped session', async () => {
    // Alice session passes BOB_KEY but the scope boundary must force ALICE_KEY
    const result = await registry.call(
      'list_messages',
      { conversation_key: BOB_KEY },
      aliceSession,
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text) as { messages: Array<{ conversationKey: string }> };
    // Should return Alice's messages, not Bob's — scope boundary enforced
    expect(data.messages.length).toBe(2);
    for (const msg of data.messages) {
      expect(msg.conversationKey).toBe(ALICE_KEY);
    }
  });

  it('search_chat_messages only returns results from the given conversation_key', async () => {
    const result = await registry.call(
      'search_chat_messages',
      { conversation_key: ALICE_KEY, query: 'Alice' },
      aliceSession,
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text) as { results: Array<{ conversationKey: string }> };
    expect(data.results.length).toBeGreaterThan(0);
    for (const msg of data.results) {
      expect(msg.conversationKey).toBe(ALICE_KEY);
    }
  });

  it('search_chat_messages does NOT return messages from other conversations', async () => {
    const result = await registry.call(
      'search_chat_messages',
      { conversation_key: ALICE_KEY, query: 'Bob' },
      aliceSession,
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text) as { results: unknown[] };
    expect(data.results.length).toBe(0);
  });

  it('search_chat_messages ignores caller-supplied conversation_key and forces session key (scope bypass prevention)', async () => {
    // Alice session passes BOB_KEY — should be silently overridden to ALICE_KEY
    const result = await registry.call(
      'search_chat_messages',
      { conversation_key: BOB_KEY, query: 'Hello' },
      aliceSession,
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text) as { results: Array<{ conversationKey: string }> };
    // Must only return Alice's messages — Bob's conversation is inaccessible
    for (const msg of data.results) {
      expect(msg.conversationKey).toBe(ALICE_KEY);
    }
  });

  it('get_message_context ignores caller-supplied conversation_key and forces session key (scope bypass prevention)', async () => {
    // Alice session asks for context on alice-msg-1 but passes BOB_KEY as conversation_key
    // The scope boundary must force ALICE_KEY, so alice-msg-1 should be found (not a mismatch error)
    const result = await registry.call(
      'get_message_context',
      { message_id: 'alice-msg-1', conversation_key: BOB_KEY },
      aliceSession,
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text) as { target: { conversationKey: string } };
    expect(data.target.conversationKey).toBe(ALICE_KEY);
  });

  it('search_messages (global-scope) is rejected with a scope error', async () => {
    const result = await registry.call(
      'search_messages',
      { query: 'Alice' },
      aliceSession,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not available in a chat-scoped session');
  });

  it('list_chats (global-scope) is rejected with a scope error', async () => {
    const result = await registry.call('list_chats', {}, aliceSession);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not available in a chat-scoped session');
  });

  it('list_groups (global-scope) is rejected with a scope error', async () => {
    const result = await registry.call('list_groups', {}, aliceSession);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not available in a chat-scoped session');
  });

  it('global-scope tools are hidden from listTools in a chat-scoped session', () => {
    const tools = registry.listTools(aliceSession);
    const toolNames = tools.map((t) => t.name);

    expect(toolNames).not.toContain('search_messages');
    expect(toolNames).not.toContain('list_chats');
    expect(toolNames).not.toContain('list_groups');
    expect(toolNames).not.toContain('get_chat');
  });

  it('chat-scope tools are visible in listTools for a chat-scoped session', () => {
    const tools = registry.listTools(aliceSession);
    const toolNames = tools.map((t) => t.name);

    expect(toolNames).toContain('list_messages');
    expect(toolNames).toContain('search_chat_messages');
    expect(toolNames).toContain('send_message');
  });

  it('send_message auto-injects deliveryJid from session — caller chatJid is overridden', async () => {
    const capturedCalls: Array<{ jid: string; content: unknown }> = [];
    const conn = {
      contactsDir: { contacts: new Map<string, string>() },
      sendRaw: async (jid: string, content: unknown) => {
        capturedCalls.push({ jid, content });
      },
    } as unknown as ConnectionManager;

    const reg = new ToolRegistry();
    registerMessagingTools(reg, { connection: conn, db: db.raw });

    // Caller supplies BOB_JID but session has ALICE_JID as deliveryJid
    const result = await reg.call(
      'send_message',
      { chatJid: BOB_JID, text: 'hello' },
      aliceSession,
    );

    expect(result.isError).toBeFalsy();
    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]!.jid).toBe(ALICE_JID);
  });
});

// ---------------------------------------------------------------------------
// Tests: Global session
// ---------------------------------------------------------------------------

describe('global session', () => {
  let db: Database;
  let registry: ToolRegistry;
  const session = globalSession();

  beforeEach(() => {
    db = makeDb();
    seedMessages(db);
    registry = makeRegistry(db, makeMockSock(), makeMockConnection());
  });

  it('list_messages with Alice conversation_key returns only Alice messages', async () => {
    const result = await registry.call(
      'list_messages',
      { conversation_key: ALICE_KEY },
      session,
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text) as { messages: Array<{ conversationKey: string }> };
    expect(data.messages.length).toBe(2);
    for (const msg of data.messages) {
      expect(msg.conversationKey).toBe(ALICE_KEY);
    }
  });

  it('list_messages with Bob conversation_key returns only Bob messages', async () => {
    const result = await registry.call(
      'list_messages',
      { conversation_key: BOB_KEY },
      session,
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text) as { messages: Array<{ conversationKey: string }> };
    expect(data.messages.length).toBe(2);
    for (const msg of data.messages) {
      expect(msg.conversationKey).toBe(BOB_KEY);
    }
  });

  it('search_messages (global) searches across all conversations', async () => {
    const result = await registry.call(
      'search_messages',
      { query: 'Hello' },
      session,
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text) as { results: Array<{ conversationKey: string }> };
    const keys = new Set(data.results.map((r) => r.conversationKey));
    expect(keys).toContain(ALICE_KEY);
    expect(keys).toContain(BOB_KEY);
  });

  it('search_messages returns only matching content, not all messages', async () => {
    const result = await registry.call(
      'search_messages',
      { query: 'Alice' },
      session,
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text) as { results: Array<{ conversationKey: string }> };
    for (const msg of data.results) {
      expect(msg.conversationKey).toBe(ALICE_KEY);
    }
  });

  it('list_chats returns all conversations', async () => {
    const result = await registry.call('list_chats', {}, session);

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text) as { chats: Array<{ conversationKey: string }> };
    const keys = data.chats.map((c) => c.conversationKey);
    expect(keys).toContain(ALICE_KEY);
    expect(keys).toContain(BOB_KEY);
  });

  it('all tools are visible in listTools for a global session', () => {
    const tools = registry.listTools(session);
    const toolNames = tools.map((t) => t.name);

    expect(toolNames).toContain('list_messages');
    expect(toolNames).toContain('search_messages');
    expect(toolNames).toContain('list_chats');
    expect(toolNames).toContain('send_message');
  });

  it('send_message requires chatJid in global session — missing chatJid is an error', async () => {
    const result = await registry.call(
      'send_message',
      { text: 'hello' }, // no chatJid
      session,
    );

    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: Two concurrent chat-scoped sessions
// ---------------------------------------------------------------------------

describe('two concurrent chat-scoped sessions', () => {
  let db: Database;
  let registry: ToolRegistry;

  beforeEach(() => {
    db = makeDb();
    seedMessages(db);
    registry = makeRegistry(db, makeMockSock(), makeMockConnection());
  });

  it('Alice session and Bob session each see only their own messages', async () => {
    const aliceResult = await registry.call(
      'list_messages',
      { conversation_key: ALICE_KEY },
      chatSession(ALICE_KEY, ALICE_JID),
    );

    const bobResult = await registry.call(
      'list_messages',
      { conversation_key: BOB_KEY },
      chatSession(BOB_KEY, BOB_JID),
    );

    expect(aliceResult.isError).toBeFalsy();
    expect(bobResult.isError).toBeFalsy();

    const aliceData = JSON.parse(aliceResult.content[0].text) as { messages: Array<{ conversationKey: string }> };
    const bobData = JSON.parse(bobResult.content[0].text) as { messages: Array<{ conversationKey: string }> };

    expect(aliceData.messages.every((m) => m.conversationKey === ALICE_KEY)).toBe(true);
    expect(bobData.messages.every((m) => m.conversationKey === BOB_KEY)).toBe(true);
  });

  it('FTS search is isolated per conversation_key', async () => {
    const aliceResult = await registry.call(
      'search_chat_messages',
      { conversation_key: ALICE_KEY, query: 'Hello' },
      chatSession(ALICE_KEY, ALICE_JID),
    );

    const bobResult = await registry.call(
      'search_chat_messages',
      { conversation_key: BOB_KEY, query: 'Hello' },
      chatSession(BOB_KEY, BOB_JID),
    );

    expect(aliceResult.isError).toBeFalsy();
    expect(bobResult.isError).toBeFalsy();

    const aliceData = JSON.parse(aliceResult.content[0].text) as { results: Array<{ conversationKey: string }> };
    const bobData = JSON.parse(bobResult.content[0].text) as { results: Array<{ conversationKey: string }> };

    expect(aliceData.results.every((r) => r.conversationKey === ALICE_KEY)).toBe(true);
    expect(bobData.results.every((r) => r.conversationKey === BOB_KEY)).toBe(true);
  });

  it('Alice cannot call global tools; Bob cannot call global tools', async () => {
    const aliceScopeViolation = await registry.call(
      'search_messages',
      { query: 'test' },
      chatSession(ALICE_KEY, ALICE_JID),
    );

    const bobScopeViolation = await registry.call(
      'search_messages',
      { query: 'test' },
      chatSession(BOB_KEY, BOB_JID),
    );

    expect(aliceScopeViolation.isError).toBe(true);
    expect(bobScopeViolation.isError).toBe(true);
    expect(aliceScopeViolation.content[0].text).toContain('not available in a chat-scoped session');
    expect(bobScopeViolation.content[0].text).toContain('not available in a chat-scoped session');
  });
});
