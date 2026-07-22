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
    });
    sm.setDurability(durability);

    await sm.spawnSession();

    expect(sm.getRoutePolicy()).toBe(route);
    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({ routePolicy: route }));
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
    const retire = vi.spyOn(durability, 'retireSessionLifecycle')
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
