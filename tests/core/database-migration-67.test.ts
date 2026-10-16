import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_MIGRATION, Database } from '../../src/core/database.ts';
import { runMigration67 } from '../../src/core/database-migration-67.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('whatsoup-migration-67-');

function versions(db: Database): number[] {
  return (db.raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>)
    .map(({ version }) => Number(version));
}

describe('migration 67 remote memory lifecycle ledger', () => {
  let db: Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('upgrades a schema-66 database with the composite destination primary key', () => {
    const dbPath = join(tmp.make('upgrade'), 'bot.db');
    const schema66 = new Database(dbPath);
    schema66.open();
    schema66.raw.exec('DROP TRIGGER remote_memory_lifecycle_tombstone_wins; DROP TABLE remote_memory_lifecycle');
    schema66.raw.prepare('DELETE FROM schema_migrations WHERE version = 67').run();
    schema66.close();

    db = new Database(dbPath);
    db.open();
    expect(CURRENT_SCHEMA_MIGRATION).toBe(67);
    expect(versions(db)).toEqual(Array.from({ length: 67 }, (_, index) => index + 1));
    const keys = db.raw.prepare("PRAGMA table_info('remote_memory_lifecycle')").all() as Array<{ name: string; pk: number }>;
    expect(Object.fromEntries(keys.filter(({ pk }) => pk > 0).map(({ name, pk }) => [name, pk]))).toEqual({
      account_id: 1,
      index_name: 2,
      namespace: 3,
      remote_record_id: 4,
    });
  });

  it('is idempotent when run against an already upgraded ledger', () => {
    db = new Database(':memory:');
    db.open();
    runMigration67(db.raw);
    runMigration67(db.raw);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'remote_memory_lifecycle'").get())
      .toEqual({ n: 1 });
  });
});
