import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FleetDiscovery, DiscoveredInstance } from '../fleet/discovery.ts';

/** Stream request body with size guard. Rejects with 413 if exceeded. */
export function readBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', (chunk: Buffer | string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) {
        req.destroy();
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/** Send a JSON response. */
export function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

/** Check Bearer token authorization. Returns true if authorized. */
export function checkBearerAuth(req: IncomingMessage, expectedToken: string): boolean {
  const header = req.headers['authorization'];
  return header === `Bearer ${expectedToken}`;
}

/** Route matching with named captures. Returns params or null. */
export function parseRoute(
  method: string,
  url: string,
  pattern: { method: string; path: RegExp },
): Record<string, string> | null {
  if (method !== pattern.method) return null;
  const pathname = url?.split('?')[0] ?? '';
  const match = pathname.match(pattern.path);
  if (!match) return null;
  return match.groups ?? {};
}

/** Extract query params from URL. */
export function parseQueryString(url: string | undefined): Record<string, string> {
  if (!url) return {};
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  const params: Record<string, string> = {};
  const searchParams = new URLSearchParams(url.slice(idx + 1));
  for (const [key, value] of searchParams) {
    params[key] = value;
  }
  return params;
}

/** Look up an instance by name, sending 404 if not found. */
export function requireInstance(
  discovery: FleetDiscovery,
  name: string,
  res: ServerResponse,
): DiscoveredInstance | null {
  const instance = discovery.getInstance(name);
  if (!instance) {
    jsonResponse(res, 404, { error: `instance '${name}' not found` });
    return null;
  }
  return instance;
}

/** Parse an integer query parameter with bounds clamping. */
export function parseIntParam(qs: Record<string, string | undefined>, key: string, defaultVal: number, min: number, max: number): number {
  return Math.min(Math.max(parseInt(qs[key] ?? String(defaultVal), 10) || defaultVal, min), max);
}

/** Wrap an async request handler, catching errors as 500. */
export function asyncHandler(
  fn: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    fn(req, res).catch((err) => {
      try {
        const status = (err as any).statusCode ?? 500;
        jsonResponse(res, status, { error: (err as Error).message ?? 'internal error' });
      } catch { /* response already started */ }
    });
  };
}
