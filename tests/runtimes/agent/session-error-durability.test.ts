import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/mock/home'),
  userInfo: vi.fn(() => ({ username: 'testuser' })),
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => ''),
}));
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('../../../src/runtimes/agent/process-tree.ts', () => ({
  killSessionTree: vi.fn(async () => undefined),
}));

import { spawn } from 'node:child_process';
import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import type { Messenger } from '../../../src/core/types.ts';
import { SessionManager } from '../../../src/runtimes/agent/session.ts';
import { OpenAIApiProvider } from '../../../src/runtimes/agent/providers/openai-api.ts';
import { killSessionTree } from '../../../src/runtimes/agent/process-tree.ts';

const CHAT_JID = '15550171@s.whatsapp.net';
const CONVERSATION_KEY = '15550171';

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  };
}

function makeChild(pid: number) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  };
  child.pid = pid;
  child.stdin = Object.assign(new EventEmitter(), {
    write: vi.fn((_data: unknown, encoding?: unknown, callback?: (err?: Error | null) => void) => {
      if (typeof encoding === 'function') encoding();
      else callback?.();
      return true;
    }),
    end: vi.fn(),
  });
  child.stdout = new EventEmitter();
  (child.stdout as unknown as { setEncoding: () => void }).setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

function rowStatus(db: Database, rowId: number): string | undefined {
  return (db.raw.prepare('SELECT status FROM agent_sessions WHERE id = ?').get(rowId) as
    { status: string } | undefined)?.status;
}

function lifecycleRow(
  db: Database,
  sessionId: string | null,
  status: string,
  conversationKey = CONVERSATION_KEY,
  provider: string | null = 'claude-cli',
): number {
  const result = db.raw.prepare(
    `INSERT INTO agent_sessions (
       session_id, claude_pid, started_in_directory, chat_jid, workspace_key,
       started_at, status, provider
     ) VALUES (?, 0, '/mock/home', ?, ?, datetime('now'), ?, ?)`,
  ).run(sessionId, CHAT_JID, conversationKey, status, provider);
  return Number(result.lastInsertRowid);
}

function resumeStateSnapshot(db: Database): unknown {
  return {
    agentSessions: db.raw.prepare(
      `SELECT id, session_id, claude_pid, workspace_key, status, provider, ended_at
       FROM agent_sessions ORDER BY id`,
    ).all(),
    checkpoints: db.raw.prepare(
      `SELECT conversation_key, session_id, claude_pid, session_status,
              checkpoint_version, updated_at
       FROM session_checkpoints ORDER BY conversation_key`,
    ).all(),
  };
}

