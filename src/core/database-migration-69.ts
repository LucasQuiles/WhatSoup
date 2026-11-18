import type { DatabaseSync } from 'node:sqlite';

/**
 * Failed-terminal reply-debt index.
 *
 * The debt selector in `open-recoveries-sql.ts` runs on every supervisor health
 * read and, keyed per aged record, inside the terminal-records retention DELETE.
 * No other index covers `inbound_seq` or the terminal failure columns, so each
 * read scanned terminal history. This partial index holds only the rows that can
 * carry the debt. Its WHERE clause repeats the selector's terminal predicates
 * term for term: SQLite uses a partial index only when the query's WHERE implies
 * the index's, so the two must change together. Index only; no table, row or
 * trigger changes. IF NOT EXISTS makes a re-run on a database that already has
 * the index a no-op.
 */
const INDEX = 'idx_turn_terminal_failed_reply_debt';
const DEFINITION = `ON turn_terminal_records(inbound_seq)
    WHERE inbound_disposition = 'failed_terminal'
      AND reply_guarantee_disarmed = 0
      AND delivery_kind <> 'echoed'
      AND COALESCE(attempt_failure_class, '') <> 'operator_cancelled'`;
const collapse = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
// sqlite_master keeps the statement from the index name on, without IF NOT EXISTS.
const STORED_SQL = collapse(`CREATE INDEX ${INDEX} ${DEFINITION}`);

export function runMigration69(db: DatabaseSync): void {
  // A damaged file can lack the table while its ledger is current. Skip it, as
  // the migrations for other absent tables do: the registry-backed table repair
  // after the migrations recreates the table together with this index.
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'turn_terminal_records'")
    .get() as { name: string } | undefined;
  if (!table) return;
  db.exec('SAVEPOINT failed_terminal_debt_index');
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS ${INDEX} ${DEFINITION}`);
    db.exec('RELEASE failed_terminal_debt_index');
  } catch (error) {
    db.exec('ROLLBACK TO failed_terminal_debt_index');
    db.exec('RELEASE failed_terminal_debt_index');
    throw error;
  }
}

/**
 * Startup check, run in the schema transaction after the table repair. The
 * ledger is keyed by number alone, and IF NOT EXISTS keeps a same-name index of
 * any definition, so neither a recorded migration nor the name proves this
 * index. A missing index, or one whose stored definition differs, is rebuilt; an
 * index holds only data derived from its table, so the rebuild loses nothing. A
 * failure throws, so the transaction never commits the receipt without the index.
 * Returns what it found when it rebuilt, or null when the index was exact.
 */
export function ensureFailedTerminalDebtIndex(db: DatabaseSync): 'missing' | 'different' | null {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(INDEX) as { sql: string | null } | undefined;
  if (row !== undefined && collapse(row.sql ?? '') === STORED_SQL) return null;
  db.exec(`DROP INDEX IF EXISTS ${INDEX}`);
  db.exec(`CREATE INDEX ${INDEX} ${DEFINITION}`);
  return row === undefined ? 'missing' : 'different';
}
