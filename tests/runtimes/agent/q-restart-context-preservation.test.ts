import { EventEmitter } from 'node:events';
import type { SessionOwnershipRegistry } from '../../../src/runtimes/agent/session-ownership.ts';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Messenger, IncomingMessage } from '../../../src/core/types.ts';

// ─── Hoisted provider-boundary doubles ──────────────────────────────────────

const { makeQueueDouble } = vi.hoisted(() => {
  function makeQueueDouble(chatJid: string, conversationKey: string) {
    void conversationKey;
    const double = {
      targetChatJid: chatJid,
      enqueueText: vi.fn(),
      getSenderToken: () => 'test-sender-token',
      enqueueStreamingText: vi.fn(),
      commitStreamingText: vi.fn(),
      discardPreToolAssistantText: vi.fn(),
      enqueueResultText: vi.fn(),
      enqueueToolUpdate: vi.fn(),
      enqueueProgressUpdate: vi.fn(),
      indicateTyping: vi.fn(),
      flush: vi.fn(async () => {}),
      isPoisoned: vi.fn(() => false),
      shutdown: vi.fn(async () => {}),
      abortTurn: vi.fn(),
      updateDeliveryJid: vi.fn(),
      setInboundSeq: vi.fn(),
      markLastTerminal: vi.fn(),
      clearLastOpId: vi.fn(),
      beginTurnEvidence: vi.fn(),
      flushTurnEvidence: vi.fn(async (turnId: string) => ({
        turnId,
        answerOpIds: [],
        lifecycleOpIds: [],
        statusOpIds: [],
      })),
      setToolUpdateMode: vi.fn(),
      setToolUpdateRedirectJid: vi.fn(),
      setTextAggregateDelayMs: vi.fn(),
      enqueuePoll: vi.fn(async (fn: () => Promise<void>) => {
        await fn();
      }),
      hasPendingPoll: vi.fn(() => false),
      setPollPending: vi.fn(),
      endTurn: vi.fn(),
      getLastOpId: vi.fn(() => undefined),
      setDurability: vi.fn(),
    };
    return double;
  }

  return { makeQueueDouble };
});

const { mockConfig, configuredDefaults } = vi.hoisted(() => ({
  configuredDefaults: { proactiveResumeOnStartup: false },
  mockConfig: {
    agentProvider: 'opencode-cli',
    fallbackTunables: { noticeDedupMs: 1_800_000, primaryRecheckMs: 300_000, probeStallThreshold: 12, probeStallCeilingMultiple: 10 },
    adminPhones: new Set<string>(['15550001']),
    controlPeers: new Map<string, string>(),
    internalPeerJids: new Set<string>(),
    toolUpdateMode: 'full' as const,
    toolUpdateRedirectJid: null as string | null,
    textAggregateDelayMs: 2_000,
    stateRoot: `/tmp/whatsoup-test-state-q-restart-${process.pid}`,
    restartLoopGuard: { enabled: false, maxRestarts: 3, windowMs: 300_000 },
    startupNotifications: false,
    proactiveResumeOnStartup: false,
    mediaDir: `/tmp/whatsoup-test-media-q-restart-${process.pid}`,
    pineconeAllowedIndexes: [] as string[],
    voiceReply: 'never' as const,
    elevenlabs: { defaultVoiceId: 'v', defaultModel: 'm', stability: 0.5, similarityBoost: 0.75 },
    memory: { adminJid: 'admin@s.whatsapp.net' },
  },
}));

// ─── Module mocks ───────────────────────────────────────────────────────────

vi.mock('../../../src/logger.ts', async () => {
  const { loggerMock } = await import('../../helpers/logger-mock.ts');
  return loggerMock();
});

vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlert: vi.fn(),
  emitAlertChecked: vi.fn(),
  emitObservationChecked: vi.fn(() => true),
  clearAlertSource: vi.fn(),
  clearAlertSourceChecked: vi.fn(),
}));

