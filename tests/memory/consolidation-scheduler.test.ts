import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryConsolidationScheduler } from '../../src/memory/consolidation-scheduler.ts';

vi.useFakeTimers();

describe('MemoryConsolidationScheduler', () => {
  const pinecone = { search: vi.fn(), upsert: vi.fn() };
  const provider = { name: 'test-provider', generate: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  it('runs immediately on start and then on interval', async () => {
    pinecone.search.mockResolvedValue([]);
    const scheduler = new MemoryConsolidationScheduler(pinecone, provider as any, {
      intervalMs: 60_000,
      lookbackDays: 7,
      dryRun: false,
    });

    scheduler.start();

    expect(pinecone.search).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(pinecone.search).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it('start is idempotent and stop is idempotent', async () => {
    pinecone.search.mockResolvedValue([]);
    const scheduler = new MemoryConsolidationScheduler(pinecone, provider as any, {
      intervalMs: 60_000,
      lookbackDays: 7,
      dryRun: true,
    });

    scheduler.start();
    scheduler.start();

    expect(pinecone.search).toHaveBeenCalledTimes(1);
    scheduler.stop();
    scheduler.stop();
  });

  it('drains the active run before stop resolves', async () => {
    let resolveSearch: ((results: []) => void) | undefined;
    pinecone.search.mockReturnValue(new Promise<[]>((resolve) => {
      resolveSearch = resolve;
    }));
    const scheduler = new MemoryConsolidationScheduler(pinecone, provider as any, {
      intervalMs: 60_000,
      lookbackDays: 7,
      dryRun: true,
    });

    scheduler.start();

    let stopResolved = false;
    const stopPromise = scheduler.stop().then(() => {
      stopResolved = true;
    });
    await Promise.resolve();

    expect(stopResolved).toBe(false);
    resolveSearch?.([]);
    await stopPromise;
    expect(stopResolved).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(pinecone.search).toHaveBeenCalledTimes(1);
  });

  it('returns from stop after the timeout when an active run does not drain', async () => {
    pinecone.search.mockReturnValue(new Promise<[]>(() => {}));
    const scheduler = new MemoryConsolidationScheduler(pinecone, provider as any, {
      intervalMs: 60_000,
      lookbackDays: 7,
      dryRun: true,
    });

    scheduler.start();

    let stopResolved = false;
    const stopPromise = scheduler.stop(25).then(() => {
      stopResolved = true;
    });
    await Promise.resolve();

    expect(stopResolved).toBe(false);
    await vi.advanceTimersByTimeAsync(25);
    await stopPromise;
    expect(stopResolved).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(pinecone.search).toHaveBeenCalledTimes(1);
  });

  it('skips a manual run when a previous manual run is still active', async () => {
    let resolveSearch: ((results: []) => void) | undefined;
    pinecone.search.mockReturnValue(new Promise<[]>((resolve) => {
      resolveSearch = resolve;
    }));
    const scheduler = new MemoryConsolidationScheduler(pinecone, provider as any, {
      intervalMs: 60_000,
      lookbackDays: 7,
      dryRun: true,
    });

    const firstRun = scheduler.runOnce();
    await Promise.resolve();
    await scheduler.runOnce();

    expect(pinecone.search).toHaveBeenCalledTimes(1);
    resolveSearch?.([]);
    await firstRun;
  });

  it('keeps periodic scheduling alive after an unexpected scheduled run failure', async () => {
    pinecone.search
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([]);
    const scheduler = new MemoryConsolidationScheduler(pinecone, provider as any, {
      intervalMs: 60_000,
      lookbackDays: 7,
      dryRun: true,
    });

    scheduler.start();
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(pinecone.search).toHaveBeenCalledTimes(2);

    await scheduler.stop();
  });

  it('keeps tracking the active run when an interval tick is skipped', async () => {
    let resolveSearch: ((results: []) => void) | undefined;
    pinecone.search.mockReturnValue(new Promise<[]>((resolve) => {
      resolveSearch = resolve;
    }));
    const scheduler = new MemoryConsolidationScheduler(pinecone, provider as any, {
      intervalMs: 60_000,
      lookbackDays: 7,
      dryRun: true,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pinecone.search).toHaveBeenCalledTimes(1);

    let stopResolved = false;
    const stopPromise = scheduler.stop().then(() => {
      stopResolved = true;
    });
    await Promise.resolve();

    expect(stopResolved).toBe(false);
    resolveSearch?.([]);
    await stopPromise;
    expect(stopResolved).toBe(true);
  });

  it('warns and still resolves stop() when the active run never drains before timeout', async () => {
    // UNHAPPY: a hung consolidation run must not block stop() forever — after the timeout
    // stop() resolves (logging that the run is still draining).
    pinecone.search.mockReturnValue(new Promise<[]>(() => { /* never resolves */ }));
    const scheduler = new MemoryConsolidationScheduler(pinecone, provider as any, {
      intervalMs: 60_000,
      lookbackDays: 7,
      dryRun: true,
    });
    scheduler.start();

    let stopResolved = false;
    const stopPromise = scheduler.stop(5_000).then(() => { stopResolved = true; });
    await Promise.resolve();
    expect(stopResolved).toBe(false);

    await vi.advanceTimersByTimeAsync(5_000);
    await stopPromise;
    expect(stopResolved).toBe(true);
  });

  it('skips runOnce when a previous run is still active', async () => {
    // UNHAPPY: overlapping runs must not double-execute; a second runOnce is skipped.
    pinecone.search.mockReturnValue(new Promise<[]>(() => { /* hang the first run */ }));
    const scheduler = new MemoryConsolidationScheduler(pinecone, provider as any, {
      intervalMs: 60_000,
      lookbackDays: 7,
      dryRun: true,
    });
    scheduler.start();
    expect(pinecone.search).toHaveBeenCalledTimes(1);

    await scheduler.runOnce();
    expect(pinecone.search).toHaveBeenCalledTimes(1);

    const stopPromise = scheduler.stop(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await stopPromise;
  });
});
