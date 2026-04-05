import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { CircuitBreaker } from '../../src/core/circuit-breaker.ts';

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-05T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('exports a CircuitBreaker class', () => {
    expect(CircuitBreaker).toBeTypeOf('function');
  });

  it('opens after reaching the failure threshold and allows a probe after reset', () => {
    const breaker = new CircuitBreaker('smoke', 2, 1_000);

    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(false);

    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(true);

    vi.advanceTimersByTime(999);
    expect(breaker.isOpen()).toBe(true);

    vi.advanceTimersByTime(1);
    expect(breaker.isOpen()).toBe(false);

    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(true);
  });

  it('closes again after a successful probe and resets the failure count', () => {
    const breaker = new CircuitBreaker('smoke', 2, 1_000);

    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(true);

    vi.advanceTimersByTime(1_000);
    expect(breaker.isOpen()).toBe(false);

    breaker.recordSuccess();
    expect(breaker.isOpen()).toBe(false);

    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(false);

    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(true);
  });
});
