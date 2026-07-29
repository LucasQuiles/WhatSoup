import { shortHash } from '../lib/short-hash.ts';
import {
  classifyMemoryOperationFailure,
  type MemoryEvidenceCoverage,
  type MemoryOperationFailureCode,
} from '../lib/memory-operation-telemetry.ts';
import { createChildLogger } from '../logger.ts';
import type {
  MemoryRecord,
  PineconeSearchDetails,
} from '../runtimes/chat/providers/pinecone.ts';
import type { LLMProvider } from '../runtimes/chat/providers/types.ts';
import { clusterMemories, consolidateCluster } from './consolidation.ts';
import type { ClusterExecutionOutcome } from './types.ts';
import {
  CONSOLIDATION_RUN_SCHEMA_VERSION,
  emptyConsolidationCounters,
  type ConsolidationCounters,
  type ConsolidationFailureCode,
  type ConsolidationRunReport,
  type ConsolidationRunStage,
  type ConsolidationRunStatus,
} from '../core/memory-consolidation-contract.ts';

const log = createChildLogger('consolidation-cron');

export interface ConsolidationOptions {
  lookbackDays: number;
  dryRun: boolean;
  runId?: string;
  signal?: AbortSignal;
  traceId?: string;
  isWriteAllowed?: () => boolean;
  onProgress?: (
    stage: ConsolidationRunStage,
    counters: Readonly<ConsolidationCounters>,
    evidenceCoverage: MemoryEvidenceCoverage,
  ) => boolean | void;
  now?: () => number;
}

export interface ConsolidationPinecone {
  searchDetailed(
    query: string,
    filters: Record<string, unknown>,
    topK: number,
    traceId?: string,
    signal?: AbortSignal,
  ): Promise<PineconeSearchDetails>;
  upsert(
    records: MemoryRecord[],
    context?: {
      operationId?: string;
      traceId?: string;
      operation?: 'upsert' | 'memory_write';
      signal?: AbortSignal;
    },
  ): Promise<void>;
}

function scopeKey(chatJid: string, senderJid: string): string {
  return `${chatJid}\0${senderJid}`;
}

function searchEvidence(details: PineconeSearchDetails): MemoryEvidenceCoverage {
  if (details.status === 'ok') return 'provider_response';
  if (details.status === 'breaker_open' || details.status === 'project_guard_failed') {
    return 'local_guard';
  }
  return 'provider_error';
}

function searchFailureCode(details: PineconeSearchDetails): MemoryOperationFailureCode {
  if (details.failureCode) return details.failureCode;
  if (details.status === 'breaker_open') return 'breaker_open';
  if (details.status === 'project_guard_failed') return 'project_guard_failed';
  return 'provider_unavailable';
}

function safeDuration(startedAtMs: number, completedAtMs: number): number {
  return Math.max(0, completedAtMs - startedAtMs);
}

