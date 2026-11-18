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
const SCHEMA = `
  CREATE INDEX IF NOT EXISTS idx_turn_terminal_failed_reply_debt
    ON turn_terminal_records(inbound_seq)
    WHERE inbound_disposition = 'failed_terminal'
      AND reply_guarantee_disarmed = 0
      AND delivery_kind <> 'echoed'
      AND COALESCE(attempt_failure_class, '') <> 'operator_cancelled';
`;

export function runMigration69(db: DatabaseSync): void {
  db.exec('SAVEPOINT failed_terminal_debt_index');
  try {
    db.exec(SCHEMA);
    db.exec('RELEASE failed_terminal_debt_index');
  } catch (error) {
    db.exec('ROLLBACK TO failed_terminal_debt_index');
    db.exec('RELEASE failed_terminal_debt_index');
    throw error;
  }
}
