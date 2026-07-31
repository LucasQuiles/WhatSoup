import type {
  MemoryEvidenceCoverage,
  MemoryOperationFailureCode,
} from '../lib/memory-operation-telemetry.ts';
import { MEMORY_OPERATION_FAILURE_CODES } from '../lib/memory-operation-telemetry.ts';

export const CONSOLIDATION_RUN_SCHEMA_VERSION = 1 as const;

export type ConsolidationRunMode = 'dry_run' | 'live';
export type ConsolidationRunStatus =
  | 'completed'
  | 'no_work'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'skipped';
export type ConsolidationReceiptStatus =
  | 'running'
  | 'cancelling'
  | 'no_work'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'abandoned';
export type ConsolidationRunStage =
  | 'scheduled'
  | 'search'
  | 'cluster'
  | 'generate'
  | 'validate'
  | 'write'
  | 'finalize';
export const CONSOLIDATION_FAILURE_CODES = [
  ...MEMORY_OPERATION_FAILURE_CODES,
  'output_invalid',
  'scope_invalid',
  'write_failed',
  'cancelled',
  'already_running',
  'restart_abandoned',
  'observation_failed',
] as const satisfies readonly (
  | MemoryOperationFailureCode
  | 'output_invalid'
  | 'scope_invalid'
  | 'write_failed'
  | 'cancelled'
  | 'already_running'
  | 'restart_abandoned'
  | 'observation_failed'
)[];

export type ConsolidationFailureCode =
  (typeof CONSOLIDATION_FAILURE_CODES)[number];

export interface ConsolidationCounters {
  recordsObserved: number;
  clustersAttempted: number;
  clustersCompleted: number;
  wouldPromote: number;
  writeAttempted: number;
  writeConfirmed: number;
  discarded: number;
  failed: number;
  skipped: number;
}

export interface ConsolidationRunReport {
  schemaVersion: typeof CONSOLIDATION_RUN_SCHEMA_VERSION;
  runId: string;
  mode: ConsolidationRunMode;
  status: ConsolidationRunStatus;
  stage: ConsolidationRunStage;
  failureCode: ConsolidationFailureCode;
  retryable: boolean;
  evidenceCoverage: MemoryEvidenceCoverage;
  attemptedAt: string;
  completedAt: string;
  successAt: string | null;
  durationMs: number;
  counters: ConsolidationCounters;
}

export interface ConsolidationHealth {
  schema_version: typeof CONSOLIDATION_RUN_SCHEMA_VERSION;
  readable: boolean;
  state:
    | 'disabled'
    | 'not_started'
    | 'current'
    | 'dry_run'
    | 'no_work'
    | 'stalled'
    | 'cancelling'
    | 'partial'
    | 'failed'
    | 'abandoned'
    | 'unreadable';
  mode: ConsolidationRunMode | null;
  latest_status: ConsolidationReceiptStatus | null;
  latest_stage: ConsolidationRunStage | null;
  failure_code: ConsolidationFailureCode;
  retryable: boolean;
  evidence_coverage: MemoryEvidenceCoverage;
  latest_attempt_at: number | null;
  latest_success_at: number | null;
  active_age_ms: number | null;
  skipped_ticks: number;
  counters: ConsolidationCounters;
}

export function emptyConsolidationCounters(): ConsolidationCounters {
  return {
    recordsObserved: 0,
    clustersAttempted: 0,
    clustersCompleted: 0,
    wouldPromote: 0,
    writeAttempted: 0,
    writeConfirmed: 0,
    discarded: 0,
    failed: 0,
    skipped: 0,
  };
}
