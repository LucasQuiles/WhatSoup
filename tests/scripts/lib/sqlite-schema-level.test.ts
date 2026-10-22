/**
 * readSchemaMigrationLevel: the read-only level release activation compares
 * before and after a failed switch. Unknown must throw, never read as 0.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { trackTmpDirs } from '../../helpers/tmp-dir.ts';
import { readSchemaMigrationLevel } from '../../../scripts/lib/sqlite-schema-level.ts';

const tmp = trackTmpDirs('whatsoup-schema-level-');

function database(statements: string): string {
  const dbPath = path.join(tmp.make('db'), 'bot.db');
  const db = new DatabaseSync(dbPath);
  db.exec(statements);
  db.close();
  return dbPath;
}

describe('readSchemaMigrationLevel', () => {
  it('returns the highest recorded migration', () => {
    const dbPath = database(
      'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT);'
      + 'INSERT INTO schema_migrations (version) VALUES (3), (65), (12);',
    );
    expect(readSchemaMigrationLevel(dbPath)).toBe(65);
  });

  it('returns 0 for an empty ledger and for a database with no ledger yet', () => {
    expect(readSchemaMigrationLevel(database('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);'))).toBe(0);
    expect(readSchemaMigrationLevel(database('CREATE TABLE other (value TEXT);'))).toBe(0);
  });

  it('throws for a missing file, a file that is not a database, and a non-integer level', () => {
    const dir = tmp.make('bad');
    expect(() => readSchemaMigrationLevel(path.join(dir, 'absent.db'))).toThrow();
    const garbage = path.join(dir, 'garbage.db');
    writeFileSync(garbage, 'not a sqlite database');
    expect(() => readSchemaMigrationLevel(garbage)).toThrow(/could not read schema migration level/);
    const textual = database(
      "CREATE TABLE schema_migrations (version TEXT); INSERT INTO schema_migrations VALUES ('x');",
    );
    expect(() => readSchemaMigrationLevel(textual)).toThrow(/not a non-negative integer/);
  });
});
