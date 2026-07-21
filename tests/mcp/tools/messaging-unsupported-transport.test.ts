// tests/mcp/tools/messaging-unsupported-transport.test.ts
// Phase 2 — graceful capability degradation.
//
// When the active transport (e.g. Signal) does not support an operation the
// user is invoking via MCP tool, the tool must return a clean, agent-actionable
// tool error (error code `unsupported_transport`) instead of throwing an opaque
// exception up to the MCP caller. Agents key on the stable error code to learn
// not to retry that operation on this transport.
//
// This file exercises every MCP messaging tool whose handler delegates to
// `connection.sendRaw` or `connection.sendPollMessage` — both throw
// UnsupportedTransportOperationError on Signal / Twilio / iMessage today.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Database } from '../../../src/core/database.ts';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import { registerMessagingTools, type MessagingDeps } from '../../../src/mcp/tools/messaging.ts';
import { createProfileRegistry } from '../../../src/core/profiles.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';
import { UnsupportedTransportOperationError } from '../../../src/transport/signal/connection-bridge.ts';
import { emitAlertChecked } from '../../../src/lib/emit-alert.ts';

vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlertChecked: vi.fn(() => true),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE messages (
      pk INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid TEXT NOT NULL,
      conversation_key TEXT NOT NULL,
      sender_jid TEXT NOT NULL,
      sender_name TEXT,
      message_id TEXT UNIQUE,
      content TEXT,
      content_type TEXT NOT NULL DEFAULT 'text',
      is_from_me INTEGER NOT NULL DEFAULT 0,
      timestamp INTEGER NOT NULL,
      quoted_message_id TEXT,
      edited_at TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    CREATE TABLE chat_aliases (
      alias TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  // Seed a target message so reply/react/edit/delete/pin can resolve it.
  db.prepare(`
    INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content, is_from_me, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'main-chat@s.whatsapp.net',
    'main-chat',
    'main-chat@s.whatsapp.net',
    'msg-001',
    'hello',
    0,
    1_700_000_000,
  );
  // edit_message requires is_from_me=1 (you can only edit your own messages).
  db.prepare(`
    INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content, is_from_me, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'main-chat@s.whatsapp.net',
    'main-chat',
    'bot@s.whatsapp.net',
    'mine-001',
    'my outgoing',
    1,
    1_700_000_001,
  );
  return db;
}

/**
 * Connection whose sendRaw + sendPollMessage always throw the typed error
 * every unsupported transport throws. Models what messaging.ts sees when the
 * active transport is Signal / Twilio / iMessage.
 */
function makeUnsupportedConnection() {
  return {
    contactsDir: {
      contacts: new Map<string, string>(),
      getLidMappings: () => undefined,
    },
    sendRaw: async () => {
      throw new UnsupportedTransportOperationError('sendRaw');
    },
    sendPollMessage: async () => {
      throw new UnsupportedTransportOperationError('sendPollMessage');
    },
    sendMedia: async () => {
      throw new UnsupportedTransportOperationError('sendMedia');
    },
  } as unknown as import('../../../src/transport/connection.ts').ConnectionManager;
}

function chatSession(conversationKey: string, deliveryJid: string): SessionContext {
  return { tier: 'chat-scoped', conversationKey, deliveryJid };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerMessagingTools — unsupported-transport degradation', () => {
  let registry: ToolRegistry;
  let db: DatabaseSync;
  let dbWrapper: Database;
  let connection: ReturnType<typeof makeUnsupportedConnection>;
  let deps: MessagingDeps;

  beforeEach(() => {
    vi.mocked(emitAlertChecked).mockClear();
    registry = new ToolRegistry();
    db = makeDb();
    dbWrapper = new Database(':memory:');
    dbWrapper.open();
    connection = makeUnsupportedConnection();
    deps = {
      connection,
      db,
      dbWrapper,
      adminPhones: new Set<string>(),
      instanceName: 'test-bot',
      profiles: createProfileRegistry({}),
    };
    registerMessagingTools(registry, deps);
  });

  const session = (): SessionContext => chatSession('main-chat', 'main-chat@s.whatsapp.net');

  /**
   * Asserts the tool returned an `unsupported_transport` tool error rather than
   * throwing. We accept either:
   *   - result.isError === true with content[0].text matching the error code, OR
   *   - the parsed JSON body carrying { error: 'unsupported_transport' }
   * The exact surface depends on how each tool builds its return value; both
   * are "agent-actionable" because the LLM can read them. The non-negotiable
   * rule is: the tool did NOT throw.
   */
  function expectUnsupportedTransport(result: { isError?: boolean; content?: { text?: string }[] }) {
    // The hard contract: never throw to the MCP caller.
    // (calling code would have caught the throw; reaching here means we returned.)
    expect(result).toBeDefined();
    const text = result.content?.[0]?.text ?? '';
    const parsed = (() => { try { return JSON.parse(text); } catch { return null; } })();
    const carriesCode =
      (parsed && parsed.error === 'unsupported_transport')
      || /unsupported_transport/.test(text)
      || /not supported on this transport/i.test(text);
    if (!carriesCode) {
      throw new Error(
        `expected unsupported_transport tool error, got: ${JSON.stringify(result)}`,
      );
    }
  }

  // ── each tool that reaches sendRaw / sendPollMessage ──────────────────────

  it('send_message returns unsupported_transport (does not throw)', async () => {
    const result = await registry.call('send_message', { text: 'hi' }, session());
    expectUnsupportedTransport(result);
  });

  it('reply_message returns unsupported_transport (does not throw)', async () => {
    const result = await registry.call(
      'reply_message',
      { chatJid: 'main-chat@s.whatsapp.net', messageId: 'msg-001', text: 'reply' },
      session(),
    );
    expectUnsupportedTransport(result);
  });

  it('react_message returns unsupported_transport (does not throw)', async () => {
    const result = await registry.call(
      'react_message',
      { chatJid: 'main-chat@s.whatsapp.net', messageId: 'msg-001', emoji: '👍' },
      session(),
    );
    expectUnsupportedTransport(result);
  });

  it('edit_message returns unsupported_transport (does not throw)', async () => {
    const result = await registry.call(
      'edit_message',
      { chatJid: 'main-chat@s.whatsapp.net', messageId: 'mine-001', newText: 'edited' },
      session(),
    );
    expectUnsupportedTransport(result);
  });

  it('delete_message returns unsupported_transport (does not throw)', async () => {
    const result = await registry.call(
      'delete_message',
      { chatJid: 'main-chat@s.whatsapp.net', messageId: 'msg-001' },
      session(),
    );
    expectUnsupportedTransport(result);
  });

  it('send_location returns unsupported_transport (does not throw)', async () => {
    const result = await registry.call(
      'send_location',
      { chatJid: 'main-chat@s.whatsapp.net', latitude: 1.5, longitude: 2.5 },
      session(),
    );
    expectUnsupportedTransport(result);
  });

  it('send_contact returns unsupported_transport (does not throw)', async () => {
    const result = await registry.call(
      'send_contact',
      {
        chatJid: 'main-chat@s.whatsapp.net',
        contacts: [{ displayName: 'Alice', phone: '15555550001' }],
      },
      session(),
    );
    expectUnsupportedTransport(result);
  });

  it('send_poll returns unsupported_transport (does not throw)', async () => {
    const result = await registry.call(
      'send_poll',
      { chatJid: 'main-chat@s.whatsapp.net', question: 'Pick one', options: ['a', 'b'] },
      session(),
    );
    expectUnsupportedTransport(result);
  });

  it('pin_message returns unsupported_transport (does not throw)', async () => {
    const result = await registry.call(
      'pin_message',
      { chatJid: 'main-chat@s.whatsapp.net', messageId: 'msg-001', pin: true },
      session(),
    );
    expectUnsupportedTransport(result);
  });
});
