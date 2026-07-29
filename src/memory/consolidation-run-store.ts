import { randomBytes } from 'node:crypto';
import type { Database } from '../core/database.ts';
import type { MemoryEvidenceCoverage } from '../lib/memory-operation-telemetry.ts';
import {
  CONSOLIDATION_RUN_SCHEMA_VERSION,
  emptyConsolidationCounters,
  type ConsolidationCounters,
  type ConsolidationFailureCode,
  type ConsolidationHealth,
  type ConsolidationReceiptStatus,
  type ConsolidationRunMode,
  type ConsolidationRunStage,
} from '../core/memory-consolidation-contract.ts';

export type ConsolidationRunSource =
  | 'scheduler_immediate'
  | 'scheduler_periodic'
  | 'manual';

export type ConsolidationTerminalStatus = Exclude<
  ConsolidationReceiptStatus,
  'running' | 'cancelling'
>;

export interface ConsolidationRunHandle {
  runId: string;
}

interface ReceiptRow {
  mode: ConsolidationRunMode;
  status: ConsolidationReceiptStatus;
  stage: ConsolidationRunStage;
  failure_code: ConsolidationFailureCode;
  retryable: number;
  evidence_coverage: MemoryEvidenceCoverage;
  attempted_at: number;
  last_progress_at: number;
  lease_expires_at: number | null;
  completed_at: number | null;
  success_at: number | null;
  records_observed: number;
  clusters_attempted: number;
  clusters_completed: number;
  would_promote: number;
  write_attempted: number;
  write_confirmed: number;
  discarded: number;
  failed: number;
  skipped: number;
  overlap_skipped: number;
}

function counterArguments(counters: ConsolidationCounters): number[] {
  return [
    counters.recordsObserved,
    counters.clustersAttempted,
    counters.clustersCompleted,
    counters.wouldPromote,
    counters.writeAttempted,
    counters.writeConfirmed,
    counters.discarded,
    counters.failed,
    counters.skipped,
  ];
}

function countersFromRow(row: ReceiptRow): ConsolidationCounters {
  return {
    recordsObserved: row.records_observed,
    clustersAttempted: row.clusters_attempted,
    clustersCompleted: row.clusters_completed,
    wouldPromote: row.would_promote,
    writeAttempted: row.write_attempted,
    writeConfirmed: row.write_confirmed,
    discarded: row.discarded,
    failed: row.failed,
    skipped: row.skipped,
  };
}

function healthState(
  row: ReceiptRow,
  nowMs: number,
  stalledAfterMs: number,
): ConsolidationHealth['state'] {
  if (row.status === 'running') {
    if (row.overlap_skipped >= 2) return 'stalled';
    const progressAge = Math.max(0, nowMs - row.last_progress_at);
    if (
      progressAge > stalledAfterMs
      || (row.lease_expires_at !== null && nowMs > row.lease_expires_at)
    ) {
      return 'stalled';
    }
    return 'current';
  }
  if (row.status === 'cancelling') return 'cancelling';
  if (row.status === 'no_work') return 'no_work';
  if (row.status === 'completed') {
    return row.mode === 'dry_run' ? 'dry_run' : 'current';
  }
  if (row.status === 'partial') return 'partial';
  if (row.status === 'abandoned') return 'abandoned';
  return 'failed';
}

export class ConsolidationRunStore {
  private readonly database: Database;

  constructor(database: Database) {
    this.database = database;
  }

  beginRun(input: {
    source: ConsolidationRunSource;
    mode: ConsolidationRunMode;
    nowMs: number;
    leaseExpiresAtMs: number;
  }): ConsolidationRunHandle {
    const runId = randomBytes(16).toString('hex');
    this.database.raw.prepare(`
      INSERT INTO memory_consolidation_runs (
        run_id, source, mode, status, stage, failure_code, retryable,
        evidence_coverage, attempted_at, last_progress_at, lease_expires_at
      ) VALUES (?, ?, ?, 'running', 'scheduled', 'none', 0,
        'not_observed', ?, ?, ?)
    `).run(
      runId,
      input.source,
      input.mode,
      input.nowMs,
      input.nowMs,
      input.leaseExpiresAtMs,
    );
    return { runId };
  }

