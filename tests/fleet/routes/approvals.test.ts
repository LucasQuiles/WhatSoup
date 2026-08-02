/**
 * Tests for the approvals read + decision path (D-4 build):
 *  - FleetDbReader.getPendingPolls (real node:sqlite, pending_polls table)
 *  - GET /api/lines/:name/approvals (handleGetApprovals, fake deps)
 *  - POST /api/lines/:name/approvals/decision (handlePostApprovalDecision,
 *    proxyToInstance mocked at the module seam)
 *
 * Design: docs/proposals/2026-07-19-approval-queue.md (D1 v1 scope:
 * AskUserQuestion pending polls; D2(a) live instance proxy, offline-honest
 * 502; D4 declinedVia provenance is instance-side).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { unlinkSync, existsSync } from 'node:fs';
import { FleetDbReader } from '../../../src/fleet/db-reader.ts';
import { SQLITE_BUSY_TIMEOUT_PRAGMA } from '../../../src/lib/sqlite-constants.ts';

const proxyMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/fleet/http-proxy.ts', () => ({
  proxyToInstance: proxyMock,
}));

const { mockLogWarn } = vi.hoisted(() => ({ mockLogWarn: vi.fn() }));
vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: mockLogWarn,
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  handleGetApprovals,
  handlePostApprovalDecision,
  type ApprovalsDeps,
} from '../../../src/fleet/routes/approvals.ts';
import type { DiscoveredInstance } from '../../../src/fleet/discovery.ts';
import { mockReq, mockRes } from '../../helpers/http-mocks.ts';

const MINIMAL_SCHEMA = `
  CREATE TABLE pending_polls (
    map_key TEXT PRIMARY KEY,
    chat_jid TEXT NOT NULL,
    payload TEXT NOT NULL,
    hard_closes_at INTEGER
  );
`;

function tmpFile(): string {
  return join(tmpdir(), `fleet-approvals-${randomBytes(8).toString('hex')}.db`);
}

function cleanup(...paths: string[]): void {
  for (const p of paths) {
    for (const suffix of ['', '-wal', '-shm']) {
      const full = p + suffix;
      if (existsSync(full)) { try { unlinkSync(full); } catch { /* ignore */ } }
    }
  }
}

const SAMPLE_PAYLOAD = {
  questions: [
    {
      question: 'Deploy the new build to production?',
      options: [
        { label: 'Deploy now', description: 'Ship it immediately' },
        { label: 'Hold', description: 'Wait for the window' },
      ],
      multiSelect: false,
    },
  ],
  toolId: 'tool-1',
  chatJid: '15550000001@s.whatsapp.net',
  chatJidAliases: [],
  mode: 'poll',
  pollMessageIdToQuestionIndex: [['pollmsg-1', 0]],
  currentQuestionIndex: 0,
  answersCollected: {},
  createdAt: 1784400000000,
  resolution: 'first',
  timeoutMs: 3600000,
  votesByQuestion: [],
  adminJids: ['15550000001@s.whatsapp.net'],
  resolvedAt: null,
  source: 'askuser',
  sentPollMessageIds: ['pollmsg-1'],
};

function insertPending(db: DatabaseSync, mapKey: string, payload: object, hardClosesAt: number | null): void {
  db.prepare(`
    INSERT INTO pending_polls (map_key, chat_jid, payload, hard_closes_at)
    VALUES (?, ?, ?, ?)
  `).run(mapKey, (payload as { chatJid: string }).chatJid, JSON.stringify(payload), hardClosesAt);
}

