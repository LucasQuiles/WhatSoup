// src/transport/contract/queue.ts

export interface QueueCounters {
  enqueued: number;
  dequeued: number;
  overflowed: number;        // tryEnqueue returned false
  dropped: number;           // dropOldest invoked
}

interface Slot<T> { value: T; enqueuedAt: number; }

/**
 * Single-producer / single-consumer bounded queue with observability counters.
 *
 * tryEnqueue() never blocks; returns false on overflow. Callers decide whether to
 * drop, redirect, or degrade. The queue itself does NOT auto-drop on overflow —
 * that policy belongs to the loss-policy logic in the dispatcher.
 */
export class BoundedQueue<T> {
  private readonly buf: Array<Slot<T>> = [];
  private readonly cap: number;
  readonly counters: QueueCounters = {
    enqueued: 0, dequeued: 0, overflowed: 0, dropped: 0,
  };

  constructor(capacity: number) {
    if (capacity < 1) throw new Error(`BoundedQueue capacity must be >= 1, got ${capacity}`);
    this.cap = capacity;
  }

  get size(): number { return this.buf.length; }
  get capacity(): number { return this.cap; }

  tryEnqueue(value: T): boolean {
    if (this.buf.length >= this.cap) {
      this.counters.overflowed += 1;
      return false;
    }
    this.buf.push({ value, enqueuedAt: Date.now() });
    this.counters.enqueued += 1;
    return true;
  }

  tryDequeue(): T | undefined {
    const slot = this.buf.shift();
    if (slot === undefined) return undefined;
    this.counters.dequeued += 1;
    return slot.value;
  }

  /** Drops the oldest item; returns it. Increments dropped counter. */
  dropOldest(): T | undefined {
    const slot = this.buf.shift();
    if (slot === undefined) return undefined;
    this.counters.dropped += 1;
    return slot.value;
  }

  oldestAgeMs(): number {
    const head = this.buf[0];
    return head === undefined ? 0 : Date.now() - head.enqueuedAt;
  }
}
