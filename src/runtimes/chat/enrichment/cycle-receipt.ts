import type { Database } from '../../../core/database.ts';

export const ENRICHMENT_CYCLE_RECEIPT_SCHEMA_VERSION = 1 as const;

export const ENRICHMENT_CYCLE_RECEIPT_STATUSES = [
  'no_work',
  'completed',
  'partial',
  'failed',
  'legacy_unclassified',
] as const;

export const ENRICHMENT_CYCLE_FAILURE_CODES = [
  'none',
  'segment_failed',
  'selection_failed',
  'message_state_write_failed',
  'ledger_write_failed',
  'legacy_unclassified',
] as const;

export const ENRICHMENT_CYCLE_STAGES = [
  'none',
  'selection',
  'segment',
  'message_state',
  'ledger',
] as const;

export type EnrichmentCycleReceiptStatus =
  (typeof ENRICHMENT_CYCLE_RECEIPT_STATUSES)[number];
export type EnrichmentCycleFailureCode =
  (typeof ENRICHMENT_CYCLE_FAILURE_CODES)[number];
export type EnrichmentCycleStage =
  (typeof ENRICHMENT_CYCLE_STAGES)[number];
export type EnrichmentCycleEvidenceCoverage = 'typed' | 'legacy_unclassified';
export type EnrichmentCycleSource = 'online' | 'legacy';

export interface EnrichmentCycleReceipt {
  source: EnrichmentCycleSource;
  status: EnrichmentCycleReceiptStatus;
  failureCode: EnrichmentCycleFailureCode;
  stage: EnrichmentCycleStage;
  retryable: boolean;
  evidenceCoverage: EnrichmentCycleEvidenceCoverage;
  startedAt: string;
  completedAt: string | null;
  successAt: string | null;
  messagesSelected: number;
  messagesSucceeded: number;
  messagesDeferred: number;
  messagesTerminal: number;
  factsExtracted: number;
  factsQueued: number;
}

type ReceiptRow = {
  schema_version: unknown;
  source: unknown;
  status: unknown;
  failure_code: unknown;
  stage: unknown;
  retryable: unknown;
  evidence_coverage: unknown;
  started_at: unknown;
  completed_at: unknown;
  success_at: unknown;
  messages_selected: unknown;
  messages_succeeded: unknown;
  messages_deferred: unknown;
  messages_terminal: unknown;
  facts_extracted: unknown;
  facts_queued: unknown;
};

export type OnlineEnrichmentCycleLedger =
  | { state: 'absent' }
  | {
      state: 'available';
      receipt: EnrichmentCycleReceipt;
      lastSuccessfulAt: string | null;
    }
  | { state: 'invalid' };

