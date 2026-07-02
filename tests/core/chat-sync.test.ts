import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Database } from '../../src/core/database.ts';
import {
  handleReaction,
  handleReceipt,
  handleChatsUpsert,
  handleChatsUpdate,
  handleChatsDelete,
} from '../../src/core/chat-sync.ts';
import { upsertLidMapping } from '../../src/core/lid-resolver.ts';

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
      expect(row.conversation_key).toBe('111');
    });

    it('keys a MAPPED LID DM by the resolved phone, matching live ingest (QR-043)', () => {
      const LID = '31478083756155';
      const PHONE = '15551230007';
      upsertLidMapping(db, LID, `${PHONE}@s.whatsapp.net`);

      handleChatsUpsert(db, [{ id: `${LID}@lid`, name: 'Mapped' }]);

      const row = db.raw
        .prepare('SELECT conversation_key FROM chats WHERE jid = ?')
        .get(`${LID}@lid`) as any;
      // Bug was: conversation_key === LID number, splitting it from the
      // phone-keyed live messages. Fix: resolved phone.
      expect(row.conversation_key).toBe(PHONE);
      expect(row.conversation_key).not.toBe(LID);
    });

    it('repairs a stale conversation_key on re-upsert once the LID mapping is learned (QR-043 ON CONFLICT)', () => {
      const LID = '31478083756155';
      const PHONE = '15551230007';

      // First sync BEFORE the mapping exists → keyed under the raw LID number.
      handleChatsUpsert(db, [{ id: `${LID}@lid`, name: 'BeforeMap' }]);
      let row = db.raw.prepare('SELECT conversation_key FROM chats WHERE jid = ?').get(`${LID}@lid`) as any;
      expect(row.conversation_key).toBe(LID);

      // Mapping is learned, then a re-sync arrives. ON CONFLICT must repair the key.
      upsertLidMapping(db, LID, `${PHONE}@s.whatsapp.net`);
      handleChatsUpsert(db, [{ id: `${LID}@lid`, name: 'AfterMap' }]);

      row = db.raw.prepare('SELECT conversation_key, name FROM chats WHERE jid = ?').get(`${LID}@lid`) as any;
      expect(row.conversation_key).toBe(PHONE);
      expect(row.name).toBe('AfterMap');
    });

    it('persists a chat with no name as null (c.name nullish arm)', () => {
      handleChatsUpsert(db, [
        { id: '222@s.whatsapp.net', conversationTimestamp: 3000, unreadCount: 7 }, // no name
      ]);

      const row = db.raw
        .prepare('SELECT name, unread_count FROM chats WHERE jid = ?')
        .get('222@s.whatsapp.net') as any;
      expect(row).toEqual({ name: null, unread_count: 7 });
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
      const rows = db.raw
        .prepare('SELECT * FROM chats WHERE jid = ?')
        .all('nonexistent@s.whatsapp.net') as unknown[];
      expect(rows).toHaveLength(0);
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

      const rows = db.raw
        .prepare('SELECT * FROM chats WHERE jid = ?')
        .all('111@s.whatsapp.net') as unknown[];
      expect(rows).toHaveLength(0);
    });

    it('ignores delete for non-existent chat', () => {
      expect(() => handleChatsDelete(db, ['nonexistent@s.whatsapp.net'])).not.toThrow();
      const rows = db.raw.prepare('SELECT * FROM chats').all() as unknown[];
      expect(rows).toHaveLength(0);
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
        .prepare('SELECT jid, conversation_key, name, unread_count FROM chats WHERE jid = ?')
        .get('111@s.whatsapp.net') as any;
      expect({ ...good }).toStrictEqual({
        jid: '111@s.whatsapp.net',
        conversation_key: '111',
        name: 'Good',
        unread_count: 0,
      });
      // Bad chat must not be stored
      const badRows = db.raw
        .prepare('SELECT * FROM chats WHERE jid = ?')
        .all('invalid-no-at') as unknown[];
      expect(badRows).toHaveLength(0);
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

  // ─── Uncovered-branch coverage ────────────────────────────────────────────

  describe('chat-sync.ts uncovered-branch coverage', () => {
    describe('handleChatsUpsert — optional field branches', () => {
      it('persists archived, pinned, muteEndTime, and ephemeralExpiration when set', () => {
        handleChatsUpsert(db, [
          {
            id: '15550000001@s.whatsapp.net',
            name: 'Flagged',
            unreadCount: 3,
            archived: true,
            pinned: 2,
            muteEndTime: 1700000000,
            ephemeralExpiration: 86400,
          },
        ]);

        const row = db.raw
          .prepare('SELECT * FROM chats WHERE jid = ?')
          .get('15550000001@s.whatsapp.net') as any;
        expect(row.is_archived).toBe(1);
        expect(row.is_pinned).toBe(1);
        expect(row.mute_until).toBe(new Date(1700000000 * 1000).toISOString());
        expect(row.ephemeral_duration).toBe(86400);
        expect(row.unread_count).toBe(3);
      });

      it('writes null mute_until and null ephemeral_duration when absent', () => {
        handleChatsUpsert(db, [{ id: '15550000002@s.whatsapp.net', name: 'Plain' }]);

        const row = db.raw
          .prepare('SELECT mute_until, ephemeral_duration, is_archived, is_pinned FROM chats WHERE jid = ?')
          .get('15550000002@s.whatsapp.net') as any;
        expect(row.mute_until).toBeNull();
        expect(row.ephemeral_duration).toBeNull();
        expect(row.is_archived).toBe(0);
        expect(row.is_pinned).toBe(0);
      });

      it('falls back to default-domain mapping for unknown domain', () => {
        // Domain that is NOT s.whatsapp.net, lid, or g.us exercises the default case.
        handleChatsUpsert(db, [{ id: '15550000003@broadcast', name: 'Mystery' }]);

        const row = db.raw
          .prepare('SELECT conversation_key FROM chats WHERE jid = ?')
          .get('15550000003@broadcast') as any;
        expect(row.conversation_key).toBe('15550000003_at_broadcast');
      });
    });

    describe('handleChatsUpdate — per-field SET branches', () => {
      const baseId = '15550000010@s.whatsapp.net';
      beforeEach(() => {
        handleChatsUpsert(db, [{ id: baseId, name: 'Seed' }]);
      });

      it('flips archived false→0 and pinned false→0', () => {
        handleChatsUpdate(db, [
          { id: baseId, archived: false, pinned: 0 },
        ]);

        const row = db.raw
          .prepare('SELECT is_archived, is_pinned FROM chats WHERE jid = ?')
          .get(baseId) as any;
        expect(row.is_archived).toBe(0);
        expect(row.is_pinned).toBe(0);
      });

      it('sets mute_until from muteEndTime and clears when 0', () => {
        // First: a real timestamp populates mute_until
        handleChatsUpdate(db, [{ id: baseId, muteEndTime: 1700000000 }]);
        let row = db.raw
          .prepare('SELECT mute_until FROM chats WHERE jid = ?')
          .get(baseId) as any;
        expect(row.mute_until).toBe(new Date(1700000000 * 1000).toISOString());

        // Then: muteEndTime === 0 → falsy branch writes null
        handleChatsUpdate(db, [{ id: baseId, muteEndTime: 0 }]);
        row = db.raw
          .prepare('SELECT mute_until FROM chats WHERE jid = ?')
          .get(baseId) as any;
        expect(row).toEqual({ mute_until: null });
      });

      it('sets ephemeral_duration via update', () => {
        handleChatsUpdate(db, [{ id: baseId, ephemeralExpiration: 604800 }]);

        const row = db.raw
          .prepare('SELECT ephemeral_duration FROM chats WHERE jid = ?')
          .get(baseId) as any;
        expect(row.ephemeral_duration).toBe(604800);
      });

      it('applies multiple field updates in a single item', () => {
        handleChatsUpdate(db, [
          {
            id: baseId,
            name: 'Multi',
            unreadCount: 9,
            archived: true,
            pinned: 1,
            muteEndTime: 1234567890,
            ephemeralExpiration: 3600,
          },
        ]);

        const row = db.raw
          .prepare(
            'SELECT name, unread_count, is_archived, is_pinned, mute_until, ephemeral_duration FROM chats WHERE jid = ?',
          )
          .get(baseId) as any;
        expect(row).toMatchObject({
          name: 'Multi',
          unread_count: 9,
          is_archived: 1,
          is_pinned: 1,
          mute_until: new Date(1234567890 * 1000).toISOString(),
          ephemeral_duration: 3600,
        });
      });

      it('returns early for null-like input — no crash, no rows touched', () => {
        expect(() =>
          handleChatsUpdate(db, null as unknown as Array<{ id: string }>),
        ).not.toThrow();
        const row = db.raw
          .prepare('SELECT name FROM chats WHERE jid = ?')
          .get(baseId) as any;
        expect(row.name).toBe('Seed');
      });

      it('catches per-item error from db.raw.prepare and continues', () => {
        // Force db.raw.prepare to throw on the UPDATE path, then restore.
        const spy = vi.spyOn(db.raw, 'prepare').mockImplementation(() => {
          throw new Error('synthetic prepare failure');
        });
        try {
          expect(() =>
            handleChatsUpdate(db, [
              { id: baseId, name: 'Should Be Skipped' },
              { id: '15550000011@s.whatsapp.net', name: 'Also Skipped' },
            ]),
          ).not.toThrow();
        } finally {
          spy.mockRestore();
        }
        // Seed row untouched because the prepared-statement threw before UPDATE ran
        const row = db.raw
          .prepare('SELECT name FROM chats WHERE jid = ?')
          .get(baseId) as any;
        expect(row.name).toBe('Seed');
      });
    });

    describe('handleChatsDelete — error isolation branch', () => {
      it('catches per-item error from stmt.run and continues', () => {
        const baseId = '15550000020@s.whatsapp.net';
        handleChatsUpsert(db, [{ id: baseId, name: 'ToDelete' }]);

        // handleChatsDelete prepares the statement once outside the loop,
        // then calls stmt.run(jid) inside try/catch. Force .run to throw.
        const spy = vi
          .spyOn(db.raw, 'prepare')
          .mockReturnValue({ run: () => { throw new Error('synthetic delete failure'); } } as any);
        try {
          expect(() => handleChatsDelete(db, [baseId, '15550000021@s.whatsapp.net'])).not.toThrow();
        } finally {
          spy.mockRestore();
        }
        // Row still present because DELETE threw at run-time
        const rows = db.raw
          .prepare('SELECT jid FROM chats WHERE jid = ?')
          .all(baseId) as any[];
        expect(rows).toHaveLength(1);
      });

      it('returns early for null-like input — no crash', () => {
        expect(() =>
          handleChatsDelete(db, null as unknown as string[]),
        ).not.toThrow();
        const count = (
          db.raw.prepare('SELECT COUNT(*) AS cnt FROM chats').get() as { cnt: number }
        ).cnt;
        expect(count).toBe(0);
      });
    });
  });
});
