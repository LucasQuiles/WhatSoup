import type { DatabaseSync } from 'node:sqlite';

/**
 * Persist when each outbound delivery entered its current ambiguity episode.
 * Legacy ambiguous rows retain a conservative pre-migration age from their
 * submission receipt when available, then their queue creation time.
 */
export function runMigration52(db: DatabaseSync): void {
  const columns = db
    .prepare("PRAGMA table_info('outbound_ops')")
    .all() as Array<{ name: string }>;
  if (columns.length === 0) return;

  if (!columns.some(({ name }) => name === 'ambiguity_at')) {
    db.exec('ALTER TABLE outbound_ops ADD COLUMN ambiguity_at TEXT');
  }

  db.exec(`
    UPDATE outbound_ops
    SET ambiguity_at = COALESCE(submitted_at, created_at)
    WHERE status = 'maybe_sent' AND ambiguity_at IS NULL
  `);
}
