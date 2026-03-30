import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../src/core/database.ts';
import {
  handleReaction,
  handleReceipt,
  handleChatsUpsert,
  handleChatsUpdate,
  handleChatsDelete,
} from '../../src/core/chat-sync.ts';

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

describe('chat-sync', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
  });

  // --- Reactions ---

  describe('handleReaction', () => {
    it('inserts a new reaction', () => {
      handleReaction(db, {
        messageId: 'msg1',
        conversationKey: 'conv1',
        senderJid: 'sender1@s.whatsapp.net',
        reaction: '👍',
      });

      const row = db.raw
        .prepare('SELECT * FROM reactions WHERE message_id = ?')
        .get('msg1') as any;
      expect(row.reaction).toBe('👍');
      expect(row.sender_jid).toBe('sender1@s.whatsapp.net');
    });

    it('replaces reaction from same sender on same message', () => {
      handleReaction(db, {
        messageId: 'msg1',
        conversationKey: 'conv1',
        senderJid: 'sender1@s.whatsapp.net',
        reaction: '👍',
      });
      handleReaction(db, {
        messageId: 'msg1',
        conversationKey: 'conv1',
        senderJid: 'sender1@s.whatsapp.net',
        reaction: '❤️',
      });

      const rows = db.raw
        .prepare('SELECT * FROM reactions WHERE message_id = ?')
        .all('msg1') as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].reaction).toBe('❤️');
    });

    it('removes reaction when empty string', () => {
      handleReaction(db, {
        messageId: 'msg1',
        conversationKey: 'conv1',
        senderJid: 'sender1@s.whatsapp.net',
        reaction: '👍',
      });
      handleReaction(db, {
        messageId: 'msg1',
        conversationKey: 'conv1',
        senderJid: 'sender1@s.whatsapp.net',
        reaction: '',
      });

      const rows = db.raw
        .prepare('SELECT * FROM reactions WHERE message_id = ?')
        .all('msg1') as any[];
      expect(rows).toHaveLength(0);
    });

    it('allows different senders to react to same message', () => {
      handleReaction(db, {
        messageId: 'msg1',
        conversationKey: 'conv1',
        senderJid: 'sender1@s.whatsapp.net',
        reaction: '👍',
      });
      handleReaction(db, {
        messageId: 'msg1',
        conversationKey: 'conv1',
        senderJid: 'sender2@s.whatsapp.net',
        reaction: '❤️',
      });

      const rows = db.raw
        .prepare('SELECT * FROM reactions WHERE message_id = ?')
        .all('msg1') as any[];
      expect(rows).toHaveLength(2);
    });
  });

  // --- Receipts ---

  describe('handleReceipt', () => {
    it('inserts a delivery receipt', () => {
      handleReceipt(db, {
        messageId: 'msg1',
        recipientJid: 'recv1@s.whatsapp.net',
        type: 'delivery',
      });

      const row = db.raw
        .prepare('SELECT * FROM receipts WHERE message_id = ?')
        .get('msg1') as any;
      expect(row.type).toBe('delivery');
    });

    it('upserts receipt — same message+recipient+type is idempotent', () => {
      handleReceipt(db, {
        messageId: 'msg1',
        recipientJid: 'recv1@s.whatsapp.net',
        type: 'delivery',
      });
      handleReceipt(db, {
        messageId: 'msg1',
        recipientJid: 'recv1@s.whatsapp.net',
        type: 'delivery',
      });

      const rows = db.raw
        .prepare('SELECT * FROM receipts WHERE message_id = ?')
        .all('msg1') as any[];
      expect(rows).toHaveLength(1);
    });

    it('allows different receipt types for same message+recipient', () => {
      handleReceipt(db, {
        messageId: 'msg1',
        recipientJid: 'recv1@s.whatsapp.net',
        type: 'delivery',
      });
      handleReceipt(db, {
        messageId: 'msg1',
        recipientJid: 'recv1@s.whatsapp.net',
        type: 'read',
      });

      const rows = db.raw
        .prepare('SELECT * FROM receipts WHERE message_id = ?')
        .all('msg1') as any[];
      expect(rows).toHaveLength(2);
    });
  });

  // --- Chats ---

  describe('handleChatsUpsert', () => {
    it('inserts a new chat', () => {
      handleChatsUpsert(db, [
        { id: '111@s.whatsapp.net', conversationTimestamp: 1000, name: 'Alice' },
      ]);

      const row = db.raw
        .prepare('SELECT * FROM chats WHERE jid = ?')
        .get('111@s.whatsapp.net') as any;
      expect(row.name).toBe('Alice');
      expect(row.conversation_key).toBeTruthy();
    });

    it('replaces existing chat on conflict', () => {
      handleChatsUpsert(db, [
        { id: '111@s.whatsapp.net', conversationTimestamp: 1000, name: 'Alice' },
      ]);
      handleChatsUpsert(db, [
        { id: '111@s.whatsapp.net', conversationTimestamp: 2000, name: 'Alice Updated' },
      ]);

      const rows = db.raw
        .prepare('SELECT * FROM chats WHERE jid = ?')
        .all('111@s.whatsapp.net') as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('Alice Updated');
    });
  });

  describe('handleChatsUpdate', () => {
    it('updates name for existing chat', () => {
      handleChatsUpsert(db, [
        { id: '111@s.whatsapp.net', conversationTimestamp: 1000, name: 'Alice' },
      ]);
      handleChatsUpdate(db, [
        { id: '111@s.whatsapp.net', name: 'Alice New Name' },
      ]);

      const row = db.raw
        .prepare('SELECT * FROM chats WHERE jid = ?')
        .get('111@s.whatsapp.net') as any;
      expect(row.name).toBe('Alice New Name');
    });

    it('updates unread_count', () => {
      handleChatsUpsert(db, [
        { id: '111@s.whatsapp.net', conversationTimestamp: 1000, name: 'Alice' },
      ]);
      handleChatsUpdate(db, [
        { id: '111@s.whatsapp.net', unreadCount: 5 },
      ]);

      const row = db.raw
        .prepare('SELECT * FROM chats WHERE jid = ?')
        .get('111@s.whatsapp.net') as any;
      expect(row.unread_count).toBe(5);
    });

    it('ignores update for non-existent chat', () => {
      // Should not throw
      handleChatsUpdate(db, [
        { id: 'nonexistent@s.whatsapp.net', name: 'Ghost' },
      ]);
      const row = db.raw
        .prepare('SELECT * FROM chats WHERE jid = ?')
        .get('nonexistent@s.whatsapp.net') as any;
      expect(row).toBeUndefined();
    });
  });

  describe('handleChatsDelete', () => {
    it('deletes an existing chat', () => {
      handleChatsUpsert(db, [
        { id: '111@s.whatsapp.net', conversationTimestamp: 1000, name: 'Alice' },
      ]);
      handleChatsDelete(db, ['111@s.whatsapp.net']);

      const row = db.raw
        .prepare('SELECT * FROM chats WHERE jid = ?')
        .get('111@s.whatsapp.net') as any;
      expect(row).toBeUndefined();
    });

    it('ignores delete for non-existent chat', () => {
      // Should not throw
      handleChatsDelete(db, ['nonexistent@s.whatsapp.net']);
    });
  });
});
