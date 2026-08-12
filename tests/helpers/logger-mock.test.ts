import { describe, expect, it, vi } from 'vitest';

import {
  asMockLogger,
  componentLoggerMock,
  hoistedLoggerMock,
  loggerModuleMock,
  resetLoggerMock,
  singletonLoggerMock,
  type SingletonLoggerMock,
} from './logger-mock.ts';

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

describe('hoistedLoggerMock', () => {
  it('assigns the singleton mocks onto the hoisted target (same vi.fn instances)', () => {
    const target: Record<string, unknown> = {};
    const { singleton } = hoistedLoggerMock(target);

    expect(target.info).toBe(singleton.info);
    expect(target.error).toBe(singleton.error);
    expect(Object.keys(target).sort()).toEqual(['debug', 'error', 'info', 'warn']);
  });

  it('singleton stays bare and walkable — 4 keys, no child, every value a vi.fn()', () => {
    const { singleton } = hoistedLoggerMock({});

    expect(Object.keys(singleton).sort()).toEqual(['debug', 'error', 'info', 'warn']);
    for (const mock of Object.values(singleton)) {
      expect(vi.isMockFunction(mock)).toBe(true);
    }
  });

  it('createChildLogger spreads the singleton mocks, so calls land on the hoisted target', () => {
    const target: Record<string, unknown> = {};
    const { createChildLogger } = hoistedLoggerMock(target);
    const child = createChildLogger();

    child.warn('via child');
    expect(target.warn).toHaveBeenCalledWith('via child');
  });

  it('child is recursive: child.child() returns the child logger itself', () => {
    const { createChildLogger } = hoistedLoggerMock({});
    const child = createChildLogger();

    expect(child.child()).toBe(child);
    expect(child.child().child()).toBe(child);
  });

  it('each createChildLogger call returns a fresh wrapper sharing the same mocks', () => {
    const { singleton, createChildLogger } = hoistedLoggerMock({});
    const first = createChildLogger();
    const second = createChildLogger();

    expect(first).not.toBe(second);
    expect(first.info).toBe(singleton.info);
    expect(second.info).toBe(singleton.info);
  });
});

describe('loggerModuleMock', () => {
  it('exposes exactly the src/logger.ts surface the suites mock: default, createChildLogger, flushLogger', () => {
    const mod = loggerModuleMock();

    expect(Object.keys(mod).sort()).toEqual(['createChildLogger', 'default', 'flushLogger']);
  });

  it('default carries all 5 log levels including fatal, each a vi.fn()', () => {
    const mod = loggerModuleMock();

    for (const key of ['info', 'warn', 'error', 'debug', 'fatal'] as const) {
      expect(vi.isMockFunction(mod.default[key])).toBe(true);
    }
  });

  it('default.child() is recursive — returns the default logger itself', () => {
    const mod = loggerModuleMock();

    expect(mod.default.child()).toBe(mod.default);
  });

  it('createChildLogger returns the SAME default instance (assertions stay on one handle)', () => {
    const mod = loggerModuleMock();

    expect(mod.createChildLogger('any-component')).toBe(mod.default);
    expect(mod.createChildLogger).toHaveBeenCalledWith('any-component');
  });

  it('flushLogger is an async no-op vi.fn()', async () => {
    const mod = loggerModuleMock();

    await expect(mod.flushLogger()).resolves.toBeUndefined();
    expect(mod.flushLogger).toHaveBeenCalledTimes(1);
  });
});

describe('componentLoggerMock', () => {
  it('hands the SAME captured singleton to the named component on every call', () => {
    const { log, createChildLogger } = componentLoggerMock('outbound-audience');

    expect(createChildLogger('outbound-audience')).toBe(log);
    expect(createChildLogger('outbound-audience')).toBe(log);
  });

  it('delegates every other component to the fallback with the component name', () => {
    const real = { real: true };
    const fallback = vi.fn(() => real);
    const { log, createChildLogger } = componentLoggerMock('outbound-audience', fallback);

    expect(createChildLogger('database')).toBe(real);
    expect(fallback).toHaveBeenCalledWith('database');
    expect(createChildLogger('outbound-audience')).toBe(log);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('without a fallback, unmatched components get fresh unshared singletons', () => {
    const { log, createChildLogger } = componentLoggerMock('outbound-audience');
    const other = createChildLogger('database');

    expect(other).not.toBe(log);
    expect(other).not.toBe(createChildLogger('database'));
  });

  it('the captured log is the bare walkable 4-key singleton', () => {
    const { log } = componentLoggerMock('outbound-audience');

    expect(Object.keys(log).sort()).toEqual(['debug', 'error', 'info', 'warn']);
  });
});

describe('asMockLogger + SingletonLoggerMock', () => {
  it('asMockLogger is an identity cast — same reference back, typed as pino Logger', () => {
    const mock = singletonLoggerMock();
    const logger = asMockLogger(mock);

    expect(logger).toBe(mock);
    logger.error('typed call');
    expect(mock.error).toHaveBeenCalledWith('typed call');
  });

  it('SingletonLoggerMock names the singleton shape for annotations', () => {
    // The payload here is the compile-time annotation on the next line; the
    // runtime assertion only keeps the test non-vacuous.
    const typed: SingletonLoggerMock = singletonLoggerMock();

    expect(Object.keys(typed).sort()).toEqual(['debug', 'error', 'info', 'warn']);
  });
});

describe('resetLoggerMock', () => {
  it('clears call history on every vi.fn() without replacing the mocks', () => {
    const logger = singletonLoggerMock();
    const before = logger.error;
    logger.error('boom');
    logger.info('ok');

    resetLoggerMock(logger);

    expect(logger.error).toBe(before);
    expect(logger.error).toHaveBeenCalledTimes(0);
    expect(logger.info).toHaveBeenCalledTimes(0);
  });

  it('passes non-mock values through untouched (mixed shapes like level strings)', () => {
    const mixed = { ...singletonLoggerMock(), level: 'error' };
    mixed.warn('noise');

    expect(() => resetLoggerMock(mixed)).not.toThrow();
    expect(mixed.level).toBe('error');
    expect(mixed.warn).toHaveBeenCalledTimes(0);
  });

  it('is scoped — a second logger keeps its history', () => {
    const cleared = singletonLoggerMock();
    const kept = singletonLoggerMock();
    cleared.debug('a');
    kept.debug('b');

    resetLoggerMock(cleared);

    expect(cleared.debug).toHaveBeenCalledTimes(0);
    expect(kept.debug).toHaveBeenCalledTimes(1);
  });
});
