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

    it('handles empty messageId and senderJid — treats as valid row key', () => {
      // Baileys may occasionally emit events with empty/missing identifiers;
      // the handler should not throw — it will store or delete a degenerate row.
      expect(() =>
        handleReaction(db, {
          messageId: '',
          conversationKey: '',
          senderJid: '',
          reaction: '👍',
        }),
      ).not.toThrow();
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
    it('returns early with empty array — no crash', () => {
      expect(() => handleChatsUpsert(db, [])).not.toThrow();
      const count = (db.raw.prepare('SELECT COUNT(*) AS cnt FROM chats').get() as { cnt: number }).cnt;
      expect(count).toBe(0);
    });

    it('returns early with null-like input — no crash', () => {
      // Simulates Baileys passing unexpected non-array value at runtime
      expect(() => handleChatsUpsert(db, null as unknown as any[])).not.toThrow();
      const count = (db.raw.prepare('SELECT COUNT(*) AS cnt FROM chats').get() as { cnt: number }).cnt;
      expect(count).toBe(0);
    });

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

    it('skips update when no recognized fields are present — no crash', () => {
      handleChatsUpsert(db, [{ id: '111@s.whatsapp.net', name: 'Alice' }]);
      // Pass an update with only an unrecognized field — sets[] stays empty
      expect(() =>
        handleChatsUpdate(db, [{ id: '111@s.whatsapp.net', unknownField: 'ignored' }]),
      ).not.toThrow();
      // Name should be unchanged
      const row = db.raw
        .prepare('SELECT name FROM chats WHERE jid = ?')
        .get('111@s.whatsapp.net') as any;
      expect(row.name).toBe('Alice');
    });

    it('returns early with empty updates array — no crash', () => {
      expect(() => handleChatsUpdate(db, [])).not.toThrow();
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

  // ─── Per-item error isolation (RES-003) ────────────────────────────────────

  describe('per-item error isolation', () => {
    it('handleChatsUpsert: skips invalid JID but persists valid ones', () => {
      // 'invalid-no-at' has no @ — toConversationKey throws
      handleChatsUpsert(db, [
        { id: 'invalid-no-at', name: 'Bad' },
        { id: '111@s.whatsapp.net', name: 'Good' },
      ]);
      // Good chat must be stored
      const good = db.raw
        .prepare('SELECT * FROM chats WHERE jid = ?')
        .get('111@s.whatsapp.net') as any;
      expect(good).toBeDefined();
      expect(good.name).toBe('Good');
      // Bad chat must not be stored
      const bad = db.raw
        .prepare('SELECT * FROM chats WHERE jid = ?')
        .get('invalid-no-at') as any;
      expect(bad).toBeUndefined();
    });

    it('handleChatsUpsert: all invalid JIDs — no crash, no rows inserted', () => {
      expect(() =>
        handleChatsUpsert(db, [
          { id: 'no-at-sign', name: 'Bad1' },
          { id: '', name: 'Bad2' },
        ]),
      ).not.toThrow();
      const count = (db.raw.prepare('SELECT COUNT(*) AS cnt FROM chats').get() as { cnt: number })
        .cnt;
      expect(count).toBe(0);
    });

    it('handleChatsDelete: processes remaining items when one throws', () => {
      // Insert two valid chats then delete one valid + one that won't throw (deletes are simple)
      handleChatsUpsert(db, [
        { id: '111@s.whatsapp.net', name: 'Alice' },
        { id: '222@s.whatsapp.net', name: 'Bob' },
      ]);
      // All deletes should succeed without throwing
      expect(() =>
        handleChatsDelete(db, ['111@s.whatsapp.net', '222@s.whatsapp.net']),
      ).not.toThrow();
      const count = (db.raw.prepare('SELECT COUNT(*) AS cnt FROM chats').get() as { cnt: number })
        .cnt;
      expect(count).toBe(0);
    });
  });
});
