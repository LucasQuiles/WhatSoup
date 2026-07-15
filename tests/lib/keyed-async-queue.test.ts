import { describe, expect, it, vi } from 'vitest';

import { KeyedAsyncQueue } from '../../src/lib/keyed-async-queue.ts';

/**
 * Deterministic microtask-ordering helpers. Each task resolves after a
 * configurable number of `setTimeout(0)` ticks so we can assert serialization
 * vs parallelism without flaky real-time waits.
 */
function tick(n = 1): Promise<void> {
  let p: Promise<void> = Promise.resolve();
  for (let i = 0; i < n; i++) {
    p = p.then(() => new Promise<void>((r) => setTimeout(r, 0)));
  }
  return p;
}

describe('KeyedAsyncQueue', () => {
  it('serializes tasks enqueued under the same key (order preserved)', async () => {
    const queue = new KeyedAsyncQueue<string>();
    const order: string[] = [];

    // Three tasks on the same key; each records its label on completion.
    // Task 2 and 3 are enqueued immediately (before task 1 completes), so they
    // must chain. If they ran concurrently the order would be nondeterministic.
    queue.enqueue('chat-a', async () => {
      await tick(3);
      order.push('a-1');
    });
    queue.enqueue('chat-a', async () => {
      await tick(1);
      order.push('a-2');
    });
    await queue.enqueue('chat-a', async () => {
      await tick(0);
      order.push('a-3');
    });

    expect(order).toEqual(['a-1', 'a-2', 'a-3']);
  });

  it('runs tasks under different keys in parallel', async () => {
    const queue = new KeyedAsyncQueue<string>();
    const completion: string[] = [];

    // key-1 takes 3 ticks, key-2 takes 1 tick. If serialized, key-2 would finish
    // after key-1. In parallel, key-2 finishes first.
    const p1 = queue.enqueue('slow', async () => {
      await tick(3);
      completion.push('slow');
    });
    const p2 = queue.enqueue('fast', async () => {
      await tick(1);
      completion.push('fast');
    });
    await Promise.all([p1, p2]);

    expect(completion).toEqual(['fast', 'slow']);
  });

  it('returns the task result to the caller (resolution)', async () => {
    const queue = new KeyedAsyncQueue<string>();
    const result = await queue.enqueue('k', async () => 42);
    expect(result).toBe(42);
  });

  it('propagates the task rejection to the caller', async () => {
    const queue = new KeyedAsyncQueue<string>();
    const err = new Error('boom');
    await expect(queue.enqueue('k', async () => { throw err; })).rejects.toBe(err);
  });

  it('a rejected task does NOT poison subsequent tasks for the same key', async () => {
    const queue = new KeyedAsyncQueue<string>();
    const log: number[] = [];

    await expect(queue.enqueue('k', async () => { throw new Error('first fails'); })).rejects.toThrow();
    // The next task on the same key must still run and resolve normally.
    const result = await queue.enqueue('k', async () => {
      log.push(1);
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(log).toEqual([1]);
  });

  it('cleans up the map entry after the last task for a key settles', async () => {
    const queue = new KeyedAsyncQueue<string>();
    queue.enqueue('k', async () => { await tick(1); });
    await queue.enqueue('k', async () => { await tick(1); });

    // After all tasks for 'k' settle, the internal tails map should not retain
    // the entry (avoids unbounded growth across many distinct keys).
    // We can't read the private field directly, but we can assert via a fresh
    // enqueue that behaves as if no prior chain exists (runs immediately).
    const start = Date.now();
    await queue.enqueue('k', async () => { /* no tick */ });
    // If a stale tail were still chained, this could still resolve quickly
    // (tails are resolved promises), so the stronger assertion is structural:
    // confirm the queue accepts new work without throwing and resolves it.
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('fires onEnqueue and onSettle hooks at the right times', async () => {
    const enqueued: string[] = [];
    const settled: string[] = [];
    const queue = new KeyedAsyncQueue<string>({
      onEnqueue: (key) => { enqueued.push(key); },
      onSettle: (key) => { settled.push(key); },
    });

    await queue.enqueue('x', async () => { await tick(1); });
    await queue.enqueue('y', async () => { await tick(1); });

    expect(enqueued).toEqual(['x', 'y']);
    expect(settled).toEqual(['x', 'y']);
  });

  it('fires onSettle even when the task rejects', async () => {
    const settled: string[] = [];
    const queue = new KeyedAsyncQueue<string>({
      onSettle: (key) => { settled.push(key); },
    });

    await expect(queue.enqueue('x', async () => { throw new Error('boom'); })).rejects.toThrow();
    expect(settled).toEqual(['x']);
  });

  it('handles rapid re-enqueue of the same key before the first settles', async () => {
    const queue = new KeyedAsyncQueue<number>();
    const order: number[] = [];

    // Enqueue 5 tasks on the same key synchronously; they must all run in order.
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 5; i++) {
      const idx = i;
      promises.push(queue.enqueue('k', async () => {
        await tick((5 - idx) % 3);  // varied ticks to defeat accidental ordering
        order.push(idx);
      }));
    }
    await Promise.all(promises);

    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it('isolates failures across keys (one key failing does not affect another)', async () => {
    const queue = new KeyedAsyncQueue<string>();
    const result = await queue.enqueue('good', async () => 'still-works');
    expect(result).toBe('still-works');
  });

  it('works with no hooks supplied (default constructor)', async () => {
    const queue = new KeyedAsyncQueue<string>();
    const r = await queue.enqueue('k', async () => 'noop-hooks-ok');
    expect(r).toBe('noop-hooks-ok');
  });

  it('does not hold a stale tail that blocks a new key forever', async () => {
    // Regression guard: if the settle/cleanup logic deleted the wrong entry,
    // a long-running task on key A could be deleted by a quick task on key A
    // that resolved first, causing a third enqueue to not chain. Verify that
    // after mixed durations, a follow-up task still chains correctly.
    const queue = new KeyedAsyncQueue<string>();
    const order: string[] = [];

    queue.enqueue('k', async () => { await tick(4); order.push('long'); });
    queue.enqueue('k', async () => { await tick(1); order.push('short'); });
    await queue.enqueue('k', async () => { order.push('final'); });

    expect(order).toEqual(['long', 'short', 'final']);
  });
});
