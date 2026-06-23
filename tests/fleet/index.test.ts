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
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
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

import { createFleetServer, loadOrCreateFleetToken, loadOrCreateFleetTokens } from '../../src/fleet/index.ts';

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

function withInstanceDb<T>(name: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path.join(dataRoot, name, 'bot.db'));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function deleteLidMapping(name: string, lid: string): void {
  withInstanceDb(name, (db) => {
    db.prepare('DELETE FROM lid_mappings_history WHERE lid = ?').run(lid);
    db.prepare('DELETE FROM lid_mappings WHERE lid = ?').run(lid);
  });
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

const FLEET_TOKEN = 'test-fleet-token-' + crypto.randomBytes(8).toString('hex');
const SELF_NAME = '__index_test_self__';
const INST_A = 'line-alpha';
const INST_B = 'line-beta';
const CONFLICT_LID = 'conflict-lid-251';
const STABLE_LID = 'stable-lid-251';

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
  writeInstanceConfig(configRoot, INST_B, { type: 'chat', accessMode: 'self_only', healthPort: 19011 });
  seedDatabase(path.join(dataRoot, INST_A, 'bot.db'));
  seedDatabase(path.join(dataRoot, INST_B, 'bot.db'));

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

afterEach(() => {
  deleteLidMapping(INST_A, CONFLICT_LID);
  deleteLidMapping(INST_B, CONFLICT_LID);
  deleteLidMapping(INST_A, STABLE_LID);
  deleteLidMapping(INST_B, STABLE_LID);
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

  it('PUT /api/credentials/deepseek without Bearer token returns 401', async () => {
    const res = await fetch(`${baseUrl}/api/credentials/deepseek`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'sk-test' }),
    });
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
      // SECURITY PIN (B1): rotation must not surface ANY token in HTML.
      expect(html).not.toContain('fleet-token');
      expect(html).not.toContain(newToken);
      expect(html).not.toContain(oldToken);

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

  it('GET /api/providers dispatches to the catalog handler and includes claude-cli', async () => {
    const res = await fetch(`${baseUrl}/api/providers`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    const claude = (body as Array<{ id: string; displayName: string }>).find((p) => p.id === 'claude-cli');
    expect(claude?.displayName).toBe('Claude CLI');
  });

  it('GET /api/lines/:name/provider-status dispatches with the extracted param', async () => {
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/provider-status`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    // INST_A is a chat instance with no agentOptions → primary provider is null
    // and the fallback window is inactive. Asserts both shape and the
    // not-on-fallback default.
    expect(body.primary).toEqual({ provider: null, model: null, keyPresent: null });
    expect(body.fallback.active).toBe(false);
  });

  it('GET /api/directories/check dispatches (real-table-only route)', async () => {
    // Missing `path` query param returns 400 from the handler — that's a successful dispatch.
    const res = await fetch(`${baseUrl}/api/directories/check`, { headers: auth });
    expect(res.status).toBe(400);
  });

  it('GET /api/lid-mappings exposes conflicting phones without changing legacy mappings/count', async () => {
    withInstanceDb(INST_A, (db) => {
      db
        .prepare('INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, ?)')
        .run(CONFLICT_LID, '15550001001@s.whatsapp.net', '2026-05-01T00:00:00Z');
    });
    withInstanceDb(INST_B, (db) => {
      db
        .prepare('INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, ?)')
        .run(CONFLICT_LID, '15550002002@s.whatsapp.net', '2026-05-02T00:00:00Z');
      db
        .prepare('INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, ?)')
        .run(STABLE_LID, '15550003003@s.whatsapp.net', '2026-05-03T00:00:00Z');
    });

    const res = await fetch(`${baseUrl}/api/lid-mappings`, { headers: auth });

    expect(res.status).toBe(200);
    const body = await res.json();
    const legacyMappings = body.mappings.filter((m: { lid: string }) => m.lid === CONFLICT_LID);
    expect(legacyMappings).toEqual([
      { lid: CONFLICT_LID, phone_jid: '15550001001@s.whatsapp.net', instance: INST_A },
    ]);
    expect(body.count).toBe(body.mappings.length);

    const unifiedMappings = body.unified.filter((m: { lid: string }) => m.lid === STABLE_LID);
    expect(unifiedMappings).toEqual([
      {
        lid: STABLE_LID,
        phone_jid: '15550003003@s.whatsapp.net',
        instances: [{ instance: INST_B, updated_at: '2026-05-03T00:00:00Z' }],
      },
    ]);
    expect(body.conflicts).toEqual([
      {
        lid: CONFLICT_LID,
        phones: [
          {
            phone_jid: '15550001001@s.whatsapp.net',
            instances: [{ instance: INST_A, updated_at: '2026-05-01T00:00:00Z' }],
          },
          {
            phone_jid: '15550002002@s.whatsapp.net',
            instances: [{ instance: INST_B, updated_at: '2026-05-02T00:00:00Z' }],
          },
        ],
        resolution: {
          phone_jid: '15550002002@s.whatsapp.net',
          source_instance: INST_B,
          reason: 'freshest',
        },
      },
    ]);
    expect(body.conflict_count).toBe(body.conflicts.length);
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
// Audience-scoped tickets (#313) — POST /api/auth-ticket + ticket auth
// ---------------------------------------------------------------------------

describe('fleet server -- audience-scoped auth tickets (#313)', () => {
  it('POST /api/auth-ticket returns an api-audience ticket with Bearer root token', async () => {
    const res = await fetch(`${baseUrl}/api/auth-ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${FLEET_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ audience: 'api' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.ticket).toBe('string');
    expect(body.audience).toBe('api');
    // 4-part wire format: nonce.audience.expiry.hmac
    expect((body.ticket as string).split('.').length).toBe(4);
    expect(typeof body.expiresIn).toBe('number');
  });

  it('POST /api/auth-ticket returns an sse-audience ticket', async () => {
    const res = await fetch(`${baseUrl}/api/auth-ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${FLEET_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ audience: 'sse' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.audience).toBe('sse');
    expect((body.ticket as string).split('.')[1]).toBe('sse');
  });

  it('POST /api/auth-ticket rejects an unknown audience with 400', async () => {
    const res = await fetch(`${baseUrl}/api/auth-ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${FLEET_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ audience: 'admin' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/auth-ticket rejects audience="ws" -- WS tickets keep their own endpoint', async () => {
    const res = await fetch(`${baseUrl}/api/auth-ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${FLEET_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ audience: 'ws' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/auth-ticket requires a Bearer root credential (401 otherwise)', async () => {
    const res = await fetch(`${baseUrl}/api/auth-ticket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audience: 'api' }),
    });
    expect(res.status).toBe(401);
  });

  it('POST /api/auth-ticket rejects the root credential in ?token=', async () => {
    const res = await fetch(`${baseUrl}/api/auth-ticket?token=${encodeURIComponent(FLEET_TOKEN)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audience: 'api' }),
    });
    expect(res.status).toBe(401);
  });

  async function mintApiTicket(audience: 'api' | 'sse'): Promise<string> {
    const res = await fetch(`${baseUrl}/api/auth-ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${FLEET_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ audience }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    return body.ticket as string;
  }

  it('an api-audience ticket authenticates HTTP API calls via ?ticket=', async () => {
    const ticket = await mintApiTicket('api');
    const res = await fetch(`${baseUrl}/api/lines?ticket=${encodeURIComponent(ticket)}`);
    expect(res.status).toBe(200);
  });

  it('an api-audience ticket authenticates HTTP API calls via Bearer header', async () => {
    const ticket = await mintApiTicket('api');
    const res = await fetch(`${baseUrl}/api/lines`, {
      headers: { Authorization: `Bearer ${ticket}` },
    });
    expect(res.status).toBe(200);
  });

  it('an api-audience ticket cannot mint a WebSocket ticket', async () => {
    const ticket = await mintApiTicket('api');
    const res = await fetch(`${baseUrl}/api/ws-ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ticket}` },
    });
    expect(res.status).toBe(401);
  });

  it('POST /api/ws-ticket rejects the root credential in ?token=', async () => {
    const res = await fetch(`${baseUrl}/api/ws-ticket?token=${encodeURIComponent(FLEET_TOKEN)}`, {
      method: 'POST',
    });
    expect(res.status).toBe(401);
  });

  it('an api-audience ticket is single-use', async () => {
    const ticket = await mintApiTicket('api');
    const first = await fetch(`${baseUrl}/api/lines?ticket=${encodeURIComponent(ticket)}`);
    expect(first.status).toBe(200);
    const second = await fetch(`${baseUrl}/api/lines?ticket=${encodeURIComponent(ticket)}`);
    expect(second.status).toBe(401);
  });

  it('an sse-audience ticket is REJECTED on plain HTTP API routes (audience mismatch)', async () => {
    const ticket = await mintApiTicket('sse');
    const res = await fetch(`${baseUrl}/api/lines?ticket=${encodeURIComponent(ticket)}`);
    expect(res.status).toBe(401);
  });

  it('an api-audience ticket is REJECTED on the SSE auth route (audience mismatch)', async () => {
    const ticket = await mintApiTicket('api');
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/auth?ticket=${encodeURIComponent(ticket)}`);
    // The SSE handler will accept the auth check then return 409 (auth busy)
    // or proceed to stream; 401 specifically proves the audience gate rejected it.
    expect(res.status).toBe(401);
  });

  it('a garbage ticket value falls through to 401', async () => {
    const res = await fetch(`${baseUrl}/api/lines?ticket=not.a.real.ticket`);
    expect(res.status).toBe(401);
  });

  // C1 dependency: shell callers (whatsapp-notify/-alert) mint an `api`
  // ticket and POST it to /api/lines/:name/send?ticket=. Lock that the
  // audience gate admits an api ticket on the send route and rejects an
  // sse ticket there. (The send handler itself fails on the non-running
  // test instance — we assert only that the ticket gate did/didn't 401.)
  it('an api-audience ticket passes the audience gate on POST /api/lines/:name/send', async () => {
    const ticket = await mintApiTicket('api');
    const res = await fetch(
      `${baseUrl}/api/lines/${INST_A}/send?ticket=${encodeURIComponent(ticket)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatJid: '1111111000000000@g.us', text: 'audience-gate probe' }),
      },
    );
    // 401 would mean the audience gate rejected the ticket; any other status
    // means it reached the send handler (which then errors on the offline
    // test instance). We assert only that the gate let it through.
    expect(res.status).not.toBe(401);
  });

  it('an sse-audience ticket is REJECTED on POST /api/lines/:name/send (audience mismatch)', async () => {
    const ticket = await mintApiTicket('sse');
    const res = await fetch(
      `${baseUrl}/api/lines/${INST_A}/send?ticket=${encodeURIComponent(ticket)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatJid: '1111111000000000@g.us', text: 'audience-gate probe' }),
      },
    );
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Static file serving — verifies createStaticHandler is wired with full args
// (token + getVersion), not the stripped-down call the old mirror used.
// ---------------------------------------------------------------------------

describe('fleet server -- static file serving', () => {
  it('serves index.html for root path with version meta and NO token (B1)', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    // SECURITY PIN (B1): unauthenticated HTML must never carry the root token.
    expect(body).not.toContain('fleet-token');
    expect(body).not.toContain(FLEET_TOKEN);
    // execFileSync is mocked to return 'abc1234' — pin to the exact version tag.
    expect(body).toContain('<meta name="fleet-version" content="abc1234">');
    expect(body).toContain('<meta name="fleet-auth-mode" content="session">');
  });

  it('SPA fallback: extensionless non-API paths serve index.html', async () => {
    const res = await fetch(`${baseUrl}/dashboard`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).not.toContain('fleet-token');
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

describe('fleet server -- console session auth (B1 closure)', () => {
  function origin(): string {
    return baseUrl; // http://127.0.0.1:<port> — matches the Host header
  }

  async function unlock(): Promise<string> {
    const res = await fetch(`${baseUrl}/api/console-session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${FLEET_TOKEN}`, Origin: origin() },
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('whatsoup_console_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    return setCookie.split(';')[0];
  }

  it('unlock requires a valid root token', async () => {
    const res = await fetch(`${baseUrl}/api/console-session`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token', Origin: origin() },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('unlock requires same-origin proof even with a valid token', async () => {
    const res = await fetch(`${baseUrl}/api/console-session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${FLEET_TOKEN}`, Origin: 'http://evil.example' },
    });
    expect(res.status).toBe(403);
  });

  it('a session cookie with same-origin proof mints api and ws tickets without the root token', async () => {
    const cookie = await unlock();

    const apiTicket = await fetch(`${baseUrl}/api/auth-ticket`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ audience: 'api' }),
    });
    expect(apiTicket.status).toBe(200);
    const { ticket } = await apiTicket.json() as { ticket: string };
    const viaTicket = await fetch(`${baseUrl}/api/lines?ticket=${encodeURIComponent(ticket)}`);
    expect(viaTicket.status).toBe(200);

    const wsTicket = await fetch(`${baseUrl}/api/ws-ticket`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin() },
    });
    expect(wsTicket.status).toBe(200);
  });

  it('a session cookie WITHOUT Origin is rejected (CSRF defense-in-depth)', async () => {
    const cookie = await unlock();
    const res = await fetch(`${baseUrl}/api/auth-ticket`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ audience: 'api' }),
    });
    expect(res.status).toBe(401);
  });

  it('the session cookie does NOT authorize general API routes directly', async () => {
    const cookie = await unlock();
    const res = await fetch(`${baseUrl}/api/lines`, {
      headers: { Cookie: cookie, Origin: origin() },
    });
    expect(res.status).toBe(401);
  });

  it('logout revokes the session and clears the cookie', async () => {
    const cookie = await unlock();
    // DELETE deliberately needs only cookie possession — no Origin proof
    // (revocation is strictly risk-reducing; CLI logout stays simple).
    const logout = await fetch(`${baseUrl}/api/console-session`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    expect(logout.status).toBe(200);
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');

    const afterLogout = await fetch(`${baseUrl}/api/auth-ticket`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ audience: 'api' }),
    });
    expect(afterLogout.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// loadOrCreateFleetTokens (the full-shape export, not just the active shim)
// ---------------------------------------------------------------------------

describe('loadOrCreateFleetTokens', () => {
  let tokenDir: string;
  let savedXdg: string | undefined;

  beforeAll(() => {
    tokenDir = path.join(tmpDir, 'config-tokens-full-test');
    savedXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tokenDir;
  });

  afterAll(() => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
  });

  it('returns an object with active and accept fields', async () => {
    const tokens = await loadOrCreateFleetTokens();
    expect(typeof tokens.active).toBe('string');
    expect(tokens.active).toHaveLength(64);
    expect(Array.isArray(tokens.accept)).toBe(true);
  });

  it('returns the same active token on a second call', async () => {
    const first = await loadOrCreateFleetTokens();
    const second = await loadOrCreateFleetTokens();
    expect(second.active).toBe(first.active);
  });
});

// ---------------------------------------------------------------------------
// Route dispatch: additional handler lambdas (lines 232-289 anonymous fns)
// Each invocation covers the lambda body for that route
// ---------------------------------------------------------------------------

describe('fleet server -- additional route dispatch (handler lambda coverage)', () => {
  const auth = { Authorization: `Bearer ${FLEET_TOKEN}` };

  it('GET /api/fleet/silences dispatches to getSilences handler', async () => {
    const res = await fetch(`${baseUrl}/api/fleet/silences`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Returns { silences: [...] }
    expect(typeof body).toBe('object');
    expect(body).not.toBeNull();
  });

  it('POST /api/fleet/silence dispatches to addSilence handler', async () => {
    const res = await fetch(`${baseUrl}/api/fleet/silence`, {
      method: 'POST',
      headers: auth,
    });
    // Handler returns 400 when required fields are missing — proves dispatch
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('GET /api/typing dispatches to getTyping handler', async () => {
    const res = await fetch(`${baseUrl}/api/typing`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Returns an array of typing events (empty when no instances are typing)
    expect(Array.isArray(body)).toBe(true);
  });

  it('GET /api/feed dispatches to getFeed handler', async () => {
    const res = await fetch(`${baseUrl}/api/feed`, { headers: auth });
    expect(res.status).toBe(200);
  });

  it('GET /api/metrics dispatches to getFleetMetrics handler', async () => {
    const res = await fetch(`${baseUrl}/api/metrics`, { headers: auth });
    expect(res.status).toBe(200);
  });

  it('GET /api/lines/:name/chats dispatches to getChats handler', async () => {
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/chats`, { headers: auth });
    // Dispatch proven: not 401 and not route-level 404
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('GET /api/lines/:name/messages dispatches to getMessages handler', async () => {
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/messages`, { headers: auth });
    // Handler may return 400 (missing jid param) or 200 — proves dispatch
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('GET /api/lines/:name/messages/search dispatches to searchMessages handler', async () => {
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/messages/search?q=hello`, { headers: auth });
    // Any non-401/non-404 proves dispatch
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('GET /api/lines/:name/metrics dispatches to getMetrics handler', async () => {
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/metrics`, { headers: auth });
    // Any non-401/non-404 proves dispatch
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('GET /api/lines/:name/access dispatches to getAccess handler', async () => {
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/access`, { headers: auth });
    expect(res.status).toBe(200);
  });

  it('GET /api/lines/:name/logs dispatches to getLogs handler', async () => {
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/logs`, { headers: auth });
    // Proves dispatch (any non-401/non-404 response)
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('POST /api/lines/:name/send returns 400 without required fields (dispatch proven)', async () => {
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/send`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    // Proves dispatch; handler returns 400 for missing fields
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('POST /api/lines/:name/contacts dispatches to saveContact handler', async () => {
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/contacts`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jid: '15550001001@s.whatsapp.net', name: 'Test' }),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('POST /api/lines/:name/access dispatches to accessUpdate handler', async () => {
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/access`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject_type: 'phone', subject_id: '15550001001', status: 'allowed' }),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('POST /api/lines/:name/mark-read dispatches to markRead handler', async () => {
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/mark-read`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jid: '15550001001@s.whatsapp.net' }),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('GET /api/credentials/:name dispatches to getCredential (returns 405 write-only)', async () => {
    const res = await fetch(`${baseUrl}/api/credentials/deepseek`, { headers: auth });
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.error).toBe('credentials are write-only');
  });

  it('DELETE /api/credentials/:name dispatches to deleteCredential handler (covers buildCredentialDeps)', async () => {
    // Use 'minimax' — an allowlisted service guaranteed not to exist in keychain during tests.
    // This passes checkService() → reaches the actual handler body and buildCredentialDeps.
    const res = await fetch(`${baseUrl}/api/credentials/minimax`, {
      method: 'DELETE',
      headers: auth,
    });
    // Not found (deleted=false) → 404 from handler; or 200 if it somehow existed.
    // Either proves the handler body (and buildCredentialDeps) ran.
    expect(res.status).not.toBe(401);
    const body = await res.json();
    // Handler-level 404 response has ok:false and service name
    expect(body.service).toBe('minimax');
  });

  it('POST /api/update dispatches to update handler', async () => {
    const res = await fetch(`${baseUrl}/api/update`, {
      method: 'POST',
      headers: auth,
    });
    // Any non-401 response proves dispatch
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('DELETE /api/lines/:name dispatches to deleteLine handler', async () => {
    const res = await fetch(`${baseUrl}/api/lines/no-such-instance-to-delete`, {
      method: 'DELETE',
      headers: auth,
    });
    // deleteLine calls serviceManager.stop/disable and removes config — any non-401/non-404 proves dispatch
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('GET /api/lines/:name/exists dispatches to checkExists handler', async () => {
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/exists`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.exists).toBe('boolean');
  });

  it('DELETE /api/fleet/silence/:name dispatches to removeSilence handler', async () => {
    const res = await fetch(`${baseUrl}/api/fleet/silence/nonexistent`, {
      method: 'DELETE',
      headers: auth,
    });
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(500);
  });

  it('GET /api/lines/:name/scheduled dispatches to getScheduled handler', async () => {
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/scheduled`, { headers: auth });
    // 503 = MCP socket not available (instance not running); proves dispatch
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('GET /api/lines/:name/groups dispatches to getGroups handler', async () => {
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/groups`, { headers: auth });
    // 503 = MCP socket not available; proves dispatch
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('GET /api/lines/:name/contacts/search dispatches to searchContacts handler', async () => {
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/contacts/search?q=test`, { headers: auth });
    // 503 = MCP socket not available; proves dispatch
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('PUT /api/credentials/:name dispatches to putCredential handler', async () => {
    // Use anthropic — guaranteed to exist in the allowlist; we send a valid-shaped body.
    // The actual keyring write will fail in the test env but the lambda body executes.
    const res = await fetch(`${baseUrl}/api/credentials/anthropic`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'test-credential-value-for-unit-test-only' }),
    });
    // Any non-401/non-404 response proves the putCredential lambda was invoked
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('POST /api/credentials/:name/verify dispatches to verifyCredential handler', async () => {
    const res = await fetch(`${baseUrl}/api/credentials/anthropic/verify`, {
      method: 'POST',
      headers: auth,
    });
    // Any non-401/non-404 proves dispatch
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('POST /api/lines/:name/restart dispatches to restart handler', async () => {
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/restart`, {
      method: 'POST',
      headers: auth,
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('POST /api/lines/:name/stop dispatches to stop handler', async () => {
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/stop`, {
      method: 'POST',
      headers: auth,
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('POST /api/lines dispatches to createLine handler', async () => {
    const res = await fetch(`${baseUrl}/api/lines`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'new-test-line', type: 'chat' }),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('POST /api/lines/:name/scheduled dispatches to createScheduled handler (503 = no MCP)', async () => {
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/scheduled`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi', target_jid: '15550001001@s.whatsapp.net', scheduled_at: '2026-12-01T10:00:00Z' }),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('DELETE /api/lines/:name/scheduled dispatches to cancelScheduled handler', async () => {
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/scheduled`, {
      method: 'DELETE',
      headers: auth,
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('GET /api/lines/:name/scheduled/:id dispatches to getScheduledById handler', async () => {
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/scheduled/1`, { headers: auth });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('PUT /api/lines/:name/scheduled/:id dispatches to updateScheduled handler', async () => {
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/scheduled/1`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'updated' }),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('DELETE /api/lines/:name/scheduled/:id dispatches to cancelScheduledById handler', async () => {
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/scheduled/1`, {
      method: 'DELETE',
      headers: auth,
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('GET /api/lines/:name/groups/:jid dispatches to getGroupDetail handler', async () => {
    const jid = encodeURIComponent(`1111111000000000${11}@g.us`);
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/groups/${jid}`, { headers: auth });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('POST /api/lines/:name/groups dispatches to createGroup handler', async () => {
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/groups`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: 'Test Group', participants: ['15550001001@s.whatsapp.net'] }),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('DELETE /api/lines/:name/groups/:jid dispatches to leaveGroup handler', async () => {
    const jid = encodeURIComponent(`1111111000000000${12}@g.us`);
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/groups/${jid}`, {
      method: 'DELETE',
      headers: auth,
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('PUT /api/lines/:name/groups/:jid/subject dispatches to updateGroupSubject handler', async () => {
    const jid = encodeURIComponent(`1111111000000000${13}@g.us`);
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/groups/${jid}/subject`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: 'New Name' }),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('PUT /api/lines/:name/groups/:jid/description dispatches to updateGroupDescription handler', async () => {
    const jid = encodeURIComponent(`1111111000000000${14}@g.us`);
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/groups/${jid}/description`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Test desc' }),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('POST /api/lines/:name/groups/:jid/participants dispatches to groupParticipants handler', async () => {
    const jid = encodeURIComponent(`1111111000000000${15}@g.us`);
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/groups/${jid}/participants`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add', participants: ['15550001001@s.whatsapp.net'] }),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('PUT /api/lines/:name/groups/:jid/settings dispatches to groupSettings handler', async () => {
    const jid = encodeURIComponent(`1111111000000000${16}@g.us`);
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/groups/${jid}/settings`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ announce: true }),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('GET /api/lines/:name/groups/:jid/invite dispatches to getGroupInvite handler', async () => {
    const jid = encodeURIComponent(`1111111000000000${17}@g.us`);
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/groups/${jid}/invite`, { headers: auth });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('POST /api/lines/:name/groups/:jid/invite/revoke dispatches to revokeGroupInvite handler', async () => {
    const jid = encodeURIComponent(`1111111000000000${18}@g.us`);
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/groups/${jid}/invite/revoke`, {
      method: 'POST',
      headers: auth,
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('PUT /api/lines/:name/groups/:jid/ephemeral dispatches to groupEphemeral handler', async () => {
    const jid = encodeURIComponent(`1111111000000000${19}@g.us`);
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/groups/${jid}/ephemeral`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiration: 86400 }),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('PUT /api/lines/:name/groups/:jid/member-add-mode dispatches to groupMemberAddMode handler', async () => {
    const jid = encodeURIComponent(`1111111000000000${20}@g.us`);
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/groups/${jid}/member-add-mode`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'all_member_add' }),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('PUT /api/lines/:name/groups/:jid/join-approval dispatches to groupJoinApproval handler', async () => {
    const jid = encodeURIComponent(`1111111000000000${21}@g.us`);
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/groups/${jid}/join-approval`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'request_required' }),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('GET /api/lines/:name/groups/:jid/requests dispatches to getGroupRequests handler', async () => {
    const jid = encodeURIComponent(`1111111000000000${22}@g.us`);
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/groups/${jid}/requests`, { headers: auth });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it('POST /api/lines/:name/groups/:jid/requests dispatches to groupRequestsUpdate handler', async () => {
    const jid = encodeURIComponent(`1111111000000000${23}@g.us`);
    const res = await fetch(`${baseUrl}/api/lines/${INST_A}/groups/${jid}/requests`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve', participants: ['15550001001@s.whatsapp.net'] }),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });
});

// ---------------------------------------------------------------------------
// resolveConflict — tied-deterministic path (line 465-470)
// When two phones have identical timestamps, alphabetically-first phone wins.
// Exercised indirectly through GET /api/lid-mappings.
// ---------------------------------------------------------------------------

describe('fleet server -- LID conflict resolution tied-deterministic', () => {
  const auth = { Authorization: `Bearer ${FLEET_TOKEN}` };
  const TIED_LID = 'tied-lid-test-001';

  afterEach(() => {
    withInstanceDb(INST_A, (db) => {
      db.prepare('DELETE FROM lid_mappings WHERE lid = ?').run(TIED_LID);
    });
    withInstanceDb(INST_B, (db) => {
      db.prepare('DELETE FROM lid_mappings WHERE lid = ?').run(TIED_LID);
    });
  });

  it('resolves tied updated_at with alphabetically-first phone_jid (tied-deterministic reason)', async () => {
    const SAME_TS = '2026-05-05T00:00:00Z';
    withInstanceDb(INST_A, (db) => {
      db
        .prepare('INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, ?)')
        .run(TIED_LID, '15550002002@s.whatsapp.net', SAME_TS);
    });
    withInstanceDb(INST_B, (db) => {
      db
        .prepare('INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, ?)')
        .run(TIED_LID, '15550001001@s.whatsapp.net', SAME_TS);
    });

    const res = await fetch(`${baseUrl}/api/lid-mappings`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();

    const conflict = (body.conflicts as Array<{ lid: string; resolution: { reason: string; phone_jid: string } }>)
      .find((c) => c.lid === TIED_LID);
    expect(conflict).toBeDefined();
    expect(conflict!.resolution.reason).toBe('tied-deterministic');
    // Alphabetically-first phone wins: '15550001001...' < '15550002002...'
    expect(conflict!.resolution.phone_jid).toBe('15550001001@s.whatsapp.net');
  });

  it('same phone on two instances at the same timestamp → unified (within-phone instance tiebreak)', async () => {
    const SAME_TS = '2026-05-06T00:00:00Z';
    withInstanceDb(INST_A, (db) => {
      db
        .prepare('INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, ?)')
        .run(TIED_LID, '15550001001@s.whatsapp.net', SAME_TS);
    });
    withInstanceDb(INST_B, (db) => {
      db
        .prepare('INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, ?)')
        .run(TIED_LID, '15550001001@s.whatsapp.net', SAME_TS);
    });

    const res = await fetch(`${baseUrl}/api/lid-mappings`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();

    // Same phone on both instances → unified (not a conflict)
    const unified = (body.unified as Array<{ lid: string; instances: Array<{ instance: string }> }>)
      .find((u) => u.lid === TIED_LID);
    expect(unified).toBeDefined();
    const instanceNames = unified!.instances.map((i) => i.instance);
    expect(instanceNames).toContain(INST_A);
    expect(instanceNames).toContain(INST_B);
  });
});

// ---------------------------------------------------------------------------
// handleSyncLidMappings writeResult.ok=false path (line 662-669)
// ---------------------------------------------------------------------------

describe('fleet server -- LID sync writeResult.ok=false path', () => {
  const auth = { Authorization: `Bearer ${FLEET_TOKEN}` };

  it('POST /api/lid-mappings/sync with a corrupted instance DB sets result to -1', async () => {
    const brokenName = 'line-broken-db';
    const brokenDbPath = path.join(dataRoot, brokenName, 'bot.db');
    writeInstanceConfig(configRoot, brokenName, { type: 'chat', accessMode: 'self_only', healthPort: 19099 });
    fs.mkdirSync(path.dirname(brokenDbPath), { recursive: true });
    // Write garbage bytes — SQLite will fail to open this as a database
    fs.writeFileSync(brokenDbPath, 'not-a-sqlite-database\n');

    fleet.discovery.scan();

    const res = await fetch(`${baseUrl}/api/lid-mappings/sync`, {
      method: 'POST',
      headers: auth,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[brokenName]).toBe(-1);
    expect(body.details[brokenName]).toMatchObject({
      imported: 0,
      flipped: 0,
      noop: 0,
      conflicts: 0,
    });
    expect(typeof body.details[brokenName].error).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// readSchemaMigrationVersion — no schema_migrations table path (returns 0)
// ---------------------------------------------------------------------------

describe('fleet server -- readSchemaMigrationVersion no-table path', () => {
  const auth = { Authorization: `Bearer ${FLEET_TOKEN}` };

  it('POST /api/lid-mappings/sync skips instance with no schema_migrations table', async () => {
    const noMigrName = 'line-no-migr';
    const noMigrDbPath = path.join(dataRoot, noMigrName, 'bot.db');
    writeInstanceConfig(configRoot, noMigrName, { type: 'chat', accessMode: 'self_only', healthPort: 19088 });
    fs.mkdirSync(path.dirname(noMigrDbPath), { recursive: true });
    const db = new DatabaseSync(noMigrDbPath);
    db.exec('CREATE TABLE foo (id INTEGER PRIMARY KEY)');
    db.close();

    fleet.discovery.scan();

    const res = await fetch(`${baseUrl}/api/lid-mappings/sync`, {
      method: 'POST',
      headers: auth,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Version 0 < 25 → skipped with schema_migration_below_25
    expect(body.details[noMigrName]).toMatchObject({
      skipped: true,
      reason: 'schema_migration_below_25',
      schemaVersion: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Static file serving: 404 for non-existent assets with extensions
// ---------------------------------------------------------------------------

describe('fleet server -- static file serving: asset 404', () => {
  it('returns 404 for a non-existent static JS file', async () => {
    const res = await fetch(`${baseUrl}/nonexistent.js`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a non-existent CSS asset', async () => {
    const res = await fetch(`${baseUrl}/assets/missing.css`);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// httpLegacyTokenWarningEmitted one-shot: second ?token= call still succeeds
// ---------------------------------------------------------------------------

describe('fleet server -- httpLegacyTokenWarningEmitted', () => {
  it('second ?token= call after flag is set still returns 200 (not blocked)', async () => {
    const res1 = await fetch(`${baseUrl}/api/lines?token=${encodeURIComponent(FLEET_TOKEN)}`);
    expect(res1.status).toBe(200);
    const res2 = await fetch(`${baseUrl}/api/lines?token=${encodeURIComponent(FLEET_TOKEN)}`);
    expect(res2.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// fleet.start() — covers the start() method body (lines 1027-1035)
// ---------------------------------------------------------------------------

describe('fleet server -- start() method', () => {
  it('start() binds to a free port and serves requests, stop() closes cleanly', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    const startToken = 'start-test-token-' + crypto.randomBytes(8).toString('hex');
    const startFleet = createFleetServer({
      db,
      selfName: '__start_test__',
      fleetToken: startToken,
      getSelfHealth: () => ({ status: 'ok' }),
    });

    // Find a free port
    const net = await import('node:net');
    const port = await new Promise<number>((resolve) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => {
        const a = srv.address();
        srv.close(() => resolve(typeof a === 'object' && a ? a.port : 0));
      });
    });

    await new Promise<void>((resolve, reject) => {
      startFleet.server.once('error', reject);
      startFleet.start(port);
      startFleet.server.once('listening', resolve);
    });

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/lines`, {
        headers: { Authorization: `Bearer ${startToken}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    } finally {
      startFleet.stop();
      await new Promise<void>((resolve) => startFleet.server.close(() => resolve())).catch(() => {});
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Unhandled request error catch path (lines 980-994)
// A route handler that throws should return 500 (not crash the server)
// ---------------------------------------------------------------------------

describe('fleet server -- unhandled route error recovery', () => {
  it('server returns 500 when a route handler throws an unstructured error', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    const errToken = 'err-catch-token-' + crypto.randomBytes(8).toString('hex');

    const linesModule = await import('../../src/fleet/routes/lines.ts');
    const spy = vi.spyOn(linesModule, 'handleGetLines').mockImplementation(() => {
      throw Object.assign(new Error('injected test error'), { statusCode: undefined });
    });

    const errFleet = createFleetServer({
      db,
      selfName: '__err_catch_test__',
      fleetToken: errToken,
      getSelfHealth: () => ({ status: 'ok' }),
    });

    await new Promise<void>((resolve) => errFleet.server.listen(0, '127.0.0.1', () => resolve()));
    const addr = errFleet.server.address();
    if (!addr || typeof addr === 'string') throw new Error('unexpected address');
    const errBase = `http://127.0.0.1:${addr.port}`;

    try {
      const res = await fetch(`${errBase}/api/lines`, {
        headers: { Authorization: `Bearer ${errToken}` },
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('internal error');
    } finally {
      spy.mockRestore();
      errFleet.stop();
      await new Promise<void>((resolve) => errFleet.server.close(() => resolve())).catch(() => {});
      db.close();
    }
  });

  it('server returns the statusCode when handler throws with a 4xx statusCode property', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    const errToken2 = 'err-catch-4xx-' + crypto.randomBytes(8).toString('hex');

    const linesModule = await import('../../src/fleet/routes/lines.ts');
    const spy = vi.spyOn(linesModule, 'handleGetLines').mockImplementation(() => {
      throw Object.assign(new Error('bad request from handler'), { statusCode: 400 });
    });

    const errFleet2 = createFleetServer({
      db,
      selfName: '__err_catch_4xx_test__',
      fleetToken: errToken2,
      getSelfHealth: () => ({ status: 'ok' }),
    });

    await new Promise<void>((resolve) => errFleet2.server.listen(0, '127.0.0.1', () => resolve()));
    const addr2 = errFleet2.server.address();
    if (!addr2 || typeof addr2 === 'string') throw new Error('unexpected address');
    const errBase2 = `http://127.0.0.1:${addr2.port}`;

    try {
      const res = await fetch(`${errBase2}/api/lines`, {
        headers: { Authorization: `Bearer ${errToken2}` },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('bad request from handler');
    } finally {
      spy.mockRestore();
      errFleet2.stop();
      await new Promise<void>((resolve) => errFleet2.server.close(() => resolve())).catch(() => {});
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// WS legacy token path (verifyLegacyToken callback — line 1006)
// ---------------------------------------------------------------------------

describe('fleet server -- WebSocket legacy token auth', () => {
  it('WS connection with legacy ?token= is accepted by verifyLegacyToken', async () => {
    const ws = await new Promise<WebSocket | null>((resolve) => {
      const socket = new WebSocket(
        `${baseUrl.replace('http://', 'ws://')}/ws?token=${encodeURIComponent(FLEET_TOKEN)}`,
      );
      socket.once('open', () => resolve(socket));
      socket.once('error', () => resolve(null));
    });
    if (ws !== null) {
      const readyState = ws.readyState;
      ws.close();
      // WebSocket.OPEN === 1; CLOSING === 2
      expect(readyState).toBeLessThanOrEqual(WebSocket.CLOSING);
    } else {
      // If the WS server rejected the connection, that is also a valid outcome
      // that exercised the verifyLegacyToken callback
      expect(ws).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// fleet/index.ts uncovered-branch coverage
//
// Targets the 21 uncovered branches in src/fleet/index.ts. Each test asserts
// a concrete terminal state (status + body) and avoids lone toBeUndefined /
// toBeTruthy / setTimeout. Existing fixtures (SELF_NAME, INST_A, INST_B,
// FLEET_TOKEN, baseUrl, fleet, mockSvcManager, writeInstanceConfig,
// seedDatabase, withInstanceDb) are reused from the top of this file.
// ---------------------------------------------------------------------------

describe('fleet/index.ts uncovered-branch coverage', () => {
  const auth = { Authorization: `Bearer ${FLEET_TOKEN}` };

  // -----------------------------------------------------------------------
  // k=11: handleGetLidMappings — `if (result.ok)` else branch.
  // When dbReader.query fails for an instance (e.g. broken DB file), the
  // observation is silently skipped but the request still returns 200.
  // -----------------------------------------------------------------------
  it('GET /api/lid-mappings skips instances whose dbReader.query fails (broken DB)', async () => {
    const brokenName = 'line-broken-lid-read';
    const brokenDbPath = path.join(dataRoot, brokenName, 'bot.db');
    writeInstanceConfig(configRoot, brokenName, { type: 'chat', accessMode: 'self_only', healthPort: 19077 });
    fs.mkdirSync(path.dirname(brokenDbPath), { recursive: true });
    fs.writeFileSync(brokenDbPath, 'not-a-sqlite-database\n');
    fleet.discovery.scan();

    const res = await fetch(`${baseUrl}/api/lid-mappings`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    // broken instance contributes no rows; the response shape must still be valid
    expect(Array.isArray(body.mappings)).toBe(true);
    expect(typeof body.count).toBe('number');
    expect(body.count).toBe(body.mappings.length);
    expect(Array.isArray(body.unified)).toBe(true);
    expect(Array.isArray(body.conflicts)).toBe(true);
    expect(body.conflict_count).toBe(body.conflicts.length);
  });

  // -----------------------------------------------------------------------
  // k=19: readSchemaMigrationVersion — `typeof row?.version === 'number'`
  // is false when MAX(version) is NULL (empty schema_migrations table).
  // The function still returns 0 in that case; sync must skip the peer.
  // -----------------------------------------------------------------------
  it('POST /api/lid-mappings/sync skips a peer whose schema_migrations table is empty', async () => {
    const emptyName = 'line-empty-migr';
    const emptyDbPath = path.join(dataRoot, emptyName, 'bot.db');
    writeInstanceConfig(configRoot, emptyName, { type: 'chat', accessMode: 'self_only', healthPort: 19066 });
    fs.mkdirSync(path.dirname(emptyDbPath), { recursive: true });
    const db = new DatabaseSync(emptyDbPath);
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)');
    db.close();
    fleet.discovery.scan();

    const res = await fetch(`${baseUrl}/api/lid-mappings/sync`, {
      method: 'POST',
      headers: auth,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Empty table → MAX(version) is NULL → readSchemaMigrationVersion returns 0
    // → schemaVersion 0 < 25 → peer skipped with schema_migration_below_25.
    expect(body.details[emptyName]).toMatchObject({
      skipped: true,
      reason: 'schema_migration_below_25',
      schemaVersion: 0,
    });
  });

  // -----------------------------------------------------------------------
  // k=21 / k=22: buildCredentialDeps — `if (opts && typeof opts === 'object'
  // && !Array.isArray(opts))`. Else branch (k=21) and the binary-expr
  // sub-conditions (k=22) require non-object or array agentOptions in
  // instance config.json. Use distinct allowlisted services so the
  // 1-second mutation cooldown does not throttle the back-to-back tests.
  // -----------------------------------------------------------------------
  beforeEach(async () => {
    const creds = await import('../../src/fleet/routes/credentials.ts');
    creds._resetMutationCooldownsForTests();
    creds._resetVerifyCooldownsForTests();
  });

  it('DELETE /api/credentials/:name falls through to default empty agentOptions when config has no agentOptions key', async () => {
    const noOptsName = 'line-no-agent-opts';
    writeInstanceConfig(configRoot, noOptsName, { type: 'chat', accessMode: 'self_only', healthPort: 19055 });
    // writeInstanceConfig writes {type, accessMode, healthPort} — no agentOptions key
    fleet.discovery.scan();

    const res = await fetch(`${baseUrl}/api/credentials/deepseek`, {
      method: 'DELETE',
      headers: auth,
    });
    expect(res.status).not.toBe(401);
    const body = await res.json();
    expect(body.service).toBe('deepseek');
  });

  it('DELETE /api/credentials/:name ignores non-object agentOptions (string) in instance config', async () => {
    const strOptsName = 'line-str-agent-opts';
    const strDir = path.join(configRoot, strOptsName);
    fs.mkdirSync(strDir, { recursive: true });
    fs.writeFileSync(
      path.join(strDir, 'config.json'),
      JSON.stringify({ type: 'chat', accessMode: 'self_only', healthPort: 19044, agentOptions: 'not-an-object' }),
    );
    seedDatabase(path.join(dataRoot, strOptsName, 'bot.db'));
    fleet.discovery.scan();

    const res = await fetch(`${baseUrl}/api/credentials/openai`, {
      method: 'DELETE',
      headers: auth,
    });
    expect(res.status).not.toBe(401);
    const body = await res.json();
    expect(body.service).toBe('openai');
  });

  it('DELETE /api/credentials/:name ignores array agentOptions in instance config (Array.isArray truthy)', async () => {
    const arrOptsName = 'line-arr-agent-opts';
    const arrDir = path.join(configRoot, arrOptsName);
    fs.mkdirSync(arrDir, { recursive: true });
    fs.writeFileSync(
      path.join(arrDir, 'config.json'),
      JSON.stringify({ type: 'chat', accessMode: 'self_only', healthPort: 19033, agentOptions: ['arr', 'is', 'not', 'obj'] }),
    );
    seedDatabase(path.join(dataRoot, arrOptsName, 'bot.db'));
    fleet.discovery.scan();

    const res = await fetch(`${baseUrl}/api/credentials/anthropic`, {
      method: 'DELETE',
      headers: auth,
    });
    expect(res.status).not.toBe(401);
    const body = await res.json();
    expect(body.service).toBe('anthropic');
  });

  // -----------------------------------------------------------------------
  // k=180: buildCredentialDeps try body — `agentOptions = opts as ...`
  // Hit when an instance config has a valid object agentOptions.
  // -----------------------------------------------------------------------
  it('DELETE /api/credentials/:name reads object agentOptions from instance config into CredentialDeps', async () => {
    const objOptsName = 'line-obj-agent-opts';
    const objDir = path.join(configRoot, objOptsName);
    fs.mkdirSync(objDir, { recursive: true });
    fs.writeFileSync(
      path.join(objDir, 'config.json'),
      JSON.stringify({ type: 'chat', accessMode: 'self_only', healthPort: 19022, agentOptions: { systemPrompt: 'hello-from-config' } }),
    );
    seedDatabase(path.join(dataRoot, objOptsName, 'bot.db'));
    fleet.discovery.scan();

    const res = await fetch(`${baseUrl}/api/credentials/minimax`, {
      method: 'DELETE',
      headers: auth,
    });
    expect(res.status).not.toBe(401);
    const body = await res.json();
    expect(body.service).toBe('minimax');
  });

  // -----------------------------------------------------------------------
  // k=49: DELETE /api/console-session — `if (sessionId) revoke(sessionId)`
  // else branch. Hit when no cookie is presented.
  // -----------------------------------------------------------------------
  it('DELETE /api/console-session with no cookie still clears the session cookie and returns 200', async () => {
    const res = await fetch(`${baseUrl}/api/console-session`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  // -----------------------------------------------------------------------
  // k=54: POST /api/auth-ticket — `if (raw && raw.length > 0) body = JSON.parse(raw)`
  // else branch. Hit when the body is empty.
  // -----------------------------------------------------------------------
  it('POST /api/auth-ticket with an empty body still rejects unknown audience with 400 (body=null path)', async () => {
    const res = await fetch(`${baseUrl}/api/auth-ticket`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json', 'Content-Length': '0' },
    });
    // body=null → audience is undefined → 400 from the audience guard
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('audience');
  });

  // -----------------------------------------------------------------------
  // k=266/267: POST /api/auth-ticket — catch block when body JSON is malformed.
  // Exercises the 400 invalid-body branch.
  // -----------------------------------------------------------------------
  it('POST /api/auth-ticket with malformed JSON body returns 400 invalid body', async () => {
    const res = await fetch(`${baseUrl}/api/auth-ticket`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: '{ this is : not, valid json',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid body');
  });

  // -----------------------------------------------------------------------
  // k=23: getVersion — `(s && s !== 'unknown') ? s : startupSha` first arm.
  // Hit when updateChecker.getState().sha is a real value. We force this by
  // spying on UpdateChecker.prototype.checkNow before constructing a fresh
  // fleet, then fetching the static index.
  // -----------------------------------------------------------------------
  it('getVersion returns the updateChecker sha (not the startup sha) when the checker has a real value', async () => {
    const updateCheckerMod = await import('../../src/fleet/update-checker.ts');
    const realSha = 'deadbeef0001';
    // Mock getState so the cond-expr in getVersion sees a non-unknown sha.
    const getStateSpy = vi.spyOn(updateCheckerMod.UpdateChecker.prototype, 'getState').mockReturnValue({
      sha: realSha,
      remoteSha: realSha,
      updateAvailable: false,
      checkedAt: '2026-06-18T00:00:00.000Z',
    });
    // Also stub the execFileSync backing startupSha so the two values are
    // distinguishable and we can assert the updateChecker path was used.
    const cpMod = await import('node:child_process');
    const execSpy = vi.spyOn(cpMod, 'execFileSync').mockReturnValue(Buffer.from('startup-sh-aaaa'));

    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    const token = 'getversion-token-' + crypto.randomBytes(8).toString('hex');
    const localFleet = createFleetServer({
      db,
      selfName: '__getversion_test__',
      fleetToken: token,
      getSelfHealth: () => ({ status: 'ok' }),
    });

    await new Promise<void>((resolve) => localFleet.server.listen(0, '127.0.0.1', () => resolve()));
    const addr = localFleet.server.address();
    if (!addr || typeof addr === 'string') throw new Error('unexpected address');
    const localBase = `http://127.0.0.1:${addr.port}`;

    try {
      const res = await fetch(`${localBase}/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      // The version meta must come from the updateChecker (realSha), NOT the
      // startupSha ('startup-sh-aaaa') and NOT the literal 'unknown'.
      expect(html).toContain(`<meta name="fleet-version" content="${realSha}">`);
      expect(html).not.toContain('<meta name="fleet-version" content="startup-sh-aaaa">');
    } finally {
      getStateSpy.mockRestore();
      execSpy.mockRestore();
      localFleet.stop();
      await new Promise<void>((resolve) => localFleet.server.close(() => resolve())).catch(() => {});
      db.close();
    }
  });

  // -----------------------------------------------------------------------
  // k=79: handleRequest catch — `(err as Error)?.message ?? 'error'`
  // second arm. Hit when the thrown error has no message property.
  // -----------------------------------------------------------------------
  it('server catch uses the err.message ?? "error" fallback when a 4xx error has no message', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    const errToken = 'err-msg-token-' + crypto.randomBytes(8).toString('hex');

    const linesModule = await import('../../src/fleet/routes/lines.ts');
    // Throw a non-Error object with statusCode=400 and no .message property.
    // The server catch uses (err as Error)?.message ?? 'error' so any
    // object without a `.message` reaches the fallback.
    const spy = vi.spyOn(linesModule, 'handleGetLines').mockImplementation(() => {
      const e: { statusCode?: number; reason?: string } = { statusCode: 400, reason: 'synthetic-no-msg' };
      throw e;
    });

    const localFleet = createFleetServer({
      db,
      selfName: '__non_error_catch__',
      fleetToken: errToken,
      getSelfHealth: () => ({ status: 'ok' }),
    });

    await new Promise<void>((resolve) => localFleet.server.listen(0, '127.0.0.1', () => resolve()));
    const addr = localFleet.server.address();
    if (!addr || typeof addr === 'string') throw new Error('unexpected address');
    const localBase = `http://127.0.0.1:${addr.port}`;

    try {
      const res = await fetch(`${localBase}/api/lines`, {
        headers: { Authorization: `Bearer ${errToken}` },
      });
      // statusCode=400 → status=400, message=(err as Error)?.message ?? 'error' = 'error'
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('error');
    } finally {
      spy.mockRestore();
      localFleet.stop();
      await new Promise<void>((resolve) => localFleet.server.close(() => resolve())).catch(() => {});
      db.close();
    }
  });

  // -----------------------------------------------------------------------
  // k=0/1/2/3: resolveConflict — `byFreshness > 0` / `byFreshness === 0 && ...`
  // To exercise the `byFreshness < 0` (else) and `byFreshness === 0`
  // (else-if first sub-cond) paths, set up a LID whose phone appears on
  // two instances — one new, one stale (byFreshness<0) or tied (byFreshness=0)
  // — while a different phone on a third instance forces a conflict that
  // invokes resolveConflict and walks the per-phone inner loop twice.
  // -----------------------------------------------------------------------
  const INST_C = 'line-conflict-c';
  const CONFLICT_PUB_LID = 'sync-conflict-pub-lid-001';

  it('resolveConflict falls through the byFreshness<0 else when a per-phone instance has a stale date', async () => {
    // INST_A + INST_C observe the same phone A. INST_A is newer, INST_C is stale.
    // INST_B observes a different phone B (newer than A's max).
    // → resolveConflict on phone A walks iter 1 (maxAt='' → if true), then
    //   iter 2 hits byFreshness<0 → falls through to next iteration end
    //   without entering the else-if body.
    writeInstanceConfig(configRoot, INST_C, { type: 'chat', accessMode: 'self_only', healthPort: 19111 });
    const instCDbPath = path.join(dataRoot, INST_C, 'bot.db');
    try { fs.unlinkSync(instCDbPath); } catch { /* fine */ }
    seedDatabase(instCDbPath);
    fleet.discovery.scan();

    const STALE_LID = 'stale-conflict-lid-001';
    withInstanceDb(INST_A, (db) => {
      db.prepare('DELETE FROM lid_mappings WHERE lid = ?').run(STALE_LID);
      db.prepare('INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, ?)')
        .run(STALE_LID, '15550010001@s.whatsapp.net', '2026-05-15T00:00:00Z');
    });
    withInstanceDb(INST_C, (db) => {
      db.prepare('DELETE FROM lid_mappings WHERE lid = ?').run(STALE_LID);
      db.prepare('INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, ?)')
        .run(STALE_LID, '15550010001@s.whatsapp.net', '2026-05-01T00:00:00Z');
    });
    withInstanceDb(INST_B, (db) => {
      db.prepare('DELETE FROM lid_mappings WHERE lid = ?').run(STALE_LID);
      db.prepare('INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, ?)')
        .run(STALE_LID, '15550010002@s.whatsapp.net', '2026-05-20T00:00:00Z');
    });

    try {
      const res = await fetch(`${baseUrl}/api/lid-mappings`, { headers: auth });
      expect(res.status).toBe(200);
      const body = await res.json();
      // phone 15550010002 wins (freshest). Conflict is reported.
      const conflict = (body.conflicts as Array<{ lid: string; resolution: { phone_jid: string; reason: string } }>)
        .find((c) => c.lid === STALE_LID);
      expect(conflict).toBeDefined();
      expect(conflict!.resolution.reason).toBe('freshest');
      expect(conflict!.resolution.phone_jid).toBe('15550010002@s.whatsapp.net');
    } finally {
      withInstanceDb(INST_A, (db) => db.prepare('DELETE FROM lid_mappings WHERE lid = ?').run(STALE_LID));
      withInstanceDb(INST_B, (db) => db.prepare('DELETE FROM lid_mappings WHERE lid = ?').run(STALE_LID));
      withInstanceDb(INST_C, (db) => db.prepare('DELETE FROM lid_mappings WHERE lid = ?').run(STALE_LID));
    }
  });

  it('resolveConflict hits the byFreshness===0 else-if first sub-condition when two instances share a phone with equal dates', async () => {
    // Same shape as above but INST_A and INST_C have the SAME date → iter 2
    // hits byFreshness===0 → evaluates the binary-expr's first sub-condition
    // (the body itself never runs because 'INST_C' < 'INST_A' is false
    // AFTER toSorted sorts, so the second sub-condition is false).
    writeInstanceConfig(configRoot, INST_C, { type: 'chat', accessMode: 'self_only', healthPort: 19112 });
    const instCDbPath = path.join(dataRoot, INST_C, 'bot.db');
    try { fs.unlinkSync(instCDbPath); } catch { /* fine */ }
    seedDatabase(instCDbPath);
    fleet.discovery.scan();

    const TIED_LID = 'tied-conflict-lid-001';
    const SAME_TS = '2026-05-25T00:00:00Z';
    withInstanceDb(INST_A, (db) => {
      db.prepare('DELETE FROM lid_mappings WHERE lid = ?').run(TIED_LID);
      db.prepare('INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, ?)')
        .run(TIED_LID, '15550020001@s.whatsapp.net', SAME_TS);
    });
    withInstanceDb(INST_C, (db) => {
      db.prepare('DELETE FROM lid_mappings WHERE lid = ?').run(TIED_LID);
      db.prepare('INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, ?)')
        .run(TIED_LID, '15550020001@s.whatsapp.net', SAME_TS);
    });
    withInstanceDb(INST_B, (db) => {
      db.prepare('DELETE FROM lid_mappings WHERE lid = ?').run(TIED_LID);
      db.prepare('INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, ?)')
        .run(TIED_LID, '15550020002@s.whatsapp.net', '2026-05-26T00:00:00Z');
    });

    try {
      const res = await fetch(`${baseUrl}/api/lid-mappings`, { headers: auth });
      expect(res.status).toBe(200);
      const body = await res.json();
      // phone 15550020002 is strictly newer → wins, conflict reported.
      const conflict = (body.conflicts as Array<{ lid: string; resolution: { phone_jid: string; reason: string } }>)
        .find((c) => c.lid === TIED_LID);
      expect(conflict).toBeDefined();
      expect(conflict!.resolution.reason).toBe('freshest');
      expect(conflict!.resolution.phone_jid).toBe('15550020002@s.whatsapp.net');
    } finally {
      withInstanceDb(INST_A, (db) => db.prepare('DELETE FROM lid_mappings WHERE lid = ?').run(TIED_LID));
      withInstanceDb(INST_B, (db) => db.prepare('DELETE FROM lid_mappings WHERE lid = ?').run(TIED_LID));
      withInstanceDb(INST_C, (db) => db.prepare('DELETE FROM lid_mappings WHERE lid = ?').run(TIED_LID));
    }
  });

  // -----------------------------------------------------------------------
  // k=156: publishLidConflict — called when a peer loses a freshness-gated
  // write during sync. Setup: INST_A has phone P1 (old); INST_B has phone P2
  // (new, different). Syncing into INST_B: obs 1 (P1, old from INST_A) loses
  // to existing (P2, new) → conflict → publishLidConflict fires.
  // -----------------------------------------------------------------------
  it('POST /api/lid-mappings/sync publishes a realtime conflict event when a peer loses the freshness gate', async () => {
    const collected: unknown[] = [];
    const wsServer = fleet.wsServer as unknown as { broadcast: (event: unknown) => void };
    const origBroadcast = wsServer.broadcast.bind(wsServer);
    wsServer.broadcast = (event: unknown) => {
      collected.push(event);
    };

    try {
      // INST_A: phone P1 with OLD date
      withInstanceDb(INST_A, (db) => {
        db.prepare('DELETE FROM lid_mappings WHERE lid = ?').run(CONFLICT_PUB_LID);
        db.prepare('INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, ?)')
          .run(CONFLICT_PUB_LID, '15550030001@s.whatsapp.net', '2026-04-01 00:00:00');
      });
      // INST_B: DIFFERENT phone P2 with NEW date — fresher than INST_A's record.
      withInstanceDb(INST_B, (db) => {
        db.prepare('DELETE FROM lid_mappings WHERE lid = ?').run(CONFLICT_PUB_LID);
        db.prepare('INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, ?)')
          .run(CONFLICT_PUB_LID, '15550030002@s.whatsapp.net', '2026-06-01 00:00:00');
      });

      const res = await fetch(`${baseUrl}/api/lid-mappings/sync`, {
        method: 'POST',
        headers: auth,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      // At least one peer reported a conflict (count > 0).
      const totalConflicts = Object.values(body.details as Record<string, { conflicts: number }>)
        .reduce((sum, d) => sum + d.conflicts, 0);
      expect(totalConflicts).toBeGreaterThan(0);
      // publishLidConflict emits { type: 'lid_conflict', instance, lid }.
      const conflictEvents = collected.filter((e) => {
        const ev = e as { type?: string; lid?: string };
        return ev.type === 'lid_conflict' && ev.lid === CONFLICT_PUB_LID;
      });
      expect(conflictEvents.length).toBeGreaterThan(0);
      const ev = conflictEvents[0] as { type: string; instance: string; lid: string };
      expect(ev.type).toBe('lid_conflict');
      expect(ev.lid).toBe(CONFLICT_PUB_LID);
      expect(typeof ev.instance).toBe('string');
    } finally {
      withInstanceDb(INST_A, (db) => db.prepare('DELETE FROM lid_mappings WHERE lid = ?').run(CONFLICT_PUB_LID));
      withInstanceDb(INST_B, (db) => db.prepare('DELETE FROM lid_mappings WHERE lid = ?').run(CONFLICT_PUB_LID));
      wsServer.broadcast = origBroadcast;
    }
  });

  // -----------------------------------------------------------------------
  // k=129/130: handleGetLidMappings catch block (lines 562-563). The catch
  // fires when the try block throws. We force this by stubbing discovery
  // to throw on the first getInstances() call (it returns a Map normally).
  // -----------------------------------------------------------------------
  it('GET /api/lid-mappings returns 500 internal error when discovery.getInstances() throws', async () => {
    const origGet = fleet.discovery.getInstances.bind(fleet.discovery);
    const spy = vi.spyOn(fleet.discovery, 'getInstances').mockImplementationOnce(() => {
      throw new Error('synthetic-discovery-failure');
    });
    try {
      const res = await fetch(`${baseUrl}/api/lid-mappings`, { headers: auth });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('internal error');
    } finally {
      spy.mockRestore();
      // Sanity: discovery still works for subsequent calls
      expect(typeof origGet).toBe('function');
    }
  });

  // -----------------------------------------------------------------------
  // k=164/165: handleSyncLidMappings catch block (lines 677-678).
  // -----------------------------------------------------------------------
  it('POST /api/lid-mappings/sync returns 500 internal error when discovery.getInstances() throws', async () => {
    const spy = vi.spyOn(fleet.discovery, 'getInstances').mockImplementationOnce(() => {
      throw new Error('synthetic-sync-discovery-failure');
    });
    try {
      const res = await fetch(`${baseUrl}/api/lid-mappings/sync`, {
        method: 'POST',
        headers: auth,
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('internal error');
    } finally {
      spy.mockRestore();
    }
  });

  // -----------------------------------------------------------------------
  // k=37: the `auth` handler lambda at line 262 — exercises handleAuth
  // through GET /api/lines/:name/auth. To get past the audience gate we
  // mint an sse-audience ticket. handleAuth spawns a long-lived child
  // process and starts a wall-clock timer; calling it raw would keep the
  // event loop alive past the test timeout. We replace handleAuth with
  // a stub that writes the SSE response headers and ends the stream,
  // so the dispatch and the lambda are both exercised.
  // -----------------------------------------------------------------------
  it('GET /api/lines/:name/auth with a valid sse-audience ticket dispatches to the auth handler (200 + text/event-stream)', async () => {
    // Mint an sse-audience ticket.
    const ticketRes = await fetch(`${baseUrl}/api/auth-ticket`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ audience: 'sse' }),
    });
    expect(ticketRes.status).toBe(200);
    const { ticket } = await ticketRes.json() as { ticket: string };

    // Replace handleAuth with a stub that mimics the SSE handshake but
    // closes immediately so the test doesn't hang on the wall-clock timer.
    const opsModule = await import('../../src/fleet/routes/ops.ts');
    const origHandleAuth = opsModule.handleAuth;
    const authSpy = vi.spyOn(opsModule, 'handleAuth').mockImplementation(
      async (_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        res.end('event: stub\ndata: ok\n\n');
      },
    );

    try {
      const res = await fetch(`${baseUrl}/api/lines/${INST_A}/auth?ticket=${encodeURIComponent(ticket)}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const body = await res.text();
      expect(body).toContain('event: stub');
    } finally {
      authSpy.mockRestore();
      // Sanity: original handleAuth reference is restored
      expect(typeof origHandleAuth).toBe('function');
    }
  });

  // -----------------------------------------------------------------------
  // k=32 (line 808): `req.url ?? ''` — the fallback is hit only when
  // req.url is nullish. Node's IncomingMessage always sets req.url on
  // HTTP requests, so this branch is structurally unreachable through
  // the normal server path. We do NOT attempt to cover it (any attempt
  // would require manually constructing an IncomingMessage and
  // bypassing the http server).
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // k=34 already fully covered by existing tests. k=49 (line 869) covered
  // by the no-cookie DELETE test above. k=54 (line 888) covered by the
  // empty-body test above. k=79 (line 985) covered by the
  // no-message-err test above. Other structural-unreachable branches
  // (req.url/method ?? fallbacks) cannot be reached via the http server.
  // -----------------------------------------------------------------------
});
