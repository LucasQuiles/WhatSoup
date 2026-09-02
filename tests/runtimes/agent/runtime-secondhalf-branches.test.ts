// Coverage-ratchet draft (RR-013) — AgentRuntime second-half (source lines >= 4000).
//
// Region focus (the first half of runtime.ts is owned by a sibling agent):
//   * handlePendingPollSoftExpiry / handlePendingPollHardExpiry  (~4142-4248)
//   * handlePerChatCrash auto-respawn INNER timer callback        (~4426-7467 band 7000)
//
// These timeout/expiry and respawn-continuation paths are exercised by no
// existing test by name (grep across tests/runtimes/agent/*.test.ts shows the
// vote-received → settlePoll happy paths are covered, but the timer-driven
// expiry handlers and the auto-respawn continuation body are not).
//
// Harness mirrors tests/runtimes/agent/runtime.test.ts: the SessionManager and
// OutboundQueue modules are mocked so AgentRuntime can be constructed and driven
// purely through captured callbacks + private-field state seeding. Real SQLite is
// not required for these paths (the DB calls on these branches are mocked at the
// module boundary, matching the sibling suite's makeDb()).
//
// Repo-hygiene reserved IDs only.

import { describe, it, expect, beforeEach, afterEach, vi, onTestFinished } from 'vitest';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger, IncomingMessage } from '../../../src/core/types.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import type { IOutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';
import { GLOBAL_CONVERSATION_KEY, toConversationKey } from '../../../src/core/conversation-key.ts';
import type {
  MarkSystemTurnInput,
  PendingSystemTurnSnapshot,
  SystemTurnLeaseToken,
  SystemTurnPurpose,
} from '../../../src/runtimes/agent/pending-system-result-tracker.ts';

// ─── Hoisted mocks ──────────────────────────────────────────────────────────

const {
  mockSession,
  mockQueue,
  capturedOnEventRef,
  capturedOnCrashRef,
  capturedNotifyUserRef,
} = vi.hoisted(() => {
  type CapturedCrashInfo = {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    sessionId: string | null;
    dbRowId: number | null;
    provider?: string;
    crashClass?: string;
    stderrPreview?: string;
  };
  const capturedOnEventRef: { current: ((event: AgentEvent) => void) | null } = { current: null };
  const capturedOnCrashRef: { current: ((info: CapturedCrashInfo) => void) | null } = { current: null };
  const capturedNotifyUserRef: { current: ((msg: string) => void) | null } = { current: null };

  const mockSession = {
    spawnSession: vi.fn(async () => {}),
    sendTurn: vi.fn(async (_text: string) => {}),
    sendTurnAtProviderBoundary: vi.fn(async (text: string, onReady?: () => void) => {
      onReady?.();
      await mockSession.sendTurn(text);
    }),
    handleNew: vi.fn(async () => {}),
    getStatus: vi.fn(() => ({ active: false, pid: null as number | null, providerTerminated: true, sessionId: null as string | null, startedAt: null as string | null, messageCount: 0, lastMessageAt: null as string | null })),
    shutdown: vi.fn(async () => {}),
    clearTurnWatchdog: vi.fn(() => {}),
    completeProviderTurn: vi.fn(() => {}),
    waitForProviderTurnToTerminalize: vi.fn(async () => {}),
    tickWatchdog: vi.fn(() => {}),
    trackToolStart: vi.fn((_toolId: string) => {}),
    trackToolEnd: vi.fn((_toolId: string) => {}),
    getDbRowId: vi.fn((): number | null => null),
    setDurability: vi.fn((_durability: unknown) => {}),
    bindGenerationOwnership: vi.fn((_resolve: () => unknown) => {}),
    getProviderId: vi.fn(() => 'claude-cli'),
    getModelRef: vi.fn(() => undefined),
  };

  const mockQueue = {
    enqueueText: vi.fn(),
    getSenderToken: () => 'mock-sender-token',
    enqueueStreamingText: vi.fn((_text: string, _role?: string, _onCommit?: () => void) => {}),
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
    targetChatJid: '15550001@s.whatsapp.net',
    getLastOpId: vi.fn(() => undefined),
    setDurability: vi.fn(),
  };

  return { mockSession, mockQueue, capturedOnEventRef, capturedOnCrashRef, capturedNotifyUserRef };
});

// TYPE NOTE: assertions use mockRuntimeLogger.warn; typed for property access.
const { mockRuntimeLogger } = vi.hoisted(() => ({
  mockRuntimeLogger: {} as Record<string, ReturnType<typeof vi.fn>>,
}));

const { mockEmitAlert, mockClearAlertSource } = vi.hoisted(() => ({
  mockEmitAlert: vi.fn(),
  mockClearAlertSource: vi.fn(),
}));

const { mockGetMessagesSince } = vi.hoisted(() => ({
  // Default: no missed messages. Individual tests override per case.
  mockGetMessagesSince: vi.fn(() => [] as Array<{ timestamp: number; senderName: string | null; senderJid: string; content: string | null }>),
}));

const { mockPrepareContentForAgent } = vi.hoisted(() => ({
  mockPrepareContentForAgent: vi.fn(async (msg: IncomingMessage) => msg.content ?? ''),
}));

const { mockGetActiveSession } = vi.hoisted(() => ({
  mockGetActiveSession: vi.fn(() => null as {
    id: number;
    session_id: string | null;
    chat_jid: string | null;
    workspace_key?: string | null;
    claude_pid: number;
    status: string;
    started_at: string;
    last_message_at: string | null;
    message_count: number;
  } | null),
}));

// ─── Module mocks ───────────────────────────────────────────────────────────

vi.mock('../../../src/logger.ts', async () => {
  const { hoistedLoggerMock } = await import('../../helpers/logger-mock.ts');
  const { createChildLogger } = hoistedLoggerMock(mockRuntimeLogger);
  return { createChildLogger };
});

vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlert: mockEmitAlert,
  emitAlertChecked: mockEmitAlert,
  emitObservationChecked: vi.fn(() => true),
  clearAlertSource: mockClearAlertSource,
  clearAlertSourceChecked: mockClearAlertSource,
}));

vi.mock('../../../src/core/messages.ts', () => ({
  getRecentMessages: vi.fn(() => []),
  getMessagesSince: mockGetMessagesSince,
  updateMediaPath: vi.fn(),
  updateTranscription: vi.fn(),
}));

vi.mock('../../../src/runtimes/agent/media-prep.ts', () => ({
  prepareContentForAgent: mockPrepareContentForAgent,
  relocateMediaToWorkspace: vi.fn((content: string) => content),
}));

vi.mock('../../../src/runtimes/agent/session-db.ts', () => ({
  ensureAgentSchema: vi.fn(),
  createSession: vi.fn(() => 1),
  accumulateSessionTokens: vi.fn(),
  incrementMessageCount: vi.fn(),
  updateSessionId: vi.fn(),
  updateSessionStatus: vi.fn(),
  getActiveSession: mockGetActiveSession,
  backfillWorkspaceKeys: vi.fn(),
  markOrphaned: vi.fn(),
  getResumableSessionForChat: vi.fn(() => null),
  backfillSessionProvider: vi.fn(),
  accumulateTokensWithEvent: vi.fn(),
  getSessionTokenSnapshot: vi.fn(() => null),
  markSessionCompacted: vi.fn(),
}));

vi.mock('../../../src/runtimes/agent/session-classifier.ts', () => ({
  classifyActiveSessions: vi.fn(() => []),
}));

vi.mock('../../../src/runtimes/agent/session.ts', () => ({
  // eslint-disable-next-line prefer-arrow-callback -- constructor mock requires function keyword; expires 2026-12-31
  SessionManager: vi.fn().mockImplementation(function (opts: {
    onEvent: (event: AgentEvent) => void;
    onCrash?: (info: unknown) => void;
    notifyUser?: (msg: string) => void;
  }) {
    capturedOnEventRef.current = opts.onEvent;
    capturedOnCrashRef.current = (opts.onCrash as never) ?? null;
    capturedNotifyUserRef.current = opts.notifyUser ?? null;
    return mockSession;
  }),
  formatAge: vi.fn(() => 'now'),
  getProviderBinary: vi.fn(() => null),
}));

vi.mock('../../../src/runtimes/agent/outbound-queue.ts', () => ({
  // eslint-disable-next-line prefer-arrow-callback -- constructor mock requires function keyword; expires 2026-12-31
  OutboundQueue: vi.fn().mockImplementation(function () {
    return mockQueue;
  }),
}));

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    // #2192 s4b: provider-fallback tunables live on config (defaults mirror the retired IIFEs).
    fallbackTunables: { noticeDedupMs: 1_800_000, primaryRecheckMs: 300_000, probeStallThreshold: 12, probeStallCeilingMultiple: 10 },
    adminPhones: new Set<string>(['15550001']),
    controlPeers: new Map<string, string>(),
    toolUpdateMode: 'full' as 'full' | 'minimal' | 'friendly',
    toolUpdateRedirectJid: null as string | null,
    textAggregateDelayMs: 2_000,
    stateRoot: '/tmp/whatsoup-test-state-secondhalf',
    restartLoopGuard: { enabled: true, maxRestarts: 3, windowMs: 300_000 },
    startupNotifications: true,
    proactiveResumeOnStartup: true,
    mediaDir: '/tmp/whatsoup-test-media-runtime-secondhalf-branches/tmp',
    pineconeAllowedIndexes: [] as string[],
    voiceReply: 'never' as const,
    elevenlabs: { defaultVoiceId: 'v', defaultModel: 'm', stability: 0.5, similarityBoost: 0.75 },
    memory: { adminJid: 'admin@s.whatsapp.net' },
  },
}));

vi.mock('../../../src/config.ts', () => ({ config: mockConfig }));

vi.mock('../../../src/runtimes/chat/providers/elevenlabs.ts', () => ({
  synthesizeSpeech: vi.fn(),
}));

vi.mock('../../../src/core/media-download.ts', () => ({
  writeTempFile: vi.fn(() => '/tmp/voice-reply.mp3'),
  downloadMedia: vi.fn(),
}));

vi.mock('../../../src/core/access-list.ts', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../../../src/core/access-list.ts');
  return actual;
});

// ─── Imports under test ─────────────────────────────────────────────────────

import {
  AgentRuntime,
  type PendingPollQuestion,
  type PollVote,
} from '../../../src/runtimes/agent/runtime.ts';
import {
  makeRuntimeTurnContext,
  publishSingletonTestOwner,
} from './lib/runtime-mock-scaffold.ts';

// ─── Local helpers (mirror sibling suite) ───────────────────────────────────

function makeDb(): Database {
  return {
    assertWritableCompatibility: vi.fn(),
    raw: {
      prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn() })),
      exec: vi.fn(),
    },
  } as unknown as Database;
}

function makeMessenger(): { messenger: Messenger; sentMessages: Array<{ jid: string; text: string }> } {
  const sentMessages: Array<{ jid: string; text: string }> = [];
  const messenger: Messenger = {
    sendMessage: vi.fn(async (jid: string, text: string) => {
      sentMessages.push({ jid, text });
      return { waMessageId: null };
    }),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  };
  return { messenger, sentMessages };
}

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: 'msg-compatibility',
    chatJid: dmJid,
    senderJid: dmJid,
    senderName: 'Test User',
    content: 'hello',
    contentText: null,
    contentType: 'text',
    isFromMe: false,
    isGroup: false,
    mentionedJids: [],
    timestamp: Date.now(),
    quotedMessageId: null,
    isResponseWorthy: true,
    ...overrides,
  };
}

function completedCheckpoint(args: {
  conversationKey: string;
  deliveryJid: string;
  sessionId: string;
  updatedAt: string;
}) {
  return {
    id: 9,
    conversation_key: args.conversationKey,
    session_id: args.sessionId,
    transcript_path: null,
    active_turn_id: null,
    last_inbound_seq: 1,
    completed_inbound_seq: 1,
    last_flushed_outbound_id: null,
    watchdog_state: null,
    workspace_path: null,
    claude_pid: null,
    session_status: 'active',
    checkpoint_version: 1,
    completed_delivery_jid: args.deliveryJid,
    completed_delivery_namespace: 's.whatsapp.net',
    completed_scope: 'singleton',
    completed_logical_turn_id: 'turn-1',
    completed_manager_id: 'resume-manager',
    completed_generation: 1,
    updated_at: args.updatedAt,
  };
}

type CrashInfo = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  sessionId: string | null;
  dbRowId: number | null;
  provider?: string;
  crashClass?: string;
  stderrPreview?: string;
  generationIdentity?: { managerId: string; generation: number };
  terminationReason?: 'idle_watchdog' | 'stalled_operation' | 'suspend' | 'ended';
};

