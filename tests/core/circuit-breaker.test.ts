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

  it('logs state transitions when a logger is supplied', () => {
    const info = vi.fn();
    const logger = { info } as unknown as import('pino').Logger;
    const breaker = new CircuitBreaker('logged', 1, 1_000, logger);

    breaker.recordFailure(); // failures(1) >= threshold(1) → transition('open')

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'logged', old: 'closed', new: 'open', failures: 1 }),
      'circuit_breaker_state_change',
    );
    expect(breaker.isOpen()).toBe(true);
  });

  it('a second isOpen() while half-open allows the call without re-transitioning', () => {
    const breaker = new CircuitBreaker('smoke', 1, 1_000);
    breaker.recordFailure(); // → open
    expect(breaker.isOpen()).toBe(true);

    vi.advanceTimersByTime(1_000);
    // 1st call: line 34 TRUE, !probing → transition to 'half-open', returns false (probe allowed).
    expect(breaker.isOpen()).toBe(false);
    // 2nd call: line 32 false, line 34 first operand ('state === open') FALSE, line 42 returns false.
    expect(breaker.isOpen()).toBe(false);
  });

  it('recordSuccess on an already-closed breaker skips the transition', () => {
    const breaker = new CircuitBreaker('smoke', 2, 1_000);
    // state is already 'closed' → line 48 `state !== 'closed'` is false, transition skipped.
    breaker.recordSuccess();
    expect(breaker.isOpen()).toBe(false);
  });
});
