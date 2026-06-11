import type { Database } from '../../core/database.ts';

export interface PersistedFallbackState {
  activeUntil: number; // epoch ms
  activatedAt: number; // epoch ms
  reason: string;
}

/** Ensure the singleton fallback-state table exists. Idempotent. */
export function ensureFallbackStateSchema(db: Database): void {
  db.raw.exec(`
    CREATE TABLE IF NOT EXISTS agent_fallback_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      active_until INTEGER NOT NULL,
      activated_at INTEGER NOT NULL,
      reason TEXT NOT NULL DEFAULT 'usage-limit'
    )
  `);
}

/** Persist (or replace) the current fallback window. Upserts the singleton row. */
export function saveFallbackState(db: Database, s: PersistedFallbackState): void {
  db.raw
    .prepare(
      `INSERT INTO agent_fallback_state (id, active_until, activated_at, reason)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         active_until = excluded.active_until,
         activated_at = excluded.activated_at,
         reason = excluded.reason`,
    )
    .run(s.activeUntil, s.activatedAt, s.reason);
}

/**
 * Load the persisted fallback state, or null if none exists.
 *
 * Validates that all fields are the expected types before returning — SQLite
 * affinity means a corrupted row can contain wrong-typed values that would
 * otherwise silently propagate as garbage. On any validation failure, null is
 * returned so the caller can treat it as "no persisted state".
 */
export function loadFallbackState(db: Database): PersistedFallbackState | null {
  const row = db.raw
    .prepare(
      `SELECT active_until AS activeUntil, activated_at AS activatedAt, reason
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
  return { activeUntil: row.activeUntil, activatedAt: row.activatedAt, reason: row.reason };
}

/** Remove the persisted fallback state. No-op if nothing is stored. */
export function clearFallbackState(db: Database): void {
  db.raw.prepare(`DELETE FROM agent_fallback_state WHERE id = 1`).run();
}