type PollRuntimeState = {
  pendingPolls: { questions: Map<string, PendingPollQuestion> };
  pendingSystemResults: {
    mark(input: MarkSystemTurnInput): SystemTurnLeaseToken;
    peek(scopeKey: string): PendingSystemTurnSnapshot | null;
  };
  chatSessions: Map<string, typeof mockSession>;
  chatQueues: Map<string, IOutboundQueue>;
  sessionEventToolScopes: WeakMap<object, string>;
  handleEventPerChat(sourceSession: object, event: AgentEvent, toolScopeKey: string): void;
  handlePendingPollSoftExpiry: (mapKey: string, expected: PendingPollQuestion) => void;
  handlePendingPollHardExpiry: (mapKey: string, expected: PendingPollQuestion) => void;
  handlePerChatCrash: (mapKey: string, chatJid?: string, info?: CrashInfo) => void;
  pendingRespawnTimers: Set<ReturnType<typeof setTimeout>>;
};

const groupJid = '12036355555555NNNN@g.us';
const dmJid = '15550001@s.whatsapp.net';

function seedPending(overrides: Partial<PendingPollQuestion>): PendingPollQuestion {
  const pending: PendingPollQuestion = {
    questions: [{
      question: 'Approve?',
      header: 'Decide',
      options: [{ label: 'Yes', description: 'go' }, { label: 'No', description: 'stop' }],
      multiSelect: false,
    }],
    toolId: 'tool-x',
    chatJid: groupJid,
    chatJidAliases: new Set([groupJid]),
    mode: 'poll',
    pollMessageIdToQuestionIndex: new Map([['POLL_X', 0]]),
    currentQuestionIndex: 0,
    answersCollected: {},
    createdAt: Date.now(),
    resolution: 'first-vote-wins',
    timeoutMs: 60_000,
    votesByQuestion: new Map(),
    adminJids: null,
    source: 'askuser',
    sentPollMessageIds: ['POLL_X'],
    ...overrides,
  };
  return pending;
}

function vote(voterJid: string, option: string, isAdmin: boolean, ts: number): PollVote {
  return { voterJid, selectedOptions: [option], isAdmin, timestamp: ts };
}

function setOwnedTestSession(runtime: AgentRuntime, mapKey: string): void {
  const state = runtime as unknown as {
    setOwnedPerChatSession: (key: string, value: typeof mockSession) => void;
    sessionEventToolScopes: WeakMap<object, string>;
  };
  state.setOwnedPerChatSession(mapKey, mockSession);
  state.sessionEventToolScopes.set(mockSession, `${mapKey}#test`);
}

function admitPendingSystemResult(
  state: PollRuntimeState,
  mapKey: string,
  expectedPurpose: SystemTurnPurpose,
): void {
  const pending = state.pendingSystemResults.peek(mapKey);
  expect(pending).toEqual(expect.objectContaining({
    purpose: expectedPurpose,
    blocking: true,
  }));
  const toolScopeKey = state.sessionEventToolScopes.get(mockSession);
  if (!toolScopeKey) throw new Error(`missing tool scope for ${mapKey}`);
  state.handleEventPerChat(mockSession, { type: 'result', text: null }, toolScopeKey);
  expect(state.pendingSystemResults.peek(mapKey)).toBeNull();
}

function currentCrashIdentity(runtime: AgentRuntime, mapKey: string): {
  generationIdentity: { managerId: string; generation: number };
} {
  const owner = (runtime as unknown as {
    sessionOwnership: { get: (key: string) => { managerId: string; generation: number } | undefined };
  }).sessionOwnership.get(mapKey);
  if (!owner) throw new Error(`missing test owner for ${mapKey}`);
  return { generationIdentity: { managerId: owner.managerId, generation: owner.generation } };
}

// ─── Setup ──────────────────────────────────────────────────────────────────

