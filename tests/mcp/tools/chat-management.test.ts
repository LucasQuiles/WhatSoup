import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import { registerChatManagementTools } from '../../../src/mcp/tools/chat-management.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';
import type { WhatsAppSocket } from '../../../src/transport/connection.ts';

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
    sendMessage: vi.fn().mockResolvedValue(undefined),
    chatModify: vi.fn().mockResolvedValue(undefined),
    readMessages: vi.fn().mockResolvedValue(undefined),
    star: vi.fn().mockResolvedValue(undefined),
  } as unknown as WhatsAppSocket;
}

function seedConversations(db: Database) {
  db.raw.exec(`
    INSERT INTO messages
      (chat_jid, conversation_key, sender_jid, sender_name, message_id, content, content_type, is_from_me, timestamp)
    VALUES
      ('111@s.whatsapp.net', '111', '111@s.whatsapp.net', 'Alice', 'msg1', 'First message', 'text', 0, 1000),
      ('111@s.whatsapp.net', '111', '111@s.whatsapp.net', 'Alice', 'msg2', 'Second message', 'text', 0, 2000),
      ('111@s.whatsapp.net', '111', '111@s.whatsapp.net', 'Alice', 'msg3', 'Third message', 'text', 0, 3000),
      ('111@s.whatsapp.net', '111', '111@s.whatsapp.net', 'Alice', 'msg4', 'Fourth message', 'text', 0, 4000),
      ('111@s.whatsapp.net', '111', '111@s.whatsapp.net', 'Alice', 'msg5', 'Fifth message', 'text', 0, 5000),
      ('222@s.whatsapp.net', '222', '222@s.whatsapp.net', 'Bob',   'msg6', 'Bob chat', 'text', 0, 6000);
  `);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('chat-management tools', () => {
  let db: Database;
  let registry: ToolRegistry;
  let mockSock: WhatsAppSocket;

  beforeEach(() => {
    db = makeDb();
    mockSock = makeMockSock();
    registry = new ToolRegistry();
    registerChatManagementTools(db, () => mockSock, (tool) => registry.register(tool));
    seedConversations(db);
  });

  // --- list_messages ---

  describe('list_messages', () => {
    it('is visible in chat-scoped session', () => {
      const tools = registry.listTools(chatSession('111'));
      expect(tools.find((t) => t.name === 'list_messages')).toBeDefined();
    });

    it('returns messages for a conversation in chronological order', async () => {
      const result = await registry.call(
        'list_messages',
        { conversation_key: '111', limit: 10 },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text) as { messages: Array<{ messageId: string }> };
      const ids = data.messages.map((m) => m.messageId);
      expect(ids).toEqual(['msg1', 'msg2', 'msg3', 'msg4', 'msg5']);
    });

    it('paginates using before_pk', async () => {
      // Get the last 3 messages first
      const page1 = await registry.call(
        'list_messages',
        { conversation_key: '111', limit: 3 },
        globalSession(),
      );
      const page1Data = JSON.parse(page1.content[0].text) as {
        messages: Array<{ pk: number; messageId: string }>;
      };
      expect(page1Data.messages).toHaveLength(3);
      // These are msg3, msg4, msg5 (the 3 most recent, in chron order)
      const firstPkInPage = page1Data.messages[0].pk;

      // Page 2: messages before the first pk of page 1
      const page2 = await registry.call(
        'list_messages',
        { conversation_key: '111', limit: 10, before_pk: firstPkInPage },
        globalSession(),
      );
      const page2Data = JSON.parse(page2.content[0].text) as {
        messages: Array<{ pk: number; messageId: string }>;
      };
      // Should not overlap with page 1
      const page1Ids = new Set(page1Data.messages.map((m) => m.messageId));
      for (const m of page2Data.messages) {
        expect(page1Ids.has(m.messageId)).toBe(false);
      }
    });

    it('excludes soft-deleted messages', async () => {
      db.raw.exec(`UPDATE messages SET deleted_at = datetime('now') WHERE message_id = 'msg3'`);
      const result = await registry.call(
        'list_messages',
        { conversation_key: '111', limit: 10 },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { messages: Array<{ messageId: string }> };
      expect(data.messages.map((m) => m.messageId)).not.toContain('msg3');
    });
  });

  // --- get_message_context ---

  describe('get_message_context', () => {
    it('returns before, target, and after', async () => {
      const result = await registry.call(
        'get_message_context',
        { message_id: 'msg3', conversation_key: '111', context_size: 2 },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text) as {
        before: Array<{ messageId: string }>;
        target: { messageId: string };
        after: Array<{ messageId: string }>;
      };
      expect(data.target.messageId).toBe('msg3');
      expect(data.before.map((m) => m.messageId)).toContain('msg2');
      expect(data.after.map((m) => m.messageId)).toContain('msg4');
    });

    it('errors when message_id not found', async () => {
      const result = await registry.call(
        'get_message_context',
        { message_id: 'nonexistent', conversation_key: '111' },
        globalSession(),
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not found/);
    });

    it('errors when message belongs to different conversation', async () => {
      const result = await registry.call(
        'get_message_context',
        { message_id: 'msg6', conversation_key: '111' },
        globalSession(),
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/belongs to conversation/);
    });

    it('is visible in chat-scoped session (chat scope)', () => {
      const tools = registry.listTools(chatSession('111'));
      expect(tools.find((t) => t.name === 'get_message_context')).toBeDefined();
    });
  });

  // --- list_chats ---

  describe('list_chats', () => {
    it('is global scope only', () => {
      const chatTools = registry.listTools(chatSession('111'));
      expect(chatTools.find((t) => t.name === 'list_chats')).toBeUndefined();
    });

    it('returns all conversations with last activity', async () => {
      const result = await registry.call('list_chats', {}, globalSession());
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text) as {
        chats: Array<{ conversationKey: string; lastTimestamp: number }>;
      };
      const keys = data.chats.map((c) => c.conversationKey);
      expect(keys).toContain('111');
      expect(keys).toContain('222');
    });

    it('orders by most recent activity', async () => {
      const result = await registry.call('list_chats', {}, globalSession());
      const data = JSON.parse(result.content[0].text) as {
        chats: Array<{ conversationKey: string }>;
      };
      // 222 has most recent message (msg6 at 6000)
      expect(data.chats[0].conversationKey).toBe('222');
    });
  });

  // --- get_chat ---

  describe('get_chat', () => {
    it('returns details for an existing conversation', async () => {
      const result = await registry.call('get_chat', { conversation_key: '111' }, globalSession());
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text) as {
        conversationKey: string;
        messageCount: number;
      };
      expect(data.conversationKey).toBe('111');
      expect(data.messageCount).toBe(5);
    });

    it('errors for a nonexistent conversation', async () => {
      const result = await registry.call('get_chat', { conversation_key: 'zzz999' }, globalSession());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not found/);
    });

    it('is rejected in chat-scoped session', async () => {
      const result = await registry.call('get_chat', { conversation_key: '111' }, chatSession('111'));
      expect(result.isError).toBe(true);
    });
  });

  // --- forward_message ---

  describe('forward_message', () => {
    it('calls sock.sendMessage with the content', async () => {
      const result = await registry.call(
        'forward_message',
        { message_id: 'msg1', to_jid: '333@s.whatsapp.net' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect(mockSock.sendMessage).toHaveBeenCalledWith(
        '333@s.whatsapp.net',
        { text: 'First message' },
      );
    });

    it('errors when message not found', async () => {
      const result = await registry.call(
        'forward_message',
        { message_id: 'nonexistent', to_jid: '333@s.whatsapp.net' },
        globalSession(),
      );
      expect(result.isError).toBe(true);
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerChatManagementTools(db, () => null, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call(
        'forward_message',
        { message_id: 'msg1', to_jid: '333@s.whatsapp.net' },
        globalSession(),
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not connected/);
    });

    it('uses true Baileys forward when raw_message is available', async () => {
      // Add raw_message column and seed a message with it
      db.raw.exec('ALTER TABLE messages ADD COLUMN raw_message TEXT');
      db.raw
        .prepare(`UPDATE messages SET raw_message = ? WHERE message_id = 'msg1'`)
        .run(JSON.stringify({ key: { id: 'msg1' }, message: { conversation: 'First message' } }));

      const result = await registry.call(
        'forward_message',
        { message_id: 'msg1', to_jid: '333@s.whatsapp.net' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect(mockSock.sendMessage).toHaveBeenCalledWith(
        '333@s.whatsapp.net',
        expect.objectContaining({ forward: expect.any(Object) }),
      );
    });

    it('falls back to text forward when raw_message column is absent', async () => {
      // Do not add raw_message column — it does not exist in base schema
      const result = await registry.call(
        'forward_message',
        { message_id: 'msg1', to_jid: '333@s.whatsapp.net' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect(mockSock.sendMessage).toHaveBeenCalledWith(
        '333@s.whatsapp.net',
        { text: 'First message' },
      );
    });

    it('falls back to text when raw_message is null', async () => {
      db.raw.exec('ALTER TABLE messages ADD COLUMN raw_message TEXT');
      // raw_message is NULL for msg1 (not updated)
      const result = await registry.call(
        'forward_message',
        { message_id: 'msg1', to_jid: '333@s.whatsapp.net' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect(mockSock.sendMessage).toHaveBeenCalledWith(
        '333@s.whatsapp.net',
        { text: 'First message' },
      );
    });
  });

  // --- archive_chat ---

  describe('archive_chat', () => {
    it('calls chatModify with archive=true', async () => {
      const result = await registry.call(
        'archive_chat',
        { jid: '111@s.whatsapp.net', archive: true },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect(mockSock.chatModify).toHaveBeenCalledWith({ archive: true, lastMessages: [] }, '111@s.whatsapp.net');
    });

    it('calls chatModify with archive=false to unarchive', async () => {
      await registry.call(
        'archive_chat',
        { jid: '111@s.whatsapp.net', archive: false },
        globalSession(),
      );
      expect(mockSock.chatModify).toHaveBeenCalledWith({ archive: false, lastMessages: [] }, '111@s.whatsapp.net');
    });

    it('is rejected in chat-scoped session', async () => {
      const result = await registry.call(
        'archive_chat',
        { jid: '111@s.whatsapp.net', archive: true },
        chatSession('111'),
      );
      expect(result.isError).toBe(true);
    });
  });

  // --- pin_chat ---

  describe('pin_chat', () => {
    it('calls chatModify with pin=true', async () => {
      await registry.call(
        'pin_chat',
        { jid: '111@s.whatsapp.net', pin: true },
        globalSession(),
      );
      expect(mockSock.chatModify).toHaveBeenCalledWith({ pin: true }, '111@s.whatsapp.net');
    });
  });

  // --- mute_chat ---

  describe('mute_chat', () => {
    it('calls chatModify with mute timestamp when mute=true', async () => {
      await registry.call(
        'mute_chat',
        { jid: '111@s.whatsapp.net', mute: true, until: 9999999 },
        globalSession(),
      );
      expect(mockSock.chatModify).toHaveBeenCalledWith({ mute: 9999999 }, '111@s.whatsapp.net');
    });

    it('calls chatModify with mute=null when mute=false', async () => {
      await registry.call(
        'mute_chat',
        { jid: '111@s.whatsapp.net', mute: false },
        globalSession(),
      );
      expect(mockSock.chatModify).toHaveBeenCalledWith({ mute: null }, '111@s.whatsapp.net');
    });
  });

  // --- mark_messages_read ---

  describe('mark_messages_read', () => {
    it('calls sock.readMessages with correct keys', async () => {
      const result = await registry.call(
        'mark_messages_read',
        { jid: '111@s.whatsapp.net', message_ids: ['msg1', 'msg2'] },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect(mockSock.readMessages).toHaveBeenCalledWith([
        { remoteJid: '111@s.whatsapp.net', id: 'msg1', fromMe: false },
        { remoteJid: '111@s.whatsapp.net', id: 'msg2', fromMe: false },
      ]);
    });

    it('is rejected in chat-scoped session', async () => {
      const result = await registry.call(
        'mark_messages_read',
        { jid: '111@s.whatsapp.net', message_ids: ['msg1'] },
        chatSession('111'),
      );
      expect(result.isError).toBe(true);
    });
  });

  // --- star_message ---

  describe('star_message', () => {
    it('calls sock.star with star=true', async () => {
      const result = await registry.call(
        'star_message',
        { jid: '111@s.whatsapp.net', message_ids: ['msg1'], star: true },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect(mockSock.star).toHaveBeenCalledWith(
        '111@s.whatsapp.net',
        [{ id: 'msg1', fromMe: false }],
        true,
      );
    });

    it('calls sock.star with star=false to unstar', async () => {
      await registry.call(
        'star_message',
        { jid: '111@s.whatsapp.net', message_ids: ['msg1'], star: false },
        globalSession(),
      );
      expect(mockSock.star).toHaveBeenCalledWith(
        '111@s.whatsapp.net',
        [{ id: 'msg1', fromMe: false }],
        false,
      );
    });

    it('is rejected in chat-scoped session', async () => {
      const result = await registry.call(
        'star_message',
        { jid: '111@s.whatsapp.net', message_ids: ['msg1'], star: true },
        chatSession('111'),
      );
      expect(result.isError).toBe(true);
    });
  });
});
