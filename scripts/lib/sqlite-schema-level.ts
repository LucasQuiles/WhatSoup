/**
 * Read-only schema migration level of a WhatSoup database, for operator
 * commands that must know whether a release migrated it (release activation).
 *
 * Same query and missing-ledger rule as the capability-obligation operator
 * scripts' inline readers. `assertSchemaCeiling` in
 * `src/core/database-compatibility.ts` is not reused because it throws on a
 * future schema instead of returning the level, and the level is the answer
 * here.
 */
import { DatabaseSync } from 'node:sqlite';

/**
 * `MAX(version)` of `schema_migrations`, or 0 when the ledger table does not
 * exist yet. Any other failure (missing file, not a database, unreadable
 * value) throws: a caller deciding whether an older binary may start must
 * treat "unknown" as "changed".
 */
export function readSchemaMigrationLevel(dbPath: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    let level: unknown;
    try {
      level = (db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: unknown }).v;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/no such table/i.test(message)) return 0;
      throw new Error(`could not read schema migration level: ${message}`);
    }
    if (typeof level !== 'number' || !Number.isSafeInteger(level) || level < 0) {
      throw new Error(`schema migration level is not a non-negative integer: ${String(level)}`);
    }
    return level;
  } finally {
    db.close();
  }
}
