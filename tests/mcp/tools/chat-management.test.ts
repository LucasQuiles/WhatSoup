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

    it.each([
      ['negative', -1],
      ['zero', 0],
      ['fractional', 1.5],
      ['oversized', 1001],
    ])('rejects %s limit values', async (_name, limit) => {
      const result = await registry.call(
        'list_messages',
        { conversation_key: '111', limit },
        globalSession(),
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/Invalid parameters/);
      expect(result.content[0].text).toMatch(/limit/);
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

    it('does not leak the target conversation for cross-chat IDs in chat-scoped sessions', async () => {
      const result = await registry.call(
        'get_message_context',
        { message_id: 'msg6', conversation_key: '222' },
        chatSession('111'),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not found/);
      expect(result.content[0].text).not.toContain('222');
      expect(result.content[0].text).not.toMatch(/belongs to conversation/);
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

    it('filters conversations by query across key, jid, and chat name', async () => {
      db.raw.exec(`
        INSERT INTO chats (jid, conversation_key, name, unread_count, is_archived)
        VALUES ('111@s.whatsapp.net', '111', 'Alice Chat', 3, 0)
      `);

      const byName = await registry.call('list_chats', { query: 'alice' }, globalSession());
      expect(byName.isError).toBeUndefined();
      const nameData = JSON.parse(byName.content[0].text) as { chats: Array<{ conversationKey: string }> };
      expect(nameData.chats.map((c) => c.conversationKey)).toEqual(['111']);

      const byJid = await registry.call('list_chats', { query: '222@s.whatsapp.net' }, globalSession());
      expect(byJid.isError).toBeUndefined();
      const jidData = JSON.parse(byJid.content[0].text) as { chats: Array<{ conversationKey: string }> };
      expect(jidData.chats.map((c) => c.conversationKey)).toEqual(['222']);
    });

    it('filters LID-addressed conversations by mapped phone JID', async () => {
      db.raw.exec(`
        INSERT INTO messages
          (chat_jid, conversation_key, sender_jid, sender_name, message_id, content, content_type, is_from_me, timestamp)
        VALUES
          ('9999@lid', '9999', '9999@lid', 'Lid Contact', 'msg-lid', 'LID-backed DM', 'text', 0, 7000);
        INSERT INTO lid_mappings (lid, phone_jid)
        VALUES ('9999', 'fixture-phone@s.whatsapp.net')
      `);

      const result = await registry.call('list_chats', { query: 'fixture-phone' }, globalSession());
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text) as {
        chats: Array<{ conversationKey: string; chatJid: string }>;
      };
      expect(data.chats.map((c) => c.conversationKey)).toEqual(['9999']);
      expect(data.chats[0].chatJid).toBe('9999@lid');
    });

    it('filters device-suffixed LID conversations by mapped phone JID', async () => {
      db.raw.exec(`
        INSERT INTO messages
          (chat_jid, conversation_key, sender_jid, sender_name, message_id, content, content_type, is_from_me, timestamp)
        VALUES
          ('9999:12@lid', '9999', '9999:12@lid', 'Lid Contact', 'msg-lid-device', 'LID-backed DM', 'text', 0, 7000);
        INSERT INTO lid_mappings (lid, phone_jid)
        VALUES ('9999', 'fixture-phone@s.whatsapp.net')
      `);

      const result = await registry.call('list_chats', { query: 'fixture-phone' }, globalSession());
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text) as {
        chats: Array<{ conversationKey: string; chatJid: string }>;
      };
      expect(data.chats.map((c) => c.conversationKey)).toEqual(['9999']);
      expect(data.chats[0].chatJid).toBe('9999:12@lid');
    });

    it('treats query wildcard characters as literal substring characters', async () => {
      db.raw.exec(`
        INSERT INTO chats (jid, conversation_key, name, unread_count, is_archived)
        VALUES
          ('333@s.whatsapp.net', '333', '100% Real', 0, 0),
          ('334@s.whatsapp.net', '334', '1000 Real', 0, 0),
          ('335@s.whatsapp.net', '335', 'A_B Contact', 0, 0),
          ('336@s.whatsapp.net', '336', 'ACB Contact', 0, 0)
      `);

      const percent = await registry.call('list_chats', { query: '100%' }, globalSession());
      expect(percent.isError).toBeUndefined();
      const percentData = JSON.parse(percent.content[0].text) as { chats: Array<{ conversationKey: string }> };
      expect(percentData.chats.map((c) => c.conversationKey)).toEqual(['333']);

      const underscore = await registry.call('list_chats', { query: 'a_' }, globalSession());
      expect(underscore.isError).toBeUndefined();
      const underscoreData = JSON.parse(underscore.content[0].text) as { chats: Array<{ conversationKey: string }> };
      expect(underscoreData.chats.map((c) => c.conversationKey)).toEqual(['335']);
    });

    it('does not broaden LID mapping joins when stored LID values contain wildcard characters', async () => {
      db.raw.exec(`
        INSERT INTO messages
          (chat_jid, conversation_key, sender_jid, sender_name, message_id, content, content_type, is_from_me, timestamp)
        VALUES
          ('abcx:1@lid', 'abcx', 'abcx:1@lid', 'Corrupt Lid Candidate', 'msg-wild-lid', 'Should not match', 'text', 0, 7000);
        INSERT INTO lid_mappings (lid, phone_jid)
        VALUES ('abc_', 'wildcard-phone@s.whatsapp.net')
      `);

      const result = await registry.call('list_chats', { query: 'wildcard-phone' }, globalSession());
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text) as { chats: Array<{ conversationKey: string }> };
      expect(data.chats).toEqual([]);
    });

    it('rejects impractically large page offsets', async () => {
      const result = await registry.call('list_chats', { page: 100_001 }, globalSession());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/Invalid parameters/);
      expect(result.content[0].text).toMatch(/page/);
    });

    it('paginates after sorting by last activity', async () => {
      const firstPage = await registry.call('list_chats', { limit: 1, page: 0 }, globalSession());
      const secondPage = await registry.call('list_chats', { limit: 1, page: 1 }, globalSession());
      const firstData = JSON.parse(firstPage.content[0].text) as { chats: Array<{ conversationKey: string }>; page: number };
      const secondData = JSON.parse(secondPage.content[0].text) as { chats: Array<{ conversationKey: string }>; page: number };

      expect(firstData.page).toBe(0);
      expect(secondData.page).toBe(1);
      expect(firstData.chats.map((c) => c.conversationKey)).toEqual(['222']);
      expect(secondData.chats.map((c) => c.conversationKey)).toEqual(['111']);
    });

    it('sorts by chat name when requested', async () => {
      db.raw.exec(`
        INSERT INTO chats (jid, conversation_key, name, unread_count, is_archived)
        VALUES
          ('111@s.whatsapp.net', '111', 'Alice Chat', 0, 0),
          ('222@s.whatsapp.net', '222', 'Bob Chat', 0, 0)
      `);

      const result = await registry.call('list_chats', { sort_by: 'name' }, globalSession());
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text) as { chats: Array<{ conversationKey: string }> };
      expect(data.chats.map((c) => c.conversationKey)).toEqual(['111', '222']);
    });

    it('includes the latest message only when requested', async () => {
      const withoutPreview = await registry.call('list_chats', { limit: 1 }, globalSession());
      const withoutData = JSON.parse(withoutPreview.content[0].text) as { chats: Array<{ lastMessage?: unknown }> };
      expect(withoutData.chats[0].lastMessage).toBeUndefined();

      const withPreview = await registry.call(
        'list_chats',
        { limit: 1, include_last_message: true },
        globalSession(),
      );
      expect(withPreview.isError).toBeUndefined();
      const withData = JSON.parse(withPreview.content[0].text) as {
        chats: Array<{
          conversationKey: string;
          lastMessage: { messageId: string; contentPreview: string; content?: string; contentType: string };
        }>;
      };
      expect(withData.chats[0].conversationKey).toBe('222');
      expect(withData.chats[0].lastMessage.messageId).toBe('msg6');
      expect(withData.chats[0].lastMessage.contentPreview).toBe('Bob chat');
      expect(withData.chats[0].lastMessage.content).toBeUndefined();
      expect(withData.chats[0].lastMessage.contentType).toBe('text');
    });

    it('truncates last-message previews to avoid bloating agent context', async () => {
      const longText = 'x'.repeat(150);
      db.raw.prepare(`
        INSERT INTO messages
          (chat_jid, conversation_key, sender_jid, sender_name, message_id, content, content_text, content_type, is_from_me, timestamp)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        '333@s.whatsapp.net',
        '333',
        '333@s.whatsapp.net',
        'Carol',
        'msg-long',
        longText,
        longText,
        'text',
        0,
        7000,
      );

      const result = await registry.call(
        'list_chats',
        { limit: 1, include_last_message: true },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text) as {
        chats: Array<{ lastMessage: { contentPreview: string } }>;
      };
      expect(data.chats[0].lastMessage.contentPreview).toHaveLength(100);
      expect(data.chats[0].lastMessage.contentPreview.endsWith('...')).toBe(true);
    });
  });

  // --- list_chats — with chat metadata ---

  describe('list_chats — with chat metadata', () => {
    it('includes metadata from chats table when available', async () => {
      // Seed the chats table with metadata
      db.raw.exec(`
        INSERT INTO chats (jid, conversation_key, name, unread_count, is_archived)
        VALUES ('111@s.whatsapp.net', '111', 'Alice Chat', 3, 0)
      `);

      const result = await registry.call(
        'list_chats',
        { limit: 10 },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      const chat = parsed.chats.find((c: any) => c.conversationKey === '111');
      expect(chat).toBeDefined();
      expect(chat.name).toBe('Alice Chat');
      expect(chat.unreadCount).toBe(3);
    });

    it('works when no metadata exists', async () => {
      const result = await registry.call(
        'list_chats',
        { limit: 10 },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      // Should still return chats from messages table
      expect(parsed.chats.length).toBeGreaterThan(0);
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
      // Seed raw_message for the existing message (column added by migration 5)
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
      // raw_message column exists (added by migration 5) but value is NULL — falls back to text
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
      // raw_message is NULL for msg1 (not updated) — column exists from migration 5
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

    it('rejects forwarding a source message outside a bound global conversation', async () => {
      const result = await registry.call(
        'forward_message',
        { message_id: 'msg6', to_jid: '111@s.whatsapp.net' },
        { tier: 'global', conversationKey: '111' },
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('different conversation');
      expect(result.content[0].text).not.toContain('Bob chat');
      expect(mockSock.sendMessage).not.toHaveBeenCalled();
    });

    it('rejects forwarding to a destination outside a bound global conversation', async () => {
      const result = await registry.call(
        'forward_message',
        { message_id: 'msg1', to_jid: '222@s.whatsapp.net' },
        { tier: 'global', conversationKey: '111' },
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('different conversation');
      expect(mockSock.sendMessage).not.toHaveBeenCalled();
    });
  });

  // --- forward_message: outbound identity guard ---

  describe('forward_message — outbound identity guard', () => {
    it('enforce mode blocks a forward to a cold target before any sock.sendMessage', async () => {
      const { config } = await import('../../../src/config.ts');
      const original = config.outboundIdentityMode;
      config.outboundIdentityMode = 'enforce';
      try {
        // 333@s.whatsapp.net has no contact / no access / no inbound — cold.
        const result = await registry.call(
          'forward_message',
          { message_id: 'msg1', to_jid: '333@s.whatsapp.net' },
          globalSession(),
        );
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/identity guard blocked/i);
        expect(mockSock.sendMessage).not.toHaveBeenCalled();
      } finally {
        config.outboundIdentityMode = original;
      }
    });

    it('log-only mode forwards to a cold target (audit only, no block)', async () => {
      const { config } = await import('../../../src/config.ts');
      const original = config.outboundIdentityMode;
      config.outboundIdentityMode = 'log-only';
      try {
        const result = await registry.call(
          'forward_message',
          { message_id: 'msg1', to_jid: '333@s.whatsapp.net' },
          globalSession(),
        );
        expect(result.isError).toBeUndefined();
        expect(mockSock.sendMessage).toHaveBeenCalledTimes(1);
      } finally {
        config.outboundIdentityMode = original;
      }
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

// ---------------------------------------------------------------------------
// chat-management.ts uncovered-branch coverage
//
// Targets the residual branches not exercised by the happy-path suites above.
// Each test is paired to one or more lines that the per-file coverage report
// previously flagged as not-covered.
// ---------------------------------------------------------------------------

describe('chat-management.ts uncovered-branch coverage', () => {
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

  // --- list_chats: contentPreview / metadata branches ---

  describe('list_chats — residual branches', () => {
    it('returns null contentPreview when the last message has neither content_text nor content', async () => {
      // Media-only message: both `content` and `content_text` are NULL.
      db.raw
        .prepare(
          `INSERT INTO messages
             (chat_jid, conversation_key, sender_jid, sender_name, message_id,
              content, content_text, content_type, is_from_me, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          '333@s.whatsapp.net',
          '333',
          '333@s.whatsapp.net',
          'Carol',
          'msg-media',
          null,
          null,
          'image',
          0,
          8000,
        );

      const result = await registry.call(
        'list_chats',
        { limit: 10, include_last_message: true },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text) as {
        chats: Array<{ lastMessage: { messageId: string; contentPreview: string | null } | null }>;
      };
      const mediaChat = data.chats.find((c) => c.lastMessage?.messageId === 'msg-media');
      expect(mediaChat).toBeDefined();
      expect(mediaChat?.lastMessage).toMatchObject({ messageId: 'msg-media', contentPreview: null });
    });

    it('reports isArchived / isPinned when the chats row has the corresponding flags set', async () => {
      db.raw.exec(`
        INSERT INTO chats
          (jid, conversation_key, name, unread_count, is_archived, is_pinned, mute_until, ephemeral_duration)
        VALUES
          ('111@s.whatsapp.net', '111', 'Alice Chat', 0, 1, 1, NULL, NULL)
      `);

      const result = await registry.call('list_chats', { limit: 10 }, globalSession());
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text) as {
        chats: Array<{
          conversationKey: string;
          isArchived: boolean | undefined;
          isPinned: boolean | undefined;
        }>;
      };
      const alice = data.chats.find((c) => c.conversationKey === '111');
      expect(alice).toBeDefined();
      expect(alice?.isArchived).toBe(true);
      expect(alice?.isPinned).toBe(true);
    });

    it('returns null senderName and null lastMessage for chats that have no messages', async () => {
      // chats-only conversation: the UNION ALL branch of base_conversation_rows.
      db.raw.exec(`
        INSERT INTO chats (jid, conversation_key, name, unread_count, is_archived, is_pinned)
        VALUES ('555@s.whatsapp.net', '555', 'Empty Chat', 0, 0, 0)
      `);

      const result = await registry.call(
        'list_chats',
        { limit: 10, include_last_message: true, query: 'empty' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text) as {
        chats: Array<{ lastMessage: unknown }>;
      };
      expect(data.chats).toHaveLength(1);
      expect(data.chats[0]).toMatchObject({ lastMessage: null });
    });

    it('returns null senderName for messages with no sender_name set', async () => {
      db.raw
        .prepare(
          `INSERT INTO messages
             (chat_jid, conversation_key, sender_jid, sender_name, message_id,
              content, content_text, content_type, is_from_me, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          '444@s.whatsapp.net',
          '444',
          '444@s.whatsapp.net',
          null,
          'msg-noname',
          'hi',
          'hi',
          'text',
          0,
          9000,
        );

      const result = await registry.call(
        'list_chats',
        { limit: 10, include_last_message: true },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text) as {
        chats: Array<{
          lastMessage: { messageId: string; senderName: string | null } | null;
        }>;
      };
      const chat = data.chats.find((c) => c.lastMessage?.messageId === 'msg-noname');
      expect(chat).toBeDefined();
      expect(chat?.lastMessage).toMatchObject({ messageId: 'msg-noname', senderName: null });
    });
  });

  // --- get_chat: normalization / not-found branches ---

  describe('get_chat — residual branches', () => {
    it('accepts a raw JID with a @g.us domain and normalises it for lookup', async () => {
      // Seed a group conversation using the encoded key form ('..._at_g.us').
      db.raw.exec(`
        INSERT INTO messages
          (chat_jid, conversation_key, sender_jid, sender_name, message_id, content, content_type, is_from_me, timestamp)
        VALUES
          ('grp1@g.us', 'grp1_at_g.us', 'grp1@g.us', 'Group Member', 'gmsg1', 'group hello', 'text', 0, 11000)
      `);

      const result = await registry.call(
        'get_chat',
        { conversation_key: 'grp1@g.us' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text) as {
        conversationKey: string;
        messageCount: number;
        chatJid: string;
      };
      expect(data.conversationKey).toBe('grp1_at_g.us');
      expect(data.messageCount).toBe(1);
      expect(data.chatJid).toBe('grp1@g.us');
    });
  });

  // --- forward_message: error & fallback branches ---

  describe('forward_message — residual branches', () => {
    it('rejects a malformed to_jid when a global session is bound to a conversation', async () => {
      // session.conversationKey is set AND to_jid has no '@' -> toConversationKey throws.
      const result = await registry.call(
        'forward_message',
        { message_id: 'msg1', to_jid: 'not-a-jid' },
        { tier: 'global', conversationKey: '111' },
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid to_jid');
      expect(result.content[0].text).toContain('not-a-jid');
      expect(mockSock.sendMessage).not.toHaveBeenCalled();
    });

    it('falls back to text when raw_message is unparseable JSON', async () => {
      // rawMessage present but invalid -> JSON.parse throws -> catch arm runs.
      db.raw
        .prepare(`UPDATE messages SET raw_message = ? WHERE message_id = 'msg1'`)
        .run('{ this is not valid json');

      const result = await registry.call(
        'forward_message',
        { message_id: 'msg1', to_jid: '333@s.whatsapp.net' },
        globalSession(),
      );

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text) as { method: string };
      expect(data.method).toBe('text');
      expect(mockSock.sendMessage).toHaveBeenCalledWith('333@s.whatsapp.net', { text: 'First message' });
    });

    it('uses the content_type placeholder when content is null in the text fallback', async () => {
      // Set content NULL so the `row.content ?? '[X] message]'` branch fires.
      db.raw.exec(`UPDATE messages SET content = NULL WHERE message_id = 'msg1'`);

      const result = await registry.call(
        'forward_message',
        { message_id: 'msg1', to_jid: '333@s.whatsapp.net' },
        globalSession(),
      );

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text) as { method: string };
      expect(data.method).toBe('text');
      expect(mockSock.sendMessage).toHaveBeenCalledWith('333@s.whatsapp.net', {
        text: '[text message]',
      });
    });

    it('falls back to text when the raw_message column has been dropped from the schema', async () => {
      // Simulate pre-migration-5 schema: dropping the column makes the SELECT throw.
      db.raw.exec('ALTER TABLE messages DROP COLUMN raw_message');

      const result = await registry.call(
        'forward_message',
        { message_id: 'msg1', to_jid: '333@s.whatsapp.net' },
        globalSession(),
      );

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text) as { method: string };
      expect(data.method).toBe('text');
      expect(mockSock.sendMessage).toHaveBeenCalledWith('333@s.whatsapp.net', { text: 'First message' });
    });
  });

  // --- mute_chat: default-until branch ---

  describe('mute_chat — residual branches', () => {
    it('uses a default 8h mute window when `until` is omitted', async () => {
      // Capture the value passed to chatModify so we can assert it's a sensible
      // future unix-seconds value (8h from now, within a small tolerance window).
      const before = Math.floor(Date.now() / 1000);
      await registry.call(
        'mute_chat',
        { jid: '111@s.whatsapp.net', mute: true },
        globalSession(),
      );
      const after = Math.floor(Date.now() / 1000);

      expect(mockSock.chatModify).toHaveBeenCalledTimes(1);
      const [modifyArg, jidArg] = (mockSock.chatModify as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(jidArg).toBe('111@s.whatsapp.net');
      const muteValue = (modifyArg as { mute: number | null }).mute;
      expect(typeof muteValue).toBe('number');
      // 8 hours = 28800 seconds. Allow for clock drift around the boundary.
      expect(muteValue).toBeGreaterThanOrEqual(before + 8 * 3600 - 2);
      expect(muteValue).toBeLessThanOrEqual(after + 8 * 3600 + 2);
    });
  });
});
