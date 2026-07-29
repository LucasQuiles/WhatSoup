import type { DatabaseSync } from 'node:sqlite';
import {
  TOOL_DURABILITY_GROUPS,
  TOOL_FAILURE_CODES,
  TOOL_INPUT_MARKER,
  TOOL_RESULT_MARKERS,
} from './durability-evidence-contract.ts';

function sqlValues(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

/**
 * Replace raw tool parameters/results with fixed markers and add a closed,
 * content-free terminal evidence contract. Historical prose is never parsed.
 */
export function runMigration50(db: DatabaseSync): void {
  const columns = db
    .prepare("PRAGMA table_info('tool_calls')")
    .all() as Array<{ name: string }>;
  if (columns.length === 0) return;
  if (columns.some(({ name }) => name === 'outcome_code')) return;

  db.exec(`
    CREATE TABLE tool_calls_v50 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_key TEXT NOT NULL,
      session_checkpoint_id INTEGER,
      tool_name TEXT NOT NULL,
      tool_group TEXT NOT NULL
        CHECK (tool_group IN (${sqlValues(TOOL_DURABILITY_GROUPS)})),
      tool_input TEXT NOT NULL
        CHECK (tool_input = '${TOOL_INPUT_MARKER}'),
      status TEXT NOT NULL
        CHECK (
          status IN (
            'pending', 'executing', 'complete', 'error', 'replayed', 'quarantined'
          )
        ),
      result TEXT,
      replay_policy TEXT NOT NULL
        CHECK (replay_policy IN ('safe', 'unsafe', 'read_only')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      outbound_op_id INTEGER,
      outcome_code TEXT NOT NULL
        CHECK (
          outcome_code IN (
            'not_terminal', 'success', 'failure',
            'recovered_replayed', 'recovery_quarantined'
          )
        ),
      failure_code TEXT
        CHECK (
          failure_code IS NULL
          OR failure_code IN (${sqlValues(TOOL_FAILURE_CODES)})
        ),
      failure_stage TEXT
        CHECK (
          failure_stage IS NULL
          OR failure_stage IN (
            'admission', 'validation', 'authorization', 'policy', 'handler',
            'dependency', 'recovery', 'unknown'
          )
        ),
      retry_disposition TEXT NOT NULL
        CHECK (
          retry_disposition IN (
            'not_applicable', 'retryable', 'not_retryable', 'unknown'
          )
        ),
      operator_action TEXT NOT NULL
        CHECK (operator_action IN ('none', 'inspect', 'recover', 'unknown')),
      evidence_coverage TEXT NOT NULL
        CHECK (
          evidence_coverage IN ('complete', 'partial', 'legacy_unclassified')
        ),
      duration_ms INTEGER
        CHECK (
          duration_ms IS NULL
          OR (
            typeof(duration_ms) = 'integer'
            AND duration_ms BETWEEN 0 AND 9007199254740991
          )
        ),
      CHECK (
        (
          status IN ('pending', 'executing')
          AND outcome_code = 'not_terminal'
          AND result IS NULL
          AND completed_at IS NULL
          AND failure_code IS NULL
          AND failure_stage IS NULL
          AND retry_disposition = 'not_applicable'
          AND operator_action = 'none'
          AND duration_ms IS NULL
        )
        OR (
          status = 'complete'
          AND outcome_code = 'success'
          AND result = '${TOOL_RESULT_MARKERS.success}'
          AND completed_at IS NOT NULL
          AND failure_code IS NULL
          AND failure_stage IS NULL
          AND retry_disposition = 'not_applicable'
          AND operator_action = 'none'
        )
        OR (
          status = 'error'
          AND outcome_code = 'failure'
          AND result = '${TOOL_RESULT_MARKERS.error}'
          AND completed_at IS NOT NULL
          AND failure_code IS NOT NULL
          AND failure_stage IS NOT NULL
          AND retry_disposition <> 'not_applicable'
        )
        OR (
          status = 'replayed'
          AND outcome_code = 'recovered_replayed'
          AND result = '${TOOL_RESULT_MARKERS.recovery}'
          AND completed_at IS NOT NULL
          AND failure_code IS NULL
          AND failure_stage IS NULL
          AND retry_disposition = 'not_applicable'
          AND operator_action = 'none'
        )
        OR (
          status = 'quarantined'
          AND outcome_code = 'recovery_quarantined'
          AND result = '${TOOL_RESULT_MARKERS.recovery}'
          AND completed_at IS NOT NULL
          AND failure_code = 'unknown'
          AND failure_stage = 'recovery'
          AND retry_disposition = 'not_retryable'
          AND operator_action = 'inspect'
        )
      ),
      CHECK (
        failure_code IS NULL
        OR failure_code = 'unknown'
        OR evidence_coverage <> 'legacy_unclassified'
      )
    )
  `);

  db.exec(`
    INSERT INTO tool_calls_v50 (
      id,
      conversation_key,
      session_checkpoint_id,
      tool_name,
      tool_group,
      tool_input,
      status,
      result,
      replay_policy,
      created_at,
      completed_at,
      outbound_op_id,
      outcome_code,
      failure_code,
      failure_stage,
      retry_disposition,
      operator_action,
      evidence_coverage,
      duration_ms
    )
    SELECT
      id,
      conversation_key,
      session_checkpoint_id,
      tool_name,
      'other',
      '${TOOL_INPUT_MARKER}',
      status,
      CASE status
        WHEN 'complete' THEN '${TOOL_RESULT_MARKERS.success}'
        WHEN 'error' THEN '${TOOL_RESULT_MARKERS.error}'
        WHEN 'replayed' THEN '${TOOL_RESULT_MARKERS.recovery}'
        WHEN 'quarantined' THEN '${TOOL_RESULT_MARKERS.recovery}'
        ELSE NULL
      END,
      replay_policy,
      created_at,
      completed_at,
      outbound_op_id,
      CASE status
        WHEN 'pending' THEN 'not_terminal'
        WHEN 'executing' THEN 'not_terminal'
        WHEN 'complete' THEN 'success'
        WHEN 'error' THEN 'failure'
        WHEN 'replayed' THEN 'recovered_replayed'
        WHEN 'quarantined' THEN 'recovery_quarantined'
      END,
      CASE status
        WHEN 'error' THEN 'unknown'
        WHEN 'quarantined' THEN 'unknown'
        ELSE NULL
      END,
      CASE status
        WHEN 'error' THEN 'unknown'
        WHEN 'quarantined' THEN 'recovery'
        ELSE NULL
      END,
      CASE status
        WHEN 'error' THEN 'unknown'
        WHEN 'quarantined' THEN 'not_retryable'
        ELSE 'not_applicable'
      END,
      CASE status
        WHEN 'error' THEN 'unknown'
        WHEN 'quarantined' THEN 'inspect'
        ELSE 'none'
      END,
      'legacy_unclassified',
      NULL
    FROM tool_calls
  `);

  db.exec('DROP TABLE tool_calls');
  db.exec('ALTER TABLE tool_calls_v50 RENAME TO tool_calls');
  db.exec(`
    CREATE INDEX idx_tool_calls_status_created
      ON tool_calls(status, created_at)
  `);
  db.exec(`
    CREATE INDEX idx_tool_calls_failure_completed
      ON tool_calls(failure_code, completed_at)
      WHERE status = 'error'
  `);
}
