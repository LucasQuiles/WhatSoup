import type { Database } from '../../core/database.ts';

/** Schema version for the persisted fallback-state row. Bumped when the
 *  persisted shape changes; the restore path rejects version-incompatible
 *  rows with an explicit reconciliation state instead of silently re-routing. */
export const PERSISTED_FALLBACK_STATE_VERSION = 2;

export type FallbackRecoveryState = 'active' | 'terminal' | 'operator-held';
export type FallbackRecoveryTerminalReason =
  | 'attempt-limit'
  | 'elapsed-limit'
  | 'clock-anomaly'
  | 'probe-outcome-unknown'
  | 'operator-killed'
  | 'operator-recovery-failed';
export type FailedKeysEvidenceAvailability = 'available' | 'unavailable';

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
  /** The recovery episode's original start, distinct from the fallback window
   *  start so an explicit retry can begin a new bounded episode without
   *  concealing the original fallback window. */
  recoveryEpisodeStartedAt?: number;
  recoveryState?: FallbackRecoveryState;
  recoveryTerminalReason?: FallbackRecoveryTerminalReason | null;
  /** A process died after claiming a probe and before recording its outcome.
   *  Restore must hold the episode for reconciliation instead of replaying it. */
  recoveryProbeInFlight?: boolean;
  /** `unavailable` means failed_keys_json was malformed or unreadable. The
   *  raw SQLite value stays in place for operator reconciliation. */
  failedKeysEvidenceAvailability?: FailedKeysEvidenceAvailability;
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
  if (!hasColumn('recovery_episode_started_at')) {
    db.raw.exec(`ALTER TABLE agent_fallback_state ADD COLUMN recovery_episode_started_at INTEGER`);
  }
  if (!hasColumn('recovery_state')) {
    db.raw.exec(`ALTER TABLE agent_fallback_state ADD COLUMN recovery_state TEXT NOT NULL DEFAULT 'active'`);
  }
  if (!hasColumn('recovery_terminal_reason')) {
    db.raw.exec(`ALTER TABLE agent_fallback_state ADD COLUMN recovery_terminal_reason TEXT`);
  }
  if (!hasColumn('recovery_probe_in_flight')) {
    db.raw.exec(`ALTER TABLE agent_fallback_state ADD COLUMN recovery_probe_in_flight INTEGER NOT NULL DEFAULT 0`);
  }
}

/** Persist (or replace) the current fallback window. Upserts the singleton row. */
export function saveFallbackState(db: Database, s: PersistedFallbackState): void {
  db.raw
    .prepare(
      `INSERT INTO agent_fallback_state (id, active_until, activated_at, reason, probe_attempts,
              version, active_entry_provider, active_entry_model, failed_keys_json,
              recovery_episode_started_at, recovery_state, recovery_terminal_reason, recovery_probe_in_flight)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         active_until = excluded.active_until,
         activated_at = excluded.activated_at,
         reason = excluded.reason,
         probe_attempts = excluded.probe_attempts,
         version = excluded.version,
         active_entry_provider = excluded.active_entry_provider,
         active_entry_model = excluded.active_entry_model,
         failed_keys_json = excluded.failed_keys_json,
         recovery_episode_started_at = excluded.recovery_episode_started_at,
         recovery_state = excluded.recovery_state,
         recovery_terminal_reason = excluded.recovery_terminal_reason,
         recovery_probe_in_flight = excluded.recovery_probe_in_flight`,
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
      s.recoveryEpisodeStartedAt ?? s.activatedAt,
      s.recoveryState ?? 'active',
      s.recoveryTerminalReason ?? null,
      s.recoveryProbeInFlight ? 1 : 0,
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
              failed_keys_json AS failedKeysJson,
              recovery_episode_started_at AS recoveryEpisodeStartedAt,
              recovery_state AS recoveryState,
              recovery_terminal_reason AS recoveryTerminalReason,
              recovery_probe_in_flight AS recoveryProbeInFlight
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
  const recoveryEpisodeStartedAt =
    typeof row.recoveryEpisodeStartedAt === 'number' && Number.isFinite(row.recoveryEpisodeStartedAt)
      ? row.recoveryEpisodeStartedAt
      : row.activatedAt;
  const recoveryState: FallbackRecoveryState =
    row.recoveryState === 'terminal' || row.recoveryState === 'operator-held'
      ? row.recoveryState
      : 'active';
  const recoveryTerminalReason: FallbackRecoveryTerminalReason | null =
    row.recoveryTerminalReason === 'attempt-limit'
    || row.recoveryTerminalReason === 'elapsed-limit'
    || row.recoveryTerminalReason === 'clock-anomaly'
    || row.recoveryTerminalReason === 'probe-outcome-unknown'
    || row.recoveryTerminalReason === 'operator-killed'
    || row.recoveryTerminalReason === 'operator-recovery-failed'
      ? row.recoveryTerminalReason
      : null;
  const recoveryProbeInFlight = (row.recoveryProbeInFlight as unknown) === 1 || row.recoveryProbeInFlight === true;
  // Never coerce corrupted failed-provider evidence to an empty set. Doing so
  // would permit a known failed route to be selected after restart. The raw
  // database value remains untouched for a separately authorized repair.
  let failedKeys: PersistedFailedKey[] = [];
  let failedKeysEvidenceAvailability: FailedKeysEvidenceAvailability = 'available';
  if (typeof row.failedKeysJson !== 'string' || row.failedKeysJson.length === 0) {
    failedKeysEvidenceAvailability = 'unavailable';
  } else {
    try {
      const parsed: unknown = JSON.parse(row.failedKeysJson);
      if (Array.isArray(parsed)) {
        const valid = parsed.every(
          (e) =>
            typeof e === 'object' && e !== null
            && typeof (e as Record<string, unknown>).provider === 'string'
            && typeof (e as Record<string, unknown>).model === 'string',
        );
        if (valid) failedKeys = parsed as PersistedFailedKey[];
        else failedKeysEvidenceAvailability = 'unavailable';
      } else {
        failedKeysEvidenceAvailability = 'unavailable';
      }
    } catch {
      failedKeysEvidenceAvailability = 'unavailable';
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
    recoveryEpisodeStartedAt,
    recoveryState,
    recoveryTerminalReason,
    recoveryProbeInFlight,
    failedKeysEvidenceAvailability,
  };
}

/** Remove the persisted fallback state. No-op if nothing is stored. */
export function clearFallbackState(db: Database): void {
  db.raw.prepare(`DELETE FROM agent_fallback_state WHERE id = 1`).run();
}
