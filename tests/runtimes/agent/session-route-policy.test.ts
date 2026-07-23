import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import type { Messenger } from '../../../src/core/types.ts';
import {
  PROVIDER_DATA_POLICY_VERSION,
  ProviderDataPolicyError,
  resolveProviderRoutePolicy,
} from '../../../src/core/provider-data-policy.ts';
import { SessionManager } from '../../../src/runtimes/agent/session.ts';
import { OpenAIApiProvider } from '../../../src/runtimes/agent/providers/openai-api.ts';

function messenger(): Messenger {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  };
}

const route = resolveProviderRoutePolicy({
  provider: 'openai-api',
  model: 'gpt-5',
  dataPolicy: 'restricted',
  boundaryMode: 'enforce',
});

describe('SessionManager route policy admission', () => {
  let db: Database;
  let durability: DurabilityEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    durability = new DurabilityEngine(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it('reports a compatible enforced boundary only while the restricted managed session is active', async () => {
    vi.spyOn(OpenAIApiProvider.prototype, 'initialize').mockResolvedValue(undefined);
    const enforced = new SessionManager({
      db,
      messenger: messenger(),
      chatJid: '15550200@s.whatsapp.net',
      onEvent: vi.fn(),
      provider: 'openai-api',
      model: 'gpt-5',
      routePolicy: route,
      providerBoundaryMode: 'enforce',
    });

    expect(enforced.hasCompatibleEnforcedProviderDataBoundary()).toBe(false);
    await enforced.spawnSession();
    expect(enforced.hasCompatibleEnforcedProviderDataBoundary()).toBe(true);

    const shadow = new SessionManager({
      db,
      messenger: messenger(),
      chatJid: '15550209@s.whatsapp.net',
      onEvent: vi.fn(),
      provider: 'openai-api',
      model: 'gpt-5',
      routePolicy: route,
      providerBoundaryMode: 'shadow',
    });
    await shadow.spawnSession();
    expect(shadow.hasCompatibleEnforcedProviderDataBoundary()).toBe(false);
  });

  it('threads the exact frozen tuple into provider session options and checkpoint metadata', async () => {
    const initialize = vi.spyOn(OpenAIApiProvider.prototype, 'initialize').mockResolvedValue(undefined);
    const sm = new SessionManager({
      db,
      messenger: messenger(),
      chatJid: '15550201@s.whatsapp.net',
      onEvent: vi.fn(),
      provider: 'openai-api',
      model: 'gpt-5',
      routePolicy: route,
      providerBoundaryMode: 'enforce',
      providerBoundaryRouteSource: 'fallback',
    });
    sm.setDurability(durability);

    await sm.spawnSession();

    expect(sm.getRoutePolicy()).toBe(route);
    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({
      routePolicy: route,
      providerBoundaryMode: 'enforce',
      providerSessionId: expect.stringMatching(/^openai-api-[0-9a-f-]{36}$/),
      providerDataBoundary: expect.objectContaining({
        binding: expect.objectContaining({
          provider: 'openai-api',
          model: 'gpt-5',
          dataPolicy: 'restricted',
          policyVersion: PROVIDER_DATA_POLICY_VERSION,
          providerSessionId: expect.stringMatching(/^openai-api-[0-9a-f-]{36}$/),
        }),
        mode: 'enforce',
      }),
    }));
    const initialized = initialize.mock.calls[0]![0];
    expect(initialized.providerDataBoundary?.binding.providerSessionId)
      .toBe(initialized.providerSessionId);
    const checkpoint = durability.getSessionCheckpoint('15550201');
    expect(JSON.parse(checkpoint?.watchdog_state ?? '')).toEqual({
      providerRoutePolicy: {
        provider: 'openai-api',
        model: 'gpt-5',
        dataPolicy: 'restricted',
        policyVersion: PROVIDER_DATA_POLICY_VERSION,
      },
    });
  });

  it('retires a newly constructed broker when durable lifecycle admission fails', async () => {
    db.raw.exec(`
      CREATE TRIGGER deny_boundary_session_insert
      BEFORE INSERT ON agent_sessions
      BEGIN
        SELECT RAISE(ABORT, 'synthetic boundary admission failure');
      END;
    `);
    const boundaryEvents: Array<{ eventType: string }> = [];
    const initialize = vi.spyOn(OpenAIApiProvider.prototype, 'initialize').mockResolvedValue(undefined);
    const sm = new SessionManager({
      db,
      messenger: messenger(),
      chatJid: '15550202@s.whatsapp.net',
      onEvent: vi.fn(),
      provider: 'openai-api',
      model: 'gpt-5',
      routePolicy: route,
      providerBoundaryMode: 'enforce',
      providerBoundaryRouteSource: 'default',
      providerBoundaryEventSink: (event) => boundaryEvents.push(event),
    });

    await expect(sm.spawnSession()).rejects.toThrow(/synthetic boundary admission failure/);

    expect(initialize).not.toHaveBeenCalled();
    expect(boundaryEvents).toContainEqual(expect.objectContaining({ eventType: 'success', success: 1 }));
  });

  it('preserves existing checkpoint watchdog state when adding route policy metadata', async () => {
    durability.upsertSessionCheckpoint('15550203', {
      watchdogState: JSON.stringify({ lastProbeAt: 123, nested: { healthy: true } }),
    });
    vi.spyOn(OpenAIApiProvider.prototype, 'initialize').mockResolvedValue(undefined);
    const sm = new SessionManager({
      db,
      messenger: messenger(),
      chatJid: '15550203@s.whatsapp.net',
      onEvent: vi.fn(),
      provider: 'openai-api',
      model: 'gpt-5',
      routePolicy: route,
    });
    sm.setDurability(durability);

    await sm.spawnSession();

    expect(JSON.parse(durability.getSessionCheckpoint('15550203')?.watchdog_state ?? '')).toEqual({
      lastProbeAt: 123,
      nested: { healthy: true },
      providerRoutePolicy: {
        provider: 'openai-api',
        model: 'gpt-5',
        dataPolicy: 'restricted',
        policyVersion: PROVIDER_DATA_POLICY_VERSION,
      },
    });
  });

  it.each([
    {
      name: 'missing metadata',
      watchdogState: null,
    },
    {
      name: 'provider mismatch',
      watchdogState: JSON.stringify({
        providerRoutePolicy: {
          provider: 'anthropic-api',
          model: 'gpt-5',
          dataPolicy: 'restricted',
          policyVersion: PROVIDER_DATA_POLICY_VERSION,
        },
      }),
    },
    {
      name: 'model mismatch',
      watchdogState: JSON.stringify({
        providerRoutePolicy: {
          provider: 'openai-api',
          model: 'gpt-4.1',
          dataPolicy: 'restricted',
          policyVersion: PROVIDER_DATA_POLICY_VERSION,
        },
      }),
    },
    {
      name: 'policy mismatch',
      watchdogState: JSON.stringify({
        providerRoutePolicy: {
          provider: 'openai-api',
          model: 'gpt-5',
          dataPolicy: 'trusted',
          policyVersion: PROVIDER_DATA_POLICY_VERSION,
        },
      }),
    },
    {
      name: 'version mismatch',
      watchdogState: JSON.stringify({
        providerRoutePolicy: {
          provider: 'openai-api',
          model: 'gpt-5',
          dataPolicy: 'restricted',
          policyVersion: 'provider-data-policy-v0',
        },
      }),
    },
  ])('retires a resume checkpoint with $name before provider admission', async ({ watchdogState }) => {
    const sessionId = `policy-resume-${Math.random()}`;
    const inserted = db.raw.prepare(
      `INSERT INTO agent_sessions (
         session_id, claude_pid, started_in_directory, chat_jid, workspace_key,
         started_at, status, provider
       ) VALUES (?, 0, '/tmp', '15550202@s.whatsapp.net', '15550202',
         datetime('now'), 'suspended', 'openai-api')`,
    ).run(sessionId);
    const rowId = Number(inserted.lastInsertRowid);
    durability.upsertSessionCheckpoint('15550202', {
      sessionId,
      sessionStatus: 'suspended',
      ...(watchdogState === null ? {} : { watchdogState }),
    });
    const initialize = vi.spyOn(OpenAIApiProvider.prototype, 'initialize');
    const sm = new SessionManager({
      db,
      messenger: messenger(),
      chatJid: '15550202@s.whatsapp.net',
      onEvent: vi.fn(),
      provider: 'openai-api',
      model: 'gpt-5',
      routePolicy: route,
    });
    sm.setDurability(durability);

    await expect(sm.spawnSession(sessionId, rowId)).rejects.toBeInstanceOf(ProviderDataPolicyError);
    expect(initialize).not.toHaveBeenCalled();
    expect(db.raw.prepare('SELECT status FROM agent_sessions WHERE id = ?').get(rowId))
      .toEqual({ status: 'ended' });
    expect(durability.getSessionCheckpoint('15550202')?.session_status).toBe('ended');
  });

  it('does not retire unrelated workspaces when route-policy rejection shares a session ID', async () => {
    const sessionId = 'duplicate-route-policy-resume';
    const insert = db.raw.prepare(
      `INSERT INTO agent_sessions (
         session_id, claude_pid, started_in_directory, chat_jid, workspace_key,
         started_at, status, provider
       ) VALUES (?, 0, '/tmp', ?, ?, datetime('now'), 'suspended', 'openai-api')`,
    );
    const currentRowId = Number(insert.run(
      sessionId,
      '15550215@s.whatsapp.net',
      '15550215',
    ).lastInsertRowid);
    const otherRowId = Number(insert.run(
      sessionId,
      '15550216@s.whatsapp.net',
      '15550216',
    ).lastInsertRowid);
    const mismatchedWatchdogState = JSON.stringify({
      providerRoutePolicy: {
        provider: 'openai-api',
        model: 'gpt-4.1',
        dataPolicy: 'restricted',
        policyVersion: PROVIDER_DATA_POLICY_VERSION,
      },
    });
    durability.upsertSessionCheckpoint('15550215', {
      sessionId,
      sessionStatus: 'suspended',
      watchdogState: mismatchedWatchdogState,
    });
    durability.upsertSessionCheckpoint('15550216', {
      sessionId,
      sessionStatus: 'suspended',
      watchdogState: mismatchedWatchdogState,
    });
    const sm = new SessionManager({
      db,
      messenger: messenger(),
      chatJid: '15550215@s.whatsapp.net',
      onEvent: vi.fn(),
      provider: 'openai-api',
      model: 'gpt-5',
      routePolicy: route,
    });
    sm.setDurability(durability);

    await expect(sm.spawnSession(sessionId)).rejects.toBeInstanceOf(ProviderDataPolicyError);
    expect(db.raw.prepare('SELECT id, status FROM agent_sessions WHERE session_id = ? ORDER BY id')
      .all(sessionId)).toEqual([
      { id: currentRowId, status: 'suspended' },
      { id: otherRowId, status: 'suspended' },
    ]);
    expect(durability.getSessionCheckpoint('15550215')?.session_status).toBe('suspended');
    expect(durability.getSessionCheckpoint('15550216')?.session_status).toBe('suspended');
  });

  it('preserves ProviderDataPolicyError when route-policy retirement fails', async () => {
    const sessionId = 'route-policy-retirement-failure';
    const inserted = db.raw.prepare(
      `INSERT INTO agent_sessions (
         session_id, claude_pid, started_in_directory, chat_jid, workspace_key,
         started_at, status, provider
       ) VALUES (?, 0, '/tmp', '15550217@s.whatsapp.net', '15550217',
         datetime('now'), 'suspended', 'openai-api')`,
    ).run(sessionId);
    const rowId = Number(inserted.lastInsertRowid);
    durability.upsertSessionCheckpoint('15550217', {
      sessionId,
      sessionStatus: 'suspended',
      watchdogState: JSON.stringify({
        providerRoutePolicy: {
          provider: 'openai-api',
          model: 'gpt-4.1',
          dataPolicy: 'restricted',
          policyVersion: PROVIDER_DATA_POLICY_VERSION,
        },
      }),
    });
    const retire = vi.spyOn(durability, 'retireExactSessionLifecycle')
      .mockImplementation(() => { throw new Error('synthetic policy retirement failure'); });
    const initialize = vi.spyOn(OpenAIApiProvider.prototype, 'initialize');
    const sm = new SessionManager({
      db,
      messenger: messenger(),
      chatJid: '15550217@s.whatsapp.net',
      onEvent: vi.fn(),
      provider: 'openai-api',
      model: 'gpt-5',
      routePolicy: route,
    });
    sm.setDurability(durability);

    await expect(sm.spawnSession(sessionId)).rejects.toBeInstanceOf(ProviderDataPolicyError);
    expect(retire).toHaveBeenCalledOnce();
    expect(initialize).not.toHaveBeenCalled();
    expect(db.raw.prepare('SELECT status FROM agent_sessions WHERE id = ?').get(rowId))
      .toEqual({ status: 'suspended' });
    expect(durability.getSessionCheckpoint('15550217')?.session_status).toBe('suspended');
  });

  it('compensates a failed route-policy metadata write before provider admission', async () => {
    const metadataError = new Error('synthetic route policy metadata failure');
    vi.spyOn(durability, 'upsertSessionCheckpoint').mockImplementation(() => { throw metadataError; });
    const initialize = vi.spyOn(OpenAIApiProvider.prototype, 'initialize');
    const sm = new SessionManager({
      db,
      messenger: messenger(),
      chatJid: '15550218@s.whatsapp.net',
      onEvent: vi.fn(),
      provider: 'openai-api',
      model: 'gpt-5',
      routePolicy: route,
    });
    sm.setDurability(durability);

    await expect(sm.spawnSession()).rejects.toBe(metadataError);
    expect(initialize).not.toHaveBeenCalled();
    expect(db.raw.prepare(
      `SELECT COUNT(*) AS n FROM agent_sessions
       WHERE workspace_key = ? AND status = 'active'`,
    ).get('15550218')).toEqual({ n: 0 });
    expect(db.raw.prepare(
      `SELECT COUNT(*) AS n FROM session_checkpoints
       WHERE conversation_key = ? AND session_status = 'active'`,
    ).get('15550218')).toEqual({ n: 0 });
    expect(sm.getStatus()).toMatchObject({
      active: false,
      durableFailureClosed: true,
      durableFailureInconclusive: false,
    });
  });

  it('reports an inconclusive durable lifecycle when metadata compensation also fails', async () => {
    const metadataError = new Error('synthetic route policy metadata failure');
    vi.spyOn(durability, 'upsertSessionCheckpoint').mockImplementation(() => { throw metadataError; });
    db.raw.exec(`
      CREATE TRIGGER deny_route_policy_compensation
      BEFORE UPDATE OF status ON agent_sessions
      WHEN OLD.workspace_key = '15550219' AND NEW.status = 'crashed'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic compensation failure');
      END;
    `);
    const initialize = vi.spyOn(OpenAIApiProvider.prototype, 'initialize');
    const sm = new SessionManager({
      db,
      messenger: messenger(),
      chatJid: '15550219@s.whatsapp.net',
      onEvent: vi.fn(),
      provider: 'openai-api',
      model: 'gpt-5',
      routePolicy: route,
    });
    sm.setDurability(durability);

    await expect(sm.spawnSession()).rejects.toBe(metadataError);
    expect(initialize).not.toHaveBeenCalled();
    expect(db.raw.prepare(
      `SELECT COUNT(*) AS n FROM agent_sessions
       WHERE workspace_key = ? AND status = 'active'`,
    ).get('15550219')).toEqual({ n: 1 });
    expect(db.raw.prepare(
      `SELECT COUNT(*) AS n FROM session_checkpoints
       WHERE conversation_key = ? AND session_status = 'active'`,
    ).get('15550219')).toEqual({ n: 1 });
    expect(sm.getStatus()).toMatchObject({
      active: false,
      durableFailureClosed: false,
    });
    expect(sm.getStatus()).toHaveProperty('durableFailureInconclusive', true);
  });

  it('blocks same-manager fresh and resume retry until exact durable failure reconciliation completes', async () => {
    const metadataError = new Error('synthetic route policy metadata failure');
    const persistMetadata = vi.spyOn(durability, 'upsertSessionCheckpoint')
      .mockImplementation(() => { throw metadataError; });
    db.raw.exec(`
      CREATE TRIGGER deny_same_manager_compensation
      BEFORE UPDATE OF status ON agent_sessions
      WHEN OLD.workspace_key = '15550226' AND NEW.status = 'crashed'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic compensation failure');
      END;
    `);
    const initialize = vi.spyOn(OpenAIApiProvider.prototype, 'initialize').mockResolvedValue(undefined);
    const sm = new SessionManager({
      db,
      messenger: messenger(),
      chatJid: '15550226@s.whatsapp.net',
      onEvent: vi.fn(),
      provider: 'openai-api',
      model: 'gpt-5',
      routePolicy: route,
    });
    sm.setDurability(durability);

    await expect(sm.spawnSession()).rejects.toBe(metadataError);
    await expect(sm.spawnSession()).rejects.toBe(metadataError);
    await expect(sm.spawnSession('resume-must-remain-blocked')).rejects.toBe(metadataError);
    expect(initialize).not.toHaveBeenCalled();
    expect(db.raw.prepare(
      `SELECT COUNT(*) AS n FROM agent_sessions
       WHERE workspace_key = ? AND status = 'active'`,
    ).get('15550226')).toEqual({ n: 1 });

    const row = db.raw.prepare(
      `SELECT id FROM agent_sessions
       WHERE workspace_key = ? AND session_id IS NULL AND status = 'active'`,
    ).get('15550226') as { id: number };
    db.raw.exec('DROP TRIGGER deny_same_manager_compensation');
    durability.closeSessionLifecycleFailure({
      agentSessionRowId: row.id,
      providerSessionId: null,
      provider: 'openai-api',
      conversationKey: '15550226',
      agentStatus: 'crashed',
    });
    persistMetadata.mockRestore();

    await sm.spawnSession();
    expect(initialize).toHaveBeenCalledOnce();
    expect(sm.getStatus()).toMatchObject({
      active: true,
      durableFailureClosed: false,
      durableFailureInconclusive: false,
    });
  });

  it('blocks reconstructed-manager admission on durable unresolved pre-init state', async () => {
    const metadataError = new Error('synthetic route policy metadata failure');
    const persistMetadata = vi.spyOn(durability, 'upsertSessionCheckpoint')
      .mockImplementation(() => { throw metadataError; });
    db.raw.exec(`
      CREATE TRIGGER deny_reconstructed_manager_compensation
      BEFORE UPDATE OF status ON agent_sessions
      WHEN OLD.workspace_key = '15550227' AND NEW.status = 'crashed'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic compensation failure');
      END;
    `);
    const initialize = vi.spyOn(OpenAIApiProvider.prototype, 'initialize').mockResolvedValue(undefined);
    const failed = new SessionManager({
      db,
      messenger: messenger(),
      chatJid: '15550227@s.whatsapp.net',
      onEvent: vi.fn(),
      provider: 'openai-api',
      model: 'gpt-5',
      routePolicy: route,
    });
    failed.setDurability(durability);

    await expect(failed.spawnSession()).rejects.toBe(metadataError);
    persistMetadata.mockRestore();
    const reconstructed = new SessionManager({
      db,
      messenger: messenger(),
      chatJid: '15550227@s.whatsapp.net',
      onEvent: vi.fn(),
      provider: 'openai-api',
      model: 'gpt-5',
      routePolicy: route,
    });
    reconstructed.setDurability(durability);

    await expect(reconstructed.spawnSession()).rejects.toThrow(
      /unresolved active .*lifecycle/i,
    );
    expect(initialize).not.toHaveBeenCalled();
    expect(db.raw.prepare(
      `SELECT COUNT(*) AS n FROM agent_sessions
       WHERE workspace_key = ? AND status = 'active'`,
    ).get('15550227')).toEqual({ n: 1 });
  });

  it('blocks reconstructed-manager resume on a durable unresolved active lifecycle', async () => {
    const sessionId = 'inconclusive-reconstructed-resume';
    const resumeRoute = resolveProviderRoutePolicy({
      provider: 'opencode-cli',
      model: undefined,
      dataPolicy: 'trusted',
      boundaryMode: 'enforce',
    });
    const inserted = db.raw.prepare(
      `INSERT INTO agent_sessions (
         session_id, claude_pid, started_in_directory, chat_jid, workspace_key,
         started_at, status, provider
       ) VALUES (?, 42, '/tmp', '15550228@s.whatsapp.net', '15550228',
         datetime('now'), 'suspended', 'opencode-cli')`,
    ).run(sessionId);
    const rowId = Number(inserted.lastInsertRowid);
    durability.upsertSessionCheckpoint('15550228', {
      sessionId,
      sessionStatus: 'suspended',
      watchdogState: JSON.stringify({
        providerRoutePolicy: {
          provider: 'opencode-cli',
          model: null,
          dataPolicy: 'trusted',
          policyVersion: PROVIDER_DATA_POLICY_VERSION,
        },
      }),
    });
    const metadataError = new Error('synthetic resumed route policy metadata failure');
    const persistMetadata = vi.spyOn(durability, 'upsertSessionCheckpoint')
      .mockImplementation(() => { throw metadataError; });
    db.raw.exec(`
      CREATE TRIGGER deny_reconstructed_resume_compensation
      BEFORE UPDATE OF status ON agent_sessions
      WHEN OLD.workspace_key = '15550228' AND NEW.status = 'resume_failed'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic resumed compensation failure');
      END;
    `);
    const failedEvent = vi.fn();
    const failed = new SessionManager({
      db,
      messenger: messenger(),
      chatJid: '15550228@s.whatsapp.net',
      onEvent: failedEvent,
      provider: 'opencode-cli',
      routePolicy: resumeRoute,
    });
    failed.setDurability(durability);

    await expect(failed.spawnSession(sessionId, rowId)).rejects.toBe(metadataError);
    expect(failedEvent).not.toHaveBeenCalled();
    const failedCheckpoint = durability.getSessionCheckpoint('15550228');
    const checkpointVersion = failedCheckpoint?.checkpoint_version;
    expect(JSON.parse(failedCheckpoint?.watchdog_state ?? '')).toMatchObject({
      providerRoutePolicyAdmission: {
        state: 'pending',
        provider: 'opencode-cli',
      },
    });
    persistMetadata.mockRestore();
    const reconstructedEvent = vi.fn();
    const reconstructed = new SessionManager({
      db,
      messenger: messenger(),
      chatJid: '15550228@s.whatsapp.net',
      onEvent: reconstructedEvent,
      provider: 'opencode-cli',
      routePolicy: resumeRoute,
    });
    reconstructed.setDurability(durability);

    await expect(reconstructed.spawnSession(sessionId, rowId)).rejects.toThrow(
      /unresolved active route-policy admission lifecycle/i,
    );
    expect(reconstructedEvent).not.toHaveBeenCalled();
    expect(db.raw.prepare(
      'SELECT id, status, claude_pid FROM agent_sessions WHERE id = ?',
    ).get(rowId)).toEqual({ id: rowId, status: 'active', claude_pid: 0 });
    expect(durability.getSessionCheckpoint('15550228')).toMatchObject({
      session_status: 'active',
      checkpoint_version: checkpointVersion,
    });
  });

  it('still admits an active resume with committed route-policy metadata', async () => {
    const sessionId = 'committed-active-resume';
    const resumeRoute = resolveProviderRoutePolicy({
      provider: 'opencode-cli',
      model: undefined,
      dataPolicy: 'trusted',
      boundaryMode: 'enforce',
    });
    const inserted = db.raw.prepare(
      `INSERT INTO agent_sessions (
         session_id, claude_pid, started_in_directory, chat_jid, workspace_key,
         started_at, status, provider
       ) VALUES (?, 42, '/tmp', '15550229@s.whatsapp.net', '15550229',
         datetime('now'), 'active', 'opencode-cli')`,
    ).run(sessionId);
    const rowId = Number(inserted.lastInsertRowid);
    durability.upsertSessionCheckpoint('15550229', {
      sessionId,
      sessionStatus: 'active',
      watchdogState: JSON.stringify({
        providerRoutePolicy: {
          provider: 'opencode-cli',
          model: null,
          dataPolicy: 'trusted',
          policyVersion: PROVIDER_DATA_POLICY_VERSION,
        },
      }),
    });
    const onEvent = vi.fn();
    const sm = new SessionManager({
      db,
      messenger: messenger(),
      chatJid: '15550229@s.whatsapp.net',
      onEvent,
      provider: 'opencode-cli',
      routePolicy: resumeRoute,
    });
    sm.setDurability(durability);

    await sm.spawnSession(sessionId, rowId);

    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'init',
      sessionId,
    }));
    expect(db.raw.prepare('SELECT status FROM agent_sessions WHERE id = ?').get(rowId))
      .toEqual({ status: 'active' });
    expect(durability.getSessionCheckpoint('15550229')?.session_status).toBe('active');
  });

  it('reactivates only the intended compatible OpenCode lifecycle for a duplicate session ID', async () => {
    const sessionId = 'duplicate-compatible-opencode-resume';
    const insert = db.raw.prepare(
      `INSERT INTO agent_sessions (
         session_id, claude_pid, started_in_directory, chat_jid, workspace_key,
         started_at, status, provider
       ) VALUES (?, 0, '/tmp', ?, ?, datetime('now'), 'suspended', 'opencode-cli')`,
    );
    const firstRowId = Number(insert.run(
      sessionId,
      '15550220@s.whatsapp.net',
      '15550220',
    ).lastInsertRowid);
    const secondRowId = Number(insert.run(
      sessionId,
      '15550221@s.whatsapp.net',
      '15550221',
    ).lastInsertRowid);
    durability.upsertSessionCheckpoint('15550220', { sessionId, sessionStatus: 'suspended' });
    durability.upsertSessionCheckpoint('15550221', { sessionId, sessionStatus: 'suspended' });
    const sm = new SessionManager({
      db,
      messenger: messenger(),
      chatJid: '15550220@s.whatsapp.net',
      onEvent: vi.fn(),
      provider: 'opencode-cli',
    });
    sm.setDurability(durability);

    await sm.spawnSession(sessionId);

    expect(db.raw.prepare('SELECT id, status FROM agent_sessions WHERE session_id = ? ORDER BY id')
      .all(sessionId)).toEqual([
      { id: firstRowId, status: 'active' },
      { id: secondRowId, status: 'suspended' },
    ]);
    expect(durability.getSessionCheckpoint('15550220')?.session_status).toBe('active');
    expect(durability.getSessionCheckpoint('15550221')?.session_status).toBe('suspended');
  });

  it('retires only the intended unsupported OpenAI lifecycle for a duplicate session ID', async () => {
    const sessionId = 'duplicate-unsupported-openai-resume';
    const insert = db.raw.prepare(
      `INSERT INTO agent_sessions (
         session_id, claude_pid, started_in_directory, chat_jid, workspace_key,
         started_at, status, provider
       ) VALUES (?, 0, '/tmp', ?, ?, datetime('now'), 'suspended', 'openai-api')`,
    );
    const firstRowId = Number(insert.run(
      sessionId,
      '15550222@s.whatsapp.net',
      '15550222',
    ).lastInsertRowid);
    const secondRowId = Number(insert.run(
      sessionId,
      '15550223@s.whatsapp.net',
      '15550223',
    ).lastInsertRowid);
    durability.upsertSessionCheckpoint('15550222', { sessionId, sessionStatus: 'suspended' });
    durability.upsertSessionCheckpoint('15550223', { sessionId, sessionStatus: 'suspended' });
    const sm = new SessionManager({
      db,
      messenger: messenger(),
      chatJid: '15550222@s.whatsapp.net',
      onEvent: vi.fn(),
      provider: 'openai-api',
    });
    sm.setDurability(durability);

    await expect(sm.spawnSession(sessionId)).rejects.toThrow(/does not support persisted session resume/i);

    expect(db.raw.prepare('SELECT id, status FROM agent_sessions WHERE session_id = ? ORDER BY id')
      .all(sessionId)).toEqual([
      { id: firstRowId, status: 'ended' },
      { id: secondRowId, status: 'suspended' },
    ]);
    expect(durability.getSessionCheckpoint('15550222')?.session_status).toBe('ended');
    expect(durability.getSessionCheckpoint('15550223')?.session_status).toBe('suspended');
  });

  it('fails closed when the intended checkpoint identity changes before activation proof', async () => {
    const sessionId = 'checkpoint-toctou-resume';
    const inserted = db.raw.prepare(
      `INSERT INTO agent_sessions (
         session_id, claude_pid, started_in_directory, chat_jid, workspace_key,
         started_at, status, provider
       ) VALUES (?, 0, '/tmp', '15550224@s.whatsapp.net', '15550224',
         datetime('now'), 'suspended', 'opencode-cli')`,
    ).run(sessionId);
    const rowId = Number(inserted.lastInsertRowid);
    durability.upsertSessionCheckpoint('15550224', { sessionId, sessionStatus: 'suspended' });
    const reactivate = durability.reactivateSessionLifecycle.bind(durability);
    vi.spyOn(durability, 'reactivateSessionLifecycle').mockImplementation((params) => {
      db.raw.prepare(
        `UPDATE session_checkpoints SET conversation_key = ? WHERE conversation_key = ?`,
      ).run('15550225', '15550224');
      durability.upsertSessionCheckpoint('15550224', {
        sessionId: 'replacement-checkpoint-session',
        sessionStatus: 'suspended',
      });
      return reactivate(params);
    });
    const sm = new SessionManager({
      db,
      messenger: messenger(),
      chatJid: '15550224@s.whatsapp.net',
      onEvent: vi.fn(),
      provider: 'opencode-cli',
    });
    sm.setDurability(durability);

    await expect(sm.spawnSession(sessionId)).rejects.toThrow(/checkpoint|conversation|exact/i);
    expect(db.raw.prepare('SELECT status FROM agent_sessions WHERE id = ?').get(rowId))
      .toEqual({ status: 'suspended' });
    expect(durability.getSessionCheckpoint('15550225')?.session_status).toBe('suspended');
    expect(durability.getSessionCheckpoint('15550224')?.session_status).toBe('suspended');
  });

  it('retires the persisted agent row and checkpoint when its provider differs from the resolved route', async () => {
    const sessionId = 'foreign-provider-resume';
    const inserted = db.raw.prepare(
      `INSERT INTO agent_sessions (
         session_id, claude_pid, started_in_directory, chat_jid, workspace_key,
         started_at, status, provider
       ) VALUES (?, 0, '/tmp', '15550204@s.whatsapp.net', '15550204',
         datetime('now'), 'suspended', 'anthropic-api')`,
    ).run(sessionId);
    const rowId = Number(inserted.lastInsertRowid);
    durability.upsertSessionCheckpoint('15550204', {
      sessionId,
      sessionStatus: 'suspended',
      watchdogState: JSON.stringify({
        providerRoutePolicy: {
          provider: 'anthropic-api',
          model: 'claude-sonnet-4',
          dataPolicy: 'restricted',
          policyVersion: PROVIDER_DATA_POLICY_VERSION,
        },
      }),
    });
    const initialize = vi.spyOn(OpenAIApiProvider.prototype, 'initialize');
    const sm = new SessionManager({
      db,
      messenger: messenger(),
      chatJid: '15550204@s.whatsapp.net',
      onEvent: vi.fn(),
      provider: 'openai-api',
      model: 'gpt-5',
      routePolicy: route,
    });
    sm.setDurability(durability);

    await expect(sm.spawnSession(sessionId)).rejects.toThrow(/provider/i);
    expect(initialize).not.toHaveBeenCalled();
    expect(db.raw.prepare('SELECT status FROM agent_sessions WHERE id = ?').get(rowId))
      .toEqual({ status: 'ended' });
    expect(durability.getSessionCheckpoint('15550204')?.session_status).toBe('ended');
  });

  it('leaves an omitted-row-ID resume unchanged when provider ownership is ambiguous', async () => {
    const sessionId = 'ambiguous-provider-resume';
    const insert = db.raw.prepare(
      `INSERT INTO agent_sessions (
         session_id, claude_pid, started_in_directory, chat_jid, workspace_key,
         started_at, status, provider
       ) VALUES (?, 0, '/tmp', '15550205@s.whatsapp.net', '15550205',
         datetime('now'), 'suspended', ?)`,
    );
    const firstRowId = Number(insert.run(sessionId, 'anthropic-api').lastInsertRowid);
    const secondRowId = Number(insert.run(sessionId, 'claude-cli').lastInsertRowid);
    durability.upsertSessionCheckpoint('15550205', {
      sessionId,
      sessionStatus: 'suspended',
    });
    const sm = new SessionManager({
      db,
      messenger: messenger(),
      chatJid: '15550205@s.whatsapp.net',
      onEvent: vi.fn(),
      provider: 'openai-api',
      model: 'gpt-5',
      routePolicy: route,
    });
    sm.setDurability(durability);

    await expect(sm.spawnSession(sessionId)).rejects.toThrow(/ambiguous|ownership|provider/i);
    expect(db.raw.prepare('SELECT id, status FROM agent_sessions WHERE session_id = ? ORDER BY id')
      .all(sessionId)).toEqual([
      { id: firstRowId, status: 'suspended' },
      { id: secondRowId, status: 'suspended' },
    ]);
    expect(durability.getSessionCheckpoint('15550205')?.session_status).toBe('suspended');
  });

  it('leaves every lifecycle unchanged when a session ID is duplicated across workspaces', async () => {
    const sessionId = 'cross-workspace-provider-resume';
    const insert = db.raw.prepare(
      `INSERT INTO agent_sessions (
         session_id, claude_pid, started_in_directory, chat_jid, workspace_key,
         started_at, status, provider
       ) VALUES (?, 0, '/tmp', ?, ?, datetime('now'), 'suspended', 'anthropic-api')`,
    );
    const currentRowId = Number(insert.run(
      sessionId,
      '15550207@s.whatsapp.net',
      '15550207',
    ).lastInsertRowid);
    const otherRowId = Number(insert.run(
      sessionId,
      '15550208@s.whatsapp.net',
      '15550208',
    ).lastInsertRowid);
    durability.upsertSessionCheckpoint('15550207', {
      sessionId,
      sessionStatus: 'suspended',
    });
    durability.upsertSessionCheckpoint('15550208', {
      sessionId,
      sessionStatus: 'suspended',
    });
    const sm = new SessionManager({
      db,
      messenger: messenger(),
      chatJid: '15550207@s.whatsapp.net',
      onEvent: vi.fn(),
      provider: 'openai-api',
      model: 'gpt-5',
      routePolicy: route,
    });
    sm.setDurability(durability);

    await expect(sm.spawnSession(sessionId)).rejects.toThrow(
      'Provider session ownership is foreign, unknown, or ambiguous',
    );
    expect(db.raw.prepare('SELECT id, status FROM agent_sessions WHERE session_id = ? ORDER BY id')
      .all(sessionId)).toEqual([
      { id: currentRowId, status: 'suspended' },
      { id: otherRowId, status: 'suspended' },
    ]);
    expect(durability.getSessionCheckpoint('15550207')?.session_status).toBe('suspended');
    expect(durability.getSessionCheckpoint('15550208')?.session_status).toBe('suspended');
  });

  it.each([
    {
      name: 'another provider',
      historicalProvider: 'claude-cli' as string | null,
      currentJid: '15550211@s.whatsapp.net',
      currentKey: '15550211',
      historicalJid: '15550212@s.whatsapp.net',
      historicalKey: '15550212',
    },
    {
      name: 'a NULL provider namespace',
      historicalProvider: null,
      currentJid: '15550213@s.whatsapp.net',
      currentKey: '15550213',
      historicalJid: '15550214@s.whatsapp.net',
      historicalKey: '15550214',
    },
  ])('does not retire through a historical session-ID row owned by $name', async ({
    historicalProvider,
    currentJid,
    currentKey,
    historicalJid,
    historicalKey,
  }) => {
    const sessionId = `historical-namespace-${currentKey}`;
    const insert = db.raw.prepare(
      `INSERT INTO agent_sessions (
         session_id, claude_pid, started_in_directory, chat_jid, workspace_key,
         started_at, status, provider
       ) VALUES (?, 0, '/tmp', ?, ?, datetime('now'), ?, ?)`,
    );
    const currentRowId = Number(insert.run(
      sessionId,
      currentJid,
      currentKey,
      'suspended',
      'anthropic-api',
    ).lastInsertRowid);
    const historicalRowId = Number(insert.run(
      sessionId,
      historicalJid,
      historicalKey,
      'ended',
      historicalProvider,
    ).lastInsertRowid);
    durability.upsertSessionCheckpoint(currentKey, {
      sessionId,
      sessionStatus: 'suspended',
    });
    const sm = new SessionManager({
      db,
      messenger: messenger(),
      chatJid: currentJid,
      onEvent: vi.fn(),
      provider: 'openai-api',
      model: 'gpt-5',
      routePolicy: route,
    });
    sm.setDurability(durability);

    await expect(sm.spawnSession(sessionId)).rejects.toThrow(
      'Provider session ownership is foreign, unknown, or ambiguous',
    );
    expect(db.raw.prepare('SELECT id, status FROM agent_sessions WHERE session_id = ? ORDER BY id')
      .all(sessionId)).toEqual([
      { id: currentRowId, status: 'suspended' },
      { id: historicalRowId, status: 'ended' },
    ]);
    expect(durability.getSessionCheckpoint(currentKey)?.session_status).toBe('suspended');
  });

  it('preserves the canonical ownership error when a foreign row has no checkpoint', async () => {
    const sessionId = 'foreign-provider-without-checkpoint';
    const inserted = db.raw.prepare(
      `INSERT INTO agent_sessions (
         session_id, claude_pid, started_in_directory, chat_jid, workspace_key,
         started_at, status, provider
       ) VALUES (?, 0, '/tmp', '15550209@s.whatsapp.net', '15550209',
         datetime('now'), 'suspended', 'anthropic-api')`,
    ).run(sessionId);
    const rowId = Number(inserted.lastInsertRowid);
    const sm = new SessionManager({
      db,
      messenger: messenger(),
      chatJid: '15550209@s.whatsapp.net',
      onEvent: vi.fn(),
      provider: 'openai-api',
      model: 'gpt-5',
      routePolicy: route,
    });
    sm.setDurability(durability);

    await expect(sm.spawnSession(sessionId)).rejects.toThrow(
      'Provider session ownership is foreign, unknown, or ambiguous',
    );
    expect(db.raw.prepare('SELECT status FROM agent_sessions WHERE id = ?').get(rowId))
      .toEqual({ status: 'suspended' });
  });

  it('does not mask the canonical ownership error when eligible retirement fails', async () => {
    const sessionId = 'foreign-provider-retirement-failure';
    const inserted = db.raw.prepare(
      `INSERT INTO agent_sessions (
         session_id, claude_pid, started_in_directory, chat_jid, workspace_key,
         started_at, status, provider
       ) VALUES (?, 0, '/tmp', '15550210@s.whatsapp.net', '15550210',
         datetime('now'), 'suspended', 'anthropic-api')`,
    ).run(sessionId);
    const rowId = Number(inserted.lastInsertRowid);
    durability.upsertSessionCheckpoint('15550210', {
      sessionId,
      sessionStatus: 'suspended',
    });
    const retire = vi.spyOn(durability, 'retireExactSessionLifecycle')
      .mockImplementation(() => { throw new Error('synthetic retirement failure'); });
    const sm = new SessionManager({
      db,
      messenger: messenger(),
      chatJid: '15550210@s.whatsapp.net',
      onEvent: vi.fn(),
      provider: 'openai-api',
      model: 'gpt-5',
      routePolicy: route,
    });
    sm.setDurability(durability);

    await expect(sm.spawnSession(sessionId)).rejects.toThrow(
      'Provider session ownership is foreign, unknown, or ambiguous',
    );
    expect(retire).toHaveBeenCalledOnce();
    expect(db.raw.prepare('SELECT status FROM agent_sessions WHERE id = ?').get(rowId))
      .toEqual({ status: 'suspended' });
    expect(durability.getSessionCheckpoint('15550210')?.session_status).toBe('suspended');
  });

  it('preserves the exact missing-checkpoint rejection and row state without retirement', async () => {
    const sessionId = 'missing-checkpoint-current-provider';
    const inserted = db.raw.prepare(
      `INSERT INTO agent_sessions (
         session_id, claude_pid, started_in_directory, chat_jid, workspace_key,
         started_at, status, provider
       ) VALUES (?, 0, '/tmp', '15550206@s.whatsapp.net', '15550206',
         datetime('now'), 'suspended', 'openai-api')`,
    ).run(sessionId);
    const rowId = Number(inserted.lastInsertRowid);
    const sm = new SessionManager({
      db,
      messenger: messenger(),
      chatJid: '15550206@s.whatsapp.net',
      onEvent: vi.fn(),
      provider: 'openai-api',
      model: 'gpt-5',
      routePolicy: route,
    });
    sm.setDurability(durability);

    await expect(sm.spawnSession(sessionId, rowId)).rejects.toThrow(
      'No resumable checkpoint matches the provider session and conversation',
    );
    expect(db.raw.prepare('SELECT status FROM agent_sessions WHERE id = ?').get(rowId))
      .toEqual({ status: 'suspended' });
    expect(durability.getSessionCheckpoint('15550206')).toBeUndefined();
  });
});