  recordProgress(
    handle: ConsolidationRunHandle,
    input: {
      stage: ConsolidationRunStage;
      evidenceCoverage: MemoryEvidenceCoverage;
      counters: ConsolidationCounters;
      nowMs: number;
      leaseExpiresAtMs: number;
    },
  ): boolean {
    const result = this.database.raw.prepare(`
      UPDATE memory_consolidation_runs
      SET stage = ?,
          evidence_coverage = ?,
          last_progress_at = ?,
          lease_expires_at = ?,
          records_observed = ?,
          clusters_attempted = ?,
          clusters_completed = ?,
          would_promote = ?,
          write_attempted = ?,
          write_confirmed = ?,
          discarded = ?,
          failed = ?,
          skipped = ?
      WHERE run_id = ? AND status = 'running'
    `).run(
      input.stage,
      input.evidenceCoverage,
      input.nowMs,
      input.leaseExpiresAtMs,
      ...counterArguments(input.counters),
      handle.runId,
    );
    return Number(result.changes) === 1;
  }

  recordSkippedTick(handle: ConsolidationRunHandle, nowMs: number): boolean {
    const result = this.database.raw.prepare(`
      UPDATE memory_consolidation_runs
      SET overlap_skipped = overlap_skipped + 1,
          last_skipped_at = ?,
          failure_code = 'already_running',
          retryable = 1
      WHERE run_id = ? AND status IN ('running', 'cancelling')
    `).run(nowMs, handle.runId);
    return Number(result.changes) === 1;
  }

  requestCancellation(handle: ConsolidationRunHandle, _nowMs: number): boolean {
    const result = this.database.raw.prepare(`
      UPDATE memory_consolidation_runs
      SET status = 'cancelling',
          failure_code = 'cancelled',
          retryable = 1
      WHERE run_id = ? AND status = 'running'
    `).run(handle.runId);
    return Number(result.changes) === 1;
  }

  finalizeRun(
    handle: ConsolidationRunHandle,
    input: {
      status: ConsolidationTerminalStatus;
      stage: ConsolidationRunStage;
      failureCode: ConsolidationFailureCode;
      retryable: boolean;
      evidenceCoverage: MemoryEvidenceCoverage;
      counters: ConsolidationCounters;
      nowMs: number;
    },
  ): boolean {
    const successAt =
      input.status === 'completed' || input.status === 'no_work'
        ? input.nowMs
        : null;
    const allowedCurrentStatus =
      input.status === 'cancelled' || input.status === 'abandoned'
        ? "status IN ('running', 'cancelling')"
        : "status = 'running'";
    const result = this.database.raw.prepare(`
      UPDATE memory_consolidation_runs
      SET status = ?,
          stage = ?,
          failure_code = ?,
          retryable = ?,
          evidence_coverage = ?,
          last_progress_at = ?,
          lease_expires_at = NULL,
          completed_at = ?,
          success_at = ?,
          records_observed = ?,
          clusters_attempted = ?,
          clusters_completed = ?,
          would_promote = ?,
          write_attempted = ?,
          write_confirmed = ?,
          discarded = ?,
          failed = ?,
          skipped = ?
      WHERE run_id = ? AND ${allowedCurrentStatus}
    `).run(
      input.status,
      input.stage,
      input.failureCode,
      input.retryable ? 1 : 0,
      input.evidenceCoverage,
      input.nowMs,
      input.nowMs,
      successAt,
      ...counterArguments(input.counters),
      handle.runId,
    );
    return Number(result.changes) === 1;
  }

  abandonInterruptedRuns(nowMs: number): number {
    const result = this.database.raw.prepare(`
      UPDATE memory_consolidation_runs
      SET status = 'abandoned',
          stage = 'finalize',
          failure_code = 'restart_abandoned',
          retryable = 1,
          evidence_coverage = 'local_guard',
          last_progress_at = ?,
          lease_expires_at = NULL,
          completed_at = ?,
          success_at = NULL
      WHERE status IN ('running', 'cancelling')
    `).run(nowMs, nowMs);
    return Number(result.changes);
  }

