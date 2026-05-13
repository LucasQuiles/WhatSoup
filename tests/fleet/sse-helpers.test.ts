/**
 * Direct unit coverage for src/fleet/sse-helpers.ts.
 *
 * `createSSEWriter(res, onEnd?)` returns a pair of closures:
 *   - writeSSE(event, data) → res.write(`event: ${event}\ndata: ${JSON}\n\n`)
 *   - endOnce() → res.end() + onEnd?.(), guarded so it runs at most once.
 *
 * Writes after endOnce() must be no-ops. No prior test mirror.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import { createSSEWriter } from '../../src/fleet/sse-helpers.ts';

/** Minimal ServerResponse fake — only the methods sse-helpers touches. */
function makeFakeResponse() {
  return {
    write: vi.fn(),
    end: vi.fn(),
  } as unknown as ServerResponse & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
}

describe('createSSEWriter — writeSSE', () => {
  it('writes the canonical SSE frame: event: <name>\\ndata: <json>\\n\\n', () => {
    const res = makeFakeResponse();
    const { writeSSE } = createSSEWriter(res);
    writeSSE('progress', { step: 1 });
    expect(res.write).toHaveBeenCalledTimes(1);
    expect(res.write).toHaveBeenCalledWith('event: progress\ndata: {"step":1}\n\n');
  });

  it('JSON-stringifies arbitrary data shapes including strings, arrays, null', () => {
    const res = makeFakeResponse();
    const { writeSSE } = createSSEWriter(res);
    writeSSE('a', 'literal');
    writeSSE('b', [1, 2, 3]);
    writeSSE('c', null);
    expect(res.write).toHaveBeenNthCalledWith(1, 'event: a\ndata: "literal"\n\n');
    expect(res.write).toHaveBeenNthCalledWith(2, 'event: b\ndata: [1,2,3]\n\n');
    expect(res.write).toHaveBeenNthCalledWith(3, 'event: c\ndata: null\n\n');
  });

  it('emits each call as a separate res.write (frames not batched)', () => {
    const res = makeFakeResponse();
    const { writeSSE } = createSSEWriter(res);
    writeSSE('x', 1);
    writeSSE('y', 2);
    writeSSE('z', 3);
    expect(res.write).toHaveBeenCalledTimes(3);
  });
});

describe('createSSEWriter — endOnce', () => {
  it('calls res.end() exactly once', () => {
    const res = makeFakeResponse();
    const { endOnce } = createSSEWriter(res);
    endOnce();
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: repeated calls do NOT call res.end() again', () => {
    const res = makeFakeResponse();
    const { endOnce } = createSSEWriter(res);
    endOnce();
    endOnce();
    endOnce();
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('invokes the onEnd callback exactly once when provided', () => {
    const res = makeFakeResponse();
    const onEnd = vi.fn();
    const { endOnce } = createSSEWriter(res, onEnd);
    endOnce();
    endOnce();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('skips onEnd invocation when no callback is provided', () => {
    const res = makeFakeResponse();
    // Should not throw even though onEnd is undefined
    expect(() => createSSEWriter(res).endOnce()).not.toThrow();
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('calls onEnd BEFORE res.end (consumer can write final state)', () => {
    const res = makeFakeResponse();
    const order: string[] = [];
    res.end.mockImplementation(() => order.push('end'));
    const onEnd = vi.fn(() => order.push('onEnd'));
    const { endOnce } = createSSEWriter(res, onEnd);
    endOnce();
    expect(order).toEqual(['onEnd', 'end']);
  });
});

describe('createSSEWriter — write-after-end guard', () => {
  it('writeSSE after endOnce is a no-op (no extra res.write call)', () => {
    const res = makeFakeResponse();
    const { writeSSE, endOnce } = createSSEWriter(res);
    writeSSE('a', 1);
    endOnce();
    writeSSE('b', 2);
    writeSSE('c', 3);
    expect(res.write).toHaveBeenCalledTimes(1);
    expect(res.write).toHaveBeenCalledWith('event: a\ndata: 1\n\n');
  });

  it('endOnce after writeSSE still terminates once', () => {
    const res = makeFakeResponse();
    const { writeSSE, endOnce } = createSSEWriter(res);
    writeSSE('a', 1);
    writeSSE('b', 2);
    endOnce();
    endOnce();
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(res.write).toHaveBeenCalledTimes(2);
  });
});

describe('createSSEWriter — instance isolation', () => {
  it('two writers built from different responses do NOT share ended state', () => {
    const resA = makeFakeResponse();
    const resB = makeFakeResponse();
    const a = createSSEWriter(resA);
    const b = createSSEWriter(resB);
    a.endOnce();
    b.writeSSE('still-live', 1);
    expect(resB.write).toHaveBeenCalledTimes(1);
    expect(resB.end).not.toHaveBeenCalled();
  });
});
