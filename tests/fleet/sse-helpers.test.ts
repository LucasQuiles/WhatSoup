/**
 * Direct unit coverage for fleet/sse-helpers.ts (createSSEWriter).
 *
 * The helper is consumed by ops.ts and update.ts SSE routes (covered
 * indirectly), but the double-end guard and write-after-end behavior have
 * no direct pin. These tests lock the contract.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import { createSSEWriter } from '../../src/fleet/sse-helpers.ts';

function makeRes() {
  return {
    write: vi.fn((_chunk: string) => true),
    end: vi.fn(),
  } as unknown as ServerResponse & {
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
}

describe('createSSEWriter', () => {
  it('writeSSE formats event/data lines with terminating blank line', () => {
    const res = makeRes();
    const { writeSSE } = createSSEWriter(res);

    writeSSE('progress', { step: 'pull', pct: 50 });

    expect(res.write).toHaveBeenCalledOnce();
    expect(res.write).toHaveBeenCalledWith(
      'event: progress\ndata: {"step":"pull","pct":50}\n\n',
    );
  });

  it('endOnce invokes onEnd then res.end exactly once even when called repeatedly', () => {
    const res = makeRes();
    const onEnd = vi.fn();
    const { endOnce } = createSSEWriter(res, onEnd);

    endOnce();
    endOnce();
    endOnce();

    expect(onEnd).toHaveBeenCalledOnce();
    expect(res.end).toHaveBeenCalledOnce();
  });

  it('writeSSE after endOnce is suppressed (no res.write call)', () => {
    const res = makeRes();
    const { writeSSE, endOnce } = createSSEWriter(res);

    writeSSE('start', {});
    endOnce();
    writeSSE('after', { ignored: true });

    expect(res.write).toHaveBeenCalledOnce();
    expect(res.write).toHaveBeenCalledWith('event: start\ndata: {}\n\n');
  });

  it('endOnce without onEnd callback ends the response without throwing', () => {
    const res = makeRes();
    const { endOnce } = createSSEWriter(res);

    expect(() => endOnce()).not.toThrow();
    expect(res.end).toHaveBeenCalledOnce();
  });
});
