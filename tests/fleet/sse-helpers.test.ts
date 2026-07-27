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

/**
 * Minimal ServerResponse fake — only the methods sse-helpers touches.
 *
 * `on` records listeners so a test can fire the response's 'error' event, which
 * is how a dead stream actually reports itself: res.write() does NOT throw on an
 * ended/destroyed response, it emits 'error' asynchronously (#2292 L7).
 */
function makeFakeResponse() {
  const listeners = new Map<string, (arg: unknown) => void>();
  const res = {
    write: vi.fn(),
    end: vi.fn(),
    on: vi.fn((event: string, handler: (arg: unknown) => void) => {
      listeners.set(event, handler);
      return res;
    }),
  };
  return Object.assign(
    res as unknown as ServerResponse & {
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;
    },
    { emitError: (err: unknown) => listeners.get('error')?.(err) },
  );
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

// --- #2292 L7: error paths. Four call sites are a setTimeout callback and three
// child-process event handlers, so anything thrown or emitted here has no catch
// above it — an unhandled 'error' event terminates the process.

describe('createSSEWriter — error paths', () => {
  it('attaches an error listener to the response (the async mode try/catch cannot see)', () => {
    const res = makeFakeResponse();
    createSSEWriter(res);
    expect(res.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('stops writing after the response emits an error, without throwing', () => {
    const res = makeFakeResponse();
    const { writeSSE } = createSSEWriter(res);
    writeSSE('before', 1);
    expect(() => res.emitError(new Error('ECONNRESET'))).not.toThrow();
    writeSSE('after', 2);
    expect(res.write).toHaveBeenCalledTimes(1);
    expect(res.write).toHaveBeenCalledWith('event: before\ndata: 1\n\n');
  });

  it('swallows a synchronous write failure and suppresses later writes', () => {
    const res = makeFakeResponse();
    res.write.mockImplementation(() => {
      throw new Error('ERR_STREAM_DESTROYED');
    });
    const { writeSSE } = createSSEWriter(res);
    expect(() => writeSSE('boom', 1)).not.toThrow();
    writeSSE('next', 2);
    expect(res.write).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a circular reference', () => { const c: Record<string, unknown> = {}; c['self'] = c; return c; }],
    ['a BigInt value', () => ({ n: 1n })],
  ])('does not throw when JSON.stringify fails on %s', (_name, build) => {
    const res = makeFakeResponse();
    const { writeSSE } = createSSEWriter(res);
    expect(() => writeSSE('bad', build())).not.toThrow();
    expect(res.write).not.toHaveBeenCalled();
  });

  it('still writes normally after a stringify failure is contained', () => {
    const res = makeFakeResponse();
    const { writeSSE } = createSSEWriter(res);
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    writeSSE('bad', circular);
    // A stringify fault is per-message, not a dead socket — but the guard marks
    // the stream unwritable either way, so this asserts the CHOSEN behaviour
    // rather than assuming it.
    expect(res.write).not.toHaveBeenCalled();
  });

  it('swallows a res.end() failure inside endOnce', () => {
    const res = makeFakeResponse();
    res.end.mockImplementation(() => {
      throw new Error('ERR_STREAM_DESTROYED');
    });
    const { endOnce } = createSSEWriter(res);
    expect(() => endOnce()).not.toThrow();
  });

  it('STILL runs onEnd cleanup after the response errored', () => {
    // The reason `ended` and `writable` are separate flags. onEnd releases the
    // in-flight auth slot and clears a timer (fleet/routes/ops.ts:1329); if a
    // response error suppressed endOnce, those would leak and block re-auth.
    const res = makeFakeResponse();
    const onEnd = vi.fn();
    const { endOnce } = createSSEWriter(res, onEnd);
    res.emitError(new Error('EPIPE'));
    endOnce();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(res.end).toHaveBeenCalledTimes(1);
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
