import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TOOL_INPUT_MARKER,
  TOOL_RESULT_MARKERS,
} from '../../src/core/durability-evidence-contract.ts';
import { runMigration50 } from '../../src/core/database-migration-50.ts';
import { CURRENT_SCHEMA_MIGRATION, Database } from '../../src/core/database.ts';

const INPUT_CANARY = 'CANARY-2561-RAW-TOOL-INPUT';
const RESULT_CANARY = 'CANARY-2561-RAW-TOOL-RESULT';
const ERROR_CANARY = 'CANARY-2561-RAW-ERROR-PROSE';

function createLegacyToolCalls(raw: DatabaseSync): void {
  raw.exec(`
    CREATE TABLE tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_key TEXT NOT NULL,
      session_checkpoint_id INTEGER,
      tool_name TEXT NOT NULL,
      tool_input TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      result TEXT,
      replay_policy TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      outbound_op_id INTEGER
    )
  `);
}

function insertLegacy(
  raw: DatabaseSync,
  id: number,
  status: string,
  result: string | null,
  completedAt: string | null,
): void {
  raw.prepare(`
    INSERT INTO tool_calls (
      id, conversation_key, tool_name, tool_input, status, result,
      replay_policy, created_at, completed_at, outbound_op_id
    ) VALUES (?, 'conversation-a', 'send_message', ?, ?, ?, 'unsafe',
              '2026-07-01 00:00:00', ?, 77)
  `).run(id, `${INPUT_CANARY}-${id}`, status, result, completedAt);
}

