import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import { registerChatOperationTools } from '../../../src/mcp/tools/chat-operations.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';
import type { WhatsAppSocket } from '../../../src/transport/connection.ts';

function globalSession(): SessionContext {
  return { tier: 'global' };
}

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function makeMockSock(): WhatsAppSocket {
  return {
    sendMessage: vi.fn().mockResolvedValue({ key: { id: 'wa_msg_1' } }),
    chatModify: vi.fn().mockResolvedValue(undefined),
    fetchMessageHistory: vi.fn().mockResolvedValue(undefined),
    requestPlaceholderResend: vi.fn().mockResolvedValue(undefined),
  } as unknown as WhatsAppSocket;
}

function seedMessages(db: Database): void {
  db.raw.exec(`
    INSERT INTO messages
      (chat_jid, conversation_key, sender_jid, sender_name, message_id, content, content_type, is_from_me, timestamp)
    VALUES
      ('111@s.whatsapp.net', '111', '111@s.whatsapp.net', 'Alice', 'msg1', 'Hello', 'text', 0, 1000),
      ('111@s.whatsapp.net', '111', 'me@s.whatsapp.net', 'Me', 'msg2', 'Hi back', 'text', 1, 2000)
  `);
}

describe('chat-operations tools', () => {
  let db: Database;
  let registry: ToolRegistry;
  let mockSock: WhatsAppSocket;

  beforeEach(() => {
    db = makeDb();
    mockSock = makeMockSock();
    registry = new ToolRegistry();
    registerChatOperationTools(db, () => mockSock, (tool) => registry.register(tool));
    seedMessages(db);
  });

  // --- W2-01: clear_chat ---

  describe('clear_chat', () => {
    it('calls chatModify with clear payload', async () => {
      const result = await registry.call(
        'clear_chat',
        { jid: '111@s.whatsapp.net', messages: [{ id: 'msg1', fromMe: false, timestamp: 1000 }] },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect(mockSock.chatModify).toHaveBeenCalledWith(
        { clear: { messages: [{ id: 'msg1', fromMe: false, timestamp: 1000 }] } },
        '111@s.whatsapp.net',
      );
    });

    it('is a global-scope tool', () => {
      const tools = registry.listTools(globalSession());
      const tool = tools.find((t) => t.name === 'clear_chat');
      expect(tool).toBeDefined();
    });
  });

  // --- W2-02: delete_chat ---

  describe('delete_chat', () => {
    it('calls chatModify with delete payload', async () => {
      const result = await registry.call(
        'delete_chat',
        { jid: '111@s.whatsapp.net', last_message_key: { id: 'msg2', fromMe: true }, last_message_timestamp: 2000 },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect(mockSock.chatModify).toHaveBeenCalledWith(
        { delete: true, lastMessages: [{ key: { id: 'msg2', fromMe: true }, messageTimestamp: 2000 }] },
        '111@s.whatsapp.net',
      );
    });
  });

  // --- W2-03: delete_message_for_me ---

  describe('delete_message_for_me', () => {
    it('calls chatModify with deleteForMe payload', async () => {
      const result = await registry.call(
        'delete_message_for_me',
        { jid: '111@s.whatsapp.net', message_id: 'msg1', from_me: false, timestamp: 1000 },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect(mockSock.chatModify).toHaveBeenCalledWith(
        {
          deleteForMe: {
            key: { remoteJid: '111@s.whatsapp.net', id: 'msg1', fromMe: false },
            timestamp: 1000,
          },
        },
        '111@s.whatsapp.net',
      );
    });
  });

  // --- W2-04: set_disappearing_messages ---

  describe('set_disappearing_messages', () => {
    it('sends disappearing message toggle on', async () => {
      const result = await registry.call(
        'set_disappearing_messages',
        { jid: '111@s.whatsapp.net', duration: 86400 },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect(mockSock.sendMessage).toHaveBeenCalledWith(
        '111@s.whatsapp.net',
        { disappearingMessagesInChat: 86400 },
      );
    });

    it('sends disappearing message toggle off', async () => {
      const result = await registry.call(
        'set_disappearing_messages',
        { jid: '111@s.whatsapp.net', duration: 0 },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect(mockSock.sendMessage).toHaveBeenCalledWith(
        '111@s.whatsapp.net',
        { disappearingMessagesInChat: false },
      );
    });
  });

  // --- W2-05: send_event_message ---

  describe('send_event_message', () => {
    it('sends an event message', async () => {
      const result = await registry.call(
        'send_event_message',
        {
          chatJid: '111@s.whatsapp.net',
          name: 'Team Meeting',
          description: 'Weekly sync',
          start_time: 1700000000,
          end_time: 1700003600,
        },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect(mockSock.sendMessage).toHaveBeenCalledWith(
        '111@s.whatsapp.net',
        expect.objectContaining({
          event: expect.objectContaining({
            name: 'Team Meeting',
            description: 'Weekly sync',
          }),
        }),
      );
    });
  });

  // --- W2-06: mark_chat_read ---

  describe('mark_chat_read', () => {
    it('calls chatModify with markRead true', async () => {
      const result = await registry.call(
        'mark_chat_read',
        {
          jid: '111@s.whatsapp.net',
          read: true,
          last_message_key: { id: 'msg1', fromMe: false },
          last_message_timestamp: 1000,
        },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect(mockSock.chatModify).toHaveBeenCalledWith(
        { markRead: true, lastMessages: [{ key: { id: 'msg1', fromMe: false }, messageTimestamp: 1000 }] },
        '111@s.whatsapp.net',
      );
    });

    it('supports marking as unread', async () => {
      const result = await registry.call(
        'mark_chat_read',
        {
          jid: '111@s.whatsapp.net',
          read: false,
          last_message_key: { id: 'msg1', fromMe: false },
          last_message_timestamp: 1000,
        },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect(mockSock.chatModify).toHaveBeenCalledWith(
        { markRead: false, lastMessages: [{ key: { id: 'msg1', fromMe: false }, messageTimestamp: 1000 }] },
        '111@s.whatsapp.net',
      );
    });
  });

  // --- W2-07: update_push_name ---

  describe('update_push_name', () => {
    it('calls chatModify with pushNameSetting', async () => {
      const result = await registry.call(
        'update_push_name',
        { name: 'New Name' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect(mockSock.chatModify).toHaveBeenCalledWith(
        { pushNameSetting: 'New Name' },
        '',
      );
    });
  });

  // --- W2-08: fetch_message_history ---

  describe('fetch_message_history', () => {
    it('calls fetchMessageHistory on socket', async () => {
      const result = await registry.call(
        'fetch_message_history',
        { count: 50 },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect(mockSock.fetchMessageHistory).toHaveBeenCalledWith(50, undefined, undefined);
    });
  });

  // --- W2-09: request_placeholder_resend ---

  describe('request_placeholder_resend', () => {
    it('calls requestPlaceholderResend on socket', async () => {
      const result = await registry.call(
        'request_placeholder_resend',
        { message_key: { remoteJid: '111@s.whatsapp.net', id: 'msg1', fromMe: false } },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).requestPlaceholderResend).toHaveBeenCalledWith({
        remoteJid: '111@s.whatsapp.net',
        id: 'msg1',
        fromMe: false,
      });
    });
  });

  // --- W2-10: get_reactions ---

  describe('get_reactions', () => {
    it('returns reactions for a message', async () => {
      db.raw.exec(`
        INSERT INTO reactions (message_id, conversation_key, sender_jid, reaction)
        VALUES ('msg1', '111', 'sender1@s.whatsapp.net', '👍'),
               ('msg1', '111', 'sender2@s.whatsapp.net', '❤️')
      `);

      const result = await registry.call(
        'get_reactions',
        { message_id: 'msg1' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.reactions).toHaveLength(2);
    });

    it('returns empty array for message with no reactions', async () => {
      const result = await registry.call(
        'get_reactions',
        { message_id: 'nonexistent' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.reactions).toHaveLength(0);
      expect(parsed.count).toBe(0);
    });
  });

  // --- W2-11: get_message_receipts ---

  describe('get_message_receipts', () => {
    it('returns receipts for a message', async () => {
      db.raw.exec(`
        INSERT INTO receipts (message_id, recipient_jid, type)
        VALUES ('msg1', 'recv1@s.whatsapp.net', 'delivery'),
               ('msg1', 'recv1@s.whatsapp.net', 'read')
      `);

      const result = await registry.call(
        'get_message_receipts',
        { message_id: 'msg1' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.receipts).toHaveLength(2);
    });

    it('returns empty array for message with no receipts', async () => {
      const result = await registry.call(
        'get_message_receipts',
        { message_id: 'nonexistent' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.receipts).toHaveLength(0);
      expect(parsed.count).toBe(0);
    });
  });

  // --- Not-connected errors ---

  describe('not-connected errors', () => {
    it('clear_chat errors when not connected', async () => {
      const disconnectedRegistry = new ToolRegistry();
      registerChatOperationTools(db, () => null, (tool) => disconnectedRegistry.register(tool));

      const result = await disconnectedRegistry.call(
        'clear_chat',
        { jid: '111@s.whatsapp.net', messages: [{ id: 'msg1', fromMe: false, timestamp: 1000 }] },
        globalSession(),
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not connected');
    });

    it('set_disappearing_messages errors when not connected', async () => {
      const disconnectedRegistry = new ToolRegistry();
      registerChatOperationTools(db, () => null, (tool) => disconnectedRegistry.register(tool));

      const result = await disconnectedRegistry.call(
        'set_disappearing_messages',
        { jid: '111@s.whatsapp.net', duration: 86400 },
        globalSession(),
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not connected');
    });
  });
});
