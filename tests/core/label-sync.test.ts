import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { handleLabelsEdit, handleLabelsAssociation } from '../../src/core/label-sync.ts';

describe('label-sync', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => { db.close(); });

  // ─── Migration 4 schema ───────────────────────────────────────────────────

  describe('Migration 4 — labels tables', () => {
    it('creates labels table with correct columns', () => {
      const cols = db.raw.prepare("PRAGMA table_info(labels)").all() as Array<{ name: string }>;
      const names = cols.map((c) => c.name);
      expect(names).toContain('id');
      expect(names).toContain('name');
      expect(names).toContain('color');
      expect(names).toContain('predefined_id');
      expect(names).toContain('updated_at');
    });

    it('creates label_associations table with correct columns', () => {
      const cols = db.raw.prepare("PRAGMA table_info(label_associations)").all() as Array<{ name: string; dflt_value: string | null; notnull: number }>;
      const names = cols.map((c) => c.name);
      expect(names).toContain('id');
      expect(names).toContain('label_id');
      expect(names).toContain('type');
      expect(names).toContain('chat_jid');
      expect(names).toContain('message_id');
      expect(names).toContain('created_at');
    });
  });

  // ─── handleLabelsEdit ─────────────────────────────────────────────────────

  describe('handleLabelsEdit', () => {
    it('inserts a label into the labels table', () => {
      handleLabelsEdit(db, [{ id: 'lbl-1', name: 'Important', color: 1 }]);

      const row = db.raw.prepare("SELECT * FROM labels WHERE id = ?").get('lbl-1') as {
        id: string;
        name: string;
        color: number | null;
        predefined_id: string | null;
      };
      expect(row).toBeDefined();
      expect(row.id).toBe('lbl-1');
      expect(row.name).toBe('Important');
      expect(row.color).toBe(1);
      expect(row.predefined_id).toBeNull();
    });

    it('inserts a label with predefinedId', () => {
      handleLabelsEdit(db, [{ id: 'lbl-2', name: 'Work', predefinedId: 'pre-001' }]);

      const row = db.raw.prepare("SELECT predefined_id FROM labels WHERE id = ?").get('lbl-2') as {
        predefined_id: string | null;
      };
      expect(row.predefined_id).toBe('pre-001');
    });

    it('upserts a label — updates name and color on conflict', () => {
      handleLabelsEdit(db, [{ id: 'lbl-1', name: 'Old Name', color: 2 }]);
      handleLabelsEdit(db, [{ id: 'lbl-1', name: 'New Name', color: 5 }]);

      const rows = db.raw.prepare("SELECT * FROM labels WHERE id = 'lbl-1'").all() as Array<{
        name: string;
        color: number;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('New Name');
      expect(rows[0].color).toBe(5);
    });

    it('inserts multiple labels in one call', () => {
      handleLabelsEdit(db, [
        { id: 'lbl-1', name: 'Alpha' },
        { id: 'lbl-2', name: 'Beta', color: 3 },
        { id: 'lbl-3', name: 'Gamma', color: 7 },
      ]);

      const count = (
        db.raw.prepare("SELECT COUNT(*) AS cnt FROM labels").get() as { cnt: number }
      ).cnt;
      expect(count).toBe(3);
    });

    it('handles empty labels array without error', () => {
      expect(() => handleLabelsEdit(db, [])).not.toThrow();
    });
  });

  // ─── handleLabelsAssociation ──────────────────────────────────────────────

  describe('handleLabelsAssociation', () => {
    beforeEach(() => {
      // Seed a label so label associations can reference it
      handleLabelsEdit(db, [{ id: 'lbl-1', name: 'Work' }]);
    });

    it('inserts a chat association', () => {
      handleLabelsAssociation(db, {
        labelId: 'lbl-1',
        type: 'chat',
        chatJid: '111@s.whatsapp.net',
        operation: 'add',
      });

      const row = db.raw
        .prepare("SELECT * FROM label_associations WHERE label_id = ?")
        .get('lbl-1') as { label_id: string; type: string; chat_jid: string; message_id: string };
      expect(row).toBeDefined();
      expect(row.label_id).toBe('lbl-1');
      expect(row.type).toBe('chat');
      expect(row.chat_jid).toBe('111@s.whatsapp.net');
      expect(row.message_id).toBe('');
    });

    it('inserts a message association', () => {
      handleLabelsAssociation(db, {
        labelId: 'lbl-1',
        type: 'message',
        chatJid: '111@s.whatsapp.net',
        messageId: 'msg-abc',
        operation: 'add',
      });

      const row = db.raw
        .prepare("SELECT message_id FROM label_associations WHERE label_id = ? AND type = 'message'")
        .get('lbl-1') as { message_id: string };
      expect(row.message_id).toBe('msg-abc');
    });

    it('ignores duplicate association on conflict', () => {
      handleLabelsAssociation(db, {
        labelId: 'lbl-1',
        type: 'chat',
        chatJid: '111@s.whatsapp.net',
        operation: 'add',
      });
      handleLabelsAssociation(db, {
        labelId: 'lbl-1',
        type: 'chat',
        chatJid: '111@s.whatsapp.net',
        operation: 'add',
      });

      const count = (
        db.raw
          .prepare("SELECT COUNT(*) AS cnt FROM label_associations WHERE label_id = 'lbl-1'")
          .get() as { cnt: number }
      ).cnt;
      expect(count).toBe(1);
    });

    it('removes a chat association when operation is remove', () => {
      handleLabelsAssociation(db, {
        labelId: 'lbl-1',
        type: 'chat',
        chatJid: '111@s.whatsapp.net',
        operation: 'add',
      });
      handleLabelsAssociation(db, {
        labelId: 'lbl-1',
        type: 'chat',
        chatJid: '111@s.whatsapp.net',
        operation: 'remove',
      });

      const count = (
        db.raw
          .prepare("SELECT COUNT(*) AS cnt FROM label_associations WHERE label_id = 'lbl-1'")
          .get() as { cnt: number }
      ).cnt;
      expect(count).toBe(0);
    });

    it('removes only the matching association (not others)', () => {
      handleLabelsAssociation(db, {
        labelId: 'lbl-1',
        type: 'chat',
        chatJid: '111@s.whatsapp.net',
        operation: 'add',
      });
      handleLabelsAssociation(db, {
        labelId: 'lbl-1',
        type: 'chat',
        chatJid: '222@s.whatsapp.net',
        operation: 'add',
      });
      handleLabelsAssociation(db, {
        labelId: 'lbl-1',
        type: 'chat',
        chatJid: '111@s.whatsapp.net',
        operation: 'remove',
      });

      const rows = db.raw
        .prepare("SELECT chat_jid FROM label_associations WHERE label_id = 'lbl-1'")
        .all() as Array<{ chat_jid: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].chat_jid).toBe('222@s.whatsapp.net');
    });

    it('defaults to add when operation is omitted', () => {
      handleLabelsAssociation(db, {
        labelId: 'lbl-1',
        type: 'chat',
        chatJid: '333@s.whatsapp.net',
      });

      const count = (
        db.raw
          .prepare("SELECT COUNT(*) AS cnt FROM label_associations WHERE chat_jid = '333@s.whatsapp.net'")
          .get() as { cnt: number }
      ).cnt;
      expect(count).toBe(1);
    });

    it('handles remove on non-existent association without error', () => {
      expect(() =>
        handleLabelsAssociation(db, {
          labelId: 'lbl-1',
          type: 'chat',
          chatJid: 'ghost@s.whatsapp.net',
          operation: 'remove',
        }),
      ).not.toThrow();
    });
  });
});