describe('migration 50 metadata-only tool-call evidence', () => {
  let raw: DatabaseSync;

  beforeEach(() => {
    raw = new DatabaseSync(':memory:');
    createLegacyToolCalls(raw);
  });

  afterEach(() => {
    raw.close();
  });

  it('scrubs legacy content and maps every lifecycle without parsing prose', () => {
    insertLegacy(raw, 1, 'pending', null, null);
    insertLegacy(raw, 2, 'executing', null, null);
    insertLegacy(raw, 3, 'complete', RESULT_CANARY, '2026-07-01 00:00:01');
    insertLegacy(raw, 4, 'error', `error: ${ERROR_CANARY}`, '2026-07-01 00:00:02');
    insertLegacy(raw, 5, 'replayed', RESULT_CANARY, '2026-07-01 00:00:03');
    insertLegacy(raw, 6, 'quarantined', RESULT_CANARY, '2026-07-01 00:00:04');

    runMigration50(raw);

    const rows = raw.prepare(`
      SELECT id, tool_input, status, result, tool_group, outcome_code,
             failure_code, failure_stage, retry_disposition, operator_action,
             evidence_coverage, duration_ms
      FROM tool_calls ORDER BY id
    `).all() as Array<Record<string, unknown>>;

    expect(rows).toEqual([
      {
        id: 1,
        tool_input: TOOL_INPUT_MARKER,
        status: 'pending',
        result: null,
        tool_group: 'other',
        outcome_code: 'not_terminal',
        failure_code: null,
        failure_stage: null,
        retry_disposition: 'not_applicable',
        operator_action: 'none',
        evidence_coverage: 'legacy_unclassified',
        duration_ms: null,
      },
      {
        id: 2,
        tool_input: TOOL_INPUT_MARKER,
        status: 'executing',
        result: null,
        tool_group: 'other',
        outcome_code: 'not_terminal',
        failure_code: null,
        failure_stage: null,
        retry_disposition: 'not_applicable',
        operator_action: 'none',
        evidence_coverage: 'legacy_unclassified',
        duration_ms: null,
      },
      {
        id: 3,
        tool_input: TOOL_INPUT_MARKER,
        status: 'complete',
        result: TOOL_RESULT_MARKERS.success,
        tool_group: 'other',
        outcome_code: 'success',
        failure_code: null,
        failure_stage: null,
        retry_disposition: 'not_applicable',
        operator_action: 'none',
        evidence_coverage: 'legacy_unclassified',
        duration_ms: null,
      },
      {
        id: 4,
        tool_input: TOOL_INPUT_MARKER,
        status: 'error',
        result: TOOL_RESULT_MARKERS.error,
        tool_group: 'other',
        outcome_code: 'failure',
        failure_code: 'unknown',
        failure_stage: 'unknown',
        retry_disposition: 'unknown',
        operator_action: 'unknown',
        evidence_coverage: 'legacy_unclassified',
        duration_ms: null,
      },
      {
        id: 5,
        tool_input: TOOL_INPUT_MARKER,
        status: 'replayed',
        result: TOOL_RESULT_MARKERS.recovery,
        tool_group: 'other',
        outcome_code: 'recovered_replayed',
        failure_code: null,
        failure_stage: null,
        retry_disposition: 'not_applicable',
        operator_action: 'none',
        evidence_coverage: 'legacy_unclassified',
        duration_ms: null,
      },
      {
        id: 6,
        tool_input: TOOL_INPUT_MARKER,
        status: 'quarantined',
        result: TOOL_RESULT_MARKERS.recovery,
        tool_group: 'other',
        outcome_code: 'recovery_quarantined',
        failure_code: 'unknown',
        failure_stage: 'recovery',
        retry_disposition: 'not_retryable',
        operator_action: 'inspect',
        evidence_coverage: 'legacy_unclassified',
        duration_ms: null,
      },
    ]);

    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(INPUT_CANARY);
    expect(serialized).not.toContain(RESULT_CANARY);
    expect(serialized).not.toContain(ERROR_CANARY);
  });

  it('preserves the exact open-row recovery identity and terminal exclusion', () => {
    insertLegacy(raw, 1, 'pending', null, null);
    insertLegacy(raw, 2, 'executing', null, null);
    insertLegacy(raw, 3, 'error', ERROR_CANARY, '2026-07-01 00:00:02');

    runMigration50(raw);

    expect(raw.prepare(`
      SELECT id, conversation_key, tool_name, replay_policy, outbound_op_id
      FROM tool_calls
      WHERE status IN ('executing', 'pending')
      ORDER BY id
    `).all()).toEqual([
      {
        id: 1,
        conversation_key: 'conversation-a',
        tool_name: 'send_message',
        replay_policy: 'unsafe',
        outbound_op_id: 77,
      },
      {
        id: 2,
        conversation_key: 'conversation-a',
        tool_name: 'send_message',
        replay_policy: 'unsafe',
        outbound_op_id: 77,
      },
    ]);
  });

  it('rejects lifecycle, marker, and evidence contradictions', () => {
    runMigration50(raw);

    expect(() => raw.prepare(`
      INSERT INTO tool_calls (
        conversation_key, tool_name, tool_group, tool_input, status, result,
        replay_policy, outcome_code, failure_code, failure_stage,
        retry_disposition, operator_action, evidence_coverage, completed_at
      ) VALUES (
        'c', 'tool', 'other', ?, 'error', ?,
        'unsafe', 'failure', NULL, 'handler',
        'not_retryable', 'inspect', 'complete', datetime('now')
      )
    `).run(TOOL_INPUT_MARKER, TOOL_RESULT_MARKERS.error)).toThrow();

    expect(() => raw.prepare(`
      INSERT INTO tool_calls (
        conversation_key, tool_name, tool_group, tool_input, status, result,
        replay_policy, outcome_code, failure_code, failure_stage,
        retry_disposition, operator_action, evidence_coverage, completed_at
      ) VALUES (
        'c', 'tool', 'other', 'RAW-CONTENT', 'complete', ?,
        'unsafe', 'success', NULL, NULL,
        'not_applicable', 'none', 'complete', datetime('now')
      )
    `).run(TOOL_RESULT_MARKERS.success)).toThrow();

    expect(() => raw.prepare(`
      INSERT INTO tool_calls (
        conversation_key, tool_name, tool_group, tool_input, status, result,
        replay_policy, outcome_code, failure_code, failure_stage,
        retry_disposition, operator_action, evidence_coverage
      ) VALUES (
        'c', 'tool', 'extension-private', ?, 'pending', NULL,
        'unsafe', 'not_terminal', NULL, NULL,
        'not_applicable', 'none', 'complete'
      )
    `).run(TOOL_INPUT_MARKER)).toThrow();
  });

  it('is idempotent against an already migrated schema', () => {
    insertLegacy(raw, 1, 'error', ERROR_CANARY, '2026-07-01 00:00:02');

    runMigration50(raw);
    runMigration50(raw);

    expect(raw.prepare('SELECT COUNT(*) AS count FROM tool_calls').get()).toEqual({ count: 1 });
    expect(raw.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  });

  it('is registered as the current schema migration', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      expect(CURRENT_SCHEMA_MIGRATION).toBe(52);
      expect(db.raw.prepare(
        'SELECT version FROM schema_migrations WHERE version = 50',
      ).get()).toEqual({ version: 50 });
    } finally {
      db.close();
    }
  });
});
