/**
 * Dashboard-independent fleet liveness route (`/livez`).
 *
 * The fleet console is served from built static assets under `dist/`. Those
 * assets are absent from an immutable release when the release cut omits the
 * console build, so the console root (`/`) 404s even though the fleet process
 * is healthy and serving its API. A watchdog that decides restarts by curling
 * `/` therefore restart-loops the fleet service on a purely cosmetic packaging
 * gap (observed on mini7: 249 fleet restarts driven by a 9099 `/` 404).
 *
 * `/livez` answers from process state alone — no `dist/` assets, no database,
 * no auth, no request-body read — so a watchdog can distinguish "process is
 * serving" (200) from "console assets missing" (root 404). It is intended to be
 * probed unauthenticated over loopback, exactly like the previous root probe,
 * but without the asset dependency.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface LivenessOptions {
  /** This instance's fleet name (e.g. the host's self name). */
  selfName: string;
  /** Process start time in epoch ms, used to derive uptime. */
  startedAtMs: number;
}

/** The single path this handler owns. */
export const LIVENESS_PATH = '/livez';

/**
 * Build a liveness handler. Returns `true` when it has handled the request
 * (path matched `/livez`), `false` otherwise so the caller can continue its
 * own routing — mirroring `createStaticHandler`'s contract.
 */
export function createLivenessHandler(
  opts: LivenessOptions,
): (req: IncomingMessage, res: ServerResponse) => boolean {
  return function livenessHandler(req: IncomingMessage, res: ServerResponse): boolean {
    const method = req.method ?? 'GET';
    const pathname = (req.url ?? '/').split('?')[0];
    if (pathname !== LIVENESS_PATH) return false;
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET, HEAD' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return true;
    }

    const body = JSON.stringify({
      alive: true,
      instance: opts.selfName,
      pid: process.pid,
      uptime_seconds: Math.max(0, Math.round((Date.now() - opts.startedAtMs) / 1000)),
      started_at: new Date(opts.startedAtMs).toISOString(),
    });

    // No caching: a watchdog must see current process state on every probe.
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(method === 'HEAD' ? undefined : body);
    return true;
  };
}