describe('AgentRuntime second-half: poll expiry + auto-respawn continuation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    capturedOnEventRef.current = null;
    capturedOnCrashRef.current = null;
    capturedNotifyUserRef.current = null;
    mockConfig.controlPeers = new Map();
    mockSession.spawnSession.mockResolvedValue(undefined);
    mockSession.getStatus.mockReturnValue({ active: false, pid: null, providerTerminated: true, sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null });
    mockSession.sendTurn.mockResolvedValue(undefined);
    mockSession.getDbRowId.mockReturnValue(null);
    mockGetMessagesSince.mockReturnValue([]);
    mockGetActiveSession.mockReturnValue(null);
    mockConfig.toolUpdateMode = 'full';
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  describe('minimal-mode delivery boundaries', () => {
    const mapKey = 'minimal@s.whatsapp.net';
    type ScopedView = {
      handleEventWithContext: (
        event: AgentEvent, queue: IOutboundQueue, session: typeof mockSession,
        conversationKey?: string, inboundSeq?: number, mapKey?: string, toolScopeKey?: string,
      ) => void;
      perChatTurnText: Map<string, string>;
      replyGuarantee: { notifyActivity: ReturnType<typeof vi.fn> } | null;
      runtimeTurnCoordinator: { markRuntimeTurnReplayUnsafe: (key?: string) => void };
    };

    it('commits per-chat replay, liveness, and voice state only with queued text', () => {
      mockConfig.toolUpdateMode = 'minimal';
      const state = new AgentRuntime(makeDb(), makeMessenger().messenger, 'test', {
        sessionScope: 'per_chat',
      }) as unknown as ScopedView;
      const notifyActivity = vi.fn();
      const markUnsafe = vi.spyOn(state.runtimeTurnCoordinator, 'markRuntimeTurnReplayUnsafe');
      state.replyGuarantee = { notifyActivity };
      state.handleEventWithContext(
        { type: 'assistant_text', text: 'The workbook is ready.' }, mockQueue, mockSession,
        undefined, undefined, mapKey, mapKey,
      );

      expect(state.perChatTurnText.get(mapKey) ?? '').toBe('');
      expect(markUnsafe).not.toHaveBeenCalled();
      expect(notifyActivity).not.toHaveBeenCalled();
      const commit = mockQueue.enqueueStreamingText.mock.calls.at(-1)?.[2];
      expect(commit).toBeTypeOf('function');
      commit?.();
      expect(state.perChatTurnText.get(mapKey)).toBe('The workbook is ready.');
      expect(markUnsafe).toHaveBeenCalledWith(mapKey);
      expect(notifyActivity).toHaveBeenCalledWith(mockQueue.targetChatJid);
    });

    it('discards only at normal tools and preserves provisional text across tool errors', () => {
      mockConfig.toolUpdateMode = 'minimal';
      const state = new AgentRuntime(makeDb(), makeMessenger().messenger, 'test', {
        sessionScope: 'per_chat',
      }) as unknown as ScopedView;
      state.handleEventWithContext(
        { type: 'assistant_text', text: 'I will inspect it.' }, mockQueue, mockSession,
        undefined, undefined, mapKey, mapKey,
      );
      state.handleEventWithContext(
        { type: 'tool_use', toolId: 'read-1', toolName: 'Read', toolInput: {} },
        mockQueue, mockSession, undefined, undefined, mapKey, mapKey,
      );
      expect(mockQueue.discardPreToolAssistantText).toHaveBeenCalledOnce();

      mockQueue.discardPreToolAssistantText.mockClear();
      state.handleEventWithContext(
        { type: 'assistant_text', text: 'The file is unavailable.' }, mockQueue, mockSession,
        undefined, undefined, mapKey, mapKey,
      );
      state.handleEventWithContext(
        { type: 'tool_result', toolId: 'untracked-error', toolName: 'Read', content: 'missing', isError: true },
        mockQueue, mockSession, undefined, undefined, mapKey, mapKey,
      );
      expect(mockQueue.discardPreToolAssistantText).not.toHaveBeenCalled();
      expect(mockQueue.enqueueToolUpdate).toHaveBeenCalledWith(expect.objectContaining({ category: 'error' }));
      expect(mockQueue.enqueueStreamingText.mock.calls.at(-1)?.[2]).toBeTypeOf('function');
    });

    it('keeps shared text provisional until a normal tool discards it', () => {
      mockConfig.toolUpdateMode = 'minimal';
      const runtime = new AgentRuntime(makeDb(), makeMessenger().messenger);
      const state = runtime as unknown as {
        handleEvent: (session: typeof mockSession, event: AgentEvent) => void;
        queue: IOutboundQueue;
        currentTurnAssistantText: string;
        turnHadVisibleOutput: boolean;
        currentRuntimeTurnContext: ReturnType<typeof makeRuntimeTurnContext> | null;
        replyGuarantee: { notifyActivity: ReturnType<typeof vi.fn> } | null;
      };
      const notifyActivity = vi.fn();
      state.queue = mockQueue;
      state.replyGuarantee = { notifyActivity };
      state.currentRuntimeTurnContext = makeRuntimeTurnContext(
        'singleton', 'test@s.whatsapp.net', mockQueue.targetChatJid, 1, 'minimal-shared',
      );
      publishSingletonTestOwner(runtime, mockSession, mockQueue.targetChatJid);

      state.handleEvent(mockSession, { type: 'assistant_text', text: 'I will inspect the files.' });
      expect(state.currentTurnAssistantText).toBe('');
      expect(state.turnHadVisibleOutput).toBe(false);
      expect(state.currentRuntimeTurnContext.replay.replaySafe).toBe(true);
      expect(notifyActivity).not.toHaveBeenCalled();

      state.handleEvent(mockSession, {
        type: 'tool_use', toolId: 'read-shared', toolName: 'Read', toolInput: {},
      });
      expect(state.currentRuntimeTurnContext.replay.replaySafe).toBe(false);
      expect(mockQueue.discardPreToolAssistantText).toHaveBeenCalledOnce();
      expect(notifyActivity).not.toHaveBeenCalled();
    });

  });

  describe('database compatibility admission', () => {
    it('rejects startup before schema initialization when the database is drained', async () => {
      const { ensureAgentSchema } = await import('../../../src/runtimes/agent/session-db.ts');
      const db = makeDb();
      const rejection = new Error('database compatibility drain');
      vi.mocked(db.assertWritableCompatibility).mockImplementation(() => { throw rejection; });
      const runtime = new AgentRuntime(db, makeMessenger().messenger);

      await expect(runtime.start()).rejects.toBe(rejection);

      expect(db.assertWritableCompatibility).toHaveBeenCalledTimes(1);
      expect(ensureAgentSchema).not.toHaveBeenCalled();
      expect(mockSession.spawnSession).not.toHaveBeenCalled();
    });

    it('rejects a message before media preparation when the database is drained', async () => {
      const db = makeDb();
      const rejection = new Error('database compatibility drain');
      vi.mocked(db.assertWritableCompatibility).mockImplementation(() => { throw rejection; });
      const runtime = new AgentRuntime(db, makeMessenger().messenger);

      await expect(runtime.handleMessage(makeMsg({
        contentType: 'image',
        content: null,
      }))).rejects.toBe(rejection);

      expect(db.assertWritableCompatibility).toHaveBeenCalledTimes(1);
      expect(mockPrepareContentForAgent).not.toHaveBeenCalled();
      expect(mockSession.sendTurn).not.toHaveBeenCalled();
    });

    it('rejects a synthetic agent job before constructing or enqueueing a turn', () => {
      const db = makeDb();
      vi.mocked(db.assertWritableCompatibility).mockImplementation(() => {
        throw new Error('database compatibility drain');
      });
      const runtime = new AgentRuntime(db, makeMessenger().messenger);

      expect(runtime.dispatchAgentJob({
        beadId: 1,
        triggerId: 2,
        occurrenceId: 77,
        prompt: 'do work',
        title: 'scheduled work',
        reportChatJid: 'test@g.us',
      })).toEqual({ dispatched: false, detail: 'database compatibility drain' });
      expect(db.assertWritableCompatibility).toHaveBeenCalledTimes(1);
      expect(mockSession.sendTurn).not.toHaveBeenCalled();
    });

    it('refuses a scheduled dispatch when no durability engine is set (#2144)', () => {
      const db = makeDb();
      const runtime = new AgentRuntime(db, makeMessenger().messenger);

      const result = runtime.dispatchAgentJob({
        beadId: 1,
        triggerId: 2,
        occurrenceId: 77,
        prompt: 'do work',
        title: 'scheduled work',
        reportChatJid: 'test@g.us',
      });

      expect(result.dispatched).toBe(false);
      expect(String(result.detail)).toContain('durability engine not set');
      expect(mockSession.sendTurn).not.toHaveBeenCalled();
    });

    it('journals a durable inbound owner BEFORE acknowledging a scheduled dispatch (#2144)', () => {
      const db = makeDb();
      const runtime = new AgentRuntime(db, makeMessenger().messenger);
      const journalInbound = vi.fn(() => 77);
      (runtime as unknown as { durability: unknown }).durability = { journalInbound };
      const handleMessage = vi
        .spyOn(runtime, 'handleMessage')
        .mockResolvedValue(undefined);

      const result = runtime.dispatchAgentJob({
        beadId: 5,
        triggerId: 9,
        occurrenceId: 77,
        prompt: 'do work',
        title: 'scheduled work',
        reportChatJid: 'test@g.us',
      });

      // Ownership precedes the fire-and-forget AND the acknowledgement.
      expect(journalInbound).toHaveBeenCalledTimes(1);
      const journalArgs = journalInbound.mock.calls[0] as unknown[];
      expect(String(journalArgs[0])).toMatch(/^agentjob-9-/);
      expect(journalArgs[2]).toBe('test@g.us');
      expect(journalArgs[3]).toBe('agent');
      expect(journalInbound.mock.invocationCallOrder[0]).toBeLessThan(
        handleMessage.mock.invocationCallOrder[0]!,
      );
      // The synthetic turn carries the durable seq, and the ack names it.
      expect(handleMessage.mock.calls[0]?.[0]).toMatchObject({ inboundSeq: 77, isSyntheticJob: true });
      expect(result).toEqual({ dispatched: true, detail: expect.stringContaining('inbound seq 77') });
    });

    it('uses a different provider session for a scheduled turn than the interactive group session', async () => {
      const { SessionManager: MockSessionManagerCtor } = await import('../../../src/runtimes/agent/session.ts');
      // The ctor override below replaces the shared singleton double with
      // per-construction objects. It MUST NOT leak past this test: later tests
      // assert identity against the canonical `mockSession` singleton (e.g. the
      // stand-in-introduction WeakSet mark), and the file-level beforeEach's
      // vi.clearAllMocks() clears CALLS, not implementations. onTestFinished
      // restores the canonical implementation even when this test fails.
      const mockedSessionCtor = MockSessionManagerCtor as unknown as ReturnType<typeof vi.fn>;
      const canonicalSessionCtor = mockedSessionCtor.getMockImplementation();
      onTestFinished(() => {
        if (canonicalSessionCtor) mockedSessionCtor.mockImplementation(canonicalSessionCtor);
      });
      const createdOptions: Array<{
        chatJid: string;
        persistenceConversationKey?: string;
        notifyUser?: (msg: string) => void;
        onCrash?: (info: {
          exitCode: number | null;
          signal: NodeJS.Signals | null;
          sessionId: string | null;
          dbRowId: number | null;
          generationIdentity: { managerId: string; generation: number };
        }) => void;
      }> = [];
      const createdSessions: Array<typeof mockSession> = [];
      (MockSessionManagerCtor as unknown as ReturnType<typeof vi.fn>).mockImplementation(function (
        opts: {
          chatJid: string;
          persistenceConversationKey?: string;
          notifyUser?: (msg: string) => void;
          onCrash?: (info: {
            exitCode: number | null;
            signal: NodeJS.Signals | null;
            sessionId: string | null;
            dbRowId: number | null;
            generationIdentity: { managerId: string; generation: number };
          }) => void;
          onEvent: (event: AgentEvent) => void;
        },
      ) {
        const session = {
          ...mockSession,
          getStatus: vi.fn(() => ({
            active: false,
            pid: null as number | null,
            providerTerminated: true,
            sessionId: null as string | null,
            startedAt: null as string | null,
            messageCount: 0,
            lastMessageAt: null as string | null,
          })),
          spawnSession: vi.fn(async () => {}),
          sendTurn: vi.fn(async () => {}),
          bindGenerationOwnership: vi.fn(),
        };
        createdOptions.push(opts);
        createdSessions.push(session);
        return session;
      });
      const runtime = new AgentRuntime(makeDb(), makeMessenger().messenger, 'test', {
        sessionScope: 'per_chat',
      });
      const inner = runtime as unknown as {
        _handleMessageInner(msg: IncomingMessage): Promise<void>;
        chatSessions: Map<string, typeof mockSession>;
        sessionManagerIds: WeakMap<typeof mockSession, string>;
        sessionOwnership: {
          get(mapKey: string): { managerId: string; generation: number } | undefined;
        };
      };

      void inner._handleMessageInner(makeMsg({
        chatJid: groupJid,
        senderJid: dmJid,
        isGroup: true,
        content: 'interactive question',
      }));
      await vi.waitFor(() => expect(createdOptions).toHaveLength(1));
      void inner._handleMessageInner(makeMsg({
        messageId: 'agentjob-5-1',
        chatJid: groupJid,
        senderJid: 'admin@s.whatsapp.net',
        senderName: 'Scheduled job',
        isGroup: true,
        isSyntheticJob: true,
        content: 'scheduled check',
      }));
      await vi.waitFor(() => expect(createdOptions).toHaveLength(2));

      expect(inner.chatSessions.size).toBe(2);
      expect(new Set(createdSessions).size).toBe(2);
      expect(createdOptions.map((opts) => opts.chatJid)).toEqual([groupJid, groupJid]);
      expect(createdOptions[0]?.persistenceConversationKey).toBe(toConversationKey(groupJid));
      expect(createdOptions[1]?.persistenceConversationKey).toBe(`${groupJid}::scheduled-agent-job`);

      mockQueue.enqueueText.mockClear();
      mockQueue.flush.mockClear();
      createdOptions[1]?.notifyUser?.(
        'Agent session ended (exited with code 143). Send any message to start a new session.',
      );
      expect(mockQueue.enqueueText).not.toHaveBeenCalled();
      expect(mockQueue.flush).not.toHaveBeenCalled();

      const scheduledMapKey = `${groupJid}::scheduled-agent-job`;
      const scheduledSession = createdSessions[1]!;
      const managerId = inner.sessionManagerIds.get(scheduledSession)!;
      const generation = inner.sessionOwnership.get(scheduledMapKey)!.generation;
      createdOptions[1]?.onCrash?.({
        exitCode: 143,
        signal: null,
        sessionId: null,
        dbRowId: 2015,
        generationIdentity: { managerId, generation },
      });
      expect(inner.chatSessions.has(scheduledMapKey)).toBe(false);
      expect(inner.chatSessions.has(groupJid)).toBe(true);
    });

    it('#3374: subsequent interactive inbounds dispatch while and after a scheduled turn holds its session', async () => {
      const { SessionManager: MockSessionManagerCtor } = await import('../../../src/runtimes/agent/session.ts');
      // Same ctor-override discipline as the scheduled-isolation test above:
      // restore the canonical singleton double even when this test fails.
      const mockedSessionCtor = MockSessionManagerCtor as unknown as ReturnType<typeof vi.fn>;
      const canonicalSessionCtor = mockedSessionCtor.getMockImplementation();
      onTestFinished(() => {
        if (canonicalSessionCtor) mockedSessionCtor.mockImplementation(canonicalSessionCtor);
      });
      type CapturedCtorOptions = {
        chatJid: string;
        onCrash?: (info: {
          exitCode: number | null;
          signal: NodeJS.Signals | null;
          sessionId: string | null;
          dbRowId: number | null;
          generationIdentity: { managerId: string; generation: number };
        }) => void;
        onEvent: (event: AgentEvent) => void;
      };
      const createdOptions: CapturedCtorOptions[] = [];
      const createdSessions: Array<typeof mockSession> = [];
      mockedSessionCtor.mockImplementation(function (opts: CapturedCtorOptions) {
        const session = {
          ...mockSession,
          getStatus: vi.fn(() => ({
            active: false,
            pid: null as number | null,
            providerTerminated: true,
            sessionId: null as string | null,
            startedAt: null as string | null,
            messageCount: 0,
            lastMessageAt: null as string | null,
          })),
          spawnSession: vi.fn(async () => {}),
          sendTurn: vi.fn(async (_text: string) => {}),
          sendTurnAtProviderBoundary: vi.fn(async (text: string, onReady?: () => void) => {
            onReady?.();
            await session.sendTurn(text);
          }),
          bindGenerationOwnership: vi.fn(),
        };
        createdOptions.push(opts);
        createdSessions.push(session);
        return session;
      });
      const runtime = new AgentRuntime(makeDb(), makeMessenger().messenger, 'test', {
        sessionScope: 'per_chat',
      });
      const inner = runtime as unknown as {
        _handleMessageInner(msg: IncomingMessage): Promise<void>;
        chatSessions: Map<string, typeof mockSession>;
        sessionManagerIds: WeakMap<typeof mockSession, string>;
        sessionOwnership: {
          get(mapKey: string): { managerId: string; generation: number } | undefined;
        };
      };

      void inner._handleMessageInner(makeMsg({
        chatJid: groupJid,
        senderJid: dmJid,
        isGroup: true,
        content: 'interactive question one',
      }));
      await vi.waitFor(() => expect(createdSessions).toHaveLength(1));
      const interactive = createdSessions[0]!;
      await vi.waitFor(() => expect(interactive.sendTurn).toHaveBeenCalledTimes(1));
      // Terminalize interactive turn one so its own scope is free.
      createdOptions[0]!.onEvent({ type: 'result', text: null });

      void inner._handleMessageInner(makeMsg({
        messageId: 'agentjob-9-1',
        chatJid: groupJid,
        senderJid: 'admin@s.whatsapp.net',
        senderName: 'Scheduled job',
        isGroup: true,
        isSyntheticJob: true,
        content: 'daily scheduled digest',
      }));
      await vi.waitFor(() => expect(createdSessions).toHaveLength(2));
      const scheduled = createdSessions[1]!;
      await vi.waitFor(() => expect(scheduled.sendTurn).toHaveBeenCalledTimes(1));

      // #3374 wedge half 1: the scheduled TURN is deliberately never
      // terminalized (no result event) — the live incident's signature. A new
      // interactive inbound must still dispatch on the interactive session
      // instead of queueing behind the held scheduled turn.
      void inner._handleMessageInner(makeMsg({
        chatJid: groupJid,
        senderJid: dmJid,
        isGroup: true,
        content: 'interactive question two while the job holds its session',
      }));
      await vi.waitFor(() => expect(interactive.sendTurn).toHaveBeenCalledTimes(2));
      expect(createdSessions).toHaveLength(2);
      expect(scheduled.sendTurn).toHaveBeenCalledTimes(1);
      // Terminalize interactive turn two before the retirement phase.
      createdOptions[0]!.onEvent({ type: 'result', text: null });

      // Retire the scheduled session via provider exit (the #3341 idle path).
      const scheduledMapKey2 = `${groupJid}::scheduled-agent-job`;
      const scheduledManagerId = inner.sessionManagerIds.get(scheduled)!;
      const scheduledGeneration = inner.sessionOwnership.get(scheduledMapKey2)!.generation;
      createdOptions[1]?.onCrash?.({
        exitCode: 0,
        signal: null,
        sessionId: null,
        dbRowId: 2016,
        generationIdentity: { managerId: scheduledManagerId, generation: scheduledGeneration },
      });
      expect(inner.chatSessions.has(scheduledMapKey2)).toBe(false);

      // #3374 wedge half 2: after retirement the interactive lane still
      // dispatches — the job left nothing behind that a user DM can wedge on.
      void inner._handleMessageInner(makeMsg({
        chatJid: groupJid,
        senderJid: dmJid,
        isGroup: true,
        content: 'interactive question three after retirement',
      }));
      await vi.waitFor(() => expect(interactive.sendTurn).toHaveBeenCalledTimes(3));
      expect(inner.chatSessions.has(groupJid)).toBe(true);
    });

    it('maps a journal failure to a refused dispatch instead of an unowned ack (#2144)', () => {
      const db = makeDb();
      const runtime = new AgentRuntime(db, makeMessenger().messenger);
      (runtime as unknown as { durability: unknown }).durability = {
        journalInbound: vi.fn(() => { throw new Error('journal write failed'); }),
      };
      const handleMessage = vi.spyOn(runtime, 'handleMessage').mockResolvedValue(undefined);

      const result = runtime.dispatchAgentJob({
        beadId: 5,
        triggerId: 9,
        occurrenceId: 77,
        prompt: 'do work',
        title: 'scheduled work',
        reportChatJid: 'test@g.us',
      });

      expect(result).toEqual({ dispatched: false, detail: 'journal write failed' });
      expect(handleMessage).not.toHaveBeenCalled();
    });

    it('rejects a control turn before constructing a repair session', async () => {
      const db = makeDb();
      const rejection = new Error('database compatibility drain');
      vi.mocked(db.assertWritableCompatibility).mockImplementation(() => { throw rejection; });
      const runtime = new AgentRuntime(db, makeMessenger().messenger);

      await expect(runtime.handleControlTurn('report-1', '{"type":"repair"}')).rejects.toBe(rejection);

      expect(db.assertWritableCompatibility).toHaveBeenCalledTimes(1);
      expect(mockSession.spawnSession).not.toHaveBeenCalled();
      expect(mockSession.sendTurn).not.toHaveBeenCalled();
    });

    it('rejects an agent command before validating or dispatching it', async () => {
      const db = makeDb();
      const rejection = new Error('database compatibility drain');
      vi.mocked(db.assertWritableCompatibility).mockImplementation(() => { throw rejection; });
      const runtime = new AgentRuntime(db, makeMessenger().messenger);

      await expect(runtime.handleAgentCommand({ command: 'restart' as 'compact' }))
        .rejects.toBe(rejection);

      expect(db.assertWritableCompatibility).toHaveBeenCalledTimes(1);
      expect(mockSession.sendTurn).not.toHaveBeenCalled();
    });
  });

  it('leaves a stale lifecycle untouched when its workspace identity is unavailable', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const updatedAt = new Date(Date.now() - 120 * 60_000).toISOString().replace('Z', '');

    mockGetActiveSession.mockReturnValue({
      id: 9,
      session_id: 'sess-stale-unscoped',
      chat_jid: 'unscoped@s.whatsapp.net',
      workspace_key: null,
      claude_pid: 0,
      status: 'active',
      started_at: new Date(Date.now() - 120 * 60_000).toISOString(),
      last_message_at: null,
      message_count: 0,
    });

    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'single' });
    const mockDurability = {
      getLatestCompletedCheckpointForSession: vi.fn(() => completedCheckpoint({
        conversationKey: 'unscoped',
        deliveryJid: 'unscoped@s.whatsapp.net',
        sessionId: 'sess-stale-unscoped',
        updatedAt,
      })),
      retireExactSessionLifecycle: vi.fn(),
    };
    (runtime as unknown as { durability: unknown }).durability = mockDurability;

    await runtime.start();

    expect(mockSession.spawnSession).not.toHaveBeenCalled();
    expect(mockDurability.retireExactSessionLifecycle).not.toHaveBeenCalled();
    expect(mockRuntimeLogger.warn).toHaveBeenCalledWith({
      rowId: 9,
      conversationKey: 'unscoped',
    }, 'cannot retire stale shared/single resume without exact workspace identity');
  });

  it('capDedupeMap evicts oldest-first over an object-valued map (BEAD-050)', () => {
    const runtime = new AgentRuntime(makeDb(), makeMessenger().messenger);
    const cap = (runtime as unknown as {
      capDedupeMap(map: Map<string, unknown>, max?: number): void;
    }).capDedupeMap.bind(runtime);
    const map = new Map<string, { adminJids: Set<string>; fetchedAt: number }>();
    for (let i = 0; i < 10; i++) {
      map.set(`group-${i}@g.us`, { adminJids: new Set([`admin-${i}`]), fetchedAt: i });
    }

    cap(map, 4);

    expect(map.size).toBe(4);
    expect([...map.keys()]).toEqual([
      'group-6@g.us', 'group-7@g.us', 'group-8@g.us', 'group-9@g.us',
    ]);
    cap(map, 4);
    expect(map.size).toBe(4);
  });

  // ── handlePendingPollSoftExpiry ──────────────────────────────────────────

  describe('handlePendingPollSoftExpiry', () => {
    it('early-returns when the pending object identity no longer matches (idempotent guard, ~4144)', () => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const state = runtime as unknown as PollRuntimeState;

      const original = seedPending({ chatJid: groupJid });
      const replacement = seedPending({ chatJid: groupJid });
      state.pendingPolls.questions.set(groupJid, replacement);

      // expectedPending !== current — must be a no-op (no settle/no send)
      state.handlePendingPollSoftExpiry(groupJid, original);

      expect(state.pendingPolls.questions.get(groupJid)).toBe(replacement);
      expect(mockQueue.enqueueText).not.toHaveBeenCalled();
    });

    it('send_poll + majority-after-timeout: settles via awaitResolve with the tallied winner (~4148-4163)', async () => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const state = runtime as unknown as PollRuntimeState;

      let resolved: string | null = null;
      const votes = new Map<string, PollVote>([
        ['1555001@s.whatsapp.net', vote('1555001@s.whatsapp.net', 'Yes', false, 100)],
        ['1555002@s.whatsapp.net', vote('1555002@s.whatsapp.net', 'Yes', false, 200)],
        ['1555003@s.whatsapp.net', vote('1555003@s.whatsapp.net', 'No', false, 300)],
      ]);
      const pending = seedPending({
        source: 'send_poll',
        resolution: 'majority-after-timeout',
        votesByQuestion: new Map([[0, votes]]),
        awaitResolve: (answer: string) => { resolved = answer; },
        awaitReject: () => {},
      });
      const mapKey = 'send_poll:m1';
      state.pendingPolls.questions.set(mapKey, pending);

      state.handlePendingPollSoftExpiry(mapKey, pending);

      expect(resolved).toBe('Yes');
      expect(pending.answersCollected[0]).toBe('Yes');
      expect(state.pendingPolls.questions.has(mapKey)).toBe(false);
    });

    it('send_poll + admin-wins with no admin vote: falls back to recorded non-admin majority (~4167-4181)', () => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const state = runtime as unknown as PollRuntimeState;

      let resolved: string | null = null;
      const votes = new Map<string, PollVote>([
        ['1555004@s.whatsapp.net', vote('1555004@s.whatsapp.net', 'No', false, 50)],
        ['1555005@s.whatsapp.net', vote('1555005@s.whatsapp.net', 'No', false, 60)],
      ]);
      const pending = seedPending({
        source: 'send_poll',
        resolution: 'admin-wins',
        votesByQuestion: new Map([[0, votes]]),
        adminJids: new Set(['1555009@s.whatsapp.net']),
        awaitResolve: (answer: string) => { resolved = answer; },
        awaitReject: () => {},
      });
      const mapKey = 'send_poll:m2';
      state.pendingPolls.questions.set(mapKey, pending);

      state.handlePendingPollSoftExpiry(mapKey, pending);

      expect(resolved).toBe('No');
      expect(pending.answersCollected[0]).toBe('No');
    });

    it('send_poll + first-vote-wins (no resolution branch): rejects awaiter on plain expiry (~4184)', async () => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const state = runtime as unknown as PollRuntimeState;

      let rejection: Error | null = null;
      const pending = seedPending({
        source: 'send_poll',
        resolution: 'first-vote-wins',
        votesByQuestion: new Map(),
        awaitResolve: () => {},
        awaitReject: (err: Error) => { rejection = err; },
      });
      const mapKey = 'send_poll:m3';
      state.pendingPolls.questions.set(mapKey, pending);

      state.handlePendingPollSoftExpiry(mapKey, pending);

      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as unknown as Error).message).toMatch(/Poll expiry/);
      expect(state.pendingPolls.questions.has(mapKey)).toBe(false);
    });

    it('askuser + majority-after-timeout: settles and injects via sendTurn (~4189-4203)', async () => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const state = runtime as unknown as PollRuntimeState;

      setOwnedTestSession(runtime, groupJid);
      state.chatQueues.set(groupJid, mockQueue);
      const mark = vi.spyOn(state.pendingSystemResults, 'mark');

      const votes = new Map<string, PollVote>([
        ['1555006@s.whatsapp.net', vote('1555006@s.whatsapp.net', 'No', false, 100)],
        ['1555007@s.whatsapp.net', vote('1555007@s.whatsapp.net', 'No', false, 200)],
      ]);
      const pending = seedPending({
        chatJid: groupJid,
        source: 'askuser',
        resolution: 'majority-after-timeout',
        votesByQuestion: new Map([[0, votes]]),
        toolId: 'tool-au',
      });
      state.pendingPolls.questions.set(groupJid, pending);

      state.handlePendingPollSoftExpiry(groupJid, pending);

      expect(pending.answersCollected[0]).toBe('No');
      // askuser path injects the answer into the session (settlePoll → injectPollAnswers)
      await vi.waitFor(() => {
        expect(mockSession.sendTurn).toHaveBeenCalledWith(expect.stringContaining('No'));
      });
      expect(mark).toHaveBeenCalledWith(expect.objectContaining({
        scopeKey: groupJid,
        purpose: 'poll_answer_continuation',
        timeoutMs: 240_000,
        onTimeout: expect.any(Function),
      }));
      admitPendingSystemResult(state, groupJid, 'poll_answer_continuation');
      expect(mockSession.completeProviderTurn).toHaveBeenCalledOnce();
      expect(state.pendingPolls.questions.has(groupJid)).toBe(false);
    });

    it('askuser + admin-wins with no admin: uses non-admin majority on timeout (~4207-4221)', () => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const state = runtime as unknown as PollRuntimeState;
      state.chatSessions.set(groupJid, mockSession);
      state.chatQueues.set(groupJid, mockQueue);

      const votes = new Map<string, PollVote>([
        ['1555008@s.whatsapp.net', vote('1555008@s.whatsapp.net', 'Yes', false, 10)],
      ]);
      const pending = seedPending({
        chatJid: groupJid,
        source: 'askuser',
        resolution: 'admin-wins',
        votesByQuestion: new Map([[0, votes]]),
        adminJids: new Set(['1555010@s.whatsapp.net']),
        toolId: 'tool-aw',
      });
      state.pendingPolls.questions.set(groupJid, pending);

      state.handlePendingPollSoftExpiry(groupJid, pending);

      expect(pending.answersCollected[0]).toBe('Yes');
    });

    it('askuser default path: converts to textFallback and prompts for the remaining question (~4225-4236)', () => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const state = runtime as unknown as PollRuntimeState;
      state.chatSessions.set(groupJid, mockSession);
      state.chatQueues.set(groupJid, mockQueue);

      const pending = seedPending({
        chatJid: groupJid,
        source: 'askuser',
        resolution: 'first-vote-wins',
        votesByQuestion: new Map(),
        toolId: 'tool-fb',
      });
      state.pendingPolls.questions.set(groupJid, pending);

      state.handlePendingPollSoftExpiry(groupJid, pending);

      // Unanswered → mode flips to textFallback and a prompt is sent to the chat queue
      expect(pending.mode).toBe('textFallback');
      expect(mockQueue.enqueueText).toHaveBeenCalledWith(
        expect.stringContaining('did not receive the poll vote'),
      );
      // Poll is NOT removed — it remains pending for text reply
      expect(state.pendingPolls.questions.has(groupJid)).toBe(true);
    });
  });

  // ── handlePendingPollHardExpiry ──────────────────────────────────────────

  describe('handlePendingPollHardExpiry', () => {
    it('early-returns when identity mismatches (~4241)', () => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const state = runtime as unknown as PollRuntimeState;

      const original = seedPending({ chatJid: groupJid });
      const replacement = seedPending({ chatJid: groupJid });
      state.pendingPolls.questions.set(groupJid, replacement);

      state.handlePendingPollHardExpiry(groupJid, original);

      expect(state.pendingPolls.questions.get(groupJid)).toBe(replacement);
      expect(mockQueue.enqueueText).not.toHaveBeenCalled();
    });

    it('sends an expiry notice and clears the poll when questions remain unanswered (~4243-4247)', () => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const state = runtime as unknown as PollRuntimeState;
      state.chatSessions.set(groupJid, mockSession);
      state.chatQueues.set(groupJid, mockQueue);

      const pending = seedPending({ chatJid: groupJid, answersCollected: {} });
      state.pendingPolls.questions.set(groupJid, pending);

      state.handlePendingPollHardExpiry(groupJid, pending);

      expect(mockQueue.enqueueText).toHaveBeenCalledWith(
        expect.stringContaining('expired'),
      );
      expect(state.pendingPolls.questions.has(groupJid)).toBe(false);
    });

    it('clears the poll without a notice when all questions are already answered (~4243 false branch)', () => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const state = runtime as unknown as PollRuntimeState;
      state.chatSessions.set(groupJid, mockSession);
      state.chatQueues.set(groupJid, mockQueue);

      const pending = seedPending({ chatJid: groupJid, answersCollected: { 0: 'Yes' } });
      state.pendingPolls.questions.set(groupJid, pending);

      state.handlePendingPollHardExpiry(groupJid, pending);

      expect(mockQueue.enqueueText).not.toHaveBeenCalled();
      expect(state.pendingPolls.questions.has(groupJid)).toBe(false);
    });
  });

  // ── handlePerChatCrash auto-respawn inner timer callback ──────────────────

  describe('handlePerChatCrash auto-respawn continuation', () => {
    function seedPerChatSession(state: PollRuntimeState, mapKey: string): void {
      setOwnedTestSession(state as unknown as AgentRuntime, mapKey);
      state.chatQueues.set(mapKey, mockQueue);
    }

    it('on first crash: schedules a respawn, resumes, and sends a continuation turn (~7438-7453)', async () => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const state = runtime as unknown as PollRuntimeState;
      const mapKey = dmJid;
      seedPerChatSession(state, mapKey);
      const mark = vi.spyOn(state.pendingSystemResults, 'mark');

      // Session reports inactive at crash time, then active after spawnSession.
      mockSession.getStatus
        .mockReturnValueOnce({ active: false, pid: null, providerTerminated: true, sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null }) // timer guard check
        .mockReturnValue({ active: true, pid: 321, providerTerminated: false, sessionId: 'sess-1', startedAt: '2026-06-16T00:00:00Z', messageCount: 1, lastMessageAt: null }); // post-resume

      state.handlePerChatCrash(mapKey, dmJid, {
        ...currentCrashIdentity(runtime, mapKey),
        exitCode: 1,
        signal: null,
        sessionId: 'sess-1',
        dbRowId: 7,
        provider: 'p',
        crashClass: 'oom',
        stderrPreview: 'boom',
      });

      // advance jittered respawn delay
      await vi.advanceTimersByTimeAsync(60_000);
      // flush spawnSession().then() microtasks + the inner 1s settle wait
      await vi.advanceTimersByTimeAsync(2_000);

      expect(mockSession.spawnSession).toHaveBeenCalledWith('sess-1', 7);
      // continuation turn injected after a successful resume
      await vi.waitFor(() => {
        expect(mockSession.sendTurn).toHaveBeenCalledWith(
          expect.stringContaining('session resumed after crash'),
        );
      });
      expect(mark).toHaveBeenCalledWith(expect.objectContaining({
        scopeKey: mapKey,
        purpose: 'respawn_continuation',
        timeoutMs: 240_000,
        onTimeout: expect.any(Function),
      }));
      admitPendingSystemResult(state, mapKey, 'respawn_continuation');
      // success path clears the prior respawn-failed alert
      expect(mockClearAlertSource).toHaveBeenCalledWith('test', 'agent_respawn_failed');
    });

    it('re-arms a respawn refused only because termination is unproven, and recovers once it proves', async () => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const state = runtime as unknown as PollRuntimeState;
      const mapKey = dmJid;
      seedPerChatSession(state, mapKey);

      // Unproven at the moment the timer fires: the managed tool loop is still
      // inside an already-entered call, so nothing has released the provider.
      const unproven = {
        active: false, pid: null, providerTerminated: false,
        sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null,
      };
      const proven = { ...unproven, providerTerminated: true };
      mockSession.getStatus.mockReturnValue(unproven);

      state.handlePerChatCrash(mapKey, dmJid, {
        ...currentCrashIdentity(runtime, mapKey),
        exitCode: null, signal: null, sessionId: 'sess-defer', dbRowId: 12,
        provider: 'p', crashClass: 'managed_provider_error', stderrPreview: 'tool loop still running',
      });

      // One respawn delay only. The backoff is jittered within [1.5s, 2.5s] at
      // this attempt, so 2.6s fires exactly the first timer and no deferral.
      await vi.advanceTimersByTimeAsync(2_600);
      expect(mockSession.spawnSession).not.toHaveBeenCalled();
      // The attempt must not have been consumed: something has to bring the
      // respawn back, and this timer is the only thing that does.
      expect(state.pendingRespawnTimers.size).toBe(1);

      // The tool loop returns and its `finally` settles the turn.
      mockSession.getStatus.mockReturnValue(proven);

      await vi.advanceTimersByTimeAsync(2_600);
      await vi.advanceTimersByTimeAsync(2_000);

      expect(mockSession.spawnSession).toHaveBeenCalledWith('sess-defer', 12);
      expect(state.pendingRespawnTimers.size).toBe(0);
    });

    it('stops re-arming when termination never proves, leaving no pending timer', async () => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const state = runtime as unknown as PollRuntimeState;
      const mapKey = dmJid;
      seedPerChatSession(state, mapKey);

      // Termination never proves. The deferral must be bounded, or this session
      // re-arms a timer for the life of the process.
      mockSession.getStatus.mockReturnValue({
        active: false, pid: null, providerTerminated: false,
        sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null,
      });

      state.handlePerChatCrash(mapKey, dmJid, {
        ...currentCrashIdentity(runtime, mapKey),
        exitCode: null, signal: null, sessionId: 'sess-never', dbRowId: 14,
        provider: 'p', crashClass: 'managed_provider_error', stderrPreview: 'never settles',
      });

      // The whole deferral budget at this backoff fits well inside 120s.
      await vi.advanceTimersByTimeAsync(120_000);

      expect(mockSession.spawnSession).not.toHaveBeenCalled();
      expect(state.pendingRespawnTimers.size).toBe(0);
    });

    it('recovers on the first firing when termination is already proven', async () => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const state = runtime as unknown as PollRuntimeState;
      const mapKey = dmJid;
      seedPerChatSession(state, mapKey);

      mockSession.getStatus
        .mockReturnValueOnce({
          active: false, pid: null, providerTerminated: true,
          sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null,
        })
        .mockReturnValue({
          active: true, pid: 321, providerTerminated: false, sessionId: 'sess-control',
          startedAt: '2026-06-16T00:00:00Z', messageCount: 1, lastMessageAt: null,
        });

      state.handlePerChatCrash(mapKey, dmJid, {
        ...currentCrashIdentity(runtime, mapKey),
        exitCode: 1, signal: null, sessionId: 'sess-control', dbRowId: 13,
        provider: 'p', crashClass: 'oom', stderrPreview: 'boom',
      });

      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(2_000);

      // Exactly once: the proven path must not deferrals-loop or double-spawn.
      expect(mockSession.spawnSession).toHaveBeenCalledTimes(1);
      expect(mockSession.spawnSession).toHaveBeenCalledWith('sess-control', 13);
      expect(state.pendingRespawnTimers.size).toBe(0);
    });

    it('does not resume a manager whose provider termination is unproven', async () => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const state = runtime as unknown as PollRuntimeState;
      const mapKey = dmJid;
      seedPerChatSession(state, mapKey);

      // A managed-loop provider crash whose kill threw: nothing was released,
      // so termination is recorded as unknown. `active` is already false and a
      // managed provider never assigns a child, so a gate reading only those
      // two sees a cleanly dead manager and resumes into live provider work.
      mockSession.getStatus.mockReturnValue({
        active: false,
        pid: null,
        providerTerminated: false,
        sessionId: null,
        startedAt: null,
        messageCount: 0,
        lastMessageAt: null,
      });

      state.handlePerChatCrash(mapKey, dmJid, {
        ...currentCrashIdentity(runtime, mapKey),
        exitCode: null,
        signal: null,
        sessionId: 'sess-unproven',
        dbRowId: 11,
        provider: 'p',
        crashClass: 'managed_provider_error',
        stderrPreview: 'kill failed',
      });

      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(2_000);

      // Two incarnations of one conversation would run side by side, with
      // duplicate external side effects, and the resume would then clear the
      // uncertainty that should have blocked it.
      expect(mockSession.spawnSession).not.toHaveBeenCalled();
      expect(mockSession.sendTurn).not.toHaveBeenCalledWith(
        expect.stringContaining('session resumed after crash'),
      );
    });

    it('clears a stale post-turn gate before the continuation so the reply is delivered, not suppressed as phantom (3398)', async () => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const state = runtime as unknown as PollRuntimeState;
      const mapKey = dmJid;
      seedPerChatSession(state, mapKey);

      // The pre-crash user turn completed normally, which arms the post-turn
      // gate for this chat (runtime-turn-result-handler arms it on every
      // genuine user-turn result). The crash lands with the gate still set —
      // no new user message has arrived to clear it.
      const postTurnGate = (runtime as unknown as { postTurnGate: Set<string> }).postTurnGate;
      postTurnGate.add(mapKey);

      mockSession.getStatus
        .mockReturnValueOnce({ active: false, pid: null, providerTerminated: true, sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null }) // timer guard check
        .mockReturnValue({ active: true, pid: 321, providerTerminated: false, sessionId: 'sess-gate', startedAt: '2026-06-16T00:00:00Z', messageCount: 1, lastMessageAt: null }); // post-resume

      state.handlePerChatCrash(mapKey, dmJid, {
        ...currentCrashIdentity(runtime, mapKey),
        exitCode: 1, signal: null, sessionId: 'sess-gate', dbRowId: 8,
      });

      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(2_000);

      await vi.waitFor(() => {
        expect(mockSession.sendTurn).toHaveBeenCalledWith(
          expect.stringContaining('session resumed after crash'),
        );
      });

      // The model's continuation reply arrives while the respawn_continuation
      // system turn is still pending. It must reach the user — on the broken
      // path it dies as 'post-turn gate: suppressed phantom assistant_text'.
      const toolScopeKey = state.sessionEventToolScopes.get(mockSession);
      if (!toolScopeKey) throw new Error(`missing tool scope for ${mapKey}`);
      state.handleEventPerChat(
        mockSession,
        { type: 'assistant_text', text: 'Picking up where we left off.' },
        toolScopeKey,
      );
      expect(mockQueue.enqueueStreamingText).toHaveBeenCalledWith('Picking up where we left off.');
      // The dispatch site cleared the stale gate before sending the continuation.
      expect(postTurnGate.has(mapKey)).toBe(false);

      admitPendingSystemResult(state, mapKey, 'respawn_continuation');
    });

    it('clears the shared-scope post-turn gate entry before the continuation outside per_chat (3398)', async () => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'shared' });
      const state = runtime as unknown as PollRuntimeState;
      const mapKey = dmJid;
      seedPerChatSession(state, mapKey);

      // Shared scope gates outbound text under GLOBAL_CONVERSATION_KEY (the
      // shared tool-scope key). A stale entry there survives the crash the same
      // way the per-chat entry does.
      const postTurnGate = (runtime as unknown as { postTurnGate: Set<string> }).postTurnGate;
      postTurnGate.add(mapKey);
      postTurnGate.add(GLOBAL_CONVERSATION_KEY);

      mockSession.getStatus
        .mockReturnValueOnce({ active: false, pid: null, providerTerminated: true, sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null }) // timer guard check
        .mockReturnValue({ active: true, pid: 321, providerTerminated: false, sessionId: 'sess-gate-shared', startedAt: '2026-06-16T00:00:00Z', messageCount: 1, lastMessageAt: null }); // post-resume

      state.handlePerChatCrash(mapKey, dmJid, {
        ...currentCrashIdentity(runtime, mapKey),
        exitCode: 1, signal: null, sessionId: 'sess-gate-shared', dbRowId: 9,
      });

      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(2_000);

      await vi.waitFor(() => {
        expect(mockSession.sendTurn).toHaveBeenCalledWith(
          expect.stringContaining('session resumed after crash'),
        );
      });

      expect(postTurnGate.has(mapKey)).toBe(false);
      expect(postTurnGate.has(GLOBAL_CONVERSATION_KEY)).toBe(false);

      admitPendingSystemResult(state, mapKey, 'respawn_continuation');
    });

    it('does not clear respawn failure until the continuation crosses the provider gate', async () => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const state = runtime as unknown as PollRuntimeState;
      const mapKey = dmJid;
      seedPerChatSession(state, mapKey);
      mockSession.getStatus
        .mockReturnValueOnce({ active: false, pid: null, providerTerminated: true, sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null })
        .mockReturnValue({ active: true, pid: 321, providerTerminated: false, sessionId: 'sess-gated', startedAt: '2026-06-16T00:00:00Z', messageCount: 1, lastMessageAt: null });

      let admit!: () => void;
      const admitted = new Promise<void>((resolve) => { admit = resolve; });
      mockSession.sendTurnAtProviderBoundary.mockImplementationOnce(async (text: string, onReady?: () => void) => {
        await admitted;
        onReady?.();
        await mockSession.sendTurn(text);
      });

      state.handlePerChatCrash(mapKey, dmJid, {
        ...currentCrashIdentity(runtime, mapKey),
        exitCode: 1,
        signal: null,
        sessionId: 'sess-gated',
        dbRowId: 12,
      });
      await vi.advanceTimersByTimeAsync(62_000);

      expect(mockSession.sendTurnAtProviderBoundary).toHaveBeenCalledWith(
        expect.stringContaining('session resumed after crash'),
        expect.any(Function),
      );
      expect(mockClearAlertSource).not.toHaveBeenCalledWith('test', 'agent_respawn_failed');

      // A global provider queue can legitimately exceed both old 240s retry
      // windows. Queue time must not quarantine the session before admission.
      await vi.advanceTimersByTimeAsync(600_000);
      expect(mockSession.shutdown).not.toHaveBeenCalled();
      expect(mockClearAlertSource).not.toHaveBeenCalledWith('test', 'agent_respawn_failed');

      admit();
      await vi.waitFor(() => {
        expect(mockClearAlertSource).toHaveBeenCalledWith('test', 'agent_respawn_failed');
      });
    });

    it('injects missed messages before the continuation turn when any arrived during the crash window (~7447-7449)', async () => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const state = runtime as unknown as PollRuntimeState;
      const mapKey = dmJid;
      seedPerChatSession(state, mapKey);
      const mark = vi.spyOn(state.pendingSystemResults, 'mark');

      mockGetMessagesSince.mockReturnValue([
        { timestamp: Math.floor(Date.now() / 1000), senderName: 'Tester', senderJid: dmJid, content: 'are you back?' },
      ]);
      mockSession.getStatus
        .mockReturnValueOnce({ active: false, pid: null, providerTerminated: true, sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null })
        .mockReturnValue({ active: true, pid: 321, providerTerminated: false, sessionId: 'sess-2', startedAt: '2026-06-16T00:00:00Z', messageCount: 1, lastMessageAt: null });

      state.handlePerChatCrash(mapKey, dmJid, {
        ...currentCrashIdentity(runtime, mapKey),
        exitCode: 1, signal: null, sessionId: 'sess-2', dbRowId: 9,
      });

      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(2_000);

      await vi.waitFor(() => {
        expect(mockSession.sendTurn).toHaveBeenCalledWith(
          expect.stringContaining('Recent chat context'),
        );
      });
      expect(mockSession.sendTurn).not.toHaveBeenCalledWith(
        expect.stringContaining('session resumed after crash'),
      );
      expect(mark).toHaveBeenCalledWith(expect.objectContaining({
        scopeKey: mapKey,
        purpose: 'respawn_context',
        timeoutMs: 240_000,
        onTimeout: expect.any(Function),
      }));
      admitPendingSystemResult(state, mapKey, 'respawn_context');

      await vi.waitFor(() => {
        expect(mockSession.sendTurn).toHaveBeenCalledWith(
          expect.stringContaining('session resumed after crash'),
        );
      });
      expect(mark).toHaveBeenCalledWith(expect.objectContaining({
        scopeKey: mapKey,
        purpose: 'respawn_continuation',
        timeoutMs: 240_000,
        onTimeout: expect.any(Function),
      }));
      admitPendingSystemResult(state, mapKey, 'respawn_continuation');
      expect(mockSession.sendTurn).toHaveBeenCalledWith(
        expect.stringContaining('session resumed after crash'),
      );
    });

    it('aborts the continuation when the resumed session is still inactive (~7443 early return)', async () => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const state = runtime as unknown as PollRuntimeState;
      const mapKey = dmJid;
      seedPerChatSession(state, mapKey);

      // Stays inactive even after spawnSession — continuation must not be sent.
      mockSession.getStatus.mockReturnValue({ active: false, pid: null, providerTerminated: true, sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null });

      state.handlePerChatCrash(mapKey, dmJid, {
        ...currentCrashIdentity(runtime, mapKey),
        exitCode: 1, signal: null, sessionId: 'sess-3', dbRowId: 11,
      });

      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(2_000);

      expect(mockSession.spawnSession).toHaveBeenCalledWith('sess-3', 11);
      expect(mockSession.sendTurn).not.toHaveBeenCalledWith(
        expect.stringContaining('session resumed after crash'),
      );
    });

    it('emits agent_respawn_failed alert once the crash limit is exhausted (~7465-7467)', () => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const state = runtime as unknown as PollRuntimeState;
      const mapKey = dmJid;
      seedPerChatSession(state, mapKey);

      // Seed the prior crash history, then deliver one current-generation crash.
      // Replaying the same callback would now be (correctly) deduplicated while
      // the generation is recoverable_dead, so it cannot model distinct crashes.
      const crashState = state as unknown as { recordCrash: (key: string) => number };
      for (let i = 0; i < 3; i++) crashState.recordCrash(mapKey);
      state.handlePerChatCrash(mapKey, dmJid, {
        ...currentCrashIdentity(runtime, mapKey),
        exitCode: 1, signal: 'SIGKILL', sessionId: 'sess-x', dbRowId: 1,
        provider: 'p', crashClass: 'oom', stderrPreview: 'kaboom',
      });

      expect(mockEmitAlert).toHaveBeenCalledWith(
        'test',
        'agent_respawn_failed',
        expect.stringContaining('respawn exhausted'),
        expect.stringContaining('Last exit'),
      );
    });
  });

  // ── intentional suspend-class exits vs the auto-respawn budget (3395) ──────
  //
  // #3394 classifies a supervisor-issued kill (takeIntentionalKill) and threads
  // the matched reason through SessionCrashInfo.terminationReason. #3395: a
  // marked-intentional exit is a resumable suspend-class exit and must not
  // charge the auto-respawn attempt budget — a bot that idle-suspends
  // repeatedly must never reach "auto-respawn exhausted". Unmarked exits (an
  // external SIGTERM, a bare 143 that no marker claimed) keep counting, so a
  // genuinely crashing child still exhausts at the same threshold.
  describe('intentional suspend-class exits do not charge the auto-respawn budget (3395)', () => {
    type OwnershipView = {
      get: (key: string) => { managerId: string; generation: number; state: string } | undefined;
      advanceGeneration: (key: string, managerId: string) => number;
      transition: (key: string, managerId: string, to: never) => void;
    };
    type CrashBudgetState = PollRuntimeState & {
      getCrashCount: (key: string) => number;
      exhaustedRespawnOwners: Set<string>;
      sessionOwnership: OwnershipView;
    };

    function makeCrashBudgetRuntime(): { runtime: AgentRuntime; state: CrashBudgetState } {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const state = runtime as unknown as CrashBudgetState;
      setOwnedTestSession(runtime, dmJid);
      state.chatQueues.set(dmJid, mockQueue);
      return { runtime, state };
    }

    // Model one reap→respawn cycle boundary: a real respawn advances the owner
    // generation and reactivates it before the next exit can be observed. The
    // first cycle keeps the freshly claimed 'starting' generation. Returns
    // false once the owner is gone (released by exhaustion terminalization) so
    // the loop degrades into a readable assertion diff instead of throwing.
    function reactivateForNextCycle(state: CrashBudgetState, mapKey: string): boolean {
      const owner = state.sessionOwnership.get(mapKey);
      if (!owner) return false;
      if (owner.state !== 'starting') {
        state.sessionOwnership.advanceGeneration(mapKey, owner.managerId);
        state.sessionOwnership.transition(mapKey, owner.managerId, 'active' as never);
      }
      return true;
    }

    it('recurring marked-intentional reaps never consume respawn attempts (3395)', () => {
      const { runtime, state } = makeCrashBudgetRuntime();
      const mapKey = dmJid;

      // Six reap/respawn cycles — well past AUTO_RESPAWN_MAX_CRASHES (3).
      const counts: number[] = [];
      const states: string[] = [];
      for (let cycle = 0; cycle < 6; cycle++) {
        if (!reactivateForNextCycle(state, mapKey)) {
          counts.push(-1);
          states.push('released');
          continue;
        }
        state.handlePerChatCrash(mapKey, dmJid, {
          ...currentCrashIdentity(runtime, mapKey),
          exitCode: null,
          signal: 'SIGKILL',
          sessionId: null,
          dbRowId: null,
          provider: 'p',
          terminationReason: 'idle_watchdog',
        });
        counts.push(state.getCrashCount(mapKey));
        states.push(state.sessionOwnership.get(mapKey)?.state ?? 'released');
      }

      // The budget is never charged: no crash counted, no exhaustion, no alert.
      expect(counts).toEqual([0, 0, 0, 0, 0, 0]);
      expect(states).toEqual(Array<string>(6).fill('recoverable_dead'));
      expect(state.exhaustedRespawnOwners.has(mapKey)).toBe(false);
      // Stronger than a shaped not.toHaveBeenCalledWith: no respawn-failed
      // alert with ANY argument shape may exist.
      expect(mockEmitAlert.mock.calls.filter((c) => c[1] === 'agent_respawn_failed')).toHaveLength(0);

      // The full budget is still intact afterwards: genuine crashes alone must
      // walk it 1→4 and exhaust exactly on the 4th, not earlier.
      const genuineStates: string[] = [];
      const genuineCounts: number[] = [];
      for (let i = 0; i < 4; i++) {
        if (!reactivateForNextCycle(state, mapKey)) {
          genuineCounts.push(-1);
          genuineStates.push('released');
          continue;
        }
        state.handlePerChatCrash(mapKey, dmJid, {
          ...currentCrashIdentity(runtime, mapKey),
          exitCode: 1,
          signal: null,
          sessionId: null,
          dbRowId: null,
        });
        genuineCounts.push(state.getCrashCount(mapKey));
        genuineStates.push(state.sessionOwnership.get(mapKey)?.state ?? 'released');
      }
      expect(genuineCounts).toEqual([1, 2, 3, 4]);
      // Exhaustion terminalization releases the ownership record.
      expect(genuineStates).toEqual(['recoverable_dead', 'recoverable_dead', 'recoverable_dead', 'released']);
      expect(state.exhaustedRespawnOwners.has(mapKey)).toBe(true);
      expect(mockEmitAlert).toHaveBeenCalledWith(
        'test',
        'agent_respawn_failed',
        expect.stringContaining('respawn exhausted'),
        expect.stringContaining('Last exit'),
      );
    });

    it('an unmarked graceful 143 exit still charges the budget (the 3394 pin)', () => {
      const { runtime, state } = makeCrashBudgetRuntime();
      const mapKey = dmJid;

      // No terminationReason: the exit was not claimed by takeIntentionalKill,
      // so the numeric SIGTERM form must keep counting as a crash.
      expect(reactivateForNextCycle(state, mapKey)).toBe(true);
      state.handlePerChatCrash(mapKey, dmJid, {
        ...currentCrashIdentity(runtime, mapKey),
        exitCode: 143,
        signal: null,
        sessionId: null,
        dbRowId: null,
      });
      expect(state.getCrashCount(mapKey)).toBe(1);
      expect(state.sessionOwnership.get(mapKey)?.state).toBe('recoverable_dead');

      // An external SIGTERM (signal form, unmarked) counts too.
      expect(reactivateForNextCycle(state, mapKey)).toBe(true);
      state.handlePerChatCrash(mapKey, dmJid, {
        ...currentCrashIdentity(runtime, mapKey),
        exitCode: null,
        signal: 'SIGTERM',
        sessionId: null,
        dbRowId: null,
      });
      expect(state.getCrashCount(mapKey)).toBe(2);
    });

    it('genuine crash exhaustion still triggers at the unchanged threshold', () => {
      const { runtime, state } = makeCrashBudgetRuntime();
      const mapKey = dmJid;

      const counts: number[] = [];
      const exhaustedAfter: boolean[] = [];
      for (let i = 0; i < 4; i++) {
        if (!reactivateForNextCycle(state, mapKey)) {
          counts.push(-1);
          exhaustedAfter.push(true);
          continue;
        }
        state.handlePerChatCrash(mapKey, dmJid, {
          ...currentCrashIdentity(runtime, mapKey),
          exitCode: 1,
          signal: 'SIGKILL',
          sessionId: null,
          dbRowId: null,
        });
        counts.push(state.getCrashCount(mapKey));
        exhaustedAfter.push(state.exhaustedRespawnOwners.has(mapKey));
      }

      expect(counts).toEqual([1, 2, 3, 4]);
      expect(exhaustedAfter).toEqual([false, false, false, true]);
      const respawnFailedAlerts = mockEmitAlert.mock.calls.filter(
        (call) => call[1] === 'agent_respawn_failed',
      );
      expect(respawnFailedAlerts).toHaveLength(1);
      expect(mockEmitAlert).toHaveBeenCalledWith(
        'test',
        'agent_respawn_failed',
        expect.stringContaining('respawn exhausted'),
        expect.stringContaining('Last exit'),
      );
    });
  });
});

