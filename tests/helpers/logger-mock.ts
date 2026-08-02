import { vi } from 'vitest';

/**
 * Module factory for `vi.mock('../../src/logger.ts', ...)`. Deliberately
 * replicates the shape the migrated suites always used: no `trace` key, and a
 * non-recursive `child()` returning a flat object with `level: 'error'`.
 * Consumers needing a different shape should keep a local factory rather than
 * widen this one.
 */
export function loggerMock() {
  return {
    createChildLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      child: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        fatal: vi.fn(),
        level: 'error',
      }),
    }),
  };
}

/**
 * Bare 4-key, non-recursive singleton child logger: `info`/`warn`/`error`/
 * `debug` only — no `fatal`, no `child` key, no `level`. For suites whose
 * test body walks the mock object itself (`Object.values(...).forEach(mock
 * => mock.mockClear())`) or asserts directly on it (`expect(mock.error)
 * .toHaveBeenCalledWith(...)`): those patterns require every value in the
 * object to be a `vi.fn()`, and require the SAME object instance on every
 * call so assertions target what the code under test actually logged
 * through. Call this once per test file (inside the `vi.mock()` factory)
 * and reuse the single returned object everywhere a logger is needed —
 * do not call it more than once per file, since each call returns a
 * fresh, independent object. Consumers needing a `.child()` method should
 * wrap this return (e.g. `{ ...singletonLoggerMock(), child: () =>
 * singleton }`), not extend this function, to keep the object this
 * function returns walkable by `Object.values(...).mockClear()`.
 */
export function singletonLoggerMock() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}
