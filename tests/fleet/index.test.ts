/**
 * Fleet index.ts tests — drive the *real* createFleetServer factory.
 *
 * Previously this file rebuilt a parallel 2-entry ROUTES mirror that diverged
 * from production's 49-entry table and never exercised the query-token auth
 * branch. We now boot the real factory (same pattern as integration.test.ts)
 * so server wiring regressions surface here, and we add explicit coverage for
 * the `?token=` query-param auth path that EventSource clients depend on.
 *
 * Scope is intentionally narrow: this file proves the *shell* (startup,
 * bearer + query auth, 404, static fallback, dispatch on representative HTTP
 * verbs/param shapes) plus loadOrCreateFleetToken. Long-tail per-route
 * coverage lives in integration.test.ts and future per-route test files.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing fleet modules
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], cb: (err: Error | null, stdout?: string) => void) => {
    cb(null, '');
  }),
  execFileSync: vi.fn(() => Buffer.from('abc1234')),
  spawn: vi.fn(),
}));

const mockSvcManager = {
  enable: vi.fn().mockResolvedValue(undefined),
  disable: vi.fn().mockResolvedValue(undefined),
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  restart: vi.fn().mockResolvedValue(undefined),
  startFire: vi.fn(),
};
vi.mock('../../src/fleet/platform.ts', () => ({
  createServiceManager: vi.fn(() => mockSvcManager),
  detectPlatform: vi.fn(() => 'linux-systemd'),
}));

vi.mock('../../src/fleet/mcp-client.ts', () => ({
  mcpCall: vi.fn(async () => ({ success: true, result: { status: 'sent' } })),
}));

vi.mock('../../src/fleet/http-proxy.ts', () => ({
  proxyToInstance: vi.fn(async () => ({ status: 200, body: JSON.stringify({ ok: true }) })),
}));

vi.mock('../../src/logger.ts', () => {
  const noop = () => {};
  const child = () => fakeLogger;
  const fakeLogger: Record<string, unknown> = {
    info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop,
    child, flush: noop,
  };
  return { default: fakeLogger, createChildLogger: () => fakeLogger, flushLogger: async () => {} };
});

import { createFleetServer, loadOrCreateFleetToken } from '../../src/fleet/index.ts';

// ---------------------------------------------------------------------------
// Minimal schema — enough for fleet startup
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
INSERT INTO schema_migrations VALUES (25);

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

CREATE TABLE lid_mappings (
  lid TEXT PRIMARY KEY,
  phone_jid TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE lid_mappings_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lid TEXT NOT NULL,
  prev_phone_jid TEXT,
  new_phone_jid TEXT NOT NULL,
  source TEXT NOT NULL,
  source_instance TEXT,
  changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  observed_updated_at TEXT
);
`;

const SCHEMA_SQL_V24 = `
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
INSERT INTO schema_migrations VALUES (24);

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

CREATE TABLE lid_mappings (
  lid TEXT PRIMARY KEY,
  phone_jid TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

function writeInstanceConfig(configRoot: string, name: string, overrides: Record<string, unknown> = {}): void {
  const instanceDir = path.join(configRoot, name);
  fs.mkdirSync(instanceDir, { recursive: true });
  const config = { type: 'chat', accessMode: 'self_only', healthPort: 3010, ...overrides };
  fs.writeFileSync(path.join(instanceDir, 'config.json'), JSON.stringify(config, null, 2));
}

function seedDatabase(dbPath: string, schemaSql = SCHEMA_SQL): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(schemaSql);
  db.close();
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

const FLEET_TOKEN = 'test-fleet-token-' + crypto.randomBytes(8).toString('hex');
const SELF_NAME = '__index_test_self__';
const INST_A = 'line-alpha';

let tmpDir: string;
let configRoot: string;
let dataRoot: string;
let stateRoot: string;
let distDir: string;
let createdIndexHtml = false;
let distExisted = false;
let selfDb: DatabaseSync;
let fleet: ReturnType<typeof createFleetServer>;
let baseUrl: string;
let savedEnv: Record<string, string | undefined>;

beforeAll(async () => {
  savedEnv = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  };

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-index-test-'));
  configRoot = path.join(tmpDir, 'config', 'whatsoup', 'instances');
  dataRoot = path.join(tmpDir, 'data', 'whatsoup', 'instances');
  stateRoot = path.join(tmpDir, 'state', 'whatsoup', 'instances');
  fs.mkdirSync(configRoot, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true });

  process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
  process.env.XDG_DATA_HOME = path.join(tmpDir, 'data');
  process.env.XDG_STATE_HOME = path.join(tmpDir, 'state');

  writeInstanceConfig(configRoot, INST_A, { type: 'chat', accessMode: 'self_only', healthPort: 19010 });
  seedDatabase(path.join(dataRoot, INST_A, 'bot.db'));

  const selfDataDir = path.join(dataRoot, SELF_NAME);
  fs.mkdirSync(selfDataDir, { recursive: true });
  selfDb = new DatabaseSync(path.join(selfDataDir, 'bot.db'));
  selfDb.exec(SCHEMA_SQL);

  // The real factory resolves distDir relative to src/fleet/index.ts. Make sure
  // an index.html exists so the static handler can serve the SPA fallback.
  distDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'dist');
  distExisted = fs.existsSync(distDir);
  fs.mkdirSync(distDir, { recursive: true });
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    // Include <head></head> so the static handler's meta-tag injection
    // (which uses `html.replace('</head>', ...)`) actually fires.
    fs.writeFileSync(
      path.join(distDir, 'index.html'),
      '<html><head></head><body>fleet</body></html>',
    );
    createdIndexHtml = true;
  }

  fleet = createFleetServer({
    db: selfDb,
    selfName: SELF_NAME,
    fleetToken: FLEET_TOKEN,
    getSelfHealth: () => ({ status: 'ok' }),
  });

  fleet.discovery.scan();

  const originalFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/health')) {
      return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    return originalFetch(input, init);
  });

  await new Promise<void>((resolve) => {
    fleet.server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = fleet.server.address();
  if (!addr || typeof addr === 'string') throw new Error('unexpected address type');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  fleet.stop();
  await new Promise<void>((resolve) => fleet.server.close(() => resolve()));
  try { selfDb.close(); } catch { /* already closed */ }
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (createdIndexHtml) {
    try { fs.unlinkSync(path.join(distDir, 'index.html')); } catch { /* fine */ }
  }
  if (!distExisted) {
    try { fs.rmdirSync(distDir); } catch { /* fine — dir may be non-empty if vite build ran during test */ }
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

describe('fleet server -- startup', () => {
  it('responds on the listening port', async () => {
    const res = await fetch(`${baseUrl}/api/lines`, {
      headers: { Authorization: `Bearer ${FLEET_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Bearer auth gating (existing behavior, now via the real factory)
// ---------------------------------------------------------------------------

describe('fleet server -- API auth gating (Bearer)', () => {
  it('returns 401 without Authorization header', async () => {
    const res = await fetch(`${baseUrl}/api/lines`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('unauthorized');
  });

  it('returns 401 with wrong Bearer token', async () => {
    const res = await fetch(`${baseUrl}/api/lines`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 with malformed Authorization header', async () => {
    const res = await fetch(`${baseUrl}/api/lines`, {
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 200 with correct Bearer token', async () => {
    const res = await fetch(`${baseUrl}/api/lines`, {
      headers: { Authorization: `Bearer ${FLEET_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it('all /api/* paths require auth, not just known routes', async () => {
    const res = await fetch(`${baseUrl}/api/unknown/path`);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// PRIORITY 1: Query-token auth (?token=) — previously untested branch
// ---------------------------------------------------------------------------

describe('fleet server -- API auth via ?token= query param', () => {
  it('accepts a valid token via ?token= without Authorization header', async () => {
    const res = await fetch(
      `${baseUrl}/api/lines?token=${encodeURIComponent(FLEET_TOKEN)}`,
    );
    expect(res.status).toBe(200);
  });

  it('rejects an invalid ?token= value with 401', async () => {
    const res = await fetch(`${baseUrl}/api/lines?token=not-the-real-token`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('unauthorized');
  });

  it('rejects an empty ?token= with 401', async () => {
    const res = await fetch(`${baseUrl}/api/lines?token=`);
    expect(res.status).toBe(401);
  });

  it('rejects a ?token= of wrong length even if it is a prefix of the real token', async () => {
    // Guards the length-check that gates timingSafeEqual (which throws on length mismatch).
    const truncated = FLEET_TOKEN.slice(0, FLEET_TOKEN.length - 2);
    const res = await fetch(`${baseUrl}/api/lines?token=${encodeURIComponent(truncated)}`);
    expect(res.status).toBe(401);
  });

  it('accepts when Authorization header is valid even if ?token= is wrong (header path wins)', async () => {
    const res = await fetch(
      `${baseUrl}/api/lines?token=garbage`,
      { headers: { Authorization: `Bearer ${FLEET_TOKEN}` } },
    );
    expect(res.status).toBe(200);
  });

  it('accepts when ?token= is valid even if Authorization header is wrong (query fallback)', async () => {
    const res = await fetch(
      `${baseUrl}/api/lines?token=${encodeURIComponent(FLEET_TOKEN)}`,
      { headers: { Authorization: 'Bearer wrong-token' } },
    );
    expect(res.status).toBe(200);
  });

  it('query-token auth applies to parameterised routes too', async () => {
    const res = await fetch(
      `${baseUrl}/api/lines/${INST_A}?token=${encodeURIComponent(FLEET_TOKEN)}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe(INST_A);
  });
});

describe('fleet server -- runtime token rotation', () => {
  it('re-reads active and accepted tokens without restarting the server', async () => {
    const oldToken = 'a'.repeat(64);
    const newToken = 'b'.repeat(64);
    let tokenSet = { active: oldToken, accept: [] as string[] };
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    const dynamicFleet = createFleetServer({
      db,
      selfName: '__dynamic_token_test__',
      fleetToken: oldToken,
      getFleetTokens: () => tokenSet,
      getSelfHealth: () => ({ status: 'ok' }),
    });

    await new Promise<void>((resolve) => {
      dynamicFleet.server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = dynamicFleet.server.address();
    if (!addr || typeof addr === 'string') throw new Error('unexpected address type');
    const dynamicBaseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const initial = await fetch(`${dynamicBaseUrl}/api/lines`, {
        headers: { Authorization: `Bearer ${oldToken}` },
      });
      expect(initial.status).toBe(200);

      tokenSet = { active: newToken, accept: [oldToken] };
      const fresh = await fetch(`${dynamicBaseUrl}/api/lines`, {
        headers: { Authorization: `Bearer ${newToken}` },
      });
      expect(fresh.status).toBe(200);

      const acceptedPrior = await fetch(`${dynamicBaseUrl}/api/lines`, {
        headers: { Authorization: `Bearer ${oldToken}` },
      });
      expect(acceptedPrior.status).toBe(200);

      const ticketRes = await fetch(`${dynamicBaseUrl}/api/ws-ticket`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${newToken}` },
      });
      expect(ticketRes.status).toBe(200);
      const { ticket } = await ticketRes.json() as { ticket: string };
      const ws = await new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${addr.port}/ws?ticket=${encodeURIComponent(ticket)}`);
        socket.once('open', () => resolve(socket));
        socket.once('error', reject);
      });
      ws.close();

      const html = await fetch(dynamicBaseUrl).then((res) => res.text());
      expect(html).toContain(`<meta name="fleet-token" content="${newToken}">`);
      expect(html).not.toContain(`<meta name="fleet-token" content="${oldToken}">`);

      tokenSet = { active: newToken, accept: [] };
      const expiredPrior = await fetch(`${dynamicBaseUrl}/api/lines`, {
        headers: { Authorization: `Bearer ${oldToken}` },
      });
      expect(expiredPrior.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => {
        dynamicFleet.server.once('close', resolve);
        dynamicFleet.stop();
      });
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Route matching against the real 49-entry table (representative coverage)
// ---------------------------------------------------------------------------

describe('fleet server -- API route dispatch (real factory)', () => {
  const auth = { Authorization: `Bearer ${FLEET_TOKEN}` };

  it('returns 404 for unknown /api/ routes when authenticated', async () => {
    const res = await fetch(`${baseUrl}/api/nonexistent`, { headers: auth });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('not found');
  });

  it('GET /api/lines (no params) dispatches to the lines handler and returns an array', async () => {
    const res = await fetch(`${baseUrl}/api/lines`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect((body as any[]).some((l) => l.name === INST_A)).toBe(true);
  });

  it('GET /api/lines/:name dispatches to the line-detail handler with the extracted param', async () => {
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe(INST_A);
    expect(body.type).toBe('chat');
  });

  it('GET /api/lines/:name returns 404 for unknown instance (handler-level 404)', async () => {
    const res = await fetch(`${baseUrl}/api/lines/no-such-instance`, { headers: auth });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain('not found');
  });

  it('method dispatch: POST /api/lines/:name does not match GET /api/lines/:name', async () => {
    // No POST route is registered for `/api/lines/:name` itself — guards the
    // method-as-part-of-the-key dispatch behavior in parseRoute.
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}`, {
      method: 'POST', headers: auth,
    });
    expect(res.status).toBe(404);
  });

  it('GET /api/version dispatches to the version handler (EmptyRouteParams shape)', async () => {
    const res = await fetch(`${baseUrl}/api/version`, { headers: auth });
    // We just need the route to dispatch (not 404 / not 401). Shape may vary
    // across the UpdateChecker async lifecycle.
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(401);
  });

  it('GET /api/directories/check dispatches (real-table-only route)', async () => {
    // Missing `path` query param returns 400 from the handler — that's a successful dispatch.
    const res = await fetch(`${baseUrl}/api/directories/check`, { headers: auth });
    expect(res.status).toBe(400);
  });

  it('POST /api/lid-mappings/sync keeps legacy result counts and exposes detailed counters separately', async () => {
    const instDbPath = path.join(dataRoot, INST_A, 'bot.db');
    const db = new DatabaseSync(instDbPath);
    try {
      db.prepare('DELETE FROM lid_mappings_history WHERE lid = ?').run('424242');
      db.prepare('DELETE FROM lid_mappings WHERE lid = ?').run('424242');
      db
        .prepare('INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, ?)')
        .run('424242', '15550004242@s.whatsapp.net', '2026-05-01 00:00:00');
    } finally {
      db.close();
    }

    const res = await fetch(`${baseUrl}/api/lid-mappings/sync`, {
      method: 'POST',
      headers: auth,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalMappings).toBeGreaterThanOrEqual(1);
    expect(typeof body.results[INST_A]).toBe('number');
    expect(body.results[INST_A]).toBe(0);
    expect(body.details[INST_A]).toMatchObject({
      imported: 0,
      flipped: 0,
      conflicts: 0,
    });
  });

  it('POST /api/lid-mappings/sync skips schema-v24 peers before history writes', async () => {
    const staleName = 'line-schema-24';
    const staleDbPath = path.join(dataRoot, staleName, 'bot.db');
    writeInstanceConfig(configRoot, staleName, { type: 'chat', accessMode: 'self_only', healthPort: 19024 });
    seedDatabase(staleDbPath, SCHEMA_SQL_V24);
    fleet.discovery.scan();

    const db = new DatabaseSync(staleDbPath);
    try {
      db
        .prepare('INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, ?)')
        .run('242424', '15550002424@s.whatsapp.net', '2026-05-02 00:00:00');
    } finally {
      db.close();
    }

    const res = await fetch(`${baseUrl}/api/lid-mappings/sync`, {
      method: 'POST',
      headers: auth,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[staleName]).toBe(0);
    expect(body.details[staleName]).toMatchObject({
      imported: 0,
      flipped: 0,
      noop: 0,
      conflicts: 0,
      skipped: true,
      reason: 'schema_migration_below_25',
      schemaVersion: 24,
    });

    const verifyDb = new DatabaseSync(staleDbPath);
    try {
      const historyTable = verifyDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='lid_mappings_history'")
        .get();
      expect(historyTable).toBeUndefined();
    } finally {
      verifyDb.close();
    }
  });

  it('PATCH /api/lines/:name/config dispatches (verb other than GET/POST)', async () => {
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/config`, {
      method: 'PATCH',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemPrompt: 'hi' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.systemPrompt).toBe('hi');
  });
});

// ---------------------------------------------------------------------------
// Static file serving — verifies createStaticHandler is wired with full args
// (token + getVersion), not the stripped-down call the old mirror used.
// ---------------------------------------------------------------------------

describe('fleet server -- static file serving', () => {
  it('serves index.html for root path with token+version meta injected', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    // Locks in the createStaticHandler(distDir, fleetToken, getVersion) wiring:
    // a server constructed with only distDir would still pass status+content-type
    // but would skip meta injection entirely.
    expect(body).toContain(`<meta name="fleet-token" content="${FLEET_TOKEN}">`);
    // execFileSync is mocked to return 'abc1234' — pin to the exact version tag.
    expect(body).toContain('<meta name="fleet-version" content="abc1234">');
  });

  it('SPA fallback: extensionless non-API paths serve index.html', async () => {
    const res = await fetch(`${baseUrl}/dashboard`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain(`<meta name="fleet-token" content="${FLEET_TOKEN}">`);
    expect(body).toContain('<meta name="fleet-version" content="abc1234">');
  });
});

// ---------------------------------------------------------------------------
// loadOrCreateFleetToken — preserved from the prior file
// ---------------------------------------------------------------------------

describe('loadOrCreateFleetToken', () => {
  // Back-compat shim: returns just the `active` token from the rotatable
  // storage in `token-storage.ts`. Full rotation coverage lives in
  // `tests/fleet/token-storage.test.ts`.
  let tokenDir: string;
  let jsonPath: string;
  let legacyPath: string;
  let savedXdg: string | undefined;

  beforeAll(() => {
    tokenDir = path.join(tmpDir, 'config-token-test');
    savedXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tokenDir;
    jsonPath = path.join(tokenDir, 'whatsoup', 'fleet-tokens.json');
    legacyPath = path.join(tokenDir, 'whatsoup', 'fleet-token');
  });

  afterAll(() => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
  });

  it('creates a new fleet-tokens.json when none exists', async () => {
    try { fs.unlinkSync(jsonPath); } catch { /* fine */ }
    try { fs.unlinkSync(legacyPath); } catch { /* fine */ }
    const token = await loadOrCreateFleetToken();
    expect(token).toHaveLength(64);
    expect(fs.existsSync(jsonPath)).toBe(true);
  });

  it('returns the existing active token on subsequent calls', async () => {
    const first = await loadOrCreateFleetToken();
    const second = await loadOrCreateFleetToken();
    expect(first).toBe(second);
  });

  it('migrates an existing legacy fleet-token into fleet-tokens.json', async () => {
    // Reset state for this scenario
    try { fs.unlinkSync(jsonPath); } catch { /* fine */ }
    const validToken = 'a'.repeat(64);
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, `${validToken}\n`, { mode: 0o600 });
    const token = await loadOrCreateFleetToken();
    expect(token).toBe(validToken);
    expect(fs.existsSync(jsonPath)).toBe(true);
    // Legacy file preserved for one rollback cycle
    expect(fs.existsSync(legacyPath)).toBe(true);
  });
});
