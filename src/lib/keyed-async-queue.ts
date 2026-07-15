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
 */

export interface KeyedAsyncQueueOptions<K> {
  /** Fired synchronously when a task is enqueued under a key. */
  onEnqueue?: (key: K) => void;
  /** Fired after a task settles (resolves OR rejects), before the next runs. */
  onSettle?: (key: K) => void;
}

export class KeyedAsyncQueue<K> {
  private readonly tails = new Map<K, Promise<void>>();
  private readonly onEnqueueHook?: (key: K) => void;
  private readonly onSettleHook?: (key: K) => void;

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
    this.onEnqueueHook?.(key);
    const previous = this.tails.get(key) ?? Promise.resolve();
    // Run the task after the previous tail settles, whether it resolved or
    // rejected — a prior failure must not block this task (no poison chain).
    const run = previous.then(task, task);
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
