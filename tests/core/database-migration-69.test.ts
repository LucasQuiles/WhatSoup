/**
 * Migration 69: a partial index on `turn_terminal_records(inbound_seq)` that
 * holds only the terminal rows that can carry failed-terminal reply debt. Its
 * WHERE clause repeats the debt selector's terminal predicates term for term,
 * because SQLite uses a partial index only when the query implies that clause.
 * Startup must end with exactly this index whenever the migration is recorded,
 * including a damaged file whose terminal table is gone, and must never take the
 * name from an object on another table.
 */
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CURRENT_SCHEMA_MIGRATION, Database, migratedSchemaSnapshot } from '../../src/core/database.ts';
import { ensureFailedTerminalDebtIndex, runMigration69 } from '../../src/core/database-migration-69.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

// Only the database component's logger is captured, so the rebuild line can be
// asserted without other components' calls.
const databaseLog = vi.hoisted(() => ({}) as Record<string, ReturnType<typeof vi.fn>>);
vi.mock('../../src/logger.ts', async () => {
  const { componentLoggerMock, loggerMock } = await import('../helpers/logger-mock.ts');
  const { log, createChildLogger } = componentLoggerMock('database', () => loggerMock().createChildLogger());
  Object.assign(databaseLog, log);
  return { createChildLogger };
});

const tmp = trackTmpDirs('whatsoup-migration-69-');
const MIGRATION = 69;
const INDEX = 'idx_turn_terminal_failed_reply_debt';
const REBUILD_LINE = 'Failed-terminal reply-debt index rebuilt';
// SQLite stores the statement from the index name on, without IF NOT EXISTS;
// whitespace is collapsed before comparing.
const DEFINITION = `CREATE INDEX ${INDEX} ON turn_terminal_records(inbound_seq)`
  + " WHERE inbound_disposition = 'failed_terminal' AND reply_guarantee_disarmed = 0"
  + " AND delivery_kind <> 'echoed' AND COALESCE(attempt_failure_class, '') <> 'operator_cancelled'";

const collapse = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

function indexDefinition(raw: DatabaseSync): string | null {
  const row = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(INDEX) as { sql: string } | undefined;
  return row === undefined ? null : collapse(row.sql);
}

function ledgerVersions(raw: DatabaseSync): number[] {
  return (raw.prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all() as Array<{ version: number }>).map((row) => Number(row.version));
}

const versionsThrough = (last: number): number[] => Array.from({ length: last }, (_, i) => i + 1);

// Index, table and view names share one namespace per database and match without case.
function objectsUnderIndexName(raw: DatabaseSync): unknown[] {
  return raw.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name = ? COLLATE NOCASE AND type <> 'trigger'",
  ).all(INDEX);
}

// SQLite increments the schema cookie on every schema change, a drop or a create included.
const schemaCookie = (raw: DatabaseSync): unknown => raw.prepare('PRAGMA schema_version').get();

function rebuildLines(): unknown[][] {
  return databaseLog.warn!.mock.calls.filter(([, message]) => message === REBUILD_LINE);
}

// Migration 70 (operator catch-up resolutions) adds a column, so a ledger rewound below 70 must
// also lose that migration's objects, or the reopen re-runs its ADD COLUMN. Triggers go first:
// SQLite refuses to drop a column that a trigger still names.
const CATCHUP_MIGRATION = 70;
function dropCatchupMigrationObjects(raw: DatabaseSync): void {
  raw.exec('DROP TRIGGER operator_catchup_resolution_outbound_immutable');
  raw.exec('DROP TRIGGER operator_catchup_resolution_source_immutable');
  raw.exec('DROP TRIGGER operator_catchup_resolution_no_legacy_close');
  raw.exec('DROP TRIGGER operator_catchup_resolution_fulfillment_required');
  raw.exec('DROP TRIGGER operator_catchup_resolution_no_corroboration');
  raw.exec('DROP TABLE operator_catchup_resolutions');
  raw.exec('ALTER TABLE inbound_disposition_links DROP COLUMN original_fulfillment_confirmed');
}

