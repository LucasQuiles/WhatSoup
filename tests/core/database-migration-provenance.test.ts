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
    'c77b6cbe35ffc3964f5801075fcb67a0bed5600a534b70ab0f71523d8dba7e7f',
  ],
] as const);

describe('deployed schema migration provenance', () => {
  let db: Database | null = null;

  afterEach(() => {
    db?.close();
    db = null;
  });

  it('retains exact applied migrations 41 and 42 and locks migration 43 before rollout', () => {
    for (const [source, expectedHash] of LOCKED_MIGRATION_HASHES) {
      const actualHash = createHash('sha256').update(readFileSync(source)).digest('hex');
      expect(actualHash).toBe(expectedHash);
    }
  });

  it('opens a fresh database through schema 43 with intact closure proofs', () => {
    db = new Database(':memory:');
    db.open();

    expect(CURRENT_SCHEMA_MIGRATION).toBe(43);
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
});
