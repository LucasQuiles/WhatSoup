// tests/transport/contract/queue.test.ts
import { afterEach, describe, it, expect, vi } from 'vitest';
import { BoundedQueue } from '../../../src/transport/contract/queue.ts';

describe('BoundedQueue', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects non-positive capacity', () => {
    expect(() => new BoundedQueue<number>(0)).toThrow('capacity must be >= 1');
  });

  it('exposes configured capacity', () => {
    const q = new BoundedQueue<number>(3);
    expect(q.capacity).toBe(3);
  });

  it('tryEnqueue returns true while under capacity', () => {
    const q = new BoundedQueue<number>(3);
    expect(q.tryEnqueue(1)).toBe(true);
    expect(q.tryEnqueue(2)).toBe(true);
    expect(q.tryEnqueue(3)).toBe(true);
  });

  it('tryEnqueue returns false at capacity (no drop semantics — caller decides)', () => {
    const q = new BoundedQueue<number>(2);
    q.tryEnqueue(1);
    q.tryEnqueue(2);
    expect(q.tryEnqueue(3)).toBe(false);
    expect(q.size).toBe(2);
  });

  it('tryDequeue returns FIFO order', () => {
    const q = new BoundedQueue<number>(3);
    q.tryEnqueue(1); q.tryEnqueue(2); q.tryEnqueue(3);
    expect(q.tryDequeue()).toBe(1);
    expect(q.tryDequeue()).toBe(2);
    expect(q.tryDequeue()).toBe(3);
    expect(q.tryDequeue()).toBeUndefined();
  });

  it('counters track enqueued / dequeued / overflowed', () => {
    const q = new BoundedQueue<number>(2);
    q.tryEnqueue(1); q.tryEnqueue(2);
    q.tryEnqueue(3); // overflow
    q.tryDequeue();
    expect(q.counters.enqueued).toBe(2);
    expect(q.counters.dequeued).toBe(1);
    expect(q.counters.overflowed).toBe(1);
  });

  it('oldest_age_ms reflects head age', async () => {
    vi.useFakeTimers();
    const q = new BoundedQueue<number>(2);
    q.tryEnqueue(1);
    await vi.advanceTimersByTimeAsync(25);
    expect(q.oldestAgeMs()).toBeGreaterThanOrEqual(20);
  });

  it('oldest_age_ms returns null for empty queue', () => {
    const q = new BoundedQueue<number>(2);
    expect(q.oldestAgeMs()).toBeNull();
  });

  it('oldest_age_ms returns 0 for an item enqueued at the current clock tick', () => {
    vi.useFakeTimers();
    const q = new BoundedQueue<number>(2);

    q.tryEnqueue(1);

    expect(q.oldestAgeMs()).toBe(0);
  });

  it('dropOldest evicts head and increments dropped counter', () => {
    const q = new BoundedQueue<number>(2);
    q.tryEnqueue(1); q.tryEnqueue(2);
    expect(q.dropOldest()).toBe(1);
    expect(q.size).toBe(1);
    expect(q.counters.dropped).toBe(1);
  });

  it('dropOldest returns undefined without incrementing dropped for an empty queue', () => {
    const q = new BoundedQueue<number>(2);
    expect(q.dropOldest()).toBeUndefined();
    expect(q.counters.dropped).toBe(0);
  });
});
