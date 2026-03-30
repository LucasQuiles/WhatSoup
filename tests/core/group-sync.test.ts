import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { handleGroupsUpsert, handleGroupsUpdate } from '../../src/core/group-sync.ts';

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

describe('group-sync', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
  });

  // --- handleGroupsUpsert ---

  describe('handleGroupsUpsert', () => {
    it('inserts a new group', () => {
      handleGroupsUpsert(db, [
        {
          id: '123456789@g.us',
          subject: 'Test Group',
          desc: 'A test group',
          owner: '111@s.whatsapp.net',
          creation: 1700000000,
          participants: [{}, {}, {}],
          restrict: false,
          announce: true,
        },
      ]);

      const row = db.raw
        .prepare('SELECT * FROM groups WHERE jid = ?')
        .get('123456789@g.us') as any;

      expect(row).toBeDefined();
      expect(row.subject).toBe('Test Group');
      expect(row.description).toBe('A test group');
      expect(row.owner).toBe('111@s.whatsapp.net');
      expect(row.creation_time).toBe(1700000000);
      expect(row.participant_count).toBe(3);
      expect(row.restrict_mode).toBe(0);
      expect(row.announce_mode).toBe(1);
    });

    it('upserts without overwriting subject with null when subject is absent', () => {
      handleGroupsUpsert(db, [
        { id: 'g1@g.us', subject: 'Original', participants: [{}] },
      ]);
      // Re-deliver with no subject
      handleGroupsUpsert(db, [
        { id: 'g1@g.us', participants: [{}, {}] },
      ]);

      const row = db.raw
        .prepare('SELECT subject, participant_count FROM groups WHERE jid = ?')
        .get('g1@g.us') as any;

      // Subject should be preserved (COALESCE logic)
      expect(row.subject).toBe('Original');
      // Participant count should be updated
      expect(row.participant_count).toBe(2);
    });

    it('handles an empty array without throwing', () => {
      expect(() => handleGroupsUpsert(db, [])).not.toThrow();
    });

    it('inserts multiple groups in one call', () => {
      handleGroupsUpsert(db, [
        { id: 'g1@g.us', subject: 'Group 1' },
        { id: 'g2@g.us', subject: 'Group 2' },
      ]);

      const rows = db.raw.prepare('SELECT jid FROM groups ORDER BY jid').all() as any[];
      expect(rows).toHaveLength(2);
      expect(rows[0].jid).toBe('g1@g.us');
      expect(rows[1].jid).toBe('g2@g.us');
    });
  });

  // --- handleGroupsUpdate ---

  describe('handleGroupsUpdate', () => {
    beforeEach(() => {
      // Seed a group first
      handleGroupsUpsert(db, [
        {
          id: 'g1@g.us',
          subject: 'Original Subject',
          desc: 'Original description',
          restrict: false,
          announce: false,
        },
      ]);
    });

    it('updates subject when provided', () => {
      handleGroupsUpdate(db, [{ id: 'g1@g.us', subject: 'New Subject' }]);

      const row = db.raw
        .prepare('SELECT subject FROM groups WHERE jid = ?')
        .get('g1@g.us') as any;
      expect(row.subject).toBe('New Subject');
    });

    it('updates announce mode', () => {
      handleGroupsUpdate(db, [{ id: 'g1@g.us', announce: true }]);

      const row = db.raw
        .prepare('SELECT announce_mode FROM groups WHERE jid = ?')
        .get('g1@g.us') as any;
      expect(row.announce_mode).toBe(1);
    });

    it('does not clear description when only subject is updated', () => {
      handleGroupsUpdate(db, [{ id: 'g1@g.us', subject: 'Changed' }]);

      const row = db.raw
        .prepare('SELECT description FROM groups WHERE jid = ?')
        .get('g1@g.us') as any;
      expect(row.description).toBe('Original description');
    });

    it('handles update for non-existent group without throwing', () => {
      // Should produce a no-op (0 rows affected) but not throw
      expect(() =>
        handleGroupsUpdate(db, [{ id: 'nonexistent@g.us', subject: 'X' }]),
      ).not.toThrow();
    });

    it('handles empty update array without throwing', () => {
      expect(() => handleGroupsUpdate(db, [])).not.toThrow();
    });
  });
});
