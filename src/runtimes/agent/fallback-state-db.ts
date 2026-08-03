import type { Database } from '../../core/database.ts';

export interface PersistedFallbackState {
  activeUntil: number; // epoch ms
  activatedAt: number; // epoch ms
  reason: string;
  /** Consecutive failed recovery probes in the current stall episode. Persisted
   *  so a restart mid-stall resumes the stall clock instead of resetting it. */
  probeAttempts: number;
}

/** Ensure the singleton fallback-state table exists. Idempotent — also
 *  migrates pre-probe_attempts tables in place (additive column, old rows
 *  read back as 0). */
export function ensureFallbackStateSchema(db: Database): void {
  db.raw.exec(`
    CREATE TABLE IF NOT EXISTS agent_fallback_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      active_until INTEGER NOT NULL,
      activated_at INTEGER NOT NULL,
      reason TEXT NOT NULL DEFAULT 'usage-limit',
      probe_attempts INTEGER NOT NULL DEFAULT 0
    )
  `);
  // CREATE IF NOT EXISTS is a no-op against a legacy table, so probe the
  // column explicitly and add it when absent (deterministic — no blanket
  // catch that could mask a real DDL failure).
  const hasProbeAttempts = db.raw
    .prepare(`SELECT 1 AS present FROM pragma_table_info('agent_fallback_state') WHERE name = 'probe_attempts'`)
    .get();
  if (!hasProbeAttempts) {
    db.raw.exec(`ALTER TABLE agent_fallback_state ADD COLUMN probe_attempts INTEGER NOT NULL DEFAULT 0`);
  }
}

/** Persist (or replace) the current fallback window. Upserts the singleton row. */
export function saveFallbackState(db: Database, s: PersistedFallbackState): void {
  db.raw
    .prepare(
      `INSERT INTO agent_fallback_state (id, active_until, activated_at, reason, probe_attempts)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         active_until = excluded.active_until,
         activated_at = excluded.activated_at,
         reason = excluded.reason,
         probe_attempts = excluded.probe_attempts`,
    )
    .run(s.activeUntil, s.activatedAt, s.reason, s.probeAttempts);
}

/**
 * Load the persisted fallback state, or null if none exists.
 *
 * Validates that all fields are the expected types before returning — SQLite
 * affinity means a corrupted row can contain wrong-typed values that would
 * otherwise silently propagate as garbage. On any validation failure, null is
 * returned so the caller can treat it as "no persisted state".
 */
export function getFallbackState(db: Database): PersistedFallbackState | null {
  const row = db.raw
    .prepare(
      `SELECT active_until AS activeUntil, activated_at AS activatedAt, reason,
              probe_attempts AS probeAttempts
       FROM agent_fallback_state WHERE id = 1`,
    )
    .get() as Partial<PersistedFallbackState> | undefined;
  if (
    !row ||
    typeof row.activeUntil !== 'number' ||
    typeof row.activatedAt !== 'number' ||
    typeof row.reason !== 'string'
  ) {
    return null;
  }
  // probe_attempts is additive observability: a corrupt value must not
  // invalidate an otherwise valid window, so coerce instead of nulling.
  const probeAttempts =
    typeof row.probeAttempts === 'number' && Number.isFinite(row.probeAttempts) && row.probeAttempts >= 0
      ? row.probeAttempts
      : 0;
  return { activeUntil: row.activeUntil, activatedAt: row.activatedAt, reason: row.reason, probeAttempts };
}

/** Remove the persisted fallback state. No-op if nothing is stored. */
export function clearFallbackState(db: Database): void {
  db.raw.prepare(`DELETE FROM agent_fallback_state WHERE id = 1`).run();
}