  readHealth(input: {
    enabled: boolean;
    started: boolean;
    nowMs: number;
    stalledAfterMs: number;
  }): ConsolidationHealth {
    if (!input.enabled) return this.emptyHealth('disabled');

    try {
      const row = this.database.raw.prepare(`
        SELECT
          mode, status, stage, failure_code, retryable, evidence_coverage,
          attempted_at, last_progress_at, lease_expires_at, completed_at,
          success_at,
          records_observed, clusters_attempted, clusters_completed,
          would_promote, write_attempted, write_confirmed, discarded,
          failed, skipped, overlap_skipped
        FROM memory_consolidation_runs
        ORDER BY attempted_at DESC, run_id DESC
        LIMIT 1
      `).get() as ReceiptRow | undefined;

      if (!row) return this.emptyHealth('not_started');

      const success = this.database.raw.prepare(`
        SELECT MAX(success_at) AS latest_success_at
        FROM memory_consolidation_runs
      `).get() as { latest_success_at: number | null };
      const active =
        row.status === 'running' || row.status === 'cancelling';
      let state = healthState(row, input.nowMs, input.stalledAfterMs);
      let failureCode = row.failure_code;
      let retryable = row.retryable === 1;
      let evidenceCoverage = row.evidence_coverage;

      if (row.status === 'running' && state === 'current') {
        const latchedFailure = this.database.raw.prepare(`
          SELECT
            mode, status, stage, failure_code, retryable, evidence_coverage,
            attempted_at, last_progress_at, lease_expires_at, completed_at,
            success_at,
            records_observed, clusters_attempted, clusters_completed,
            would_promote, write_attempted, write_confirmed, discarded,
            failed, skipped, overlap_skipped
          FROM memory_consolidation_runs
          WHERE status IN ('partial', 'failed', 'cancelled', 'abandoned')
            AND completed_at > ?
          ORDER BY completed_at DESC, attempted_at DESC, run_id DESC
          LIMIT 1
        `).get(success.latest_success_at ?? 0) as ReceiptRow | undefined;
        if (latchedFailure) {
          state = healthState(
            latchedFailure,
            input.nowMs,
            input.stalledAfterMs,
          );
          failureCode = latchedFailure.failure_code;
          retryable = latchedFailure.retryable === 1;
          evidenceCoverage = latchedFailure.evidence_coverage;
        }
      }
      if (
        !input.started
        && (state === 'current' || state === 'dry_run' || state === 'no_work')
      ) {
        state = 'not_started';
      }

      return {
        schema_version: CONSOLIDATION_RUN_SCHEMA_VERSION,
        readable: true,
        state,
        mode: row.mode,
        latest_status: row.status,
        latest_stage: row.stage,
        failure_code: failureCode,
        retryable,
        evidence_coverage: evidenceCoverage,
        latest_attempt_at: row.attempted_at,
        latest_success_at: success.latest_success_at,
        active_age_ms: active
          ? Math.max(0, input.nowMs - row.attempted_at)
          : null,
        skipped_ticks: row.overlap_skipped,
        counters: countersFromRow(row),
      };
    } catch {
      return this.emptyHealth('unreadable', false, 'observation_failed');
    }
  }

  private emptyHealth(
    state: ConsolidationHealth['state'],
    readable = true,
    failureCode: ConsolidationFailureCode = 'none',
  ): ConsolidationHealth {
    return {
      schema_version: CONSOLIDATION_RUN_SCHEMA_VERSION,
      readable,
      state,
      mode: null,
      latest_status: null,
      latest_stage: null,
      failure_code: failureCode,
      retryable: false,
      evidence_coverage: 'not_observed',
      latest_attempt_at: null,
      latest_success_at: null,
      active_age_ms: null,
      skipped_ticks: 0,
      counters: emptyConsolidationCounters(),
    };
  }
}
