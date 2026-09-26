import type { SessionOwnershipRegistry } from '../../../src/runtimes/agent/session-ownership.ts';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Messenger, IncomingMessage } from '../../../src/core/types.ts';

// Lazy per-chat checkpoint adoption (#3530 successor; owner decisions 15 part 2 and 65).
// Scaffold follows the #3530 draft's q-restart-context-preservation suite: a real
// SQLite database and DurabilityEngine, a managed-loop provider (no child process),
// and the provider boundary stubbed so a turn never reaches a model.

const { makeQueueDouble } = vi.hoisted(() => {
  function makeQueueDouble(chatJid: string) {
    return {
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
        turnId, answerOpIds: [], lifecycleOpIds: [], statusOpIds: [],
      })),
      setToolUpdateMode: vi.fn(),
      setToolUpdateRedirectJid: vi.fn(),
      setTextAggregateDelayMs: vi.fn(),
      enqueuePoll: vi.fn(async (fn: () => Promise<void>) => { await fn(); }),
      hasPendingPoll: vi.fn(() => false),
      setPollPending: vi.fn(),
      endTurn: vi.fn(),
      getLastOpId: vi.fn(() => undefined),
      setDurability: vi.fn(),
    };
  }
  return { makeQueueDouble };
});

const { mockConfig, recentMessages } = vi.hoisted(() => ({
  recentMessages: { rows: [] as unknown[] },
  mockConfig: {
    agentProvider: 'opencode-cli',
    fallbackTunables: { noticeDedupMs: 1_800_000, primaryRecheckMs: 300_000, probeStallThreshold: 12, probeStallCeilingMultiple: 10 },
    adminPhones: new Set<string>(['15550001']),
    controlPeers: new Map<string, string>(),
    internalPeerJids: new Set<string>(),
    toolUpdateMode: 'full' as const,
    toolUpdateRedirectJid: null as string | null,
    textAggregateDelayMs: 2_000,
    stateRoot: `/tmp/whatsoup-test-state-lazy-adoption-${process.pid}`,
    restartLoopGuard: { enabled: false, maxRestarts: 3, windowMs: 300_000 },
    startupNotifications: false,
    proactiveResumeOnStartup: false,
    mediaDir: `/tmp/whatsoup-test-media-lazy-adoption-${process.pid}`,
    pineconeAllowedIndexes: [] as string[],
    voiceReply: 'never' as const,
    elevenlabs: { defaultVoiceId: 'v', defaultModel: 'm', stability: 0.5, similarityBoost: 0.75 },
    memory: { adminJid: 'admin@s.whatsapp.net' },
  },
}));

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
  getRecentMessages: vi.fn(() => recentMessages.rows),
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
  OutboundQueue: vi.fn().mockImplementation(function (_messenger: unknown, chatJid: string) {
    return makeQueueDouble(chatJid);
  }),
}));

vi.mock('../../../src/config.ts', () => ({ config: mockConfig }));

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
  WhatSoupSocketServer: vi.fn().mockImplementation(function (_p: string, _r: unknown, session: unknown) {
    return {
      session, start: vi.fn(), stop: vi.fn(), updateDeliveryJid: vi.fn(),
      updateActorJid: vi.fn(), updateConversationKey: vi.fn(),
    };
  }),
}));

vi.mock('../../../src/mcp/register-all.ts', () => ({ registerAllTools: vi.fn() }));

vi.mock('../../../src/runtimes/agent/media-bridge.ts', () => ({
  startMediaBridge: vi.fn(() => null),
  setMediaBridgeChat: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs');
  return { ...actual, mkdirSync: vi.fn(), writeFileSync: vi.fn() };
});

vi.mock('node:child_process', () => {
  const forbidden = () => vi.fn(() => { throw new Error('external process forbidden'); });
  return { spawn: forbidden(), spawnSync: forbidden(), exec: forbidden(), execSync: forbidden(), execFile: forbidden(), execFileSync: forbidden() };
});
vi.mock('../../../src/runtimes/agent/process-tree.ts', () => ({ killSessionTree: vi.fn(async () => { throw new Error('external kill forbidden'); }) }));

vi.mock('../../../src/core/provider-mcp-config.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/core/provider-mcp-config.ts')>(),
  writeProviderMcpConfig: vi.fn(() => '/fixture/mcp.json'),
}));

