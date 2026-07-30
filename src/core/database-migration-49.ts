import type { DatabaseSync } from 'node:sqlite';

const EPOCH_MS_CHECK = (column: string): string =>
  `(typeof(${column}) = 'integer' AND ${column} BETWEEN 1 AND 9007199254740991)`;

const COUNTER_CHECK = (column: string): string =>
  `(typeof(${column}) = 'integer' AND ${column} >= 0)`;

/**
 * Durable, content-free execution receipts for memory consolidation.
 *
 * The table intentionally stores only lifecycle state and aggregate counters.
 * Memory text, claims, source identifiers, hashes, model output, and raw
 * exception text are excluded from the schema.
 */
export function runMigration49(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_consolidation_runs (
      run_id TEXT NOT NULL PRIMARY KEY
        CHECK (
          length(run_id) = 32
          AND run_id NOT GLOB '*[^0-9a-f]*'
        ),
      schema_version INTEGER NOT NULL DEFAULT 1
        CHECK (schema_version = 1),
      source TEXT NOT NULL
        CHECK (source IN ('scheduler_immediate', 'scheduler_periodic', 'manual')),
      mode TEXT NOT NULL
        CHECK (mode IN ('dry_run', 'live')),
      status TEXT NOT NULL
        CHECK (
          status IN (
            'running', 'cancelling', 'no_work', 'completed', 'partial',
            'failed', 'cancelled', 'abandoned'
          )
        ),
      stage TEXT NOT NULL
        CHECK (
          stage IN (
            'scheduled', 'search', 'cluster', 'generate', 'validate',
            'write', 'finalize'
          )
        ),
      failure_code TEXT NOT NULL DEFAULT 'none'
        CHECK (
          failure_code IN (
            'none', 'breaker_open', 'project_guard_failed', 'auth_failed',
            'rate_limited', 'timeout', 'network_error', 'invalid_request',
            'provider_unavailable', 'unknown', 'output_invalid',
            'scope_invalid', 'write_failed', 'cancelled', 'already_running',
            'restart_abandoned', 'observation_failed'
          )
        ),
      retryable INTEGER NOT NULL DEFAULT 0
        CHECK (retryable IN (0, 1)),
      evidence_coverage TEXT NOT NULL DEFAULT 'not_observed'
        CHECK (
          evidence_coverage IN (
            'not_observed', 'local_guard', 'provider_response',
            'provider_error', 'fallback_scores'
          )
        ),
      attempted_at INTEGER NOT NULL CHECK ${EPOCH_MS_CHECK('attempted_at')},
      last_progress_at INTEGER NOT NULL CHECK ${EPOCH_MS_CHECK('last_progress_at')},
      last_skipped_at INTEGER
        CHECK (last_skipped_at IS NULL OR ${EPOCH_MS_CHECK('last_skipped_at')}),
      lease_expires_at INTEGER
        CHECK (lease_expires_at IS NULL OR ${EPOCH_MS_CHECK('lease_expires_at')}),
      completed_at INTEGER
        CHECK (completed_at IS NULL OR ${EPOCH_MS_CHECK('completed_at')}),
      success_at INTEGER
        CHECK (success_at IS NULL OR ${EPOCH_MS_CHECK('success_at')}),
      records_observed INTEGER NOT NULL DEFAULT 0
        CHECK ${COUNTER_CHECK('records_observed')},
      clusters_attempted INTEGER NOT NULL DEFAULT 0
        CHECK ${COUNTER_CHECK('clusters_attempted')},
      clusters_completed INTEGER NOT NULL DEFAULT 0
        CHECK ${COUNTER_CHECK('clusters_completed')},
      would_promote INTEGER NOT NULL DEFAULT 0
        CHECK ${COUNTER_CHECK('would_promote')},
      write_attempted INTEGER NOT NULL DEFAULT 0
        CHECK ${COUNTER_CHECK('write_attempted')},
      write_confirmed INTEGER NOT NULL DEFAULT 0
        CHECK ${COUNTER_CHECK('write_confirmed')},
      discarded INTEGER NOT NULL DEFAULT 0
        CHECK ${COUNTER_CHECK('discarded')},
      failed INTEGER NOT NULL DEFAULT 0
        CHECK ${COUNTER_CHECK('failed')},
      skipped INTEGER NOT NULL DEFAULT 0
        CHECK ${COUNTER_CHECK('skipped')},
      overlap_skipped INTEGER NOT NULL DEFAULT 0
        CHECK ${COUNTER_CHECK('overlap_skipped')},
      CHECK (
        (
          status IN ('running', 'cancelling')
          AND completed_at IS NULL
          AND success_at IS NULL
        )
        OR (
          status IN (
            'no_work', 'completed', 'partial', 'failed', 'cancelled', 'abandoned'
          )
          AND completed_at IS NOT NULL
        )
      ),
      CHECK (
        (
          status IN ('no_work', 'completed')
          AND success_at IS NOT NULL
        )
        OR (
          status NOT IN ('no_work', 'completed')
          AND success_at IS NULL
        )
      )
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_consolidation_runs_status_attempt
      ON memory_consolidation_runs(status, attempted_at)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_consolidation_runs_completed
      ON memory_consolidation_runs(completed_at)
      WHERE completed_at IS NOT NULL
  `);
}