// ─── P4: fresh-spawn context preamble (effect-free by construction) ─────────
//
// The old contract sent recent history as a fresh_session_context SYSTEM turn.
// The admission gate rejects every effect from that owner
// (purpose_disallows_effect), so an action-heavy context block burned the whole
// 240s deadline attempting effects it could never apply; the timeout quarantine
// then killed the session under the queued user turn (observed twice on the
// production owner DM, 2026-07-17 — inbound seqs 49207/49219 dropped). The new
// contract merges context into the user turn at the provider boundary: one
// send, no system lease, no deadline race.

import { getRecentMessages } from '../../../src/core/messages.ts';

describe('fresh-spawn context preamble (P4 — effect-free by construction)', () => {
  const chatJid = '15550002222@s.whatsapp.net';
  const bearerToken = 'tokFAKE1234567890abcd';

  beforeEach(() => {
    const agentConfig = mockConfig as typeof mockConfig & {
      agentProvider?: string;
      agentFallbacks?: Array<{ provider: string; model?: string }>;
    };
    agentConfig.agentProvider = 'claude-cli';
    delete agentConfig.agentFallbacks;
    vi.mocked(mockSession.sendTurn).mockReset().mockResolvedValue(undefined);
    vi.mocked(mockSession.getProviderId).mockReset().mockReturnValue('claude-cli');
    vi.mocked(mockSession.getStatus).mockReset().mockReturnValue({
      active: false,
      pid: null,
      providerTerminated: true,
      sessionId: null,
      startedAt: null,
      messageCount: 0,
      lastMessageAt: null,
    });
    vi.mocked(getRecentMessages).mockReset();
    vi.mocked(getRecentMessages).mockReturnValue([]);
  });

  afterEach(() => {
    const agentConfig = mockConfig as typeof mockConfig & {
      agentProvider?: string;
      agentFallbacks?: Array<{ provider: string; model?: string }>;
    };
    delete agentConfig.agentProvider;
    delete agentConfig.agentFallbacks;
  });

  function recentRows() {
    return [
      { timestamp: 1_784_299_000, senderName: 'q', senderJid: '15550003333@s.whatsapp.net', content: 'earlier message one', isFromMe: true },
      { timestamp: 1_784_300_000, senderName: 'Lucas', senderJid: chatJid, content: 'earlier message two', isFromMe: false },
    ];
  }

  it('merges recent context into the user turn — no fresh_session_context system turn, no barrier race', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test');
    const state = runtime as unknown as PollRuntimeState & {
      sendTurnToSession(session: typeof mockSession, chatJid: string, text: string): Promise<void>;
      currentTurnReplayText: string | null;
    };
    await runtime.start();
    vi.mocked(getRecentMessages).mockReturnValue(recentRows() as ReturnType<typeof getRecentMessages>);
    const mark = vi.spyOn(state.pendingSystemResults, 'mark');

    await state.sendTurnToSession(mockSession, chatJid, 'Continue');

    expect(mark).not.toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'fresh_session_context' }),
    );
    // Replay/journal capture must keep the pure user text — the preamble exists
    // only at the provider boundary.
    expect(state.currentTurnReplayText).toBeNull();
    expect(mockSession.sendTurn).toHaveBeenCalledTimes(1);
    const sent = (vi.mocked(mockSession.sendTurn).mock.calls[0] as unknown as [{
      applicationContext: string[];
      userText: string;
    }])[0];
    expect(sent.applicationContext[0]).toMatch(/^\[Recent chat context — read before responding\]\n/);
    expect(sent.applicationContext[0]).toContain('earlier message one');
    expect(sent.applicationContext[0].indexOf('earlier message one'))
      .toBeLessThan(sent.applicationContext[0].indexOf('earlier message two'));
    expect(sent.userText).toBe('Continue');
  });

  it('keeps the active inbound request out of recent context so it appears exactly once', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test');
    const state = runtime as unknown as PollRuntimeState & {
      sendTurnToSession(
        session: typeof mockSession,
        chatJid: string,
        text: string,
        mapKey?: string,
        actorJid?: string,
      ): Promise<void>;
    };
    await runtime.start();
    vi.mocked(getRecentMessages).mockReturnValue([
      ...recentRows(),
      {
        timestamp: 1_784_301_000,
        senderName: 'Lucas',
        senderJid: chatJid,
        content: 'Continue',
        isFromMe: false,
      },
    ] as ReturnType<typeof getRecentMessages>);

    await state.sendTurnToSession(mockSession, chatJid, 'Continue', undefined, chatJid);

    const sent = (vi.mocked(mockSession.sendTurn).mock.calls[0] as unknown as [{
      applicationContext: string[];
      userText: string;
    }])[0];
    expect(sent.applicationContext[0]).not.toContain('Continue');
    expect(sent.userText).toBe('Continue');
    expect(JSON.stringify(sent).match(/Continue/g)).toHaveLength(1);
  });

  it('sends the plain user text when no recent history exists', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test');
    const state = runtime as unknown as PollRuntimeState & {
      sendTurnToSession(session: typeof mockSession, chatJid: string, text: string): Promise<void>;
    };
    await runtime.start();
    vi.mocked(getRecentMessages).mockReturnValue([]);

    await state.sendTurnToSession(mockSession, chatJid, 'Continue');

    expect(mockSession.sendTurn).toHaveBeenCalledTimes(1);
    expect(mockSession.sendTurn).toHaveBeenCalledWith('Continue');
  });

  it('proceeds with the plain user text when context assembly throws', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test');
    const state = runtime as unknown as PollRuntimeState & {
      sendTurnToSession(session: typeof mockSession, chatJid: string, text: string): Promise<void>;
    };
    await runtime.start();
    vi.mocked(getRecentMessages).mockImplementation(() => {
      throw new Error('db read failed');
    });

    await state.sendTurnToSession(mockSession, chatJid, 'Continue');

    expect(mockSession.sendTurn).toHaveBeenCalledTimes(1);
    expect(mockSession.sendTurn).toHaveBeenCalledWith('Continue');
  });

  it('redacts fresh context for a live cross-provider session after the fallback window expires', async () => {
    const runtime = new AgentRuntime(makeDb(), makeMessenger().messenger, 'test');
    await runtime.start();
    vi.mocked(mockSession.getProviderId).mockReturnValue('opencode-cli');
    vi.mocked(getRecentMessages).mockReturnValue([{
      timestamp: 1_784_300_000,
      senderName: 'Lucas',
      senderJid: chatJid,
      content: `use Bearer ${bearerToken} for the call`,
      isFromMe: false,
    }] as ReturnType<typeof getRecentMessages>);

    await runtime.handleMessage(makeMsg({
      chatJid,
      senderJid: chatJid,
      content: 'Continue',
    }));
    await vi.waitFor(() => expect(mockSession.sendTurn).toHaveBeenCalledTimes(1));

    const sent = (vi.mocked(mockSession.sendTurn).mock.calls[0] as unknown as [{
      applicationContext: string[];
      userText: string;
    }])[0];
    expect(sent.applicationContext[0]).toContain('Bearer [REDACTED]');
    expect(sent.applicationContext[0]).not.toContain(bearerToken);
    expect(sent.userText).toBe('Continue');
  });

  it('preserves fresh context for a same-provider session while a fallback window is active', async () => {
    const agentConfig = mockConfig as typeof mockConfig & {
      agentFallbacks?: Array<{ provider: string; model?: string }>;
    };
    agentConfig.agentFallbacks = [{ provider: 'claude-cli', model: 'haiku-fast' }];
    const runtime = new AgentRuntime(makeDb(), makeMessenger().messenger, 'test');
    await runtime.start();
    expect(runtime.forceFallback()).toMatchObject({ ok: true });
    vi.mocked(getRecentMessages).mockReturnValue([{
      timestamp: 1_784_300_000,
      senderName: 'Lucas',
      senderJid: chatJid,
      content: `use Bearer ${bearerToken} for the call`,
      isFromMe: false,
    }] as ReturnType<typeof getRecentMessages>);

    await runtime.handleMessage(makeMsg({
      chatJid,
      senderJid: chatJid,
      content: 'Continue',
    }));
    await vi.waitFor(() => expect(mockSession.sendTurn).toHaveBeenCalledTimes(1));

    const sent = (vi.mocked(mockSession.sendTurn).mock.calls[0] as unknown as [{
      applicationContext: string[];
      userText: string;
    }])[0];
    expect(sent.applicationContext[0]).toContain(bearerToken);
    expect(sent.applicationContext[0]).not.toContain('Bearer [REDACTED]');
    expect(sent.userText).toBe('Continue');
  });

  it('prepends a one-shot stand-in introduction for a cross-provider session during an active fallback window', async () => {
    const agentConfig = mockConfig as typeof mockConfig & {
      agentFallbacks?: Array<{ provider: string; model?: string }>;
    };
    agentConfig.agentFallbacks = [{ provider: 'opencode-cli', model: 'glm/glm-5.2' }];
    const runtime = new AgentRuntime(makeDb(), makeMessenger().messenger, 'test');
    await runtime.start();
    expect(runtime.forceFallback()).toMatchObject({ ok: true });
    vi.mocked(mockSession.getProviderId).mockReturnValue('opencode-cli');
    vi.mocked(getRecentMessages).mockReturnValue(recentRows() as ReturnType<typeof getRecentMessages>);

    await runtime.handleMessage(makeMsg({ chatJid, senderJid: chatJid, content: 'Continue' }));
    await vi.waitFor(() => expect(mockSession.sendTurn).toHaveBeenCalledTimes(1));

    const sent = (vi.mocked(mockSession.sendTurn).mock.calls[0] as unknown as [{
      applicationContext: string[];
      userText: string;
    }])[0];
    // Intro leads, identifies the stand-in, and instructs continuation; the
    // recent-context block follows in the same preamble entry so the model
    // reads WHO it is before the thread it must continue.
    expect(sent.applicationContext[0]).toMatch(/^\[Provider handoff — read before responding\]\n/);
    expect(sent.applicationContext[0]).toContain('glm/glm-5.2');
    expect(sent.applicationContext[0]).toContain('introduce yourself');
    expect(sent.applicationContext[0]).toContain('[Recent chat context — read before responding]');
    expect(sent.userText).toBe('Continue');

    // One-shot per manager: the manager is marked introduced, so the next
    // fresh-spawn turn skips the handoff block. (Asserted via the mark rather
    // than a second dispatched turn — the mocked session never completes its
    // provider turn, so a second inbound would queue behind it forever.)
    const introduced = (runtime as unknown as {
      introducedStandIns: WeakSet<object>;
    }).introducedStandIns;
    expect(introduced.has(mockSession as unknown as object)).toBe(true);
  });
});

