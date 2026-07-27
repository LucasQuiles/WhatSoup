import type { DatabaseSync } from 'node:sqlite';

/**
 * NUMBERING NOTE: this file deliberately claims migration number 45 while
 * open PR #1974 (a stale, unmerged WIP omnibus) also drafts its own
 * `database-migration-45.ts` there (unrelated DDL: `outbound_op_message_ids`).
 * That add/add filename collision is an INTENTIONAL, loud conflict for
 * #1974's rebase/reconcile to resolve — not a bug in this file and not this
 * branch's problem to route around.
 *
 * Why 45 and not some other, collision-free number: this repo's migration
 * numbering must be gap-free (`tests/core/migration-safety.test.ts`'s
 * contiguity guard enforces strict N, N+1, N+2, ... with no skips), and 45
 * is the next number after the last one landed on `main` at the time this
 * migration was authored. Picking any other number to dodge #1974 would
 * either violate that contiguity guard outright, or — if inserted earlier in
 * the sequence — silently satisfy the guard today at the cost of *hiding*
 * the real #1974 collision until that PR rebases and lands, which is worse:
 * the conflict would surface then as a confusing runtime/data mismatch
 * instead of an obvious file-level merge conflict now. Decided and
 * documented here per coordinator review during the durability-invariant-1789
 * work (2026-07); resolution is #1974's rebase, not a change to this file.
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
