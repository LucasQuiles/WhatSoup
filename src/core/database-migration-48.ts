import type { DatabaseSync } from 'node:sqlite';

/**
 * Migration 48 — recovery_runs failure-context columns (#1786 salvage).
 *
 * Migration 45 (#2139) added a first-class `status` column to `recovery_runs`
 * with terminal values 'completed' | 'failed'. It records THAT a run failed but
 * not WHY: the failing phase and the error text remain buried in the free-text
 * `notes` JSON, which is not queryable and not a stable contract.
 *
 * This migration adds two nullable failure-context columns so a failed recovery
 * run carries a durable, queryable reason:
 *   - error_kind:    the failing phase (e.g. 'reconcile_maybe_sent_outbound')
 *   - error_message: the primary error text
 * Both are NULL for runs that did not fail (started/completed), so no backfill
 * is required — historical rows correctly read NULL failure context.
 *
 * Provenance: this is the surviving delta of PR #2141/#1786 after #2139
 * superseded its `status`-column half. Reconstructed as the smallest valid
 * change on current main (columns added additively on top of #2139's migration
 * 45) rather than by rebasing the collided #2141 branch. See the repo-loop
 * program run ledger (F-002) for the supersession proof.
 */
export function runMigration48(db: DatabaseSync): void {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'recovery_runs'")
    .get() as { name: string } | undefined;
  if (!table) return;

  // SQLite has no ALTER TABLE ... ADD COLUMN IF NOT EXISTS; guard on PRAGMA.
  const cols = db.prepare("PRAGMA table_info('recovery_runs')").all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('error_kind')) {
    db.exec('ALTER TABLE recovery_runs ADD COLUMN error_kind TEXT');
  }
  if (!names.has('error_message')) {
    db.exec('ALTER TABLE recovery_runs ADD COLUMN error_message TEXT');
  }
}
