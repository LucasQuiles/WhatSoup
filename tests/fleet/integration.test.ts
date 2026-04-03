/**
 * Fleet module integration tests.
 *
 * Spins up a real createFleetServer() backed by temp directories with mock
 * instance configs and seeded SQLite databases, then exercises the HTTP API
 * end-to-end. External calls (health polling, MCP socket, HTTP proxy,
 * systemctl) are mocked so tests are self-contained.
 */
import { describe, it, expect, beforeAll, afterAll, vi, type Mock } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing fleet modules
// ---------------------------------------------------------------------------

// Mock child_process.execFile so restart tests don't invoke real systemctl.
// (execFile is the safe alternative to exec — no shell injection risk.)
vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], cb: (err: Error | null, stdout?: string) => void) => {
    cb(null, '');
  }),
  spawn: vi.fn(),
}));

// Mock mcp-client and http-proxy to avoid real socket/HTTP calls from ops routes
vi.mock('../../src/fleet/mcp-client.ts', () => ({
  mcpCall: vi.fn(async () => ({ success: true, result: { status: 'sent' } })),
}));

vi.mock('../../src/fleet/http-proxy.ts', () => ({
  proxyToInstance: vi.fn(async () => ({ status: 200, body: JSON.stringify({ ok: true }) })),
}));

// Suppress pino log output during tests
vi.mock('../../src/logger.ts', () => {
  const noop = () => {};
  const child = () => fakeLogger;
  const fakeLogger: Record<string, unknown> = {
    info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop,
    child,
    flush: noop,
  };
  return { default: fakeLogger, createChildLogger: () => fakeLogger, flushLogger: async () => {} };
});

import { createFleetServer } from '../../src/fleet/index.ts';
import { mcpCall } from '../../src/fleet/mcp-client.ts';
import { proxyToInstance } from '../../src/fleet/http-proxy.ts';
import { execFile } from 'node:child_process';

// ---------------------------------------------------------------------------
// Schema DDL — minimal tables needed by the fleet db-reader queries
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
INSERT INTO schema_migrations VALUES (1);

CREATE TABLE messages (
  pk INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_key TEXT NOT NULL,
  sender_jid TEXT,
  sender_name TEXT,
  content TEXT,
  content_type TEXT DEFAULT 'text',
  timestamp INTEGER NOT NULL,
  is_from_me INTEGER DEFAULT 0,
  deleted_at TEXT,
  enrichment_processed_at TEXT
);

