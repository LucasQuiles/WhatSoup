/**
 * Shared health-server test harness (extracted per review wf_dc1654c1 finding 10 —
 * this was the third diverging copy). vi.mock blocks CANNOT live here (hoisting);
 * each test file keeps its own config/logger mocks.
 */
import { vi } from 'vitest';
import { createServer, request } from 'node:http';
import { Database } from '../../../src/core/database.ts';
import type { HealthDeps } from '../../../src/core/health.ts';
import type { ConnectionManager } from '../../../src/transport/connection.ts';

export function httpReq(
  port: number,
  path: string,
  method: 'GET' | 'POST',
  body?: string,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body).toString() } : {}),
        ...extraHeaders,
      },
    };
    const req = request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

export async function buildTestServer(deps: HealthDeps): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  const { startHealthServer } = await import('../../../src/core/health.ts');
  return new Promise((resolve) => {
    const server = startHealthServer(deps);
    server.close(() => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve({ server, port });
      });
    });
  });
}

export function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

export function makeDeps(db: Database, overrides: Partial<HealthDeps> = {}): HealthDeps {
  return {
    db,
    connectionManager: {
      botJid: '15551230004@s.whatsapp.net',
      botLid: null,
      getSocket: vi.fn().mockReturnValue(null),
      sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
      sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    } as unknown as ConnectionManager,
    startedAt: Date.now() - 1000,
    getEnrichmentStats: vi.fn().mockReturnValue({ lastRun: null, unprocessed: 0 }),
    instanceName: 'ad-bot',
    instanceType: 'chat',
    accessMode: 'allowlist',
    ...overrides,
  };
}

/** Fake agent runtime exposing a camelCase turnCapability (null = no turnCapability key). */
export function makeAgentRuntime(tc: Record<string, unknown> | null) {
  return {
    getHealthSnapshot: () => ({
      status: 'healthy',
      details: tc === null ? { active: true } : { active: true, turnCapability: tc },
    }),
    getFallbackState: () => null,
  };
}

/** Build a server for deps, GET /health once, tear down, return parsed json. */
export async function getHealth(deps: HealthDeps): Promise<{ status: number; json: Record<string, any> }> {
  const { server, port } = await buildTestServer(deps);
  try {
    const { status, body } = await httpReq(port, '/health', 'GET');
    return { status, json: JSON.parse(body) };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
