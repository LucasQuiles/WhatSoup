/**
 * Tests for the checkpoint browser read path:
 *  - FleetDbReader.getCheckpoints (real node:sqlite, minimal schema)
 *  - GET /api/lines/:name/checkpoints (handleGetLineCheckpoints, fake deps)
 *
 * Spec: oc-re/specs/2026-07-19-checkpoint-browser-ui-spec.md
 * The `resumable` flag MUST use the durability engine's exact filter
 * (src/core/durability.ts:501-506): session_status IN ('active','suspended')
 * AND session_id IS NOT NULL.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { unlinkSync, existsSync } from 'node:fs';
import { FleetDbReader } from '../../../src/fleet/db-reader.ts';
import { handleGetLineCheckpoints } from '../../../src/fleet/routes/checkpoints.ts';
import type { CheckpointsDeps } from '../../../src/fleet/routes/checkpoints.ts';
import type { DiscoveredInstance } from '../../../src/fleet/discovery.ts';
import { mockReq, mockRes } from '../../helpers/http-mocks.ts';

// ─── FleetDbReader.getCheckpoints (real sqlite) ─────────────────────────────

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
  return join(tmpdir(), `fleet-dbr-cp-${randomBytes(8).toString('hex')}.db`);
}

function cleanup(...paths: string[]): void {
  for (const p of paths) {
    for (const suffix of ['', '-wal', '-shm']) {
      const full = p + suffix;
      if (existsSync(full)) { try { unlinkSync(full); } catch { /* ignore */ } }
    }
  }
}