describe('SessionManager durable error lifecycle', () => {
  let db: Database;
  let durability: DurabilityEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    db = new Database(':memory:');
    db.open();
    durability = new DurabilityEngine(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it.each([
    ['ENOENT', Object.assign(new Error('missing claude'), { code: 'ENOENT' })],
    ['generic', Object.assign(new Error('spawn denied'), { code: 'EACCES' })],
  ])('closes persistent-session rows and checkpoints on %s spawn error', async (_label, error) => {
    const child = makeChild(17101);
    vi.mocked(spawn).mockReturnValue(child as never);
    const sm = new SessionManager({
      db,
      messenger: makeMessenger(),
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      onCrash: vi.fn(),
    });
    sm.setDurability(durability);

    await sm.spawnSession();
    const rowId = sm.getDbRowId();
    if (rowId === null) throw new Error('persistent session row was not created');
    child.emit('error', error);

    expect(rowStatus(db, rowId)).toBe('crashed');
    expect(durability.getSessionCheckpoint(CONVERSATION_KEY)?.session_status).toBe('orphaned');

    await sm.shutdown(true);

    expect(rowStatus(db, rowId)).toBe('crashed');
    expect(durability.getSessionCheckpoint(CONVERSATION_KEY)?.session_status).toBe('orphaned');

    await sm.shutdown(false);

    expect(rowStatus(db, rowId)).toBe('crashed');
    expect(durability.getSessionCheckpoint(CONVERSATION_KEY)?.session_status).toBe('orphaned');
  });

  it('keeps a persistent abnormal exit crashed and orphaned through cleanup shutdown', async () => {
    const child = makeChild(17104);
    vi.mocked(spawn).mockReturnValue(child as never);
    const sm = new SessionManager({
      db,
      messenger: makeMessenger(),
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      onCrash: vi.fn(),
    });
    sm.setDurability(durability);

    await sm.spawnSession();
    const rowId = sm.getDbRowId();
    if (rowId === null) throw new Error('persistent session row was not created');
    child.emit('exit', 7, null);

    expect(rowStatus(db, rowId)).toBe('crashed');
    expect(durability.getSessionCheckpoint(CONVERSATION_KEY)?.session_status).toBe('orphaned');

    await sm.shutdown(true);

    expect(rowStatus(db, rowId)).toBe('crashed');
    expect(durability.getSessionCheckpoint(CONVERSATION_KEY)?.session_status).toBe('orphaned');
  });

  it('keeps a rejected persistent resume failed and orphaned through cleanup shutdown', async () => {
    const existingRowId = lifecycleRow(
      db,
      'expired-provider-session',
      'suspended',
    );
    durability.upsertSessionCheckpoint(CONVERSATION_KEY, {
      sessionId: 'expired-provider-session',
      sessionStatus: 'active',
    });
    const child = makeChild(17105);
    vi.mocked(spawn).mockReturnValue(child as never);
    const sm = new SessionManager({
      db,
      messenger: makeMessenger(),
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      onResumeFailed: vi.fn(),
    });
    sm.setDurability(durability);

    await sm.spawnSession('expired-provider-session', existingRowId);
    const rowId = sm.getDbRowId();
    if (rowId === null) throw new Error('resumed session row was not created');
    child.emit('exit', 1, null);

    expect(rowStatus(db, rowId)).toBe('resume_failed');
    expect(durability.getSessionCheckpoint(CONVERSATION_KEY)?.session_status).toBe('orphaned');

    await sm.shutdown(true);

    expect(rowStatus(db, rowId)).toBe('resume_failed');
    expect(durability.getSessionCheckpoint(CONVERSATION_KEY)?.session_status).toBe('orphaned');
  });

  it.each([
    ['ENOENT', Object.assign(new Error('missing opencode'), { code: 'ENOENT' })],
    ['generic', Object.assign(new Error('spawn denied'), { code: 'EACCES' })],
  ])('closes spawn-per-turn rows and checkpoints on %s spawn error', async (_label, error) => {
    const child = makeChild(17102);
    vi.mocked(spawn).mockReturnValue(child as never);
    const sm = new SessionManager({
      db,
      messenger: makeMessenger(),
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      onCrash: vi.fn(),
      provider: 'opencode-cli',
      model: 'glm/test-model',
    });
    sm.setDurability(durability);

    await sm.spawnSession();
    const rowId = sm.getDbRowId();
    if (rowId === null) throw new Error('spawn-per-turn session row was not created');
    await sm.sendTurn('hello');
    child.emit('error', error);

    expect(rowStatus(db, rowId)).toBe('crashed');
    expect(durability.getSessionCheckpoint(CONVERSATION_KEY)?.session_status).toBe('orphaned');

    await sm.shutdown(true);

    expect(rowStatus(db, rowId)).toBe('crashed');
    expect(durability.getSessionCheckpoint(CONVERSATION_KEY)?.session_status).toBe('orphaned');
  });

  it('closes spawn-per-turn rows and checkpoints on abnormal exit', async () => {
    const child = makeChild(17103);
    vi.mocked(spawn).mockReturnValue(child as never);
    const sm = new SessionManager({
      db,
      messenger: makeMessenger(),
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      onCrash: vi.fn(),
      provider: 'opencode-cli',
      model: 'glm/test-model',
    });
    sm.setDurability(durability);

    await sm.spawnSession();
    const rowId = sm.getDbRowId();
    if (rowId === null) throw new Error('spawn-per-turn session row was not created');
    await sm.sendTurn('hello');
    child.emit('exit', 7, null);
    child.emit('close', 7, null);
    await new Promise((resolve) => setImmediate(resolve));

    expect(rowStatus(db, rowId)).toBe('crashed');
    expect(durability.getSessionCheckpoint(CONVERSATION_KEY)?.session_status).toBe('orphaned');

    await sm.shutdown(true);

    expect(rowStatus(db, rowId)).toBe('crashed');
    expect(durability.getSessionCheckpoint(CONVERSATION_KEY)?.session_status).toBe('orphaned');
  });

  it('keeps a managed-provider turn failure crashed and orphaned through cleanup shutdown', async () => {
    vi.spyOn(OpenAIApiProvider.prototype, 'sendTurn')
      .mockRejectedValue(new Error('managed turn failed'));
    const sm = new SessionManager({
      db,
      messenger: makeMessenger(),
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      onCrash: vi.fn(),
      provider: 'openai-api',
    });
    sm.setDurability(durability);

    await sm.spawnSession();
    const rowId = sm.getDbRowId();
    if (rowId === null) throw new Error('managed provider session row was not created');
    await expect(sm.sendTurn('hello')).rejects.toThrow('managed turn failed');

    expect(rowStatus(db, rowId)).toBe('crashed');
    expect(durability.getSessionCheckpoint(CONVERSATION_KEY)?.session_status).toBe('orphaned');

    await sm.shutdown(true);

    expect(rowStatus(db, rowId)).toBe('crashed');
    expect(durability.getSessionCheckpoint(CONVERSATION_KEY)?.session_status).toBe('orphaned');
  });

  it('kills and waits for a persistent child when atomic fresh persistence fails', async () => {
    const child = makeChild(17106);
    vi.mocked(spawn).mockReturnValue(child as never);
    vi.mocked(killSessionTree).mockImplementationOnce(async () => {
      child.exitCode = 1;
      child.emit('exit', 1, 'SIGKILL');
    });
    db.raw.exec(`
      CREATE TRIGGER deny_session_begin
      BEFORE INSERT ON session_checkpoints
      WHEN NEW.conversation_key = '${CONVERSATION_KEY}'
      BEGIN
        SELECT RAISE(ABORT, 'checkpoint begin fault');
      END;
    `);
    const sm = new SessionManager({
      db,
      messenger: makeMessenger(),
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
    });
    sm.setDurability(durability);

    await expect(sm.spawnSession()).rejects.toThrow(/checkpoint begin fault/i);

    expect(killSessionTree).toHaveBeenCalled();
    expect(sm.getStatus()).toMatchObject({ active: false, pid: null });
    expect(sm.getDbRowId()).toBeNull();
    expect(db.raw.prepare(
      `SELECT COUNT(*) AS n FROM agent_sessions WHERE workspace_key = ?`,
    ).get(CONVERSATION_KEY)).toEqual({ n: 0 });
    expect(durability.getSessionCheckpoint(CONVERSATION_KEY)).toBeUndefined();
  });

  it.each(['openai-api', 'anthropic-api'] as const)(
    'fully resets a %s manager when atomic fresh persistence fails',
    async (provider) => {
      db.raw.exec(`
        CREATE TRIGGER deny_managed_session_begin
        BEFORE INSERT ON session_checkpoints
        WHEN NEW.conversation_key = '${CONVERSATION_KEY}'
        BEGIN
          SELECT RAISE(ABORT, 'managed checkpoint fault');
        END;
      `);
      const initialize = vi.spyOn(OpenAIApiProvider.prototype, 'initialize');
      const sm = new SessionManager({
        db,
        messenger: makeMessenger(),
        chatJid: CHAT_JID,
        onEvent: vi.fn(),
        provider,
      });
      sm.setDurability(durability);

      await expect(sm.spawnSession()).rejects.toThrow(/managed checkpoint fault/i);

      expect(sm.getStatus()).toMatchObject({ active: false, sessionId: null });
      expect(sm.getDbRowId()).toBeNull();
      expect(db.raw.prepare(
        `SELECT COUNT(*) AS n FROM agent_sessions WHERE workspace_key = ?`,
      ).get(CONVERSATION_KEY)).toEqual({ n: 0 });
      if (provider === 'openai-api') expect(initialize).not.toHaveBeenCalled();
    },
  );

  it('fully resets a spawn-per-turn manager when atomic fresh persistence fails', async () => {
    db.raw.exec(`
      CREATE TRIGGER deny_spawn_per_turn_begin
      BEFORE INSERT ON session_checkpoints
      WHEN NEW.conversation_key = '${CONVERSATION_KEY}'
      BEGIN
        SELECT RAISE(ABORT, 'spawn-per-turn checkpoint fault');
      END;
    `);
    const sm = new SessionManager({
      db,
      messenger: makeMessenger(),
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'opencode-cli',
    });
    sm.setDurability(durability);

    await expect(sm.spawnSession()).rejects.toThrow(/spawn-per-turn checkpoint fault/i);

    expect(sm.getStatus()).toMatchObject({ active: false, sessionId: null });
    expect(sm.getDbRowId()).toBeNull();
    expect(db.raw.prepare(
      `SELECT COUNT(*) AS n FROM agent_sessions WHERE workspace_key = ?`,
    ).get(CONVERSATION_KEY)).toEqual({ n: 0 });
  });

  it('records crash/orphan atomically and preserves the child handle when termination fails', async () => {
    const child = makeChild(17107);
    vi.mocked(spawn).mockReturnValue(child as never);
    const sm = new SessionManager({
      db,
      messenger: makeMessenger(),
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
    });
    sm.setDurability(durability);
    await sm.spawnSession();
    const rowId = sm.getDbRowId();
    if (rowId === null) throw new Error('persistent session row was not created');
    (sm as unknown as { handleProviderEvent(event: { type: 'init'; sessionId: string }): void })
      .handleProviderEvent({ type: 'init', sessionId: 'shutdown-fault-session' });
    vi.mocked(killSessionTree).mockRejectedValueOnce(new Error('tree termination failed'));

    await expect(sm.shutdown(true)).rejects.toThrow(/tree termination failed/i);

    expect(rowStatus(db, rowId)).toBe('crashed');
    expect(durability.getSessionCheckpoint(CONVERSATION_KEY)?.session_status).toBe('orphaned');
    expect(sm.getStatus()).toMatchObject({
      active: false,
      pid: 17107,
      durableFailureClosed: true,
    });
    expect(sm.getDbRowId()).toBe(rowId);
  });

  it('does not persist graceful state until child termination succeeds', async () => {
    const child = makeChild(17109);
    vi.mocked(spawn).mockReturnValue(child as never);
    let finishTermination: (() => void) | null = null;
    vi.mocked(killSessionTree).mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishTermination = resolve;
    }));
    const sm = new SessionManager({
      db,
      messenger: makeMessenger(),
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
    });
    sm.setDurability(durability);
    await sm.spawnSession();
    const rowId = sm.getDbRowId();
    if (rowId === null) throw new Error('persistent session row was not created');

    const shuttingDown = sm.shutdown(true);
    await Promise.resolve();

    expect(rowStatus(db, rowId)).toBe('active');
    expect(durability.getSessionCheckpoint(CONVERSATION_KEY)?.session_status).toBe('active');

    const release = finishTermination as (() => void) | null;
    if (release === null) throw new Error('termination was not started');
    release();
    await shuttingDown;

    expect(rowStatus(db, rowId)).toBe('suspended');
    expect(durability.getSessionCheckpoint(CONVERSATION_KEY)?.session_status).toBe('suspended');
  });

  it('rolls back graceful state atomically after termination when checkpoint closure fails', async () => {
    const child = makeChild(17110);
    vi.mocked(spawn).mockReturnValue(child as never);
    const sm = new SessionManager({
      db,
      messenger: makeMessenger(),
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
    });
    sm.setDurability(durability);
    await sm.spawnSession();
    const rowId = sm.getDbRowId();
    if (rowId === null) throw new Error('persistent session row was not created');
    db.raw.exec(`
      CREATE TRIGGER deny_graceful_checkpoint
      BEFORE UPDATE ON session_checkpoints
      WHEN NEW.session_status = 'suspended'
      BEGIN
        SELECT RAISE(ABORT, 'graceful checkpoint fault');
      END;
    `);

    await expect(sm.shutdown(true)).rejects.toThrow(/graceful checkpoint fault/i);

    expect(sm.getStatus()).toMatchObject({ active: false, pid: null });
    expect(sm.getDbRowId()).toBe(rowId);
    expect(rowStatus(db, rowId)).toBe('active');
    expect(durability.getSessionCheckpoint(CONVERSATION_KEY)?.session_status).toBe('active');

    db.raw.exec('DROP TRIGGER deny_graceful_checkpoint');
    await sm.shutdown(true);
    expect(rowStatus(db, rowId)).toBe('suspended');
    expect(durability.getSessionCheckpoint(CONVERSATION_KEY)?.session_status).toBe('suspended');
  });

  it('keeps the managed provider handle when its shutdown fails', async () => {
    vi.spyOn(OpenAIApiProvider.prototype, 'initialize').mockImplementation(async (opts) => {
      opts.onEvent({ type: 'init', sessionId: 'managed-shutdown-fault' });
    });
    vi.spyOn(OpenAIApiProvider.prototype, 'shutdown')
      .mockRejectedValue(new Error('managed shutdown failed'));
    const sm = new SessionManager({
      db,
      messenger: makeMessenger(),
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'openai-api',
    });
    sm.setDurability(durability);
    await sm.spawnSession();
    const rowId = sm.getDbRowId();
    if (rowId === null) throw new Error('managed session row was not created');

    await expect(sm.shutdown(true)).rejects.toThrow(/managed shutdown failed/i);

    expect(rowStatus(db, rowId)).toBe('crashed');
    expect(durability.getSessionCheckpoint(CONVERSATION_KEY)?.session_status).toBe('orphaned');
    expect(sm.getStatus()).toMatchObject({ active: false, durableFailureClosed: true });
    expect((sm as unknown as { managedProviderSession: unknown }).managedProviderSession)
      .toBeInstanceOf(OpenAIApiProvider);
    expect(sm.getDbRowId()).toBe(rowId);
  });

  it('wires a supplied OpenCode resume ID into the first spawned turn', async () => {
    const rowId = lifecycleRow(
      db,
      'opencode-resume-id',
      'suspended',
      CONVERSATION_KEY,
      'opencode-cli',
    );
    durability.upsertSessionCheckpoint(CONVERSATION_KEY, {
      sessionId: 'opencode-resume-id',
      sessionStatus: 'suspended',
    });
    const child = makeChild(17108);
    vi.mocked(spawn).mockReturnValue(child as never);
    const sm = new SessionManager({
      db,
      messenger: makeMessenger(),
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'opencode-cli',
      model: 'glm/test-model',
    });
    sm.setDurability(durability);

    await sm.spawnSession('opencode-resume-id', rowId);
    await sm.sendTurn('continue');

    const args = vi.mocked(spawn).mock.calls.at(-1)?.[1] as string[];
    expect(args).toContain('--session');
    expect(args).toContain('opencode-resume-id');
    expect(rowStatus(db, rowId)).toBe('active');
  });

  it.each([
    {
      name: 'foreign provider row',
      setup: (database: Database, engine: DurabilityEngine) => {
        const rowId = lifecycleRow(
          database,
          'foreign-provider-resume',
          'suspended',
          CONVERSATION_KEY,
          'opencode-cli',
        );
        engine.upsertSessionCheckpoint(CONVERSATION_KEY, {
          sessionId: 'foreign-provider-resume',
          sessionStatus: 'suspended',
        });
        return { rowId, sessionId: 'foreign-provider-resume', retire: true };
      },
    },
    {
      name: 'legacy null-provider persisted ID',
      setup: (database: Database, engine: DurabilityEngine) => {
        const rowId = lifecycleRow(
          database,
          'legacy-provider-resume',
          'suspended',
          CONVERSATION_KEY,
          null,
        );
        engine.upsertSessionCheckpoint(CONVERSATION_KEY, {
          sessionId: 'legacy-provider-resume',
          sessionStatus: 'suspended',
        });
        return { rowId, sessionId: 'legacy-provider-resume', retire: false };
      },
    },
    {
      name: 'cross-provider duplicate opaque ID',
      setup: (database: Database, engine: DurabilityEngine) => {
        const rowId = lifecycleRow(
          database,
          'duplicate-provider-resume',
          'suspended',
          CONVERSATION_KEY,
          'claude-cli',
        );
        lifecycleRow(
          database,
          'duplicate-provider-resume',
          'orphaned',
          CONVERSATION_KEY,
          'opencode-cli',
        );
        engine.upsertSessionCheckpoint(CONVERSATION_KEY, {
          sessionId: 'duplicate-provider-resume',
          sessionStatus: 'suspended',
        });
        return { rowId, sessionId: 'duplicate-provider-resume', retire: false };
      },
    },
    {
      name: 'conversation mismatch',
      setup: (database: Database, engine: DurabilityEngine) => {
        const rowId = lifecycleRow(
          database,
          'conversation-provider-resume',
          'suspended',
          'different-conversation',
          'claude-cli',
        );
        engine.upsertSessionCheckpoint('different-conversation', {
          sessionId: 'conversation-provider-resume',
          sessionStatus: 'suspended',
        });
        return { rowId, sessionId: 'conversation-provider-resume', retire: false };
      },
    },
    {
      name: 'missing exact checkpoint',
      setup: (database: Database) => ({
        rowId: lifecycleRow(
          database,
          'missing-checkpoint-resume',
          'suspended',
          CONVERSATION_KEY,
          'claude-cli',
        ),
        sessionId: 'missing-checkpoint-resume',
        retire: false,
      }),
    },
  ])('rejects $name before child spawn with the required lifecycle disposition', async ({ setup }) => {
    const { rowId, sessionId, retire } = setup(db, durability);
    const before = resumeStateSnapshot(db);
    const child = makeChild(17120);
    vi.mocked(spawn).mockReturnValue(child as never);
    vi.mocked(killSessionTree).mockImplementationOnce(async () => {
      child.exitCode = 1;
      child.emit('exit', 1, 'SIGKILL');
    });
    const sm = new SessionManager({
      db,
      messenger: makeMessenger(),
      chatJid: CHAT_JID,
      onEvent: vi.fn(),
      provider: 'claude-cli',
    });
    sm.setDurability(durability);

    await expect(sm.spawnSession(sessionId, rowId)).rejects.toThrow(
      /provider|ownership|ambiguous|resumable|conversation|checkpoint/i,
    );

    expect(spawn).not.toHaveBeenCalled();
    expect(killSessionTree).not.toHaveBeenCalled();
    if (retire) {
      expect(rowStatus(db, rowId)).toBe('ended');
      expect(durability.getSessionCheckpoint(CONVERSATION_KEY)?.session_status).toBe('ended');
    } else {
      expect(resumeStateSnapshot(db)).toEqual(before);
    }
    expect(sm.getStatus()).toMatchObject({ active: false, sessionId: null });
    expect(sm.getDbRowId()).toBeNull();
  });
});
