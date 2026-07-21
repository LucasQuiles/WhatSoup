/**
 * Tests for the live-session inspector (terminal Stage A, part 1):
 *  - parsePsTable (pure parser for the scoped ps probe)
 *  - GET /api/lines/:name/live-sessions (ps rows JOINED against
 *    session_checkpoints via claudePid — the #1861/#1870 "which generation
 *    is actually alive vs which row claims" surface)
 *
 * MAP: docs/proposals/2026-07-20-terminal-leg-map.md (stage A — zero input
 * path, read tier only). The probe is injectable (deps.probeProcesses) so
 * the route's join semantics are tested without shelling out.
 */
import { describe, it, expect, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { unlinkSync, existsSync } from 'node:fs';
import { parsePsTable, handleGetLiveSessions, type LiveSessionsDeps } from '../../../src/fleet/routes/live-sessions.ts';
import { FleetDbReader } from '../../../src/fleet/db-reader.ts';
import type { DiscoveredInstance } from '../../../src/fleet/discovery.ts';
import { mockReq, mockRes } from '../../helpers/http-mocks.ts';

// ─── parsePsTable ───────────────────────────────────────────────────────────

describe('parsePsTable (scoped ps probe parser)', () => {
  it('parses pid/ppid/stat/etimes/args rows', () => {
    const out = parsePsTable(
      '  101   1 Ss    3600 claude --resume sess-1\n' +
      '  202 101 S+      45 claude --print\n' +
      '  303   1 Z        0 [claude] <defunct>\n',
    );
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ pid: 101, ppid: 1, state: 'Ss', etimeSeconds: 3600 });
    expect(out[1]).toMatchObject({ pid: 202, ppid: 101, state: 'S+', etimeSeconds: 45 });
    expect(out[2]!.state).toBe('Z');
  });

  it('returns an empty array on empty/garbage input (never throws)', () => {
    expect(parsePsTable('')).toEqual([]);
    expect(parsePsTable('not a ps table')).toEqual([]);
  });
});

// ─── route ──────────────────────────────────────────────────────────────────

const MINIMAL_SCHEMA = `
  CREATE TABLE session_checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_key TEXT NOT NULL,
    session_id TEXT,
    transcript_path TEXT,
    active_turn_id TEXT,
    last_inbound_seq INTEGER,
    last_flushed_outbound_id INTEGER,
    watchdog_state TEXT,
    workspace_path TEXT,
    claude_pid INTEGER,
    checkpoint_version INTEGER NOT NULL DEFAULT 1,
    session_status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_scope TEXT,
    completed_delivery_jid TEXT,
    completed_logical_turn_id TEXT,
    UNIQUE(conversation_key)
  );
`;

function tmpFile(): string {
  return join(tmpdir(), `fleet-live-${randomBytes(8).toString('hex')}.db`);
}

function cleanup(...paths: string[]): void {
  for (const p of paths) {
    for (const suffix of ['', '-wal', '-shm']) {
      const full = p + suffix;
      if (existsSync(full)) { try { unlinkSync(full); } catch { /* ignore */ } }
    }
  }
}

function insertCheckpoint(db: DatabaseSync, key: string, status: string, pid: number | null): void {
  db.prepare(`
    INSERT INTO session_checkpoints (conversation_key, session_id, session_status, checkpoint_version, claude_pid, workspace_path)
    VALUES (?, ?, ?, 1, ?, ?)
  `).run(key, `sess-${key}`, status, pid, `/workspaces/${key}`);
}

function fakeInstance(dbPath: string): DiscoveredInstance {
  return {
    name: 'agent-line',
    type: 'agent',
    accessMode: 'self_only',
    healthPort: 3010,
    dbPath,
    stateRoot: '/state/agent-line',
    logDir: '/data/agent-line/logs',
    healthToken: null,
    configPath: '/config/agent-line/config.json',
    socketPath: null,
  } as DiscoveredInstance;
}