function insertCheckpoint(
  db: DatabaseSync,
  key: string,
  status: string,
  sessionId: string | null,
  updatedAt: string,
  version = 1,
): void {
  db.prepare(`
    INSERT INTO session_checkpoints (
      conversation_key, session_id, session_status, checkpoint_version,
      workspace_path, claude_pid, created_at, updated_at,
      completed_scope, completed_delivery_jid, completed_logical_turn_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    key, sessionId, status, version,
    `/workspaces/${key}`, 4321, '2026-07-18 00:00:00', updatedAt,
    'per_chat', '15550000001@s.whatsapp.net', `lt-${key}`,
  );
}

describe('FleetDbReader.getCheckpoints', () => {
  let dbPath: string;
  let reader: FleetDbReader;

  beforeEach(() => {
    dbPath = tmpFile();
    const setup = new DatabaseSync(dbPath);
    setup.exec(MINIMAL_SCHEMA);
    setup.close();
    // selfName mismatch => reader opens a readonly connection to dbPath
    reader = new FleetDbReader('other-instance', new DatabaseSync(':memory:'));
  });

  afterEach(() => { cleanup(dbPath); });

  it('returns checkpoints ordered by updated_at DESC with the engine resumable filter', () => {
    const db = new DatabaseSync(dbPath);
    insertCheckpoint(db, 'conv-active', 'active', 'sess-a', '2026-07-19 01:00:00');
    insertCheckpoint(db, 'conv-suspended', 'suspended', 'sess-b', '2026-07-19 03:00:00');
    insertCheckpoint(db, 'conv-ended', 'ended', 'sess-c', '2026-07-19 02:00:00');
    insertCheckpoint(db, 'conv-orphaned', 'orphaned', 'sess-d', '2026-07-19 00:00:00');
    insertCheckpoint(db, 'conv-active-noid', 'active', null, '2026-07-19 04:00:00');
    db.close();

    const result = reader.getCheckpoints('agent-line', dbPath);
    expect(result.ok).toBe(true);
    const rows = result.ok ? result.data : [];
    expect(rows.map((r) => r.conversationKey)).toEqual([
      'conv-active-noid', 'conv-suspended', 'conv-ended', 'conv-active', 'conv-orphaned',
    ]);
    const byKey = Object.fromEntries(rows.map((r) => [r.conversationKey, r.resumable]));
    expect(byKey).toEqual({
      'conv-active-noid': false,   // active but session_id NULL => not resumable
      'conv-suspended': true,
      'conv-ended': false,
      'conv-active': true,
      'conv-orphaned': false,
    });
  });

  it('maps identity fields through', () => {
    const db = new DatabaseSync(dbPath);
    insertCheckpoint(db, 'conv-1', 'suspended', 'sess-xyz', '2026-07-19 01:00:00', 7);
    db.close();
    const result = reader.getCheckpoints('agent-line', dbPath);
    expect(result.ok).toBe(true);
    const row = result.ok ? result.data[0] : undefined;
    expect(row).toMatchObject({
      conversationKey: 'conv-1',
      sessionId: 'sess-xyz',
      sessionStatus: 'suspended',
      checkpointVersion: 7,
      claudePid: 4321,
      workspacePath: '/workspaces/conv-1',
      completedScope: 'per_chat',
      completedDeliveryJid: '15550000001@s.whatsapp.net',
      completedLogicalTurnId: 'lt-conv-1',
      resumable: true,
    });
  });

  it('caps the result set at 500 rows', () => {
    const db = new DatabaseSync(dbPath);
    for (let i = 0; i < 505; i += 1) {
      insertCheckpoint(db, `conv-${String(i).padStart(3, '0')}`, 'ended', null,
        `2026-07-19 00:${String(i % 60).padStart(2, '0')}:00`);
    }
    db.close();
    const result = reader.getCheckpoints('agent-line', dbPath);
    expect(result.ok).toBe(true);
    expect(result.ok ? result.data.length : -1).toBe(500);
  });
});

// ─── GET /api/lines/:name/checkpoints ───────────────────────────────────────

function fakeInstance(overrides: Partial<DiscoveredInstance> = {}): DiscoveredInstance {
  return {
    name: 'agent-line',
    type: 'agent',
    accessMode: 'self_only',
    healthPort: 3010,
    dbPath: '/data/agent-line/bot.db',
    stateRoot: '/state/agent-line',
    logDir: '/data/agent-line/logs',
    healthToken: null,
    configPath: '/config/agent-line/config.json',
    socketPath: null,
    ...overrides,
  };
}

function makeDeps(
  inst: DiscoveredInstance | undefined,
  getCheckpoints: ReturnType<typeof vi.fn>,
): CheckpointsDeps {
  return {
    discovery: {
      getInstance: vi.fn(() => inst),
      getInstances: vi.fn(() => (inst ? new Map([[inst.name, inst]]) : new Map())),
    } as any,
    dbReader: { getCheckpoints } as any,
  } as CheckpointsDeps;
}

const SAMPLE_ROW = {
  conversationKey: 'conv-1',
  sessionId: 'sess-xyz',
  sessionStatus: 'suspended',
  checkpointVersion: 7,
  claudePid: 4321,
  workspacePath: '/workspaces/conv-1',
  createdAt: '2026-07-18 00:00:00',
  updatedAt: '2026-07-19 01:00:00',
  completedScope: 'per_chat',
  completedDeliveryJid: '15550000001@s.whatsapp.net',
  completedLogicalTurnId: 'lt-conv-1',
  resumable: true,
};

describe('GET /api/lines/:name/checkpoints (handleGetLineCheckpoints)', () => {
  it('404s for an unknown line', async () => {
    const deps = makeDeps(undefined, vi.fn());
    const res = mockRes();
    await handleGetLineCheckpoints(mockReq(), res, deps, { name: 'ghost' });
    expect(res._status).toBe(404);
  });

  it('200s with observedAt and the reader payload', async () => {
    const getCheckpoints = vi.fn(() => ({ ok: true as const, data: [SAMPLE_ROW] }));
    const deps = makeDeps(fakeInstance(), getCheckpoints);
    const res = mockRes();
    await handleGetLineCheckpoints(mockReq(), res, deps, { name: 'agent-line' });
    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.checkpoints).toEqual([SAMPLE_ROW]);
    expect(body.readError).toBeUndefined();
    expect(getCheckpoints).toHaveBeenCalledWith('agent-line', '/data/agent-line/bot.db');
  });

  it('fails closed on read error: 200 with empty list + readError marker, never a fake empty state', async () => {
    const getCheckpoints = vi.fn(() => ({ ok: false as const, error: 'SQLITE_BUSY' }));
    const deps = makeDeps(fakeInstance(), getCheckpoints);
    const res = mockRes();
    await handleGetLineCheckpoints(mockReq(), res, deps, { name: 'agent-line' });
    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.checkpoints).toEqual([]);
    expect(body.readError).toBe(true);
  });
});
