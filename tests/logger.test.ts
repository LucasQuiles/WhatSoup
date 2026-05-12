/**
 * Direct unit coverage for src/logger.ts.
 *
 * The module exposes:
 * - default `logger` (pino instance configured from LOG_LEVEL + LOG_DIR env)
 * - `createChildLogger(name)` — child logger with `{ component: name }` binding
 * - `flushLogger()` — async flush helper for graceful shutdown
 *
 * 78 test files import from this module indirectly; no direct mirror test
 * exists. This file pins the public-API surface: child-logger contract,
 * flush behavior when no file transport is active (the default test-env
 * case), and the default logger's structural shape.
 */
import { describe, expect, it } from 'vitest';
import logger, { createChildLogger, flushLogger } from '../src/logger';

describe('default logger', () => {
  it('exposes the standard pino API surface (info/warn/error/debug/fatal/trace/child)', () => {
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.fatal).toBe('function');
    expect(typeof logger.trace).toBe('function');
    expect(typeof logger.child).toBe('function');
  });

  it('has a configured log level (string, from LOG_LEVEL env or default "info")', () => {
    expect(typeof logger.level).toBe('string');
    expect(logger.level.length).toBeGreaterThan(0);
  });
});

describe('createChildLogger', () => {
  it('returns a child logger with the component binding set to the requested name', () => {
    const child = createChildLogger('test-component');
    expect(child.bindings()).toEqual({ component: 'test-component' });
  });

  it('child loggers inherit the parent log level', () => {
    const child = createChildLogger('test-component');
    expect(child.level).toBe(logger.level);
  });

  it('child loggers expose the standard pino API surface', () => {
    const child = createChildLogger('test-component');
    expect(typeof child.info).toBe('function');
    expect(typeof child.warn).toBe('function');
    expect(typeof child.error).toBe('function');
  });

  it('two distinct names produce distinct bindings', () => {
    const a = createChildLogger('alpha');
    const b = createChildLogger('beta');
    expect(a.bindings()).toEqual({ component: 'alpha' });
    expect(b.bindings()).toEqual({ component: 'beta' });
  });

  it('calling info/warn/error does not throw with structured payload', () => {
    const child = createChildLogger('throw-check');
    expect(() => child.info({ field: 'value' }, 'message')).not.toThrow();
    expect(() => child.warn('plain string')).not.toThrow();
    expect(() => child.error(new Error('boom'), 'with error')).not.toThrow();
  });
});

describe('flushLogger', () => {
  it('returns a Promise', () => {
    const result = flushLogger();
    expect(result).toBeInstanceOf(Promise);
    return result;
  });

  it('resolves promptly when no file transport is active (default test env, no LOG_DIR set)', async () => {
    // The test env does not set LOG_DIR, so `transport` is undefined and
    // flushLogger() returns Promise.resolve(). This must complete in under
    // 100ms — well under the 2000ms safety timeout the implementation uses
    // when an actual transport is present.
    const start = Date.now();
    await flushLogger();
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(100);
  });

  it('safe to call repeatedly (idempotent) — each call returns a distinct fresh Promise', async () => {
    const p1 = flushLogger();
    const p2 = flushLogger();
    const p3 = flushLogger();
    // Each invocation returns its own Promise (factory, not memoized).
    expect(p1).not.toBe(p2);
    expect(p2).not.toBe(p3);
    expect(p1).toBeInstanceOf(Promise);
    expect(p2).toBeInstanceOf(Promise);
    expect(p3).toBeInstanceOf(Promise);
    // All three resolve within the no-transport fast path (<100ms total).
    const start = Date.now();
    await Promise.all([p1, p2, p3]);
    expect(Date.now() - start).toBeLessThan(100);
  });
});
