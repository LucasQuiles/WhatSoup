/**
 * Fleet LID sync against mixed-version peers (issue #321).
 *
 * Migration 25 added `lid_mappings_history`. `handleSyncLidMappings` writes
 * through `importLidMappings -> writeLidMapping`, which unconditionally
 * INSERTs into that history table. `FleetDbReader.queryWrite()` opens peer
 * DBs raw -- no migrations run. During a rolling fleet upgrade, a v<25 peer
 * therefore throws `no such table: lid_mappings_history` and the import
 * transaction rolls back for that peer.
 *
 * Option B (chosen): pre-check `schema_migrations.MAX(version)` per peer.
 * Below the required version, skip the peer entirely (neither
 * lid_mappings nor lid_mappings_history is touched) and report it in
 * `skippedInstances` so the caller can act on the rollout gap.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// ---------------------------------------------------------------------------
// Mocks -- must precede fleet imports.
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

import { createFleetServer } from '../../src/fleet/index.ts';

// ---------------------------------------------------------------------------
// Schema fragments
// ---------------------------------------------------------------------------

/** v25 schema -- has lid_mappings AND lid_mappings_history. */
const SCHEMA_SQL_V25 = `
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

/** v24 schema -- has lid_mappings but NOT lid_mappings_history. */
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

/**
 * Very-old peer -- no `schema_migrations` table at all.
 * MAX(version) lookup must treat this as version 0 and skip.
 */
const SCHEMA_SQL_NO_MIGRATIONS = `
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

function writeInstanceConfig(configRoot: string, name: string): void {
  const instanceDir = path.join(configRoot, name);
  fs.mkdirSync(instanceDir, { recursive: true });
  fs.writeFileSync(
    path.join(instanceDir, 'config.json'),
    JSON.stringify({ type: 'chat', accessMode: 'self_only', healthPort: 3010 }, null, 2),
  );
}

function seedDb(dbPath: string, schemaSql: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(schemaSql);
  db.close();
}

// ---------------------------------------------------------------------------
// Shared fleet bootstrap.
// ---------------------------------------------------------------------------

const FLEET_TOKEN = 'mixed-schema-test-' + crypto.randomBytes(8).toString('hex');
const SELF_NAME = '__mixed_self__';
const INST_V25 = 'line-v25';
const INST_V24 = 'line-v24';
const INST_NO_MIG = 'line-no-migrations';

