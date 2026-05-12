import { BoundedQueue } from './queue.ts';
import { makeSubscription, type Subscription } from './subscription.ts';
import { isDurableEventKind, type InboundEvent } from './events.ts';

export interface FanoutOptions {
  readonly perSubscriberCapacity: number;
  readonly subscriberTimeoutMs: number;
  readonly overflowThreshold: number;
  readonly consecutiveTimeoutThreshold: number;
  readonly persistDurableEvent?: (event: InboundEvent) => void;
}

export type SubscriberHandler = (event: InboundEvent) => void | Promise<void>;

interface SubscriberState {
  id: string;
  handler: SubscriberHandler;
  queue: BoundedQueue<InboundEvent>;
  draining: boolean;
  suspended: boolean;
  consecutiveTimeouts: number;
  consecutiveOverflows: number;
}

export interface FanoutMetrics {
  subscriberFailures: Map<string, number>;
  subscriberOverflow: Map<string, number>;
  subscriberSuspensions: Map<string, string>; // id → reason
  droppedForSuspended: number;
}

export class FanoutDispatcher {
  private readonly subs = new Map<string, SubscriberState>();
  private readonly opts: FanoutOptions;
  private readonly drains: Set<Promise<void>> = new Set();
  private disposed = false;

  readonly metrics: FanoutMetrics = {
    subscriberFailures: new Map(),
    subscriberOverflow: new Map(),
    subscriberSuspensions: new Map(),
    droppedForSuspended: 0,
  };

  constructor(opts: FanoutOptions) {
    this.opts = opts;
  }

  subscribe(id: string, handler: SubscriberHandler): Subscription {
    if (this.disposed) {
      throw new Error('FanoutDispatcher is disposed');
    }
    if (this.subs.has(id)) {
      throw new Error(`subscriber id already registered: ${id}`);
    }
    const sub: SubscriberState = {
      id, handler,
      queue: new BoundedQueue<InboundEvent>(this.opts.perSubscriberCapacity),
      draining: false,
      suspended: false,
      consecutiveTimeouts: 0,
      consecutiveOverflows: 0,
    };
    this.subs.set(id, sub);
    return makeSubscription(() => {
      // Mark suspended BEFORE removing from the map so an already-running
      // drainLoop sees the signal on its next iteration and stops delivering
      // already-queued events to the disposed handler.
      const live = this.subs.get(id);
      if (live !== undefined) live.suspended = true;
      this.subs.delete(id);
    });
  }

  isSuspended(id: string): boolean {
    return this.subs.get(id)?.suspended ?? false;
  }

  enqueue(event: InboundEvent): void {
    if (this.disposed) return;
    if (isDurableEventKind(event.kind)) {
      this.opts.persistDurableEvent?.(event);
    }
    for (const sub of this.subs.values()) {
      if (sub.suspended) {
        this.metrics.droppedForSuspended += 1;
        continue;
      }
      const enqueued = sub.queue.tryEnqueue(event);
      if (!enqueued) {
        const next = (this.metrics.subscriberOverflow.get(sub.id) ?? 0) + 1;
        this.metrics.subscriberOverflow.set(sub.id, next);
        sub.consecutiveOverflows += 1;
        if (sub.consecutiveOverflows >= this.opts.overflowThreshold) {
          this.suspend(sub, 'overflow');
        }
        continue;
      }
      sub.consecutiveOverflows = 0;
      this.kickDrain(sub);
    }
  }

  /** Awaits completion of all currently-active drain loops. Tests use this to be deterministic. */
  async flush(): Promise<void> {
    while (this.drains.size > 0) {
      await Promise.allSettled(Array.from(this.drains));
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      await this.flush();
      return;
    }
    this.disposed = true;
    for (const sub of this.subs.values()) {
      this.suspend(sub, 'disposed');
    }
    this.subs.clear();
    await this.flush();
  }

  private kickDrain(sub: SubscriberState): void {
    if (sub.draining) return;
    sub.draining = true;
    const p = this.drainLoop(sub).finally(() => {
      sub.draining = false;
      this.drains.delete(p);
    });
    this.drains.add(p);
  }

  private async drainLoop(sub: SubscriberState): Promise<void> {
    while (sub.queue.size > 0 && !sub.suspended) {
      const event = sub.queue.tryDequeue();
      if (event === undefined) break;

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<'timeout'>(resolve => {
        timer = setTimeout(() => resolve('timeout'), this.opts.subscriberTimeoutMs);
      });

      const result = await Promise.race([
        (async () => sub.handler(event))().then(() => 'ok' as const).catch((e: unknown) => ({ err: e })),
        timeoutPromise,
      ]);
      if (timer !== undefined) clearTimeout(timer);

      if (result === 'timeout') {
        sub.consecutiveTimeouts += 1;
        this.bumpFailure(sub.id);
        if (sub.consecutiveTimeouts >= this.opts.consecutiveTimeoutThreshold) {
          this.suspend(sub, 'timeout');
        }
      } else if (typeof result === 'object' && 'err' in result) {
        this.bumpFailure(sub.id);
        sub.consecutiveTimeouts = 0;
      } else {
        sub.consecutiveTimeouts = 0;
      }
    }
  }

  private bumpFailure(id: string): void {
    const next = (this.metrics.subscriberFailures.get(id) ?? 0) + 1;
    this.metrics.subscriberFailures.set(id, next);
  }

  private suspend(sub: SubscriberState, reason: string): void {
    sub.suspended = true;
    this.metrics.subscriberSuspensions.set(sub.id, reason);
  }
}