describe('AgentRuntime route recycle publication and shutdown ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    capturedOnEventRef.current = null;
    capturedOnCrashRef.current = null;
    capturedNotifyUserRef.current = null;
    mockSession.spawnSession.mockReset().mockResolvedValue(undefined);
    mockSession.shutdown.mockReset().mockResolvedValue(undefined);
    mockSession.getStatus.mockReset().mockReturnValue({ active: false, pid: null, providerTerminated: true, sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null });
    mockSession.sendTurn.mockReset().mockResolvedValue(undefined);
    mockSession.getDbRowId.mockReset().mockReturnValue(null);
    mockQueue.flush.mockReset().mockResolvedValue(undefined);
    mockQueue.abortTurn.mockReset();
    mockConfig.controlPeers = new Map();
  });

  function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
    return {
      messageId: 'msg-1',
      chatJid: 'test@s.whatsapp.net',
      senderJid: 'sender@s.whatsapp.net',
      senderName: 'Test User',
      content: 'hello',
      contentType: 'text',
      isFromMe: false,
      isGroup: false,
      mentionedJids: [],
      timestamp: Date.now(),
      quotedMessageId: null,
      contentText: null,
      isResponseWorthy: true,
      ...overrides,
    };
  }

  function makeQueueMock(targetChatJid: string): IOutboundQueue {
    return {
      enqueueText: vi.fn(),
      getSenderToken: () => 'mock-sender-token',
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
      endTurn: vi.fn(),
      updateDeliveryJid: vi.fn(),
      setInboundSeq: vi.fn(),
      markLastTerminal: vi.fn(),
      clearLastOpId: vi.fn(),
      beginTurnEvidence: vi.fn(),
      flushTurnEvidence: vi.fn(async (turnId: string) => ({
        turnId,
        answerOpIds: [] as number[],
        lifecycleOpIds: [] as number[],
        statusOpIds: [] as number[],
      })),
      setToolUpdateMode: vi.fn(),
      setToolUpdateRedirectJid: vi.fn(),
      setTextAggregateDelayMs: vi.fn(),
      enqueuePoll: vi.fn(async (fn: () => Promise<void>) => { await fn(); }),
      hasPendingPoll: vi.fn(() => false),
      setPollPending: vi.fn(),
      targetChatJid,
      getLastOpId: vi.fn(() => undefined),
      setDurability: vi.fn(),
    };
  }

  it('tracks ordinary singleton handleMessage work until its deferred recycle is published and settled', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    let releaseQueuedWork!: () => void;
    const queuedWorkBlocker = new Promise<void>((resolve) => {
      releaseQueuedWork = resolve;
    });
    let releaseRecycle!: () => void;
    const recycleBlocker = new Promise<void>((resolve) => {
      releaseRecycle = resolve;
    });
    const session = {
      getProviderId: () => 'claude-cli',
      getModelRef: () => 'old-model',
      getSpawnedEffort: () => null,
      shutdown: vi.fn(async () => {
        await recycleBlocker;
      }),
    };
    const state = runtime as unknown as {
      session: typeof session | null;
      queue: IOutboundQueue | null;
      activeChatJid: string | null;
      turnChain: Promise<void>;
      pendingRecycle: Set<string>;
      routeRecyclePublicationWork: Map<Promise<void>, string>;
    };
    state.session = session;
    state.queue = makeQueueMock('test@s.whatsapp.net');
    state.activeChatJid = 'test@s.whatsapp.net';
    state.pendingRecycle.add('__global__');
    state.turnChain = queuedWorkBlocker;

    await runtime.handleMessage(makeMsg({ content: '/status' }));
    const ordinaryQueuedWork = state.turnChain;

    expect([...state.routeRecyclePublicationWork.entries()]).toEqual([
      [ordinaryQueuedWork, '__global__'],
    ]);

    const shutdown = runtime.shutdown();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(session.shutdown).not.toHaveBeenCalled();
    expect(state.session).toBe(session);

    releaseQueuedWork();
    await vi.waitFor(() => expect(session.shutdown).toHaveBeenCalledOnce());

    expect(session.shutdown).toHaveBeenCalledWith(false);
    expect(state.session).toBe(session);

    releaseRecycle();
    await expect(shutdown).resolves.toBeUndefined();

    expect({
      shutdownCalls: session.shutdown.mock.calls,
      publicationScopes: [...state.routeRecyclePublicationWork.values()],
      session: state.session,
    }).toEqual({
      shutdownCalls: [[false]],
      publicationScopes: [],
      session: null,
    });
  });

  it('retains and retries the exact per-chat owner when ordinary handleMessage recycle publication fails', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const mapKey = 'test@s.whatsapp.net';
    const recycleError = new Error('route recycle tree still live');
    let releaseQueuedWork!: () => void;
    const queuedWorkBlocker = new Promise<void>((resolve) => {
      releaseQueuedWork = resolve;
    });
    let rejectRecycle!: (error: unknown) => void;
    const recycleBlocker = new Promise<void>((_resolve, reject) => {
      rejectRecycle = reject;
    });
    const session = {
      getProviderId: () => 'claude-cli',
      getModelRef: () => 'old-model',
      getSpawnedEffort: () => null,
      shutdown: vi.fn(() => recycleBlocker),
    };
    const queue = makeQueueMock(mapKey);
    const state = runtime as unknown as {
      chatSessions: Map<string, typeof session>;
      chatQueues: Map<string, IOutboundQueue>;
      turnChain: Promise<void>;
      pendingRecycle: Set<string>;
      routeRecyclePublicationWork: Map<Promise<void>, string>;
    };
    state.chatSessions.set(mapKey, session);
    state.chatQueues.set(mapKey, queue);
    state.pendingRecycle.add(mapKey);
    state.turnChain = queuedWorkBlocker;

    await runtime.handleMessage(makeMsg({ content: '/status' }));
    const ordinaryQueuedWork = state.turnChain;

    expect([...state.routeRecyclePublicationWork.entries()]).toEqual([
      [ordinaryQueuedWork, mapKey],
    ]);

    const shutdown = runtime.shutdown();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(session.shutdown).not.toHaveBeenCalled();
    expect(state.chatSessions.get(mapKey)).toBe(session);

    releaseQueuedWork();
    await vi.waitFor(() => expect(session.shutdown).toHaveBeenCalledOnce());
    expect(session.shutdown).toHaveBeenCalledWith(false);
    expect(state.chatSessions.get(mapKey)).toBe(session);

    rejectRecycle(recycleError);
    await expect(shutdown).rejects.toBe(recycleError);

    expect(session.shutdown).toHaveBeenCalledTimes(1);
    expect(state.chatSessions.get(mapKey)).toBe(session);
    expect(state.chatQueues.get(mapKey)).toBe(queue);
    expect(state.routeRecyclePublicationWork.size).toBe(0);

    session.shutdown.mockResolvedValueOnce(undefined);
    await expect(runtime.shutdown()).resolves.toBeUndefined();

    expect(session.shutdown).toHaveBeenCalledTimes(2);
    expect(state.chatSessions.has(mapKey)).toBe(false);
    expect(state.chatQueues.has(mapKey)).toBe(false);
  });

  it('retains only the exact per-chat owner when ordinary recycle publication misses the shutdown deadline', async () => {
    vi.useFakeTimers();
    try {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const targetKey = 'test@s.whatsapp.net';
      const unrelatedKey = 'other@s.whatsapp.net';
      let releaseQueuedWork!: () => void;
      const queuedWorkBlocker = new Promise<void>((resolve) => {
        releaseQueuedWork = resolve;
      });
      const targetSession = {
        getProviderId: () => 'claude-cli',
        getModelRef: () => 'old-model',
        getSpawnedEffort: () => null,
        shutdown: vi.fn(async () => {}),
      };
      const unrelatedSession = {
        getProviderId: () => 'claude-cli',
        getModelRef: () => 'other-model',
        getSpawnedEffort: () => null,
        shutdown: vi.fn(async () => {}),
      };
      const state = runtime as unknown as {
        chatSessions: Map<string, typeof targetSession>;
        chatQueues: Map<string, IOutboundQueue>;
        turnChain: Promise<void>;
        pendingRecycle: Set<string>;
        routeRecyclePublicationWork: Map<Promise<void>, string>;
      };
      state.chatSessions.set(targetKey, targetSession);
      state.chatSessions.set(unrelatedKey, unrelatedSession);
      state.chatQueues.set(targetKey, makeQueueMock(targetKey));
      state.chatQueues.set(unrelatedKey, makeQueueMock(unrelatedKey));
      state.pendingRecycle.add(targetKey);
      state.turnChain = queuedWorkBlocker;

      await runtime.handleMessage(makeMsg({ content: '/status' }));
      expect([...state.routeRecyclePublicationWork.values()]).toEqual([targetKey]);

      const shutdown = runtime.shutdown();
      const shutdownFailure = expect(shutdown).rejects.toThrow(
        'Route recycle shutdown join deadline expired',
      );
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(2_000);
      await shutdownFailure;

      expect(targetSession.shutdown).not.toHaveBeenCalled();
      expect(unrelatedSession.shutdown).toHaveBeenCalledOnce();
      expect(state.chatSessions.get(targetKey)).toBe(targetSession);

      releaseQueuedWork();
      await state.turnChain;
    } finally {
      vi.useRealTimers();
    }
  });

  it('joins a newly published singleton route recycle before shutdown enumerates sessions', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    let releaseSessionShutdown!: () => void;
    const sessionShutdownBlocked = new Promise<void>((resolve) => {
      releaseSessionShutdown = resolve;
    });
    const session = {
      getProviderId: () => 'claude-cli',
      getModelRef: () => 'old-model',
      getSpawnedEffort: () => null,
      shutdown: vi.fn(async () => {
        await sessionShutdownBlocked;
      }),
    };
    let releaseQueuedCommand!: () => void;
    const queuedCommandGate = new Promise<void>((resolve) => {
      releaseQueuedCommand = resolve;
    });
    let markFinalizationStarted!: () => void;
    const finalizationStarted = new Promise<void>((resolve) => {
      markFinalizationStarted = resolve;
    });
    let releaseFinalization!: () => void;
    const finalizationBlocked = new Promise<void>((resolve) => {
      releaseFinalization = resolve;
    });
    const state = runtime as unknown as {
      session: typeof session | null;
      queue: IOutboundQueue | null;
      activeChatJid: string | null;
      turnChain: Promise<void>;
      routeRecycleCommandWork: Set<Promise<void>>;
      resolveRouteForTurn: () => unknown;
      applyRouteChangeAndRecycle(
        chatJid: string,
        senderJid: string,
        mapKey: string | undefined,
      ): Promise<string>;
      runtimeTurnCoordinator: {
        finalizeActiveRuntimeTurnsForShutdown(deadlineAt?: number): Promise<void>;
      };
    };
    state.session = session;
    state.queue = makeQueueMock('test@s.whatsapp.net');
    state.activeChatJid = 'test@s.whatsapp.net';
    state.resolveRouteForTurn = () => ({
      provider: 'claude-cli',
      model: 'new-model',
      source: 'preference',
      reasonCode: 'user_pin',
      pinnedProvider: null,
    });
    let queuedCommand!: Promise<void>;
    queuedCommand = queuedCommandGate.then(async () => {
      await state.applyRouteChangeAndRecycle(
        'test@s.whatsapp.net',
        'sender@s.whatsapp.net',
        undefined,
      );
    }).finally(() => {
      state.routeRecycleCommandWork.delete(queuedCommand);
    });
    state.turnChain = queuedCommand;
    state.routeRecycleCommandWork.add(queuedCommand);
    state.runtimeTurnCoordinator.finalizeActiveRuntimeTurnsForShutdown = vi.fn(async () => {
      markFinalizationStarted();
      await finalizationBlocked;
    });

    const shutdown = runtime.shutdown();
    await finalizationStarted;
    releaseQueuedCommand();
    await vi.waitFor(() => expect(session.shutdown).toHaveBeenCalledTimes(1));
    expect(state.session).toBe(session);
    expect(state.queue).not.toBeNull();
    releaseFinalization();
    await Promise.resolve();

    expect(session.shutdown).toHaveBeenCalledTimes(1);
    expect(state.session).toBe(session);
    releaseSessionShutdown();
    await expect(shutdown).resolves.toBeUndefined();
    expect({
      shutdownCalls: session.shutdown.mock.calls.length,
      session: state.session,
      queue: state.queue,
    }).toEqual({
      shutdownCalls: 1,
      session: null,
      queue: null,
    });
  });

  it('does not re-enter a failed per-chat route recycle during runtime shutdown', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const mapKey = 'test@s.whatsapp.net';
    const recycleError = new Error('route recycle tree still live');
    let rejectSessionShutdown!: (error: unknown) => void;
    const sessionShutdownBlocked = new Promise<void>((_resolve, reject) => {
      rejectSessionShutdown = reject;
    });
    const session = {
      getProviderId: () => 'claude-cli',
      getModelRef: () => 'old-model',
      getSpawnedEffort: () => null,
      shutdown: vi.fn(() => sessionShutdownBlocked),
    };
    const queue = makeQueueMock(mapKey);
    const state = runtime as unknown as {
      chatSessions: Map<string, typeof session>;
      chatQueues: Map<string, IOutboundQueue>;
      resolveRouteForTurn: () => unknown;
      applyRouteChangeAndRecycle(
        chatJid: string,
        senderJid: string,
        mapKey: string | undefined,
      ): Promise<string>;
    };
    state.chatSessions.set(mapKey, session);
    state.chatQueues.set(mapKey, queue);
    state.resolveRouteForTurn = () => ({
      provider: 'claude-cli',
      model: 'new-model',
      source: 'preference',
      reasonCode: 'user_pin',
      pinnedProvider: null,
    });

    const recycle = state.applyRouteChangeAndRecycle(
      mapKey,
      'sender@s.whatsapp.net',
      mapKey,
    );
    await vi.waitFor(() => expect(session.shutdown).toHaveBeenCalledTimes(1));
    const shutdown = runtime.shutdown();
    await Promise.resolve();

    expect(session.shutdown).toHaveBeenCalledTimes(1);
    expect(state.chatSessions.get(mapKey)).toBe(session);
    expect(state.chatQueues.get(mapKey)).toBe(queue);
    rejectSessionShutdown(recycleError);
    await expect(recycle).rejects.toBe(recycleError);
    await expect(shutdown).rejects.toBe(recycleError);
    expect(session.shutdown).toHaveBeenCalledTimes(1);
    expect(state.chatSessions.get(mapKey)).toBe(session);
    expect(state.chatQueues.get(mapKey)).toBe(queue);

    session.shutdown.mockResolvedValueOnce(undefined);
    await expect(runtime.shutdown()).resolves.toBeUndefined();
    expect(session.shutdown).toHaveBeenCalledTimes(2);
    expect(state.chatSessions.has(mapKey)).toBe(false);
    expect(state.chatQueues.has(mapKey)).toBe(false);
  });
});
