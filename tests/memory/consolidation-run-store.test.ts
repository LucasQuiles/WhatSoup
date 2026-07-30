import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/core/database.ts';
import {
  ConsolidationRunStore,
  type ConsolidationRunHandle,
} from '../../src/memory/consolidation-run-store.ts';
import { emptyConsolidationCounters } from '../../src/core/memory-consolidation-contract.ts';

describe('ConsolidationRunStore', () => {
  let db: Database;
  let store: ConsolidationRunStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    store = new ConsolidationRunStore(db);
  });

  afterEach(() => db.close());

  function begin(nowMs = 1_000): ConsolidationRunHandle {
    return store.beginRun({
      source: 'manual',
      mode: 'live',
      nowMs,
      leaseExpiresAtMs: nowMs + 5_000,
    });
  }

  it('uses exact-owner CAS for progress and one terminal finalization', () => {
    const handle = begin();
    const counters = {
      ...emptyConsolidationCounters(),
      recordsObserved: 3,
      clustersAttempted: 1,
    };
    expect(store.recordProgress(handle, {
      stage: 'generate',
      evidenceCoverage: 'provider_response',
      counters,
      nowMs: 2_000,
      leaseExpiresAtMs: 7_000,
    })).toBe(true);

    const wrong = { runId: 'f'.repeat(32) };
    expect(store.finalizeRun(wrong, {
      status: 'completed',
      stage: 'finalize',
      failureCode: 'none',
      retryable: false,
      evidenceCoverage: 'provider_response',
      counters,
      nowMs: 3_000,
    })).toBe(false);
    expect(store.finalizeRun(handle, {
      status: 'completed',
      stage: 'finalize',
      failureCode: 'none',
      retryable: false,
      evidenceCoverage: 'provider_response',
      counters,
      nowMs: 3_000,
    })).toBe(true);
    expect(store.finalizeRun(handle, {
      status: 'failed',
      stage: 'finalize',
      failureCode: 'unknown',
      retryable: true,
      evidenceCoverage: 'provider_error',
      counters,
      nowMs: 4_000,
    })).toBe(false);

    const row = db.raw.prepare(`
      SELECT status, success_at, records_observed, clusters_attempted
      FROM memory_consolidation_runs WHERE run_id = ?
    `).get(handle.runId);
    expect(row).toEqual({
      status: 'completed',
      success_at: 3_000,
      records_observed: 3,
      clusters_attempted: 1,
    });
  });

  it('records skipped ticks without renewing progress or the lease', () => {
    const handle = begin();
    expect(store.recordProgress(handle, {
      stage: 'search',
      evidenceCoverage: 'provider_response',
      counters: emptyConsolidationCounters(),
      nowMs: 4_000,
      leaseExpiresAtMs: 10_000,
    })).toBe(true);
    expect(store.recordSkippedTick(handle, 5_000)).toBe(true);
    expect(store.readHealth({
      enabled: true,
      started: true,
      nowMs: 5_001,
      stalledAfterMs: 5_000,
    })).toMatchObject({
      state: 'current',
      failure_code: 'already_running',
      skipped_ticks: 1,
    });
    expect(store.recordSkippedTick(handle, 6_000)).toBe(true);

    expect(db.raw.prepare(`
      SELECT failure_code, retryable, skipped, overlap_skipped, last_skipped_at,
             last_progress_at, lease_expires_at
      FROM memory_consolidation_runs WHERE run_id = ?
    `).get(handle.runId)).toEqual({
      failure_code: 'already_running',
      retryable: 1,
      skipped: 0,
      overlap_skipped: 2,
      last_skipped_at: 6_000,
      last_progress_at: 4_000,
      lease_expires_at: 10_000,
    });
    expect(store.readHealth({
      enabled: true,
      started: true,
      nowMs: 6_001,
      stalledAfterMs: 5_000,
    })).toMatchObject({
      state: 'stalled',
      failure_code: 'already_running',
      skipped_ticks: 2,
      active_age_ms: 5_001,
    });
  });

  it('rehydrates interrupted running and cancelling rows as abandoned', () => {
    const running = begin(1_000);
    const cancelling = begin(2_000);
    expect(store.requestCancellation(cancelling, 2_500)).toBe(true);

    expect(store.abandonInterruptedRuns(9_000)).toBe(2);
    const rows = db.raw.prepare(`
      SELECT run_id, status, failure_code, completed_at
      FROM memory_consolidation_runs ORDER BY attempted_at
    `).all();
    expect(rows).toEqual([
      {
        run_id: running.runId,
        status: 'abandoned',
        failure_code: 'restart_abandoned',
        completed_at: 9_000,
      },
      {
        run_id: cancelling.runId,
        status: 'abandoned',
        failure_code: 'restart_abandoned',
        completed_at: 9_000,
      },
    ]);
  });

  it('reports stalled, failure-latched, recovered, disabled, and unreadable health', () => {
    const handle = begin(1_000);
    expect(store.readHealth({
      enabled: true,
      started: true,
      nowMs: 7_000,
      stalledAfterMs: 5_000,
    }).state).toBe('stalled');

    const counters = emptyConsolidationCounters();
    expect(store.finalizeRun(handle, {
      status: 'failed',
      stage: 'search',
      failureCode: 'network_error',
      retryable: true,
      evidenceCoverage: 'provider_error',
      counters: { ...counters, failed: 1 },
      nowMs: 8_000,
    })).toBe(true);
    expect(store.readHealth({
      enabled: true,
      started: true,
      nowMs: 8_001,
      stalledAfterMs: 5_000,
    })).toMatchObject({
      state: 'failed',
      failure_code: 'network_error',
      retryable: true,
    });

    const recovered = store.beginRun({
      source: 'manual',
      mode: 'dry_run',
      nowMs: 9_000,
      leaseExpiresAtMs: 14_000,
    });
    expect(store.readHealth({
      enabled: true,
      started: true,
      nowMs: 9_001,
      stalledAfterMs: 5_000,
    })).toMatchObject({
      state: 'failed',
      latest_status: 'running',
      failure_code: 'network_error',
    });
    expect(store.finalizeRun(recovered, {
      status: 'no_work',
      stage: 'finalize',
      failureCode: 'none',
      retryable: false,
      evidenceCoverage: 'provider_response',
      counters,
      nowMs: 10_000,
    })).toBe(true);
    expect(store.readHealth({
      enabled: true,
      started: true,
      nowMs: 10_001,
      stalledAfterMs: 5_000,
    }).state).toBe('no_work');

    expect(store.readHealth({
      enabled: false,
      started: false,
      nowMs: 10_001,
      stalledAfterMs: 5_000,
    }).state).toBe('disabled');

    db.raw.exec('DROP TABLE memory_consolidation_runs');
    expect(store.readHealth({
      enabled: true,
      started: true,
      nowMs: 10_001,
      stalledAfterMs: 5_000,
    })).toMatchObject({
      readable: false,
      state: 'unreadable',
      failure_code: 'observation_failed',
    });
  });

  it('latches a failure that starts in the same millisecond as the prior success', () => {
    const successful = begin(500);
    expect(store.finalizeRun(successful, {
      status: 'completed',
      stage: 'finalize',
      failureCode: 'none',
      retryable: false,
      evidenceCoverage: 'provider_response',
      counters: emptyConsolidationCounters(),
      nowMs: 1_000,
    })).toBe(true);

    const failed = begin(1_000);
    expect(store.finalizeRun(failed, {
      status: 'failed',
      stage: 'search',
      failureCode: 'network_error',
      retryable: true,
      evidenceCoverage: 'provider_error',
      counters: { ...emptyConsolidationCounters(), failed: 1 },
      nowMs: 1_100,
    })).toBe(true);
    begin(1_200);

    expect(store.readHealth({
      enabled: true,
      started: true,
      nowMs: 1_201,
      stalledAfterMs: 5_000,
    })).toMatchObject({
      state: 'failed',
      latest_status: 'running',
      failure_code: 'network_error',
    });
  });

  it('rehydrates failure and abandoned evidence after closing and reopening the database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'whatsoup-consolidation-runs-'));
    const databaseFile = join(directory, 'runs.db');
    try {
      const first = new Database(databaseFile);
      first.open();
      const firstStore = new ConsolidationRunStore(first);
      const failed = firstStore.beginRun({
        source: 'manual',
        mode: 'live',
        nowMs: 1_000,
        leaseExpiresAtMs: 2_000,
      });
      firstStore.finalizeRun(failed, {
        status: 'failed',
        stage: 'search',
        failureCode: 'network_error',
        retryable: true,
        evidenceCoverage: 'provider_error',
        counters: { ...emptyConsolidationCounters(), failed: 1 },
        nowMs: 1_500,
      });
      firstStore.beginRun({
        source: 'scheduler_periodic',
        mode: 'live',
        nowMs: 2_000,
        leaseExpiresAtMs: 3_000,
      });
      first.close();

      const reopened = new Database(databaseFile);
      reopened.open();
      const reopenedStore = new ConsolidationRunStore(reopened);
      expect(reopenedStore.abandonInterruptedRuns(4_000)).toBe(1);
      expect(reopenedStore.readHealth({
        enabled: true,
        started: true,
        nowMs: 4_001,
        stalledAfterMs: 5_000,
      })).toMatchObject({
        state: 'abandoned',
        latest_status: 'abandoned',
        failure_code: 'restart_abandoned',
        latest_attempt_at: 2_000,
        latest_success_at: null,
      });
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('never stores or projects forbidden content bytes', () => {
    const forbidden = [
      'private-memory-text',
      'private-claim',
      'private-source-id',
      'private-chat-id',
      'private-sender-id',
      'private-model-output',
      'private-raw-exception',
      'private-credential',
      'private-content-hash',
    ];
    const handle = begin();
    const counters = { ...emptyConsolidationCounters(), failed: 1 };
    store.finalizeRun(handle, {
      status: 'failed',
      stage: 'validate',
      failureCode: 'output_invalid',
      retryable: false,
      evidenceCoverage: 'provider_response',
      counters,
      nowMs: 2_000,
    });

    const serialized = JSON.stringify({
      rows: db.raw.prepare('SELECT * FROM memory_consolidation_runs').all(),
      health: store.readHealth({
        enabled: true,
        started: true,
        nowMs: 2_001,
        stalledAfterMs: 5_000,
      }),
    });
    for (const value of forbidden) expect(serialized).not.toContain(value);
  });

});