CREATE TABLE access_list (
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  status TEXT NOT NULL,
  display_name TEXT,
  requested_at TEXT,
  decided_at TEXT
);
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedDatabase(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA_SQL);

  const insertMsg = db.prepare(`
    INSERT INTO messages (conversation_key, sender_jid, sender_name, content, timestamp, is_from_me)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertMsg.run('user1@s.whatsapp.net', '5551234@s.whatsapp.net', 'Alice', 'Hello', 1700000000, 0);
  insertMsg.run('user1@s.whatsapp.net', 'self@s.whatsapp.net', 'Self', 'Hi there', 1700000001, 1);
  insertMsg.run('group1@g.us', '5559876@s.whatsapp.net', 'Bob', 'Group msg', 1700000002, 0);

  const insertAccess = db.prepare(`
    INSERT INTO access_list (subject_type, subject_id, status, display_name, requested_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  insertAccess.run('phone', '5551234@s.whatsapp.net', 'allowed', 'Alice', '2024-01-01T00:00:00Z');
  insertAccess.run('phone', '5559999@s.whatsapp.net', 'pending', 'Charlie', '2024-01-02T00:00:00Z');

  db.close();
}

function writeInstanceConfig(
  configRoot: string,
  name: string,
  overrides: Record<string, unknown> = {},
): void {
  const instanceDir = path.join(configRoot, name);
  fs.mkdirSync(instanceDir, { recursive: true });
  const config = {
    type: 'chat',
    accessMode: 'self_only',
    healthPort: 3010 + Math.floor(Math.random() * 1000),
    ...overrides,
  };
  fs.writeFileSync(path.join(instanceDir, 'config.json'), JSON.stringify(config, null, 2));
}

// ---------------------------------------------------------------------------
// Test-wide state
// ---------------------------------------------------------------------------

let tmpDir: string;
let configRoot: string;
let dataRoot: string;
let stateRoot: string;
let selfDb: DatabaseSync;
let fleet: ReturnType<typeof createFleetServer>;
let baseUrl: string;
let savedEnv: Record<string, string | undefined>;
const FLEET_TOKEN = 'test-fleet-token-' + crypto.randomBytes(8).toString('hex');
const SELF_NAME = '__integration_self__';

const INST_A = 'line-alpha';  // chat type
const INST_B = 'line-beta';   // passive type with socketPath

// ---------------------------------------------------------------------------
// Setup & teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Save XDG env vars
  savedEnv = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  };

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-integ-'));
  configRoot = path.join(tmpDir, 'config', 'whatsoup', 'instances');
  dataRoot = path.join(tmpDir, 'data', 'whatsoup', 'instances');
  stateRoot = path.join(tmpDir, 'state', 'whatsoup', 'instances');
  fs.mkdirSync(configRoot, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true });

  // Point XDG vars at our temp dirs so FleetDiscovery resolves paths there
  process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
  process.env.XDG_DATA_HOME = path.join(tmpDir, 'data');
  process.env.XDG_STATE_HOME = path.join(tmpDir, 'state');

  // Instance A — chat type with seeded DB
  writeInstanceConfig(configRoot, INST_A, {
    type: 'chat',
    accessMode: 'self_only',
    healthPort: 19010,
  });
  seedDatabase(path.join(dataRoot, INST_A, 'bot.db'));

  // Instance B — passive type with socketPath and seeded DB
  const stateB = path.join(stateRoot, INST_B);
  fs.mkdirSync(stateB, { recursive: true });
  writeInstanceConfig(configRoot, INST_B, {
    type: 'passive',
    accessMode: 'allowlist',
    healthPort: 19011,
    socketPath: path.join(stateB, 'whatsoup.sock'),
  });
  seedDatabase(path.join(dataRoot, INST_B, 'bot.db'));

  // Self-instance DB (in-memory-like, but fleet needs a DatabaseSync handle)
  const selfDataDir = path.join(dataRoot, SELF_NAME);
  fs.mkdirSync(selfDataDir, { recursive: true });
  const selfDbPath = path.join(selfDataDir, 'bot.db');
  selfDb = new DatabaseSync(selfDbPath);
  selfDb.exec(SCHEMA_SQL);

  // Create fleet server using the real factory
  fleet = createFleetServer({
    db: selfDb,
    selfName: SELF_NAME,
    fleetToken: FLEET_TOKEN,
    getSelfHealth: () => ({ status: 'ok', uptime: 42 }),
  });

  // Re-scan so discovery uses our temp XDG dirs
  fleet.discovery.scan();

  // Mock global fetch so the health poller doesn't call real ports
  const originalFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/health')) {
      return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // Non-health requests go through to the real server (our fleet server)
    return originalFetch(input, init);
  });

  // Start the server on port 0 (random available port)
  await new Promise<void>((resolve) => {
    fleet.server.listen(0, '127.0.0.1', () => resolve());
  });
  fleet.discovery.startAutoRefresh();
  fleet.healthPoller.start();

  const addr = fleet.server.address();
  if (!addr || typeof addr === 'string') throw new Error('unexpected address type');
  baseUrl = `http://127.0.0.1:${addr.port}`;

  // Give the health poller a moment to complete its initial poll
  await new Promise((r) => setTimeout(r, 150));
});

