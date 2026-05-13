/**
 * tests/fleet/legacy-token-warning.test.ts
 *
 * Covers the HTTP-API deprecation warning for legacy `?token=<root>` auth
 * (#393). Mirrors the existing `ws_legacy_token_path` warning emitted on the
 * WebSocket path. Boots the real `createFleetServer` factory with a logger
 * mock that captures `warn({ legacy, path }, 'http_legacy_token_path')`
 * calls so we can assert:
 *
 *   - the warning fires when authentication succeeds via `?token=`
 *   - the warning does NOT fire when authentication succeeds via Bearer
 *   - the warning is one-shot per server lifetime (second request silent)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// Mocks — must be set up before importing fleet modules.

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

// Logger mock — capture every warn call so the test can introspect.
type WarnCall = { obj: Record<string, unknown> | undefined; msg: string };
const warnCalls: WarnCall[] = [];

vi.mock('../../src/logger.ts', () => {
  const noop = () => {};
  const warn = (obj: unknown, msg?: unknown) => {
    if (typeof obj === 'string') {
      warnCalls.push({ obj: undefined, msg: obj });
    } else {
      warnCalls.push({
        obj: obj as Record<string, unknown> | undefined,
        msg: typeof msg === 'string' ? msg : '',
      });
    }
  };
  const child = () => fakeLogger;
  const fakeLogger: Record<string, unknown> = {
    info: noop, warn, error: noop, debug: noop, trace: noop, fatal: noop,
    child, flush: noop,
  };
  return { default: fakeLogger, createChildLogger: () => fakeLogger, flushLogger: async () => {} };
});

import { createFleetServer, HTTP_LEGACY_QUERY_TOKEN_REMOVAL_DATE } from '../../src/fleet/index.ts';

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

const FLEET_TOKEN = 'test-fleet-token-' + crypto.randomBytes(8).toString('hex');
const SELF_NAME = '__legacy_token_warning_self__';

let tmpDir: string;
let selfDb: DatabaseSync;
let fleet: ReturnType<typeof createFleetServer>;
let baseUrl: string;
let savedEnv: Record<string, string | undefined>;

function legacyWarnCount(): number {
  return warnCalls.filter((c) => c.msg === 'http_legacy_token_path').length;
}

beforeAll(async () => {
  savedEnv = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  };

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-legacy-warn-'));
  const configRoot = path.join(tmpDir, 'config', 'whatsoup', 'instances');
  const dataRoot = path.join(tmpDir, 'data', 'whatsoup', 'instances');
  const stateRoot = path.join(tmpDir, 'state', 'whatsoup', 'instances');
  fs.mkdirSync(configRoot, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true });

  process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
  process.env.XDG_DATA_HOME = path.join(tmpDir, 'data');
  process.env.XDG_STATE_HOME = path.join(tmpDir, 'state');

  const selfDataDir = path.join(dataRoot, SELF_NAME);
  fs.mkdirSync(selfDataDir, { recursive: true });
  selfDb = new DatabaseSync(path.join(selfDataDir, 'bot.db'));
  selfDb.exec(SCHEMA_SQL);

  fleet = createFleetServer({
    db: selfDb,
    selfName: SELF_NAME,
    fleetToken: FLEET_TOKEN,
    getSelfHealth: () => ({ status: 'ok' }),
  });
  fleet.discovery.scan();

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

// The legacy-token warning is one-shot per server lifetime, so the order of
// these `it` blocks is load-bearing: the "does not fire on Bearer" case must
// run before the "fires on ?token=" case, otherwise the one-shot flag is
// already tripped and the Bearer assertion is vacuous.

describe('fleet HTTP API -- legacy ?token= deprecation warning (#393)', () => {
  it('does NOT emit http_legacy_token_path on Bearer-authenticated requests', async () => {
    const before = legacyWarnCount();
    const res = await fetch(`${baseUrl}/api/lines`, {
      headers: { Authorization: `Bearer ${FLEET_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(legacyWarnCount()).toBe(before);
  });

  it('does NOT emit http_legacy_token_path on a failed ?token= attempt', async () => {
    const before = legacyWarnCount();
    const res = await fetch(`${baseUrl}/api/lines?token=not-the-real-token`);
    expect(res.status).toBe(401);
    expect(legacyWarnCount()).toBe(before);
  });

  it('emits http_legacy_token_path exactly once when ?token= auth succeeds', async () => {
    const before = legacyWarnCount();
    const res = await fetch(
      `${baseUrl}/api/lines?token=${encodeURIComponent(FLEET_TOKEN)}`,
    );
    expect(res.status).toBe(200);
    expect(legacyWarnCount()).toBe(before + 1);

    const matching = warnCalls.filter((c) => c.msg === 'http_legacy_token_path');
    const last = matching[matching.length - 1];
    expect(last.obj).toMatchObject({
      legacy: 'http-token-in-url',
      path: '/api/lines',
      removeAfter: HTTP_LEGACY_QUERY_TOKEN_REMOVAL_DATE,
    });
  });

  it('is one-shot per server lifetime — subsequent ?token= requests stay silent', async () => {
    const before = legacyWarnCount();
    const res = await fetch(
      `${baseUrl}/api/lines?token=${encodeURIComponent(FLEET_TOKEN)}`,
    );
    expect(res.status).toBe(200);
    expect(legacyWarnCount()).toBe(before);
  });

  it('documents the same removal date in README.md', () => {
    const readme = fs.readFileSync(path.resolve('README.md'), 'utf8');
    expect(readme).toContain(`scheduled for removal after **${HTTP_LEGACY_QUERY_TOKEN_REMOVAL_DATE}**`);
    expect(readme).toContain(`removeAfter: "${HTTP_LEGACY_QUERY_TOKEN_REMOVAL_DATE}"`);
  });
});
