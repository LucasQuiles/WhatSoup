import { randomBytes } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { classifyOutboundSendFailure } from './durability-evidence-contract.ts';

export type OutboundSendCaller = 'mcp' | 'health' | 'rgp';
export type OutboundSendTargetKind = 'chatJid' | 'alias';

export interface OutboundSendIntentInput {
  caller: OutboundSendCaller;
  targetKind: OutboundSendTargetKind;
}

export interface OutboundSendIntentReceipt {
  id: number;
  auditReceipt: string;
}

export interface OutboundSendListOptions {
  limit?: number;
  auditReceipt?: string;
}

export interface OutboundSendMaintenanceOptions {
  mode: 'preview' | 'apply';
  terminalDays: number;
  terminalMaxRows: number;
}

export interface OutboundSendMaintenanceResult {
  mode: 'preview' | 'apply';
  eligibleRows: number;
  deletedRows: number;
}

export interface OutboundSendReadRow {
  id: number;
  audit_receipt: string;
  schema_version: 1;
  caller: OutboundSendCaller;
  target_kind: OutboundSendTargetKind;
  outcome_code: string;
  failure_code?: string;
  failure_stage: string;
  mutation_state: string;
  retryable?: boolean;
  evidence_coverage: string;
  logical_attempt_count?: number;
  provider_submission_count?: number;
  created_at: string;
  completed_at?: string;
}

export interface OutboundSendsWriter {
  writeIntent(input: OutboundSendIntentInput): OutboundSendIntentReceipt;
  markSuccess(id: number): void;
  markFailure(id: number, error: unknown): void;
  listRecent(options?: OutboundSendListOptions): OutboundSendReadRow[];
  maintain(options: OutboundSendMaintenanceOptions): OutboundSendMaintenanceResult;
}

export function createOutboundSendsWriter({
  db,
}: {
  db: DatabaseSync;
  /** @deprecated Kept as a source-compatible construction option; never stored. */
  line?: string;
}): OutboundSendsWriter {
  const insertIntent = db.prepare(`
    INSERT INTO outbound_sends (
      audit_receipt,
      caller,
      target_kind,
      outcome_code,
      failure_stage,
      mutation_state,
      evidence_coverage,
      logical_attempt_count,
      provider_submission_count
    ) VALUES (?, ?, ?, 'intent', 'not_started', 'not_started', 'typed', 1, 0)
  `);
  const markSubmitted = db.prepare(`
    UPDATE outbound_sends
       SET outcome_code = 'submitted',
           failure_code = NULL,
           failure_stage = 'ack_received',
           mutation_state = 'acknowledged',
           retryable = NULL,
           evidence_coverage = 'typed',
           provider_submission_count = 1,
           completed_at = datetime('now')
     WHERE id = ?
       AND outcome_code = 'intent'
  `);
  const markFailed = db.prepare(`
    UPDATE outbound_sends
       SET outcome_code = ?,
           failure_code = ?,
           failure_stage = ?,
           mutation_state = ?,
           retryable = ?,
           evidence_coverage = ?,
           provider_submission_count = ?,
           completed_at = datetime('now')
     WHERE id = ?
       AND outcome_code = 'intent'
  `);
  const selectOutcome = db.prepare('SELECT outcome_code FROM outbound_sends WHERE id = ?');
  const listRecent = db.prepare(`
    SELECT
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
    FROM outbound_sends
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `);
  const listRecentByReceipt = db.prepare(`
    SELECT
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
    FROM outbound_sends
    WHERE audit_receipt = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `);

  return {
    writeIntent(input: OutboundSendIntentInput): OutboundSendIntentReceipt {
      const auditReceipt = randomBytes(16).toString('hex');
      const result = insertIntent.run(auditReceipt, input.caller, input.targetKind);
      return {
        id: Number(result.lastInsertRowid),
        auditReceipt,
      };
    },

    markSuccess(id: number): void {
      assertFinalized(markSubmitted.run(id), selectOutcome, id);
    },

    markFailure(id: number, error: unknown): void {
      const evidence = classifyOutboundSendFailure(error);
      const providerSubmissionCount = evidence.failureStage === 'ack_received' ? 1 : 0;
      assertFinalized(
        markFailed.run(
          evidence.outcomeCode,
          evidence.failureCode,
          evidence.failureStage,
          evidence.mutationState,
          evidence.retryable ? 1 : 0,
          evidence.evidenceCoverage,
          providerSubmissionCount,
          id,
        ),
        selectOutcome,
        id,
      );
    },

    listRecent(options: OutboundSendListOptions = {}): OutboundSendReadRow[] {
      const limit = normalizeLimit(options.limit);
      const rows = options.auditReceipt === undefined
        ? listRecent.all(limit)
        : listRecentByReceipt.all(normalizeAuditReceipt(options.auditReceipt), limit);
      return (rows as unknown as RawOutboundSendReadRow[]).map(toOutboundSendReadRow);
    },

    maintain(options: OutboundSendMaintenanceOptions): OutboundSendMaintenanceResult {
      return maintainOutboundSends(db, options);
    },
  };
}

