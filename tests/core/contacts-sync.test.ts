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
      handleContactsUpsert(db, [{ id: '1234@s.whatsapp.net', name: 'Alice', notify: 'Ali' }]);
      handleContactsUpdate(db, [{ id: 'unknown@s.whatsapp.net', notify: 'X' }]);
      const rows = db.raw.prepare('SELECT jid, display_name, notify_name FROM contacts ORDER BY jid').all();
      expect(rows).toEqual([
        { jid: '1234@s.whatsapp.net', display_name: 'Alice', notify_name: 'Ali' },
      ]);
    });
  });

  // Closes the residual branch-coverage gaps in src/core/contacts-sync.ts:
  //   - handleContactsUpsert catch fallback when toConversationKey throws
  //   - handleContactsUpdate if (u.name !== undefined) TRUE branch
  //   - if (u.notify !== undefined) FALSE branch
  //   - if (u.name !== undefined) FALSE branch
  describe('residual-branch coverage', () => {
    it('falls back to regex-stripped phone when toConversationKey throws on a JID without "@"', () => {
      // 'noatsymbol' has no "@" → toConversationKey throws → catch branch uses c.id.replace(/@.*$/, '')
      handleContactsUpsert(db, [{ id: 'noatsymbol', name: 'NoAt', notify: 'NoAtNotify' }]);
      const row = db.raw.prepare(
        'SELECT canonical_phone, display_name, notify_name FROM contacts WHERE jid = ?'
      ).get('noatsymbol') as
        | { canonical_phone: string | null; display_name: string | null; notify_name: string | null }
        | undefined;
      expect(row?.canonical_phone).toBe('noatsymbol');
      expect(row?.display_name).toBe('NoAt');
      expect(row?.notify_name).toBe('NoAtNotify');
    });

    it('updates only display_name when the update object carries only name (no notify)', () => {
      handleContactsUpsert(db, [{ id: '1234@s.whatsapp.net', name: 'Alice', notify: 'Ali' }]);
      handleContactsUpdate(db, [{ id: '1234@s.whatsapp.net', name: 'Alice Renamed' }]);
      const row = db.raw.prepare(
        'SELECT display_name, notify_name FROM contacts WHERE jid = ?'
      ).get('1234@s.whatsapp.net') as
        | { display_name: string | null; notify_name: string | null }
        | undefined;
      expect(row?.display_name).toBe('Alice Renamed');
      expect(row?.notify_name).toBe('Ali');
    });

    it('updates only notify_name when the update object carries only notify (no name)', () => {
      handleContactsUpsert(db, [{ id: '1234@s.whatsapp.net', name: 'Alice', notify: 'Ali' }]);
      handleContactsUpdate(db, [{ id: '1234@s.whatsapp.net', notify: 'Ali2' }]);
      const row = db.raw.prepare(
        'SELECT display_name, notify_name FROM contacts WHERE jid = ?'
      ).get('1234@s.whatsapp.net') as
        | { display_name: string | null; notify_name: string | null }
        | undefined;
      expect(row?.display_name).toBe('Alice');
      expect(row?.notify_name).toBe('Ali2');
    });

    it('applies no field changes when the update object carries neither name nor notify', () => {
      handleContactsUpsert(db, [{ id: '1234@s.whatsapp.net', name: 'Alice', notify: 'Ali' }]);
      handleContactsUpdate(db, [{ id: '1234@s.whatsapp.net' }]);
      const row = db.raw.prepare(
        'SELECT display_name, notify_name FROM contacts WHERE jid = ?'
      ).get('1234@s.whatsapp.net') as
        | { display_name: string | null; notify_name: string | null }
        | undefined;
      expect(row?.display_name).toBe('Alice');
      expect(row?.notify_name).toBe('Ali');
    });
  });
});
