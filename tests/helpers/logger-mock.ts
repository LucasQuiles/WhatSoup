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
