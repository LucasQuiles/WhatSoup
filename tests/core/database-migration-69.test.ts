/**
 * Migration 69: a partial index on `turn_terminal_records(inbound_seq)` that
 * holds only the terminal rows that can carry failed-terminal reply debt. Its
 * WHERE clause repeats the debt selector's terminal predicates term for term,
 * because SQLite uses a partial index only when the query implies that clause.
 * Startup must end with exactly this index whenever the migration is recorded,
 * including a damaged file whose terminal table is gone.
 */
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_MIGRATION, Database } from '../../src/core/database.ts';
import { runMigration69 } from '../../src/core/database-migration-69.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('whatsoup-migration-69-');
const MIGRATION = 69;
const INDEX = 'idx_turn_terminal_failed_reply_debt';
// SQLite stores the statement from the index name on, without IF NOT EXISTS;
// whitespace is collapsed before comparing.
const DEFINITION = `CREATE INDEX ${INDEX} ON turn_terminal_records(inbound_seq)`
  + " WHERE inbound_disposition = 'failed_terminal' AND reply_guarantee_disarmed = 0"
  + " AND delivery_kind <> 'echoed' AND COALESCE(attempt_failure_class, '') <> 'operator_cancelled'";

function indexDefinition(raw: DatabaseSync): string | null {
  const row = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(INDEX) as { sql: string } | undefined;
  return row === undefined ? null : row.sql.replace(/\s+/g, ' ').trim();
}

function ledgerVersions(raw: DatabaseSync): number[] {
  return (raw.prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all() as Array<{ version: number }>).map((row) => Number(row.version));
}

const versionsThrough = (last: number): number[] => Array.from({ length: last }, (_, i) => i + 1);

describe('migration 69 — failed-terminal reply-debt index', () => {
  let db: Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('a fresh database records the migration and the exact partial index', () => {
    db = new Database(':memory:');
    db.open();

    expect(ledgerVersions(db.raw)).toEqual(versionsThrough(CURRENT_SCHEMA_MIGRATION));
    expect(ledgerVersions(db.raw)).toContain(MIGRATION);
    expect(indexDefinition(db.raw)).toBe(DEFINITION);
    expect(db.raw.prepare("SELECT partial FROM pragma_index_list('turn_terminal_records') WHERE name = ?")
      .get(INDEX)).toEqual({ partial: 1 });
    expect(db.raw.prepare('SELECT name FROM pragma_index_info(?)').all(INDEX))
      .toEqual([{ name: 'inbound_seq' }]);
  });

  it('upgrades a file that lacks the migration in place', () => {
    const dbPath = join(tmp.make('upgrade'), 'bot.db');
    const first = new Database(dbPath);
    first.open();
    // Emulate the previous schema: no receipt for this migration and no index.
    first.raw.exec(`DROP INDEX ${INDEX}`);
    first.raw.prepare('DELETE FROM schema_migrations WHERE version = ?').run(MIGRATION);
    expect(ledgerVersions(first.raw)).not.toContain(MIGRATION);
    expect(indexDefinition(first.raw)).toBeNull();
    first.close();

    db = new Database(dbPath);
    db.open();

    expect(ledgerVersions(db.raw)).toEqual(versionsThrough(CURRENT_SCHEMA_MIGRATION));
    expect(indexDefinition(db.raw)).toBe(DEFINITION);
  });

  it('re-running the migration on a database that has the index succeeds', () => {
    db = new Database(':memory:');
    db.open();
    runMigration69(db.raw);
    runMigration69(db.raw);

    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(INDEX)).toEqual({ n: 1 });
    expect(indexDefinition(db.raw)).toBe(DEFINITION);
  });

  it('opens a damaged file whose ledger ends before this migration and whose terminal table is gone', () => {
    const dbPath = join(tmp.make('damaged'), 'bot.db');
    const first = new Database(dbPath);
    first.open();
    // Dropping the table drops its indexes; the startup table repair must still run.
    first.raw.exec('DROP TABLE turn_terminal_records');
    first.raw.prepare('DELETE FROM schema_migrations WHERE version >= ?').run(MIGRATION);
    expect(ledgerVersions(first.raw)).toEqual(versionsThrough(MIGRATION - 1));
    first.close();

    const reopened = new Database(dbPath);
    db = reopened;
    expect(() => reopened.open()).not.toThrow();

    expect(reopened.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get('turn_terminal_records')).toEqual({ name: 'turn_terminal_records' });
    expect(indexDefinition(reopened.raw)).toBe(DEFINITION);
    expect(ledgerVersions(reopened.raw)).toEqual(versionsThrough(CURRENT_SCHEMA_MIGRATION));
  });

  it('rebuilds the index at startup when the migration is recorded but the index is missing', () => {
    const dbPath = join(tmp.make('recorded-missing'), 'bot.db');
    const first = new Database(dbPath);
    first.open();
    first.raw.exec(`DROP INDEX ${INDEX}`);
    expect(ledgerVersions(first.raw)).toContain(MIGRATION);
    expect(indexDefinition(first.raw)).toBeNull();
    first.close();

    db = new Database(dbPath);
    db.open();

    expect(ledgerVersions(db.raw)).toEqual(versionsThrough(CURRENT_SCHEMA_MIGRATION));
    expect(indexDefinition(db.raw)).toBe(DEFINITION);
  });

  it('replaces a same-name index whose stored definition differs', () => {
    const dbPath = join(tmp.make('recorded-different'), 'bot.db');
    const other = `CREATE INDEX ${INDEX} ON turn_terminal_records(inbound_seq) WHERE inbound_disposition = 'failed_terminal'`;
    const first = new Database(dbPath);
    first.open();
    first.raw.exec(`DROP INDEX ${INDEX}`);
    first.raw.exec(other);
    expect(ledgerVersions(first.raw)).toContain(MIGRATION);
    expect(indexDefinition(first.raw)).toBe(other);
    first.close();

    db = new Database(dbPath);
    db.open();

    expect(indexDefinition(db.raw)).toBe(DEFINITION);
  });
});