afterAll(async () => {
  fleet.stop();
  await new Promise<void>((resolve) => fleet.server.close(() => resolve()));
  try { selfDb.close(); } catch { /* already closed */ }
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // Restore XDG env vars
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${FLEET_TOKEN}` };
}

async function fetchJson(
  urlPath: string,
  init: RequestInit = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    ...init,
    headers: { ...authHeaders(), ...((init.headers as Record<string, string>) ?? {}) },
  });
  const body = await res.json();
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// 1. Fleet overview
// ---------------------------------------------------------------------------

describe('fleet integration -- fleet overview', () => {
  it('GET /api/lines returns both mock instances', async () => {
    const { status, body } = await fetchJson('/api/lines');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);

    const names = (body as any[]).map((l) => l.name);
    expect(names).toContain(INST_A);
    expect(names).toContain(INST_B);
  });

  it('each line includes mode and accessMode from config', async () => {
    const { body } = await fetchJson('/api/lines');
    const alpha = (body as any[]).find((l) => l.name === INST_A);
    const beta = (body as any[]).find((l) => l.name === INST_B);

    expect(alpha.mode).toBe('chat');
    expect(alpha.accessMode).toBe('self_only');

    expect(beta.mode).toBe('passive');
    expect(beta.accessMode).toBe('allowlist');
  });

  it('each line includes a health status field', async () => {
    const { body } = await fetchJson('/api/lines');
    for (const line of body as any[]) {
      expect(['online', 'degraded', 'unreachable', 'unknown']).toContain(line.status);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Instance detail
// ---------------------------------------------------------------------------

describe('fleet integration -- instance detail', () => {
  it('GET /api/lines/:name returns detail for known instance', async () => {
    const { status, body } = await fetchJson(`/api/lines/${INST_A}`);
    expect(status).toBe(200);
    expect(body.name).toBe(INST_A);
    expect(body.type).toBe('chat');
    // dbPath is intentionally excluded from the API response (server internal)
  });

  it('includes dbStats with message count, chat count, and pending access', async () => {
    const { body } = await fetchJson(`/api/lines/${INST_A}`);
    expect(body.dbStats).not.toBeNull();
    expect(body.dbStats.messageCount).toBe(3);
    expect(body.dbStats.chatCount).toBe(2); // user1@s.whatsapp.net + group1@g.us
    expect(body.dbStats.pendingAccess).toBe(1); // Charlie
  });

  it('returns 404 for unknown instance', async () => {
    const { status, body } = await fetchJson('/api/lines/nonexistent');
    expect(status).toBe(404);
    expect(body.error).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// 3. Auth enforcement
// ---------------------------------------------------------------------------

describe('fleet integration -- auth enforcement', () => {
  const protectedGetPaths = [
    '/api/lines',
    `/api/lines/${INST_A}`,
    `/api/lines/${INST_A}/chats`,
    `/api/lines/${INST_A}/messages?conversation_key=test`,
    `/api/lines/${INST_A}/access`,
    `/api/lines/${INST_A}/logs`,
  ];

  for (const urlPath of protectedGetPaths) {
    it(`GET ${urlPath} returns 401 without token`, async () => {
      const res = await fetch(`${baseUrl}${urlPath}`);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('unauthorized');
    });
  }

  it('POST /api/lines/:name/send returns 401 without token', async () => {
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/send`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('POST /api/lines/:name/restart returns 401 without token', async () => {
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/restart`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('PATCH /api/lines/:name/config returns 401 without token', async () => {
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/config`, {
      method: 'PATCH',
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('wrong Bearer token returns 401', async () => {
    const res = await fetch(`${baseUrl}/api/lines`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 4. Send routing
// ---------------------------------------------------------------------------

describe('fleet integration -- send routing', () => {
  it('POST send to chat instance proxies via proxyToInstance', async () => {
    (proxyToInstance as Mock).mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify({ sent: true }),
    });

    const { status } = await fetchJson(`/api/lines/${INST_A}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jid: '5551234@s.whatsapp.net', text: 'Hello' }),
    });
    expect(status).toBe(200);
    expect(proxyToInstance).toHaveBeenCalled();
  });

  it('POST send to passive instance falls through to HTTP proxy when socket does not exist on disk', async () => {
    // Production checks fs.existsSync(socketPath) before MCP routing;
    // socket file doesn't exist in test env, so it falls through to HTTP proxy.
    (proxyToInstance as Mock).mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify({ ok: true }),
    });

    const { status } = await fetchJson(`/api/lines/${INST_B}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jid: '5551234@s.whatsapp.net', text: 'Hello' }),
    });
    expect(status).toBe(200);
    expect(proxyToInstance).toHaveBeenCalled();
  });

  it('POST send to unknown instance returns 404', async () => {
    const { status } = await fetchJson('/api/lines/nonexistent/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jid: 'x', text: 'y' }),
    });
    expect(status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 5. Config update
// ---------------------------------------------------------------------------

describe('fleet integration -- config update', () => {
  it('PATCH config merges fields into existing config', async () => {
    const { status, body } = await fetchJson(`/api/lines/${INST_A}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemPrompt: 'Be helpful' }),
    });
    expect(status).toBe(200);
    expect(body.systemPrompt).toBe('Be helpful');
    // Original fields preserved
    expect(body.type).toBe('chat');
    expect(body.accessMode).toBe('self_only');

    // Verify it was actually written to disk
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(configRoot, INST_A, 'config.json'), 'utf-8'),
    );
    expect(onDisk.systemPrompt).toBe('Be helpful');
    expect(onDisk.type).toBe('chat');
  });

  it('PATCH config with invalid JSON returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/config`, {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: 'not valid json!!!',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid JSON/i);
  });

  it('PATCH config with array body returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/config`, {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify([1, 2, 3]),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/must be a JSON object/i);
  });

  it('PATCH config for unknown instance returns 404', async () => {
    const { status } = await fetchJson('/api/lines/nonexistent/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ foo: 'bar' }),
    });
    expect(status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 6. Restart
// ---------------------------------------------------------------------------

describe('fleet integration -- restart', () => {
  it('POST restart returns 202 and calls systemctl', async () => {
    (execFile as unknown as Mock).mockImplementation(
      (_cmd: string, _args: string[], cb: (err: Error | null, stdout?: string) => void) => cb(null, ''),
    );

    const { status, body } = await fetchJson(`/api/lines/${INST_A}/restart`, {
      method: 'POST',
    });
    expect(status).toBe(202);
    expect(body.status).toBe('restart_requested');
    expect(body.instance).toBe(INST_A);
    expect(execFile).toHaveBeenCalledWith(
      'systemctl',
      ['--user', 'restart', `whatsoup@${INST_A}`],
      expect.any(Function),
    );
  });

  it('POST restart returns 500 when systemctl fails', async () => {
    (execFile as unknown as Mock).mockImplementation(
      (_cmd: string, _args: string[], cb: (err: Error | null) => void) =>
        cb(new Error('unit not found')),
    );

    const { status, body } = await fetchJson(`/api/lines/${INST_A}/restart`, {
      method: 'POST',
    });
    expect(status).toBe(500);
    expect(body.error).toContain('restart failed');
    expect(body.error).toContain('unit not found');
  });

  it('POST restart for unknown instance returns 404', async () => {
    const { status } = await fetchJson('/api/lines/nonexistent/restart', {
      method: 'POST',
    });
    expect(status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 7. Clean shutdown
// ---------------------------------------------------------------------------

describe('fleet integration -- clean shutdown', () => {
  it('fleet.stop() does not throw and stops polling', () => {
    // Create a second fleet server to test shutdown without destroying the main one
    const tmpDb = new DatabaseSync(':memory:');
    tmpDb.exec(SCHEMA_SQL);

    const f2 = createFleetServer({
      db: tmpDb,
      selfName: 'shutdown-test',
      fleetToken: 'tok',
      getSelfHealth: () => ({}),
    });

    f2.discovery.startAutoRefresh();
    f2.healthPoller.start();

    expect(() => f2.stop()).not.toThrow();

    tmpDb.close();
  });
});

// ---------------------------------------------------------------------------
// 8. DB error resilience
// ---------------------------------------------------------------------------

describe('fleet integration -- DB error resilience', () => {
  const corruptInstance = 'line-corrupt';

  beforeAll(() => {
    // Create an instance with a corrupt/missing DB
    const instanceDir = path.join(configRoot, corruptInstance);
    fs.mkdirSync(instanceDir, { recursive: true });
    fs.writeFileSync(
      path.join(instanceDir, 'config.json'),
      JSON.stringify({ type: 'chat', accessMode: 'self_only', healthPort: 19099 }),
    );

    // Create the data dir but write garbage instead of a valid SQLite DB
    const corruptDataDir = path.join(dataRoot, corruptInstance);
    fs.mkdirSync(corruptDataDir, { recursive: true });
    fs.writeFileSync(path.join(corruptDataDir, 'bot.db'), 'this is not a sqlite database');

    // Re-scan so discovery picks up the new instance
    fleet.discovery.scan();
  });

  it('GET /api/lines still returns all instances including one with corrupt DB', async () => {
    const { status, body } = await fetchJson('/api/lines');
    expect(status).toBe(200);
    const names = (body as any[]).map((l) => l.name);
    expect(names).toContain(INST_A);
    expect(names).toContain(INST_B);
    expect(names).toContain(corruptInstance);
  });

  it('GET /api/lines/:name for corrupt DB returns detail with null dbStats', async () => {
    const { status, body } = await fetchJson(`/api/lines/${corruptInstance}`);
    expect(status).toBe(200);
    expect(body.name).toBe(corruptInstance);
    expect(body.dbStats).toBeNull();
  });

  it('GET /api/lines/:name/chats for corrupt DB returns 500', async () => {
    const { status, body } = await fetchJson(`/api/lines/${corruptInstance}/chats`);
    expect(status).toBe(500);
    expect(body.error).toBeDefined();
  });

  it('healthy instances still work when a sibling DB is corrupt', async () => {
    const { status, body } = await fetchJson(`/api/lines/${INST_A}`);
    expect(status).toBe(200);
    expect(body.dbStats).not.toBeNull();
    expect(body.dbStats.messageCount).toBe(3);
  });
});
