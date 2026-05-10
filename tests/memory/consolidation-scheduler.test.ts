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
});
