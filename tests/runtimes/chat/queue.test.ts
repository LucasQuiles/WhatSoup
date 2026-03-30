import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { ChatQueue } from '../../../src/runtimes/chat/queue.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return a task that records when it starts and resolves after `ms` ms. */
function timedTask(
  startLog: number[],
  id: number,
  ms: number,
): () => Promise<void> {
  return () =>
    new Promise<void>((resolve) => {
      startLog.push(id);
      setTimeout(resolve, ms);
    });
}

/** Return a task that rejects after `ms` ms. */
function failingTask(ms: number): () => Promise<void> {
  return () =>
    new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error('task failed')), ms);
    });
}

// ---------------------------------------------------------------------------
// Positive
// ---------------------------------------------------------------------------

describe('ChatQueue — positive', () => {
  it('per-chat sequential: 2 messages on same chat → second task waits for first', async () => {
    const queue = new ChatQueue(3);
    const order: string[] = [];

    // Use a flag that the first task signals once it has started
    let firstTaskResolve: (() => void) | null = null;
    const firstTaskStarted = new Promise<void>((readyResolve) => {
      queue.enqueue('chat-A', () =>
        new Promise<void>((done) => {
          firstTaskResolve = done;
          readyResolve(); // signal: first task body is now executing
        }).then(() => { order.push('first-done'); }),
      );
    });

    const secondTask = (): Promise<void> => {
      order.push('second-started');
      return Promise.resolve();
    };

    queue.enqueue('chat-A', secondTask);

    // Wait until the first task body is actually running
    await firstTaskStarted;

    // Second should NOT have started yet (first is still pending)
    expect(order).not.toContain('second-started');

    // Resolve first
    firstTaskResolve!();

    // Drain the microtask/timer queue
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(order).toEqual(['first-done', 'second-started']);
  });

  it('cross-chat parallel: 3 different chats → all start concurrently', async () => {
    const queue = new ChatQueue(3);
    const started: string[] = [];

    const p1 = queue.enqueue('chat-X', () => { started.push('X'); return new Promise<void>(r => setTimeout(r, 50)); });
    const p2 = queue.enqueue('chat-Y', () => { started.push('Y'); return new Promise<void>(r => setTimeout(r, 50)); });
    const p3 = queue.enqueue('chat-Z', () => { started.push('Z'); return new Promise<void>(r => setTimeout(r, 50)); });

    // Let all tasks start
    await new Promise<void>(r => setTimeout(r, 10));

    expect(started).toContain('X');
    expect(started).toContain('Y');
    expect(started).toContain('Z');
    expect(started).toHaveLength(3);

    await Promise.all([p1, p2, p3]);
  });

  it('slot freed after completion → queued chat starts', async () => {
    const queue = new ChatQueue(1); // only 1 slot
    const order: string[] = [];

    let resolveFirst!: () => void;
    const firstTask = (): Promise<void> =>
      new Promise<void>((r) => { resolveFirst = r; });

    const secondTask = (): Promise<void> => {
      order.push('second');
      return Promise.resolve();
    };

    queue.enqueue('chat-A', () => firstTask().then(() => order.push('first')));
    queue.enqueue('chat-B', secondTask);

    // Second chat is blocked — slot is taken by first
    await new Promise<void>(r => setTimeout(r, 10));
    expect(order).not.toContain('second');

    // Release first
    resolveFirst();
    await new Promise<void>(r => setTimeout(r, 20));

    expect(order).toContain('first');
    expect(order).toContain('second');
    // first must complete before second begins
    expect(order.indexOf('first')).toBeLessThan(order.indexOf('second'));
  });

  it('stats getter returns accurate counts', async () => {
    const queue = new ChatQueue(2);

    // Initially all zero
    expect(queue.stats).toEqual({ activeChats: 0, queuedChats: 0, trackedChats: 0 });

    // Start two long-running tasks
    let resolve1!: () => void, resolve2!: () => void;
    queue.enqueue('chat-1', () => new Promise<void>(r => { resolve1 = r; }));
    queue.enqueue('chat-2', () => new Promise<void>(r => { resolve2 = r; }));

    await new Promise<void>(r => setTimeout(r, 10));
    const mid = queue.stats;
    expect(mid.activeChats).toBe(2);

    resolve1();
    resolve2();
    await new Promise<void>(r => setTimeout(r, 20));

    // After completion chains are cleared
    const final = queue.stats;
    expect(final.activeChats).toBe(0);
    expect(final.trackedChats).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Negative / invariant
// ---------------------------------------------------------------------------

describe('ChatQueue — negative / invariant', () => {
  it('MUST NOT process same-chat messages out of order', async () => {
    const queue = new ChatQueue(5);
    const results: number[] = [];
    const resolvers: Array<() => void> = [];

    // Enqueue 5 tasks for the same chat, each needing explicit resolution
    for (let i = 0; i < 5; i++) {
      const idx = i;
      queue.enqueue('same-chat', () =>
        new Promise<void>((r) => {
          resolvers.push(() => { results.push(idx); r(); });
        }),
      );
    }

    // Resolve them in order, but with slight delay each
    for (let i = 0; i < 5; i++) {
      await new Promise<void>(r => setTimeout(r, 5));
      resolvers[i]?.();
      await new Promise<void>(r => setTimeout(r, 5));
    }

    await new Promise<void>(r => setTimeout(r, 20));
    expect(results).toEqual([0, 1, 2, 3, 4]);
  });

  it('MUST NOT allow 4+ concurrent tasks when maxConcurrent=3', async () => {
    const queue = new ChatQueue(3);
    let peakConcurrency = 0;
    let currentConcurrency = 0;
    // resolvers for the 3 tasks that actually start immediately
    const resolvers: Array<() => void> = [];

    // Enqueue 5 tasks across 5 different chats
    for (let i = 0; i < 5; i++) {
      queue.enqueue(`chat-${i}`, () =>
        new Promise<void>((r) => {
          currentConcurrency++;
          peakConcurrency = Math.max(peakConcurrency, currentConcurrency);
          resolvers.push(() => { currentConcurrency--; r(); });
        }),
      );
    }

    // Let first 3 start (they acquire slots immediately)
    await new Promise<void>(r => setTimeout(r, 10));

    // At most 3 should be running at any point in time
    expect(peakConcurrency).toBeLessThanOrEqual(3);
    expect(currentConcurrency).toBe(3);

    // Resolve the first 3 one by one so the remaining 2 can start and finish
    for (let i = 0; i < 3; i++) {
      resolvers[i]?.();
      await new Promise<void>(r => setTimeout(r, 10));
    }

    // Drain remaining tasks (the 2 that were queued)
    await new Promise<void>(r => setTimeout(r, 50));

    // Resolve any that started during drain
    for (let i = 3; i < resolvers.length; i++) {
      resolvers[i]?.();
    }
    await new Promise<void>(r => setTimeout(r, 20));

    // Peak concurrency never exceeded 3
    expect(peakConcurrency).toBeLessThanOrEqual(3);
    expect(currentConcurrency).toBe(0);
  });

  it('MUST NOT deadlock on task error (error frees slot)', async () => {
    const queue = new ChatQueue(1);
    const completed: string[] = [];

    // First task: fails
    queue.enqueue('chat-A', failingTask(10));
    // Second task: different chat, should still run after slot is freed
    queue.enqueue('chat-B', () => {
      completed.push('B');
      return Promise.resolve();
    });

    // Give enough time for failure + second task to run
    await new Promise<void>(r => setTimeout(r, 100));

    expect(completed).toContain('B');
  });

  it('MUST NOT drop messages when at capacity', async () => {
    const queue = new ChatQueue(2);
    const completed: string[] = [];
    const resolvers: Array<() => void> = [];

    // Fill all 2 slots
    for (let i = 0; i < 2; i++) {
      queue.enqueue(`chat-${i}`, () =>
        new Promise<void>((r) => { resolvers.push(r); }),
      );
    }

    // Enqueue 2 more at-capacity tasks (they should queue, not be dropped)
    for (let i = 2; i < 4; i++) {
      const label = `task-${i}`;
      queue.enqueue(`chat-${i}`, () => {
        completed.push(label);
        return Promise.resolve();
      });
    }

    await new Promise<void>(r => setTimeout(r, 10));
    // Only 2 running, 2 queued — none should have run yet
    expect(completed).toHaveLength(0);

    // Release first two
    for (const r of resolvers) r();
    await new Promise<void>(r => setTimeout(r, 50));

    // All 4 tasks must complete
    expect(completed).toContain('task-2');
    expect(completed).toContain('task-3');
  });
});
