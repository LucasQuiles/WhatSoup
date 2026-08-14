import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigration57 } from '../../src/core/database-migration-57.ts';

describe('migration 57 trigger occurrences', () => {
  let raw: DatabaseSync;

  beforeEach(() => {
    raw = new DatabaseSync(':memory:');
    raw.exec(`
      CREATE TABLE beads (id INTEGER PRIMARY KEY AUTOINCREMENT);
      CREATE TABLE bead_triggers (id INTEGER PRIMARY KEY AUTOINCREMENT);
    `);
  });

  afterEach(() => raw.close());

  it('creates the occurrence table with lease fields and stable identity', () => {
    runMigration57(raw);
    const cols = (raw.prepare("PRAGMA table_info('trigger_occurrences')").all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      'trigger_id', 'bead_id', 'scheduled_for', 'attempt', 'state',
      'lease_owner', 'lease_generation', 'lease_expires_at',
      'claimed_at', 'started_at', 'finished_at', 'stale_cause',
    ]));

    raw.exec('INSERT INTO beads DEFAULT VALUES; INSERT INTO bead_triggers DEFAULT VALUES;');
    raw.prepare(
      `INSERT INTO trigger_occurrences (trigger_id, bead_id, scheduled_for, state, claimed_at)
       VALUES (1, 1, 1000, 'running', 1000)`,
    ).run();
    expect(() => raw.prepare(
      `INSERT INTO trigger_occurrences (trigger_id, bead_id, scheduled_for, state, claimed_at)
       VALUES (1, 1, 1000, 'running', 1001)`,
    ).run()).toThrow(/UNIQUE/);
    expect(() => raw.prepare(
      `INSERT INTO trigger_occurrences (trigger_id, bead_id, scheduled_for, state, claimed_at)
       VALUES (1, 1, 2000, 'sprinting', 1000)`,
    ).run()).toThrow(/CHECK/);
  });

  it('is idempotent and can be rolled back by its caller transaction', () => {
    raw.exec('BEGIN');
    runMigration57(raw);
    raw.exec('ROLLBACK');
    const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(t => t.name);
    expect(tables).not.toContain('trigger_occurrences');

    runMigration57(raw);
    runMigration57(raw);
    const after = (raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(t => t.name);
    expect(after).toContain('trigger_occurrences');
  });
});
