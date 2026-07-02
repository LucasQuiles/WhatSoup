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

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (err: Error) => void } {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

    await vi.waitFor(() => {
      expect(order).toEqual(['first-done', 'second-started']);
    });

    expect(order).toEqual(['first-done', 'second-started']);
  });

  it('cross-chat parallel: 3 different chats → all start concurrently', async () => {
    const queue = new ChatQueue(3);
    const started: string[] = [];
    const taskX = deferred();
    const taskY = deferred();
    const taskZ = deferred();

    queue.enqueue('chat-X', () => { started.push('X'); return taskX.promise; });
    queue.enqueue('chat-Y', () => { started.push('Y'); return taskY.promise; });
    queue.enqueue('chat-Z', () => { started.push('Z'); return taskZ.promise; });

    await vi.waitFor(() => {
      expect(started).toEqual(expect.arrayContaining(['X', 'Y', 'Z']));
    });

    expect(started).toContain('X');
    expect(started).toContain('Y');
    expect(started).toContain('Z');
    expect(started).toHaveLength(3);

    taskX.resolve();
    taskY.resolve();
    taskZ.resolve();
    await vi.waitFor(() => {
      expect(queue.stats.activeChats).toBe(0);
    });
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

    queue.enqueue('chat-A', () => firstTask().then(() => { order.push('first'); }));
    queue.enqueue('chat-B', secondTask);

    // Second chat is blocked — slot is taken by first
    await vi.waitFor(() => {
      expect(queue.stats.activeChats).toBe(1);
    });
    expect(order).not.toContain('second');

    // Release first
    resolveFirst();
    await vi.waitFor(() => {
      expect(order).toEqual(['first', 'second']);
    });

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

    await vi.waitFor(() => {
      expect(queue.stats.activeChats).toBe(2);
    });
    const mid = queue.stats;
    expect(mid.activeChats).toBe(2);

    resolve1();
    resolve2();
    await vi.waitFor(() => {
      expect(queue.stats.activeChats).toBe(0);
    });

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

    // Enqueue 5 tasks for the same chat, each needing explicit resolution.
    for (let i = 0; i < 5; i++) {
      const idx = i;
      queue.enqueue('same-chat', () =>
        new Promise<void>((r) => {
          results.push(idx);
          resolvers.push(r);
        }),
      );
    }

    for (let i = 0; i < 5; i++) {
      await vi.waitFor(() => {
        expect(resolvers).toHaveLength(i + 1);
      });
      resolvers[i]?.();
    }

    await vi.waitFor(() => {
      expect(queue.stats.activeChats).toBe(0);
    });
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

    await vi.waitFor(() => {
      expect(resolvers).toHaveLength(3);
    });

    // At most 3 should be running at any point in time
    expect(peakConcurrency).toBeLessThanOrEqual(3);
    expect(currentConcurrency).toBe(3);

    for (let i = 0; i < 3; i++) {
      resolvers[i]?.();
    }

    await vi.waitFor(() => {
      expect(resolvers).toHaveLength(5);
    });

    for (let i = 3; i < resolvers.length; i++) {
      resolvers[i]?.();
    }
    await vi.waitFor(() => {
      expect(queue.stats.activeChats).toBe(0);
    });

    // Peak concurrency never exceeded 3
    expect(peakConcurrency).toBeLessThanOrEqual(3);
    expect(currentConcurrency).toBe(0);
  });

  it('MUST NOT deadlock on task error (error frees slot)', async () => {
    const queue = new ChatQueue(1);
    const completed: string[] = [];

    // First task: fails
    queue.enqueue('chat-A', () => Promise.reject(new Error('task failed')));
    // Second task: different chat, should still run after slot is freed
    queue.enqueue('chat-B', () => {
      completed.push('B');
      return Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(completed).toContain('B');
    });

    expect(completed).toContain('B');
  });

  it('QR-060: sheds same-chat tasks beyond the per-chat depth cap (admission control)', async () => {
    // maxConcurrent=1, per-chat depth cap=3. A blocking first task holds the single slot so
    // subsequent same-chat tasks stay pending and accumulate against the cap.
    const queue = new ChatQueue(1, 3);
    let release!: () => void;

    const r0 = await queue.enqueue('chat-A', () => new Promise<void>((r) => { release = r; }));
    const r1 = await queue.enqueue('chat-A', () => Promise.resolve());
    const r2 = await queue.enqueue('chat-A', () => Promise.resolve());
    // pending is now 3 (= cap) → the next two are shed.
    const r3 = await queue.enqueue('chat-A', () => Promise.resolve());
    const r4 = await queue.enqueue('chat-A', () => Promise.resolve());

    expect([r0, r1, r2]).toEqual([true, true, true]);
    expect([r3, r4]).toEqual([false, false]);
    expect(queue.droppedCount).toBe(2);

    // Drain.
    release();
    await vi.waitFor(() => { expect(queue.stats.activeChats).toBe(0); });
  });

  it('QR-060: per-chat cap does not shed across distinct chats (no over-trigger)', async () => {
    // Cap is PER chat: 10 different chats each with one task stay well under the cap of 3.
    const queue = new ChatQueue(2, 3);
    const results: boolean[] = [];
    for (let i = 0; i < 10; i++) {
      results.push(await queue.enqueue(`chat-${i}`, () => Promise.resolve()));
    }
    expect(results.every(Boolean)).toBe(true);
    expect(queue.droppedCount).toBe(0);
    await vi.waitFor(() => { expect(queue.stats.activeChats).toBe(0); });
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
      const label = i === 2 ? 'jobTwo' : 'jobThree';
      queue.enqueue(`chat-${i}`, () => {
        completed.push(label);
        return Promise.resolve();
      });
    }

    await vi.waitFor(() => {
      expect(queue.stats.activeChats).toBe(2);
      expect(queue.stats.queuedChats).toBe(2);
    });
    // Only 2 running, 2 queued — none should have run yet
    expect(completed).toHaveLength(0);

    // Release first two
    for (const r of resolvers) r();
    await vi.waitFor(() => {
      expect(completed).toEqual(expect.arrayContaining(['jobTwo', 'jobThree']));
    });

    // All 4 tasks must complete
    expect(completed).toContain('jobTwo');
    expect(completed).toContain('jobThree');
  });
});
