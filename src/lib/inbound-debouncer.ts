/**
 * Inbound message debouncer.
 *
 * Coalesces rapid-fire messages from the same sender into a single reply
 * trigger. When messages arrive within `waitMs` of each other, the timer
 * resets. After `waitMs` of silence, the collected messages are flushed to
 * the callback as a batch.
 *
 * This prevents the bot from replying to every individual message when a
 * user sends a stream of short messages (e.g., typing a paragraph across
 * multiple messages, or a burst of reactions).
 *
 * A hard cap (`maxWaitMs`) forces a flush even if messages keep arriving,
 * so a user can't hold the debouncer open indefinitely by sending a message
 * every second.
 *
 * A maximum batch size (`maxBatchSize`) forces a flush when enough messages
 * accumulate, regardless of timing.
 *
 * Test-friendly: injectable clock and timer factory.
 */

export interface DebounceClock {
  now: () => number;
}

export interface DebounceTimerFactory {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface InboundDebouncerParams {
  /** Per-sender wait time in milliseconds. Messages within this window are coalesced. */
  waitMs: number;
  /** Hard cap: force flush after this many ms since the first message in the batch. */
  maxWaitMs?: number;
  /** Max messages per batch before forcing a flush. Default: unlimited. */
  maxBatchSize?: number;
  /** Injectable clock (default: Date.now). */
  clock?: DebounceClock;
  /** Injectable timer factory (default: global setTimeout/clearTimeout). */
  timers?: DebounceTimerFactory;
}

export interface FlushedBatch<TMessage> {
  /** The sender key. */
  key: string;
  /** The coalesced messages, in arrival order. */
  messages: TMessage[];
  /** Timestamp of the first message in the batch. */
  firstAt: number;
  /** Timestamp of the last message in the batch. */
  lastAt: number;
  /** Flush reason. */
  reason: 'idle' | 'max-wait' | 'max-batch' | 'flush';
}

export type FlushReason = FlushedBatch<unknown>['reason'];

export interface InboundDebouncer<TMessage> {
  /** Push a message for the given sender key. Starts or extends the debounce window. */
  push: (key: string, message: TMessage) => void;
  /** Force-flush a specific sender's pending batch immediately. */
  flush: (key: string) => FlushedBatch<TMessage> | null;
  /** Force-flush all pending batches immediately. */
  flushAll: () => FlushedBatch<TMessage>[];
  /** Get the number of pending messages for a sender. */
  pending: (key: string) => number;
  /** Get the total number of senders with pending messages. */
  pendingSenders: () => number;
  /** Cancel all timers and clear all pending messages without flushing. */
  cancel: () => void;
}

interface PendingBatch<TMessage> {
  messages: TMessage[];
  firstAt: number;
  lastAt: number;
  idleTimer: unknown;
  maxWaitTimer: unknown;
}

export function createInboundDebouncer<TMessage>(
  params: InboundDebouncerParams,
  onFlush: (batch: FlushedBatch<TMessage>) => void,
): InboundDebouncer<TMessage> {
  const waitMs = Math.max(0, Math.floor(params.waitMs));
  const maxWaitMs =
    typeof params.maxWaitMs === 'number' && params.maxWaitMs > 0
      ? Math.floor(params.maxWaitMs)
      : undefined;
  const maxBatchSize =
    typeof params.maxBatchSize === 'number' && params.maxBatchSize > 0
      ? Math.floor(params.maxBatchSize)
      : undefined;

  const clock = params.clock ?? { now: () => Date.now() };
  const timers = params.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };

  const pending = new Map<string, PendingBatch<TMessage>>();

  const clearTimers = (batch: PendingBatch<TMessage>) => {
    if (batch.idleTimer !== null) {
      timers.clearTimeout(batch.idleTimer);
      batch.idleTimer = null;
    }
    if (batch.maxWaitTimer !== null) {
      timers.clearTimeout(batch.maxWaitTimer);
      batch.maxWaitTimer = null;
    }
  };

  const doFlush = (key: string, reason: FlushReason): FlushedBatch<TMessage> | null => {
    const batch = pending.get(key);
    if (!batch || batch.messages.length === 0) return null;

    clearTimers(batch);
    pending.delete(key);

    const flushed: FlushedBatch<TMessage> = {
      key,
      messages: batch.messages,
      firstAt: batch.firstAt,
      lastAt: batch.lastAt,
      reason,
    };
    onFlush(flushed);
    return flushed;
  };

  const scheduleIdleFlush = (key: string, batch: PendingBatch<TMessage>) => {
    if (batch.idleTimer !== null) timers.clearTimeout(batch.idleTimer);
    batch.idleTimer = timers.setTimeout(() => {
      doFlush(key, 'idle');
    }, waitMs);
  };

  const push: InboundDebouncer<TMessage>['push'] = (key, message) => {
    const now = clock.now();
    const existing = pending.get(key);

    if (existing) {
      existing.messages.push(message);
      existing.lastAt = now;
      scheduleIdleFlush(key, existing);

      if (maxBatchSize && existing.messages.length >= maxBatchSize) {
        doFlush(key, 'max-batch');
      }
      return;
    }

    // New batch for this sender
    const newBatch: PendingBatch<TMessage> = {
      messages: [message],
      firstAt: now,
      lastAt: now,
      idleTimer: null,
      maxWaitTimer: null,
    };
    pending.set(key, newBatch);

    // Schedule max-wait timer once per batch
    if (maxWaitMs) {
      newBatch.maxWaitTimer = timers.setTimeout(() => {
        doFlush(key, 'max-wait');
      }, maxWaitMs);
    }

    scheduleIdleFlush(key, newBatch);
  };

  const flush: InboundDebouncer<TMessage>['flush'] = (key) => {
    return doFlush(key, 'flush');
  };

  const flushAll: InboundDebouncer<TMessage>['flushAll'] = () => {
    const results: FlushedBatch<TMessage>[] = [];
    for (const key of [...pending.keys()]) {
      const flushed = doFlush(key, 'flush');
      if (flushed) results.push(flushed);
    }
    return results;
  };

  const pendingCount: InboundDebouncer<TMessage>['pending'] = (key) => {
    return pending.get(key)?.messages.length ?? 0;
  };

  const pendingSendersCount: InboundDebouncer<TMessage>['pendingSenders'] = () => {
    return pending.size;
  };

  const cancel: InboundDebouncer<TMessage>['cancel'] = () => {
    for (const batch of pending.values()) {
      clearTimers(batch);
    }
    pending.clear();
  };

  return {
    push,
    flush,
    flushAll,
    pending: pendingCount,
    pendingSenders: pendingSendersCount,
    cancel,
  };
}
