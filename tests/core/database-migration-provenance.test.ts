import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigration42 } from '../../src/core/database-migration-42.ts';
import { CURRENT_SCHEMA_MIGRATION, Database } from '../../src/core/database.ts';

const LOCKED_MIGRATION_HASHES = new Map([
  [
    new URL('../../src/core/database-migration-41.ts', import.meta.url),
    '9bb4af0c07b81f0d05071f519c56fc0f7db00ba622b5513473925938be9fcff0',
  ],
  [
    new URL('../../src/core/database-migration-42.ts', import.meta.url),
    '1de1258c01e83cb670f42b85a506f140de432e395dd42faeeb10186223afc763',
  ],
  [
    new URL('../../src/core/database-migration-43.ts', import.meta.url),
    '1b34d1785734d9faedf8cc625711674bf8bd81867eaeadfcbe3b55591bd068d3',
  ],
] as const);

describe('deployed schema migration provenance', () => {
  let db: Database | null = null;

  afterEach(() => {
    db?.close();
    db = null;
  });

  it('retains exact applied migrations 41 and 42 and locks migration 43 for rollout', () => {
    for (const [source, expectedHash] of LOCKED_MIGRATION_HASHES) {
      const actualHash = createHash('sha256').update(readFileSync(source)).digest('hex');
      expect(actualHash).toBe(expectedHash);
    }
  });

  it('opens a fresh database through schema 43 with intact closure proofs', () => {
    db = new Database(':memory:');
    db.open();

    expect(CURRENT_SCHEMA_MIGRATION).toBe(44);
    expect(db.raw.prepare(`
      SELECT version FROM schema_migrations WHERE version IN (41, 42, 43) ORDER BY version
    `).all()).toEqual([{ version: 41 }, { version: 42 }, { version: 43 }]);
    expect(db.raw.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'view' AND name = 'operator_catchup_delivery_proofs'
    `).get()).toEqual({ name: 'operator_catchup_delivery_proofs' });
    expect(db.raw.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name = 'inbound_disposition_closure_validate_insert'
    `).get()).toEqual({ name: 'inbound_disposition_closure_validate_insert' });
    expect(db.raw.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'operator_catchup_closure_witnesses'
    `).get()).toEqual({ name: 'operator_catchup_closure_witnesses' });
    expect(db.raw.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name IN (
        'idx_operator_catchup_witness_terminal',
        'idx_operator_catchup_witness_selected_op',
        'idx_operator_catchup_witness_recovery_job'
      ) ORDER BY name
    `).all()).toEqual([
      { name: 'idx_operator_catchup_witness_recovery_job' },
      { name: 'idx_operator_catchup_witness_selected_op' },
      { name: 'idx_operator_catchup_witness_terminal' },
    ]);
    expect(db.raw.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
    expect(db.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('fails closed instead of recording schema 42 on a partial durability database', () => {
    const partial = new DatabaseSync(':memory:');
    try {
      expect(() => runMigration42(partial)).toThrow(
        'migration 42 missing required tables: inbound_events, outbound_ops, '
          + 'turn_terminal_records, turn_recovery_jobs, recovery_plans, '
          + 'inbound_disposition_links, turn_delivery_corroboration',
      );
    } finally {
      partial.close();
    }
  });

  it('does not record migration 41 when its required parent schema is missing', () => {
    db = new Database(':memory:');
    db.raw.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    const recordApplied = db.raw.prepare(
      'INSERT INTO schema_migrations (version) VALUES (?)',
    );
    for (let version = 1; version <= 40; version += 1) recordApplied.run(version);

    expect(() => db?.open()).toThrow('Migration 41 failed');
    expect(db.raw.prepare(
      'SELECT version FROM schema_migrations WHERE version = 41',
    ).get()).toBeUndefined();
    expect(db.raw.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'recovery_plans'
    `).get()).toBeUndefined();
  });

  it('does not record migration 41 when recovery_runs is missing', () => {
    db = new Database(':memory:');
    db.open();
    db.raw.exec(`
      PRAGMA foreign_keys = OFF;
      DELETE FROM schema_migrations WHERE version IN (41, 42, 43);
      DROP TABLE recovery_runs;
      PRAGMA foreign_keys = ON;
    `);

    expect(() => db?.open()).toThrow('Migration 41 failed');
    expect(db.raw.prepare(
      'SELECT version FROM schema_migrations WHERE version = 41',
    ).get()).toBeUndefined();
  });

  it('does not attest migration 41 when a same-name safety trigger is malformed', () => {
    db = new Database(':memory:');
    db.open();
    db.raw.exec(`
      DELETE FROM schema_migrations WHERE version IN (41, 42, 43);
      DROP TRIGGER recovery_plans_append_only_update;
      CREATE TRIGGER recovery_plans_append_only_update
      BEFORE UPDATE ON recovery_plans
      BEGIN
        SELECT 1;
      END;
    `);

    expect(() => db?.open()).toThrow('Migration 41 failed');
    expect(db.raw.prepare(
      'SELECT version FROM schema_migrations WHERE version = 41',
    ).get()).toBeUndefined();
  });

  it('does not attest migration 41 against a same-name malformed parent table', () => {
    db = new Database(':memory:');
    db.open();
    db.raw.exec(`
      PRAGMA foreign_keys = OFF;
      DELETE FROM schema_migrations WHERE version IN (41, 42, 43);
      DROP TABLE inbound_events;
      CREATE TABLE inbound_events (seq INTEGER PRIMARY KEY);
      PRAGMA foreign_keys = ON;
    `);

    expect(() => db?.open()).toThrow('Migration 41 failed');
    expect(db.raw.prepare(
      'SELECT version FROM schema_migrations WHERE version = 41',
    ).get()).toBeUndefined();
  });
});