vi.mock('../../../src/core/messages.ts', () => ({
  getRecentMessages: vi.fn(() => []),
  getMessagesSince: vi.fn(() => []),
  updateMediaPath: vi.fn(),
  updateTranscription: vi.fn(),
}));

vi.mock('../../../src/runtimes/agent/media-prep.ts', () => ({
  prepareContentForAgent: vi.fn(async (msg: IncomingMessage) => msg.content ?? ''),
  relocateMediaToWorkspace: vi.fn((content: string) => content),
}));

vi.mock('../../../src/runtimes/agent/outbound-queue.ts', () => ({
  // eslint-disable-next-line prefer-arrow-callback -- constructor mock requires function keyword; expires 2026-12-31
  OutboundQueue: vi.fn().mockImplementation(function (
    _messenger: unknown,
    chatJid: string,
    opts?: { conversationKey?: string },
  ) {
    const double = makeQueueDouble(chatJid, opts?.conversationKey ?? chatJid.replace(/@.*$/, ''));
    return double;
  }),
}));

vi.mock('../../../src/config.ts', async (importOriginal) => {
  // Read the real default from a synthetic named instance with the top-level key omitted.
  // Filesystem writes are doubled below; no deployed config or credentials are loaded.
  const previous = process.env.INSTANCE_CONFIG;
  process.env.INSTANCE_CONFIG = JSON.stringify({
    name: 'q-startup-fixture', type: 'agent',
    paths: Object.fromEntries(['configRoot', 'dataRoot', 'stateRoot', 'dbPath', 'lockPath', 'logDir', 'mediaDir', 'authDir']
      .map((key) => [key, '/fixture/config/' + key])),
  });
  try {
    const actual = await importOriginal<typeof import('../../../src/config.ts')>();
    configuredDefaults.proactiveResumeOnStartup = actual.config.proactiveResumeOnStartup;
  } finally {
    if (previous === undefined) delete process.env.INSTANCE_CONFIG;
    else process.env.INSTANCE_CONFIG = previous;
  }
  return { config: mockConfig };
});

vi.mock('../../../src/core/workspace.ts', () => ({
  chatJidToWorkspace: vi.fn((_cwd: string, chatJid: string) => {
    const key = chatJid.replace(/@.*$/, '');
    return {
      kind: chatJid.endsWith('@g.us') ? ('group' as const) : ('dm' as const),
      workspaceKey: key,
      workspacePath: `/tmp/whatsoup-test-ws-${key}`,
    };
  }),
  provisionWorkspace: vi.fn(() => '/tmp/whatsoup-test-ws/.claude/whatsoup.sock'),
  writeSandboxArtifacts: vi.fn(),
  ensurePermissionsSettings: vi.fn(),
  writePrivateFileSync: vi.fn(),
}));

vi.mock('../../../src/mcp/socket-server.ts', () => ({
  // eslint-disable-next-line prefer-arrow-callback -- constructor mock requires function keyword; expires 2026-12-31
  WhatSoupSocketServer: vi.fn().mockImplementation(function (
    _socketPath: string,
    _registry: unknown,
    session: { tier?: string },
    executingSessionResolver?: () => {
      actorJid?: string;
      purpose?: string;
      conversationKey?: string;
    },
  ) {
    const instance = {
      session,
      executingSessionResolver,
      start: vi.fn(),
      stop: vi.fn(),
      updateDeliveryJid: vi.fn(),
      updateActorJid: vi.fn(),
      updateConversationKey: vi.fn(),
    };
    return instance;
  }),
}));

vi.mock('../../../src/mcp/register-all.ts', () => ({
  registerAllTools: vi.fn(),
}));

