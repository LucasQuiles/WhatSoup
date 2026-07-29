import { createChildLogger } from '../logger.ts';
import type { LLMProvider } from '../runtimes/chat/providers/types.ts';
import {
  runConsolidation,
  type ConsolidationPinecone,
} from './consolidation-cron.ts';
import {
  CONSOLIDATION_RUN_SCHEMA_VERSION,
  emptyConsolidationCounters,
  type ConsolidationCounters,
  type ConsolidationRunReport,
} from '../core/memory-consolidation-contract.ts';
import {
  type ConsolidationRunHandle,
  type ConsolidationRunSource,
  ConsolidationRunStore,
} from './consolidation-run-store.ts';

const log = createChildLogger('memory:consolidation-scheduler');

export interface MemoryConsolidationSchedulerConfig {
  intervalMs: number;
  lookbackDays: number;
  dryRun: boolean;
  totalRunTimeoutMs?: number;
}

interface ActiveRun {
  handle: ConsolidationRunHandle;
  controller: AbortController;
  deadlineTimedOut: boolean;
  startedAtMs: number;
  deadlineAtMs: number;
  stage: ConsolidationRunReport['stage'];
  counters: ConsolidationCounters;
  promise: Promise<ConsolidationRunReport>;
}

const DEFAULT_TOTAL_RUN_TIMEOUT_MS = 5 * 60_000;

function asIso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