describe('FleetDbReader.getPendingPolls', () => {
  let dbPath: string;
  let reader: FleetDbReader;

  beforeEach(() => {
    dbPath = tmpFile();
    const setup = new DatabaseSync(dbPath);
    setup.exec(MINIMAL_SCHEMA);
    setup.close();
    reader = new FleetDbReader('other-instance', new DatabaseSync(':memory:'));
  });

  afterEach(() => { cleanup(dbPath); });

  it('reads pending polls with questions/options/mode/timeout deserialized from the payload', () => {
    const db = new DatabaseSync(dbPath);
    insertPending(db, 'agent:chat:1', SAMPLE_PAYLOAD, 1784403600000);
    db.close();

    const result = reader.getPendingPolls('agent-line', dbPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.supported).toBe(true);
    expect(result.data.pending).toHaveLength(1);
    const p = result.data.pending[0]!;
    expect(p.mapKey).toBe('agent:chat:1');
    expect(p.chatJid).toBe('15550000001@s.whatsapp.net');
    expect(p.mode).toBe('poll');
    expect(p.source).toBe('askuser');
    expect(p.questions).toHaveLength(1);
    expect(p.questions[0]!.question).toBe('Deploy the new build to production?');
    expect(p.questions[0]!.options.map((o) => o.label)).toEqual(['Deploy now', 'Hold']);
    expect(p.questions[0]!.multiSelect).toBe(false);
    expect(p.hardClosesAt).toBe(1784403600000);
    expect(p.createdAt).toBe(1784400000000);
    expect(p.timeoutMs).toBe(3600000);
  });

  it('skips rows whose payload is unparseable (fail-visible, never fake-valid)', () => {
    const db = new DatabaseSync(dbPath);
    insertPending(db, 'agent:chat:good', SAMPLE_PAYLOAD, null);
    db.prepare(`INSERT INTO pending_polls (map_key, chat_jid, payload, hard_closes_at) VALUES (?, ?, ?, ?)`)
      .run('agent:chat:bad', 'x@y.z', 'not json{', null);
    db.close();

    const result = reader.getPendingPolls('agent-line', dbPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.pending).toHaveLength(1);
    expect(result.data.parseErrors).toBe(1);
  });

  it('supported:false when the table is absent (legacy DB), never an error', () => {
    const emptyPath = tmpFile();
    const setup = new DatabaseSync(emptyPath);
    setup.exec(`CREATE TABLE unrelated (id INTEGER);`);
    setup.close();
    const result = reader.getPendingPolls('agent-line', emptyPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.supported).toBe(false);
    expect(result.data.pending).toEqual([]);
    cleanup(emptyPath);
  });
});

// ─── routes ─────────────────────────────────────────────────────────────────

function fakeInstance(overrides: Partial<DiscoveredInstance> = {}): DiscoveredInstance {
  return {
    name: 'agent-line',
    type: 'agent',
    accessMode: 'self_only',
    healthPort: 3010,
    dbPath: '/data/agent-line/bot.db',
    stateRoot: '/state/agent-line',
    logDir: '/data/agent-line/logs',
    healthToken: 'tok',
    configPath: '/config/agent-line/config.json',
    socketPath: null,
    ...overrides,
  } as DiscoveredInstance;
}

function makeDeps(
  inst: DiscoveredInstance | undefined,
  getPendingPolls: ReturnType<typeof vi.fn>,
): ApprovalsDeps {
  return {
    discovery: {
      getInstance: vi.fn(() => inst),
      getInstances: vi.fn(() => (inst ? new Map([[inst.name, inst]]) : new Map())),
    } as any,
    dbReader: { getPendingPolls } as any,
  } as ApprovalsDeps;
}

const ROUTE_PENDING = {
  mapKey: 'agent:chat:1',
  chatJid: '15550000001@s.whatsapp.net',
  mode: 'poll',
  source: 'askuser',
  questions: SAMPLE_PAYLOAD.questions,
  currentQuestionIndex: 0,
  answersCollected: {},
  createdAt: SAMPLE_PAYLOAD.createdAt,
  timeoutMs: 3600000,
  hardClosesAt: 1784403600000,
};

describe('GET /api/lines/:name/approvals (handleGetApprovals)', () => {
  it('404s for an unknown line', async () => {
    const deps = makeDeps(undefined, vi.fn());
    const res = mockRes();
    await handleGetApprovals(mockReq(), res, deps, { name: 'ghost' });
    expect(res._status).toBe(404);
  });

  it('200s with the pending queue', async () => {
    const getPendingPolls = vi.fn(() => ({ ok: true as const, data: { supported: true, pending: [ROUTE_PENDING], parseErrors: 0 } }));
    const deps = makeDeps(fakeInstance(), getPendingPolls);
    const res = mockRes();
    await handleGetApprovals(mockReq(), res, deps, { name: 'agent-line' });
    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.approvals).toHaveLength(1);
    expect(body.approvals[0].mapKey).toBe('agent:chat:1');
    expect(body.observedAt).toMatch(/^\d{4}-/);
    expect(body).not.toHaveProperty('readError');
  });

  it('fails closed on read error: 200 + readError, never a fake-empty queue', async () => {
    const getPendingPolls = vi.fn(() => ({ ok: false as const, error: 'SQLITE_BUSY' }));
    const deps = makeDeps(fakeInstance(), getPendingPolls);
    const res = mockRes();
    await handleGetApprovals(mockReq(), res, deps, { name: 'agent-line' });
    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.readError).toBe(true);
    expect(body).not.toHaveProperty('approvals');
  });
});