vi.mock('../../../src/runtimes/agent/media-bridge.ts', () => ({
  startMediaBridge: vi.fn(() => null),
  setMediaBridgeChat: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});


vi.mock('node:child_process', () => {
  const forbidden = () => vi.fn(() => { throw new Error('external process forbidden'); });
  return {spawn: forbidden(), spawnSync: forbidden(), exec: forbidden(), execSync: forbidden(), execFile: forbidden(), execFileSync: forbidden()};
});
vi.mock('../../../src/runtimes/agent/process-tree.ts', () => ({killSessionTree: vi.fn(async () => { throw new Error('external kill forbidden'); })}));

vi.mock('../../../src/core/provider-mcp-config.ts', async (importOriginal) => ({...await importOriginal<typeof import('../../../src/core/provider-mcp-config.ts')>(), writeProviderMcpConfig: vi.fn(() => '/fixture/mcp.json')}));

import { spawn } from 'node:child_process';
import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import { SessionManager } from '../../../src/runtimes/agent/session.ts';
import { classifyActiveSessions } from '../../../src/runtimes/agent/session-classifier.ts';
import { installFakePerChatMcpSocketManager } from './helpers/fake-per-chat-mcp-socket-manager.ts';

const GROUP = '111111100000000001@g.us';
const ORDINARY = '111111100000000001_at_g.us';
const SCHEDULED = GROUP + '::scheduled-agent-job';
const SID = 'ses_fixtureRetainedContext';
const ADJACENT = '15550001234';
type RuntimeView = {
  chatSessions: Map<string, SessionManager>;
  chatQueues: Map<string, ReturnType<typeof makeQueueDouble>>;
  sessionOwnership: SessionOwnershipRegistry;
  ensureSessionAndQueueSync(jid: string, key: string): void;
  sendTurnToSession(s: SessionManager, jid: string, text: string, key: string): Promise<void>;
  fallback: { schedulePrimaryModelUsabilityProbe: (...a: unknown[]) => void; scheduleNextPeriodicUsabilityProbe: () => void; startChainCanary: () => void };
};

describe('Q cold restart context-preservation qualification', () => {
  let db: Database;
  let engine: DurabilityEngine;
  let runtime: AgentRuntime;
  let messenger: Messenger;
  let expectedMockSpawnCalls = 0;
  function state() {
    return {
      rows: db.raw.prepare('SELECT id,session_id,provider,workspace_key,status FROM agent_sessions ORDER BY id').all(),
      checkpoints: db.raw.prepare('SELECT conversation_key,session_id,session_status,checkpoint_version,active_turn_id,last_inbound_seq,completed_inbound_seq FROM session_checkpoints ORDER BY conversation_key').all(),
      inbound: db.raw.prepare('SELECT seq,message_id,processing_status FROM inbound_events ORDER BY seq').all(),
    };
  }
  function checkpoint(key: string, sid: string, jid: string) {
    const seq = engine.journalInbound('fixture-' + key, key, jid, 'agent');
    engine.upsertSessionCheckpoint(key, {
      sessionId: sid, sessionStatus: 'active', lastInboundSeq: seq,
      transcriptPath: '/fixture/transcript-' + key,
      watchdogState: JSON.stringify({providerRoutePolicy:{provider:'opencode-cli',model:'opencode/big-pickle',dataPolicy:null,policyVersion:'provider-data-policy-v1'}}),
      completedInboundSeq: seq, completedDeliveryJid: jid,
      completedDeliveryNamespace: jid.endsWith('@g.us') ? 'g.us' : 's.whatsapp.net',
      completedScope: 'per_chat', completedLogicalTurnId: 'turn-' + key,
      completedManagerId: 'manager-' + key, completedGeneration: 1,
    });
  }
  beforeEach(() => {
    vi.clearAllMocks(); vi.useFakeTimers();
    expectedMockSpawnCalls = 0;
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('external fetch forbidden'); }));
    mockConfig.proactiveResumeOnStartup = false;
    db = new Database(':memory:'); db.open(); engine = new DurabilityEngine(db);
    const insert = db.raw.prepare(`INSERT INTO agent_sessions(session_id,claude_pid,started_in_directory,chat_jid,workspace_key,started_at,status,provider) VALUES (?,0,'/fixture',?,?,datetime('now'),'suspended','opencode-cli')`);
    insert.run(SID, GROUP, SCHEDULED);
    insert.run('adjacent-retained', ADJACENT + '@s.whatsapp.net', ADJACENT);
    checkpoint(ORDINARY, SID, GROUP); checkpoint(SCHEDULED, SID, GROUP);
    checkpoint(ADJACENT, 'adjacent-retained', ADJACENT + '@s.whatsapp.net');
    messenger = {sendMessage: vi.fn(async () => { throw new Error('transport send forbidden'); }), sendMedia: vi.fn(async () => { throw new Error('transport media forbidden'); })};
    runtime = new AgentRuntime(db, messenger, 'test', {sessionScope:'per_chat', model:'opencode/big-pickle', cwd:'/fixture/runtime'});
    installFakePerChatMcpSocketManager(runtime); runtime.setDurability(engine);
    const v = runtime as unknown as RuntimeView;
    vi.spyOn(v.fallback,'schedulePrimaryModelUsabilityProbe').mockImplementation(() => {});
    vi.spyOn(v.fallback,'scheduleNextPeriodicUsabilityProbe').mockImplementation(() => {});
    vi.spyOn(v.fallback,'startChainCanary').mockImplementation(() => {});
    vi.spyOn(SessionManager.prototype,'sendTurnAtProviderBoundary').mockResolvedValue(undefined);
  });
  afterEach(async () => {
    if (runtime) await runtime.shutdown();
    expect(spawn).toHaveBeenCalledTimes(expectedMockSpawnCalls); expect(fetch).not.toHaveBeenCalled();
    expect(messenger.sendMessage).not.toHaveBeenCalled(); expect(messenger.sendMedia).not.toHaveBeenCalled();
    db.close(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  });
  it('proactive=false leaves both namespaces and adjacent work unchanged at startup', async () => {
    const before = state(); await runtime.start(); expect(state()).toEqual(before);
    expect((runtime as unknown as RuntimeView).chatSessions.size).toBe(0);
  });
  describe('real default startup and classifier', () => {
    const ordinarySid = 'ses_fixtureOrdinaryContext';
    beforeEach(() => {
      expect(configuredDefaults.proactiveResumeOnStartup).toBe(true);
      mockConfig.proactiveResumeOnStartup = configuredDefaults.proactiveResumeOnStartup;
      db.raw.prepare(`INSERT INTO agent_sessions(session_id,claude_pid,started_in_directory,chat_jid,workspace_key,started_at,status,provider) VALUES (?,0,'/fixture',?,?,datetime('now'),'suspended','opencode-cli')`)
        .run(ordinarySid, GROUP, ORDINARY);
      db.raw.prepare('UPDATE session_checkpoints SET session_id=? WHERE conversation_key=?').run(ordinarySid, ORDINARY);
      // A healthy adjacent logical session must suppress duplicate proactive work.
      db.raw.prepare("UPDATE agent_sessions SET status='active' WHERE workspace_key=?").run(ADJACENT);
    });

    it.each([['ordinary', ORDINARY, GROUP], ['scheduled', SCHEDULED, SCHEDULED]])(
      'keeps both group namespaces at startup and resumes only the requested %s context', async (_label, key, mapKey) => {
        const before = state();
        const retained = engine.getSessionCheckpoint(key)!;
        const allCheckpoints = db.raw.prepare('SELECT * FROM session_checkpoints ORDER BY conversation_key').all();
        const startupSpawn = vi.spyOn(SessionManager.prototype, 'spawnSession');
        await runtime.start();
        expect.soft(state()).toEqual(before);
        expect.soft(db.raw.prepare('SELECT * FROM session_checkpoints ORDER BY conversation_key').all()).toEqual(allCheckpoints);
        expect(startupSpawn).not.toHaveBeenCalled();
        const v = runtime as unknown as RuntimeView;
        expect(v.chatSessions.size).toBe(0);
        v.ensureSessionAndQueueSync(GROUP, mapKey);
        const session = v.chatSessions.get(mapKey)!;
        const row = before.rows.find((r) => (r as {workspace_key:string}).workspace_key === key) as {id:number};
        await v.sendTurnToSession(session, GROUP, 'fixture requested continuation', mapKey);
        expect.soft(startupSpawn).toHaveBeenCalledExactlyOnceWith(retained.session_id, row.id);
        expect.soft(session.getDbRowId()).toBe(row.id);
        expect.soft(engine.getSessionCheckpoint(key)).toMatchObject({session_id:retained.session_id, transcript_path:retained.transcript_path});
        expect(state().rows.filter((r) => (r as {workspace_key:string}).workspace_key !== key))
          .toEqual(before.rows.filter((r) => (r as {workspace_key:string}).workspace_key !== key));
        expect(state().checkpoints.filter((r) => (r as {conversation_key:string}).conversation_key !== key))
          .toEqual(before.checkpoints.filter((r) => (r as {conversation_key:string}).conversation_key !== key));
        expect(state().inbound).toEqual(before.inbound);
      });

    it.each([['authoritative_live', 'opencode-cli'], ['ambiguous', 'unknown-provider']])(
      'leaves an existing %s group owner in place without starting a second manager', async (classification, provider) => {
        db.raw.prepare("UPDATE agent_sessions SET status='active',provider=? WHERE workspace_key=?").run(provider, SCHEDULED);
        if (classification === 'ambiguous') {
          db.raw.prepare('UPDATE agent_sessions SET claude_pid=987654 WHERE workspace_key=?').run(SCHEDULED);
          vi.spyOn(process, 'kill').mockReturnValue(true);
        }
        expect(classifyActiveSessions(db, engine).find((row) => row.conversationKey === SCHEDULED)?.classification).toBe(classification);
        const before = state(); const spawnSpy = vi.spyOn(SessionManager.prototype, 'spawnSession');
        await runtime.start();
        expect.soft(state()).toEqual(before);
        expect(spawnSpy).not.toHaveBeenCalled();
        expect((runtime as unknown as RuntimeView).chatSessions.size).toBe(0);
      });

    it('preserves stale group context for requested continuation while retaining the stale direct-chat policy', async () => {
      db.raw.prepare("UPDATE session_checkpoints SET updated_at=datetime('now','-2 hours')").run();
      db.raw.prepare("UPDATE agent_sessions SET status='suspended' WHERE workspace_key=?").run(ADJACENT);
      const groups = db.raw.prepare('SELECT * FROM session_checkpoints WHERE conversation_key IN (?,?) ORDER BY conversation_key').all(ORDINARY, SCHEDULED);
      const spawnSpy = vi.spyOn(SessionManager.prototype, 'spawnSession');
      await runtime.start();
      expect.soft(db.raw.prepare('SELECT * FROM session_checkpoints WHERE conversation_key IN (?,?) ORDER BY conversation_key').all(ORDINARY, SCHEDULED)).toEqual(groups);
      expect(engine.getSessionCheckpoint(ADJACENT)?.session_status).toBe('ended');
      expect(spawnSpy).not.toHaveBeenCalled();
    });

    it.each([['ordinary', ORDINARY, GROUP], ['scheduled', SCHEDULED, SCHEDULED]])(
      'retains invalid %s group identity at startup but rejects its requested turn before any lifecycle change', async (_label, key, mapKey) => {
        db.raw.prepare('UPDATE session_checkpoints SET completed_delivery_jid=? WHERE conversation_key=?')
          .run('15550009999@s.whatsapp.net', key);
        const before = state();
        const invalidCheckpoint = engine.getSessionCheckpoint(key)!;
        const spawnSpy = vi.spyOn(SessionManager.prototype, 'spawnSession');
        await runtime.start();
        expect.soft(state()).toEqual(before);
        expect.soft(engine.getSessionCheckpoint(key)).toEqual(invalidCheckpoint);
        expect(spawnSpy).not.toHaveBeenCalled();
        const v = runtime as unknown as RuntimeView;
        v.ensureSessionAndQueueSync(GROUP, mapKey);
        const session = v.chatSessions.get(mapKey)!;
        const shutdownSpy = vi.spyOn(session, 'shutdown');
        const queue = v.chatQueues.get(mapKey)!;
        await expect(v.sendTurnToSession(session, GROUP, 'fixture requested invalid identity', mapKey))
          .rejects.toThrow('Retained checkpoint is not admissible');
        expect(spawnSpy).not.toHaveBeenCalled();
        expect(shutdownSpy).not.toHaveBeenCalled();
        expect(queue.flush).not.toHaveBeenCalled();
        expect.soft(engine.getSessionCheckpoint(key)).toEqual(invalidCheckpoint);
        expect.soft(state()).toEqual(before);
      });

    it('is a no-op for already healthy logical owners in both namespaces', async () => {
      db.raw.prepare("UPDATE agent_sessions SET status='active'").run();
      const classified = classifyActiveSessions(db, engine);
      expect(classified).toHaveLength(3);
      expect(classified.every((row) => row.classification === 'authoritative_live')).toBe(true);
      expect(new Set(classified.map((row) => row.conversationKey))).toEqual(new Set([ORDINARY, SCHEDULED, ADJACENT]));
      const before = state(); const spawnSpy = vi.spyOn(SessionManager.prototype, 'spawnSession');
      await runtime.start();
      expect(state()).toEqual(before); expect(spawnSpy).not.toHaveBeenCalled();
      expect((runtime as unknown as RuntimeView).chatSessions.size).toBe(0);
    });
  });

  it('a fresh ordinary context preserves scheduled and adjacent records without replay', async () => {
    engine.upsertSessionCheckpoint(ORDINARY, {sessionStatus:'ended'});
    await runtime.start(); const before = state(); const v = runtime as unknown as RuntimeView;
    v.ensureSessionAndQueueSync(GROUP,GROUP); const session = v.chatSessions.get(GROUP)!;
    await v.sendTurnToSession(session,GROUP,'fixture fresh ordinary turn',GROUP);
    expect(engine.getSessionCheckpoint(ORDINARY)?.session_id).toBeNull();
    expect(state().rows.slice(0,before.rows.length)).toEqual(before.rows);
    expect(state().inbound).toEqual(before.inbound);
    expect(state().checkpoints.filter((x) => (x as {conversation_key:string}).conversation_key !== ORDINARY))
      .toEqual(before.checkpoints.filter((x) => (x as {conversation_key:string}).conversation_key !== ORDINARY));
  });
  it.each([['scheduled', SCHEDULED, GROUP], ['adjacent', ADJACENT, ADJACENT + '@s.whatsapp.net']])(
    'proactive=false resumes the exact retained %s context on the next turn', async (_label,key,jid) => {
      await runtime.start(); const before = state();
      const old = engine.getSessionCheckpoint(key)!;
      const v = runtime as unknown as RuntimeView; const mapKey=key===SCHEDULED?SCHEDULED:jid; v.ensureSessionAndQueueSync(jid,mapKey);
      const session = v.chatSessions.get(mapKey)!;
      const spawnSpy = vi.spyOn(session,'spawnSession');
      await v.sendTurnToSession(session,jid,'fixture user turn',mapKey);
      expect.soft(engine.getSessionCheckpoint(key)?.session_id, 'retained SQLite checkpoint SID must survive lazy resume').toBe(old.session_id);
      expect.soft(session.getDbRowId(), 'lazy resume must reactivate an existing row').toBe((before.rows.find((r) => (r as {workspace_key:string}).workspace_key === key) as {id:number}).id);
      expect.soft(spawnSpy).toHaveBeenCalledWith(old.session_id, expect.any(Number));
      expect(state().inbound).toEqual(before.inbound);
      expect(state().checkpoints.filter((x) => (x as {conversation_key:string}).conversation_key !== key))
        .toEqual(before.checkpoints.filter((x) => (x as {conversation_key:string}).conversation_key !== key));
    });
  it.each(['active row', 'foreign provider', 'wrong namespace', 'invalid delivery', 'quarantined', 'duplicate row', 'other active namespace', 'missing route policy'])('rejects %s without replacing retained context', async (kind) => {
    if (kind === 'missing route policy') db.raw.prepare('UPDATE session_checkpoints SET watchdog_state=NULL WHERE conversation_key=?').run(ADJACENT);
    if (kind === 'active row') db.raw.prepare("UPDATE agent_sessions SET status='active' WHERE workspace_key=?").run(ADJACENT);
    if (kind === 'foreign provider') db.raw.prepare("UPDATE agent_sessions SET provider='claude-cli' WHERE workspace_key=?").run(ADJACENT);
    if (kind === 'wrong namespace') db.raw.prepare("UPDATE agent_sessions SET workspace_key='other' WHERE workspace_key=?").run(ADJACENT);
    if (kind === 'invalid delivery') db.raw.prepare("UPDATE session_checkpoints SET completed_delivery_jid='999@s.whatsapp.net' WHERE conversation_key=?").run(ADJACENT);
    if (kind === 'quarantined') engine.quarantineCompletedDeliveryIdentityCheckpoint({conversationKey:ADJACENT,providerSessionId:'adjacent-retained',provider:'opencode-cli',reason:'invalid'});
    if (kind === 'other active namespace') db.raw.prepare("INSERT INTO agent_sessions(session_id,claude_pid,started_in_directory,chat_jid,workspace_key,started_at,status,provider) SELECT session_id,claude_pid,started_in_directory,chat_jid,'other-namespace',started_at,'active',provider FROM agent_sessions WHERE workspace_key=?").run(ADJACENT);
    if (kind === 'duplicate row') db.raw.prepare("INSERT INTO agent_sessions(session_id,claude_pid,started_in_directory,chat_jid,workspace_key,started_at,status,provider) SELECT session_id,claude_pid,started_in_directory,chat_jid,workspace_key,started_at,'active',provider FROM agent_sessions WHERE workspace_key=?").run(ADJACENT);
    await runtime.start(); const before=state(); const v=runtime as unknown as RuntimeView;
    const jid=ADJACENT+'@s.whatsapp.net'; v.ensureSessionAndQueueSync(jid,jid);
    const session=v.chatSessions.get(jid)!; const spy=vi.spyOn(session,'spawnSession');
    await expect(v.sendTurnToSession(session,jid,'fixture turn',jid)).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled(); expect(state()).toEqual(before);
  });
  it('surfaces an admitted resume failure without retrying fresh or rewriting state', async () => {
    await runtime.start(); const before=state(); const v=runtime as unknown as RuntimeView;
    const jid=ADJACENT+'@s.whatsapp.net';v.ensureSessionAndQueueSync(jid,jid);
    const session=v.chatSessions.get(jid)!;
    const spy=vi.spyOn(session,'spawnSession').mockRejectedValue(new Error('fixture resume rejected'));
    await expect(v.sendTurnToSession(session,jid,'fixture turn',jid)).rejects.toThrow('fixture resume rejected');
    expect(spy).toHaveBeenCalledExactlyOnceWith('adjacent-retained',2);expect(state()).toEqual(before);
  });

  it.each([['ordinary', ADJACENT, ADJACENT + '@s.whatsapp.net'], ['scheduled', SCHEDULED, GROUP]])(
    'preserves retained %s context on same-manager retry after actual ENOENT lifecycle closure', async (_label, key, jid) => {
      await runtime.start();
      const v = runtime as unknown as RuntimeView;
      const mapKey = key === SCHEDULED ? SCHEDULED : jid;
      v.ensureSessionAndQueueSync(jid, mapKey);
      const session = v.chatSessions.get(mapKey)!;
      const retained = engine.getSessionCheckpoint(key)!;
      const spawnSessionSpy = vi.spyOn(session, 'spawnSession');
      const shutdownSpy = vi.spyOn(session, 'shutdown');
      const child = Object.assign(new EventEmitter(), {
        pid: 987654,
        stdin: Object.assign(new EventEmitter(), { write: vi.fn(() => true), end: vi.fn() }),
        stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
        stderr: new EventEmitter(),
        kill: vi.fn(() => true), exitCode: null, signalCode: null,
      });
      vi.mocked(SessionManager.prototype.sendTurnAtProviderBoundary).mockRestore();
      vi.mocked(spawn).mockReturnValueOnce(child as never);
      expectedMockSpawnCalls = 1;
      await v.sendTurnToSession(session, jid, 'fixture first turn', mapKey);
      const rowId = session.getDbRowId()!;
      expect(spawnSessionSpy).toHaveBeenCalledExactlyOnceWith(retained.session_id, rowId);
      expect(db.raw.prepare('SELECT status FROM agent_sessions WHERE id=?').get(rowId)).toEqual({status:'active'});
      expect(child.listenerCount('error')).toBeGreaterThan(0);
      child.emit('error', Object.assign(new Error('fixture missing executable'), { code: 'ENOENT' }));
      expect(db.raw.prepare('SELECT status FROM agent_sessions WHERE id=?').get(rowId)).toEqual({status:'crashed'});
      expect(session.getStatus()).toMatchObject({active:false,durableFailureClosed:true,sessionId:null,pid:null});
      const failedCheckpoint = engine.getSessionCheckpoint(key)!;
      expect(failedCheckpoint).toMatchObject({session_status:'orphaned',session_id:retained.session_id,
        completed_inbound_seq:retained.completed_inbound_seq,completed_delivery_jid:retained.completed_delivery_jid,
        completed_manager_id:retained.completed_manager_id,completed_generation:retained.completed_generation,
        transcript_path:retained.transcript_path});
      expect(v.chatSessions.get(mapKey)).toBe(session);
      const beforeRetry = state();
      const providerRetry = vi.spyOn(SessionManager.prototype, 'sendTurnAtProviderBoundary').mockResolvedValue(undefined);
      await expect.soft(v.sendTurnToSession(session, jid, 'fixture retry', mapKey)).rejects.toThrow();
      expect.soft(spawnSessionSpy).toHaveBeenCalledTimes(1);
      expect.soft(shutdownSpy).not.toHaveBeenCalled();
      expect.soft(providerRetry).not.toHaveBeenCalled();
      expect.soft(engine.getSessionCheckpoint(key)).toEqual(failedCheckpoint);
      expect.soft(state()).toEqual(beforeRetry);
      expect(child.kill).not.toHaveBeenCalled();
    });

  it.each(['closing', 'next generation'] as const)('rejects a %s owner before retained-context adoption', async (transition) => {
    await runtime.start(); const v = runtime as unknown as RuntimeView;
    const jid = ADJACENT + '@s.whatsapp.net';v.ensureSessionAndQueueSync(jid,jid);
    const session = v.chatSessions.get(jid)!;const owner = v.sessionOwnership.get(jid)!;
    if (transition === 'closing') v.sessionOwnership.transition(jid,owner.managerId,'closing');
    else v.sessionOwnership.advanceGeneration(jid,owner.managerId);
    const before = state();const spy = vi.spyOn(session,'spawnSession');
    await expect(v.sendTurnToSession(session,jid,'fixture retained turn',jid)).rejects.toThrow('newly claimed');
    expect(spy).not.toHaveBeenCalled();expect(state()).toEqual(before);
  });

});
