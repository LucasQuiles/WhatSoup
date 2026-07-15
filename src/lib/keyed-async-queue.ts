/**
 * Per-key async serialization.
 *
 * Serializes async work *per key* while letting unrelated keys run in parallel.
 * Each key maintains a promise tail-chain; a new task for a key awaits the
 * previous tail for that key, then cleans up the map entry when it is still the
 * latest. No timers, no locks, no external state.
 *
 * Use cases: per-chat-JID send serialization, per-session transcript append
 * ordering, per-conversation tool dispatch — anywhere work for the same key
 * must not overlap, but work for different keys may run concurrently.
 *
 * Failure isolation: a rejected task does NOT poison the chain. The task's own
 * rejection is returned to the caller, while the internal tail always settles
 * (via both onFulfilled and onRejected handlers) so the next task for the key
 * still runs.
 *
 * Reentrancy guard: a task running under a key must not enqueue more work under
 * the SAME key (directly, or transitively via another key on the same async
 * chain) — the inner task would chain behind the outer task's tail while the
 * outer task awaits the inner one, a circular self-deadlock. The set of keys
 * active on the current async chain is threaded through {@link AsyncLocalStorage}
 * (which propagates across `await` boundaries), so such a nested enqueue throws
 * {@link KeyedAsyncQueueReentrancyError} synchronously instead of hanging. Note:
 * the synchronous throw aborts the enclosing task's remaining body unless the
 * caller wraps the reentrant enqueue in try/catch.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface KeyedAsyncQueueOptions<K> {
  /** Fired synchronously when a task is enqueued under a key. */
  onEnqueue?: (key: K) => void;
  /** Fired after a task settles (resolves OR rejects), before the next runs. */
  onSettle?: (key: K) => void;
}

/**
 * Thrown synchronously by {@link KeyedAsyncQueue.enqueue} when a task that is
 * already running for a key (directly, or transitively via another key on the
 * same async chain) enqueues more work under that same key.
 *
 * Such a nested same-key enqueue can never make progress: the inner task chains
 * behind the outer task's tail, but the outer task is blocked awaiting the inner
 * one — a circular wait (self-deadlock). Rejecting fast turns a silent hang into
 * an actionable error. Note this also forbids *fire-and-forget* same-key
 * reentrancy (not just awaited nesting): the call site can't be distinguished,
 * so the guard is conservative by design.
 */
export class KeyedAsyncQueueReentrancyError<K = unknown> extends Error {
  readonly key: K;

  constructor(key: K) {
    super(
      `KeyedAsyncQueue: reentrant enqueue for key ${String(key)} would deadlock — ` +
        'a task already running for this key on the current async chain enqueued ' +
        'more work under the same key. Restructure to avoid nesting same-key enqueues.',
    );
    this.name = 'KeyedAsyncQueueReentrancyError';
    this.key = key;
  }
}

export class KeyedAsyncQueue<K> {
  private readonly tails = new Map<K, Promise<void>>();
  private readonly onEnqueueHook?: (key: K) => void;
  private readonly onSettleHook?: (key: K) => void;
  /**
   * Keys whose tasks are currently running on the active async chain. Threaded
   * through AsyncLocalStorage so it propagates across `await` boundaries,
   * letting `enqueue` detect direct AND transitive same-key reentrancy.
   */
  private readonly running = new AsyncLocalStorage<ReadonlySet<K>>();

  constructor(opts: KeyedAsyncQueueOptions<K> = {}) {
    this.onEnqueueHook = opts.onEnqueue;
    this.onSettleHook = opts.onSettle;
  }

  /**
   * Enqueue a task under `key`. Resolves/rejects with the task's own outcome.
   *
   * The task runs once the previous task for the same key has settled. Tasks
   * for different keys are not ordered against each other. A prior task's
   * rejection does not skip or fail this task.
   */
  enqueue<T>(key: K, task: () => Promise<T>): Promise<T> {
    // Reentrancy guard (throws synchronously, before any state mutation): if a
    // task already running for this key on the current async chain enqueues
    // more work under the same key, it would self-deadlock. Fail fast instead.
    const activeKeys = this.running.getStore();
    if (activeKeys?.has(key)) {
      throw new KeyedAsyncQueueReentrancyError(key);
    }
    this.onEnqueueHook?.(key);
    const previous = this.tails.get(key) ?? Promise.resolve();
    // Run the task after the previous tail settles, whether it resolved or
    // rejected — a prior failure must not block this task (no poison chain).
    // The task runs inside an AsyncLocalStorage context carrying the set of
    // keys active on this chain (previous keys + this one), captured at enqueue
    // time, so a nested same-key enqueue is detected by the guard above.
    const runInContext = (): Promise<T> => {
      const nextKeys = new Set(activeKeys);
      nextKeys.add(key);
      return this.running.run(nextKeys, task);
    };
    const run = previous.then(runInContext, runInContext);
    // The tail always resolves; it exists only for chain continuity. Swallow
    // the task's own rejection here so the next task isn't skipped — the
    // caller receives the real outcome via `run`.
    const tail: Promise<void> = run.then(
      () => this.settle(key, tail),
      () => this.settle(key, tail),
    );
    this.tails.set(key, tail);
    return run;
  }

  /**
   * Settle hook shared by the resolve and reject branches of the tail.
   *
   * Deletes the map entry only if no newer task for this key has chained onto
   * us — if a newer task arrived while we were running, it set its own tail and
   * owns the entry; deleting would break the chain. Always fires onSettle so
   * consumers can track per-key concurrency for diagnostics.
   */
  private settle(key: K, myTail: Promise<void>): void {
    if (this.tails.get(key) === myTail) {
      this.tails.delete(key);
    }
    this.onSettleHook?.(key);
  }
}