// A file whose index name is held by a UNIQUE index on another table; `keep` is the
// last migration receipt left in its ledger.
function fileWithForeignIndexName(label: string, name: string, keep: number) {
  const dbPath = join(tmp.make(label), 'bot.db');
  const first = new Database(dbPath);
  first.open();
  first.raw.exec(`DROP INDEX ${INDEX}`);
  if (keep < CATCHUP_MIGRATION) dropCatchupMigrationObjects(first.raw);
  first.raw.prepare('DELETE FROM schema_migrations WHERE version > ?').run(keep);
  first.raw.exec('CREATE TABLE other_records (id INTEGER PRIMARY KEY, record_key TEXT NOT NULL)');
  first.raw.exec(`CREATE UNIQUE INDEX ${name} ON other_records(record_key)`);
  const before = { objects: objectsUnderIndexName(first.raw), ledger: ledgerVersions(first.raw) };
  first.close();
  return { dbPath, before };
}

describe('migration 69 — failed-terminal reply-debt index', () => {
  let db: Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    for (const mock of Object.values(databaseLog)) mock.mockReset();
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
    dropCatchupMigrationObjects(first.raw);
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

  it('refuses to open a schema-68 file whose index name is held by another table, and keeps that index', () => {
    const { dbPath, before } = fileWithForeignIndexName('foreign-schema-68', INDEX, MIGRATION - 1);
    expect(before.ledger).toEqual(versionsThrough(MIGRATION - 1));
    const reopened = new Database(dbPath);
    db = reopened;

    expect(() => reopened.open()).toThrow(`Index name ${INDEX} is in use on table other_records (index)`);
    expect({ objects: objectsUnderIndexName(reopened.raw), ledger: ledgerVersions(reopened.raw) })
      .toEqual(before);
  });

  it('refuses to open a recorded file whose index name is held by another table in other case', () => {
    const { dbPath, before } = fileWithForeignIndexName('foreign-upper-case', INDEX.toUpperCase(), MIGRATION);
    expect(before.ledger).toContain(MIGRATION);
    const reopened = new Database(dbPath);
    db = reopened;

    expect(() => reopened.open()).toThrow(`Index name ${INDEX} is in use on table other_records (index)`);
    expect({ objects: objectsUnderIndexName(reopened.raw), ledger: ledgerVersions(reopened.raw) })
      .toEqual(before);
  });

  it('writes the rebuild line only after the startup transaction commits', () => {
    const dbPath = join(tmp.make('rebuild-line'), 'bot.db');
    const first = new Database(dbPath);
    first.open();
    first.raw.exec(`DROP INDEX ${INDEX}`);
    first.close();

    const reopened = new Database(dbPath);
    db = reopened;
    // A start that rolls back must not claim a rebuild.
    const inTransaction: boolean[] = [];
    databaseLog.warn!.mockImplementation((_fields: unknown, message: unknown) => {
      if (message === REBUILD_LINE) inTransaction.push(reopened.raw.isTransaction);
    });
    reopened.open();

    expect(rebuildLines()).toEqual([[{ found: 'missing' }, REBUILD_LINE]]);
    expect(inTransaction).toEqual([false]);
  });

  it('leaves an exact index alone on a healthy reopen', () => {
    const dbPath = join(tmp.make('healthy-reopen'), 'bot.db');
    const first = new Database(dbPath);
    first.open();
    const cookie = schemaCookie(first.raw);
    first.close();

    db = new Database(dbPath);
    db.open();

    expect(schemaCookie(db.raw)).toEqual(cookie);
    expect(rebuildLines()).toEqual([]);
    expect(ensureFailedTerminalDebtIndex(db.raw)).toBeNull();
    expect(indexDefinition(db.raw)).toBe(DEFINITION);
  });

  it('ends the migration registry with the definition the startup check enforces', () => {
    // Every open rebuilds this index to the startup check's definition. A later
    // migration that changes or drops the index must change that check with it,
    // or each start would undo the migration. The registry replay runs without
    // the check, so this case fails until both agree.
    db = new Database(':memory:');
    db.open();
    const enforced = indexDefinition(db.raw);

    const replayed = [...migratedSchemaSnapshot()].flatMap(([table, { indexes }]) => indexes
      .filter((sql) => new RegExp(`\\b${INDEX}\\b`, 'i').test(sql))
      .map((sql) => ({ table, sql: collapse(sql) })));
    expect(replayed).toEqual([{ table: 'turn_terminal_records', sql: enforced }]);
  });
});
