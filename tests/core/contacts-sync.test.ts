import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { handleContactsUpsert, handleContactsUpdate } from '../../src/core/contacts-sync.ts';

describe('contacts-sync', () => {
  let db: Database;

  beforeEach(() => { db = new Database(':memory:'); db.open(); });
  afterEach(() => { db.close(); });

  describe('handleContactsUpsert', () => {
    it('inserts new contacts', () => {
      handleContactsUpsert(db, [
        { id: '1234@s.whatsapp.net', name: 'Alice', notify: 'Ali' },
      ]);
      const row = db.raw.prepare('SELECT * FROM contacts WHERE jid = ?').get('1234@s.whatsapp.net') as any;
      expect(row.display_name).toBe('Alice');
      expect(row.notify_name).toBe('Ali');
      expect(row.canonical_phone).toBe('1234');
    });

    it('updates existing contacts on conflict', () => {
      handleContactsUpsert(db, [{ id: '1234@s.whatsapp.net', name: 'Alice' }]);
      handleContactsUpsert(db, [{ id: '1234@s.whatsapp.net', name: 'Alice Updated', notify: 'Ali2' }]);
      const row = db.raw.prepare('SELECT * FROM contacts WHERE jid = ?').get('1234@s.whatsapp.net') as any;
      expect(row.display_name).toBe('Alice Updated');
      expect(row.notify_name).toBe('Ali2');
    });

    it('handles batch upsert', () => {
      handleContactsUpsert(db, [
        { id: '1@s.whatsapp.net', name: 'A' },
        { id: '2@s.whatsapp.net', name: 'B' },
        { id: '3@s.whatsapp.net', name: 'C' },
      ]);
      const count = (db.raw.prepare('SELECT COUNT(*) as c FROM contacts').get() as any).c;
      expect(count).toBe(3);
    });

    it('preserves existing values when new values are null', () => {
      handleContactsUpsert(db, [{ id: '1234@s.whatsapp.net', name: 'Alice', notify: 'Ali' }]);
      handleContactsUpsert(db, [{ id: '1234@s.whatsapp.net' }]); // no name or notify
      const row = db.raw.prepare('SELECT * FROM contacts WHERE jid = ?').get('1234@s.whatsapp.net') as any;
      expect(row.display_name).toBe('Alice');
      expect(row.notify_name).toBe('Ali');
    });
  });

  describe('handleContactsUpdate', () => {
    it('updates notify_name for existing contact', () => {
      handleContactsUpsert(db, [{ id: '1234@s.whatsapp.net', name: 'Alice' }]);
      handleContactsUpdate(db, [{ id: '1234@s.whatsapp.net', notify: 'NewNotify' }]);
      const row = db.raw.prepare('SELECT * FROM contacts WHERE jid = ?').get('1234@s.whatsapp.net') as any;
      expect(row.notify_name).toBe('NewNotify');
    });

    it('ignores updates for unknown contacts', () => {
      handleContactsUpdate(db, [{ id: 'unknown@s.whatsapp.net', notify: 'X' }]);
      const row = db.raw.prepare('SELECT * FROM contacts WHERE jid = ?').get('unknown@s.whatsapp.net');
      expect(row).toBeUndefined();
    });
  });
});
