/**
 * An unreadable tmp dir must not silently disable cleanup forever — the first
 * failure per directory warns (one-shot, since cleanup runs on an interval).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const tmpLogWarn = vi.hoisted(() => vi.fn());

vi.mock('../../src/logger.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/logger.ts')>();
  return {
    ...orig,
    createChildLogger: (name: string) => {
      const real = orig.createChildLogger(name);
      if (name !== 'process-tmp:retention') return real;
      return new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === 'warn') {
            return (fields: unknown, msg?: string) => {
              tmpLogWarn(fields, msg);
              return (target as { warn: (f: unknown, m?: string) => unknown }).warn(fields, msg);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    },
  };
});

import { runProcessTmpCleanup } from '../../src/core/process-tmp-retention.ts';

describe('runProcessTmpCleanup on an unreadable directory', () => {
  beforeEach(() => {
    tmpLogWarn.mockClear();
  });

  it('returns the empty result and warns once per directory', () => {
    const missing = '/nonexistent/whatsoup-tmp-retention-probe';

    const first = runProcessTmpCleanup(missing, 1000);
    expect(first).toEqual({ deleted: 0, skipped: 0, bytesFreed: 0 });
    const warns = tmpLogWarn.mock.calls.filter(([, msg]) =>
      typeof msg === 'string' && msg.includes('cleanup disabled'));
    expect(warns).toHaveLength(1);
    expect(warns[0][0]).toMatchObject({ dir: missing });

    // Second run on the same dir: no additional warn (one-shot).
    runProcessTmpCleanup(missing, 1000);
    const warnsAfter = tmpLogWarn.mock.calls.filter(([, msg]) =>
      typeof msg === 'string' && msg.includes('cleanup disabled'));
    expect(warnsAfter).toHaveLength(1);
  });
});
