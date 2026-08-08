import type { Database } from '../../core/database.ts';

/** Schema version for the persisted fallback-state row. Bumped when the
 *  persisted shape changes; the restore path rejects version-incompatible
 *  rows with an explicit reconciliation state instead of silently re-routing. */
export const PERSISTED_FALLBACK_STATE_VERSION = 1;

/** A failed-entry key as persisted — provider + model, the same identity
 *  `FallbackChain.entryKey` produces. Persisted as a JSON array of these so
 *  restart reconstitutes `failedKeys` without re-trying a known-failed entry.
 *  Credentials/account identity/paths/message content are NEVER stored here. */
export interface PersistedFailedKey {
  provider: string;
  model: string;
}

export interface PersistedFallbackState {
  activeUntil: number; // epoch ms
  activatedAt: number; // epoch ms
  reason: string;
  /** Consecutive failed recovery probes in the current stall episode. Persisted
   *  so a restart mid-stall resumes the stall clock instead of resetting it. */
  probeAttempts: number;
  /** Persisted-state schema version. The restore path rejects a row whose
   *  version it does not understand (explicit reconciliation, never a silent
   *  re-route). Additive — old rows without the column read back as 0 and are
   *  handled as legacy (version 0). */
  version: number;
  /** Identity of the fallback entry that was active when the window was
   *  persisted, so restart can validate it against the configured chain by
   *  exact provider AND model. `null` for legacy rows (no identity persisted). */
  activeEntryProvider: string | null;
  activeEntryModel: string | null;
  /** Keys of fallback entries that had failed during the window when it was
   *  persisted. Restart reconstitutes `FallbackChain.failedKeys` from this so a
   *  known-failed entry A is not retried while the episode presents as the same
   *  restored window. `[]` for legacy rows. */
  failedKeys: PersistedFailedKey[];
}

/** Ensure the singleton fallback-state table exists. Idempotent — also
 *  migrates pre-probe_attempts AND pre-chain-identity tables in place
 *  (additive columns, old rows read back as legacy defaults). */
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
  // CREATE IF NOT EXISTS is a no-op against a legacy table, so probe each
  // column explicitly and add it when absent (deterministic — no blanket
  // catch that could mask a real DDL failure). Each migration mirrors the
  // probe_attempts precedent: pragma_table_info probe + ALTER TABLE ADD
  // COLUMN DEFAULT.
  const hasColumn = (name: string): unknown =>
    db.raw
      .prepare(`SELECT 1 AS present FROM pragma_table_info('agent_fallback_state') WHERE name = ?`)
      .get(name);

  if (!hasColumn('probe_attempts')) {
    db.raw.exec(`ALTER TABLE agent_fallback_state ADD COLUMN probe_attempts INTEGER NOT NULL DEFAULT 0`);
  }
  // #3019: chain-identity + failed-keys persistence. Additive columns so old
  // rows migrate in place: version defaults to 0 (legacy), the active-entry
  // identity defaults to NULL (unknown), and failed_keys_json defaults to
  // '[]' (no failed keys known). The restore path treats version 0 rows as
  // legacy and re-arms without chain reconstitution (preserving the prior
  // behavior for pre-migration rows).
  if (!hasColumn('version')) {
    db.raw.exec(`ALTER TABLE agent_fallback_state ADD COLUMN version INTEGER NOT NULL DEFAULT 0`);
  }
  if (!hasColumn('active_entry_provider')) {
    db.raw.exec(`ALTER TABLE agent_fallback_state ADD COLUMN active_entry_provider TEXT`);
  }
  if (!hasColumn('active_entry_model')) {
    db.raw.exec(`ALTER TABLE agent_fallback_state ADD COLUMN active_entry_model TEXT`);
  }
  if (!hasColumn('failed_keys_json')) {
    db.raw.exec(`ALTER TABLE agent_fallback_state ADD COLUMN failed_keys_json TEXT NOT NULL DEFAULT '[]'`);
  }
}

/** Persist (or replace) the current fallback window. Upserts the singleton row. */
export function saveFallbackState(db: Database, s: PersistedFallbackState): void {
  db.raw
    .prepare(
      `INSERT INTO agent_fallback_state (id, active_until, activated_at, reason, probe_attempts,
              version, active_entry_provider, active_entry_model, failed_keys_json)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         active_until = excluded.active_until,
         activated_at = excluded.activated_at,
         reason = excluded.reason,
         probe_attempts = excluded.probe_attempts,
         version = excluded.version,
         active_entry_provider = excluded.active_entry_provider,
         active_entry_model = excluded.active_entry_model,
         failed_keys_json = excluded.failed_keys_json`,
    )
    .run(
      s.activeUntil,
      s.activatedAt,
      s.reason,
      s.probeAttempts,
      s.version,
      s.activeEntryProvider,
      s.activeEntryModel,
      JSON.stringify(s.failedKeys),
    );
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
              probe_attempts AS probeAttempts, version,
              active_entry_provider AS activeEntryProvider,
              active_entry_model AS activeEntryModel,
              failed_keys_json AS failedKeysJson
       FROM agent_fallback_state WHERE id = 1`,
    )
    .get() as Partial<PersistedFallbackState> & { failedKeysJson?: unknown } | undefined;
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
  // version is additive: a corrupt/missing value reads as 0 (legacy), which
  // the restore path handles as a pre-chain-identity row.
  const version =
    typeof row.version === 'number' && Number.isFinite(row.version) && row.version >= 0
      ? row.version
      : 0;
  const activeEntryProvider =
    typeof row.activeEntryProvider === 'string' ? row.activeEntryProvider : null;
  const activeEntryModel =
    typeof row.activeEntryModel === 'string' ? row.activeEntryModel : null;
  // failed_keys_json is additive: a corrupt/missing value reads as [] (no
  // failed keys known), which is the safe legacy default.
  let failedKeys: PersistedFailedKey[] = [];
  if (typeof row.failedKeysJson === 'string' && row.failedKeysJson.length > 0) {
    try {
      const parsed: unknown = JSON.parse(row.failedKeysJson);
      if (Array.isArray(parsed)) {
        failedKeys = parsed.filter(
          (e): e is PersistedFailedKey =>
            typeof e === 'object' && e !== null &&
            typeof (e as Record<string, unknown>).provider === 'string' &&
            typeof (e as Record<string, unknown>).model === 'string',
        );
      }
    } catch {
      failedKeys = [];
    }
  }
  return {
    activeUntil: row.activeUntil,
    activatedAt: row.activatedAt,
    reason: row.reason,
    probeAttempts,
    version,
    activeEntryProvider,
    activeEntryModel,
    failedKeys,
  };
}

/** Remove the persisted fallback state. No-op if nothing is stored. */
export function clearFallbackState(db: Database): void {
  db.raw.prepare(`DELETE FROM agent_fallback_state WHERE id = 1`).run();
}
