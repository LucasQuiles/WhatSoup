import type { DatabaseSync } from 'node:sqlite';

/**
 * Persist bounded quarantine metadata separately from the versioned outbound
 * failure-evidence payload. Historical rows remain conservative and are never
 * reclassified from legacy error prose.
 */
export function runMigration53(db: DatabaseSync): void {
  const columns = db
    .prepare("PRAGMA table_info('outbound_ops')")
    .all() as Array<{ name: string }>;
  if (columns.length === 0) return;

  if (!columns.some(({ name }) => name === 'quarantine_disposition')) {
    db.exec(
      "ALTER TABLE outbound_ops ADD COLUMN quarantine_disposition TEXT NOT NULL DEFAULT 'legacy_unclassified'",
    );
  }
  if (!columns.some(({ name }) => name === 'quarantine_evidence_coverage')) {
    db.exec(
      "ALTER TABLE outbound_ops ADD COLUMN quarantine_evidence_coverage TEXT NOT NULL DEFAULT 'legacy_unclassified'",
    );
  }
  if (!columns.some(({ name }) => name === 'quarantine_evidence_sha256')) {
    db.exec('ALTER TABLE outbound_ops ADD COLUMN quarantine_evidence_sha256 TEXT');
  }
  if (!columns.some(({ name }) => name === 'quarantined_at')) {
    db.exec('ALTER TABLE outbound_ops ADD COLUMN quarantined_at TEXT');
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_outbound_ops_quarantine_disposition
      ON outbound_ops(status, quarantine_disposition)
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS outbound_quarantine_retirements (
      outbound_op_id INTEGER PRIMARY KEY,
      quarantine_disposition TEXT NOT NULL CHECK (
        quarantine_disposition IN (
          'delivery_ambiguous_unsafe',
          'delivery_not_attempted',
          'record_unreconstructable',
          'stale_status_discarded'
        )
      ),
      acknowledgement TEXT NOT NULL CHECK (
        acknowledgement IN (
          'delivery-risk-reviewed',
          'record-reconstruction-reviewed',
          'none'
        )
      ) CHECK (
        (quarantine_disposition = 'delivery_ambiguous_unsafe'
          AND acknowledgement = 'delivery-risk-reviewed')
        OR (quarantine_disposition = 'record_unreconstructable'
          AND acknowledgement = 'record-reconstruction-reviewed')
        OR (quarantine_disposition IN ('delivery_not_attempted', 'stale_status_discarded')
          AND acknowledgement = 'none')
      ),
      evidence_sha256 TEXT NOT NULL CHECK (
        length(evidence_sha256) = 64
        AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      retired_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (outbound_op_id) REFERENCES outbound_ops(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_outbound_quarantine_retirements_retired_at
      ON outbound_quarantine_retirements(retired_at);
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS outbound_ops_quarantine_evidence_sha256_valid
    BEFORE INSERT ON outbound_ops
    FOR EACH ROW
    WHEN NEW.quarantine_evidence_sha256 IS NOT NULL
      AND (
        length(NEW.quarantine_evidence_sha256) != 64
        OR NEW.quarantine_evidence_sha256 GLOB '*[^0-9a-f]*'
      )
    BEGIN
      SELECT RAISE(ABORT, 'invalid outbound quarantine evidence digest');
    END;

    CREATE TRIGGER IF NOT EXISTS outbound_ops_quarantine_evidence_sha256_valid_update
    BEFORE UPDATE OF quarantine_evidence_sha256 ON outbound_ops
    FOR EACH ROW
    WHEN NEW.quarantine_evidence_sha256 IS NOT NULL
      AND (
        length(NEW.quarantine_evidence_sha256) != 64
        OR NEW.quarantine_evidence_sha256 GLOB '*[^0-9a-f]*'
      )
    BEGIN
      SELECT RAISE(ABORT, 'invalid outbound quarantine evidence digest');
    END;

    CREATE TRIGGER IF NOT EXISTS outbound_ops_quarantine_evidence_sha256_immutable
    BEFORE UPDATE OF quarantine_evidence_sha256 ON outbound_ops
    FOR EACH ROW
    WHEN OLD.quarantine_evidence_sha256 IS NOT NULL
      AND NEW.quarantine_evidence_sha256 IS NOT OLD.quarantine_evidence_sha256
    BEGIN
      SELECT RAISE(ABORT, 'outbound quarantine evidence digest is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS outbound_quarantine_retirement_evidence_matches
    BEFORE INSERT ON outbound_quarantine_retirements
    FOR EACH ROW
    WHEN NOT EXISTS (
      SELECT 1
        FROM outbound_ops
       WHERE id = NEW.outbound_op_id
         AND quarantine_evidence_sha256 = NEW.evidence_sha256
    )
    BEGIN
      SELECT RAISE(ABORT, 'retirement receipt evidence does not match quarantine evidence');
    END;
  `);
}
