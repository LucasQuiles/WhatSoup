import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { queryAll, queryOne } from '../../src/lib/db-query.ts';

interface TestRow {
  id: number;
  name: string | null;
}

describe('db-query', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    db.exec("INSERT INTO t (id, name) VALUES (1, 'a'), (2, 'b'), (3, NULL)");
  });

  afterEach(() => {
    db.close();
  });

  describe('queryAll', () => {
    it('returns all rows typed to the row interface', () => {
      const rows = queryAll<TestRow>(db, 'SELECT id, name FROM t ORDER BY id');
      expect(rows).toEqual([
        { id: 1, name: 'a' },
        { id: 2, name: 'b' },
        { id: 3, name: null },
      ]);
    });

    it('preserves SQLite column runtime types (row-type contract)', () => {
      const rows = queryAll<TestRow>(db, 'SELECT id, name FROM t ORDER BY id');
      expect(typeof rows[0].id).toBe('number');
      expect(typeof rows[0].name).toBe('string');
      expect(rows[2]).toEqual({ id: 3, name: null });
    });

    it('binds anonymous positional parameters in order', () => {
      const rows = queryAll<TestRow>(
        db,
        'SELECT id, name FROM t WHERE id > ? AND id < ? ORDER BY id',
        1,
        3,
      );
      expect(rows).toEqual([{ id: 2, name: 'b' }]);
    });

    it('returns an empty array when no rows match', () => {
      const rows = queryAll<TestRow>(db, 'SELECT id, name FROM t WHERE id = ?', 99);
      expect(rows).toEqual([]);
    });

    it('matches raw prepare().all() output for the same query (behavior parity)', () => {
      const sql = 'SELECT id, name FROM t WHERE id >= ? ORDER BY id';
      const raw = db.prepare(sql).all(2);
      const wrapped = queryAll<TestRow>(db, sql, 2);
      expect(wrapped).toEqual(raw);
    });

    it('propagates SQL errors from prepare', () => {
      expect(() => queryAll<TestRow>(db, 'SELECT nope FROM missing_table')).toThrow();
    });
  });

  describe('queryOne', () => {
    it('returns the first matching row typed to the row interface', () => {
      const row = queryOne<TestRow>(db, 'SELECT id, name FROM t WHERE id = ?', 2);
      expect(row).toEqual({ id: 2, name: 'b' });
      expect(typeof row?.id).toBe('number');
    });

    it('returns undefined when no row matches', () => {
      const sql = 'SELECT id, name FROM t WHERE id = ?';
      const missing = queryOne<TestRow>(db, sql, 99);
      expect(missing).toBeUndefined();
      const present = queryOne<TestRow>(db, sql, 1);
      expect(present).toEqual({ id: 1, name: 'a' });
    });

    it('returns only the first row of a multi-row result', () => {
      const row = queryOne<TestRow>(db, 'SELECT id, name FROM t ORDER BY id DESC');
      expect(row).toEqual({ id: 3, name: null });
    });

    it('supports aggregate rows (COUNT shape)', () => {
      const row = queryOne<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM t');
      expect(row?.c).toBe(3);
    });

    it('propagates SQL errors from prepare', () => {
      expect(() => queryOne<TestRow>(db, 'SELECT nope FROM missing_table')).toThrow();
    });
  });
});
