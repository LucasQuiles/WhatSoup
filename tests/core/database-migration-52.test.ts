import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigration52 } from '../../src/core/database-migration-52.ts';
import { CURRENT_SCHEMA_MIGRATION, Database } from '../../src/core/database.ts';

describe('migration 52 outbound ambiguity episodes', () => {
  let raw: DatabaseSync;

  beforeEach(() => {
    raw = new DatabaseSync(':memory:');
    raw.exec(`
      CREATE TABLE outbound_ops (
        id INTEGER PRIMARY KEY,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        submitted_at TEXT
      );
    `);
  });

  afterEach(() => raw.close());

  it('backfills only legacy maybe_sent rows from submitted_at then created_at', () => {
    raw.exec(`
      INSERT INTO outbound_ops (id, status, created_at, submitted_at) VALUES
        (1, 'maybe_sent', '2026-07-01 00:00:00', '2026-07-01 00:01:00'),
        (2, 'maybe_sent', '2026-07-02 00:00:00', NULL),
        (3, 'pending', '2026-07-03 00:00:00', NULL);
    `);

    runMigration52(raw);

    expect(raw.prepare('SELECT id, ambiguity_at FROM outbound_ops ORDER BY id').all()).toEqual([
      { id: 1, ambiguity_at: '2026-07-01 00:01:00' },
      { id: 2, ambiguity_at: '2026-07-02 00:00:00' },
      { id: 3, ambiguity_at: null },
    ]);
  });

  it('is idempotent, preserves an existing episode, and can be rolled back by its caller transaction', () => {
    raw.exec('BEGIN');
    runMigration52(raw);
    raw.exec('ROLLBACK');

    const afterRollback = raw.prepare("PRAGMA table_info('outbound_ops')").all() as Array<{ name: string }>;
    expect(afterRollback.map(({ name }) => name)).not.toContain('ambiguity_at');

    raw.exec(`
      INSERT INTO outbound_ops (id, status, created_at, submitted_at)
      VALUES (4, 'maybe_sent', '2026-07-04 00:00:00', NULL);
    `);
    runMigration52(raw);
    raw.prepare("UPDATE outbound_ops SET ambiguity_at = '2026-07-04 00:02:00' WHERE id = 4").run();
    runMigration52(raw);
    const afterRepeat = raw.prepare("PRAGMA table_info('outbound_ops')").all() as Array<{ name: string }>;
    expect(afterRepeat.filter(({ name }) => name === 'ambiguity_at')).toHaveLength(1);
    expect(raw.prepare('SELECT ambiguity_at FROM outbound_ops WHERE id = 4').get())
      .toEqual({ ambiguity_at: '2026-07-04 00:02:00' });
  });

  it('remains registered when a later schema migration is current', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      expect(CURRENT_SCHEMA_MIGRATION).toBe(55);
      expect(db.raw.prepare(
        'SELECT version FROM schema_migrations WHERE version = 52',
      ).get()).toEqual({ version: 52 });
    } finally {
      db.close();
    }
  });
});