import { spawn } from 'node:child_process';
import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import { SessionManager } from '../../../src/runtimes/agent/session.ts';
import { installFakePerChatMcpSocketManager } from './helpers/fake-per-chat-mcp-socket-manager.ts';
import { ownedRuntimeCwd } from '../../helpers/runtime-home-fixture.ts';

const PHONE = '15550001234';
const JID = PHONE + '@s.whatsapp.net';
const SCHEDULED = JID + '::scheduled-agent-job';
const OWN_SID = 'ses_fixtureOwnContext';
const SCHEDULED_SID = 'ses_fixtureScheduledContext';
const NOT_RESTORED = '_Previous session could not be restored_ — continuing from recent messages.';

type RuntimeView = {
  chatSessions: Map<string, SessionManager>;
  sessionOwnership: SessionOwnershipRegistry;
  ensureSessionAndQueueSync(jid: string, key: string): void;
  sendTurnToSession(s: SessionManager, jid: string, text: string, key: string): Promise<void>;
  sendDirect(jid: string, text: string): void;
  fallback: { schedulePrimaryModelUsabilityProbe: (...a: unknown[]) => void; scheduleNextPeriodicUsabilityProbe: () => void; startChainCanary: () => void };
};

describe('lazy per-chat checkpoint adoption (#3530 successor)', () => {
  let db: Database;
  let engine: DurabilityEngine;
  let runtime: AgentRuntime;
  let messenger: Messenger;
  let view: RuntimeView;
  let notices: ReturnType<typeof vi.fn<(jid: string, text: string) => void>>;
  let providerSend: ReturnType<typeof vi.spyOn>;

  function insertRow(sessionId: string, workspaceKey: string, status: string): number {
    const info = db.raw.prepare(`INSERT INTO agent_sessions(session_id,claude_pid,started_in_directory,chat_jid,workspace_key,started_at,status,provider)
      VALUES (?,0,'/fixture',?,?,datetime('now'),?,'opencode-cli')`).run(sessionId, JID, workspaceKey, status);
    return Number(info.lastInsertRowid);
  }
  function writeCheckpoint(key: string, sid: string) {
    const seq = engine.journalInbound('fixture-' + key + '-' + sid, key, JID, 'agent');
    engine.upsertSessionCheckpoint(key, {
      sessionId: sid, sessionStatus: 'suspended', lastInboundSeq: seq,
      transcriptPath: '/fixture/transcript-' + sid,
      watchdogState: JSON.stringify({ providerRoutePolicy: { provider: 'opencode-cli', model: 'opencode/big-pickle', dataPolicy: null, policyVersion: 'provider-data-policy-v1' } }),
      completedInboundSeq: seq, completedDeliveryJid: JID, completedDeliveryNamespace: 's.whatsapp.net',
      completedScope: 'per_chat', completedLogicalTurnId: 'turn-' + sid,
      completedManagerId: 'manager-' + sid, completedGeneration: 1,
    });
  }
  function rows() {
    return db.raw.prepare('SELECT id,session_id,workspace_key,status FROM agent_sessions ORDER BY id').all();
  }
  async function firstTurn(text = 'fixture user turn') {
    view.ensureSessionAndQueueSync(JID, JID);
    const session = view.chatSessions.get(JID)!;
    const spawnSpy = vi.spyOn(session, 'spawnSession');
    await view.sendTurnToSession(session, JID, text, JID);
    return { session, spawnSpy };
  }

  beforeEach(async () => {
    vi.clearAllMocks(); vi.useFakeTimers();
    recentMessages.rows = [];
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('external fetch forbidden'); }));
    db = new Database(':memory:'); db.open(); engine = new DurabilityEngine(db);
    messenger = { sendMessage: vi.fn(async () => { throw new Error('transport send forbidden'); }), sendMedia: vi.fn(async () => { throw new Error('transport media forbidden'); }) };
    const cwd = await ownedRuntimeCwd('lazy-checkpoint-adoption');
    runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat', model: 'opencode/big-pickle', cwd });
    installFakePerChatMcpSocketManager(runtime); runtime.setDurability(engine);
    view = runtime as unknown as RuntimeView;
    vi.spyOn(view.fallback, 'schedulePrimaryModelUsabilityProbe').mockImplementation(() => {});
    vi.spyOn(view.fallback, 'scheduleNextPeriodicUsabilityProbe').mockImplementation(() => {});
    vi.spyOn(view.fallback, 'startChainCanary').mockImplementation(() => {});
    providerSend = vi.spyOn(SessionManager.prototype, 'sendTurnAtProviderBoundary').mockResolvedValue(undefined);
    notices = vi.fn<(jid: string, text: string) => void>();
    (runtime as unknown as { sendDirect: (jid: string, text: string) => void }).sendDirect = notices;
    await runtime.start();
  });
  afterEach(async () => {
    if (runtime) await runtime.shutdown();
    expect(spawn).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(messenger.sendMessage).not.toHaveBeenCalled(); expect(messenger.sendMedia).not.toHaveBeenCalled();
    db.close(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  });

  describe('decision 15 part 2: own session vs another session', () => {
    it('resumes the chat\'s own suspended session on the first turn after a restart', async () => {
      const ownRow = insertRow(OWN_SID, PHONE, 'suspended');
      writeCheckpoint(PHONE, OWN_SID);
      const { spawnSpy } = await firstTurn();
      expect(spawnSpy).toHaveBeenCalledExactlyOnceWith(OWN_SID, ownRow);
      expect(notices).not.toHaveBeenCalled();
    });

    it('never adopts a checkpoint that names another namespace\'s session and recovers the chat\'s own session', async () => {
      const ownRow = insertRow(OWN_SID, PHONE, 'suspended');
      insertRow(SCHEDULED_SID, SCHEDULED, 'suspended');
      writeCheckpoint(PHONE, SCHEDULED_SID);
      const { spawnSpy } = await firstTurn();
      expect(spawnSpy).toHaveBeenCalledExactlyOnceWith(OWN_SID, ownRow);
      expect(spawnSpy).not.toHaveBeenCalledWith(SCHEDULED_SID, expect.anything());
      expect(notices).not.toHaveBeenCalled();
      // Repaired: the chat's checkpoint names its own session, and the
      // scheduled turn's completed identity no longer describes the chat.
      expect(engine.getSessionCheckpoint(PHONE)).toMatchObject({
        session_id: OWN_SID, completed_logical_turn_id: null, completed_inbound_seq: null,
      });
    });

    it('starts fresh with a notice when the foreign checkpoint leaves the chat no session of its own', async () => {
      insertRow(SCHEDULED_SID, SCHEDULED, 'suspended');
      writeCheckpoint(PHONE, SCHEDULED_SID);
      const before = rows();
      const { spawnSpy } = await firstTurn();
      expect(spawnSpy).toHaveBeenCalledExactlyOnceWith();
      expect(notices).toHaveBeenCalledExactlyOnceWith(JID, NOT_RESTORED);
      expect(rows().filter((r) => (r as { workspace_key: string }).workspace_key === SCHEDULED))
        .toEqual(before.filter((r) => (r as { workspace_key: string }).workspace_key === SCHEDULED));
    });
  });

  describe('decision 65 O3: an own-namespace checkpoint with no resumable row starts fresh with a notice and recovers context', () => {
    function storedMessage(content: string) {
      return {
        pk: 1, chatJid: JID, conversationKey: PHONE, senderJid: JID, senderName: 'Test User',
        messageId: 'stored-' + content, content, contentType: 'text', isFromMe: false,
        timestamp: Math.floor(Date.now() / 1000) - 60, quotedMessageId: null,
        enrichmentProcessedAt: null, enrichmentRetries: 0, createdAt: new Date().toISOString(),
        mediaPath: null, contentText: content,
      };
    }
    function providerTurnText(): string {
      return JSON.stringify(providerSend.mock.calls);
    }

    it('a missing same-namespace row gives a notice and recovers context', async () => {
      writeCheckpoint(PHONE, OWN_SID);
      recentMessages.rows = [storedMessage('fixture earlier question about the invoice')];
      const { spawnSpy } = await firstTurn();
      expect(spawnSpy).toHaveBeenCalledExactlyOnceWith();
      expect(notices).toHaveBeenCalledExactlyOnceWith(JID, NOT_RESTORED);
      expect(providerTurnText()).toContain('fixture earlier question about the invoice');
    });

    it('an own row that is no longer resumable gives a notice and recovers context', async () => {
      insertRow(OWN_SID, PHONE, 'crashed');
      writeCheckpoint(PHONE, OWN_SID);
      recentMessages.rows = [storedMessage('fixture earlier question about the lease')];
      const { spawnSpy } = await firstTurn();
      expect(spawnSpy).toHaveBeenCalledExactlyOnceWith();
      expect(notices).toHaveBeenCalledExactlyOnceWith(JID, NOT_RESTORED);
      expect(providerTurnText()).toContain('fixture earlier question about the lease');
    });

    it('a resume refused at spawn falls back to a fresh session with a notice and recovered context', async () => {
      const ownRow = insertRow(OWN_SID, PHONE, 'suspended');
      writeCheckpoint(PHONE, OWN_SID);
      recentMessages.rows = [storedMessage('fixture earlier question about the deposit')];
      view.ensureSessionAndQueueSync(JID, JID);
      const session = view.chatSessions.get(JID)!;
      const realSpawn = session.spawnSession.bind(session);
      const spawnSpy = vi.spyOn(session, 'spawnSession').mockImplementation(async (resumeId?: string, rowId?: number) => {
        if (resumeId !== undefined) throw new Error('fixture resume refused');
        return realSpawn(resumeId, rowId);
      });
      await view.sendTurnToSession(session, JID, 'fixture user turn', JID);
      expect(spawnSpy.mock.calls).toEqual([[OWN_SID, ownRow], []]);
      expect(notices).toHaveBeenCalledExactlyOnceWith(JID, NOT_RESTORED);
      expect(providerTurnText()).toContain('fixture earlier question about the deposit');
    });
  });

  describe('decision 65 O4: an ambiguous live owner fails closed with a notice', () => {
    const MAY_BE_RUNNING = '_This chat\'s previous session may still be running_ — not starting a second one. Try again in a few minutes.';
    const cases: Array<[string, () => void]> = [
      ['active row', () => { insertRow(OWN_SID, PHONE, 'active'); }],
      ['duplicate row', () => { insertRow(OWN_SID, PHONE, 'suspended'); insertRow(OWN_SID, PHONE, 'suspended'); }],
      ['other active namespace', () => { insertRow(OWN_SID, PHONE, 'suspended'); insertRow(OWN_SID, 'other-namespace', 'active'); }],
    ];

    it.each(cases)('%s: no spawn, no second live session, and a notice', async (_label, arrange) => {
      arrange();
      writeCheckpoint(PHONE, OWN_SID);
      const beforeRows = rows();
      const beforeCheckpoint = engine.getSessionCheckpoint(PHONE);
      view.ensureSessionAndQueueSync(JID, JID);
      const session = view.chatSessions.get(JID)!;
      const spawnSpy = vi.spyOn(session, 'spawnSession');
      await expect(view.sendTurnToSession(session, JID, 'fixture user turn', JID))
        .rejects.toThrow('CHECKPOINT_ADOPTION_REFUSED');
      expect(spawnSpy).not.toHaveBeenCalled();
      expect(providerSend).not.toHaveBeenCalled();
      expect(notices).toHaveBeenCalledExactlyOnceWith(JID, MAY_BE_RUNNING);
      expect([...view.chatSessions.values()].filter((s) => s.getStatus().active)).toEqual([]);
      expect(rows()).toEqual(beforeRows);
      expect(engine.getSessionCheckpoint(PHONE)).toEqual(beforeCheckpoint);
    });

    it('scope pin: an active row that exists only in another namespace is a foreign checkpoint, not a live owner of this chat', async () => {
      insertRow(SCHEDULED_SID, SCHEDULED, 'active');
      writeCheckpoint(PHONE, SCHEDULED_SID);
      const { spawnSpy } = await firstTurn();
      expect(spawnSpy).toHaveBeenCalledExactlyOnceWith();
      expect(notices).toHaveBeenCalledExactlyOnceWith(JID, NOT_RESTORED);
    });
  });
});
