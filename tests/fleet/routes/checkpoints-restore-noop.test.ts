/**
 * #2292 L10 — a restore that matched no checkpoint must not report success.
 *
 * The handler's own comment states the design: "the guarded UPDATE re-asserts
 * the preconditions decisively in SQL (the read above is advisory)". The SQL
 * WHERE is the authority — and its verdict was being discarded. `.run()`'s
 * result was dropped, so an UPDATE matching zero rows still produced
 * `202 restore_requested`.
 *
 * The window is real: the instance is STOPPED between the advisory read and
 * the write, so the row can change status (or be removed) in between. The
 * operator then sees a successful restore for a stop/start that changed
 * nothing.
 *
 * Setup mirrors checkpoints-restore.test.ts; the advisory read is stubbed to
 * disagree with the on-disk row, which is exactly the race.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { unlinkSync, existsSync } from 'node:fs';
import { handleRestoreCheckpoint } from '../../../src/fleet/routes/checkpoints.ts';
import type { RestoreCheckpointDeps } from '../../../src/fleet/routes/checkpoints.ts';
import type { DiscoveredInstance } from '../../../src/fleet/discovery.ts';
import { mockReq, mockRes } from '../../helpers/http-mocks.ts';

const MINIMAL_SCHEMA = `
  CREATE TABLE session_checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_key TEXT NOT NULL,
    session_id TEXT,
    session_status TEXT NOT NULL DEFAULT 'active',
    checkpoint_version INTEGER NOT NULL DEFAULT 1,
    workspace_path TEXT,
    claude_pid INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(conversation_key)
  );
`;

const KEY = 'conv-noop';

function tmpFile(): string {
  return join(tmpdir(), `fleet-cp-noop-${randomBytes(8).toString('hex')}.db`);
}
function cleanup(p: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const full = p + suffix;
    if (existsSync(full)) { try { unlinkSync(full); } catch { /* ignore */ } }
  }
}
function fakeInstance(dbPath: string): DiscoveredInstance {
  return {
    name: 'agent-line', type: 'agent', accessMode: 'self_only', healthPort: 3010,
    dbPath, stateRoot: '/state/agent-line', logDir: '/data/agent-line/logs',
    healthToken: null, configPath: '/config/agent-line/config.json', socketPath: null,
  } as DiscoveredInstance;
}

/** The advisory read reports a restorable checkpoint, whatever the DB holds. */
function readerSaysRestorable() {
  return {
    getCheckpoints: vi.fn(() => ({
      ok: true,
      data: [{ conversationKey: KEY, sessionId: 'sess-1', sessionStatus: 'ended', resumable: false, claudePid: null }],
    })),
  };
}

function makeDeps(inst: DiscoveredInstance, reader: ReturnType<typeof readerSaysRestorable>) {
  const serviceManager = {
    stop: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
  };
  const realtime = { publish: vi.fn() };
  const deps = {
    discovery: {
      getInstance: vi.fn(() => inst),
      getInstances: vi.fn(() => new Map([[inst.name, inst]])),
    } as any,
    dbReader: reader as any,
    serviceManager: serviceManager as any,
    realtime: realtime as any,
  } as RestoreCheckpointDeps;
  return { deps, serviceManager, realtime };
}

function post() {
  return mockReq({ method: 'POST', body: JSON.stringify({ conversationKey: KEY }) });
}

describe('checkpoint restore — no-op detection (#2292 L10)', () => {
  let dbPath: string;

  beforeEach(() => { dbPath = tmpFile(); });
  afterEach(() => { cleanup(dbPath); });

  function seed(status: string, sessionId: string | null): void {
    const db = new DatabaseSync(dbPath);
    db.exec(MINIMAL_SCHEMA);
    db.prepare(
      `INSERT INTO session_checkpoints (conversation_key, session_id, session_status, workspace_path)
       VALUES (?, ?, ?, ?)`,
    ).run(KEY, sessionId, status, '/workspaces/x');
    db.close();
  }

  it('does NOT report restore_requested when the guarded UPDATE matched no row', async () => {
    // The row went 'active' during the stop window, so the WHERE excludes it.
    seed('active', 'sess-1');
    const { deps } = makeDeps(fakeInstance(dbPath), readerSaysRestorable());
    const res = mockRes();

    await handleRestoreCheckpoint(post(), res, deps, { name: 'agent-line' });

    expect(res._status).toBe(409);
    const body = JSON.parse(res._body);
    expect(body.status).not.toBe('restore_requested');
    expect(String(body.error)).toMatch(/matched no checkpoint/i);
  });

  it('still restarts the instance after a no-op — never leaves it stopped', async () => {
    seed('active', 'sess-1');
    const { deps, serviceManager } = makeDeps(fakeInstance(dbPath), readerSaysRestorable());
    const res = mockRes();

    await handleRestoreCheckpoint(post(), res, deps, { name: 'agent-line' });

    // The handler stops the instance before writing; a no-op must not skip the
    // restart, or a failed restore would leave the line down.
    expect(serviceManager.stop).toHaveBeenCalledTimes(1);
    expect(serviceManager.start).toHaveBeenCalledTimes(1);
    expect(JSON.parse(res._body).instanceRestarted).toBe(true);
  });

  it('reports the no-op even when the row vanished entirely during the window', async () => {
    // Schema exists, row does not — the UPDATE matches nothing.
    const db = new DatabaseSync(dbPath);
    db.exec(MINIMAL_SCHEMA);
    db.close();
    const { deps } = makeDeps(fakeInstance(dbPath), readerSaysRestorable());
    const res = mockRes();

    await handleRestoreCheckpoint(post(), res, deps, { name: 'agent-line' });

    expect(res._status).toBe(409);
  });

  // The discriminating case. Returning 409 unconditionally would pass every
  // test above while destroying the real restore path.
  it('still returns 202 and publishes when the UPDATE DID change a row', async () => {
    seed('ended', 'sess-1');   // matches the guarded WHERE
    const { deps, realtime } = makeDeps(fakeInstance(dbPath), readerSaysRestorable());
    const res = mockRes();

    await handleRestoreCheckpoint(post(), res, deps, { name: 'agent-line' });

    expect(res._status).toBe(202);
    expect(JSON.parse(res._body).status).toBe('restore_requested');
    // The no-op path must not publish; the success path must.
    expect(realtime.publish).toHaveBeenCalled();
  });

  it('does not publish realtime events for a no-op restore', async () => {
    seed('active', 'sess-1');
    const { deps, realtime } = makeDeps(fakeInstance(dbPath), readerSaysRestorable());
    const res = mockRes();

    await handleRestoreCheckpoint(post(), res, deps, { name: 'agent-line' });

    expect(res._status).toBe(409);
    expect(realtime.publish).not.toHaveBeenCalled();
  });
});
