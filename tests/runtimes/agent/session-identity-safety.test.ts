import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import type { Messenger } from '../../../src/core/types.ts';
import {
  SessionManager,
  providerSupportsResume,
} from '../../../src/runtimes/agent/session.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import { OpenAIApiProvider } from '../../../src/runtimes/agent/providers/openai-api.ts';
import type { ProviderSessionOptions } from '../../../src/runtimes/agent/providers/types.ts';

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  };
}

type MutableSessionState = {
  chatJid: string;
  dbRowId: number | null;
  sessionId: string | null;
  resumeAttemptId: string | null;
  handleProviderEvent(event: AgentEvent): void;
};

describe('SessionManager immutable checkpoint identity', () => {
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

  it('keeps the constructor conversation key when routing state later changes', () => {
    const sm = new SessionManager({
      db,
      messenger: makeMessenger(),
      chatJid: '15550121:7@s.whatsapp.net',
      onEvent: vi.fn(),
    });
    sm.setDurability(durability);
    const state = sm as unknown as MutableSessionState;
    state.dbRowId = 999;
    state.chatJid = '81536414179557@lid';

    state.handleProviderEvent({ type: 'init', sessionId: 'immutable-session' });

    expect(durability.getSessionCheckpoint('15550121')).toMatchObject({
      session_id: 'immutable-session',
    });
    expect(durability.getSessionCheckpoint('81536414179557')).toBeUndefined();
  });

  it('clears stale completed identity before a fresh managed provider init can identify itself', async () => {
    durability.upsertSessionCheckpoint('15550125', {
      sessionId: 'ended-provider-session',
      sessionStatus: 'ended',
      lastInboundSeq: 25,
      completedInboundSeq: 25,
      completedDeliveryJid: '15550125@s.whatsapp.net',
      completedDeliveryNamespace: 's.whatsapp.net',
      completedScope: 'per_chat',
      completedLogicalTurnId: 'ended-turn-25',
      completedManagerId: 'ended-manager',
      completedGeneration: 3,
    });
    vi.spyOn(OpenAIApiProvider.prototype, 'initialize').mockResolvedValue(undefined);
    const sm = new SessionManager({
      db,
      messenger: makeMessenger(),
      chatJid: '15550125@s.whatsapp.net',
      onEvent: vi.fn(),
      provider: 'openai-api',
    });
    sm.setDurability(durability);

    await sm.spawnSession();

    expect(durability.getSessionCheckpoint('15550125')).toMatchObject({
      session_id: null,
      session_status: 'active',
      last_inbound_seq: null,
      completed_delivery_jid: null,
      completed_delivery_namespace: null,
      completed_scope: null,
      completed_logical_turn_id: null,
      completed_manager_id: null,
      completed_generation: null,
    });
    expect(durability.getResumableCheckpoints()).toEqual([]);
  });

  it('suspends only the current conversation checkpoint for a shared provider session ID', async () => {
    durability.upsertSessionCheckpoint('15550131', {
      sessionId: 'shared-provider-session',
      sessionStatus: 'active',
    });
    durability.upsertSessionCheckpoint('15550132', {
      sessionId: 'shared-provider-session',
      sessionStatus: 'active',
    });
    durability.upsertSessionCheckpoint('15550133', {
      sessionId: 'other-provider-session',
      sessionStatus: 'active',
    });
    const sm = new SessionManager({
      db,
      messenger: makeMessenger(),
      chatJid: '15550131@s.whatsapp.net',
      onEvent: vi.fn(),
    });
    sm.setDurability(durability);
    (sm as unknown as MutableSessionState).sessionId = 'shared-provider-session';

    await sm.shutdown(true);

    expect(durability.getSessionCheckpoint('15550131')?.session_status).toBe('suspended');
    expect(durability.getSessionCheckpoint('15550132')?.session_status).toBe('active');
    expect(durability.getSessionCheckpoint('15550133')?.session_status).toBe('active');
  });

  it('ends only the current conversation checkpoint for an attempted resume', async () => {
    durability.upsertSessionCheckpoint('15550141', {
      sessionId: 'resume-provider-session',
      sessionStatus: 'active',
    });
    durability.upsertSessionCheckpoint('15550142', {
      sessionId: 'resume-provider-session',
      sessionStatus: 'active',
    });
    const sm = new SessionManager({
      db,
      messenger: makeMessenger(),
      chatJid: '15550141@s.whatsapp.net',
      onEvent: vi.fn(),
    });
    sm.setDurability(durability);
    (sm as unknown as MutableSessionState).resumeAttemptId = 'resume-provider-session';

    await sm.shutdown(false);

    expect(durability.getSessionCheckpoint('15550141')?.session_status).toBe('ended');
    expect(durability.getSessionCheckpoint('15550142')?.session_status).toBe('active');
  });

  it('orphans only the current conversation checkpoint when a managed provider reports a crash', async () => {
    const providerSessionId = 'managed-provider-session';
    durability.upsertSessionCheckpoint('15550151', {
      sessionId: providerSessionId,
      sessionStatus: 'active',
    });
    durability.upsertSessionCheckpoint('15550152', {
      sessionId: providerSessionId,
      sessionStatus: 'active',
    });
    let reportCrash: ProviderSessionOptions['onCrash'] | null = null;
    vi.spyOn(OpenAIApiProvider.prototype, 'initialize').mockImplementation(async (opts) => {
      reportCrash = opts.onCrash;
      opts.onEvent({ type: 'init', sessionId: providerSessionId });
    });
    const sm = new SessionManager({
      db,
      messenger: makeMessenger(),
      chatJid: '15550151@s.whatsapp.net',
      onEvent: vi.fn(),
      provider: 'openai-api',
    });
    sm.setDurability(durability);
    await sm.spawnSession();
    const capturedCrash = reportCrash as ProviderSessionOptions['onCrash'] | null;
    if (capturedCrash === null) throw new Error('managed provider crash callback was not captured');

    capturedCrash({ exitCode: 1, signal: null, provider: 'openai-api' });

    expect(durability.getSessionCheckpoint('15550151')?.session_status).toBe('orphaned');
    expect(durability.getSessionCheckpoint('15550152')?.session_status).toBe('active');

    const rowId = sm.getDbRowId();
    if (rowId === null) throw new Error('managed provider session row was not created');
    await sm.shutdown(true);

    expect((db.raw.prepare('SELECT status FROM agent_sessions WHERE id = ?').get(rowId) as
      { status: string }).status).toBe('crashed');
    expect(durability.getSessionCheckpoint('15550151')?.session_status).toBe('orphaned');
    expect(durability.getSessionCheckpoint('15550152')?.session_status).toBe('active');
  });

  it('atomically orphans the pre-init lifecycle when managed initialization fails', async () => {
    vi.spyOn(OpenAIApiProvider.prototype, 'initialize')
      .mockRejectedValue(new Error('managed init failed'));
    const sm = new SessionManager({
      db,
      messenger: makeMessenger(),
      chatJid: '15550161@s.whatsapp.net',
      onEvent: vi.fn(),
      provider: 'openai-api',
    });
    sm.setDurability(durability);

    await expect(sm.spawnSession()).rejects.toThrow('managed init failed');

    expect(durability.getSessionCheckpoint('15550161')?.session_status).toBe('orphaned');

    const row = db.raw.prepare(
      'SELECT id, status FROM agent_sessions ORDER BY id DESC LIMIT 1',
    ).get() as { id: number; status: string };
    await sm.shutdown(true);

    expect((db.raw.prepare('SELECT status FROM agent_sessions WHERE id = ?').get(row.id) as
      { status: string }).status).toBe('crashed');
    expect(durability.getSessionCheckpoint('15550161')?.session_status).toBe('orphaned');
  });

  it('defines the provider resume capability matrix exhaustively', () => {
    expect({
      'claude-cli': providerSupportsResume('claude-cli'),
      'codex-cli': providerSupportsResume('codex-cli'),
      'opencode-cli': providerSupportsResume('opencode-cli'),
      'gemini-cli': providerSupportsResume('gemini-cli'),
      'openai-api': providerSupportsResume('openai-api'),
      'anthropic-api': providerSupportsResume('anthropic-api'),
    }).toEqual({
      'claude-cli': true,
      'codex-cli': true,
      'opencode-cli': true,
      'gemini-cli': false,
      'openai-api': false,
      'anthropic-api': false,
    });
  });

  it('keeps an unsupported exact resume retired through cleanup shutdown', async () => {
    const sessionId = 'unsupported-managed-resume';
    const insert = db.raw.prepare(
      `INSERT INTO agent_sessions (
         session_id, claude_pid, started_in_directory, chat_jid, workspace_key,
         started_at, status, provider
       ) VALUES (?, 0, '/tmp', '15550171@s.whatsapp.net', '15550171',
         datetime('now'), 'suspended', 'openai-api')`,
    ).run(sessionId);
    const rowId = Number(insert.lastInsertRowid);
    durability.upsertSessionCheckpoint('15550171', {
      sessionId,
      sessionStatus: 'suspended',
    });
    const initialize = vi.spyOn(OpenAIApiProvider.prototype, 'initialize');
    const sm = new SessionManager({
      db,
      messenger: makeMessenger(),
      chatJid: '15550171@s.whatsapp.net',
      onEvent: vi.fn(),
      provider: 'openai-api',
    });
    sm.setDurability(durability);

    await expect(sm.spawnSession(sessionId, rowId)).rejects.toThrow(
      /openai-api.*does not support.*resume/i,
    );

    expect(initialize).not.toHaveBeenCalled();
    expect(db.raw.prepare(
      'SELECT status, ended_at FROM agent_sessions WHERE id = ?',
    ).get(rowId)).toMatchObject({ status: 'ended', ended_at: expect.any(String) });
    expect(durability.getSessionCheckpoint('15550171')?.session_status).toBe('ended');
    expect(sm.getStatus()).toMatchObject({ active: false, sessionId: null });

    await sm.shutdown(true);

    expect(db.raw.prepare(
      'SELECT status, ended_at FROM agent_sessions WHERE id = ?',
    ).get(rowId)).toMatchObject({ status: 'ended', ended_at: expect.any(String) });
    expect(durability.getSessionCheckpoint('15550171')?.session_status).toBe('ended');
  });

  it('resolves and retires a unique unsupported resume when the caller has no row ID', async () => {
    const sessionId = 'unsupported-proactive-resume';
    const insert = db.raw.prepare(
      `INSERT INTO agent_sessions (
         session_id, claude_pid, started_in_directory, chat_jid, workspace_key,
         started_at, status, provider
       ) VALUES (?, 0, '/tmp', '15550172@s.whatsapp.net', '15550172',
         datetime('now'), 'suspended', 'openai-api')`,
    ).run(sessionId);
    const rowId = Number(insert.lastInsertRowid);
    durability.upsertSessionCheckpoint('15550172', {
      sessionId,
      sessionStatus: 'suspended',
    });
    const sm = new SessionManager({
      db,
      messenger: makeMessenger(),
      chatJid: '15550172@s.whatsapp.net',
      onEvent: vi.fn(),
      provider: 'openai-api',
    });
    sm.setDurability(durability);

    await expect(sm.spawnSession(sessionId)).rejects.toThrow(/does not support.*resume/i);

    expect(db.raw.prepare('SELECT status FROM agent_sessions WHERE id = ?').get(rowId))
      .toEqual({ status: 'ended' });
    expect(durability.getSessionCheckpoint('15550172')?.session_status).toBe('ended');
  });
});
