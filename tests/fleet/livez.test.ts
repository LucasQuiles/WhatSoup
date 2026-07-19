/**
 * Tests for src/fleet/livez.ts — the dashboard-independent fleet liveness route.
 *
 * The watchdog previously decided fleet-service restarts by curling the console
 * ROOT (`/`), which 404s whenever the built console assets are missing from a
 * release — turning a cosmetic packaging gap into a restart loop. `/livez`
 * answers from process state alone (no dist assets, no DB, no auth) so a
 * watchdog can distinguish "process serving" from "console assets missing".
 */
import { describe, it, expect } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createLivenessHandler } from '../../src/fleet/livez.ts';

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => boolean,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((req, res) => {
    if (!handler(req, res)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('createLivenessHandler', () => {
  it('answers GET /livez with 200 and process-only state', async () => {
    const started = Date.now() - 5000;
    const handler = createLivenessHandler({ selfName: 'rb-bot', startedAtMs: started });
    await withServer(handler, async (base) => {
      const res = await fetch(`${base}/livez`);
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.alive).toBe(true);
      expect(body.instance).toBe('rb-bot');
      expect(body.pid).toBe(process.pid);
      expect(typeof body.uptime_seconds).toBe('number');
      expect(body.uptime_seconds as number).toBeGreaterThanOrEqual(4);
    });
  });

  it('does not read the request body, filesystem, or require auth', async () => {
    // No Authorization header, no cookie — must still be 200. (Contract: the
    // watchdog probes this unauthenticated on loopback.)
    const handler = createLivenessHandler({ selfName: 'ml-bot', startedAtMs: Date.now() });
    await withServer(handler, async (base) => {
      const res = await fetch(`${base}/livez`, { headers: {} });
      expect(res.status).toBe(200);
    });
  });

  it('supports HEAD /livez (watchdogs may probe with HEAD)', async () => {
    const handler = createLivenessHandler({ selfName: 'rb-bot', startedAtMs: Date.now() });
    await withServer(handler, async (base) => {
      const res = await fetch(`${base}/livez`, { method: 'HEAD' });
      expect(res.status).toBe(200);
    });
  });

  it('returns false (declines) for non-liveness paths so other routing continues', async () => {
    const handler = createLivenessHandler({ selfName: 'rb-bot', startedAtMs: Date.now() });
    await withServer(handler, async (base) => {
      const res = await fetch(`${base}/api/version`);
      expect(res.status).toBe(404); // handler declined; test server's fallback answered
    });
  });

  it('ignores query strings on the liveness path', async () => {
    const handler = createLivenessHandler({ selfName: 'rb-bot', startedAtMs: Date.now() });
    await withServer(handler, async (base) => {
      const res = await fetch(`${base}/livez?probe=watchdog`);
      expect(res.status).toBe(200);
    });
  });
});
