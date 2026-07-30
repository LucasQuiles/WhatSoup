import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockLifecycleLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => mockLifecycleLog,
}));

import { Database } from '../../src/core/database.ts';
import type { ConsolidationPinecone } from '../../src/memory/consolidation-cron.ts';
import { MemoryConsolidationScheduler } from '../../src/memory/consolidation-scheduler.ts';
import { ConsolidationRunStore } from '../../src/memory/consolidation-run-store.ts';
import type { LLMProvider } from '../../src/runtimes/chat/providers/types.ts';

vi.useFakeTimers();

function okSearch(results: unknown[] = []) {
  return {
    results,
    status: 'ok' as const,
    evidenceCoverage: 'provider_response' as const,
  };
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('MemoryConsolidationScheduler', () => {
  let db: Database;
  let store: ConsolidationRunStore;
  let pinecone: ConsolidationPinecone & {
    searchDetailed: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
  let provider: {
    name: string;
    generate: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.setSystemTime(new Date('2026-07-28T12:00:00.000Z'));
    db = new Database(':memory:');
    db.open();
    store = new ConsolidationRunStore(db);
    pinecone = {
      searchDetailed: vi.fn().mockResolvedValue(okSearch()),
      upsert: vi.fn().mockResolvedValue(undefined),
    };
    provider = { name: 'test-provider', generate: vi.fn() };
  });

  afterEach(() => {
    vi.clearAllTimers();
    db.close();
  });

  function createScheduler(overrides: {
    intervalMs?: number;
    totalRunTimeoutMs?: number;
    dryRun?: boolean;
  } = {}): MemoryConsolidationScheduler {
    return new MemoryConsolidationScheduler(
      pinecone,
      provider as LLMProvider,
      {
        intervalMs: overrides.intervalMs ?? 60_000,
        lookbackDays: 7,
        dryRun: overrides.dryRun ?? true,
        totalRunTimeoutMs: overrides.totalRunTimeoutMs ?? 30_000,
      },
      store,
    );
  }

  it('abandons interrupted receipts, runs immediately, and keeps the interval alive', async () => {
    const interrupted = store.beginRun({
      source: 'manual',
      mode: 'live',
      nowMs: Date.now() - 10_000,
      leaseExpiresAtMs: Date.now() - 5_000,
    });
    const scheduler = createScheduler();

    scheduler.start();
    await flushAsync();

    expect(db.raw.prepare(`
      SELECT status, failure_code FROM memory_consolidation_runs
      WHERE run_id = ?
    `).get(interrupted.runId)).toEqual({
      status: 'abandoned',
      failure_code: 'restart_abandoned',
    });
    expect(pinecone.searchDetailed).toHaveBeenCalledTimes(1);
    expect(db.raw.prepare(`
      SELECT source, status FROM memory_consolidation_runs
      ORDER BY attempted_at DESC, run_id DESC LIMIT 1
    `).get()).toEqual({
      source: 'scheduler_immediate',
      status: 'no_work',
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await flushAsync();
    expect(pinecone.searchDetailed).toHaveBeenCalledTimes(2);
    expect(db.raw.prepare(`
      SELECT COUNT(*) AS count FROM memory_consolidation_runs
      WHERE source = 'scheduler_periodic'
    `).get()).toEqual({ count: 1 });

    await scheduler.stop();
  });

  it('returns a typed skipped report and increments only the active receipt skip counter', async () => {
    let resolveSearch: ((value: ReturnType<typeof okSearch>) => void) | undefined;
    pinecone.searchDetailed.mockReturnValue(new Promise((resolve) => {
      resolveSearch = resolve;
    }));
    const scheduler = createScheduler();

    const first = scheduler.runOnce();
    await flushAsync();
    const skipped = await scheduler.runOnce();

    expect(skipped).toMatchObject({
      status: 'skipped',
      failureCode: 'already_running',
      counters: { skipped: 1 },
    });
    expect(pinecone.searchDetailed).toHaveBeenCalledTimes(1);
    expect(db.raw.prepare(`
      SELECT overlap_skipped, last_progress_at, lease_expires_at
      FROM memory_consolidation_runs
    `).get()).toEqual({
      overlap_skipped: 1,
      last_progress_at: Date.now(),
      lease_expires_at: Date.now() + 30_000,
    });

    resolveSearch?.(okSearch());
    expect((await first).status).toBe('no_work');
    expect(db.raw.prepare(`
      SELECT status, failure_code, skipped, overlap_skipped
      FROM memory_consolidation_runs
    `).get()).toEqual({
      status: 'no_work',
      failure_code: 'none',
      skipped: 0,
      overlap_skipped: 1,
    });
  });

  it('preserves the original attempt timestamp when lifecycle observation throws', async () => {
    const startedAt = Date.now();
    vi.spyOn(store, 'recordProgress').mockImplementation(() => {
      vi.setSystemTime(startedAt + 1_000);
      throw new Error('synthetic observation failure');
    });
    const scheduler = createScheduler();

    const report = await scheduler.runOnce();

    expect(report).toMatchObject({
      status: 'failed',
      failureCode: 'unknown',
      attemptedAt: new Date(startedAt).toISOString(),
      completedAt: new Date(startedAt + 1_000).toISOString(),
      durationMs: 1_000,
    });
  });

  it('propagates stop cancellation and records one terminal cancellation', async () => {
    let observedSignal: AbortSignal | undefined;
    pinecone.searchDetailed.mockImplementation(
      (_query, _filters, _topK, _traceId, signal?: AbortSignal) => {
        observedSignal = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new DOMException('cancelled', 'AbortError'));
          }, { once: true });
        });
      },
    );
    const scheduler = createScheduler();

    scheduler.start();
    await flushAsync();
    await scheduler.stop();

    expect(observedSignal?.aborted).toBe(true);
    expect(db.raw.prepare(`
      SELECT status, failure_code, completed_at
      FROM memory_consolidation_runs
    `).get()).toMatchObject({
      status: 'cancelled',
      failure_code: 'cancelled',
      completed_at: Date.now(),
    });
  });

  it('fences a transport that ignores cancellation and marks its receipt abandoned', async () => {
    pinecone.searchDetailed.mockReturnValue(new Promise(() => {}));
    const scheduler = createScheduler();

    scheduler.start();
    await flushAsync();
    const stopPromise = scheduler.stop(25);
    await vi.advanceTimersByTimeAsync(25);
    await stopPromise;

    expect(db.raw.prepare(`
      SELECT status, failure_code FROM memory_consolidation_runs
    `).get()).toEqual({
      status: 'abandoned',
      failure_code: 'cancelled',
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pinecone.searchDetailed).toHaveBeenCalledTimes(1);
  });

  it('prevents a late provider response from starting a new write after stop', async () => {
    const createdAt = new Date().toISOString();
    pinecone.searchDetailed.mockResolvedValue(okSearch([{
      id: 'record-1',
      score: 0.9,
      record: {
        id: 'record-1',
        text: 'bounded input',
        claim: 'bounded input',
        evidence: '',
        createdAt,
        confidence: 0.9,
        chatJid: 'chat',
        senderJid: 'sender',
      },
    }]));
    let resolveProvider: ((value: unknown) => void) | undefined;
    provider.generate.mockReturnValue(new Promise((resolve) => {
      resolveProvider = resolve;
    }));
    const scheduler = createScheduler({ dryRun: false });

    scheduler.start();
    await flushAsync();
    const stopPromise = scheduler.stop(25);
    await vi.advanceTimersByTimeAsync(25);
    await stopPromise;

    resolveProvider?.({
      content: JSON.stringify({
        durableKnowledge: [{
          claim: 'bounded durable claim',
          promotionReason: 'bounded reason',
          confidence: 0.9,
          sourceRecordIds: ['record-1'],
        }],
        discarded: [],
      }),
      inputTokens: 1,
      outputTokens: 1,
      model: 'test',
      durationMs: 1,
    });
    await flushAsync();

    expect(pinecone.upsert).not.toHaveBeenCalled();
    expect(db.raw.prepare(`
      SELECT status, write_attempted, write_confirmed
      FROM memory_consolidation_runs
    `).get()).toEqual({
      status: 'abandoned',
      write_attempted: 0,
      write_confirmed: 0,
    });
  });

  it('classifies a deadline abort as timeout when the transport honors the signal', async () => {
    pinecone.searchDetailed.mockImplementation(
      (_query, _filters, _topK, _traceId, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new DOMException('deadline', 'AbortError'));
          }, { once: true });
        }),
    );
    const scheduler = createScheduler({ totalRunTimeoutMs: 50 });

    const run = scheduler.runOnce();
    await vi.advanceTimersByTimeAsync(50);
    const report = await run;

    expect(report).toMatchObject({
      status: 'failed',
      failureCode: 'timeout',
      retryable: true,
    });
    expect(db.raw.prepare(`
      SELECT status, failure_code, retryable
      FROM memory_consolidation_runs
    `).get()).toEqual({
      status: 'failed',
      failure_code: 'timeout',
      retryable: 1,
    });
  });

  it('returns timeout and fences late work when the transport ignores the deadline signal', async () => {
    let resolveSearch: ((value: ReturnType<typeof okSearch>) => void) | undefined;
    pinecone.searchDetailed.mockReturnValue(new Promise((resolve) => {
      resolveSearch = resolve;
    }));
    const scheduler = createScheduler({ totalRunTimeoutMs: 50 });

    const run = scheduler.runOnce();
    await vi.advanceTimersByTimeAsync(50);
    const report = await run;

    expect(report).toMatchObject({
      status: 'failed',
      failureCode: 'timeout',
      retryable: true,
    });
    expect(db.raw.prepare(`
      SELECT status, failure_code FROM memory_consolidation_runs
    `).get()).toEqual({
      status: 'failed',
      failure_code: 'timeout',
    });

    resolveSearch?.(okSearch());
    await flushAsync();
    expect(pinecone.upsert).not.toHaveBeenCalled();
  });

  it('records an in-flight write attempt and prevents a second write after stop timeout', async () => {
    const createdAt = new Date().toISOString();
    pinecone.searchDetailed.mockResolvedValue(okSearch([{
      id: 'record-1',
      score: 0.9,
      record: {
        id: 'record-1',
        text: 'bounded input',
        claim: 'bounded input',
        evidence: '',
        createdAt,
        confidence: 0.9,
        chatJid: 'chat',
        senderJid: 'sender',
      },
    }]));
    provider.generate.mockResolvedValue({
      content: JSON.stringify({
        durableKnowledge: [
          {
            claim: 'bounded durable claim one',
            promotionReason: 'bounded reason',
            confidence: 0.9,
            sourceRecordIds: ['record-1'],
          },
          {
            claim: 'bounded durable claim two',
            promotionReason: 'bounded reason',
            confidence: 0.8,
            sourceRecordIds: ['record-1'],
          },
        ],
        discarded: [],
      }),
      inputTokens: 1,
      outputTokens: 1,
      model: 'test',
      durationMs: 1,
    });
    let resolveUpsert: (() => void) | undefined;
    pinecone.upsert.mockReturnValue(new Promise<void>((resolve) => {
      resolveUpsert = resolve;
    }));
    const scheduler = createScheduler({ dryRun: false });

    const run = scheduler.runOnce();
    await flushAsync();
    expect(pinecone.upsert).toHaveBeenCalledTimes(1);
    const stopPromise = scheduler.stop(25);
    await vi.advanceTimersByTimeAsync(25);
    await stopPromise;

    expect(db.raw.prepare(`
      SELECT status, write_attempted, write_confirmed
      FROM memory_consolidation_runs
    `).get()).toEqual({
      status: 'abandoned',
      write_attempted: 1,
      write_confirmed: 0,
    });

    resolveUpsert?.();
    expect((await run).status).toBe('cancelled');
    expect(pinecone.upsert).toHaveBeenCalledTimes(1);
  });

  it('classifies an aborted in-flight upsert as cancellation and starts no second write', async () => {
    const createdAt = new Date().toISOString();
    pinecone.searchDetailed.mockResolvedValue(okSearch([{
      id: 'record-1',
      score: 0.9,
      record: {
        id: 'record-1',
        text: 'bounded input',
        claim: 'bounded input',
        evidence: '',
        createdAt,
        confidence: 0.9,
        chatJid: 'chat',
        senderJid: 'sender',
      },
    }]));
    provider.generate.mockResolvedValue({
      content: JSON.stringify({
        durableKnowledge: [
          {
            claim: 'bounded durable claim one',
            promotionReason: 'bounded reason',
            confidence: 0.9,
            sourceRecordIds: ['record-1'],
          },
          {
            claim: 'bounded durable claim two',
            promotionReason: 'bounded reason',
            confidence: 0.8,
            sourceRecordIds: ['record-1'],
          },
        ],
        discarded: [],
      }),
      inputTokens: 1,
      outputTokens: 1,
      model: 'test',
      durationMs: 1,
    });
    pinecone.upsert.mockImplementation(
      (_records, context?: { signal?: AbortSignal }) =>
        new Promise<void>((_resolve, reject) => {
          context?.signal?.addEventListener('abort', () => {
            reject(new DOMException('cancelled', 'AbortError'));
          }, { once: true });
        }),
    );
    const scheduler = createScheduler({ dryRun: false });

    const run = scheduler.runOnce();
    await flushAsync();
    expect(pinecone.upsert).toHaveBeenCalledTimes(1);
    await scheduler.stop();

    expect((await run).status).toBe('cancelled');
    expect(pinecone.upsert).toHaveBeenCalledTimes(1);
    expect(db.raw.prepare(`
      SELECT status, failure_code, write_attempted, write_confirmed
      FROM memory_consolidation_runs
    `).get()).toEqual({
      status: 'cancelled',
      failure_code: 'cancelled',
      write_attempted: 1,
      write_confirmed: 0,
    });
  });

  it('keeps periodic scheduling alive after a failed run', async () => {
    pinecone.searchDetailed
      .mockResolvedValueOnce({
        results: [],
        status: 'failed',
        failureCode: 'network_error',
        retryable: true,
      })
      .mockResolvedValueOnce(okSearch());
    const scheduler = createScheduler();

    scheduler.start();
    await flushAsync();
    await vi.advanceTimersByTimeAsync(60_000);
    await flushAsync();

    expect(pinecone.searchDetailed).toHaveBeenCalledTimes(2);
    expect(db.raw.prepare(`
      SELECT status, failure_code FROM memory_consolidation_runs
      ORDER BY attempted_at, run_id
    `).all()).toEqual(expect.arrayContaining([
      { status: 'failed', failure_code: 'network_error' },
      { status: 'no_work', failure_code: 'none' },
    ]));
    expect(mockLifecycleLog.error).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        failureCode: 'network_error',
      }),
      'memory consolidation: failed',
    );
    expect(JSON.stringify(mockLifecycleLog.info.mock.calls))
      .not.toContain('run complete');
    await scheduler.stop();
  });

  it('keeps injected private bytes out of logs, receipts, reports, and health', async () => {
    const forbidden = [
      'private-memory-text',
      'private-claim',
      'private-source-id',
      'private-chat-id',
      'private-sender-id',
      'private-model-output',
      'private-raw-exception',
      'private-credential',
      'private-deployment-detail',
    ];
    const createdAt = new Date().toISOString();
    pinecone.searchDetailed.mockResolvedValue(okSearch([
      {
        id: 'private-source-id-a',
        score: 0.9,
        record: {
          id: 'private-source-id-a',
          text: 'private-memory-text private-credential',
          claim: 'private-claim',
          evidence: '',
          createdAt,
          confidence: 0.9,
          chatJid: 'private-chat-id-a',
          senderJid: 'private-sender-id-a',
        },
      },
      {
        id: 'private-source-id-b',
        score: 0.8,
        record: {
          id: 'private-source-id-b',
          text: 'private-deployment-detail',
          claim: 'private-claim-b',
          evidence: '',
          createdAt,
          confidence: 0.8,
          chatJid: 'private-chat-id-b',
          senderJid: 'private-sender-id-b',
        },
      },
    ]));
    provider.generate
      .mockRejectedValueOnce(new Error('private-raw-exception'))
      .mockResolvedValueOnce({
        content: 'not-json-private-model-output',
        inputTokens: 1,
        outputTokens: 1,
        model: 'test',
        durationMs: 1,
      });
    const scheduler = createScheduler();

    const report = await scheduler.runOnce();
    const serialized = JSON.stringify({
      report,
      logs: {
        info: mockLifecycleLog.info.mock.calls,
        warn: mockLifecycleLog.warn.mock.calls,
        error: mockLifecycleLog.error.mock.calls,
      },
      receipts: db.raw.prepare(
        'SELECT * FROM memory_consolidation_runs',
      ).all(),
      health: store.readHealth({
        enabled: true,
        started: true,
        nowMs: Date.now(),
        stalledAfterMs: 5_000,
      }),
    });

    expect(report.status).toBe('failed');
    expect(provider.generate).toHaveBeenCalledTimes(2);
    for (const value of forbidden) {
      expect(serialized).not.toContain(value);
    }
  });
});
