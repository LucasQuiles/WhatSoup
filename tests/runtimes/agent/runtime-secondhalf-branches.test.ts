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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger, IncomingMessage } from '../../../src/core/types.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import type { IOutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';
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
    sendTurn: vi.fn(async () => {}),
    handleNew: vi.fn(async () => {}),
    getStatus: vi.fn(() => ({ active: false, pid: null as number | null, sessionId: null as string | null, startedAt: null as string | null, messageCount: 0, lastMessageAt: null as string | null })),
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
  };

  const mockQueue = {
    enqueueText: vi.fn(),
    getSenderToken: () => 'mock-sender-token',
    enqueueStreamingText: vi.fn(),
    enqueueResultText: vi.fn(),
    enqueueToolUpdate: vi.fn(),
    enqueueProgressUpdate: vi.fn(),
    indicateTyping: vi.fn(),
    flush: vi.fn(async () => {}),
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

const { mockRuntimeLogger } = vi.hoisted(() => ({
  mockRuntimeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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

// ─── Module mocks ───────────────────────────────────────────────────────────

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => mockRuntimeLogger,
}));

vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlert: mockEmitAlert,
  emitAlertChecked: mockEmitAlert,
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
  getActiveSession: vi.fn(() => null),
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
}));

vi.mock('../../../src/runtimes/agent/outbound-queue.ts', () => ({
  // eslint-disable-next-line prefer-arrow-callback -- constructor mock requires function keyword; expires 2026-12-31
  OutboundQueue: vi.fn().mockImplementation(function () {
    return mockQueue;
  }),
}));

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    adminPhones: new Set<string>(['15550001']),
    controlPeers: new Map<string, string>(),
    toolUpdateMode: 'full' as const,
    toolUpdateRedirectJid: null as string | null,
    textAggregateDelayMs: 2_000,
    stateRoot: '/tmp/whatsoup-test-state-secondhalf',
    restartLoopGuard: { enabled: true, maxRestarts: 3, windowMs: 300_000 },
    startupNotifications: true,
    proactiveResumeOnStartup: true,
    mediaDir: '/tmp/whatsoup-test-media/tmp',
    pineconeAllowedIndexes: [] as string[],
    voiceReply: 'never' as const,
    elevenlabs: { defaultVoiceId: 'v', defaultModel: 'm', stability: 0.5, similarityBoost: 0.75 },
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

type CrashInfo = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  sessionId: string | null;
  dbRowId: number | null;
  provider?: string;
  crashClass?: string;
  stderrPreview?: string;
  generationIdentity?: { managerId: string; generation: number };
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
    mockSession.getStatus.mockReturnValue({ active: false, pid: null, sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null });
    mockSession.sendTurn.mockResolvedValue(undefined);
    mockSession.getDbRowId.mockReturnValue(null);
    mockGetMessagesSince.mockReturnValue([]);
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
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
        prompt: 'do work',
        title: 'scheduled work',
        reportChatJid: 'test@g.us',
      })).toEqual({ dispatched: false, detail: 'database compatibility drain' });
      expect(db.assertWritableCompatibility).toHaveBeenCalledTimes(1);
      expect(mockSession.sendTurn).not.toHaveBeenCalled();
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
        .mockReturnValueOnce({ active: false, pid: null, sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null }) // timer guard check
        .mockReturnValue({ active: true, pid: 321, sessionId: 'sess-1', startedAt: '2026-06-16T00:00:00Z', messageCount: 1, lastMessageAt: null }); // post-resume

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
        .mockReturnValueOnce({ active: false, pid: null, sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null })
        .mockReturnValue({ active: true, pid: 321, sessionId: 'sess-2', startedAt: '2026-06-16T00:00:00Z', messageCount: 1, lastMessageAt: null });

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
      mockSession.getStatus.mockReturnValue({ active: false, pid: null, sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null });

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

  beforeEach(() => {
    vi.mocked(mockSession.sendTurn).mockClear();
    vi.mocked(getRecentMessages).mockReset();
    vi.mocked(getRecentMessages).mockReturnValue([]);
  });

  function recentRows() {
    return [
      { timestamp: 1_784_300_000, senderName: 'Lucas', senderJid: chatJid, content: 'earlier message two' },
      { timestamp: 1_784_299_000, senderName: 'q', senderJid: '15550003333@s.whatsapp.net', content: 'earlier message one' },
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
    const sent = (vi.mocked(mockSession.sendTurn).mock.calls[0] as unknown as [string])[0];
    expect(sent).toMatch(/^\[Recent chat context — read before responding\]\n/);
    expect(sent).toContain('earlier message one');
    expect(sent).toMatch(/\n\n\[Current message\]\nContinue$/);
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
});
