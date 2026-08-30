import type { DatabaseSync } from 'node:sqlite';

/**
 * Migration 63 — attestation-evidence columns (#3221 Debt 2 graduation,
 * owner-ruled 2026-08-28; slot 63 verified free after the two subsystem
 * renumbers moved this debt 58→59→61→63).
 *
 * The design spec lists probe stdout/stderr/exit refs (no secrets), the
 * bounded canary input, and media-root readability as `capability_attestations`
 * fields, but migration 58 shipped the table without them; rounds 16–17
 * preserved the evidence in a correlated, nonce-keyed receipt file instead
 * (fsynced + read-back-verified BEFORE the row is admitted). This migration
 * graduates that debt: the evidence lands IN the row and the receipt file
 * becomes corroborating rather than the sole preservation.
 *
 * Columns (all nullable — legacy rows carry NULL; their evidence lives only in
 * their round-17 receipt files):
 *   - probe_stdout_ref / probe_stderr_ref: sha256 hex REFS of the canary's
 *     captured streams (references, never raw content — no secret leak);
 *   - probe_exit: the resolver child's exit code observed by the canary;
 *   - canary_input_ref: sha256 hex of the bounded probe source the canary ran;
 *   - media_root_readable: 0/1 — the attest front-door's fail-closed
 *     media-root observation (round-16 blocker 1) recorded on the row.
 *
 * The migration-58 `capability_attestations_immutable` trigger enumerates the
 * immutable columns, so it is REBUILT here (drop + recreate) to cover the five
 * evidence columns — attestation evidence is immutable exactly like the
 * binding fields. One-way revocation and no-delete guards are untouched.
 *
 * NOTE (AS-01): bumping CURRENT_SCHEMA_MIGRATION to 63 changes the
 * `schema_version` INSIDE every D5 attestation binding — existing attestation
 * digests stop admitting on the new binary BY DESIGN (exact-match admission),
 * and the AS-01 old-binary rehearsal must be re-run 44→63 at rollout. That is
 * the architectural cost the issue names as part of this graduation.
 *
 * Fail-closed properties: idempotent via a PRAGMA table_info column-presence
 * guard (SQLite has no ADD COLUMN IF NOT EXISTS); SAVEPOINT-wrapped so a
 * partial DDL error rolls back untouched.
 */
export function runMigration63(db: DatabaseSync): void {
  db.exec('SAVEPOINT migration_63');
  try {
    const cols = db
      .prepare("PRAGMA table_info('capability_attestations')")
      .all() as Array<{ name: string }>;
    const has = (name: string): boolean => cols.some((c) => c.name === name);

    if (!has('probe_stdout_ref')) {
      db.exec(`ALTER TABLE capability_attestations ADD COLUMN probe_stdout_ref TEXT
        CHECK (probe_stdout_ref IS NULL OR length(probe_stdout_ref) = 64)`);
    }
    if (!has('probe_stderr_ref')) {
      db.exec(`ALTER TABLE capability_attestations ADD COLUMN probe_stderr_ref TEXT
        CHECK (probe_stderr_ref IS NULL OR length(probe_stderr_ref) = 64)`);
    }
    if (!has('probe_exit')) {
      db.exec(`ALTER TABLE capability_attestations ADD COLUMN probe_exit INTEGER
        CHECK (probe_exit IS NULL OR typeof(probe_exit) = 'integer')`);
    }
    if (!has('canary_input_ref')) {
      db.exec(`ALTER TABLE capability_attestations ADD COLUMN canary_input_ref TEXT
        CHECK (canary_input_ref IS NULL OR length(canary_input_ref) = 64)`);
    }
    if (!has('media_root_readable')) {
      db.exec(`ALTER TABLE capability_attestations ADD COLUMN media_root_readable INTEGER
        CHECK (media_root_readable IS NULL OR media_root_readable IN (0, 1))`);
    }

    // Rebuild the enumerated immutability trigger to cover the evidence
    // columns (drop + recreate is idempotent; the WHEN-less BEFORE UPDATE OF
    // form matches migration 58 exactly, extended by the five new columns).
    db.exec(`
      DROP TRIGGER IF EXISTS capability_attestations_immutable;

      CREATE TRIGGER capability_attestations_immutable
      BEFORE UPDATE OF
        host_id, runtime_user, release_sha, schema_version, provider_id,
        harness_type, contract_version, capability, skill_name, skill_version,
        skill_digest, resolver_digest, dependency_versions, media_root,
        canary_id, canary_result, probe_version, nonce, attested_at,
        expires_at, created_at,
        probe_stdout_ref, probe_stderr_ref, probe_exit, canary_input_ref,
        media_root_readable
      ON capability_attestations
      BEGIN
        SELECT RAISE(ABORT, 'capability_attestations: attestation fields are immutable');
      END;
    `);

    db.exec('RELEASE migration_63');
  } catch (err) {
    db.exec('ROLLBACK TO migration_63');
    db.exec('RELEASE migration_63');
    throw err;
  }
}
