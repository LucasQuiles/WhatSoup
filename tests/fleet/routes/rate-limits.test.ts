/**
 * Tests for the rate-limit / throttle read path (D-5, PDR-5 corrected):
 *  - FleetDbReader.getRateLimits (real node:sqlite, minimal schema)
 *  - GET /api/lines/:name/rate-limits (handleGetRateLimits, fake deps)
 *
 * Design/implementation lineage: PR #1937
 * The `rate_limits` table is per-SENDER chat throttling (successful
 * responses), `llm_attempts` every LLM invocation (audit 1065) — the
 * windowed excess is the retry/token-storm signal (#1864 class).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { unlinkSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { FleetDbReader } from '../../../src/fleet/db-reader.ts';
import { handleGetRateLimits } from '../../../src/fleet/routes/rate-limits.ts';
import type { RateLimitsDeps } from '../../../src/fleet/routes/rate-limits.ts';
import type { DiscoveredInstance } from '../../../src/fleet/discovery.ts';
import { mockReq, mockRes } from '../../helpers/http-mocks.ts';

const MINIMAL_SCHEMA = `
  CREATE TABLE rate_limits (
    sender_jid TEXT NOT NULL,
    response_at TEXT NOT NULL
  );
  CREATE INDEX idx_rate_limits_sender ON rate_limits(sender_jid, response_at);
  CREATE TABLE llm_attempts (
    sender_jid TEXT NOT NULL,
    attempt_at TEXT NOT NULL
  );
`;

function tmpFile(): string {
  return join(tmpdir(), `fleet-rl-${randomBytes(8).toString('hex')}.db`);
}

function cleanup(...paths: string[]): void {
  for (const p of paths) {
    for (const suffix of ['', '-wal', '-shm']) {
      const full = p + suffix;
      if (existsSync(full)) { try { unlinkSync(full); } catch { /* ignore */ } }
    }
  }
}

function insertResponses(db: DatabaseSync, sender: string, count: number, agoSec = 60): void {
  const stmt = db.prepare(`
    INSERT INTO rate_limits (sender_jid, response_at)
    VALUES (?, datetime('now', ?))
  `);
  for (let i = 0; i < count; i += 1) stmt.run(sender, `-${agoSec} seconds`);
}

function insertAttempts(db: DatabaseSync, sender: string, count: number, agoSec = 60): void {
  const stmt = db.prepare(`
    INSERT INTO llm_attempts (sender_jid, attempt_at)
    VALUES (?, datetime('now', ?))
  `);
  for (let i = 0; i < count; i += 1) stmt.run(sender, `-${agoSec} seconds`);
}

