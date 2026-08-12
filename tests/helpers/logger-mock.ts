import { vi } from 'vitest';
import type { Logger } from 'pino';

/** Fresh 5-key mock set — the per-level shape loggerMock() hands out. */
function fns() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  };
}

/**
 * Module factory for `vi.mock('../../src/logger.ts', ...)`: no `trace` key,
 * non-recursive `child()` returning a flat object with `level: 'error'` —
 * the exact shape the migrated suites always used. Consumers needing a
 * different shape should keep a local factory rather than widen this one.
 */
export function loggerMock() {
  return {
    createChildLogger: () => ({
      ...fns(),
      child: () => ({ ...fns(), level: 'error' }),
    }),
  };
}

/**
 * Bare 4-key singleton child logger (`info`/`warn`/`error`/`debug`; no
 * `fatal`, no `child`, no `level`) for suites that walk the object
 * (`Object.values(...).forEach(m => m.mockClear())`) or assert on it
 * directly. Call once per file and reuse the returned object — each call
 * returns a fresh, independent one. Full contract:
 * tests/helpers/logger-mock.test.ts.
 */
export function singletonLoggerMock() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/** The walkable singleton shape returned by {@link singletonLoggerMock}. */
export type SingletonLoggerMock = ReturnType<typeof singletonLoggerMock>;

/**
 * Bridge for suites keeping a `vi.hoisted` ref that the `vi.mock` factory
 * closes over: assigns a fresh singleton's mocks onto `target` (hoisted-ref
 * assertions see the same `vi.fn()`s) and returns the bare walkable
 * `singleton` plus a `createChildLogger` whose loggers spread the singleton
 * and add a recursive `child: vi.fn().mockReturnThis()`.
 */
export function hoistedLoggerMock(target: Record<string, unknown>) {
  const singleton = singletonLoggerMock();
  Object.assign(target, singleton);
  return {
    singleton,
    createChildLogger: () => ({ ...singleton, child: vi.fn().mockReturnThis() }),
  };
}

/**
 * Full `src/logger.ts` module shape for `vi.doMock`/`vi.mock` factories:
 * `default` (5-key incl. `fatal`, recursive `child`), `createChildLogger`
 * returning that same default instance, and an async no-op `flushLogger`.
 * Build it once in setup scope and assert through the kept handle
 * (`mod.default.fatal`, `mod.flushLogger`).
 */
export function loggerModuleMock() {
  const logger = { ...fns(), child: vi.fn().mockReturnThis() };
  return {
    default: logger,
    createChildLogger: vi.fn((_name: string) => logger),
    flushLogger: vi.fn(async () => {}),
  };
}

/**
 * Component-scoped capture: the returned `createChildLogger` hands the SAME
 * walkable singleton (`log`) to the named component and delegates every
 * other component to `fallback` — pass the real `createChildLogger` there to
 * keep unrelated components on the real logger. Without `fallback`,
 * unmatched components get fresh, unshared singletons.
 */
export function componentLoggerMock(name: string, fallback?: (component: string) => unknown) {
  const log = singletonLoggerMock();
  return {
    log,
    createChildLogger: (component: string) =>
      component === name ? log : fallback ? fallback(component) : singletonLoggerMock(),
  };
}

/** Cast a mock logger to pino's `Logger` for APIs typed against it. */
export function asMockLogger(mock: object): Logger {
  return mock as unknown as Logger;
}

/**
 * Clear call history on every `vi.fn()` in a mock logger — scoped to the
 * one object, never a global `clearMocks` flip. Non-mock values pass
 * through untouched, so any mock-logger shape is accepted.
 */
export function resetLoggerMock(mock: Record<string, unknown>): void {
  for (const value of Object.values(mock)) {
    if (vi.isMockFunction(value)) value.mockClear();
  }
}
