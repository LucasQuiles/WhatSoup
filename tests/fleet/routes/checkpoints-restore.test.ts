/**
 * Tests for the checkpoint-restore path (D-1, restart-mediated):
 *  POST /api/lines/:name/checkpoints/restore (handleRestoreCheckpoint)
 *
 * Spec: oc-re/specs/2026-07-19-checkpoint-restore-spec.md
 * Safety ordering (handoff §6 — the runtime owns resume semantics):
 * validate → stop → guarded write (while DOWN) → start → publish.
 * The fleet NEVER writes checkpoint state behind a running instance's
 * back and NEVER resumes a session itself; the boot-time resume gate
 * (src/core/durability.ts:501-506) does the resume.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { unlinkSync, existsSync } from 'node:fs';
import { FleetDbReader } from '../../../src/fleet/db-reader.ts';
import { handleRestoreCheckpoint } from '../../../src/fleet/routes/checkpoints.ts';
import type { RestoreCheckpointDeps } from '../../../src/fleet/routes/checkpoints.ts';
import type { DiscoveredInstance } from '../../../src/fleet/discovery.ts';
import { mockReq, mockRes } from '../../helpers/http-mocks.ts';

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
  return join(tmpdir(), `fleet-cp-restore-${randomBytes(8).toString('hex')}.db`);
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
): void {
  db.prepare(`
    INSERT INTO session_checkpoints (
      conversation_key, session_id, session_status, checkpoint_version,
      workspace_path, claude_pid, completed_scope,
      completed_delivery_jid, completed_logical_turn_id
    ) VALUES (?, ?, ?, 1, ?, 4321, 'per_chat', '15550000001@s.whatsapp.net', ?)
  `).run(key, sessionId, status, `/workspaces/${key}`, `lt-${key}`);
}

function readStatus(dbPath: string, key: string): string | undefined {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare(
      `SELECT session_status FROM session_checkpoints WHERE conversation_key = ?`,
    ).get(key) as { session_status: string } | undefined;
    return row?.session_status;
  } finally {
    db.close();
  }
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
  dbReader: FleetDbReader | { getCheckpoints: ReturnType<typeof vi.fn> },
): RestoreCheckpointDeps & {
  serviceManager: { stop: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn> };
  realtime: { publish: ReturnType<typeof vi.fn> };
} {
  return {
    discovery: {
      getInstance: vi.fn(() => inst),
      getInstances: vi.fn(() => (inst ? new Map([[inst.name, inst]]) : new Map())),
    } as any,
    dbReader: dbReader as any,
    serviceManager: {
      stop: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
    } as any,
    realtime: { publish: vi.fn() } as any,
  };
}

describe('POST /api/lines/:name/checkpoints/restore (handleRestoreCheckpoint)', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpFile();
    const setup = new DatabaseSync(dbPath);
    setup.exec(MINIMAL_SCHEMA);
    setup.close();
  });

  afterEach(() => { cleanup(dbPath); });

  for (const name of ['a', 'agent-2', 'a'.repeat(30)]) {
    it(`accepts valid instance name="${name}"`, async () => {
      const deps = makeDeps(undefined, { getCheckpoints: vi.fn() });
      const res = mockRes();
      await handleRestoreCheckpoint(
        mockReq({ method: 'POST', body: JSON.stringify({ conversationKey: 'conv-1' }) }),
        res, deps, { name },
      );
      expect(res._status).toBe(404);
      expect(JSON.parse(res._body)).toEqual({ error: `instance '${name}' not found` });
    });
  }

  for (const name of ['UPPER', '1starts-with-digit', 'a'.repeat(31)]) {
    it(`returns the shared 400 contract for invalid instance name="${name}"`, async () => {
      const getCheckpoints = vi.fn();
      const deps = makeDeps(fakeInstance(dbPath), { getCheckpoints });
      const res = mockRes();
      await handleRestoreCheckpoint(
        mockReq({ method: 'POST', body: JSON.stringify({ conversationKey: 'conv-1' }) }),
        res, deps, { name },
      );
      expect(res._status).toBe(400);
      expect(JSON.parse(res._body)).toEqual({ error: 'invalid instance name' });
      expect(getCheckpoints).not.toHaveBeenCalled();
      expect(deps.serviceManager.stop).not.toHaveBeenCalled();
    });
  }

  it('404s for an unknown line', async () => {
    const deps = makeDeps(undefined, { getCheckpoints: vi.fn() });
    const res = mockRes();
    await handleRestoreCheckpoint(
      mockReq({ method: 'POST', body: JSON.stringify({ conversationKey: 'conv-1' }) }),
      res, deps, { name: 'ghost' },
    );
    expect(res._status).toBe(404);
  });

  it('400s on a malformed body', async () => {
    const deps = makeDeps(fakeInstance(dbPath), { getCheckpoints: vi.fn() });
    const res = mockRes();
    await handleRestoreCheckpoint(
      mockReq({ method: 'POST', body: 'not json' }), res, deps, { name: 'agent-line' },
    );
    expect(res._status).toBe(400);
  });

  it('404s when the checkpoint row does not exist', async () => {
    const reader = new FleetDbReader('other-instance', new DatabaseSync(':memory:'));
    const deps = makeDeps(fakeInstance(dbPath), reader);
    const res = mockRes();
    await handleRestoreCheckpoint(
      mockReq({ method: 'POST', body: JSON.stringify({ conversationKey: 'ghost-conv' }) }),
      res, deps, { name: 'agent-line' },
    );
    expect(res._status).toBe(404);
    expect(deps.serviceManager.stop).not.toHaveBeenCalled();
  });

  it('short-circuits idempotently when the checkpoint is already resumable — no stop, no write', async () => {
    const db = new DatabaseSync(dbPath);
    insertCheckpoint(db, 'conv-live', 'suspended', 'sess-live');
    db.close();
    const reader = new FleetDbReader('other-instance', new DatabaseSync(':memory:'));
    const deps = makeDeps(fakeInstance(dbPath), reader);
    const res = mockRes();
    await handleRestoreCheckpoint(
      mockReq({ method: 'POST', body: JSON.stringify({ conversationKey: 'conv-live' }) }),
      res, deps, { name: 'agent-line' },
    );
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body).status).toBe('already_resumable');
    expect(deps.serviceManager.stop).not.toHaveBeenCalled();
    expect(deps.serviceManager.start).not.toHaveBeenCalled();
    expect(readStatus(dbPath, 'conv-live')).toBe('suspended');
  });

  it('409s when the checkpoint has no session id — the resume gate needs one and we never invent it', async () => {
    const db = new DatabaseSync(dbPath);
    insertCheckpoint(db, 'conv-noid', 'ended', null);
    db.close();
    const reader = new FleetDbReader('other-instance', new DatabaseSync(':memory:'));
    const deps = makeDeps(fakeInstance(dbPath), reader);
    const res = mockRes();
    await handleRestoreCheckpoint(
      mockReq({ method: 'POST', body: JSON.stringify({ conversationKey: 'conv-noid' }) }),
      res, deps, { name: 'agent-line' },
    );
    expect(res._status).toBe(409);
    expect(deps.serviceManager.stop).not.toHaveBeenCalled();
    expect(readStatus(dbPath, 'conv-noid')).toBe('ended');
  });

  it('happy path: stop → write-while-down → start, row flips ended→suspended, 202 + publish', async () => {
    const db = new DatabaseSync(dbPath);
    insertCheckpoint(db, 'conv-ended', 'ended', 'sess-e');
    db.close();
    const reader = new FleetDbReader('other-instance', new DatabaseSync(':memory:'));
    const deps = makeDeps(fakeInstance(dbPath), reader);
    const res = mockRes();
    await handleRestoreCheckpoint(
      mockReq({ method: 'POST', body: JSON.stringify({ conversationKey: 'conv-ended' }) }),
      res, deps, { name: 'agent-line' },
    );
    expect(res._status).toBe(202);
    const body = JSON.parse(res._body);
    expect(body.status).toBe('restore_requested');
    expect(body.instance).toBe('agent-line');
    expect(body.conversationKey).toBe('conv-ended');
    // Write happened while DOWN: stop strictly before start, both awaited
    expect(deps.serviceManager.stop).toHaveBeenCalledWith('agent-line');
    expect(deps.serviceManager.start).toHaveBeenCalledWith('agent-line');
    expect(deps.serviceManager.stop.mock.invocationCallOrder[0])
      .toBeLessThan(deps.serviceManager.start.mock.invocationCallOrder[0]!);
    // The decisive outcome: the row is now inside the resume-gate filter
    expect(readStatus(dbPath, 'conv-ended')).toBe('suspended');
    expect(deps.realtime.publish).toHaveBeenCalled();
  });

  it('stop failure → 500, zero mutation, start never attempted', async () => {
    const db = new DatabaseSync(dbPath);
    insertCheckpoint(db, 'conv-ended', 'ended', 'sess-e');
    db.close();
    const reader = new FleetDbReader('other-instance', new DatabaseSync(':memory:'));
    const deps = makeDeps(fakeInstance(dbPath), reader);
    deps.serviceManager.stop.mockRejectedValue(new Error('unit not found'));
    const res = mockRes();
    await handleRestoreCheckpoint(
      mockReq({ method: 'POST', body: JSON.stringify({ conversationKey: 'conv-ended' }) }),
      res, deps, { name: 'agent-line' },
    );
    expect(res._status).toBe(500);
    expect(deps.serviceManager.start).not.toHaveBeenCalled();
    expect(readStatus(dbPath, 'conv-ended')).toBe('ended');
  });

  it('write failure after stop → start still attempted, 500 with restartAttempted', async () => {
    // Read succeeds (mocked reader returns the row) but the write open
    // fails: dbPath lives in a nonexistent directory.
    const missingPath = join(tmpdir(), `no-such-dir-${randomBytes(6).toString('hex')}`, 'bot.db');
    const row = {
      conversationKey: 'conv-x', sessionId: 'sess-x', sessionStatus: 'ended',
      checkpointVersion: 1, claudePid: 1, workspacePath: null,
      createdAt: '2026-07-19T00:00:00Z', updatedAt: '2026-07-19T00:00:00Z',
      completedScope: null, completedDeliveryJid: null, completedLogicalTurnId: null,
      resumable: false,
    };
    const deps = makeDeps(fakeInstance(missingPath), {
      getCheckpoints: vi.fn(() => ({ ok: true as const, data: [row] })),
    });
    const res = mockRes();
    await handleRestoreCheckpoint(
      mockReq({ method: 'POST', body: JSON.stringify({ conversationKey: 'conv-x' }) }),
      res, deps, { name: 'agent-line' },
    );
    expect(res._status).toBe(500);
    expect(JSON.parse(res._body).restartAttempted).toBe(true);
    expect(deps.serviceManager.start).toHaveBeenCalledWith('agent-line');
  });
});