const TERMINAL_RETENTION_PREDICATE = `
  outcome_code IN (
    'submitted', 'confirmed', 'failed_not_sent',
    'ambiguous', 'legacy_unclassified'
  )
  AND (
    COALESCE(completed_at, created_at) < datetime('now', ?)
    OR id IN (
      SELECT id
      FROM outbound_sends
      WHERE outcome_code IN (
        'submitted', 'confirmed', 'failed_not_sent',
        'ambiguous', 'legacy_unclassified'
      )
      ORDER BY COALESCE(completed_at, created_at) DESC, id DESC
      LIMIT -1 OFFSET ?
    )
  )
`;

export function maintainOutboundSends(
  db: DatabaseSync,
  options: OutboundSendMaintenanceOptions,
): OutboundSendMaintenanceResult {
  const mode = options.mode;
  if (mode !== 'preview' && mode !== 'apply') {
    throw new Error('mode must be preview or apply');
  }
  const terminalDays = normalizePositiveInteger(options.terminalDays, 'terminalDays');
  const terminalMaxRows = Math.max(
    100,
    normalizePositiveInteger(options.terminalMaxRows, 'terminalMaxRows'),
  );
  const cutoff = `-${terminalDays} days`;
  const eligibleRows = (
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM outbound_sends
      WHERE ${TERMINAL_RETENTION_PREDICATE}
    `).get(cutoff, terminalMaxRows) as { count: number }
  ).count;

  if (mode === 'preview' || eligibleRows === 0) {
    return { mode, eligibleRows, deletedRows: 0 };
  }

  const deletedRows = Number(db.prepare(`
    DELETE FROM outbound_sends
    WHERE ${TERMINAL_RETENTION_PREDICATE}
  `).run(cutoff, terminalMaxRows).changes);
  return { mode, eligibleRows, deletedRows };
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isInteger(limit)) {
    throw new Error('limit must be an integer');
  }
  if (limit < 1) {
    throw new Error('limit must be at least 1');
  }
  return Math.min(limit, 100);
}

function normalizeAuditReceipt(receipt: string): string {
  if (!/^[0-9a-f]{32}$/.test(receipt)) {
    throw new Error('auditReceipt must be 32 lowercase hexadecimal characters');
  }
  return receipt;
}

function normalizePositiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

interface RawOutboundSendReadRow {
  id: number;
  audit_receipt: string;
  schema_version: 1;
  caller: OutboundSendCaller;
  target_kind: OutboundSendTargetKind;
  outcome_code: string;
  failure_code: string | null;
  failure_stage: string;
  mutation_state: string;
  retryable: 0 | 1 | null;
  evidence_coverage: string;
  logical_attempt_count: number | null;
  provider_submission_count: number | null;
  created_at: string;
  completed_at: string | null;
}

function toOutboundSendReadRow(row: RawOutboundSendReadRow): OutboundSendReadRow {
  return {
    id: row.id,
    audit_receipt: row.audit_receipt,
    schema_version: row.schema_version,
    caller: row.caller,
    target_kind: row.target_kind,
    outcome_code: row.outcome_code,
    ...(row.failure_code === null ? {} : { failure_code: row.failure_code }),
    failure_stage: row.failure_stage,
    mutation_state: row.mutation_state,
    ...(row.retryable === null ? {} : { retryable: row.retryable === 1 }),
    evidence_coverage: row.evidence_coverage,
    ...(row.logical_attempt_count === null
      ? {}
      : { logical_attempt_count: row.logical_attempt_count }),
    ...(row.provider_submission_count === null
      ? {}
      : { provider_submission_count: row.provider_submission_count }),
    created_at: row.created_at,
    ...(row.completed_at === null ? {} : { completed_at: row.completed_at }),
  };
}

function assertFinalized(
  result: ReturnType<StatementSync['run']>,
  selectOutcome: StatementSync,
  id: number,
): void {
  if (Number(result.changes) === 1) return;

  const row = selectOutcome.get(id) as { outcome_code: string } | undefined;
  if (!row) {
    throw new Error(`outbound send audit row not found: ${id}`);
  }
  throw new Error(
    `outbound send audit row ${id} is already finalized with outcome ${row.outcome_code}`,
  );
}
