import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FleetDiscovery, DiscoveredInstance } from '../fleet/discovery.ts';

/** Stream request body bytes with size guard. Rejects with 413 if exceeded.
 * Returns the exact received byte sequence; callers that need byte-stable
 * semantics (digests, idempotency) must hash this buffer, not a decode. */
export function readBodyBytes(req: IncomingMessage, maxBytes = 64 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    req.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += part.length;
      if (bytes > maxBytes) {
        settled = true;
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(part);
    });
    req.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

/** Stream request body with size guard. Rejects with 413 if exceeded.
 * Decodes once after the full body arrives so multibyte characters split
 * across chunk boundaries are preserved. */
export async function readBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<string> {
  const bytes = await readBodyBytes(req, maxBytes);
  return bytes.toString('utf8');
}

/** Send a JSON response. */
export function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

/** Extract the Bearer credential without comparing it to a known token. */
export function extractBearer(req: IncomingMessage): string | null {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return null;
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return null;
  return header.slice(prefix.length);
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
