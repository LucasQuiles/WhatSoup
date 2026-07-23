import type { DatabaseSync } from 'node:sqlite';

/**
 * NUMBERING NOTE: this file deliberately claims migration number 45 while
 * open PR #1974 (a stale, unmerged WIP omnibus) also drafts its own
 * `database-migration-45.ts` there (unrelated DDL: `outbound_op_message_ids`).
 * That add/add filename collision is an INTENTIONAL, loud conflict for
 * #1974's rebase/reconcile to resolve — not a bug in this file and not this
 * branch's problem to route around. Renumbering to something else here would
 * silently satisfy `tests/core/migration-safety.test.ts`'s contiguity guard
 * today at the cost of hiding the real collision until #1974 lands, which is
 * worse. See the durability-invariant-1789 task-1 report for the full
 * reasoning.
 *
 * recovery_runs today has no status column: whether a run failed is only
 * inferable from `completed_at IS NULL` plus free-text `notes` JSON. This
 * migration adds a first-class `status` column with terminal values
 * 'completed' | 'failed', defaulting new/untouched rows to 'started'.
 *
 * Backfill: rows with completed_at IS NOT NULL become 'completed'. Rows
 * with completed_at IS NULL are left at the 'started' default — historical
 * incompletes are ambiguous (crash mid-run vs. genuinely still in flight)
 * and must NOT be retro-labeled as 'failed'.
 */
export function runMigration45(db: DatabaseSync): void {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'recovery_runs'")
    .get() as { name: string } | undefined;
  if (!table) return;

  const cols = db.prepare("PRAGMA table_info('recovery_runs')").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'status')) {
    db.exec("ALTER TABLE recovery_runs ADD COLUMN status TEXT NOT NULL DEFAULT 'started'");
  }

  db.exec(`
    UPDATE recovery_runs
    SET status = 'completed'
    WHERE completed_at IS NOT NULL
  `);
}
