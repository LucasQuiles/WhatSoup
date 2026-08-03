/**
 * Unit tests for the clock abstraction (src/lib/clock.ts).
 *
 * Regression protection for #2200 slice 1: verifies SystemClock returns
 * real wall-clock time and FakeClock returns controlled, advanceable time.
 */
import { describe, expect, it } from 'vitest';

import { Clock, fakeClock, systemClock } from '../../src/lib/clock.ts';

describe('systemClock', () => {
  it('now() returns epoch-ms close to Date.now()', () => {
    const before = Date.now();
    const result = systemClock.now();
    const after = Date.now();
    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after);
  });

  it('nowIso() returns an ISO 8601 UTC string', () => {
    const iso = systemClock.nowIso();
    // ISO 8601 UTC ends with 'Z'
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  it('nowUnixSec() returns integer epoch-seconds', () => {
    const sec = systemClock.nowUnixSec();
    expect(Number.isInteger(sec)).toBe(true);
    // Sanity: epoch-seconds is roughly now/1000
    const expected = Math.floor(Date.now() / 1000);
    expect(Math.abs(sec - expected)).toBeLessThanOrEqual(2);
  });

  it('implements the Clock interface', () => {
    // Type-level check: systemClock is assignable to Clock.
    const c: Clock = systemClock;
    expect(typeof c.now).toBe('function');
    expect(typeof c.nowIso).toBe('function');
    expect(typeof c.nowUnixSec).toBe('function');
  });
});

describe('fakeClock', () => {
  it('starts at the initial value (default 0)', () => {
    const fc = fakeClock();
    expect(fc.now()).toBe(0);
  });

  it('starts at a provided initial value', () => {
    const fc = fakeClock(1_000_000);
    expect(fc.now()).toBe(1_000_000);
  });

  it('advance() moves time forward by deltaMs', () => {
    const fc = fakeClock(1_000);
    fc.advance(500);
    expect(fc.now()).toBe(1_500);
  });

  it('set() moves time to an absolute epoch-ms value', () => {
    const fc = fakeClock(0);
    fc.set(99_999);
    expect(fc.now()).toBe(99_999);
  });

  it('nowUnixSec() floors to integer seconds', () => {
    const fc = fakeClock(1_999);
    // 1999 ms → 1 second (floored)
    expect(fc.nowUnixSec()).toBe(1);
  });

  it('nowIso() serializes the current fake time', () => {
    // 1970-01-01T00:00:01.000Z = epoch 1000ms
    const fc = fakeClock(1_000);
    expect(fc.nowIso()).toBe('1970-01-01T00:00:01.000Z');
  });

  it('advance() is cumulative across calls', () => {
    const fc = fakeClock(100);
    fc.advance(50);
    fc.advance(50);
    fc.advance(100);
    expect(fc.now()).toBe(300);
  });

  it('implements the Clock interface', () => {
    const c: Clock = fakeClock(0);
    expect(typeof c.now).toBe('function');
    expect(typeof c.nowIso).toBe('function');
    expect(typeof c.nowUnixSec).toBe('function');
  });
});
