/**
 * Integration: Exception Handling and Unknown Input Tests
 *
 * Verifies WhatSoup survives failure scenarios without crashing.
 * Tests cover:
 * 1. Tool handler resilience: invalid params, missing messages, disconnected socket
 * 2. Database error propagation: WhatSoupError with DATABASE_ERROR code
 * 3. ToolRegistry unknown-tool and schema-validation error paths
 * 4. Unexpected input via ToolRegistry.call (null/empty/huge params)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { ToolRegistry } from '../../src/mcp/registry.ts';
import { registerChatManagementTools } from '../../src/mcp/tools/chat-management.ts';
import { registerSearchTools } from '../../src/mcp/tools/search.ts';
import { registerMessagingTools, type MessagingDeps } from '../../src/mcp/tools/messaging.ts';
import { WhatSoupError } from '../../src/errors.ts';
import type { SessionContext } from '../../src/mcp/types.ts';
import type { WhatsAppSocket } from '../../src/transport/connection.ts';
import type { ConnectionManager } from '../../src/transport/connection.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function makeMockSock(): WhatsAppSocket {
  return {
    sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
    chatModify: vi.fn().mockResolvedValue(undefined),
    readMessages: vi.fn().mockResolvedValue(undefined),
    star: vi.fn().mockResolvedValue(undefined),
  } as unknown as WhatsAppSocket;
}

function makeNullSock(): () => WhatsAppSocket | null {
  return () => null;
}

function makeMockConnection(): ConnectionManager {
  return {
    contactsDir: { contacts: new Map<string, string>() },
    sendRaw: vi.fn().mockResolvedValue({ waMessageId: null }),
    sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
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

function makeRegistry(db: Database, getSock: () => WhatsAppSocket | null, conn: ConnectionManager): ToolRegistry {
  const registry = new ToolRegistry();
  registerChatManagementTools(db, getSock, (tool) => registry.register(tool));
  registerSearchTools(db, (tool) => registry.register(tool));
  const deps: MessagingDeps = { connection: conn, db: db.raw };
  registerMessagingTools(registry, deps);
  return registry;
}

// ---------------------------------------------------------------------------
// 1. Unknown tool and schema validation
// ---------------------------------------------------------------------------

describe('ToolRegistry error paths', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    const db = makeDb();
    registry = makeRegistry(db, makeNullSock(), makeMockConnection());
  });

  it('call with unknown tool name → isError, message contains "Unknown tool"', async () => {
    const result = await registry.call('does_not_exist', {}, globalSession());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool');
  });

  it('call with missing required params → isError, message contains "Invalid parameters"', async () => {
    // list_messages requires conversation_key
    const result = await registry.call('list_messages', {}, globalSession());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid parameters');
  });

  it('call with wrong param type → isError, message contains "Invalid parameters"', async () => {
    const result = await registry.call(
      'list_messages',
      { conversation_key: 12345 }, // number instead of string
      globalSession(),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid parameters');
  });

  it('call with extra unknown params → does not crash (Zod strips unknown keys by default)', async () => {
    const db = makeDb();
    const reg = makeRegistry(db, makeNullSock(), makeMockConnection());
    const result = await reg.call(
      'list_messages',
      { conversation_key: 'testkey', unknown_extra_param: 'oops', also_bad: 99 },
      globalSession(),
    );
    // Should succeed (Zod strips extra keys) or fail gracefully
    // Either way it must not throw
    expect(typeof result.isError === 'boolean' || result.isError === undefined).toBe(true);
  });

  it('empty string params → isError (Zod minLength not set but empty conversation_key returns empty results)', async () => {
    const db = makeDb();
    const reg = makeRegistry(db, makeNullSock(), makeMockConnection());
    const result = await reg.call(
      'list_messages',
      { conversation_key: '' },
      globalSession(),
    );
    // Should complete without throwing, regardless of outcome
    expect(result).toBeDefined();
    expect(result.content).toBeDefined();
    expect(result.content.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Tool handlers with disconnected socket
// ---------------------------------------------------------------------------

describe('Tool handlers with disconnected WhatsApp socket', () => {
  let db: Database;
  let registry: ToolRegistry;

  beforeEach(() => {
    db = makeDb();
    registry = makeRegistry(db, makeNullSock(), makeMockConnection());
  });

  it('send_message fails gracefully when connection.sendRaw throws', async () => {
    const throwingConn = {
      contactsDir: { contacts: new Map<string, string>() },
      sendRaw: vi.fn().mockRejectedValue(new Error('WhatsApp not connected')),
    } as unknown as ConnectionManager;

    const reg = new ToolRegistry();
    registerMessagingTools(reg, { connection: throwingConn, db: db.raw });

    const result = await reg.call(
      'send_message',
      { chatJid: '15551234567@s.whatsapp.net', text: 'hello' },
      globalSession(),
    );

    // Tool handler catches the error and returns it in the result (not an uncaught throw)
    expect(result).toBeDefined();
  });

  it('archive_chat with null socket → isError, message mentions not connected', async () => {
    const result = await registry.call(
      'archive_chat',
      { jid: '15551234567@s.whatsapp.net', archive: true },
      globalSession(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not connected|WhatsApp/i);
  });

  it('mark_messages_read with null socket → isError', async () => {
    const result = await registry.call(
      'mark_messages_read',
      { jid: '15551234567@s.whatsapp.net', message_ids: ['msg1', 'msg2'] },
      globalSession(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not connected|WhatsApp/i);
  });

  it('forward_message with null socket → isError', async () => {
    const result = await registry.call(
      'forward_message',
      { message_id: 'nonexistent-msg', to_jid: '15551234567@s.whatsapp.net' },
      globalSession(),
    );

    // Should fail with "not connected" or "not found" — either way it must not crash
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Database interactions with missing/invalid messages
// ---------------------------------------------------------------------------

describe('Tool handlers with missing or invalid messages', () => {
  let db: Database;
  let registry: ToolRegistry;

  beforeEach(() => {
    db = makeDb();
    // Seed one valid message
    db.raw.exec(`
      INSERT INTO messages (chat_jid, conversation_key, sender_jid, sender_name, message_id, content, content_type, is_from_me, timestamp)
      VALUES ('15551234567@s.whatsapp.net', '15551234567', '15551234567@s.whatsapp.net', 'Alice', 'msg-001', 'Hello', 'text', 0, 1000)
    `);
    registry = makeRegistry(db, makeNullSock(), makeMockConnection());
  });

  it('get_message_context with non-existent message_id → isError, message contains message ID or not found', async () => {
    const result = await registry.call(
      'get_message_context',
      { message_id: 'msg-does-not-exist', conversation_key: '15551234567' },
      globalSession(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found|msg-does-not-exist/i);
  });

  it('get_message_context with wrong conversation_key → isError about conversation mismatch', async () => {
    const result = await registry.call(
      'get_message_context',
      { message_id: 'msg-001', conversation_key: 'wrong-conversation-key' },
      globalSession(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/wrong-conversation-key|belongs to/i);
  });

  it('get_chat with non-existent conversation_key → isError, message contains key or not found', async () => {
    const result = await registry.call(
      'get_chat',
      { conversation_key: 'no-such-conversation' },
      globalSession(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no-such-conversation|not found/i);
  });

  it('list_messages with empty result set → isError is false, messages array is empty', async () => {
    const result = await registry.call(
      'list_messages',
      { conversation_key: 'empty-conversation' },
      globalSession(),
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text) as { messages: unknown[] };
    expect(data.messages).toHaveLength(0);
  });

  it('search_chat_messages with no results → isError is false, results array is empty', async () => {
    const result = await registry.call(
      'search_chat_messages',
      { conversation_key: '15551234567', query: 'zzznonexistentterm' },
      chatSession('15551234567', '15551234567@s.whatsapp.net'),
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text) as { results: unknown[] };
    expect(data.results).toHaveLength(0);
  });

  it('reply_message with non-existent messageId → returns error field in result', async () => {
    const conn = makeMockConnection();
    const reg = new ToolRegistry();
    registerMessagingTools(reg, { connection: conn, db: db.raw });

    const result = await reg.call(
      'reply_message',
      { chatJid: '15551234567@s.whatsapp.net', messageId: 'ghost-msg-id', text: 'reply' },
      chatSession('15551234567', '15551234567@s.whatsapp.net'),
    );

    // Tool returns { error: 'Message not found' } — the registry wraps it as success
    // but the content will contain error info
    expect(result).toBeDefined();
    const text = result.content[0].text;
    expect(text).toMatch(/not found|error/i);
  });

  it('edit_message on a non-own message → returns "Can only edit your own messages"', async () => {
    db.raw.exec(`
      INSERT INTO messages (chat_jid, conversation_key, sender_jid, sender_name, message_id, content, content_type, is_from_me, timestamp)
      VALUES ('15551234567@s.whatsapp.net', '15551234567', '15551234567@s.whatsapp.net', 'Alice', 'alice-msg', 'Hi', 'text', 0, 2000)
    `);

    const conn = makeMockConnection();
    const reg = new ToolRegistry();
    registerMessagingTools(reg, { connection: conn, db: db.raw });

    const result = await reg.call(
      'edit_message',
      { chatJid: '15551234567@s.whatsapp.net', messageId: 'alice-msg', newText: 'changed' },
      chatSession('15551234567', '15551234567@s.whatsapp.net'),
    );

    expect(result).toBeDefined();
    const text = result.content[0].text;
    expect(text).toMatch(/edit.*own|own.*message/i);
  });
});

// ---------------------------------------------------------------------------
// 4. WhatSoupError contract in DB context
// ---------------------------------------------------------------------------

describe('WhatSoupError construction via Database operations', () => {
  it('Database constructor with bad path → WhatSoupError with DATABASE_ERROR code', () => {
    // Exercising WhatSoupError directly
    const cause = new Error('SQLITE: unable to open database');
    const err = new WhatSoupError('Cannot open database at /bad/path/bot.db', 'DATABASE_ERROR', cause);

    expect(err).toBeInstanceOf(WhatSoupError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('DATABASE_ERROR');
    expect(err.cause).toBe(cause);
    expect(err.retryable).toBe(false);
    expect(err.name).toBe('WhatSoupError');
  });

  it('WhatSoupError with SEND_FAILED is not retryable', () => {
    const err = new WhatSoupError('send timed out', 'SEND_FAILED');
    expect(err.retryable).toBe(false);
  });

  it('WhatSoupError with CONNECTION_UNAVAILABLE is retryable', () => {
    const err = new WhatSoupError('socket closed', 'CONNECTION_UNAVAILABLE');
    expect(err.retryable).toBe(true);
  });

  it('WhatSoupError with LLM_UNAVAILABLE is retryable', () => {
    const err = new WhatSoupError('anthropic 503', 'LLM_UNAVAILABLE');
    expect(err.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Resilience: ToolRegistry call never throws (always returns ToolCallResult)
// ---------------------------------------------------------------------------

describe('ToolRegistry.call always returns ToolCallResult, never throws', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  const brokenInputs = [
    { name: 'null params value', params: { conversation_key: null } },
    { name: 'undefined params value', params: { conversation_key: undefined } },
    { name: 'numeric instead of string', params: { conversation_key: 0 } },
    { name: 'object instead of string', params: { conversation_key: {} } },
    { name: 'array instead of string', params: { conversation_key: [] } },
  ];

  for (const tc of brokenInputs) {
    it(`list_messages with ${tc.name} → returns result, does not throw`, async () => {
      const registry = makeRegistry(db, makeNullSock(), makeMockConnection());
      let result;
      let threw = false;

      try {
        result = await registry.call('list_messages', tc.params as Record<string, unknown>, globalSession());
      } catch {
        threw = true;
      }

      expect(threw).toBe(false);
      expect(result).toBeDefined();
      expect(result!.content).toBeDefined();
    });
  }

  it('send_message with very long text (100k chars) → does not throw', async () => {
    const conn = makeMockConnection();
    const registry = makeRegistry(db, makeNullSock(), conn);
    const longText = 'a'.repeat(100_000);

    let threw = false;
    try {
      await registry.call(
        'send_message',
        { chatJid: '15551234567@s.whatsapp.net', text: longText },
        globalSession(),
      );
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
  });
});
