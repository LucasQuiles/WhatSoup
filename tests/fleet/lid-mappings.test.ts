/**
 * Fleet LID mapping conflict surfacing (issue #251 PR-2 / PR-3).
 *
 * GET /api/lid-mappings returns:
 *   { mappings, count, unified, conflicts, conflict_count }
 * Each conflict carries a `resolution: { phone_jid, source_instance, reason }`
 * where reason is 'freshest' or 'tied-deterministic'.
 *
 * POST /api/lid-mappings/sync emits one `lid_conflict` event per
 * detected conflict (when `details[*].conflicts > 0` for any peer).
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
  const fakeLogger: Record<string, unknown> = {
    info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop,
    child: () => fakeLogger, flush: noop,
  };
  return { default: fakeLogger, createChildLogger: () => fakeLogger, flushLogger: async () => {} };
});

import { createFleetServer } from '../../src/fleet/index.ts';
import { FleetWebSocketServer } from '../../src/fleet/websocket-server.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

function insertLid(dbPath: string, lid: string, phone: string, updatedAt: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare('INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, ?)')
      .run(lid, phone, updatedAt);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Shared fleet bootstrap.
// ---------------------------------------------------------------------------

const FLEET_TOKEN = 'lid-conflict-test-' + crypto.randomBytes(8).toString('hex');
const SELF_NAME = '__lid_conflict_self__';
const INST_ALPHA = 'line-alpha';
const INST_BRAVO = 'line-bravo';
const INST_CHARLIE = 'line-charlie';

// Conflict scenario: LID has three observations across three peers,
// one is strictly the freshest -> reason 'freshest'.
const LID_FRESHEST = 'L-freshest';
const PHONE_OLD = '15550000111@s.whatsapp.net';
const PHONE_MID = '15550000222@s.whatsapp.net';
const PHONE_NEW = '15550000333@s.whatsapp.net';

// Tie scenario: LID has two phones with identical max updated_at
// across peers -> alphabetical phone_jid wins, reason 'tied-deterministic'.
const LID_TIED = 'L-tied';
const PHONE_TIED_A = '15550001111@s.whatsapp.net'; // alphabetically first
const PHONE_TIED_B = '15550002222@s.whatsapp.net';

// Mixed timestamp format scenario: raw string ordering would pick the ISO
// timestamp because "T" sorts after space, but parsed time should pick NEWER.
const LID_MIXED_FORMAT = 'L-mixed-format';
const PHONE_MIXED_OLDER = '15550004444@s.whatsapp.net';
const PHONE_MIXED_NEWER = '15550005555@s.whatsapp.net';

// Single-phone (unified) mapping.
const LID_UNIFIED = 'L-unified';
const PHONE_UNIFIED = '15550003333@s.whatsapp.net';

let tmpDir: string;
let dataRoot: string;
let selfDb: DatabaseSync;
let fleet: ReturnType<typeof createFleetServer>;
let baseUrl: string;
let savedEnv: Record<string, string | undefined>;
let broadcastSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  savedEnv = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  };

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-lid-conflict-'));
  const configRoot = path.join(tmpDir, 'config', 'whatsoup', 'instances');
  dataRoot = path.join(tmpDir, 'data', 'whatsoup', 'instances');
  const stateRoot = path.join(tmpDir, 'state', 'whatsoup', 'instances');
  fs.mkdirSync(configRoot, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true });

  process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
  process.env.XDG_DATA_HOME = path.join(tmpDir, 'data');
  process.env.XDG_STATE_HOME = path.join(tmpDir, 'state');

  for (const inst of [INST_ALPHA, INST_BRAVO, INST_CHARLIE]) {
    writeInstanceConfig(configRoot, inst);
    seedDb(path.join(dataRoot, inst, 'bot.db'), SCHEMA_SQL_V25);
  }

  // Conflict: freshest winner. Alpha oldest, Bravo mid, Charlie newest.
  insertLid(path.join(dataRoot, INST_ALPHA, 'bot.db'), LID_FRESHEST, PHONE_OLD, '2026-01-01 00:00:00');
  insertLid(path.join(dataRoot, INST_BRAVO, 'bot.db'), LID_FRESHEST, PHONE_MID, '2026-02-01 00:00:00');
  insertLid(path.join(dataRoot, INST_CHARLIE, 'bot.db'), LID_FRESHEST, PHONE_NEW, '2026-03-01 00:00:00');

  // Conflict: tie. Both phones have identical max updated_at.
  insertLid(path.join(dataRoot, INST_ALPHA, 'bot.db'), LID_TIED, PHONE_TIED_A, '2026-04-01 00:00:00');
  insertLid(path.join(dataRoot, INST_BRAVO, 'bot.db'), LID_TIED, PHONE_TIED_B, '2026-04-01 00:00:00');

  // Conflict: timestamp formats differ but parse to ordered instants.
  insertLid(path.join(dataRoot, INST_ALPHA, 'bot.db'), LID_MIXED_FORMAT, PHONE_MIXED_OLDER, '2026-05-01T00:00:00Z');
  insertLid(path.join(dataRoot, INST_BRAVO, 'bot.db'), LID_MIXED_FORMAT, PHONE_MIXED_NEWER, '2026-05-01 00:00:01');

  // Unified single-phone mapping.
  insertLid(path.join(dataRoot, INST_ALPHA, 'bot.db'), LID_UNIFIED, PHONE_UNIFIED, '2026-01-15 00:00:00');
  insertLid(path.join(dataRoot, INST_BRAVO, 'bot.db'), LID_UNIFIED, PHONE_UNIFIED, '2026-01-15 00:00:00');

  // Self DB on v25.
  const selfDataDir = path.join(dataRoot, SELF_NAME);
  fs.mkdirSync(selfDataDir, { recursive: true });
  selfDb = new DatabaseSync(path.join(selfDataDir, 'bot.db'));
  selfDb.exec(SCHEMA_SQL_V25);

  // dist/index.html for static handler.
  const distDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    fs.writeFileSync(path.join(distDir, 'index.html'), '<html><head></head><body>fleet</body></html>');
  }

  // Spy on the broadcast method BEFORE server construction so the
  // deferred publisher wires to the spy.
  broadcastSpy = vi.spyOn(FleetWebSocketServer.prototype, 'broadcast').mockImplementation(() => {});

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

describe('GET /api/lid-mappings -- conflict surfacing (#251)', () => {
  const auth = { Authorization: `Bearer ${FLEET_TOKEN}` };

  it('returns unified mappings, conflicts, and conflict_count', async () => {
    const res = await fetch(`${baseUrl}/api/lid-mappings`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(Array.isArray(body.unified)).toBe(true);
    expect(Array.isArray(body.conflicts)).toBe(true);
    expect(body.conflict_count).toBe(body.conflicts.length);
    // We seeded three distinct conflicts: freshest + tied + mixed timestamp formats.
    expect(body.conflicts.length).toBe(3);
    expect(body.conflict_count).toBe(3);

    // Unified should contain L-unified.
    const unifiedLids = body.unified.map((u: { lid: string }) => u.lid);
    expect(unifiedLids).toContain(LID_UNIFIED);
  });

  it('each conflict has a resolution with phone_jid, source_instance, and reason', async () => {
    const res = await fetch(`${baseUrl}/api/lid-mappings`, { headers: auth });
    const body = await res.json();
    for (const conflict of body.conflicts) {
      expect(conflict).toHaveProperty('resolution');
      expect(conflict.resolution).toEqual({
        phone_jid: expect.any(String),
        source_instance: expect.any(String),
        reason: expect.stringMatching(/^(freshest|tied-deterministic)$/),
      });
    }
  });

  it('freshest scenario: max updated_at wins, reason=freshest, source_instance=that instance', async () => {
    const res = await fetch(`${baseUrl}/api/lid-mappings`, { headers: auth });
    const body = await res.json();
    const freshest = body.conflicts.find((c: { lid: string }) => c.lid === LID_FRESHEST);
    expect(freshest).toBeDefined();
    expect(freshest.resolution).toEqual({
      phone_jid: PHONE_NEW,
      source_instance: INST_CHARLIE,
      reason: 'freshest',
    });
  });

  it('tied scenario: alphabetical phone_jid wins, reason=tied-deterministic', async () => {
    const res = await fetch(`${baseUrl}/api/lid-mappings`, { headers: auth });
    const body = await res.json();
    const tied = body.conflicts.find((c: { lid: string }) => c.lid === LID_TIED);
    expect(tied).toBeDefined();
    expect(tied.resolution.phone_jid).toBe(PHONE_TIED_A);
    expect(tied.resolution.reason).toBe('tied-deterministic');
    // source_instance must be the alphabetically-first instance of the
    // winning phone.
    expect(tied.resolution.source_instance).toBe(INST_ALPHA);
  });

  it('mixed timestamp formats: parsed freshness wins instead of raw string order', async () => {
    const res = await fetch(`${baseUrl}/api/lid-mappings`, { headers: auth });
    const body = await res.json();
    const mixed = body.conflicts.find((c: { lid: string }) => c.lid === LID_MIXED_FORMAT);
    expect(mixed).toBeDefined();
    expect(mixed.resolution).toEqual({
      phone_jid: PHONE_MIXED_NEWER,
      source_instance: INST_BRAVO,
      reason: 'freshest',
    });
  });

  it('does not emit lid_conflict events on GET because reads must not trigger refetch loops', async () => {
    broadcastSpy.mockClear();
    await fetch(`${baseUrl}/api/lid-mappings`, { headers: auth });
    type LidConflictEvent = { type: string; instance?: string };
    const lidEvents = broadcastSpy.mock.calls
      .map((call: unknown[]) => call[0] as LidConflictEvent)
      .filter((ev: LidConflictEvent) => ev.type === 'lid_conflict');
    expect(lidEvents).toEqual([]);
  });
});

describe('POST /api/lid-mappings/sync -- conflict event emission (#251)', () => {
  const auth = { Authorization: `Bearer ${FLEET_TOKEN}` };

  it('emits at least one lid_conflict event when peers report conflicts > 0', async () => {
    broadcastSpy.mockClear();
    const res = await fetch(`${baseUrl}/api/lid-mappings/sync`, {
      method: 'POST', headers: auth,
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    // Sanity: at least one peer should have observed conflict writes.
    const conflictDetails = Object.values(body.details as Record<string, { conflicts: number }>)
      .filter(d => d.conflicts > 0);
    expect(conflictDetails.length).toBeGreaterThan(0);

    type LidConflictEvent = { type: string; lid?: string; conversationKey?: string };
    const lidEvents = broadcastSpy.mock.calls
      .map((call: unknown[]) => call[0] as LidConflictEvent)
      .filter((ev: LidConflictEvent) => ev.type === 'lid_conflict');
    expect(lidEvents.length).toBeGreaterThan(0);
    expect(lidEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'lid_conflict', lid: expect.any(String) }),
      ]),
    );
    expect(lidEvents.every((ev: LidConflictEvent) => ev.conversationKey === undefined)).toBe(true);

    for (const inst of [INST_ALPHA, INST_BRAVO, INST_CHARLIE]) {
      const db = new DatabaseSync(path.join(dataRoot, inst, 'bot.db'));
      try {
        const tied = db.prepare('SELECT phone_jid FROM lid_mappings WHERE lid = ?')
          .get(LID_TIED) as { phone_jid: string } | undefined;
        expect(tied?.phone_jid).toBe(PHONE_TIED_A);
      } finally {
        db.close();
      }
    }
  });
});