function isKnownValue<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === 'string' && values.includes(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function toOnlineReceipt(row: ReceiptRow): EnrichmentCycleReceipt | null {
  const startedAt = row.started_at;
  const completedAt = row.completed_at;
  const successAt = row.success_at;
  if (
    row.schema_version !== ENRICHMENT_CYCLE_RECEIPT_SCHEMA_VERSION
    || row.source !== 'online'
    || row.evidence_coverage !== 'typed'
    || !isKnownValue(ENRICHMENT_CYCLE_RECEIPT_STATUSES, row.status)
    || !isKnownValue(ENRICHMENT_CYCLE_FAILURE_CODES, row.failure_code)
    || !isKnownValue(ENRICHMENT_CYCLE_STAGES, row.stage)
    || (row.retryable !== 0 && row.retryable !== 1)
    || !isTimestamp(startedAt)
    || !isTimestamp(completedAt)
    || (successAt !== null && !isTimestamp(successAt))
    || !isNonNegativeInteger(row.messages_selected)
    || !isNonNegativeInteger(row.messages_succeeded)
    || !isNonNegativeInteger(row.messages_deferred)
    || !isNonNegativeInteger(row.messages_terminal)
    || !isNonNegativeInteger(row.facts_extracted)
    || !isNonNegativeInteger(row.facts_queued)
  ) {
    return null;
  }

  if (
    Date.parse(completedAt) < Date.parse(startedAt)
    || (successAt !== null && (
      Date.parse(successAt) < Date.parse(startedAt)
      || Date.parse(successAt) > Date.parse(completedAt)
    ))
    || row.messages_succeeded + row.messages_deferred + row.messages_terminal !== row.messages_selected
    || row.facts_queued > row.facts_extracted
  ) {
    return null;
  }

  if (row.status === 'no_work') {
    if (row.failure_code !== 'none' || row.stage !== 'none' || row.retryable !== 0 || row.success_at === null) {
      return null;
    }
    if (
      row.messages_selected !== 0
      || row.messages_succeeded !== 0
      || row.messages_deferred !== 0
      || row.messages_terminal !== 0
      || row.facts_extracted !== 0
      || row.facts_queued !== 0
    ) {
      return null;
    }
  } else if (row.status === 'completed') {
    if (
      row.failure_code !== 'none'
      || row.stage !== 'none'
      || row.retryable !== 0
      || successAt === null
      || row.messages_deferred !== 0
      || row.messages_terminal !== 0
    ) {
      return null;
    }
  } else if (row.status !== 'legacy_unclassified') {
    if (row.failure_code === 'none' || row.stage === 'none' || successAt !== null) {
      return null;
    }
  } else {
    return null;
  }

  return {
    source: 'online',
    status: row.status,
    failureCode: row.failure_code,
    stage: row.stage,
    retryable: row.retryable === 1,
    evidenceCoverage: 'typed',
    startedAt,
    completedAt,
    successAt,
    messagesSelected: row.messages_selected,
    messagesSucceeded: row.messages_succeeded,
    messagesDeferred: row.messages_deferred,
    messagesTerminal: row.messages_terminal,
    factsExtracted: row.facts_extracted,
    factsQueued: row.facts_queued,
  };
}

export function writeEnrichmentCycleReceipt(
  db: Database,
  receipt: EnrichmentCycleReceipt,
): void {
  db.raw.prepare(`
    INSERT INTO enrichment_runs (
      schema_version,
      source,
      status,
      failure_code,
      stage,
      retryable,
      evidence_coverage,
      started_at,
      completed_at,
      success_at,
      messages_processed,
      facts_extracted,
      facts_upserted,
      messages_selected,
      messages_succeeded,
      messages_deferred,
      messages_terminal,
      facts_queued,
      error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    ENRICHMENT_CYCLE_RECEIPT_SCHEMA_VERSION,
    receipt.source,
    receipt.status,
    receipt.failureCode,
    receipt.stage,
    receipt.retryable ? 1 : 0,
    receipt.evidenceCoverage,
    receipt.startedAt,
    receipt.completedAt,
    receipt.successAt,
    receipt.messagesSucceeded + receipt.messagesTerminal,
    receipt.factsExtracted,
    receipt.factsQueued,
    receipt.messagesSelected,
    receipt.messagesSucceeded,
    receipt.messagesDeferred,
    receipt.messagesTerminal,
    receipt.factsQueued,
  );
}

export function readOnlineEnrichmentCycleLedger(db: Database): OnlineEnrichmentCycleLedger {
  const row = db.raw.prepare(`
    SELECT
      schema_version,
      source,
      status,
      failure_code,
      stage,
      retryable,
      evidence_coverage,
      started_at,
      completed_at,
      success_at,
      messages_selected,
      messages_succeeded,
      messages_deferred,
      messages_terminal,
      facts_extracted,
      facts_queued
    FROM enrichment_runs
    WHERE source = 'online'
    ORDER BY run_id DESC
    LIMIT 1
  `).get() as ReceiptRow | undefined;

  if (!row) return { state: 'absent' };

  const receipt = toOnlineReceipt(row);
  if (!receipt) return { state: 'invalid' };

  const lastSuccessRow = db.raw.prepare(`
    SELECT
      schema_version,
      source,
      status,
      failure_code,
      stage,
      retryable,
      evidence_coverage,
      started_at,
      completed_at,
      success_at,
      messages_selected,
      messages_succeeded,
      messages_deferred,
      messages_terminal,
      facts_extracted,
      facts_queued
    FROM enrichment_runs
    WHERE source = 'online' AND success_at IS NOT NULL
    ORDER BY run_id DESC
    LIMIT 1
  `).get() as ReceiptRow | undefined;
  let lastSuccessfulAt: string | null = null;
  if (lastSuccessRow) {
    const lastSuccessReceipt = toOnlineReceipt(lastSuccessRow);
    if (
      !lastSuccessReceipt
      || (lastSuccessReceipt.status !== 'no_work' && lastSuccessReceipt.status !== 'completed')
      || lastSuccessReceipt.successAt === null
    ) {
      return { state: 'invalid' };
    }
    lastSuccessfulAt = lastSuccessReceipt.successAt;
  }

  return {
    state: 'available',
    receipt,
    lastSuccessfulAt,
  };
}

export function readLatestEnrichmentCycleReceipt(db: Database): EnrichmentCycleReceipt | null {
  const ledger = readOnlineEnrichmentCycleLedger(db);
  return ledger.state === 'available' ? ledger.receipt : null;
}
