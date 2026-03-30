// tests/mcp/tools/messaging.test.ts

import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import { registerMessagingTools, type MessagingDeps } from '../../../src/mcp/tools/messaging.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';

// ---------------------------------------------------------------------------
// Helpers
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
  return db;
}

function seedMessage(
  db: DatabaseSync,
  overrides: {
    message_id?: string;
    chat_jid?: string;
    conversation_key?: string;
    sender_jid?: string;
    is_from_me?: number;
  } = {},
): string {
  const messageId = overrides.message_id ?? 'msg-001';
  db.prepare(`
    INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content, is_from_me, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.chat_jid ?? '1234567890@s.whatsapp.net',
    overrides.conversation_key ?? '1234567890',
    overrides.sender_jid ?? '1234567890@s.whatsapp.net',
    messageId,
    'hello',
    overrides.is_from_me ?? 0,
    1_700_000_000,
  );
  return messageId;
}

function makeCalls(): string[] {
  return [];
}

function makeConnection(calls: string[]) {
  return {
    contactsDir: {
      contacts: new Map<string, string>([['alice', '15555550001']]),
    },
    sendRaw: async (jid: string, content: unknown) => {
      calls.push(JSON.stringify({ jid, content }));
    },
    sendMedia: async (jid: string, media: unknown) => {
      calls.push(JSON.stringify({ sendMedia: { jid, media } }));
    },
  } as unknown as import('../../../src/transport/connection.ts').ConnectionManager;
}

function chatSession(conversationKey: string, deliveryJid: string): SessionContext {
  return { tier: 'chat-scoped', conversationKey, deliveryJid };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerMessagingTools', () => {
  let registry: ToolRegistry;
  let db: DatabaseSync;
  let calls: string[];
  let connection: ReturnType<typeof makeConnection>;
  let deps: MessagingDeps;

  beforeEach(() => {
    registry = new ToolRegistry();
    db = makeDb();
    calls = makeCalls();
    connection = makeConnection(calls);
    deps = { connection, db };
    registerMessagingTools(registry, deps);
  });

  // ── send_message ──────────────────────────────────────────────────────────

  describe('send_message', () => {
    it('calls sock.sendMessage with plain text', async () => {
      const session = chatSession('1234567890', '1234567890@s.whatsapp.net');
      const result = await registry.call('send_message', { text: 'Hello world' }, session);

      expect(result.isError).toBeUndefined();
      expect(calls).toHaveLength(1);
      const call = JSON.parse(calls[0]);
      expect(call.jid).toBe('1234567890@s.whatsapp.net');
      expect(call.content.text).toBe('Hello world');
    });

    it('applies mention formatting for @name patterns', async () => {
      const session = chatSession('1234567890', '1234567890@s.whatsapp.net');
      await registry.call('send_message', { text: 'Hi @alice!' }, session);

      expect(calls).toHaveLength(1);
      const call = JSON.parse(calls[0]);
      expect(call.content.text).toBe('Hi @15555550001!');
      expect(call.content.mentions).toContain('15555550001@s.whatsapp.net');
    });

    it('sends plain text without mentions field when no @mentions present', async () => {
      const session = chatSession('1234567890', '1234567890@s.whatsapp.net');
      await registry.call('send_message', { text: 'No mentions here' }, session);

      const call = JSON.parse(calls[0]);
      expect(call.content).not.toHaveProperty('mentions');
    });

    it('returns error when socket is not connected', async () => {
      (connection as any).sendRaw = async () => {
        throw new Error('WhatsApp is not connected');
      };

      const result = await registry.call(
        'send_message',
        { text: 'test' },
        chatSession('x', 'x@s.whatsapp.net'),
      );

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toMatch(/not connected/);
    });
  });

  // ── reply_message ─────────────────────────────────────────────────────────

  describe('reply_message', () => {
    it('sends a quoted reply to the correct message', async () => {
      const messageId = seedMessage(db, {
        chat_jid: '1234567890@s.whatsapp.net',
        conversation_key: '1234567890',
        sender_jid: 'bob@s.whatsapp.net',
        is_from_me: 0,
      });

      const session = chatSession('1234567890', '1234567890@s.whatsapp.net');
      const result = await registry.call('reply_message', { messageId, text: 'Replying!' }, session);

      expect(result.isError).toBeUndefined();
      const body = JSON.parse(result.content[0].text);
      expect(body.sent).toBe(true);

      const call = JSON.parse(calls[0]);
      expect(call.content.contextInfo.stanzaId).toBe(messageId);
    });

    it('returns error for unknown message ID', async () => {
      const session = chatSession('1234567890', '1234567890@s.whatsapp.net');
      const result = await registry.call('reply_message', { messageId: 'nonexistent', text: 'hi' }, session);

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toMatch(/Message not found/);
    });

    it('rejects cross-conversation access in chat-scoped session', async () => {
      seedMessage(db, { message_id: 'msg-other', conversation_key: 'other' });

      const session = chatSession('1234567890', '1234567890@s.whatsapp.net');
      const result = await registry.call('reply_message', { messageId: 'msg-other', text: 'sneaky' }, session);

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toMatch(/Access denied/);
    });
  });

  // ── react_message ─────────────────────────────────────────────────────────

  describe('react_message', () => {
    it('sends a reaction with the correct emoji and message key', async () => {
      const messageId = seedMessage(db, { conversation_key: '1234567890', is_from_me: 0 });
      const session = chatSession('1234567890', '1234567890@s.whatsapp.net');

      const result = await registry.call('react_message', { messageId, emoji: '👍' }, session);

      expect(result.isError).toBeUndefined();
      const call = JSON.parse(calls[0]);
      expect(call.content.react.text).toBe('👍');
      expect(call.content.react.key.id).toBe(messageId);
    });

    it('allows removing a reaction with empty string emoji', async () => {
      const messageId = seedMessage(db, { conversation_key: '1234567890' });
      const session = chatSession('1234567890', '1234567890@s.whatsapp.net');

      await registry.call('react_message', { messageId, emoji: '' }, session);

      const call = JSON.parse(calls[0]);
      expect(call.content.react.text).toBe('');
    });

    it('rejects cross-conversation message for react', async () => {
      seedMessage(db, { message_id: 'msg-x', conversation_key: 'other' });
      const session = chatSession('1234567890', '1234567890@s.whatsapp.net');

      const result = await registry.call('react_message', { messageId: 'msg-x', emoji: '❤️' }, session);

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toMatch(/Access denied/);
    });
  });

  // ── edit_message ──────────────────────────────────────────────────────────

  describe('edit_message', () => {
    it('sends edit for a message sent by me', async () => {
      const messageId = seedMessage(db, { conversation_key: '1234567890', is_from_me: 1 });
      const session = chatSession('1234567890', '1234567890@s.whatsapp.net');

      const result = await registry.call('edit_message', { messageId, newText: 'corrected text' }, session);

      expect(result.isError).toBeUndefined();
      const call = JSON.parse(calls[0]);
      expect(call.content.text).toBe('corrected text');
      expect(call.content.edit.id).toBe(messageId);
    });

    it('rejects editing a message not sent by me', async () => {
      const messageId = seedMessage(db, { conversation_key: '1234567890', is_from_me: 0 });
      const session = chatSession('1234567890', '1234567890@s.whatsapp.net');

      const result = await registry.call('edit_message', { messageId, newText: 'try to edit' }, session);

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toMatch(/own messages/);
    });

    it('rejects cross-conversation message for edit', async () => {
      seedMessage(db, { message_id: 'msg-y', conversation_key: 'other', is_from_me: 1 });
      const session = chatSession('1234567890', '1234567890@s.whatsapp.net');

      const result = await registry.call('edit_message', { messageId: 'msg-y', newText: 'hack' }, session);

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toMatch(/Access denied/);
    });
  });

  // ── delete_message ────────────────────────────────────────────────────────

  describe('delete_message', () => {
    it('sends delete for an existing message', async () => {
      const messageId = seedMessage(db, { conversation_key: '1234567890', is_from_me: 1 });
      const session = chatSession('1234567890', '1234567890@s.whatsapp.net');

      const result = await registry.call('delete_message', { messageId }, session);

      expect(result.isError).toBeUndefined();
      const call = JSON.parse(calls[0]);
      expect(call.content.delete.id).toBe(messageId);
    });

    it('rejects delete for nonexistent message', async () => {
      const session = chatSession('1234567890', '1234567890@s.whatsapp.net');
      const result = await registry.call('delete_message', { messageId: 'ghost' }, session);

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toMatch(/Message not found/);
    });

    it('rejects cross-conversation message for delete', async () => {
      seedMessage(db, { message_id: 'msg-z', conversation_key: 'other', is_from_me: 1 });
      const session = chatSession('1234567890', '1234567890@s.whatsapp.net');

      const result = await registry.call('delete_message', { messageId: 'msg-z' }, session);

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toMatch(/Access denied/);
    });
  });

  // ── send_location ─────────────────────────────────────────────────────────

  describe('send_location', () => {
    it('sends location with lat/lon', async () => {
      const session = chatSession('1234567890', '1234567890@s.whatsapp.net');
      const result = await registry.call(
        'send_location',
        { latitude: 40.7128, longitude: -74.006, name: 'NYC' },
        session,
      );

      expect(result.isError).toBeUndefined();
      const call = JSON.parse(calls[0]);
      expect(call.content.location.degreesLatitude).toBe(40.7128);
      expect(call.content.location.degreesLongitude).toBe(-74.006);
      expect(call.content.location.name).toBe('NYC');
    });
  });

  // ── send_contact ──────────────────────────────────────────────────────────

  describe('send_contact', () => {
    it('sends a vCard contact', async () => {
      const session = chatSession('1234567890', '1234567890@s.whatsapp.net');
      const result = await registry.call(
        'send_contact',
        { displayName: 'John Doe', phone: '15551234567' },
        session,
      );

      expect(result.isError).toBeUndefined();
      const call = JSON.parse(calls[0]);
      expect(call.content.contacts.displayName).toBe('John Doe');
      expect(call.content.contacts.contacts[0].vcard).toContain('John Doe');
      expect(call.content.contacts.contacts[0].vcard).toContain('15551234567');
    });
  });

  // ── send_poll ─────────────────────────────────────────────────────────────

  describe('send_poll', () => {
    it('sends a poll with question and options', async () => {
      const session = chatSession('1234567890', '1234567890@s.whatsapp.net');
      const result = await registry.call(
        'send_poll',
        { question: 'Favourite colour?', options: ['Red', 'Blue', 'Green'] },
        session,
      );

      expect(result.isError).toBeUndefined();
      const call = JSON.parse(calls[0]);
      expect(call.content.poll.name).toBe('Favourite colour?');
      expect(call.content.poll.values).toEqual(['Red', 'Blue', 'Green']);
    });

    it('rejects poll with fewer than 2 options', async () => {
      const session = chatSession('1234567890', '1234567890@s.whatsapp.net');
      const result = await registry.call(
        'send_poll',
        { question: 'One option?', options: ['Only one'] },
        session,
      );

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toMatch(/at least 2 options/);
    });

    it('rejects poll with more than 12 options', async () => {
      const session = chatSession('1234567890', '1234567890@s.whatsapp.net');
      const tooMany = Array.from({ length: 13 }, (_, i) => `Option ${i + 1}`);
      const result = await registry.call(
        'send_poll',
        { question: 'Too many?', options: tooMany },
        session,
      );

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toMatch(/at most 12 options/);
    });
  });

  // ── pin_message ───────────────────────────────────────────────────────────

  describe('pin_message', () => {
    it('pins a message', async () => {
      const messageId = seedMessage(db, { conversation_key: '1234567890' });
      const session = chatSession('1234567890', '1234567890@s.whatsapp.net');

      const result = await registry.call('pin_message', { messageId, pin: true }, session);

      expect(result.isError).toBeUndefined();
      const call = JSON.parse(calls[0]);
      expect(call.content.pin.id).toBe(messageId);
      expect(call.content.type).toBe(1);
    });

    it('unpins a message', async () => {
      const messageId = seedMessage(db, { conversation_key: '1234567890' });
      const session = chatSession('1234567890', '1234567890@s.whatsapp.net');

      const result = await registry.call('pin_message', { messageId, pin: false }, session);

      expect(result.isError).toBeUndefined();
      const call = JSON.parse(calls[0]);
      expect(call.content.type).toBe(2);
    });

    it('rejects cross-conversation message for pin', async () => {
      seedMessage(db, { message_id: 'msg-p', conversation_key: 'other' });
      const session = chatSession('1234567890', '1234567890@s.whatsapp.net');

      const result = await registry.call('pin_message', { messageId: 'msg-p', pin: true }, session);

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toMatch(/Access denied/);
    });
  });
});
