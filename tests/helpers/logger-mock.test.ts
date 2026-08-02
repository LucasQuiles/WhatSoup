import { describe, expect, it } from 'vitest';

import { singletonLoggerMock } from './logger-mock.ts';

describe('singletonLoggerMock', () => {
  it('exposes exactly the 4 mock keys, no fatal, no child, no level', () => {
    const logger = singletonLoggerMock();

    expect(Object.keys(logger).sort()).toEqual(['debug', 'error', 'info', 'warn']);
  });

  it('every key is a vi.fn(), safe for Object.values(...).forEach(mockClear)', () => {
    const logger = singletonLoggerMock();

    for (const mock of Object.values(logger)) {
      expect(mock).toHaveProperty('mock');
      expect(() => mock.mockClear()).not.toThrow();
    }
  });

  it('mockClear resets call history without breaking the mock', () => {
    const logger = singletonLoggerMock();

    logger.error('boom');
    expect(logger.error).toHaveBeenCalledTimes(1);

    for (const mock of Object.values(logger)) mock.mockClear();

    expect(logger.error).toHaveBeenCalledTimes(0);
    logger.error('again');
    expect(logger.error).toHaveBeenCalledWith('again');
  });

  it('a caller-built child() wrapper returns the SAME object (identity, not a new mock)', () => {
    const singleton = singletonLoggerMock();
    const wrapped = { ...singleton, child: () => singleton };

    expect(wrapped.child()).toBe(singleton);
    expect(wrapped.child()).toBe(wrapped.child());
  });

  it('two calls return independent objects (not a module-level singleton)', () => {
    const first = singletonLoggerMock();
    const second = singletonLoggerMock();

    expect(first).not.toBe(second);
    expect(first.info).not.toBe(second.info);
  });
});