export class MemoryConsolidationScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = true;
  private activeRun: ActiveRun | null = null;
  private readonly pinecone: ConsolidationPinecone;
  private readonly provider: LLMProvider;
  private readonly config: MemoryConsolidationSchedulerConfig;
  private readonly store: ConsolidationRunStore;

  constructor(
    pinecone: ConsolidationPinecone,
    provider: LLMProvider,
    config: MemoryConsolidationSchedulerConfig,
    store: ConsolidationRunStore,
  ) {
    this.pinecone = pinecone;
    this.provider = provider;
    this.config = config;
    this.store = store;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.store.abandonInterruptedRuns(Date.now());
    this.runScheduled('scheduler_immediate');
    this.timer = setInterval(() => {
      this.runScheduled('scheduler_periodic');
    }, this.config.intervalMs);
    this.timer.unref?.();
  }

  async stop(timeoutMs = 5_000): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    const active = this.activeRun;
    if (!active) return;

    const nowMs = Date.now();
    try {
      this.store.requestCancellation(active.handle, nowMs);
    } catch {
      log.error({
        failureCode: 'observation_failed',
        stage: 'finalize',
      }, 'memory consolidation: cancellation receipt update failed');
    }
    active.controller.abort(new DOMException('scheduler stopped', 'AbortError'));

    let timeout: ReturnType<typeof setTimeout> | null = null;
    const drained = Symbol('drained');
    const timedOut = Symbol('timedOut');
    const result = await Promise.race([
      active.promise.then(() => drained),
      new Promise<typeof timedOut>((resolve) => {
        timeout = setTimeout(() => resolve(timedOut), timeoutMs);
        timeout.unref?.();
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });

    if (result === timedOut) {
      try {
        this.store.finalizeRun(active.handle, {
          status: 'abandoned',
          stage: 'finalize',
          failureCode: 'cancelled',
          retryable: true,
          evidenceCoverage: 'local_guard',
          counters: active.counters,
          nowMs: Date.now(),
        });
      } catch {
        log.error({
          failureCode: 'observation_failed',
          stage: 'finalize',
        }, 'memory consolidation: abandoned receipt update failed');
      }
      if (this.activeRun === active) this.activeRun = null;
      log.warn({
        timeoutMs,
        failureCode: 'cancelled',
      }, 'memory consolidation: active run fenced after stop timeout');
    }
  }

  async runOnce(
    source: ConsolidationRunSource = 'manual',
  ): Promise<ConsolidationRunReport> {
    const active = this.activeRun;
    if (active) {
      const nowMs = Date.now();
      this.store.recordSkippedTick(active.handle, nowMs);
      const counters = emptyConsolidationCounters();
      counters.skipped = 1;
      return {
        schemaVersion: CONSOLIDATION_RUN_SCHEMA_VERSION,
        runId: active.handle.runId,
        mode: this.config.dryRun ? 'dry_run' : 'live',
        status: 'skipped',
        stage: 'scheduled',
        failureCode: 'already_running',
        retryable: true,
        evidenceCoverage: 'local_guard',
        attemptedAt: asIso(nowMs),
        completedAt: asIso(nowMs),
        successAt: null,
        durationMs: 0,
        counters,
      };
    }

    const startedAtMs = Date.now();
    const totalRunTimeoutMs =
      this.config.totalRunTimeoutMs ?? DEFAULT_TOTAL_RUN_TIMEOUT_MS;
    const handle = this.store.beginRun({
      source,
      mode: this.config.dryRun ? 'dry_run' : 'live',
      nowMs: startedAtMs,
      leaseExpiresAtMs: startedAtMs + totalRunTimeoutMs,
    });
    const next: ActiveRun = {
      handle,
      controller: new AbortController(),
      deadlineTimedOut: false,
      startedAtMs,
      deadlineAtMs: startedAtMs + totalRunTimeoutMs,
      stage: 'scheduled',
      counters: emptyConsolidationCounters(),
      promise: Promise.resolve(undefined as never),
    };
    this.activeRun = next;
    next.promise = this.executeRun(next, totalRunTimeoutMs);
    return next.promise;
  }

  private async executeRun(
    active: ActiveRun,
    totalRunTimeoutMs: number,
  ): Promise<ConsolidationRunReport> {
    const timedOut = Symbol('timedOut');
    let deadline: ReturnType<typeof setTimeout> | null = null;
    const deadlineResult = new Promise<typeof timedOut>((resolve) => {
      deadline = setTimeout(() => {
        active.deadlineTimedOut = true;
        active.controller.abort(
          new DOMException('run deadline exceeded', 'TimeoutError'),
        );
        if (this.activeRun === active) this.activeRun = null;
        resolve(timedOut);
      }, totalRunTimeoutMs);
      deadline.unref?.();
    });
    const rawRun = runConsolidation(this.pinecone, this.provider, {
      lookbackDays: this.config.lookbackDays,
      dryRun: this.config.dryRun,
      runId: active.handle.runId,
      signal: active.controller.signal,
      isWriteAllowed: () =>
        this.activeRun === active && !active.controller.signal.aborted,
      onProgress: (stage, counters, evidenceCoverage) => {
        const nowMs = Date.now();
        const owned = this.store.recordProgress(active.handle, {
          stage,
          evidenceCoverage,
          counters: { ...counters },
          nowMs,
          leaseExpiresAtMs: active.deadlineAtMs,
        });
        if (owned) {
          active.stage = stage;
          active.counters = { ...counters };
        }
        if (!owned && !active.controller.signal.aborted) {
          active.controller.abort(
            new DOMException('execution lease lost', 'AbortError'),
          );
        }
        return owned;
      },
    }).then(
      (report) => ({ kind: 'report' as const, report }),
      () => ({ kind: 'error' as const }),
    );

    const result = await Promise.race([rawRun, deadlineResult]);
    if (deadline) {
      clearTimeout(deadline);
      deadline = null;
    }

    let report: ConsolidationRunReport;
    if (result === timedOut) {
      const nowMs = Date.now();
      const counters = {
        ...active.counters,
        failed: active.counters.failed + 1,
      };
      report = {
        schemaVersion: CONSOLIDATION_RUN_SCHEMA_VERSION,
        runId: active.handle.runId,
        mode: this.config.dryRun ? 'dry_run' : 'live',
        status: 'failed',
        stage: active.stage,
        failureCode: 'timeout',
        retryable: true,
        evidenceCoverage: 'local_guard',
        attemptedAt: asIso(active.startedAtMs),
        completedAt: asIso(nowMs),
        successAt: null,
        durationMs: Math.max(0, nowMs - active.startedAtMs),
        counters,
      };
    } else if (result.kind === 'report') {
      report = result.report;
    } else {
      const nowMs = Date.now();
      const counters = {
        ...active.counters,
        failed: active.counters.failed + 1,
      };
      report = {
        schemaVersion: CONSOLIDATION_RUN_SCHEMA_VERSION,
        runId: active.handle.runId,
        mode: this.config.dryRun ? 'dry_run' : 'live',
        status: 'failed',
        stage: active.stage,
        failureCode: 'unknown',
        retryable: true,
        evidenceCoverage: 'provider_error',
        attemptedAt: asIso(active.startedAtMs),
        completedAt: asIso(nowMs),
        successAt: null,
        durationMs: Math.max(0, nowMs - active.startedAtMs),
        counters,
      };
    }

    if (report.status === 'cancelled') {
      const deadlineExpired = active.deadlineTimedOut;
      report = {
        ...report,
        status: deadlineExpired ? 'failed' : 'cancelled',
        failureCode: deadlineExpired ? 'timeout' : 'cancelled',
        retryable: true,
      };
    }
    active.counters = { ...report.counters };

    try {
      const finalized = this.store.finalizeRun(active.handle, {
        status: report.status === 'skipped' ? 'failed' : report.status,
        stage: report.stage,
        failureCode: report.failureCode,
        retryable: report.retryable,
        evidenceCoverage: report.evidenceCoverage,
        counters: report.counters,
        nowMs: Date.parse(report.completedAt),
      });
      if (
        !finalized
        && (report.status === 'completed' || report.status === 'no_work')
      ) {
        report = {
          ...report,
          status: 'failed',
          stage: 'finalize',
          failureCode: 'observation_failed',
          retryable: true,
          successAt: null,
        };
      }
    } catch {
      report = {
        ...report,
        status: 'failed',
        stage: 'finalize',
        failureCode: 'observation_failed',
        retryable: true,
        successAt: null,
      };
    }
    if (this.activeRun === active) this.activeRun = null;

    const logFields = {
      schemaVersion: report.schemaVersion,
      runId: report.runId,
      mode: report.mode,
      status: report.status,
      stage: report.stage,
      failureCode: report.failureCode,
      retryable: report.retryable,
      evidenceCoverage: report.evidenceCoverage,
      durationMs: report.durationMs,
      counters: report.counters,
    };
    if (report.status === 'completed') {
      log.info(logFields, 'memory consolidation: completed');
    } else if (report.status === 'no_work') {
      log.info(logFields, 'memory consolidation: no work');
    } else if (report.status === 'failed') {
      log.error(logFields, 'memory consolidation: failed');
    } else {
      log.warn(logFields, `memory consolidation: ${report.status}`);
    }
    return report;
  }

  private runScheduled(
    source: 'scheduler_immediate' | 'scheduler_periodic',
  ): void {
    if (this.stopped) return;
    void this.runOnce(source).catch(() => {
      log.error({
        failureCode: 'observation_failed',
        stage: 'scheduled',
      }, 'memory consolidation: scheduled run could not start');
    });
  }
}