describe('POST /api/lines/:name/approvals/decision (handlePostApprovalDecision)', () => {
  beforeEach(() => { proxyMock.mockReset(); mockLogWarn.mockClear(); });

  it('400s on a malformed body (missing selectedOptions)', async () => {
    const deps = makeDeps(fakeInstance(), vi.fn());
    const res = mockRes();
    await handlePostApprovalDecision(
      mockReq({ method: 'POST', body: JSON.stringify({ mapKey: 'agent:chat:1', questionIndex: 0 }) }),
      res, deps, { name: 'agent-line' },
    );
    expect(res._status).toBe(400);
    expect(proxyMock).not.toHaveBeenCalled();
  });

  it('proxies a valid decision to the instance health server and returns 202', async () => {
    proxyMock.mockResolvedValue({ status: 200, body: JSON.stringify({ ok: true }) });
    const deps = makeDeps(fakeInstance(), vi.fn());
    const res = mockRes();
    await handlePostApprovalDecision(
      mockReq({ method: 'POST', body: JSON.stringify({ mapKey: 'agent:chat:1', questionIndex: 0, selectedOptions: ['Deploy now'] }) }),
      res, deps, { name: 'agent-line' },
    );
    expect(res._status).toBe(202);
    expect(proxyMock).toHaveBeenCalledWith(3010, '/poll-decision', 'POST',
      JSON.stringify({ mapKey: 'agent:chat:1', questionIndex: 0, selectedOptions: ['Deploy now'] }), 'tok');
    expect(JSON.parse(res._body).status).toBe('decision_delivered');
  });

  it('relays the instance 409 verbatim when the poll was already resolved elsewhere', async () => {
    proxyMock.mockResolvedValue({ status: 409, body: JSON.stringify({ ok: false, error: 'already resolved' }) });
    const deps = makeDeps(fakeInstance(), vi.fn());
    const res = mockRes();
    await handlePostApprovalDecision(
      mockReq({ method: 'POST', body: JSON.stringify({ mapKey: 'agent:chat:1', questionIndex: 0, selectedOptions: ['Deploy now'] }) }),
      res, deps, { name: 'agent-line' },
    );
    expect(res._status).toBe(409);
    expect(JSON.parse(res._body).error).toMatch(/already resolved/);
  });

  it('v1.1: configures lock waiting before every durable-queue write, then returns 202 with the row present', async () => {
    const queueDbPath = tmpFile();
    const prepareSpy = vi.spyOn(DatabaseSync.prototype, 'prepare');
    const execSpy = vi.spyOn(DatabaseSync.prototype, 'exec');
    const runSpy = vi.spyOn(StatementSync.prototype, 'run');

    try {
      proxyMock.mockResolvedValue({ status: 502, body: JSON.stringify({ error: 'proxy error: connect ECONNREFUSED' }) });
      const deps = makeDeps(fakeInstance({ dbPath: queueDbPath }), vi.fn());
      const res = mockRes();
      await handlePostApprovalDecision(
        mockReq({ method: 'POST', body: JSON.stringify({ mapKey: 'agent:chat:1', questionIndex: 0, selectedOptions: ['Deploy now'] }) }),
        res, deps, { name: 'agent-line' },
      );

      expect(res._status).toBe(202);
      const body = JSON.parse(res._body);
      expect(body.status).toBe('decision_queued');
      expect(body.notice).toMatch(/next boot|queued/i);

      expect(prepareSpy.mock.calls[0]?.[0]).toBe(SQLITE_BUSY_TIMEOUT_PRAGMA);
      expect(prepareSpy.mock.calls[1]?.[0]).toMatch(/INSERT OR REPLACE INTO pending_poll_decisions/);
      expect(prepareSpy.mock.invocationCallOrder[0]!)
        .toBeLessThan(runSpy.mock.invocationCallOrder[0]!);
      expect(runSpy.mock.invocationCallOrder[0]!)
        .toBeLessThan(execSpy.mock.invocationCallOrder[0]!);
      expect(execSpy.mock.invocationCallOrder[0]!)
        .toBeLessThan(prepareSpy.mock.invocationCallOrder[1]!);
      expect(prepareSpy.mock.invocationCallOrder[1]!)
        .toBeLessThan(runSpy.mock.invocationCallOrder[1]!);

      const db = new DatabaseSync(queueDbPath, { readOnly: true });
      try {
        const row = db.prepare(`SELECT map_key, question_index, selected_options, via FROM pending_poll_decisions WHERE map_key = ?`)
          .get('agent:chat:1') as { map_key: string; question_index: number; selected_options: string; via: string } | undefined;
        expect(row).toBeDefined();
        expect(row!.question_index).toBe(0);
        expect(JSON.parse(row!.selected_options)).toEqual(['Deploy now']);
        expect(row!.via).toBe('console');
      } finally {
        db.close();
      }
    } finally {
      runSpy.mockRestore();
      execSpy.mockRestore();
      prepareSpy.mockRestore();
      cleanup(queueDbPath);
    }
  });

  it('survives malformed 409 body without crashing the fleet server', async () => {
    proxyMock.mockResolvedValue({ status: 409, body: 'not json!!!' });
    const deps = makeDeps(fakeInstance(), vi.fn());
    const res = mockRes();
    await handlePostApprovalDecision(
      mockReq({ method: 'POST', body: JSON.stringify({ mapKey: 'agent:chat:1', questionIndex: 0, selectedOptions: ['Deploy now'] }) }),
      res, deps, { name: 'agent-line' },
    );
    expect(res._status).toBe(409);
    expect(JSON.parse(res._body).error).toMatch(/unparseable/i);
  });

  it('survives malformed 4xx body without crashing the fleet server', async () => {
    proxyMock.mockResolvedValue({ status: 403, body: '<html>nginx error</html>' });
    const deps = makeDeps(fakeInstance(), vi.fn());
    const res = mockRes();
    await handlePostApprovalDecision(
      mockReq({ method: 'POST', body: JSON.stringify({ mapKey: 'agent:chat:1', questionIndex: 0, selectedOptions: ['Deploy now'] }) }),
      res, deps, { name: 'agent-line' },
    );
    expect(res._status).toBe(403);
    expect(JSON.parse(res._body).error).toMatch(/unparseable/i);
  });

  it('v1.1: falls back to the honest 502 when the instance is unreachable AND the durable queue write fails', async () => {
    proxyMock.mockResolvedValue({ status: 502, body: JSON.stringify({ error: 'proxy error: connect ECONNREFUSED' }) });
    const missingPath = join(tmpdir(), `no-such-dir-${randomBytes(6).toString('hex')}`, 'bot.db');
    const deps = makeDeps(fakeInstance({ dbPath: missingPath }), vi.fn());
    const res = mockRes();
    await handlePostApprovalDecision(
      mockReq({ method: 'POST', body: JSON.stringify({ mapKey: 'agent:chat:1', questionIndex: 0, selectedOptions: ['Deploy now'] }) }),
      res, deps, { name: 'agent-line' },
    );
    expect(res._status).toBe(502);
    expect(JSON.parse(res._body).error).toMatch(/offline|unreachable|not delivered/i);

    // The swallowed write-failure detail must now reach the logger (#2292-remainders
    // observability gap) — the client-facing 502 stays identical, but the actual
    // DB error is no longer discarded.
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    const [ctx, msg] = mockLogWarn.mock.calls[0]!;
    expect(msg).toMatch(/durable queue write failed/i);
    expect(ctx).toMatchObject({ instance: 'agent-line', mapKey: 'agent:chat:1' });
    expect(typeof (ctx as Record<string, unknown>).err).toBe('string');
    expect(((ctx as Record<string, unknown>).err as string).length).toBeGreaterThan(0);
  });
});
