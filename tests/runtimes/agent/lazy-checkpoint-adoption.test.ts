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
  sendTurnToSession(
    s: SessionManager, jid: string, text: string, key: string, actorJid?: string, beforeUserSend?: () => void,
    systemTurnLease?: undefined, dispatchAllowed?: () => boolean, runtimeContext?: undefined, deliveryKind?: undefined,
    purpose?: 'scheduled-agent-job',
  ): Promise<void>;
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
    // Every cleanup step runs and every failure is reported, so one failed
    // case cannot leak timers, stubs or spies into the next, and a later
    // cleanup error cannot hide an earlier one.
    const failures: unknown[] = [];
    const step = async (run: () => unknown): Promise<void> => {
      try { await run(); } catch (err) { failures.push(err); }
    };
    await step(async () => { if (runtime) await runtime.shutdown(); });
    await step(() => {
      expect(spawn).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
      expect(messenger.sendMessage).not.toHaveBeenCalled(); expect(messenger.sendMedia).not.toHaveBeenCalled();
    });
    for (const cleanup of [() => db.close(), () => vi.useRealTimers(), () => vi.unstubAllGlobals(), () => vi.restoreAllMocks()]) {
      await step(cleanup);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'lazy-checkpoint-adoption cleanup failed in several steps');
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
      expect(spawnSpy.mock.calls.flat()).not.toContain(SCHEDULED_SID);
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
      expect(notices).toHaveBeenCalledExactlyOnceWith(JID, NOT_RESTORED, 'status');
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
      expect(notices).toHaveBeenCalledExactlyOnceWith(JID, NOT_RESTORED, 'status');
      expect(providerTurnText()).toContain('fixture earlier question about the invoice');
    });

    it('an own row that is no longer resumable gives a notice and recovers context', async () => {
      insertRow(OWN_SID, PHONE, 'crashed');
      writeCheckpoint(PHONE, OWN_SID);
      recentMessages.rows = [storedMessage('fixture earlier question about the lease')];
      const { spawnSpy } = await firstTurn();
      expect(spawnSpy).toHaveBeenCalledExactlyOnceWith();
      expect(notices).toHaveBeenCalledExactlyOnceWith(JID, NOT_RESTORED, 'status');
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
      expect(notices).toHaveBeenCalledExactlyOnceWith(JID, NOT_RESTORED, 'status');
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
      expect(notices).toHaveBeenCalledExactlyOnceWith(JID, MAY_BE_RUNNING, 'status');
      expect([...view.chatSessions.values()].filter((s) => s.getStatus().active)).toEqual([]);
      expect(rows()).toEqual(beforeRows);
      expect(engine.getSessionCheckpoint(PHONE)).toEqual(beforeCheckpoint);
    });

    it('through the real admission path: the refused turn terminalizes, is not queued for replay, and the chat keeps serving', async () => {
      insertRow(OWN_SID, PHONE, 'active');
      writeCheckpoint(PHONE, OWN_SID);
      const seq = engine.journalInbound('fixture-o4-admitted', PHONE, JID, 'agent');
      const inboundStatus = () => (db.raw.prepare('SELECT processing_status FROM inbound_events WHERE seq = ?')
        .get(seq) as { processing_status: string }).processing_status;
      void runtime.handleMessage({
        messageId: 'fixture-o4-admitted', chatJid: JID, senderJid: JID, senderName: 'Test User',
        content: 'fixture o4 question', contentText: null, contentType: 'text', isFromMe: false,
        isGroup: false, mentionedJids: [], timestamp: Date.now(), quotedMessageId: null,
        isResponseWorthy: true, inboundSeq: seq,
      });
      await vi.waitFor(() => expect(inboundStatus()).not.toBe('processing'), { timeout: 4_000 });
      // Terminal, not replayed, no halt or crash signal, one specific notice.
      expect(inboundStatus()).toBe('failed');
      expect(db.raw.prepare('SELECT state FROM turn_recovery_jobs WHERE source_inbound_seq = ?').all(seq)).toEqual([]);
      expect((runtime.getHealthSnapshot().details as { degradedReasons?: string[] }).degradedReasons).toEqual([]);
      expect(notices.mock.calls).toEqual([[JID, MAY_BE_RUNNING, 'status']]);
      expect(providerSend).not.toHaveBeenCalled();
      const queue = (runtime as unknown as { chatQueues: Map<string, ReturnType<typeof makeQueueDouble>> }).chatQueues.get(JID)!;
      expect(queue.enqueueText).not.toHaveBeenCalled();

      // Once the ambiguity clears (the live owner suspended), the same chat serves again.
      db.raw.prepare("UPDATE agent_sessions SET status = 'suspended' WHERE session_id = ?").run(OWN_SID);
      const next = engine.journalInbound('fixture-o4-after', PHONE, JID, 'agent');
      void runtime.handleMessage({
        messageId: 'fixture-o4-after', chatJid: JID, senderJid: JID, senderName: 'Test User',
        content: 'fixture o4 follow-up', contentText: null, contentType: 'text', isFromMe: false,
        isGroup: false, mentionedJids: [], timestamp: Date.now(), quotedMessageId: null,
        isResponseWorthy: true, inboundSeq: next,
      });
      await vi.waitFor(() => expect(providerSend).toHaveBeenCalledTimes(1), { timeout: 4_000 });
      expect(view.chatSessions.get(JID)!.getDbRowId()).toBe(1);
      expect(notices).toHaveBeenCalledTimes(1);
    });

    it('scope pin: an active row that exists only in another namespace is a foreign checkpoint, not a live owner of this chat', async () => {
      // Pins scope only: passes before and after the O4 change.
      insertRow(SCHEDULED_SID, SCHEDULED, 'active');
      writeCheckpoint(PHONE, SCHEDULED_SID);
      const { spawnSpy } = await firstTurn();
      expect(spawnSpy).toHaveBeenCalledExactlyOnceWith();
      expect(notices).toHaveBeenCalledExactlyOnceWith(JID, NOT_RESTORED, 'status');
    });
  });

  describe('#3658: a pre-spawn close that fails only at the lifecycle step starts fresh with a notice', () => {
    const LIFECYCLE_CLOSE_FAILED = 'Exact resumable checkpoint does not match the conversation identity';

    function managerWithFailingClose(error: unknown, key = JID) {
      view.ensureSessionAndQueueSync(JID, key);
      const session = view.chatSessions.get(key)!;
      vi.spyOn(session, 'shutdown').mockRejectedValueOnce(error);
      const spawnSpy = vi.spyOn(session, 'spawnSession');
      return { session, spawnSpy };
    }

    it('no checkpoint to adopt: the turn starts fresh with the notice and dispatches', async () => {
      const { session, spawnSpy } = managerWithFailingClose(new Error(LIFECYCLE_CLOSE_FAILED));
      await expect(view.sendTurnToSession(session, JID, 'fixture user turn', JID)).resolves.toBeUndefined();
      expect(spawnSpy).toHaveBeenCalledExactlyOnceWith();
      expect(notices).toHaveBeenCalledExactlyOnceWith(JID, NOT_RESTORED, 'status');
      expect(providerSend).toHaveBeenCalledTimes(1);
    });

    it('a resumable checkpoint is not resumed behind the failed close: fresh spawn and one notice', async () => {
      insertRow(OWN_SID, PHONE, 'suspended');
      writeCheckpoint(PHONE, OWN_SID);
      const { session, spawnSpy } = managerWithFailingClose(new Error(LIFECYCLE_CLOSE_FAILED));
      await expect(view.sendTurnToSession(session, JID, 'fixture user turn', JID)).resolves.toBeUndefined();
      expect(spawnSpy).toHaveBeenCalledExactlyOnceWith();
      expect(notices).toHaveBeenCalledExactlyOnceWith(JID, NOT_RESTORED, 'status');
      expect(providerSend).toHaveBeenCalledTimes(1);
    });

    it('an adoption that already announced the notice does not announce it twice', async () => {
      insertRow(SCHEDULED_SID, SCHEDULED, 'suspended');
      writeCheckpoint(PHONE, SCHEDULED_SID);
      const { session, spawnSpy } = managerWithFailingClose(new Error(LIFECYCLE_CLOSE_FAILED));
      await expect(view.sendTurnToSession(session, JID, 'fixture user turn', JID)).resolves.toBeUndefined();
      expect(spawnSpy).toHaveBeenCalledExactlyOnceWith();
      expect(notices).toHaveBeenCalledExactlyOnceWith(JID, NOT_RESTORED, 'status');
      expect(providerSend).toHaveBeenCalledTimes(1);
    });

    it('a real lifecycle-close failure in the pre-spawn shutdown starts fresh with one notice', async () => {
      view.ensureSessionAndQueueSync(JID, JID);
      const session = view.chatSessions.get(JID)!;
      await session.spawnSession();
      const closeSpy = vi.spyOn(engine, 'closeSessionLifecycle').mockImplementation(() => {
        throw new Error(LIFECYCLE_CLOSE_FAILED);
      });
      try {
        // The first failed close leaves the manager inactive and still holding its row.
        await expect(session.shutdown()).rejects.toThrow(LIFECYCLE_CLOSE_FAILED);
        const spawnSpy = vi.spyOn(session, 'spawnSession');

        await expect(view.sendTurnToSession(session, JID, 'fixture user turn', JID)).resolves.toBeUndefined();

        expect(closeSpy).toHaveBeenCalledTimes(2);
        expect(spawnSpy).toHaveBeenCalledExactlyOnceWith();
      } finally {
        closeSpy.mockRestore();
      }
      expect(notices).toHaveBeenCalledExactlyOnceWith(JID, NOT_RESTORED, 'status');
      expect(providerSend).toHaveBeenCalledTimes(1);
    });

    it('retires the unclosed generation\'s identity before the fallback spawn, even when that spawn is refused', async () => {
      view.ensureSessionAndQueueSync(JID, JID);
      const session = view.chatSessions.get(JID)!;
      await session.spawnSession();
      const closeSpy = vi.spyOn(engine, 'closeSessionLifecycle').mockImplementation(() => {
        throw new Error(LIFECYCLE_CLOSE_FAILED);
      });
      try {
        await expect(session.shutdown()).rejects.toThrow(LIFECYCLE_CLOSE_FAILED);
        vi.spyOn(session, 'spawnSession').mockRejectedValueOnce(new Error('fixture fresh spawn refused'));

        await expect(view.sendTurnToSession(session, JID, 'fixture user turn', JID))
          .rejects.toThrow('fixture fresh spawn refused');
      } finally {
        closeSpy.mockRestore();
      }

      expect(session.getDbRowId()).toBeNull();
      expect(session.getStatus().sessionId).toBeNull();
      expect(notices).not.toHaveBeenCalled();
    });

    it.each([
      ['admitted', false],
      ['refused', true],
    ])('the abandoned row is no longer active once the fallback spawn is %s', async (_label, refuseSpawn) => {
      view.ensureSessionAndQueueSync(JID, JID);
      const session = view.chatSessions.get(JID)!;
      await session.spawnSession();
      const abandonedRowId = session.getDbRowId();
      const closeSpy = vi.spyOn(engine, 'closeSessionLifecycle').mockImplementation(() => {
        throw new Error(LIFECYCLE_CLOSE_FAILED);
      });
      try {
        await expect(session.shutdown()).rejects.toThrow(LIFECYCLE_CLOSE_FAILED);
        if (refuseSpawn) {
          vi.spyOn(session, 'spawnSession').mockRejectedValueOnce(new Error('fixture fresh spawn refused'));
        }

        const turn = view.sendTurnToSession(session, JID, 'fixture user turn', JID);
        if (refuseSpawn) await expect(turn).rejects.toThrow('fixture fresh spawn refused');
        else await expect(turn).resolves.toBeUndefined();
      } finally {
        closeSpy.mockRestore();
      }

      expect((db.raw.prepare('SELECT status FROM agent_sessions WHERE id = ?').get(abandonedRowId) as
        { status: string }).status).toBe('ended');
    });

    it.each([
      ['reactivated by another generation', `UPDATE agent_sessions SET session_id = 'other-generation-session' WHERE id = ?`, 'active'],
      ['already reconciled by the sweep', `UPDATE agent_sessions SET status = 'crashed' WHERE id = ?`, 'crashed'],
    ])('the fallback does not end an abandoned row %s', async (_label, sql, expectedStatus) => {
      view.ensureSessionAndQueueSync(JID, JID);
      const session = view.chatSessions.get(JID)!;
      await session.spawnSession();
      const rowId = session.getDbRowId();
      const closeSpy = vi.spyOn(engine, 'closeSessionLifecycle').mockImplementation(() => {
        throw new Error(LIFECYCLE_CLOSE_FAILED);
      });
      try {
        await expect(session.shutdown()).rejects.toThrow(LIFECYCLE_CLOSE_FAILED);
        db.raw.prepare(sql).run(rowId);

        await expect(view.sendTurnToSession(session, JID, 'fixture user turn', JID)).resolves.toBeUndefined();
      } finally {
        closeSpy.mockRestore();
      }

      expect((db.raw.prepare('SELECT status FROM agent_sessions WHERE id = ?').get(rowId) as
        { status: string }).status).toBe(expectedStatus);
    });

    it('the fallback ends its own abandoned row that the stale-session sweep already orphaned', async () => {
      view.ensureSessionAndQueueSync(JID, JID);
      const session = view.chatSessions.get(JID)!;
      await session.spawnSession();
      const rowId = session.getDbRowId();
      const closeSpy = vi.spyOn(engine, 'closeSessionLifecycle').mockImplementation(() => {
        throw new Error(LIFECYCLE_CLOSE_FAILED);
      });
      try {
        await expect(session.shutdown()).rejects.toThrow(LIFECYCLE_CLOSE_FAILED);
        // The interval sweep's markOrphaned on a dead provider; 'orphaned' reads as resumable.
        db.raw.prepare(`UPDATE agent_sessions SET status = 'orphaned' WHERE id = ?`).run(rowId);

        await expect(view.sendTurnToSession(session, JID, 'fixture user turn', JID)).resolves.toBeUndefined();
      } finally {
        closeSpy.mockRestore();
      }

      expect((db.raw.prepare('SELECT status FROM agent_sessions WHERE id = ?').get(rowId) as
        { status: string }).status).toBe('ended');
    });

    it('a refused fallback on a started manager keeps its row and provider session', async () => {
      view.ensureSessionAndQueueSync(JID, JID);
      const session = view.chatSessions.get(JID)!;
      await session.spawnSession();
      const rowId = session.getDbRowId();
      const sessionId = session.getStatus().sessionId;
      const closeSpy = vi.spyOn(engine, 'closeSessionLifecycle').mockImplementation(() => {
        throw new Error(LIFECYCLE_CLOSE_FAILED);
      });
      try {
        await expect(session.shutdown()).rejects.toThrow(LIFECYCLE_CLOSE_FAILED);
        // The provider is not proven stopped, so the fallback must refuse.
        const realStatus = session.getStatus.bind(session);
        const statusSpy = vi.spyOn(session, 'getStatus').mockImplementation(() => ({
          ...realStatus(), providerTerminated: false,
        }));
        const spawnSpy = vi.spyOn(session, 'spawnSession');
        try {
          await expect(view.sendTurnToSession(session, JID, 'fixture user turn', JID))
            .rejects.toThrow(LIFECYCLE_CLOSE_FAILED);
        } finally {
          statusSpy.mockRestore();
        }
        expect(spawnSpy).not.toHaveBeenCalled();
      } finally {
        closeSpy.mockRestore();
      }

      expect(session.getDbRowId()).toBe(rowId);
      expect(session.getStatus().sessionId).toBe(sessionId);
      expect(db.raw.prepare('SELECT status, session_id FROM agent_sessions WHERE id = ?').get(rowId))
        .toMatchObject({ status: 'active', session_id: sessionId });
      expect(notices).not.toHaveBeenCalled();
    });

    it('a retirement that cannot be persisted refuses the turn and keeps the generation for its next close', async () => {
      view.ensureSessionAndQueueSync(JID, JID);
      const session = view.chatSessions.get(JID)!;
      await session.spawnSession();
      const rowId = session.getDbRowId();
      const sessionId = session.getStatus().sessionId;
      const closeSpy = vi.spyOn(engine, 'closeSessionLifecycle').mockImplementation(() => {
        throw new Error(LIFECYCLE_CLOSE_FAILED);
      });
      // Only the abandoned-row close fails; every other statement runs for real.
      const realPrepare = db.raw.prepare.bind(db.raw);
      let injectedFaults = 0;
      const prepareSpy = vi.spyOn(db.raw, 'prepare').mockImplementation((sql: string) => {
        if (sql.includes(`UPDATE agent_sessions SET status = 'ended', ended_at = ?`)) {
          injectedFaults += 1;
          throw new Error('fixture abandoned-row close failed');
        }
        return realPrepare(sql);
      });
      try {
        await expect(session.shutdown()).rejects.toThrow(LIFECYCLE_CLOSE_FAILED);
        const checkpoint = engine.getSessionCheckpoint(PHONE);
        const spawnSpy = vi.spyOn(session, 'spawnSession');

        await expect(view.sendTurnToSession(session, JID, 'fixture user turn', JID))
          .rejects.toThrow(LIFECYCLE_CLOSE_FAILED);

        // The refusal came from the failed retirement, not from a fallback refused earlier.
        expect(injectedFaults).toBe(1);
        expect(spawnSpy).not.toHaveBeenCalled();
        expect(providerSend).not.toHaveBeenCalled();
        expect(notices).not.toHaveBeenCalled();
        // Nothing was made resumable: the row and checkpoint stay as the failed close left them.
        expect(db.raw.prepare('SELECT status, session_id FROM agent_sessions WHERE id = ?').get(rowId))
          .toMatchObject({ status: 'active', session_id: sessionId });
        expect(engine.getSessionCheckpoint(PHONE)).toEqual(checkpoint);
      } finally {
        prepareSpy.mockRestore();
        closeSpy.mockRestore();
      }
      // The manager keeps the identity, so its next close can still retire the row.
      expect(session.getDbRowId()).toBe(rowId);
      expect(session.getStatus().sessionId).toBe(sessionId);
    });

    it('sends no notice when the fresh spawn after a failed close is refused', async () => {
      const { session, spawnSpy } = managerWithFailingClose(new Error(LIFECYCLE_CLOSE_FAILED));
      spawnSpy.mockRejectedValueOnce(new Error('fixture fresh spawn refused'));
      await expect(view.sendTurnToSession(session, JID, 'fixture user turn', JID))
        .rejects.toThrow('fixture fresh spawn refused');
      expect(notices).not.toHaveBeenCalled();
      expect(providerSend).not.toHaveBeenCalled();
    });

    // Host admission is opt-in (Linux only) and this suite stubs the provider
    // boundary, so a deferred start is simulated at the session contract: the
    // fresh spawnSession only records the start, and the boundary performs it.
    // One boundary per turn; the record survives a refusal, as in session.ts.
    function managerWithDeferredFreshStart(...boundaries: Array<(onReady?: () => void) => Promise<void>>) {
      const { session, spawnSpy } = managerWithFailingClose(new Error(LIFECYCLE_CLOSE_FAILED));
      let deferred = false;
      spawnSpy.mockImplementationOnce(async () => { deferred = true; });
      vi.spyOn(session, 'isHostWorkAdmissionStartDeferred').mockImplementation(() => deferred);
      const noticesAtBoundary: number[] = [];
      const boundarySpy = vi.spyOn(session, 'sendTurnAtProviderBoundary');
      for (const boundary of boundaries) {
        boundarySpy.mockImplementationOnce(async (_input, onReady) => {
          noticesAtBoundary.push(notices.mock.calls.length);
          await boundary(onReady);
        });
      }
      return { session, spawnSpy, noticesAtBoundary };
    }
    const refuseDeferredStart = async (): Promise<void> => { throw new Error('fixture deferred start refused'); };
    const admitDeferredStart = async (onReady?: () => void): Promise<void> => { onReady?.(); };

    it('a deferred fresh start the provider boundary refuses sends no notice', async () => {
      const { session, spawnSpy, noticesAtBoundary } = managerWithDeferredFreshStart(async () => {
        throw new Error('fixture deferred start refused');
      });
      await expect(view.sendTurnToSession(session, JID, 'fixture user turn', JID))
        .rejects.toThrow('fixture deferred start refused');
      expect(spawnSpy).toHaveBeenCalledExactlyOnceWith();
      expect(noticesAtBoundary).toEqual([0]);
      expect(notices).not.toHaveBeenCalled();
    });

    it('a deferred fresh start superseded at the provider boundary sends no notice', async () => {
      let allowed = true;
      const { session, noticesAtBoundary } = managerWithDeferredFreshStart(async (onReady) => {
        allowed = false;
        onReady?.();
      });
      await expect(view.sendTurnToSession(
        session, JID, 'fixture user turn', JID, undefined, undefined, undefined, () => allowed,
      )).rejects.toThrow('TURN_RECOVERY_DISPATCH_TARGET_SUPERSEDED');
      expect(noticesAtBoundary).toEqual([0]);
      expect(notices).not.toHaveBeenCalled();
    });

    it('a deferred fresh start sends its one notice only once the provider boundary admits it', async () => {
      const { session, noticesAtBoundary } = managerWithDeferredFreshStart(async (onReady) => { onReady?.(); });
      await expect(view.sendTurnToSession(session, JID, 'fixture user turn', JID)).resolves.toBeUndefined();
      expect(noticesAtBoundary).toEqual([0]);
      expect(notices).toHaveBeenCalledExactlyOnceWith(JID, NOT_RESTORED, 'status');
    });

    it('a deferred fresh start\'s notice goes out before the turn opens its answer evidence', async () => {
      // In production beforeUserSend is beginDispatchedTurn, which opens the
      // turn's evidence; a notice sent after it would count as the answer.
      const order: string[] = [];
      notices.mockImplementation(() => { order.push('notice'); });
      const { session } = managerWithDeferredFreshStart(admitDeferredStart);
      await expect(view.sendTurnToSession(
        session, JID, 'fixture user turn', JID, undefined, () => { order.push('turn evidence opens'); },
      )).resolves.toBeUndefined();
      expect(order).toEqual(['notice', 'turn evidence opens']);
    });

    it('a deferred fresh start refused at one boundary sends its notice once, at the next turn\'s boundary', async () => {
      const { session, noticesAtBoundary } = managerWithDeferredFreshStart(refuseDeferredStart, admitDeferredStart);
      await expect(view.sendTurnToSession(session, JID, 'fixture user turn', JID))
        .rejects.toThrow('fixture deferred start refused');
      await expect(view.sendTurnToSession(session, JID, 'fixture next turn', JID)).resolves.toBeUndefined();
      expect(noticesAtBoundary).toEqual([0, 0]);
      expect(notices).toHaveBeenCalledExactlyOnceWith(JID, NOT_RESTORED, 'status');
    });

    it('a deferred fresh start superseded at one boundary sends its notice once, at the next turn\'s boundary', async () => {
      let allowed = true;
      const { session, noticesAtBoundary } = managerWithDeferredFreshStart(async (onReady) => {
        allowed = false;
        onReady?.();
      }, admitDeferredStart);
      await expect(view.sendTurnToSession(
        session, JID, 'fixture user turn', JID, undefined, undefined, undefined, () => allowed,
      )).rejects.toThrow('TURN_RECOVERY_DISPATCH_TARGET_SUPERSEDED');
      await expect(view.sendTurnToSession(session, JID, 'fixture next turn', JID)).resolves.toBeUndefined();
      expect(noticesAtBoundary).toEqual([0, 0]);
      expect(notices).toHaveBeenCalledExactlyOnceWith(JID, NOT_RESTORED, 'status');
    });

    it('a deferred fresh start cancelled right after its spawn sends its notice once, at the next turn\'s boundary', async () => {
      const { session, noticesAtBoundary } = managerWithDeferredFreshStart(admitDeferredStart);
      // The dispatch is superseded as soon as its deferred start is recorded.
      await expect(view.sendTurnToSession(
        session, JID, 'fixture user turn', JID, undefined, undefined, undefined,
        () => !session.isHostWorkAdmissionStartDeferred(),
      )).resolves.toBeUndefined();
      expect(notices).not.toHaveBeenCalled();
      await expect(view.sendTurnToSession(session, JID, 'fixture next turn', JID)).resolves.toBeUndefined();
      expect(noticesAtBoundary).toEqual([0]);
      expect(notices).toHaveBeenCalledExactlyOnceWith(JID, NOT_RESTORED, 'status');
    });

    it('a deferred fresh start announced at its boundary is not announced again at the next one', async () => {
      const { session, noticesAtBoundary } = managerWithDeferredFreshStart(admitDeferredStart, admitDeferredStart);
      await expect(view.sendTurnToSession(session, JID, 'fixture user turn', JID)).resolves.toBeUndefined();
      await expect(view.sendTurnToSession(session, JID, 'fixture next turn', JID)).resolves.toBeUndefined();
      expect(noticesAtBoundary).toEqual([0, 1]);
      expect(notices).toHaveBeenCalledExactlyOnceWith(JID, NOT_RESTORED, 'status');
    });

    it('a held notice waits past a scheduled turn for the next user turn', async () => {
      const { session } = managerWithDeferredFreshStart(refuseDeferredStart, admitDeferredStart, admitDeferredStart);
      await expect(view.sendTurnToSession(session, JID, 'fixture user turn', JID))
        .rejects.toThrow('fixture deferred start refused');
      await expect(view.sendTurnToSession(
        session, JID, 'fixture scheduled turn', JID, undefined, undefined, undefined, undefined, undefined, undefined,
        'scheduled-agent-job',
      )).resolves.toBeUndefined();
      expect(notices).not.toHaveBeenCalled();
      await expect(view.sendTurnToSession(session, JID, 'fixture next turn', JID)).resolves.toBeUndefined();
      expect(notices).toHaveBeenCalledExactlyOnceWith(JID, NOT_RESTORED, 'status');
    });

    it('a generation reset, as /new does, drops a held notice', async () => {
      const { session } = managerWithDeferredFreshStart(refuseDeferredStart, admitDeferredStart);
      await expect(view.sendTurnToSession(session, JID, 'fixture user turn', JID))
        .rejects.toThrow('fixture deferred start refused');
      await (runtime as unknown as {
        resetOwnedPerChatSession(mapKey: string, chatJid: string, s: SessionManager): Promise<void>;
      }).resetOwnedPerChatSession(JID, JID, session);
      await expect(view.sendTurnToSession(session, JID, 'fixture next turn', JID)).resolves.toBeUndefined();
      expect(notices).not.toHaveBeenCalled();
    });

    it('an immediate fresh start announces once even when its provider boundary runs', async () => {
      const { session } = managerWithFailingClose(new Error(LIFECYCLE_CLOSE_FAILED));
      vi.spyOn(session, 'sendTurnAtProviderBoundary').mockImplementationOnce(async (_input, onReady) => { onReady?.(); });
      await expect(view.sendTurnToSession(session, JID, 'fixture user turn', JID)).resolves.toBeUndefined();
      expect(notices).toHaveBeenCalledExactlyOnceWith(JID, NOT_RESTORED, 'status');
    });

    const scheduledTurns: Array<[string, string, 'scheduled-agent-job' | undefined]> = [
      ['its scheduled map key', SCHEDULED, undefined],
      ['its scheduled purpose', JID, 'scheduled-agent-job'],
    ];

    it.each(scheduledTurns)('a scheduled turn known by %s starts fresh after a failed close without the notice', async (_label, key, purpose) => {
      const { session, spawnSpy } = managerWithFailingClose(new Error(LIFECYCLE_CLOSE_FAILED), key);
      await expect(view.sendTurnToSession(
        session, JID, 'fixture scheduled turn', key, undefined, undefined, undefined, undefined, undefined, undefined, purpose,
      )).resolves.toBeUndefined();
      expect(spawnSpy).toHaveBeenCalledExactlyOnceWith();
      expect(providerSend).toHaveBeenCalledTimes(1);
      expect(notices).not.toHaveBeenCalled();
    });

    const unprovenStops: Array<[string, Partial<ReturnType<SessionManager['getStatus']>>]> = [
      ['the provider is not proven stopped', { providerTerminated: false }],
      ['a durable failure closure was recorded', { durableFailureClosed: true }],
      ['the durable lifecycle is inconclusive', { durableFailureInconclusive: true }],
    ];

    it.each(unprovenStops)('refuses the turn without a spawn or notice when %s', async (_label, override) => {
      view.ensureSessionAndQueueSync(JID, JID);
      const session = view.chatSessions.get(JID)!;
      const spawnSpy = vi.spyOn(session, 'spawnSession');
      const realStatus = session.getStatus.bind(session);
      let failedClose = false;
      vi.spyOn(session, 'shutdown').mockImplementationOnce(async () => {
        failedClose = true;
        throw new Error('fixture termination failed');
      });
      // The override covers only the failed close, so teardown reads real state.
      vi.spyOn(session, 'getStatus').mockImplementation(() => (
        failedClose ? { ...realStatus(), ...override } : realStatus()
      ));
      try {
        await expect(view.sendTurnToSession(session, JID, 'fixture user turn', JID))
          .rejects.toThrow('fixture termination failed');
      } finally {
        failedClose = false;
      }
      expect(spawnSpy).not.toHaveBeenCalled();
      expect(providerSend).not.toHaveBeenCalled();
      expect(notices).not.toHaveBeenCalled();
    });

    it('refuses the turn without a spawn or notice when the close reports an aggregate termination failure', async () => {
      const { session, spawnSpy } = managerWithFailingClose(
        new AggregateError([new Error('fixture kill failed')], 'fixture termination and closure both failed'),
      );
      await expect(view.sendTurnToSession(session, JID, 'fixture user turn', JID))
        .rejects.toThrow('fixture termination and closure both failed');
      expect(spawnSpy).not.toHaveBeenCalled();
      expect(providerSend).not.toHaveBeenCalled();
      expect(notices).not.toHaveBeenCalled();
    });
  });

  describe('scope: adoption restores a chat with no resident manager, never an in-process handoff', () => {
    type HandoffView = {
      recreatePerChatSessionForFallback(mapKey: string, chatJid: string): void;
      deleteOwnedPerChatSession(mapKey: string, expected?: SessionManager): boolean;
      evictIdleSession(mapKey: string, session: SessionManager, reason: string): void;
    };
    const handoff = () => runtime as unknown as HandoffView;

    it('a provider-fallback stand-in keeps main\'s fresh spawn with no restore notice', async () => {
      insertRow(OWN_SID, PHONE, 'crashed');
      writeCheckpoint(PHONE, OWN_SID);
      handoff().recreatePerChatSessionForFallback(JID, JID);
      const session = view.chatSessions.get(JID)!;
      const spawnSpy = vi.spyOn(session, 'spawnSession');
      await view.sendTurnToSession(session, JID, 'fixture user turn', JID);
      expect(spawnSpy).toHaveBeenCalledExactlyOnceWith();
      expect(notices).not.toHaveBeenCalled();
    });

    it('a manager retired by an in-process handoff (recycle, /new, crash cleanup) is followed by main\'s fresh spawn', async () => {
      insertRow(OWN_SID, PHONE, 'suspended');
      writeCheckpoint(PHONE, OWN_SID);
      const { session: first } = await firstTurn();
      expect(first.getStatus().active).toBe(true);
      handoff().deleteOwnedPerChatSession(JID, first);
      view.ensureSessionAndQueueSync(JID, JID);
      const second = view.chatSessions.get(JID)!;
      expect(second).not.toBe(first);
      const spawnSpy = vi.spyOn(second, 'spawnSession');
      await view.sendTurnToSession(second, JID, 'fixture next turn', JID);
      expect(spawnSpy).toHaveBeenCalledExactlyOnceWith();
      expect(notices).not.toHaveBeenCalled();
    });

    it('a message right after idle eviction waits for the evicted session to suspend, then resumes it', async () => {
      const ownRow = insertRow(OWN_SID, PHONE, 'suspended');
      writeCheckpoint(PHONE, OWN_SID);
      const { session: first } = await firstTurn();
      expect(first.getStatus().active).toBe(true);
      // Hold the evicted session's shutdown open, so its row still reads
      // 'active' while the next message is admitted.
      let releaseShutdown!: () => void;
      const shutdownGate = new Promise<void>((resolve) => { releaseShutdown = resolve; });
      const realShutdown = first.shutdown.bind(first);
      vi.spyOn(first, 'shutdown').mockImplementation(async (suspend?: boolean) => {
        await shutdownGate;
        return realShutdown(suspend);
      });
      handoff().evictIdleSession(JID, first, 'idle-ttl');
      view.ensureSessionAndQueueSync(JID, JID);
      const second = view.chatSessions.get(JID)!;
      const spawnSpy = vi.spyOn(second, 'spawnSession');
      let turnError: unknown = null;
      const turn = view.sendTurnToSession(second, JID, 'fixture next turn', JID)
        .catch((err: unknown) => { turnError = err; });
      await vi.advanceTimersByTimeAsync(0);
      expect(turnError).toBeNull();
      expect(spawnSpy).not.toHaveBeenCalled();
      releaseShutdown();
      await turn;
      expect(turnError).toBeNull();
      expect(spawnSpy).toHaveBeenCalledExactlyOnceWith(OWN_SID, ownRow);
      expect(notices).not.toHaveBeenCalled();
    });
  });

  describe('X1: non-sandbox per_chat managers route a provider resume refusal to their own chat', () => {
    // A provider can refuse a resumed session after spawn (exit 1, no init);
    // SessionManager then calls onResumeFailed. Without a target,
    // handleResumeFailed falls back to the shared single-mode session, which
    // non-sandbox per_chat never sets, so the refusal was silent.
    function resumeFailedCallback(session: SessionManager): (() => void) | undefined {
      return (session as unknown as { onResumeFailed?: () => void }).onResumeFailed;
    }
    function captureHandleResumeFailed() {
      const handle = vi.fn();
      (runtime as unknown as { handleResumeFailed: typeof handle }).handleResumeFailed = handle;
      return handle;
    }

    it('the lazily created per-chat manager passes its map key and itself', () => {
      const handle = captureHandleResumeFailed();
      view.ensureSessionAndQueueSync(JID, JID);
      const session = view.chatSessions.get(JID)!;
      resumeFailedCallback(session)?.();
      expect(handle).toHaveBeenCalledExactlyOnceWith(JID, { mapKey: JID, session });
    });

    it('the per-chat fallback replacement manager passes its map key and itself', () => {
      const handle = captureHandleResumeFailed();
      (runtime as unknown as { recreatePerChatSessionForFallback(mapKey: string, chatJid: string): void })
        .recreatePerChatSessionForFallback(JID, JID);
      const session = view.chatSessions.get(JID)!;
      resumeFailedCallback(session)?.();
      expect(handle).toHaveBeenCalledExactlyOnceWith(JID, { mapKey: JID, session });
    });
  });
});
