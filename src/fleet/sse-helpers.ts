/**
 * Shared SSE (Server-Sent Events) helper factory for fleet routes.
 *
 * Returns a pair of closures that write SSE events to a ServerResponse and
 * guard against double-end. The caller is responsible for setting the
 * appropriate response headers before calling any of the returned functions.
 */
import type { ServerResponse } from 'node:http';

export interface SSEWriter {
  writeSSE: (event: string, data: unknown) => void;
  endOnce: () => void;
}

export function createSSEWriter(res: ServerResponse, onEnd?: () => void): SSEWriter {
  let ended = false;

  const endOnce = () => {
    if (!ended) {
      ended = true;
      onEnd?.();
      res.end();
    }
  };

  const writeSSE = (event: string, data: unknown) => {
    if (!ended) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  return { writeSSE, endOnce };
}
