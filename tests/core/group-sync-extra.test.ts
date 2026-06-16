/**
 * Supplemental tests for src/core/group-sync.ts
 *
 * The existing tests/core/group-sync.test.ts covers handleGroupsUpsert fully
 * and hits handleGroupsUpdate for subject and announce.  Uncovered lines are
 * all inside handleGroupsUpdate for the fields not yet exercised:
 *
 *   Line 64-66:  u.desc branch  (description update)
 *   Line 68-70:  u.owner branch (owner update + null coercion)
 *   Line 72-74:  u.restrict branch (restrict_mode)
 *   Line 78-82:  u.participants branch (participant_count, including null case)
 *   Line 44:     cond-expr in upsert — g.participants != null ? length : null
 *                (false branch: participants is null/undefined)
 *
 * Also:
 *   Line 62:  binary-expr  g.participants != null  (false arm — participants absent)
 *             Already partially covered by "inserts without participants" path but
 *             the null-participants cond-expr false branch is not hit in existing tests.
 *
 * Real SQLite :memory: — zero mocks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { handleGroupsUpsert, handleGroupsUpdate } from '../../src/core/group-sync.ts';

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

describe('group-sync supplemental coverage', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
    // Seed a group used by all handleGroupsUpdate tests
    handleGroupsUpsert(db, [
      {
        id: 'g1@g.us',
        subject: 'Original Subject',
        desc: 'Original desc',
        owner: 'owner@s.whatsapp.net',
        restrict: false,
        announce: false,
        participants: [{}, {}],
      },
    ]);
  });

  afterEach(() => {
    db.close();
  });

  // ─── handleGroupsUpsert: participant_count null branch (line 43/62) ──────

  describe('handleGroupsUpsert — null participants (cond-expr false branch)', () => {
    it('stores NULL participant_count when participants is absent', () => {
      handleGroupsUpsert(db, [{ id: 'g2@g.us', subject: 'No Participants' }]);

      const row = db.raw
        .prepare('SELECT participant_count FROM groups WHERE jid = ?')
        .get('g2@g.us') as any;
      expect(row.participant_count).toBe(null);
    });

    it('stores NULL participant_count when participants is explicitly null', () => {
      handleGroupsUpsert(db, [{ id: 'g3@g.us', subject: 'Null Participants', participants: null as any }]);

      const row = db.raw
        .prepare('SELECT participant_count FROM groups WHERE jid = ?')
        .get('g3@g.us') as any;
      expect(row.participant_count).toBe(null);
    });
  });

  // ─── handleGroupsUpdate: description (line 64-66) ────────────────────────

  describe('handleGroupsUpdate — description', () => {
    it('updates description when desc is provided', () => {
      handleGroupsUpdate(db, [{ id: 'g1@g.us', desc: 'New description' }]);

      const row = db.raw
        .prepare('SELECT description FROM groups WHERE jid = ?')
        .get('g1@g.us') as any;
      expect(row.description).toBe('New description');
    });

    it('sets description to null when desc is explicitly undefined-excluded via null coercion', () => {
      // desc = null is a valid value (group deleted its description)
      handleGroupsUpdate(db, [{ id: 'g1@g.us', desc: null as any }]);

      const row = db.raw
        .prepare('SELECT description FROM groups WHERE jid = ?')
        .get('g1@g.us') as any;
      // u.desc !== undefined so the branch is entered; null is pushed
      expect(row.description).toBe(null);
    });
  });

  // ─── handleGroupsUpdate: owner (line 68-70) ──────────────────────────────

  describe('handleGroupsUpdate — owner', () => {
    it('updates owner when provided', () => {
      handleGroupsUpdate(db, [{ id: 'g1@g.us', owner: 'newowner@s.whatsapp.net' }]);

      const row = db.raw
        .prepare('SELECT owner FROM groups WHERE jid = ?')
        .get('g1@g.us') as any;
      expect(row.owner).toBe('newowner@s.whatsapp.net');
    });

    it('sets owner to null when owner is null (line 70 null coercion)', () => {
      handleGroupsUpdate(db, [{ id: 'g1@g.us', owner: null as any }]);

      const row = db.raw
        .prepare('SELECT owner FROM groups WHERE jid = ?')
        .get('g1@g.us') as any;
      expect(row.owner).toBe(null);
    });
  });

  // ─── handleGroupsUpdate: restrict (line 72-74) ───────────────────────────

  describe('handleGroupsUpdate — restrict', () => {
    it('sets restrict_mode = 1 when restrict = true', () => {
      handleGroupsUpdate(db, [{ id: 'g1@g.us', restrict: true }]);

      const row = db.raw
        .prepare('SELECT restrict_mode FROM groups WHERE jid = ?')
        .get('g1@g.us') as any;
      expect(row.restrict_mode).toBe(1);
    });

    it('sets restrict_mode = 0 when restrict = false (line 74 false branch)', () => {
      // First set to true
      handleGroupsUpdate(db, [{ id: 'g1@g.us', restrict: true }]);
      // Then clear it
      handleGroupsUpdate(db, [{ id: 'g1@g.us', restrict: false }]);

      const row = db.raw
        .prepare('SELECT restrict_mode FROM groups WHERE jid = ?')
        .get('g1@g.us') as any;
      expect(row.restrict_mode).toBe(0);
    });
  });

  // ─── handleGroupsUpdate: participants (line 80-82) ───────────────────────

  describe('handleGroupsUpdate — participants', () => {
    it('updates participant_count to the new array length (line 80)', () => {
      handleGroupsUpdate(db, [{ id: 'g1@g.us', participants: [{}, {}, {}, {}] }]);

      const row = db.raw
        .prepare('SELECT participant_count FROM groups WHERE jid = ?')
        .get('g1@g.us') as any;
      expect(row.participant_count).toBe(4);
    });

    it('sets participant_count to null when participants is null (line 82 null branch)', () => {
      handleGroupsUpdate(db, [{ id: 'g1@g.us', participants: null as any }]);

      const row = db.raw
        .prepare('SELECT participant_count FROM groups WHERE jid = ?')
        .get('g1@g.us') as any;
      expect(row.participant_count).toBe(null);
    });
  });

  // ─── handleGroupsUpdate: only updated_at (setClauses.length === 1) ───────

  describe('handleGroupsUpdate — no-field update touches row via updated_at', () => {
    it('does not throw and does not change other fields when no recognized fields provided', () => {
      handleGroupsUpdate(db, [{ id: 'g1@g.us' }]);

      const row = db.raw
        .prepare('SELECT subject FROM groups WHERE jid = ?')
        .get('g1@g.us') as any;
      expect(row.subject).toBe('Original Subject');
    });
  });
});
