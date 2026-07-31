import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import {
  ensureAgentSchema,
  createSession,
  getActiveSession,
  updateSessionId,
  updateSessionStatus,
  updateTranscriptPath,
  incrementMessageCount,
  accumulateSessionTokens,
  insertTokenEvent,
  accumulateTokensWithEvent,
  getSessionTokenSnapshot,
  markSessionCompacted,
  backfillWorkspaceKeys,
  markOrphaned,
  getResumableSessionForChat,
  resolveResumableAgentSession,
  restoreOrphanedResidentSessionStatus,
  backfillSessionProvider,
  listActiveSessionRows,
} from '../../../src/runtimes/agent/session-db.ts';

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function tempDbPath(): string {
  return join(tmpdir(), `whatsoup-agent-test-${randomBytes(4).toString('hex')}.db`);
}

const dbPath = tempDbPath();
const db = new Database(dbPath);
db.open();
ensureAgentSchema(db);
const sqliteTimestampPattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

afterAll(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const fp = dbPath + suffix;
    if (existsSync(fp)) unlinkSync(fp);
  }
});

describe('agent session-db', () => {
  beforeEach(() => {
    db.raw.prepare('DELETE FROM agent_token_events').run();
    db.raw.prepare('DELETE FROM completed_delivery_identity_admissions').run();
    db.raw.prepare('DELETE FROM session_checkpoints').run();
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
    const id = createSession(db, 12345, '~/project');
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
    expect(row?.started_in_directory).toBe('~/project');
    expect(row?.session_id).toBeNull();
    expect(row?.started_at).toMatch(sqliteTimestampPattern);
  });

  it('getActiveSession returns the active session with new fields', () => {
    const id = createSession(
      db,
      99999,
      '/tmp/test',
      'active@s.whatsapp.net',
      'active-conversation',
      'claude-cli',
    );
    // getActiveSession requires a session_id (only resumable sessions qualify)
    updateSessionId(db, id, 'ses-abc123');
    const session = getActiveSession(db, 'claude-cli');
    expect(session).not.toBeNull();
    expect(session?.id).toBe(id);
    expect(session?.claude_pid).toBe(99999);
    expect(session?.status).toBe('active');
    expect(session?.session_id).toBe('ses-abc123');
    expect(session?.chat_jid).toBe('active@s.whatsapp.net');
    expect(session?.started_at).toMatch(sqliteTimestampPattern);
    expect(session?.last_message_at).toStrictEqual(null);
    expect(session?.message_count).toBe(0);
    expect(session?.workspace_key).toBe('active-conversation');
  });

  it('getActiveSession returns null when no active session exists', () => {
    const session = getActiveSession(db, 'claude-cli');
    expect(session).toStrictEqual(null);
  });

  it('getActiveSession fails closed for a foreign or ambiguous provider namespace', () => {
    const claudeRow = createSession(
      db,
      99990,
      '/tmp/claude',
      'provider-active@s.whatsapp.net',
      'provider-active',
      'claude-cli',
    );
    updateSessionId(db, claudeRow, 'shared-opaque-id');

    expect(getActiveSession(db, 'opencode-cli')).toBeNull();
    expect(getActiveSession(db, 'claude-cli')?.id).toBe(claudeRow);

    const opencodeRow = createSession(
      db,
      99991,
      '/tmp/opencode',
      'provider-active@s.whatsapp.net',
      'provider-active',
      'opencode-cli',
    );
    updateSessionId(db, opencodeRow, 'shared-opaque-id');

    expect(getActiveSession(db, 'claude-cli')).toBeNull();
    expect(getActiveSession(db, 'opencode-cli')).toBeNull();
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

  it('listActiveSessionRows returns only active sessions that have a workspace_key', () => {
    // active + workspace_key → included (drives the handoff distiller sweep)
    const a = createSession(db, 41111, '/tmp/a', 'a@s.whatsapp.net', 'conv-a', 'claude-cli');
    // active but NO workspace_key → excluded (can't key a handoff artifact)
    createSession(db, 42222, '/tmp/b', 'b@s.whatsapp.net', undefined, 'claude-cli');
    // active + workspace_key but then ended → excluded
    const c = createSession(db, 43333, '/tmp/c', 'c@s.whatsapp.net', 'conv-c', 'claude-cli');
    updateSessionStatus(db, c, 'ended');

    const rows = listActiveSessionRows(db);
    expect(rows).toEqual([{ conversationKey: 'conv-a', rowId: a }]);
  });

  it('updateSessionId sets session_id field', () => {
    const id = createSession(db, 33333, '/tmp/sid');
    updateSessionId(db, id, 'ses_abc123');

    const row = db.raw
      .prepare('SELECT session_id FROM agent_sessions WHERE id = ?')
      .get(id) as { session_id: string } | undefined;
    expect(row?.session_id).toBe('ses_abc123');
  });

  it('getActiveSession returns null after session is crashed', () => {
    const id = createSession(db, 55555, '/tmp/postcr');
    updateSessionStatus(db, id, 'crashed');
    expect(getActiveSession(db, 'claude-cli')).toBeNull();
  });

  it('getActiveSession returns null after session is ended', () => {
    const id = createSession(db, 66666, '/tmp/postend');
    updateSessionStatus(db, id, 'ended');
    expect(getActiveSession(db, 'claude-cli')).toBeNull();
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
    expect(row?.chat_jid).toStrictEqual(null);
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
    expect(after?.last_message_at).toMatch(sqliteTimestampPattern);

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
    expect(row?.workspace_key).toStrictEqual(null);
  });

  it('backfillWorkspaceKeys: root-cwd row is marked ended', () => {
    const instanceCwd = '/workspace/WhatSoup';
    // Row started in instance root — pre-isolation shared session
    const id = createSession(db, 20001, instanceCwd, '9990000001@s.whatsapp.net');
    backfillWorkspaceKeys(db, instanceCwd);

    const row = db.raw
      .prepare('SELECT status, workspace_key FROM agent_sessions WHERE id = ?')
      .get(id) as { status: string; workspace_key: string | null } | undefined;
    expect(row?.status).toBe('ended');
    expect(row?.workspace_key).toStrictEqual(null);
  });

  it('backfillWorkspaceKeys: row under users/ gets workspace_key backfilled', () => {
    const instanceCwd = '/workspace/WhatSoup';
    const id = createSession(
      db,
      20002,
      '/workspace/WhatSoup/users/9990000002',
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
    const instanceCwd = '/workspace/WhatSoup';
    const id = createSession(
      db,
      20003,
      '/workspace/WhatSoup/users/9990000003',
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

  it('getResumableSessionForChat returns newest suspended or orphaned row', () => {
    const wk = 'resumable-test-user';
    const jid = '5550000001@s.whatsapp.net';

    // Older suspended session
    const oldId = createSession(db, 50001, '/tmp/r1', jid, wk, 'claude-cli');
    updateSessionId(db, oldId, 'ses-old');
    db.raw.prepare(`UPDATE agent_sessions SET status = 'suspended' WHERE id = ?`).run(oldId);

    // Newer orphaned session
    const newId = createSession(db, 50002, '/tmp/r2', jid, wk, 'claude-cli');
    updateSessionId(db, newId, 'ses-new');
    markOrphaned(db, newId);

    // Active session — should NOT be returned
    const activeId = createSession(db, 50003, '/tmp/r3', jid, wk, 'claude-cli');
    updateSessionId(db, activeId, 'ses-active');

    const result = getResumableSessionForChat(db, wk, 'claude-cli');
    expect(result).not.toBeNull();
    expect(result?.id).toBe(newId);
    expect(result?.session_id).toBe('ses-new');
    expect(result?.chat_jid).toBe(jid);
  });

  it('getResumableSessionForChat returns null when no resumable session exists', () => {
    const result = getResumableSessionForChat(
      db,
      'nonexistent-workspace-key',
      'claude-cli',
    );
    expect(result).toStrictEqual(null);
  });

  // B04a: Verify Codex thread ID (stored as session_id) survives persistence
  // and is recoverable via getResumableSessionForChat for crash resume.
  it('Codex thread ID persisted as session_id is retrievable for crash resume', () => {
    const wk = 'codex-thread-persist-test';
    const jid = '5550000099@s.whatsapp.net';
    const codexThreadId = 'thread_abc123def456';

    // Simulate: session created, Codex thread ID stored via updateSessionId
    // (mirrors session.ts handleProviderEvent where codexThreadId = event.sessionId
    //  and updateSessionId(db, dbRowId, event.sessionId) is called)
    const id = createSession(db, 70001, '/tmp/codex-thread', jid, wk, 'codex-cli');
    updateSessionId(db, id, codexThreadId);

    // Simulate crash: session marked as orphaned
    markOrphaned(db, id);

    // Verify: getResumableSessionForChat returns the thread ID
    const resumable = getResumableSessionForChat(db, wk, 'codex-cli');
    expect(resumable).not.toBeNull();
    expect(resumable?.session_id).toBe(codexThreadId);
    expect(resumable?.chat_jid).toBe(jid);
    expect(resumable?.id).toBe(id);
  });

  it('getResumableSessionForChat does not return active sessions', () => {
    const wk = 'active-only-key';
    const jid = '5550000002@s.whatsapp.net';
    const id = createSession(db, 60001, '/tmp/active-only', jid, wk, 'claude-cli');
    updateSessionId(db, id, 'ses-active-only');
    // status remains 'active'

    const result = getResumableSessionForChat(db, wk, 'claude-cli');
    expect(result).toStrictEqual(null);
  });

  it('getResumableSessionForChat hides foreign and provider-ambiguous rows', () => {
    const wk = 'provider-resume-selector';
    const jid = 'provider-resume@s.whatsapp.net';
    const claudeRow = createSession(db, 60010, '/tmp/claude', jid, wk, 'claude-cli');
    updateSessionId(db, claudeRow, 'provider-shared-id');
    updateSessionStatus(db, claudeRow, 'suspended');

    expect(getResumableSessionForChat(db, wk, 'opencode-cli')).toBeNull();
    expect(getResumableSessionForChat(db, wk, 'claude-cli')?.id).toBe(claudeRow);

    const opencodeRow = createSession(db, 60011, '/tmp/opencode', jid, wk, 'opencode-cli');
    updateSessionId(db, opencodeRow, 'provider-shared-id');
    updateSessionStatus(db, opencodeRow, 'orphaned');

    expect(getResumableSessionForChat(db, wk, 'claude-cli')).toBeNull();
    expect(getResumableSessionForChat(db, wk, 'opencode-cli')).toBeNull();
  });

  it('excludes unresolved completed-delivery identity admissions from lazy, direct, and shared selectors', () => {
    const workspaceKey = 'admission-protected';
    const rowId = createSession(
      db,
      60012,
      '/tmp/admission-protected',
      'admission-protected@s.whatsapp.net',
      workspaceKey,
      'claude-cli',
    );
    updateSessionId(db, rowId, 'admission-protected-session');
    updateSessionStatus(db, rowId, 'active');
    writeResumeCheckpoint(workspaceKey, 'admission-protected-session', 'active');
    const checkpoint = db.raw.prepare(
      'SELECT id FROM session_checkpoints WHERE conversation_key = ?',
    ).get(workspaceKey) as { id: number };
    const input = {
      provider: 'claude-cli',
      providerSessionId: 'admission-protected-session',
      agentSessionRowId: rowId,
      workspaceKey,
    };

    db.raw.prepare(`
      INSERT INTO completed_delivery_identity_admissions (
        target_kind, target_id, state, reason, attempts, owner, next_action
      ) VALUES ('checkpoint', ?, 'quarantined', 'invalid', 1, 'fresh_inbound', 'fresh_inbound')
    `).run(checkpoint.id);

    expect(getActiveSession(db, 'claude-cli')).toBeNull();
    expect(() => resolveResumableAgentSession(db, input)).toThrow(/admission|resumable|checkpoint/i);

    updateSessionStatus(db, rowId, 'orphaned');
    db.raw.prepare(
      "UPDATE session_checkpoints SET session_status = 'orphaned' WHERE id = ?",
    ).run(checkpoint.id);
    expect(getResumableSessionForChat(db, workspaceKey, 'claude-cli')).toBeNull();
    expect(() => resolveResumableAgentSession(db, input)).toThrow(/admission|resumable|checkpoint/i);

    db.raw.prepare(`
      DELETE FROM completed_delivery_identity_admissions
      WHERE target_kind = 'checkpoint' AND target_id = ?
    `).run(checkpoint.id);
    updateSessionStatus(db, rowId, 'active');
    db.raw.prepare(`
      INSERT INTO completed_delivery_identity_admissions (
        target_kind, target_id, state, reason, attempts, owner, next_action
      ) VALUES ('agent_session', ?, 'quarantined', 'scope_mismatch', 1, 'fresh_inbound', 'fresh_inbound')
    `).run(rowId);

    expect(getActiveSession(db, 'claude-cli')).toBeNull();
    expect(getResumableSessionForChat(db, workspaceKey, 'claude-cli')).toBeNull();
    expect(() => resolveResumableAgentSession(db, input)).toThrow(/admission|resumable|checkpoint/i);
  });

  it('excludes an unscoped shared row when its provider session has checkpoint-targeted debt', () => {
    const sessionId = 'shared-checkpoint-admission-session';
    const rowId = createSession(db, 60013, '/tmp/shared-admission', undefined, undefined, 'claude-cli');
    updateSessionId(db, rowId, sessionId);
    writeResumeCheckpoint('shared-admission-conversation', sessionId, 'active');
    const checkpoint = db.raw.prepare(
      'SELECT id FROM session_checkpoints WHERE conversation_key = ?',
    ).get('shared-admission-conversation') as { id: number };
    db.raw.prepare(`
      INSERT INTO completed_delivery_identity_admissions (
        target_kind, target_id, state, reason, attempts, owner, next_action
      ) VALUES ('checkpoint', ?, 'quarantined', 'missing', 1, 'operator', 'operator')
    `).run(checkpoint.id);

    expect(getActiveSession(db, 'claude-cli')).toBeNull();
  });

  function writeResumeCheckpoint(
    conversationKey: string,
    sessionId: string,
    status: 'active' | 'suspended' | 'orphaned' = 'suspended',
  ): void {
    db.raw.prepare(
      `INSERT INTO session_checkpoints (conversation_key, session_id, session_status)
       VALUES (?, ?, ?)`,
    ).run(conversationKey, sessionId, status);
  }

  function snapshotResumeState(): unknown {
    return {
      agentSessions: db.raw.prepare(
        `SELECT id, session_id, workspace_key, provider, status, claude_pid, ended_at
         FROM agent_sessions ORDER BY id`,
      ).all(),
      checkpoints: db.raw.prepare(
        `SELECT conversation_key, session_id, session_status, claude_pid,
                checkpoint_version, updated_at
         FROM session_checkpoints ORDER BY conversation_key`,
      ).all(),
    };
  }

  it('resolveResumableAgentSession proves exact provider, row, and conversation composition', () => {
    const rowId = createSession(
      db,
      60100,
      '/tmp/exact-resume',
      'exact-resume@s.whatsapp.net',
      'exact-resume',
      'claude-cli',
    );
    updateSessionId(db, rowId, 'exact-provider-session');
    updateSessionStatus(db, rowId, 'suspended');
    writeResumeCheckpoint('exact-resume', 'exact-provider-session');

    expect(resolveResumableAgentSession(db, {
      provider: 'claude-cli',
      providerSessionId: 'exact-provider-session',
      agentSessionRowId: rowId,
      workspaceKey: 'exact-resume',
    })).toEqual({
      id: rowId,
      provider: 'claude-cli',
      workspace_key: 'exact-resume',
    });
  });

  it.each([
    {
      name: 'foreign provider',
      setup: () => {
        const rowId = createSession(db, 60101, '/tmp/foreign', 'foreign@s.whatsapp.net', 'foreign', 'claude-cli');
        updateSessionId(db, rowId, 'foreign-session');
        updateSessionStatus(db, rowId, 'suspended');
        writeResumeCheckpoint('foreign', 'foreign-session');
        return { provider: 'opencode-cli', providerSessionId: 'foreign-session', agentSessionRowId: rowId, workspaceKey: 'foreign' };
      },
    },
    {
      name: 'null-provider persisted ID',
      setup: () => {
        const rowId = createSession(db, 60102, '/tmp/legacy', 'legacy@s.whatsapp.net', 'legacy');
        updateSessionId(db, rowId, 'legacy-session');
        updateSessionStatus(db, rowId, 'suspended');
        writeResumeCheckpoint('legacy', 'legacy-session');
        return { provider: 'claude-cli', providerSessionId: 'legacy-session', agentSessionRowId: rowId, workspaceKey: 'legacy' };
      },
    },
    {
      name: 'cross-provider duplicate ID',
      setup: () => {
        const rowId = createSession(db, 60103, '/tmp/duplicate-a', 'duplicate@s.whatsapp.net', 'duplicate', 'claude-cli');
        updateSessionId(db, rowId, 'duplicate-session');
        updateSessionStatus(db, rowId, 'suspended');
        const other = createSession(db, 60104, '/tmp/duplicate-b', 'duplicate@s.whatsapp.net', 'duplicate', 'opencode-cli');
        updateSessionId(db, other, 'duplicate-session');
        updateSessionStatus(db, other, 'orphaned');
        writeResumeCheckpoint('duplicate', 'duplicate-session');
        return { provider: 'claude-cli', providerSessionId: 'duplicate-session', agentSessionRowId: rowId, workspaceKey: 'duplicate' };
      },
    },
    {
      name: 'conversation mismatch',
      setup: () => {
        const rowId = createSession(db, 60105, '/tmp/conversation', 'conversation@s.whatsapp.net', 'persisted-conversation', 'claude-cli');
        updateSessionId(db, rowId, 'conversation-session');
        updateSessionStatus(db, rowId, 'suspended');
        writeResumeCheckpoint('persisted-conversation', 'conversation-session');
        return { provider: 'claude-cli', providerSessionId: 'conversation-session', agentSessionRowId: rowId, workspaceKey: 'different-conversation' };
      },
    },
    {
      name: 'missing exact checkpoint',
      setup: () => {
        const rowId = createSession(db, 60106, '/tmp/no-checkpoint', 'no-checkpoint@s.whatsapp.net', 'no-checkpoint', 'claude-cli');
        updateSessionId(db, rowId, 'no-checkpoint-session');
        updateSessionStatus(db, rowId, 'suspended');
        return { provider: 'claude-cli', providerSessionId: 'no-checkpoint-session', agentSessionRowId: rowId, workspaceKey: 'no-checkpoint' };
      },
    },
  ])('resolveResumableAgentSession rejects $name without any persistence mutation', ({ setup }) => {
    const input = setup();
    const before = snapshotResumeState();

    expect(() => resolveResumableAgentSession(db, input)).toThrow(
      /provider|ambiguous|ownership|resumable|conversation|checkpoint/i,
    );
    expect(snapshotResumeState()).toEqual(before);
  });

  it('insertTokenEvent inserts a row in agent_token_events', () => {
    const id = createSession(db, 80001, '/tmp/token-event');
    insertTokenEvent(db, id, 100, 50);

    const row = db.raw.prepare(
      'SELECT agent_session_id, input_tokens, output_tokens, timestamp FROM agent_token_events WHERE agent_session_id = ?'
    ).get(id) as { agent_session_id: number; input_tokens: number; output_tokens: number; timestamp: number } | undefined;

    expect(row).toBeDefined();
    expect(row!.agent_session_id).toBe(id);
    expect(row!.input_tokens).toBe(100);
    expect(row!.output_tokens).toBe(50);
    expect(row!.timestamp).toBeGreaterThan(0);
  });

  it('accumulateSessionTokens and insertTokenEvent together maintain consistency', () => {
    const id = createSession(db, 80002, '/tmp/token-dual');

    insertTokenEvent(db, id, 100, 50);
    accumulateSessionTokens(db, id, 100, 50, 0);
    insertTokenEvent(db, id, 200, 75);
    accumulateSessionTokens(db, id, 200, 75, 0);
    insertTokenEvent(db, id, 50, 25);
    accumulateSessionTokens(db, id, 50, 25, 0);

    const eventSum = db.raw.prepare(
      'SELECT SUM(input_tokens) AS total_in, SUM(output_tokens) AS total_out FROM agent_token_events WHERE agent_session_id = ?'
    ).get(id) as { total_in: number; total_out: number };

    const session = db.raw.prepare(
      'SELECT total_input_tokens, total_output_tokens FROM agent_sessions WHERE id = ?'
    ).get(id) as { total_input_tokens: number; total_output_tokens: number };

    expect(eventSum.total_in).toBe(session.total_input_tokens);
    expect(eventSum.total_out).toBe(session.total_output_tokens);
    expect(eventSum.total_in).toBe(350);
    expect(eventSum.total_out).toBe(150);
  });

  it('tracks the token baseline from the last successful compact', () => {
    const id = createSession(db, 80003, '/tmp/token-compact');
    accumulateSessionTokens(db, id, 600, 25, 0);

    const before = getSessionTokenSnapshot(db, id);
    expect(before).toEqual({
      totalInputTokens: 600,
      totalOutputTokens: 25,
      totalCacheReadTokens: 0,
      lastCompactInputTokens: 0,
      lastCompactOutputTokens: 0,
      lastCompactCacheReadTokens: 0,
    });

    markSessionCompacted(db, id);

    const afterCompact = db.raw.prepare(
      `SELECT last_compact_at, last_compact_input_tokens, last_compact_output_tokens
       FROM agent_sessions WHERE id = ?`,
    ).get(id) as {
      last_compact_at: string | null;
      last_compact_input_tokens: number;
      last_compact_output_tokens: number;
    };

    expect(afterCompact.last_compact_at).toMatch(sqliteTimestampPattern);
    expect(afterCompact.last_compact_input_tokens).toBe(600);
    expect(afterCompact.last_compact_output_tokens).toBe(25);

    accumulateSessionTokens(db, id, 40, 5, 0);
    expect(getSessionTokenSnapshot(db, id)).toEqual({
      totalInputTokens: 640,
      totalOutputTokens: 30,
      totalCacheReadTokens: 0,
      lastCompactInputTokens: 600,
      lastCompactOutputTokens: 25,
      lastCompactCacheReadTokens: 0,
    });
  });

  it('#1774: total_input_tokens grows linearly (not with the repeated cache_read term) across many turns of a fixed-context conversation', () => {
    // A stable, large conversation context re-read every turn — cache_read
    // stays CONSTANT per turn (unlike a growing conversation, this isolates
    // the conflation bug: even a non-growing re-read must never accumulate
    // into total_input_tokens). Before the split, this same call shape
    // would have summed inputTokens = newTokensPerTurn + cacheReadPerTurn
    // into total_input_tokens every turn — i.e. dominated by the huge
    // constant, not by genuine consumption.
    const id = createSession(db, 90500, '/tmp/token-linear-growth');
    const TURNS = 25;
    const NEW_TOKENS_PER_TURN = 8;
    const CACHE_READ_PER_TURN = 250_000; // one order of magnitude bigger than any real "new" turn content

    for (let turn = 0; turn < TURNS; turn += 1) {
      accumulateSessionTokens(db, id, NEW_TOKENS_PER_TURN, 1, CACHE_READ_PER_TURN);
    }

    const snapshot = getSessionTokenSnapshot(db, id);
    expect(snapshot).not.toBeNull();
    // Linear in turn count, proportional ONLY to genuinely-new tokens —
    // not the O(turns) (let alone O(turns^2) for a growing context) blowup
    // that including cache_read every turn would produce.
    expect(snapshot!.totalInputTokens).toBe(TURNS * NEW_TOKENS_PER_TURN);
    // Sanity ceiling: total_input_tokens must stay far below even a single
    // turn's cache_read value — proving cache_read never leaked in.
    expect(snapshot!.totalInputTokens).toBeLessThan(CACHE_READ_PER_TURN);
    // total_cache_read_tokens is EXPECTED to scale with turn count — that
    // growth is honest (labeled as cumulative re-reads), not a defect.
    expect(snapshot!.totalCacheReadTokens).toBe(TURNS * CACHE_READ_PER_TURN);
  });

  it('updateSessionStatus sets ended_at for terminal statuses', () => {
    const terminalStatuses = ['ended', 'crashed', 'resume_failed', 'orphaned'];
    for (const status of terminalStatuses) {
      const id = createSession(db, 80010 + terminalStatuses.indexOf(status), `/tmp/terminal-${status}`);
      updateSessionStatus(db, id, status);

      const row = db.raw.prepare(
        'SELECT ended_at, status FROM agent_sessions WHERE id = ?'
      ).get(id) as { ended_at: string | null; status: string };

      expect(row.status).toBe(status);
      expect(row.ended_at).not.toBeNull();
      // ISO 8601 format from new Date().toISOString()
      expect(row.ended_at).toMatch(isoTimestampPattern);
    }
  });

  it('updateSessionStatus does NOT set ended_at for suspended status', () => {
    const id = createSession(db, 80020, '/tmp/suspended-no-ended');
    updateSessionStatus(db, id, 'suspended');

    const row = db.raw.prepare(
      'SELECT ended_at, status FROM agent_sessions WHERE id = ?'
    ).get(id) as { ended_at: string | null; status: string };

    expect(row.status).toBe('suspended');
    expect(row.ended_at).toStrictEqual(null);
  });

  it('updateSessionStatus does NOT set ended_at for active status', () => {
    const id = createSession(db, 80021, '/tmp/active-no-ended');
    updateSessionStatus(db, id, 'active');

    const row = db.raw.prepare(
      'SELECT ended_at, status FROM agent_sessions WHERE id = ?'
    ).get(id) as { ended_at: string | null; status: string };

    expect(row.status).toBe('active');
    expect(row.ended_at).toStrictEqual(null);
  });

  it('updateSessionStatus clears stale ended_at when reactivating a terminal row', () => {
    const id = createSession(db, 1234, '/tmp');
    updateSessionStatus(db, id, 'crashed');

    updateSessionStatus(db, id, 'active');

    const row = db.raw.prepare(
      'SELECT ended_at, status FROM agent_sessions WHERE id = ?',
    ).get(id) as { ended_at: string | null; status: string };
    expect(row).toEqual({ ended_at: null, status: 'active' });
  });

  it('restores only an exact orphaned resident provider-session identity', () => {
    const id = createSession(db, 0, '/tmp/resident', undefined, 'resident', 'opencode-cli');
    updateSessionId(db, id, 'ses-resident');
    updateSessionStatus(db, id, 'orphaned');
    const durability = new DurabilityEngine(db);
    durability.upsertSessionCheckpoint('resident', {
      sessionId: 'ses-resident',
      sessionStatus: 'active',
    });

    expect(restoreOrphanedResidentSessionStatus(db, id, 'ses-other', 'opencode-cli')).toBe('refused');
    expect(restoreOrphanedResidentSessionStatus(db, id, 'ses-resident', 'claude-cli')).toBe('refused');
    expect(db.raw.prepare('SELECT status FROM agent_sessions WHERE id = ?').get(id)).toEqual({
      status: 'orphaned',
    });

    expect(restoreOrphanedResidentSessionStatus(db, id, 'ses-resident', 'opencode-cli')).toBe('restored');
    expect(db.raw.prepare('SELECT status, ended_at FROM agent_sessions WHERE id = ?').get(id)).toEqual({
      status: 'active',
      ended_at: null,
    });
    expect(restoreOrphanedResidentSessionStatus(db, id, 'ses-resident', 'opencode-cli')).toBe('already_active');

    durability.upsertSessionCheckpoint('resident', { sessionStatus: 'suspended' });
    expect(restoreOrphanedResidentSessionStatus(db, id, 'ses-resident', 'opencode-cli')).toBe('refused');
    expect(db.raw.prepare('SELECT status FROM agent_sessions WHERE id = ?').get(id)).toEqual({
      status: 'active',
    });
  });

  it.each(['ended', 'completed', 'crashed', 'resume_failed', 'suspended'])(
    'refuses to revive a %s resident row',
    (status) => {
      const id = createSession(db, 0, `/tmp/resident-${status}`, undefined, `resident-${status}`, 'opencode-cli');
      updateSessionId(db, id, `ses-${status}`);
      updateSessionStatus(db, id, status);
      const durability = new DurabilityEngine(db);
      durability.upsertSessionCheckpoint(`resident-${status}`, {
        sessionId: `ses-${status}`,
        sessionStatus: 'active',
      });
      const before = db.raw
        .prepare('SELECT status, ended_at FROM agent_sessions WHERE id = ?')
        .get(id);

      expect(
        restoreOrphanedResidentSessionStatus(db, id, `ses-${status}`, 'opencode-cli'),
      ).toBe('refused');
      expect(
        db.raw.prepare('SELECT status, ended_at FROM agent_sessions WHERE id = ?').get(id),
      ).toEqual(before);
    },
  );

  it('accumulateTokensWithEvent rolls back both writes on failure', () => {
    const id = createSession(db, 90001, '/tmp/atomic-test');

    // Successful call — both session total and event row should be written
    accumulateTokensWithEvent(db, id, 100, 50, 0);
    const eventCount = (db.raw.prepare(
      'SELECT COUNT(*) AS cnt FROM agent_token_events WHERE agent_session_id = ?'
    ).get(id) as { cnt: number }).cnt;
    expect(eventCount).toBe(1);
    const session = db.raw.prepare(
      'SELECT total_input_tokens, total_output_tokens FROM agent_sessions WHERE id = ?'
    ).get(id) as { total_input_tokens: number; total_output_tokens: number };
    expect(session.total_input_tokens).toBe(100);
    expect(session.total_output_tokens).toBe(50);

    // Force failure: use an invalid session ID that violates the FK constraint
    expect(() => accumulateTokensWithEvent(db, 999999, 200, 75, 0)).toThrow();

    // Original session totals unchanged — the failed call targeted a different ID
    // and rolled back, so no side effects
    const afterFail = db.raw.prepare(
      'SELECT total_input_tokens, total_output_tokens FROM agent_sessions WHERE id = ?'
    ).get(id) as { total_input_tokens: number; total_output_tokens: number };
    expect(afterFail.total_input_tokens).toBe(100);
    expect(afterFail.total_output_tokens).toBe(50);

    // No extra event rows written from the failed call
    const afterFailCount = (db.raw.prepare(
      'SELECT COUNT(*) AS cnt FROM agent_token_events WHERE agent_session_id = ?'
    ).get(id) as { cnt: number }).cnt;
    expect(afterFailCount).toBe(1);
  });

  it('createSession stores provider when provided', () => {
    const id = createSession(db, 90100, '/tmp/provider-test', undefined, undefined, 'codex-cli');
    const row = db.raw.prepare(
      'SELECT provider FROM agent_sessions WHERE id = ?'
    ).get(id) as { provider: string | null };
    expect(row.provider).toBe('codex-cli');
  });

  it('createSession defaults provider to null when not provided', () => {
    const id = createSession(db, 90101, '/tmp/no-provider');
    const row = db.raw.prepare(
      'SELECT provider FROM agent_sessions WHERE id = ?'
    ).get(id) as { provider: string | null };
    expect(row.provider).toStrictEqual(null);
  });

  it('backfillSessionProvider sets provider on null rows only', () => {
    const id1 = createSession(db, 90102, '/tmp/backfill-1');
    const id2 = createSession(db, 90103, '/tmp/backfill-2', undefined, undefined, 'codex-cli');
    const persistedId = createSession(db, 90104, '/tmp/backfill-persisted');
    updateSessionId(db, persistedId, 'opaque-legacy-id');

    backfillSessionProvider(db, 'claude-cli');

    const row1 = db.raw.prepare('SELECT provider FROM agent_sessions WHERE id = ?').get(id1) as { provider: string };
    const row2 = db.raw.prepare('SELECT provider FROM agent_sessions WHERE id = ?').get(id2) as { provider: string };
    const persisted = db.raw.prepare('SELECT provider FROM agent_sessions WHERE id = ?').get(persistedId) as { provider: string | null };
    expect(row1.provider).toBe('claude-cli');
    expect(row2.provider).toBe('codex-cli');
    expect(Object.entries(persisted)).toStrictEqual([['provider', null]]);
  });
});

describe('session-db.ts uncovered-branch coverage', () => {
  beforeEach(() => {
    db.raw.prepare('DELETE FROM agent_token_events').run();
    db.raw.prepare('DELETE FROM session_checkpoints').run();
    db.raw.prepare('DELETE FROM agent_sessions').run();
  });

  it('updateTranscriptPath stores the transcript file path on the session row', () => {
    const id = createSession(db, 100100, '/tmp/transcript');
    updateTranscriptPath(db, id, '/var/log/transcripts/session-abc.jsonl');

    const row = db.raw
      .prepare('SELECT transcript_path FROM agent_sessions WHERE id = ?')
      .get(id) as { transcript_path: string | null };
    expect(row.transcript_path).toBe('/var/log/transcripts/session-abc.jsonl');
  });

  it('updateTranscriptPath overwrites a previously stored path', () => {
    const id = createSession(db, 100101, '/tmp/transcript-2');
    updateTranscriptPath(db, id, '/first/path.jsonl');
    updateTranscriptPath(db, id, '/second/path.jsonl');

    const row = db.raw
      .prepare('SELECT transcript_path FROM agent_sessions WHERE id = ?')
      .get(id) as { transcript_path: string | null };
    expect(row.transcript_path).toBe('/second/path.jsonl');
  });

  it('getSessionTokenSnapshot returns null when the row does not exist', () => {
    const snapshot = getSessionTokenSnapshot(db, 999999);
    // The function's contract is "null when the row is gone"; check that the
    // call is fully null (not undefined, not a partial record) and that
    // asking for it a second time is still null.
    expect(snapshot).toBeNull();
    expect(getSessionTokenSnapshot(db, 999999)).toBeNull();
    // Sanity: a separate valid row id does not accidentally resolve to null.
    const realId = createSession(db, 100150, '/tmp/real-row');
    const realSnapshot = getSessionTokenSnapshot(db, realId);
    expect(realSnapshot).toEqual({
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      lastCompactInputTokens: 0,
      lastCompactOutputTokens: 0,
      lastCompactCacheReadTokens: 0,
    });
  });

  it('getSessionTokenSnapshot coerces NULL columns to 0', () => {
    // Insert a row directly so the token columns are NULL (createSession only
    // sets a few fields and leaves the token counters as their column default
    // of 0, but writing NULL exercises the ?? 0 branches on every field).
    db.raw.prepare(
      `INSERT INTO agent_sessions
         (claude_pid, started_in_directory, started_at, status,
          total_input_tokens, total_output_tokens, total_cache_read_tokens,
          last_compact_input_tokens, last_compact_output_tokens,
          last_compact_cache_read_tokens)
       VALUES (?, ?, datetime('now'), 'active', NULL, NULL, NULL, NULL, NULL, NULL)`,
    ).run(100200, '/tmp/null-tokens');

    const id = (db.raw
      .prepare('SELECT id FROM agent_sessions WHERE claude_pid = 100200')
      .get() as { id: number }).id;

    const snapshot = getSessionTokenSnapshot(db, id);
    expect(snapshot).toEqual({
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      lastCompactInputTokens: 0,
      lastCompactOutputTokens: 0,
      lastCompactCacheReadTokens: 0,
    });
  });

  it('backfillWorkspaceKeys: row with non-users/groups dir (and not rootCwd) is marked ended', () => {
    // Pre-isolation shared session: cwd lives outside both /users/ and /groups/
    // AND does not match the instance root. Both clauses of the
    // isRootSession OR are false-then-true respectively.
    const instanceCwd = '/workspace/WhatSoup';
    const id = createSession(
      db,
      100300,
      '/some/legacy/shared/dir',
      '15551234567@s.whatsapp.net',
    );
    backfillWorkspaceKeys(db, instanceCwd);

    const row = db.raw
      .prepare('SELECT status, workspace_key FROM agent_sessions WHERE id = ?')
      .get(id) as { status: string; workspace_key: string | null };
    expect(row.workspace_key).toBeNull();
    expect(row.status).toBe('ended');
  });

  it('backfillWorkspaceKeys: invalid chat_jid falls back to raw chat_jid in workspace_key', () => {
    // An empty chat_jid is non-null but trips toConversationKey's "must contain @"
    // guard, exercising the catch path that uses row.chat_jid as the key.
    const instanceCwd = '/workspace/WhatSoup';
    const id = createSession(
      db,
      100301,
      '/workspace/WhatSoup/users/15559876543',
      '',
    );
    backfillWorkspaceKeys(db, instanceCwd);

    const row = db.raw
      .prepare('SELECT status, workspace_key FROM agent_sessions WHERE id = ?')
      .get(id) as { status: string; workspace_key: string | null };
    expect(row.workspace_key).toBe('');
    expect(row.status).toBe('active');
  });

  it('backfillWorkspaceKeys: chat_jid missing @ also falls back to raw chat_jid', () => {
    // A non-empty chat_jid without an @ is rejected by toConversationKey and
    // should be persisted verbatim as the workspace_key.
    const instanceCwd = '/workspace/WhatSoup';
    const id = createSession(
      db,
      100302,
      '/workspace/WhatSoup/users/15551112222',
      'no-at-sign',
    );
    backfillWorkspaceKeys(db, instanceCwd);

    const row = db.raw
      .prepare('SELECT status, workspace_key FROM agent_sessions WHERE id = ?')
      .get(id) as { status: string; workspace_key: string | null };
    expect(row.workspace_key).toBe('no-at-sign');
    expect(row.status).toBe('active');
  });

  it('backfillWorkspaceKeys: chat_jid null row is skipped (not updated, not ended)', () => {
    // Rows with chat_jid IS NULL are filtered out by the WHERE clause in
    // backfillWorkspaceKeys, so they are not processed at all.
    const instanceCwd = '/workspace/WhatSoup';
    const id = createSession(db, 100303, '/workspace/WhatSoup/users/15553334444');
    db.raw.prepare('UPDATE agent_sessions SET chat_jid = NULL WHERE id = ?').run(id);

    backfillWorkspaceKeys(db, instanceCwd);

    const row = db.raw
      .prepare('SELECT status, workspace_key, chat_jid FROM agent_sessions WHERE id = ?')
      .get(id) as { status: string; workspace_key: string | null; chat_jid: string | null };
    expect(row.chat_jid).toBeNull();
    expect(row.workspace_key).toBeNull();
    expect(row.status).toBe('active');
  });

  it('ensureAgentSchema rethrows non-duplicate-column errors thrown by ALTER TABLE', () => {
    // Force one of the idempotent ALTER TABLE migrations to fail with a
    // message that does NOT include "duplicate column name". The catch
    // block in ensureAgentSchema must rethrow it.
    const realExec = db.raw.exec.bind(db.raw);
    const spy = vi.spyOn(db.raw, 'exec').mockImplementation((sql: string) => {
      if (sql.startsWith('ALTER TABLE agent_sessions ADD COLUMN chat_jid')) {
        throw new Error('simulated non-duplicate column failure');
      }
      return realExec(sql);
    });

    let thrown: unknown = null;
    try {
      try {
        ensureAgentSchema(db);
      } catch (err) {
        thrown = err;
      }
    } finally {
      spy.mockRestore();
    }
    // Concrete terminal assertions: error is an Error instance whose message
    // does NOT include the swallow-keyword.
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('simulated non-duplicate column failure');
    expect((thrown as Error).message).not.toContain('duplicate column name');
  });

  it('accumulateTokensWithEvent swallows a ROLLBACK failure (best-effort rollback)', () => {
    // Drive the inner try/catch in the failure handler: make the inner
    // operation fail, then make ROLLBACK itself throw. The best-effort
    // rollback is documented to swallow any rollback error.
    const id = createSession(db, 100400, '/tmp/rollback-fail');

    // Force the insert (insertTokenEvent) to fail by passing an unknown id —
    // this raises the FK violation in the BEGIN IMMEDIATE block.
    // Then make ROLLBACK throw so the inner catch's "/* best-effort */" runs.
    const realExec = db.raw.exec.bind(db.raw);
    const spy = vi.spyOn(db.raw, 'exec').mockImplementation((sql: string) => {
      if (sql === 'ROLLBACK') {
        throw new Error('simulated rollback failure');
      }
      return realExec(sql);
    });

    try {
      expect(() => accumulateTokensWithEvent(db, 999999, 1, 1, 0)).toThrow(
        /FOREIGN KEY constraint failed|simulated rollback failure/,
      );
    } finally {
      spy.mockRestore();
    }

    // The session row we created must remain untouched: the rolled-back
    // transaction against a different id should not have leaked any writes
    // into our row.
    const row = db.raw
      .prepare('SELECT total_input_tokens, total_output_tokens FROM agent_sessions WHERE id = ?')
      .get(id) as { total_input_tokens: number; total_output_tokens: number };
    expect(row.total_input_tokens).toBe(0);
    expect(row.total_output_tokens).toBe(0);
  });

  it('backfillSessionProvider: no-op when no rows have null provider (changes === 0)', () => {
    // Every session already has a provider set, so the UPDATE matches 0 rows.
    // The if (changes > 0) branch must be skipped (no log.info).
    createSession(db, 100500, '/tmp/already-set-1', undefined, undefined, 'codex-cli');
    createSession(db, 100501, '/tmp/already-set-2', undefined, undefined, 'claude-cli');

    // Should not throw even though nothing changes.
    expect(() => backfillSessionProvider(db, 'claude-cli')).not.toThrow();

    // Providers are unchanged.
    const rows = db.raw
      .prepare('SELECT claude_pid, provider FROM agent_sessions ORDER BY id')
      .all() as Array<{ claude_pid: number; provider: string }>;
    expect(rows).toEqual([
      { claude_pid: 100500, provider: 'codex-cli' },
      { claude_pid: 100501, provider: 'claude-cli' },
    ]);
  });

  it('backfillWorkspaceKeys: row with NULL started_in_directory uses empty string for the dir check', () => {
    // A row whose started_in_directory is NULL takes the `?? ''` path; the
    // empty string contains neither '/users/' nor '/groups/' and is not
    // equal to the resolved cwd, so it is classified as a root session and
    // marked ended.
    const instanceCwd = '/workspace/WhatSoup';
    db.raw.prepare(
      `INSERT INTO agent_sessions
         (claude_pid, started_in_directory, chat_jid, started_at, status)
       VALUES (?, NULL, ?, datetime('now'), 'active')`,
    ).run(100600, '15554445566@s.whatsapp.net');

    const id = (db.raw
      .prepare('SELECT id FROM agent_sessions WHERE claude_pid = 100600')
      .get() as { id: number }).id;

    backfillWorkspaceKeys(db, instanceCwd);

    const row = db.raw
      .prepare('SELECT status, workspace_key, started_in_directory FROM agent_sessions WHERE id = ?')
      .get(id) as { status: string; workspace_key: string | null; started_in_directory: string | null };
    expect(row.started_in_directory).toBeNull();
    expect(row.workspace_key).toBeNull();
    expect(row.status).toBe('ended');
  });
});
