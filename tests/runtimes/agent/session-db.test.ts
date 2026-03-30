import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Database } from '../../../src/core/database.ts';
import {
  ensureAgentSchema,
  createSession,
  getActiveSession,
  updateSessionId,
  updateLastMessage,
  updateSessionStatus,
  incrementMessageCount,
  backfillWorkspaceKeys,
  markOrphaned,
  sweepOrphanedSessions,
  getResumableSessionForChat,
} from '../../../src/runtimes/agent/session-db.ts';

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function tempDbPath(): string {
  return join(tmpdir(), `whatsapp-bot-agent-test-${randomBytes(4).toString('hex')}.db`);
}

const dbPath = tempDbPath();
const db = new Database(dbPath);
db.open();
ensureAgentSchema(db);

afterAll(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const fp = dbPath + suffix;
    if (existsSync(fp)) unlinkSync(fp);
  }
});

describe('agent session-db', () => {
  beforeEach(() => {
    db.raw.prepare('DELETE FROM agent_sessions').run();
  });

  it('ensureAgentSchema creates agent_sessions table', () => {
    const row = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_sessions'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('agent_sessions');
  });

  // @check CHK-022
  // @traces REQ-005.AC-03
  it('createSession inserts a row with status=active and returns id > 0', () => {
    const id = createSession(db, 12345, '/home/q/project');
    expect(id).toBeGreaterThan(0);

    const row = db.raw
      .prepare('SELECT * FROM agent_sessions WHERE id = ?')
      .get(id) as {
        id: number;
        session_id: string | null;
        claude_pid: number;
        started_in_directory: string;
        status: string;
        started_at: string;
      } | undefined;

    expect(row).toBeDefined();
    expect(row?.status).toBe('active');
    expect(row?.claude_pid).toBe(12345);
    expect(row?.started_in_directory).toBe('/home/q/project');
    expect(row?.session_id).toBeNull();
    expect(row?.started_at).toBeTruthy();
  });

  it('getActiveSession returns the active session with new fields', () => {
    const id = createSession(db, 99999, '/tmp/test');
    // getActiveSession requires a session_id (only resumable sessions qualify)
    updateSessionId(db, id, 'ses-abc123');
    const session = getActiveSession(db);
    expect(session).not.toBeNull();
    expect(session?.id).toBe(id);
    expect(session?.claude_pid).toBe(99999);
    expect(session?.status).toBe('active');
    expect(session?.session_id).toBe('ses-abc123');
    expect(session?.chat_jid).toBeNull();
    expect(session?.started_at).toBeTruthy();
    expect(session?.last_message_at).toBeNull();
    expect(session?.message_count).toBe(0);
  });

  it('getActiveSession returns null when no active session exists', () => {
    const session = getActiveSession(db);
    expect(session).toBeNull();
  });

  // @check CHK-022
  // @traces REQ-005.AC-03
  it('updateSessionStatus changes status to crashed', () => {
    const id = createSession(db, 11111, '/tmp/crash');
    updateSessionStatus(db, id, 'crashed');

    const row = db.raw
      .prepare('SELECT status FROM agent_sessions WHERE id = ?')
      .get(id) as { status: string } | undefined;
    expect(row?.status).toBe('crashed');
  });

  it('updateSessionStatus changes status to ended', () => {
    const id = createSession(db, 22222, '/tmp/end');
    updateSessionStatus(db, id, 'ended');

    const row = db.raw
      .prepare('SELECT status FROM agent_sessions WHERE id = ?')
      .get(id) as { status: string } | undefined;
    expect(row?.status).toBe('ended');
  });

  it('updateSessionId sets session_id field', () => {
    const id = createSession(db, 33333, '/tmp/sid');
    updateSessionId(db, id, 'ses_abc123');

    const row = db.raw
      .prepare('SELECT session_id FROM agent_sessions WHERE id = ?')
      .get(id) as { session_id: string } | undefined;
    expect(row?.session_id).toBe('ses_abc123');
  });

  it('updateLastMessage sets last_message_at', () => {
    const id = createSession(db, 44444, '/tmp/lm');

    const before = db.raw
      .prepare('SELECT last_message_at FROM agent_sessions WHERE id = ?')
      .get(id) as { last_message_at: string | null } | undefined;
    expect(before?.last_message_at).toBeNull();

    updateLastMessage(db, id);

    const after = db.raw
      .prepare('SELECT last_message_at FROM agent_sessions WHERE id = ?')
      .get(id) as { last_message_at: string | null } | undefined;
    expect(after?.last_message_at).toBeTruthy();
  });

  it('getActiveSession returns null after session is crashed', () => {
    const id = createSession(db, 55555, '/tmp/postcr');
    updateSessionStatus(db, id, 'crashed');
    expect(getActiveSession(db)).toBeNull();
  });

  it('getActiveSession returns null after session is ended', () => {
    const id = createSession(db, 66666, '/tmp/postend');
    updateSessionStatus(db, id, 'ended');
    expect(getActiveSession(db)).toBeNull();
  });

  it('ensureAgentSchema called twice does not throw', () => {
    expect(() => ensureAgentSchema(db)).not.toThrow();
  });

  it('createSession with chatJid stores chat_jid in the row', () => {
    const id = createSession(db, 77777, '/tmp/jid', '1234567890@s.whatsapp.net');
    const row = db.raw
      .prepare('SELECT chat_jid FROM agent_sessions WHERE id = ?')
      .get(id) as { chat_jid: string | null } | undefined;
    expect(row?.chat_jid).toBe('1234567890@s.whatsapp.net');
  });

  it('createSession without chatJid stores null for chat_jid', () => {
    const id = createSession(db, 88888, '/tmp/nojid');
    const row = db.raw
      .prepare('SELECT chat_jid FROM agent_sessions WHERE id = ?')
      .get(id) as { chat_jid: string | null } | undefined;
    expect(row?.chat_jid).toBeNull();
  });

  it('incrementMessageCount increments message_count and sets last_message_at', () => {
    const id = createSession(db, 99998, '/tmp/mc');

    const before = db.raw
      .prepare('SELECT message_count, last_message_at FROM agent_sessions WHERE id = ?')
      .get(id) as { message_count: number; last_message_at: string | null } | undefined;
    expect(before?.message_count).toBe(0);
    expect(before?.last_message_at).toBeNull();

    incrementMessageCount(db, id);

    const after = db.raw
      .prepare('SELECT message_count, last_message_at FROM agent_sessions WHERE id = ?')
      .get(id) as { message_count: number; last_message_at: string | null } | undefined;
    expect(after?.message_count).toBe(1);
    expect(after?.last_message_at).toBeTruthy();

    incrementMessageCount(db, id);
    const after2 = db.raw
      .prepare('SELECT message_count FROM agent_sessions WHERE id = ?')
      .get(id) as { message_count: number } | undefined;
    expect(after2?.message_count).toBe(2);
  });

  it('createSession stores workspace_key when provided', () => {
    const id = createSession(db, 10001, '/tmp/wk', '1234567890@s.whatsapp.net', '1234567890');
    const row = db.raw
      .prepare('SELECT workspace_key FROM agent_sessions WHERE id = ?')
      .get(id) as { workspace_key: string | null } | undefined;
    expect(row?.workspace_key).toBe('1234567890');
  });

  it('createSession stores null workspace_key when not provided', () => {
    const id = createSession(db, 10002, '/tmp/wk-null');
    const row = db.raw
      .prepare('SELECT workspace_key FROM agent_sessions WHERE id = ?')
      .get(id) as { workspace_key: string | null } | undefined;
    expect(row?.workspace_key).toBeNull();
  });

  it('backfillWorkspaceKeys: root-cwd row is marked ended', () => {
    const instanceCwd = '/home/q/LAB/whatsapp-bot';
    // Row started in instance root — pre-isolation shared session
    const id = createSession(db, 20001, instanceCwd, '9990000001@s.whatsapp.net');
    backfillWorkspaceKeys(db, instanceCwd);

    const row = db.raw
      .prepare('SELECT status, workspace_key FROM agent_sessions WHERE id = ?')
      .get(id) as { status: string; workspace_key: string | null } | undefined;
    expect(row?.status).toBe('ended');
    expect(row?.workspace_key).toBeNull();
  });

  it('backfillWorkspaceKeys: row under users/ gets workspace_key backfilled', () => {
    const instanceCwd = '/home/q/LAB/whatsapp-bot';
    const id = createSession(
      db,
      20002,
      '/home/q/LAB/whatsapp-bot/users/9990000002',
      '9990000002@s.whatsapp.net',
    );
    backfillWorkspaceKeys(db, instanceCwd);

    const row = db.raw
      .prepare('SELECT status, workspace_key FROM agent_sessions WHERE id = ?')
      .get(id) as { status: string; workspace_key: string | null } | undefined;
    expect(row?.workspace_key).toBe('9990000002');
    expect(row?.status).toBe('active');
  });

  it('backfillWorkspaceKeys: skips rows that already have workspace_key', () => {
    const instanceCwd = '/home/q/LAB/whatsapp-bot';
    const id = createSession(
      db,
      20003,
      '/home/q/LAB/whatsapp-bot/users/9990000003',
      '9990000003@s.whatsapp.net',
      'already-set',
    );
    backfillWorkspaceKeys(db, instanceCwd);

    const row = db.raw
      .prepare('SELECT workspace_key FROM agent_sessions WHERE id = ?')
      .get(id) as { workspace_key: string | null } | undefined;
    expect(row?.workspace_key).toBe('already-set');
  });

  it('markOrphaned changes status to orphaned', () => {
    const id = createSession(db, 30001, '/tmp/orphan');
    markOrphaned(db, id);

    const row = db.raw
      .prepare('SELECT status FROM agent_sessions WHERE id = ?')
      .get(id) as { status: string } | undefined;
    expect(row?.status).toBe('orphaned');
  });

  it('sweepOrphanedSessions returns only active rows', () => {
    const activeId = createSession(db, 40001, '/tmp/sweep-active');
    const crashedId = createSession(db, 40002, '/tmp/sweep-crashed');
    updateSessionStatus(db, crashedId, 'crashed');
    const endedId = createSession(db, 40003, '/tmp/sweep-ended');
    updateSessionStatus(db, endedId, 'ended');

    const results = sweepOrphanedSessions(db);
    const ids = results.map((r) => r.id);
    expect(ids).toContain(activeId);
    expect(ids).not.toContain(crashedId);
    expect(ids).not.toContain(endedId);
    // Verify PID is returned
    const found = results.find((r) => r.id === activeId);
    expect(found?.claude_pid).toBe(40001);
  });

  it('getResumableSessionForChat returns newest suspended or orphaned row', () => {
    const wk = 'resumable-test-user';
    const jid = '5550000001@s.whatsapp.net';

    // Older suspended session
    const oldId = createSession(db, 50001, '/tmp/r1', jid, wk);
    updateSessionId(db, oldId, 'ses-old');
    db.raw.prepare(`UPDATE agent_sessions SET status = 'suspended' WHERE id = ?`).run(oldId);

    // Newer orphaned session
    const newId = createSession(db, 50002, '/tmp/r2', jid, wk);
    updateSessionId(db, newId, 'ses-new');
    markOrphaned(db, newId);

    // Active session — should NOT be returned
    const activeId = createSession(db, 50003, '/tmp/r3', jid, wk);
    updateSessionId(db, activeId, 'ses-active');

    const result = getResumableSessionForChat(db, wk);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(newId);
    expect(result?.session_id).toBe('ses-new');
    expect(result?.chat_jid).toBe(jid);
  });

  it('getResumableSessionForChat returns null when no resumable session exists', () => {
    const result = getResumableSessionForChat(db, 'nonexistent-workspace-key');
    expect(result).toBeNull();
  });

  it('getResumableSessionForChat does not return active sessions', () => {
    const wk = 'active-only-key';
    const jid = '5550000002@s.whatsapp.net';
    const id = createSession(db, 60001, '/tmp/active-only', jid, wk);
    updateSessionId(db, id, 'ses-active-only');
    // status remains 'active'

    const result = getResumableSessionForChat(db, wk);
    expect(result).toBeNull();
  });
});
