/**
 * Shared SSE (Server-Sent Events) helper factory for fleet routes.
 *
 * Returns a pair of closures that write SSE events to a ServerResponse and
 * guard against double-end. The caller is responsible for setting the
 * appropriate response headers before calling any of the returned functions.
 *
 * Failure handling (#2292 L7) — there are TWO distinct modes, and they need
 * different remedies:
 *
 *  - `JSON.stringify(data)` throws SYNCHRONOUSLY on a circular reference or a
 *    BigInt, so a try/catch around the write body catches it.
 *  - `res.write()` on an ended/destroyed response does NOT throw. It emits an
 *    `'error'` event asynchronously, which a try/catch can never see. With no
 *    listener attached, Node treats it as an unhandled `'error'` event and
 *    terminates the process.
 *
 * Both matter here because four of the call sites are a `setTimeout` callback
 * and three child-process event handlers (`fleet/routes/ops.ts`), where nothing
 * upstream catches a throw — a client disconnecting mid-authentication is
 * enough to reach them with a dead response. The listener is attached here
 * rather than documented as a caller obligation, so no call site can forget it.
 *
 * Two flags, deliberately not one: `ended` guards endOnce's idempotence, while
 * `writable` tracks whether the stream can still accept bytes. Collapsing them
 * would let a response error suppress `endOnce`, and `onEnd` performs real
 * cleanup (releasing in-flight auth slots and clearing a timer) that must run
 * even when the stream dies.
 */
import type { ServerResponse } from 'node:http';
import { createChildLogger } from '../logger.ts';

const log = createChildLogger('fleet:sse');

export interface SSEWriter {
  writeSSE: (event: string, data: unknown) => void;
  endOnce: () => void;
}

export function createSSEWriter(res: ServerResponse, onEnd?: () => void): SSEWriter {
  let ended = false;
  let writable = true;

  res.on('error', (err) => {
    writable = false;
    log.warn({ err }, 'SSE response errored; suppressing further writes');
  });

  const endOnce = () => {
    if (ended) return;
    ended = true;
    writable = false;
    onEnd?.();
    try {
      res.end();
    } catch (err) {
      log.warn({ err }, 'SSE response end failed');
    }
  };

  const writeSSE = (event: string, data: unknown) => {
    if (!writable) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (err) {
      // Stop writing rather than re-throwing into a timer or event handler that
      // has no catch above it.
      writable = false;
      log.warn({ err, event }, 'SSE write failed; suppressing further writes');
    }
  };

  return { writeSSE, endOnce };
}