describe('FleetDbReader.getRateLimits', () => {
  let dbPath: string;
  let reader: FleetDbReader;
  const LIMIT = 10;
  const WINDOW_MS = 3_600_000; // 1h

  beforeEach(() => {
    dbPath = tmpFile();
    const setup = new DatabaseSync(dbPath);
    setup.exec(MINIMAL_SCHEMA);
    setup.close();
    reader = new FleetDbReader('other-instance', new DatabaseSync(':memory:'));
  });

  afterEach(() => { cleanup(dbPath); });

  it('buckets senders throttled / near-limit / under, orders top senders, totals the window', () => {
    const db = new DatabaseSync(dbPath);
    insertResponses(db, '111@s.whatsapp.net', 12); // over limit → throttled
    insertResponses(db, '222@s.whatsapp.net', 10); // at limit → throttled (>= limit gates)
    insertResponses(db, '333@s.whatsapp.net', 9);  // 90% → near limit
    insertResponses(db, '444@s.whatsapp.net', 8);  // exactly 80% → near limit
    insertResponses(db, '555@s.whatsapp.net', 2);  // under
    insertResponses(db, '666@s.whatsapp.net', 1);
    db.close();

    const result = reader.getRateLimits('chat-line', dbPath, { limit: LIMIT, windowMs: WINDOW_MS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.supported).toBe(true);
    expect(result.data.throttled).toBe(2);
    expect(result.data.nearLimit).toBe(2);
    expect(result.data.windowedResponses).toBe(42);
    expect(result.data.topSenders.map((s) => s.senderJid)).toEqual([
      '111@s.whatsapp.net', '222@s.whatsapp.net', '333@s.whatsapp.net', '444@s.whatsapp.net', '555@s.whatsapp.net',
    ]);
    expect(result.data.topSenders[0]?.count).toBe(12);
  });

  it('excludes responses outside the window', () => {
    const db = new DatabaseSync(dbPath);
    insertResponses(db, '111@s.whatsapp.net', 12, 60);      // inside
    insertResponses(db, '111@s.whatsapp.net', 20, 7200);    // 2h ago — outside (rows die at 2h but window is 1h)
    insertResponses(db, '222@s.whatsapp.net', 3, 3700);     // just outside
    db.close();

    const result = reader.getRateLimits('chat-line', dbPath, { limit: LIMIT, windowMs: WINDOW_MS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.throttled).toBe(1);
    expect(result.data.windowedResponses).toBe(12);
  });

  it('excessAttempts = windowed attempts − responses, floored at zero (token-storm signal)', () => {
    const db = new DatabaseSync(dbPath);
    insertResponses(db, '111@s.whatsapp.net', 5);
    insertAttempts(db, '111@s.whatsapp.net', 14); // 9 wasted (retries/outage)
    insertAttempts(db, '222@s.whatsapp.net', 2);  // 2 attempts, 0 responses
    db.close();

    const result = reader.getRateLimits('chat-line', dbPath, { limit: LIMIT, windowMs: WINDOW_MS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.windowedResponses).toBe(5);
    expect(result.data.windowedAttempts).toBe(16);
    expect(result.data.excessAttempts).toBe(11);
  });

  it('supported:false with zeroed counts when the tables are absent (legacy DB), never an error', () => {
    const emptyPath = tmpFile();
    const setup = new DatabaseSync(emptyPath);
    setup.exec(`CREATE TABLE unrelated (id INTEGER);`);
    setup.close();
    const result = reader.getRateLimits('chat-line', emptyPath, { limit: LIMIT, windowMs: WINDOW_MS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.supported).toBe(false);
    expect(result.data.throttled).toBe(0);
    expect(result.data.topSenders).toEqual([]);
    cleanup(emptyPath);
  });
});

// ─── GET /api/lines/:name/rate-limits ───────────────────────────────────────

function fakeInstance(overrides: Partial<DiscoveredInstance> = {}): DiscoveredInstance {
  return {
    name: 'chat-line',
    type: 'chat',
    accessMode: 'open',
    healthPort: 3020,
    dbPath: '/data/chat-line/bot.db',
    stateRoot: '/state/chat-line',
    logDir: '/data/chat-line/logs',
    healthToken: null,
    configPath: '/config/chat-line/config.json',
    socketPath: null,
    ...overrides,
  } as DiscoveredInstance;
}

function makeDeps(
  inst: DiscoveredInstance | undefined,
  getRateLimits: ReturnType<typeof vi.fn>,
): RateLimitsDeps {
  return {
    discovery: {
      getInstance: vi.fn(() => inst),
      getInstances: vi.fn(() => (inst ? new Map([[inst.name, inst]]) : new Map())),
    } as any,
    dbReader: { getRateLimits } as any,
  } as RateLimitsDeps;
}

const SAMPLE_DATA = {
  supported: true,
  throttled: 1,
  nearLimit: 2,
  topSenders: [{ senderJid: '111@s.whatsapp.net', count: 47 }],
  windowedResponses: 60,
  windowedAttempts: 75,
  excessAttempts: 15,
};

describe('GET /api/lines/:name/rate-limits (handleGetRateLimits)', () => {
  let configDir: string;
  let configPath: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'fleet-rl-cfg-'));
    configPath = join(configDir, 'config.json');
  });

  afterEach(() => { cleanup(configPath); });

  it('404s for an unknown line', async () => {
    const deps = makeDeps(undefined, vi.fn());
    const res = mockRes();
    await handleGetRateLimits(mockReq(), res, deps, { name: 'ghost' });
    expect(res._status).toBe(404);
  });

  it('200s with the aggregate, reading limit + window from the instance config.json', async () => {
    writeFileSync(configPath, JSON.stringify({ rateLimitPerHour: 30, rateLimitWindowMs: 1_800_000 }));
    const getRateLimits = vi.fn(() => ({ ok: true as const, data: SAMPLE_DATA }));
    const deps = makeDeps(fakeInstance({ configPath }), getRateLimits);
    const res = mockRes();
    await handleGetRateLimits(mockReq(), res, deps, { name: 'chat-line' });
    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.limit).toBe(30);
    expect(body.windowMs).toBe(1_800_000);
    expect(body.limitSource).toBe('config');
    expect(body.throttled).toBe(1);
    expect(body.excessAttempts).toBe(15);
    expect(body.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(getRateLimits).toHaveBeenCalledWith('chat-line', '/data/chat-line/bot.db', { limit: 30, windowMs: 1_800_000 });
  });

  it('falls back to the documented defaults (45 / 1h) when config.json is absent, declaring limitSource default', async () => {
    const getRateLimits = vi.fn(() => ({ ok: true as const, data: SAMPLE_DATA }));
    const deps = makeDeps(fakeInstance({ configPath: join(configDir, 'missing.json') }), getRateLimits);
    const res = mockRes();
    await handleGetRateLimits(mockReq(), res, deps, { name: 'chat-line' });
    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.limit).toBe(45);
    expect(body.windowMs).toBe(3_600_000);
    expect(body.limitSource).toBe('default');
  });

  it('fails closed on read error: 200 + readError, never fake-zero counts', async () => {
    const getRateLimits = vi.fn(() => ({ ok: false as const, error: 'SQLITE_BUSY' }));
    const deps = makeDeps(fakeInstance({ configPath }), getRateLimits);
    const res = mockRes();
    await handleGetRateLimits(mockReq(), res, deps, { name: 'chat-line' });
    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.readError).toBe(true);
    expect(body).not.toHaveProperty('throttled');
    expect(body).not.toHaveProperty('topSenders');
  });
});
