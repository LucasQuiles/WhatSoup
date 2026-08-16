import type { DatabaseSync } from 'node:sqlite';

/**
 * Migration 61 — terminal 'expired' state for completed-delivery identity
 * admissions (reliability program 4.1, mirrors the #2384 overdue-proposal
 * terminal lifecycle).
 *
 * The migration-54 CHECK admits only 'quarantined' | 'resolved', so a
 * quarantined admission whose peer never sends a resolving fresh inbound (and
 * that no operator touches) pins the instance's /health at `degraded`
 * FOREVER — the frozen-debt permanent floor observed on five fleet bots
 * (2026-08-16: unresolvedCount 11, oldest 4 days, nextAction fresh_inbound,
 * nothing ageing it out). The remedy is not deletion and not a silent age-out:
 * an overdue admission moves to an explicit terminal 'expired' state with a
 * preserved receipt — the row keeps target, reason, created_at,
 * last_transition_at, and gains a mandatory expired_at stamp.
 *
 * SQLite cannot alter a CHECK, so the table is rebuilt (migration-56/60
 * pattern, simplified: this table has no triggers or FK dependents):
 * SAVEPOINT, copy through a _v61 table with the widened CHECK + expired_at
 * column, drop, rename, recreate the two partial indexes verbatim. The
 * partial indexes cover only state='quarantined', so expired rows (like
 * resolved ones) stop participating in the one-open-row-per-target guard —
 * a NEW admission for the same target stays admissible after expiry.
 *
 * Fail-closed properties:
 * - Pre-flight: any state outside the known vocabulary aborts BEFORE mutation.
 * - Atomic: SAVEPOINT-wrapped; a mid-rebuild error rolls back untouched.
 * - Idempotent: detected via the new CHECK text in sqlite_master.
 */
export function runMigration61(db: DatabaseSync): void {
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'completed_delivery_identity_admissions'")
    .get() as { sql: string } | undefined;
  if (!table) return; // table is created by migration 54 on every path; absent = nothing to rebuild
  if (table.sql.includes("'expired'")) return; // already migrated

  const badStates = db.prepare(`
    SELECT DISTINCT state FROM completed_delivery_identity_admissions
    WHERE state NOT IN ('quarantined', 'resolved')
  `).all() as Array<{ state: string }>;
  if (badStates.length > 0) {
    throw new Error(
      `migration 61 pre-flight: unknown admission state(s) ${badStates.map((r) => r.state).join(', ')}`,
    );
  }

  db.exec('SAVEPOINT migration_61');
  try {
    db.exec(`
      CREATE TABLE completed_delivery_identity_admissions_v61 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_kind TEXT NOT NULL
          CHECK (target_kind IN ('checkpoint', 'agent_session')),
        target_id INTEGER NOT NULL
          CHECK (typeof(target_id) = 'integer' AND target_id > 0),
        state TEXT NOT NULL DEFAULT 'quarantined'
          CHECK (state IN ('quarantined', 'resolved', 'expired')),
        reason TEXT NOT NULL
          CHECK (reason IN ('missing', 'invalid', 'scope_mismatch')),
        attempts INTEGER NOT NULL DEFAULT 1
          CHECK (typeof(attempts) = 'integer' AND attempts = 1),
        owner TEXT NOT NULL DEFAULT 'fresh_inbound'
          CHECK (owner IN ('fresh_inbound', 'operator')),
        next_action TEXT NOT NULL DEFAULT 'fresh_inbound'
          CHECK (next_action IN ('fresh_inbound', 'operator')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_transition_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT,
        expired_at TEXT,
        CHECK (
          (state = 'quarantined' AND resolved_at IS NULL AND expired_at IS NULL)
          OR (state = 'resolved' AND resolved_at IS NOT NULL AND expired_at IS NULL)
          OR (state = 'expired' AND expired_at IS NOT NULL AND resolved_at IS NULL)
        )
      );

      INSERT INTO completed_delivery_identity_admissions_v61
        (id, target_kind, target_id, state, reason, attempts, owner,
         next_action, created_at, last_transition_at, resolved_at, expired_at)
      SELECT id, target_kind, target_id, state, reason, attempts, owner,
             next_action, created_at, last_transition_at, resolved_at, NULL
      FROM completed_delivery_identity_admissions;

      DROP TABLE completed_delivery_identity_admissions;
      ALTER TABLE completed_delivery_identity_admissions_v61
        RENAME TO completed_delivery_identity_admissions;

      CREATE INDEX IF NOT EXISTS idx_completed_delivery_identity_admissions_open_transition
        ON completed_delivery_identity_admissions(state, last_transition_at)
        WHERE state = 'quarantined';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_completed_delivery_identity_admissions_one_open_target
        ON completed_delivery_identity_admissions(target_kind, target_id)
        WHERE state = 'quarantined';
    `);
    db.exec('RELEASE migration_61');
  } catch (err) {
    db.exec('ROLLBACK TO migration_61');
    db.exec('RELEASE migration_61');
    throw err;
  }
}
