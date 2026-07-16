import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';

interface AgentLifecycleRow {
  id: number;
  session_id: string | null;
  claude_pid: number;
  status: string;
  ended_at: string | null;
}

function agentRow(db: Database, rowId: number): AgentLifecycleRow {
  const row = db.raw.prepare(
    `SELECT id, session_id, claude_pid, status, ended_at
     FROM agent_sessions WHERE id = ?`,
  ).get(rowId) as AgentLifecycleRow | undefined;
  if (!row) throw new Error(`missing agent row ${rowId}`);
  return row;
}

function insertAgentRow(
  db: Database,
  sessionId: string | null,
  status: string,
  workspaceKey: string,
  provider = 'claude-cli',
): number {
  const result = db.raw.prepare(
    `INSERT INTO agent_sessions (
       session_id, claude_pid, started_in_directory, chat_jid, workspace_key,
       started_at, status, ended_at, provider
     ) VALUES (?, 101, '/tmp/session', ?, ?, datetime('now'), ?, datetime('now'), ?)`,
  ).run(sessionId, `${workspaceKey}@s.whatsapp.net`, workspaceKey, status, provider);
  return Number(result.lastInsertRowid);
}

describe('SessionLifecycleStore through DurabilityEngine', () => {
  let db: Database;
  let durability: DurabilityEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    durability = new DurabilityEngine(db);
  });

  afterEach(() => db.close());

  it('atomically creates the agent row and resets the fresh checkpoint', () => {
    durability.upsertSessionCheckpoint('fresh-key', {
      sessionId: 'stale-session',
      sessionStatus: 'ended',
      lastInboundSeq: 9,
      completedInboundSeq: 9,
      completedDeliveryJid: 'fresh-key@s.whatsapp.net',
      completedDeliveryNamespace: 's.whatsapp.net',
      completedScope: 'per_chat',
      completedLogicalTurnId: 'stale-turn',
      completedManagerId: 'stale-manager',
      completedGeneration: 1,
    });

    const rowId = durability.beginFreshSessionLifecycle({
      pid: 212,
      cwd: '/tmp/fresh',
      chatJid: 'fresh-key@s.whatsapp.net',
      workspaceKey: 'fresh-key',
      provider: 'claude-cli',
      conversationKey: 'fresh-key',
    });

    expect(agentRow(db, rowId)).toMatchObject({
      session_id: null,
      claude_pid: 212,
      status: 'active',
      ended_at: null,
    });
    expect(durability.getSessionCheckpoint('fresh-key')).toMatchObject({
      session_id: null,
      claude_pid: 212,
      session_status: 'active',
      last_inbound_seq: null,
      completed_logical_turn_id: null,
    });
  });

  it('rolls back the fresh agent row when checkpoint persistence fails', () => {
    db.raw.exec(`
      CREATE TRIGGER deny_fresh_checkpoint
      BEFORE INSERT ON session_checkpoints
      WHEN NEW.conversation_key = 'fault-fresh'
      BEGIN
        SELECT RAISE(ABORT, 'checkpoint fault');
      END;
    `);

    expect(() => durability.beginFreshSessionLifecycle({
      pid: 313,
      cwd: '/tmp/fault',
      chatJid: 'fault-fresh@s.whatsapp.net',
      workspaceKey: 'fault-fresh',
      provider: 'claude-cli',
      conversationKey: 'fault-fresh',
    })).toThrow(/checkpoint fault/i);

    expect(db.raw.prepare(
      `SELECT COUNT(*) AS n FROM agent_sessions WHERE workspace_key = 'fault-fresh'`,
    ).get()).toEqual({ n: 0 });
    expect(durability.getSessionCheckpoint('fault-fresh')).toBeUndefined();
  });

  it('reactivates one exact resumable row and every exact-session checkpoint', () => {
    const rowId = insertAgentRow(db, 'resume-session', 'crashed', 'resume-a');
    durability.upsertSessionCheckpoint('resume-a', {
      sessionId: 'resume-session',
      sessionStatus: 'orphaned',
      claudePid: 101,
    });
    durability.upsertSessionCheckpoint('resume-b', {
      sessionId: 'resume-session',
      sessionStatus: 'suspended',
      claudePid: 101,
    });

    expect(durability.reactivateSessionLifecycle({
      agentSessionRowId: rowId,
      providerSessionId: 'resume-session',
      provider: 'claude-cli',
      pid: 414,
    })).toBe(rowId);

    expect(agentRow(db, rowId)).toMatchObject({
      session_id: 'resume-session',
      claude_pid: 414,
      status: 'active',
      ended_at: null,
    });
    expect(durability.getSessionCheckpoint('resume-a')).toMatchObject({
      claude_pid: 414,
      session_status: 'active',
    });
    expect(durability.getSessionCheckpoint('resume-b')).toMatchObject({
      claude_pid: 414,
      session_status: 'active',
    });
  });

  it('resolves a unique resumable row by provider session ID when its row ID is unavailable', () => {
    const rowId = insertAgentRow(db, 'proactive-session', 'suspended', 'proactive-a');
    durability.upsertSessionCheckpoint('proactive-a', {
      sessionId: 'proactive-session',
      sessionStatus: 'suspended',
    });

    expect(durability.reactivateSessionLifecycle({
      providerSessionId: 'proactive-session',
      provider: 'claude-cli',
      pid: 515,
    })).toBe(rowId);
    expect(agentRow(db, rowId)).toMatchObject({ status: 'active', ended_at: null });
  });

  it('rejects ambiguous or terminal resume identities without changing any row', () => {
    const first = insertAgentRow(db, 'ambiguous-session', 'suspended', 'ambiguous-a');
    const second = insertAgentRow(db, 'ambiguous-session', 'orphaned', 'ambiguous-b');
    durability.upsertSessionCheckpoint('ambiguous-a', {
      sessionId: 'ambiguous-session',
      sessionStatus: 'suspended',
    });

    expect(() => durability.reactivateSessionLifecycle({
      providerSessionId: 'ambiguous-session',
      provider: 'claude-cli',
      pid: 616,
    })).toThrow(/exactly one|ambiguous/i);
    expect(agentRow(db, first).status).toBe('suspended');
    expect(agentRow(db, second).status).toBe('orphaned');

    db.raw.prepare(`UPDATE agent_sessions SET status = 'ended' WHERE id IN (?, ?)`).run(first, second);
    expect(() => durability.reactivateSessionLifecycle({
      agentSessionRowId: first,
      providerSessionId: 'ambiguous-session',
      provider: 'claude-cli',
      pid: 717,
    })).toThrow(/resumable|exact/i);
    expect(agentRow(db, first).status).toBe('ended');
  });

  it('rolls back exact reactivation when checkpoint persistence fails', () => {
    const rowId = insertAgentRow(db, 'fault-resume-session', 'crashed', 'fault-resume');
    durability.upsertSessionCheckpoint('fault-resume', {
      sessionId: 'fault-resume-session',
      sessionStatus: 'orphaned',
      claudePid: 101,
    });
    db.raw.exec(`
      CREATE TRIGGER deny_resume_checkpoint
      BEFORE UPDATE ON session_checkpoints
      WHEN NEW.session_status = 'active' AND OLD.session_id = 'fault-resume-session'
      BEGIN
        SELECT RAISE(ABORT, 'resume checkpoint fault');
      END;
    `);

    expect(() => durability.reactivateSessionLifecycle({
      agentSessionRowId: rowId,
      providerSessionId: 'fault-resume-session',
      provider: 'claude-cli',
      pid: 818,
    })).toThrow(/resume checkpoint fault/i);

    expect(agentRow(db, rowId)).toMatchObject({
      claude_pid: 101,
      status: 'crashed',
      ended_at: expect.any(String),
    });
    expect(durability.getSessionCheckpoint('fault-resume')).toMatchObject({
      claude_pid: 101,
      session_status: 'orphaned',
    });
  });

  it('atomically closes an exact failure lifecycle', () => {
    const rowId = insertAgentRow(db, 'failed-session', 'active', 'failed-a');
    durability.upsertSessionCheckpoint('failed-a', {
      sessionId: 'failed-session',
      sessionStatus: 'active',
    });
    durability.upsertSessionCheckpoint('failed-b', {
      sessionId: 'failed-session',
      sessionStatus: 'active',
    });

    durability.closeSessionLifecycleFailure({
      agentSessionRowId: rowId,
      providerSessionId: 'failed-session',
      provider: 'claude-cli',
      conversationKey: 'failed-a',
      agentStatus: 'crashed',
    });

    expect(agentRow(db, rowId)).toMatchObject({
      status: 'crashed',
      ended_at: expect.any(String),
    });
    expect(durability.getSessionCheckpoint('failed-a')?.session_status).toBe('orphaned');
    expect(durability.getSessionCheckpoint('failed-b')?.session_status).toBe('orphaned');
  });

  it('atomically closes a pre-init failure by row and conversation identity', () => {
    const rowId = insertAgentRow(db, null, 'active', 'preinit-key');
    durability.beginFreshSessionCheckpoint('preinit-key', 919);

    durability.closeSessionLifecycleFailure({
      agentSessionRowId: rowId,
      providerSessionId: null,
      provider: 'claude-cli',
      conversationKey: 'preinit-key',
      agentStatus: 'crashed',
    });

    expect(agentRow(db, rowId).status).toBe('crashed');
    expect(durability.getSessionCheckpoint('preinit-key')?.session_status).toBe('orphaned');
  });

  it('rolls back the agent failure state when exact checkpoint closure fails', () => {
    const rowId = insertAgentRow(db, 'fault-close-session', 'active', 'fault-close');
    durability.upsertSessionCheckpoint('fault-close', {
      sessionId: 'fault-close-session',
      sessionStatus: 'active',
    });
    db.raw.exec(`
      CREATE TRIGGER deny_failure_checkpoint
      BEFORE UPDATE ON session_checkpoints
      WHEN NEW.session_status = 'orphaned' AND OLD.session_id = 'fault-close-session'
      BEGIN
        SELECT RAISE(ABORT, 'failure checkpoint fault');
      END;
    `);

    expect(() => durability.closeSessionLifecycleFailure({
      agentSessionRowId: rowId,
      providerSessionId: 'fault-close-session',
      provider: 'claude-cli',
      conversationKey: 'fault-close',
      agentStatus: 'crashed',
    })).toThrow(/failure checkpoint fault/i);

    expect(agentRow(db, rowId)).toMatchObject({ status: 'active' });
    expect(durability.getSessionCheckpoint('fault-close')?.session_status).toBe('active');
  });

  it('persists graceful closure atomically only after termination has succeeded', () => {
    const rowId = insertAgentRow(db, 'graceful-session', 'active', 'graceful-a');
    durability.upsertSessionCheckpoint('graceful-a', {
      sessionId: 'graceful-session',
      sessionStatus: 'active',
    });

    durability.closeSessionLifecycle({
      agentSessionRowId: rowId,
      providerSessionId: 'graceful-session',
      provider: 'claude-cli',
      conversationKey: 'graceful-a',
      status: 'suspended',
    });

    expect(agentRow(db, rowId)).toMatchObject({ status: 'suspended', ended_at: null });
    expect(durability.getSessionCheckpoint('graceful-a')?.session_status).toBe('suspended');
  });

  it('rejects a foreign-provider reactivation without changing row or checkpoint bytes', () => {
    const rowId = insertAgentRow(db, 'foreign-resume-session', 'suspended', 'foreign-resume');
    durability.upsertSessionCheckpoint('foreign-resume', {
      sessionId: 'foreign-resume-session',
      sessionStatus: 'suspended',
      claudePid: 101,
    });
    const beforeRow = agentRow(db, rowId);
    const beforeCheckpoint = durability.getSessionCheckpoint('foreign-resume');

    expect(() => durability.reactivateSessionLifecycle({
      agentSessionRowId: rowId,
      providerSessionId: 'foreign-resume-session',
      provider: 'opencode-cli',
      pid: 929,
    })).toThrow(/provider|resumable|exact/i);

    expect(agentRow(db, rowId)).toEqual(beforeRow);
    expect(durability.getSessionCheckpoint('foreign-resume')).toEqual(beforeCheckpoint);
  });

  it('rejects foreign-provider failure and graceful closes without checkpoint mutation', () => {
    const failureRow = insertAgentRow(db, 'foreign-failure-session', 'active', 'foreign-failure');
    durability.upsertSessionCheckpoint('foreign-failure', {
      sessionId: 'foreign-failure-session',
      sessionStatus: 'active',
    });
    const gracefulRow = insertAgentRow(db, 'foreign-graceful-session', 'active', 'foreign-graceful');
    durability.upsertSessionCheckpoint('foreign-graceful', {
      sessionId: 'foreign-graceful-session',
      sessionStatus: 'active',
    });
    const failureBefore = agentRow(db, failureRow);
    const failureCheckpointBefore = durability.getSessionCheckpoint('foreign-failure');
    const gracefulBefore = agentRow(db, gracefulRow);
    const gracefulCheckpointBefore = durability.getSessionCheckpoint('foreign-graceful');

    expect(() => durability.closeSessionLifecycleFailure({
      agentSessionRowId: failureRow,
      providerSessionId: 'foreign-failure-session',
      provider: 'opencode-cli',
      conversationKey: 'foreign-failure',
      agentStatus: 'crashed',
    })).toThrow(/provider|exact|failed/i);
    expect(() => durability.closeSessionLifecycle({
      agentSessionRowId: gracefulRow,
      providerSessionId: 'foreign-graceful-session',
      provider: 'opencode-cli',
      conversationKey: 'foreign-graceful',
      status: 'suspended',
    })).toThrow(/provider|exact|closed/i);

    expect(agentRow(db, failureRow)).toEqual(failureBefore);
    expect(durability.getSessionCheckpoint('foreign-failure')).toEqual(failureCheckpointBefore);
    expect(agentRow(db, gracefulRow)).toEqual(gracefulBefore);
    expect(durability.getSessionCheckpoint('foreign-graceful')).toEqual(gracefulCheckpointBefore);
  });
});
