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
});
