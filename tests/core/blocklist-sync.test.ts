import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { handleBlocklistSet, handleBlocklistUpdate } from '../../src/core/blocklist-sync.ts';

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function countBlocklist(db: Database): number {
  return (db.raw.prepare('SELECT COUNT(*) AS cnt FROM blocklist').get() as { cnt: number }).cnt;
}

function getBlockedJids(db: Database): string[] {
  return (db.raw.prepare('SELECT jid FROM blocklist ORDER BY jid').all() as Array<{ jid: string }>).map(
    (r) => r.jid,
  );
}

describe('blocklist-sync', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
  });

  // ─── Schema ────────────────────────────────────────────────────────────────

  describe('Migration 6 — blocklist table', () => {
    it('creates blocklist table with correct columns', () => {
      const cols = db.raw
        .prepare('PRAGMA table_info(blocklist)')
        .all() as Array<{ name: string }>;
      const names = cols.map((c) => c.name);
      expect(names).toContain('jid');
      expect(names).toContain('blocked_at');
    });

    it('creates lid_mappings table with correct columns', () => {
      const cols = db.raw
        .prepare('PRAGMA table_info(lid_mappings)')
        .all() as Array<{ name: string }>;
      const names = cols.map((c) => c.name);
      expect(names).toContain('lid');
      expect(names).toContain('phone_jid');
      expect(names).toContain('updated_at');
    });
  });

  // ─── handleBlocklistSet ────────────────────────────────────────────────────

  describe('handleBlocklistSet', () => {
    it('inserts all JIDs from the full list', () => {
      handleBlocklistSet(db, ['a@s.whatsapp.net', 'b@s.whatsapp.net']);
      expect(countBlocklist(db)).toBe(2);
    });

    it('replaces existing blocklist on second call', () => {
      handleBlocklistSet(db, ['a@s.whatsapp.net', 'b@s.whatsapp.net']);
      handleBlocklistSet(db, ['c@s.whatsapp.net']);
      expect(countBlocklist(db)).toBe(1);
      expect(getBlockedJids(db)).toEqual(['c@s.whatsapp.net']);
    });

    it('handles empty array — clears blocklist', () => {
      handleBlocklistSet(db, ['a@s.whatsapp.net']);
      handleBlocklistSet(db, []);
      expect(countBlocklist(db)).toBe(0);
    });

    it('is idempotent for duplicate JIDs — inserts only once per JID', () => {
      handleBlocklistSet(db, ['a@s.whatsapp.net', 'a@s.whatsapp.net']);
      expect(countBlocklist(db)).toBe(1);
    });

    it('ignores non-array input without throwing', () => {
      expect(() => handleBlocklistSet(db, null as unknown as string[])).not.toThrow();
      expect(countBlocklist(db)).toBe(0);
    });
  });

  // ─── handleBlocklistUpdate ─────────────────────────────────────────────────

  describe('handleBlocklistUpdate', () => {
    beforeEach(() => {
      handleBlocklistSet(db, ['existing@s.whatsapp.net']);
    });

    it('adds new JIDs on type=add', () => {
      handleBlocklistUpdate(db, { blocklist: ['new@s.whatsapp.net'], type: 'add' });
      expect(countBlocklist(db)).toBe(2);
      expect(getBlockedJids(db)).toContain('new@s.whatsapp.net');
    });

    it('does not duplicate on type=add when JID already blocked', () => {
      handleBlocklistUpdate(db, {
        blocklist: ['existing@s.whatsapp.net'],
        type: 'add',
      });
      expect(countBlocklist(db)).toBe(1);
    });

    it('removes JIDs on type=remove', () => {
      handleBlocklistUpdate(db, { blocklist: ['existing@s.whatsapp.net'], type: 'remove' });
      expect(countBlocklist(db)).toBe(0);
    });

    it('remove of non-existent JID does not throw', () => {
      expect(() =>
        handleBlocklistUpdate(db, { blocklist: ['ghost@s.whatsapp.net'], type: 'remove' }),
      ).not.toThrow();
      expect(countBlocklist(db)).toBe(1);
    });

    it('unknown type is a no-op — no changes, no throw', () => {
      expect(() =>
        handleBlocklistUpdate(db, { blocklist: ['existing@s.whatsapp.net'], type: 'unknown' }),
      ).not.toThrow();
      expect(countBlocklist(db)).toBe(1);
    });

    it('handles null/undefined blocklist gracefully', () => {
      expect(() =>
        handleBlocklistUpdate(db, { blocklist: null as unknown as string[], type: 'add' }),
      ).not.toThrow();
    });
  });
});