let tmpDir: string;
let dataRoot: string;
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

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-mixed-schema-'));
  const configRoot = path.join(tmpDir, 'config', 'whatsoup', 'instances');
  dataRoot = path.join(tmpDir, 'data', 'whatsoup', 'instances');
  const stateRoot = path.join(tmpDir, 'state', 'whatsoup', 'instances');
  fs.mkdirSync(configRoot, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true });

  process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
  process.env.XDG_DATA_HOME = path.join(tmpDir, 'data');
  process.env.XDG_STATE_HOME = path.join(tmpDir, 'state');

  // Three peers: current, behind-by-one, ancient (no schema_migrations).
  writeInstanceConfig(configRoot, INST_V25);
  writeInstanceConfig(configRoot, INST_V24);
  writeInstanceConfig(configRoot, INST_NO_MIG);
  seedDb(path.join(dataRoot, INST_V25, 'bot.db'), SCHEMA_SQL_V25);
  seedDb(path.join(dataRoot, INST_V24, 'bot.db'), SCHEMA_SQL_V24);
  seedDb(path.join(dataRoot, INST_NO_MIG, 'bot.db'), SCHEMA_SQL_NO_MIGRATIONS);

  // Self DB on v25 (the orchestrator must be current; that's the realistic case).
  const selfDataDir = path.join(dataRoot, SELF_NAME);
  fs.mkdirSync(selfDataDir, { recursive: true });
  selfDb = new DatabaseSync(path.join(selfDataDir, 'bot.db'));
  selfDb.exec(SCHEMA_SQL_V25);

  // Seed one observation on the v25 peer so the sync has work to do AND we
  // can later assert the v24/no-mig peers were NOT touched.
  const v25Db = new DatabaseSync(path.join(dataRoot, INST_V25, 'bot.db'));
  v25Db
    .prepare('INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, ?)')
    .run('999111', '15559991111@s.whatsapp.net', '2026-05-01 00:00:00');
  v25Db.close();

  // dist/index.html for static handler.
  const distDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    fs.writeFileSync(path.join(distDir, 'index.html'), '<html><head></head><body>fleet</body></html>');
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
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fleet LID sync -- mixed-version peers (#321)', () => {
  const auth = { Authorization: `Bearer ${FLEET_TOKEN}` };

  it('returns 200 and skips v<25 peers via details.skipped; v25 peer is written normally', async () => {
    const res = await fetch(`${baseUrl}/api/lid-mappings/sync`, {
      method: 'POST', headers: auth,
    });

    // Before the fix the v24 / no-migrations peers throw "no such table:
    // lid_mappings_history" inside importLidMappings, which `queryWrite`
    // catches and reports as `results[name] = -1` with the SQLite error
    // surfaced in `details[name].error`. The fix replaces that with a
    // pre-write schema-version gate that surfaces in
    // `details[name].skipped/reason/schemaVersion` (matches PR-1 detail
    // structure).
    expect(res.status).toBe(200);
    const body = await res.json();

    // v24 peer: schema_migrations.MAX(version) = 24 -> skipped.
    expect(body.results[INST_V24]).toBe(0);
    expect(body.details[INST_V24]).toMatchObject({
      imported: 0,
      flipped: 0,
      noop: 0,
      conflicts: 0,
      skipped: true,
      reason: 'schema_migration_below_25',
      schemaVersion: 24,
    });

    // Ancient peer: no schema_migrations table -> schemaVersion=null, also skipped.
    expect(body.results[INST_NO_MIG]).toBe(0);
    expect(body.details[INST_NO_MIG]).toMatchObject({
      imported: 0,
      flipped: 0,
      noop: 0,
      conflicts: 0,
      skipped: true,
      reason: 'schema_migration_below_25',
    });
    expect(body.details[INST_NO_MIG].schemaVersion === null || body.details[INST_NO_MIG].schemaVersion === 0).toBe(true);

    // v25 peer: schema is current -> written normally, not skipped.
    expect(body.details[INST_V25]).toBeDefined();
    expect(body.details[INST_V25].skipped).not.toBe(true);
  });

  it('does not write any lid_mappings row into the v24 peer (full skip, not partial)', async () => {
    // Sanity: trigger the sync (idempotent for this fixture).
    await fetch(`${baseUrl}/api/lid-mappings/sync`, { method: 'POST', headers: auth });

    // The v24 peer started with zero lid_mappings rows. After the sync, it
    // must still have zero -- i.e. we did not write the lid_mappings row
    // and then fail on the history insert.
    const v24Db = new DatabaseSync(path.join(dataRoot, INST_V24, 'bot.db'));
    try {
      const count = v24Db
        .prepare('SELECT COUNT(*) AS n FROM lid_mappings')
        .get() as { n: number };
      expect(count.n).toBe(0);
    } finally {
      v24Db.close();
    }
  });

  it('does not error on the ancient peer that lacks schema_migrations entirely', async () => {
    const res = await fetch(`${baseUrl}/api/lid-mappings/sync`, {
      method: 'POST', headers: auth,
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    // No schema_migrations table at all: skip without throwing.
    expect(body.details[INST_NO_MIG]).toBeDefined();
    expect(body.details[INST_NO_MIG].skipped).toBe(true);
    expect(body.details[INST_NO_MIG].reason).toBe('schema_migration_below_25');
    // The lid_mappings_history table must NOT have been created on the peer.
    const peerDb = new DatabaseSync(path.join(dataRoot, INST_NO_MIG, 'bot.db'));
    try {
      const tbl = peerDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='lid_mappings_history'")
        .get();
      expect(tbl).toBeUndefined();
    } finally {
      peerDb.close();
    }
  });
});