export async function runConsolidation(
  pinecone: ConsolidationPinecone,
  provider: LLMProvider,
  options: ConsolidationOptions,
): Promise<ConsolidationRunReport> {
  const now = options.now ?? Date.now;
  const startedAtMs = now();
  const attemptedAt = new Date(startedAtMs).toISOString();
  const counters = emptyConsolidationCounters();
  const mode = options.dryRun ? 'dry_run' as const : 'live' as const;
  let stage: ConsolidationRunStage = 'scheduled';
  let failureStage: ConsolidationRunStage | null = null;
  let failureCode: ConsolidationFailureCode = 'none';
  let retryable = false;
  let evidenceCoverage: MemoryEvidenceCoverage = 'not_observed';

  const progress = (
    nextStage: ConsolidationRunStage,
    coverage: MemoryEvidenceCoverage,
    nextCounters: Readonly<ConsolidationCounters> = counters,
  ): boolean => {
    stage = nextStage;
    evidenceCoverage = coverage;
    const owned =
      options.onProgress?.(stage, { ...nextCounters }, evidenceCoverage) !== false;
    return owned && !isCancelled();
  };

  const finish = (status: ConsolidationRunStatus): ConsolidationRunReport => {
    const completedAtMs = now();
    const terminalStage =
      status === 'failed' || status === 'partial'
        ? failureStage ?? stage
        : stage;
    return {
      schemaVersion: CONSOLIDATION_RUN_SCHEMA_VERSION,
      runId: options.runId ?? 'untracked',
      mode,
      status,
      stage: terminalStage,
      failureCode,
      retryable,
      evidenceCoverage,
      attemptedAt,
      completedAt: new Date(completedAtMs).toISOString(),
      successAt:
        status === 'completed' || status === 'no_work'
          ? new Date(completedAtMs).toISOString()
          : null,
      durationMs: safeDuration(startedAtMs, completedAtMs),
      counters: { ...counters },
    };
  };

  const isCancelled = (): boolean =>
    options.signal?.aborted === true
    || options.isWriteAllowed?.() === false;

  if (isCancelled()) {
    stage = 'scheduled';
    failureCode = 'cancelled';
    retryable = true;
    evidenceCoverage = 'local_guard';
    counters.failed = 1;
    return finish('cancelled');
  }

  progress('search', 'not_observed');
  let search: PineconeSearchDetails;
  try {
    search = await pinecone.searchDetailed(
      'facts about people preferences locations interests',
      {},
      100,
      options.traceId,
      options.signal,
    );
  } catch (error) {
    const failure = classifyMemoryOperationFailure(error);
    failureStage = 'search';
    failureCode = failure.code;
    retryable = failure.retryable;
    evidenceCoverage = 'provider_error';
    counters.failed = 1;
    return finish(isCancelled() ? 'cancelled' : 'failed');
  }

  evidenceCoverage = searchEvidence(search);
  if (isCancelled()) {
    failureCode = 'cancelled';
    retryable = true;
    evidenceCoverage = 'local_guard';
    counters.failed = 1;
    return finish('cancelled');
  }
  if (search.status !== 'ok') {
    failureStage = 'search';
    failureCode = searchFailureCode(search);
    retryable = search.retryable ?? true;
    counters.failed = 1;
    return finish('failed');
  }

  const cutoffMs = startedAtMs - options.lookbackDays * 86_400_000;
  const recentMemories = search.results.filter((result) => {
    const createdMs = new Date(result.record.createdAt).getTime();
    return Number.isFinite(createdMs) && createdMs >= cutoffMs;
  });
  counters.recordsObserved = recentMemories.length;

  if (recentMemories.length === 0) {
    progress('finalize', 'provider_response');
    return finish('no_work');
  }

  const records = recentMemories.map((result) => ({
    id: result.id,
    text: result.record.text,
    claim: result.record.claim ?? '',
    evidence: result.record.evidence ?? '',
    createdAt: result.record.createdAt,
    confidence: result.record.confidence,
    chatJid: result.record.chatJid ?? '',
    senderJid: result.record.senderJid ?? '',
  }));

  const scopedRecords = new Map<string, {
    chatJid: string;
    senderJid: string;
    records: typeof records;
  }>();
  for (const record of records) {
    if (!record.chatJid || !record.senderJid) {
      counters.skipped += 1;
      continue;
    }
    const key = scopeKey(record.chatJid, record.senderJid);
    const group = scopedRecords.get(key) ?? {
      chatJid: record.chatJid,
      senderJid: record.senderJid,
      records: [],
    };
    group.records.push(record);
    scopedRecords.set(key, group);
  }

  if (scopedRecords.size === 0) {
    log.info({
      recordCount: records.length,
      unscopedSkipped: counters.skipped,
    }, 'No scoped memories to consolidate');
    progress('finalize', 'provider_response');
    return finish('no_work');
  }

  for (const group of scopedRecords.values()) {
    progress('cluster', 'provider_response');
    const clusters = clusterMemories(group.records);
    log.info({
      clusterCount: clusters.length,
      recordCount: group.records.length,
      unscopedSkipped: counters.skipped,
    }, 'Clustered memories');

    for (const cluster of clusters) {
      counters.clustersAttempted += 1;
      progress('generate', 'provider_response');
      const outcome = await consolidateCluster(provider, cluster, {
        signal: options.signal,
      });
      evidenceCoverage = outcome.evidenceCoverage;

      if (outcome.status === 'cancelled' || isCancelled()) {
        stage = outcome.status === 'cancelled' ? 'generate' : 'write';
        failureCode = 'cancelled';
        retryable = true;
        counters.failed += 1;
        return finish('cancelled');
      }

      if (
        outcome.status === 'provider_unavailable'
        || outcome.status === 'provider_timeout'
        || outcome.status === 'output_invalid'
        || outcome.status === 'scope_invalid'
      ) {
        stage = outcome.status === 'output_invalid' ? 'validate' : 'generate';
        failureStage = stage;
        failureCode = outcome.status === 'output_invalid'
          ? 'output_invalid'
          : outcome.status === 'scope_invalid'
            ? 'scope_invalid'
            : outcome.failureCode;
        retryable = outcome.retryable;
        counters.failed += 1;
        continue;
      }

      counters.discarded += outcome.discarded.length;
      if (outcome.durableKnowledge.length === 0) {
        counters.clustersCompleted += 1;
        continue;
      }

      if (options.dryRun) {
        counters.wouldPromote += outcome.durableKnowledge.length;
        counters.clustersCompleted += 1;
        log.info({
          dryRun: true,
          durableCount: outcome.durableKnowledge.length,
        }, 'Would promote');
        continue;
      }

      let clusterWriteFailed = false;
      for (const durable of outcome.durableKnowledge) {
        if (isCancelled()) {
          failureCode = 'cancelled';
          retryable = true;
          counters.failed += 1;
          return finish('cancelled');
        }

        const recordNow = new Date(now()).toISOString();
        const attemptedCounters = {
          ...counters,
          writeAttempted: counters.writeAttempted + 1,
        };
        if (!progress('write', outcome.evidenceCoverage, attemptedCounters)) {
          failureCode = 'cancelled';
          retryable = true;
          evidenceCoverage = 'local_guard';
          counters.failed += 1;
          return finish('cancelled');
        }
        counters.writeAttempted += 1;
        try {
          await pinecone.upsert([{
            id: `durable:${shortHash(scopeKey(group.chatJid, group.senderJid) + `\0${durable.claim}`, 16)}`,
            text: durable.claim,
            chatJid: group.chatJid,
            senderJid: group.senderJid,
            senderName: '',
            memoryType: 'user_fact',
            confidence: durable.confidence,
            createdAt: recordNow,
            updatedAt: recordNow,
            superseded: '',
            sourceMessagePks: '',
            promotionReason: durable.promotionReason,
            claim: durable.claim,
            evidence: durable.sourceRecordIds.join(', '),
            warrant: durable.promotionReason,
            confidenceQualifier: 'consolidated',
            contradicts: '',
          }], {
            operation: 'memory_write',
            traceId: options.traceId,
            signal: options.signal,
          });
          if (isCancelled()) {
            failureCode = 'cancelled';
            retryable = true;
            evidenceCoverage = 'local_guard';
            counters.failed += 1;
            return finish('cancelled');
          }
          counters.writeConfirmed += 1;
        } catch (error) {
          if (isCancelled()) {
            failureCode = 'cancelled';
            retryable = true;
            evidenceCoverage = 'local_guard';
            counters.failed += 1;
            return finish('cancelled');
          }
          const failure = classifyMemoryOperationFailure(error);
          const writeOutcome: ClusterExecutionOutcome = {
            ...outcome,
            status: 'write_failed',
            failureCode: 'write_failed',
            retryable: failure.retryable,
            evidenceCoverage: 'provider_error',
          };
          failureCode = writeOutcome.failureCode;
          failureStage = 'write';
          retryable = writeOutcome.retryable;
          evidenceCoverage = writeOutcome.evidenceCoverage;
          counters.failed += 1;
          clusterWriteFailed = true;
          log.warn({
            failureCode,
            providerFailureCode: failure.code,
            retryable,
            recordCount: cluster.records.length,
            evidenceCoverage,
          }, 'Cluster consolidation write failed');
        }
      }
      if (!clusterWriteFailed) counters.clustersCompleted += 1;
    }
  }

  progress('finalize', evidenceCoverage);
  const status: ConsolidationRunStatus = counters.failed === 0
    ? 'completed'
    : counters.clustersCompleted > 0
      ? 'partial'
      : 'failed';
  log.info({
    schemaVersion: CONSOLIDATION_RUN_SCHEMA_VERSION,
    mode,
    status,
    failureCode,
    retryable,
    evidenceCoverage,
    counters,
  }, 'Consolidation run finished');
  return finish(status);
}