function makeDeps(
  inst: DiscoveredInstance | undefined,
  dbReader: FleetDbReader,
  probeProcesses: LiveSessionsDeps['probeProcesses'],
): LiveSessionsDeps {
  return {
    discovery: {
      getInstance: vi.fn(() => inst),
      getInstances: vi.fn(() => (inst ? new Map([[inst.name, inst]]) : new Map())),
    } as any,
    dbReader,
    probeProcesses,
  };
}

describe('GET /api/lines/:name/live-sessions', () => {
  it('404s for an unknown line', async () => {
    const deps = makeDeps(undefined, new FleetDbReader('x', new DatabaseSync(':memory:')), () => []);
    const res = mockRes();
    await handleGetLiveSessions(mockReq(), res, deps, { name: 'ghost' });
    expect(res._status).toBe(404);
  });

  it('joins live pids onto checkpoint rows and flags both anomaly classes', async () => {
    const dbPath = tmpFile();
    const setup = new DatabaseSync(dbPath);
    setup.exec(MINIMAL_SCHEMA);
    insertCheckpoint(setup, 'alive-ok@s.whatsapp.net', 'active', 101);      // resumable + live pid → fine
    insertCheckpoint(setup, 'claims-live-but-dead@s.whatsapp.net', 'active', 999); // resumable + dead pid → anomaly
    insertCheckpoint(setup, 'ended-but-running@s.whatsapp.net', 'ended', 202);    // ended + LIVE pid → #1861 retention anomaly
    insertCheckpoint(setup, 'ended-clean@s.whatsapp.net', 'ended', 303);          // ended + dead pid → fine
    insertCheckpoint(setup, 'no-pid@s.whatsapp.net', 'active', null);              // no pid → unknown
    setup.close();

    const probe = () => [
      { pid: 101, ppid: 1, state: 'Ss', etimeSeconds: 7200, args: 'claude --resume sess-alive-ok' },
      { pid: 202, ppid: 1, state: 'S+', etimeSeconds: 900, args: 'claude --resume sess-ended-but-running' },
    ];
    const deps = makeDeps(
      fakeInstance(dbPath),
      new FleetDbReader('other', new DatabaseSync(':memory:')),
      probe,
    );
    const res = mockRes();
    await handleGetLiveSessions(mockReq(), res, deps, { name: 'agent-line' });
    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.observedAt).toMatch(/^\d{4}-/);

    const byKey = new Map(body.sessions.map((s: { conversationKey: string }) => [s.conversationKey, s]));
    expect(byKey.get('alive-ok@s.whatsapp.net')).toMatchObject({ pidAlive: true, pidState: 'Ss', pidEtimeSeconds: 7200, anomaly: null });
    expect(byKey.get('claims-live-but-dead@s.whatsapp.net')).toMatchObject({ pidAlive: false, anomaly: 'resumable-but-pid-dead' });
    expect(byKey.get('ended-but-running@s.whatsapp.net')).toMatchObject({ pidAlive: true, anomaly: 'pid-alive-after-end' });
    expect(byKey.get('ended-clean@s.whatsapp.net')).toMatchObject({ pidAlive: false, anomaly: null });
    expect(byKey.get('no-pid@s.whatsapp.net')).toMatchObject({ pidAlive: null, anomaly: null });
    expect(body.anomalyCount).toBe(2);
    cleanup(dbPath);
  });

  it('fails closed when the probe throws — readError, never fabricated liveness', async () => {
    const dbPath = tmpFile();
    const setup = new DatabaseSync(dbPath);
    setup.exec(MINIMAL_SCHEMA);
    setup.close();
    const deps = makeDeps(
      fakeInstance(dbPath),
      new FleetDbReader('other', new DatabaseSync(':memory:')),
      () => { throw new Error('ps failed'); },
    );
    const res = mockRes();
    await handleGetLiveSessions(mockReq(), res, deps, { name: 'agent-line' });
    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.probeError).toBe(true);
    expect(body.sessions).toBeUndefined();
    cleanup(dbPath);
  });
});
