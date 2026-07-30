import type { DatabaseSync } from 'node:sqlite';
import { OUTBOUND_FAILURE_CODES } from './durability-evidence-contract.ts';

function sqlValues(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

/**
 * Replace destination- and payload-derived outbound audit metadata with an
 * opaque receipt and a closed lifecycle evidence contract. Historical status
 * and prose are deliberately not interpreted.
 */
export function runMigration51(db: DatabaseSync): void {
  const columns = db
    .prepare("PRAGMA table_info('outbound_sends')")
    .all() as Array<{ name: string }>;
  if (columns.length === 0) return;
  if (columns.some(({ name }) => name === 'audit_receipt')) return;

  db.exec(`
    CREATE TABLE outbound_sends_v51 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      audit_receipt TEXT NOT NULL UNIQUE
        CHECK (
          length(audit_receipt) = 32
          AND audit_receipt = lower(audit_receipt)
          AND audit_receipt NOT GLOB '*[^0-9a-f]*'
        ),
      schema_version INTEGER NOT NULL DEFAULT 1
        CHECK (schema_version = 1),
      caller TEXT NOT NULL
        CHECK (caller IN ('mcp', 'health', 'rgp')),
      target_kind TEXT NOT NULL
        CHECK (target_kind IN ('chatJid', 'alias')),
      outcome_code TEXT NOT NULL DEFAULT 'intent'
        CHECK (
          outcome_code IN (
            'intent', 'submitted', 'confirmed', 'failed_not_sent',
            'ambiguous', 'legacy_unclassified'
          )
        ),
      failure_code TEXT
        CHECK (
          failure_code IS NULL
          OR failure_code IN (${sqlValues(OUTBOUND_FAILURE_CODES)})
        ),
      failure_stage TEXT NOT NULL DEFAULT 'not_started'
        CHECK (
          failure_stage IN (
            'not_started', 'provider_call_started', 'ack_received', 'unknown'
          )
        ),
      mutation_state TEXT NOT NULL DEFAULT 'not_started'
        CHECK (
          mutation_state IN (
            'not_started', 'not_mutated', 'maybe_mutated',
            'acknowledged', 'unknown'
          )
        ),
      retryable INTEGER
        CHECK (retryable IS NULL OR retryable IN (0, 1)),
      evidence_coverage TEXT NOT NULL DEFAULT 'typed'
        CHECK (
          evidence_coverage IN ('typed', 'untyped', 'legacy_unclassified')
        ),
      logical_attempt_count INTEGER
        CHECK (
          logical_attempt_count IS NULL
          OR (
            typeof(logical_attempt_count) = 'integer'
            AND logical_attempt_count BETWEEN 0 AND 9007199254740991
          )
        ),
      provider_submission_count INTEGER
        CHECK (
          provider_submission_count IS NULL
          OR (
            typeof(provider_submission_count) = 'integer'
            AND provider_submission_count BETWEEN 0 AND 9007199254740991
          )
        ),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      CHECK (
        (
          outcome_code = 'intent'
          AND failure_code IS NULL
          AND failure_stage = 'not_started'
          AND mutation_state = 'not_started'
          AND retryable IS NULL
          AND evidence_coverage = 'typed'
          AND logical_attempt_count = 1
          AND provider_submission_count = 0
          AND completed_at IS NULL
        )
        OR (
          outcome_code IN ('submitted', 'confirmed')
          AND failure_code IS NULL
          AND failure_stage = 'ack_received'
          AND mutation_state = 'acknowledged'
          AND retryable IS NULL
          AND evidence_coverage = 'typed'
          AND logical_attempt_count = 1
          AND provider_submission_count = 1
          AND completed_at IS NOT NULL
        )
        OR (
          outcome_code = 'failed_not_sent'
          AND failure_code IS NOT NULL
          AND failure_code <> 'legacy_unclassified'
          AND failure_stage IN ('not_started', 'provider_call_started', 'unknown')
          AND mutation_state = 'not_mutated'
          AND retryable IS NOT NULL
          AND evidence_coverage IN ('typed', 'untyped')
          AND logical_attempt_count = 1
          AND provider_submission_count = 0
          AND completed_at IS NOT NULL
        )
        OR (
          outcome_code = 'ambiguous'
          AND failure_code IS NOT NULL
          AND failure_code <> 'legacy_unclassified'
          AND failure_stage IN ('provider_call_started', 'ack_received', 'unknown')
          AND mutation_state IN ('maybe_mutated', 'unknown')
          AND retryable IS NOT NULL
          AND evidence_coverage IN ('typed', 'untyped')
          AND logical_attempt_count = 1
          AND provider_submission_count IN (0, 1)
          AND completed_at IS NOT NULL
        )
        OR (
          outcome_code = 'legacy_unclassified'
          AND failure_code = 'legacy_unclassified'
          AND failure_stage = 'unknown'
          AND mutation_state = 'unknown'
          AND retryable IS NULL
          AND evidence_coverage = 'legacy_unclassified'
          AND logical_attempt_count IS NULL
          AND provider_submission_count IS NULL
          AND completed_at IS NULL
        )
      )
    );

    INSERT INTO outbound_sends_v51 (
      id,
      audit_receipt,
      schema_version,
      caller,
      target_kind,
      outcome_code,
      failure_code,
      failure_stage,
      mutation_state,
      retryable,
      evidence_coverage,
      logical_attempt_count,
      provider_submission_count,
      created_at,
      completed_at
    )
    SELECT
      id,
      lower(hex(randomblob(16))),
      1,
      caller,
      target_kind,
      'legacy_unclassified',
      'legacy_unclassified',
      'unknown',
      'unknown',
      NULL,
      'legacy_unclassified',
      NULL,
      NULL,
      created_at,
      NULL
    FROM outbound_sends;

    DROP TABLE outbound_sends;
    ALTER TABLE outbound_sends_v51 RENAME TO outbound_sends;

    CREATE INDEX idx_outbound_sends_created_at
      ON outbound_sends(created_at);
    CREATE INDEX idx_outbound_sends_outcome_created
      ON outbound_sends(outcome_code, created_at);
  `);
}
