import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../src/core/database.ts';
import type { IncomingMessage, Messenger } from '../../../src/core/types.ts';
import type { IOutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import { createRuntimeTurnContext } from '../../../src/runtimes/agent/runtime-turn-context.ts';

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
    getStatus: vi.fn(() => ({
      active: false,
      pid: null as number | null,
      sessionId: null as string | null,
      startedAt: null as string | null,
      messageCount: 0,
      lastMessageAt: null as string | null,
    })),
    shutdown: vi.fn(async () => {}),
    waitForProviderTurnToTerminalize: vi.fn(async () => {}),
    clearTurnWatchdog: vi.fn(() => {}),
    completeProviderTurn: vi.fn(() => {}),
    tickWatchdog: vi.fn(() => {}),
    trackToolStart: vi.fn((_toolId: string) => {}),
    trackToolEnd: vi.fn((_toolId: string) => {}),
    getDbRowId: vi.fn((): number | null => null),
    setDurability: vi.fn((_durability: unknown) => {}),
    bindGenerationOwnership: vi.fn((_resolve: () => unknown) => {}),
    getProviderId: vi.fn((): string => 'claude-cli'),
    getSpawnedEffort: vi.fn((): string | null => null),
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
    targetChatJid: 'test@s.whatsapp.net',
    getLastOpId: vi.fn(() => undefined),
    setDurability: vi.fn(),
  };
  return {
    mockSession,
    mockQueue,
    capturedOnEventRef,
    capturedOnCrashRef,
    capturedNotifyUserRef,
  };
});

const { mockRuntimeLogger } = vi.hoisted(() => ({
  mockRuntimeLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const { mockEmitAlert, mockClearAlertSource } = vi.hoisted(() => ({
  mockEmitAlert: vi.fn(),
  mockClearAlertSource: vi.fn(),
}));

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
  getMessagesSince: vi.fn(() => []),
  updateMediaPath: vi.fn(),
  updateTranscription: vi.fn(),
}));

vi.mock('../../../src/runtimes/agent/media-prep.ts', () => ({
  prepareContentForAgent: vi.fn(async (msg: IncomingMessage) => msg.content ?? ''),
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
    adminPhones: new Set<string>(['15550100001']),
    controlPeers: new Map<string, string>(),
    toolUpdateMode: 'full' as const,
    toolUpdateRedirectJid: null as string | null,
    textAggregateDelayMs: 2_000,
    stateRoot: '/tmp/whatsoup-test-state-reset-teardown',
    restartLoopGuard: { enabled: true, maxRestarts: 3, windowMs: 300_000 },
    startupNotifications: true,
    proactiveResumeOnStartup: true,
    mediaDir: '/tmp/whatsoup-test-media/tmp',
    pineconeAllowedIndexes: [] as string[],
    voiceReply: 'never' as const,
    elevenlabs: {
      defaultVoiceId: 'v',
      defaultModel: 'm',
      stability: 0.5,
      similarityBoost: 0.75,
    },
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

const _mockQueueTypeCheck: IOutboundQueue = mockQueue;
void _mockQueueTypeCheck;

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import { TurnQueue, type QueuedTurn } from '../../../src/runtimes/agent/turn-queue.ts';

function makeDb(): Database {
  return {
    assertWritableCompatibility: vi.fn(),
    raw: {
      prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) })),
      exec: vi.fn(),
    },
  } as unknown as Database;
}

function makeMessenger(): {
  messenger: Messenger;
  sentMessages: Array<{ jid: string; text: string }>;
} {
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

function makeQueuedTurn(overrides: Partial<QueuedTurn> = {}): QueuedTurn {
  return {
    sourceMessageId: 'queued-turn-probe',
    receivedAtUnixSeconds: 1_780_000_000,
    conversationKey: 'test',
    chatJid: 'test@s.whatsapp.net',
    senderJid: 'sender@s.whatsapp.net',
    senderName: 'Test User',
    text: 'later admitted turn',
    isGroup: false,
    contentType: 'text',
    ...overrides,
  };
}

async function sendAndDrain(runtime: AgentRuntime, msg: IncomingMessage): Promise<void> {
  await runtime.handleMessage(msg);
  await (runtime as unknown as { turnChain: Promise<void> }).turnChain;
}

function makeQueueMock(targetChatJid: string): IOutboundQueue {
  return {
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

function makeTerminalDurabilityMock() {
  return {
    getOutboundDeliverySnapshot: vi.fn(),
    finalizeTurnTerminal: vi.fn(() => ({
      applied: true,
      winnerMatchesRequest: true,
      recordId: 1,
      duplicateFinalizeCount: 0,
      replyGuaranteeDisarmed: true,
      effectiveReplyGuaranteeDisarmed: true,
    })),
  };
}

function attachRuntimeFaultMarkerSpies(runtime: AgentRuntime): {
  durability: {
    completeInbound: ReturnType<typeof vi.fn>;
    markContinuityCandidateIfNoTerminalOutbound: ReturnType<typeof vi.fn>;
    markInboundFailed: ReturnType<typeof vi.fn>;
    upsertSessionCheckpoint: ReturnType<typeof vi.fn>;
    getResumableCheckpoints: ReturnType<typeof vi.fn>;
    getOutboundDeliverySnapshot: ReturnType<typeof vi.fn>;
    finalizeTurnTerminal: ReturnType<typeof vi.fn>;
  };
  replyGuarantee: {
    arm: ReturnType<typeof vi.fn>;
    disarm: ReturnType<typeof vi.fn>;
    isArmed: ReturnType<typeof vi.fn>;
    shutdown: ReturnType<typeof vi.fn>;
  };
} {
  const durability = {
    completeInbound: vi.fn(),
    markContinuityCandidateIfNoTerminalOutbound: vi.fn(() => true),
    markInboundFailed: vi.fn(),
    upsertSessionCheckpoint: vi.fn(),
    getResumableCheckpoints: vi.fn(() => []),
    ...makeTerminalDurabilityMock(),
  };
  const replyGuarantee = {
    arm: vi.fn(),
    disarm: vi.fn(),
    isArmed: vi.fn(() => true),
    notifyActivity: vi.fn(),
    shutdown: vi.fn(),
  };
  (runtime as unknown as { durability: unknown }).durability = durability;
  (runtime as unknown as { replyGuarantee: unknown }).replyGuarantee = replyGuarantee;
  return { durability, replyGuarantee };
}

function makeRuntimeTurnContext(
  scope: 'per_chat' | 'shared' | 'singleton',
  conversationKey: string,
  deliveryJid: string,
  inboundSeq: number,
  logicalTurnId: string,
) {
  return createRuntimeTurnContext({
    identity: {
      scope,
      conversationKey,
      deliveryJid,
      inboundSeq,
      logicalTurnId,
      managerId: `manager-${scope}`,
      generation: 1,
    },
    recoveryOwner: {
      logicalTurnId: `${logicalTurnId}:recovery`,
      managerId: 'manager-recovery',
      generation: 2,
    },
    replay: {
      sourceMessageId: `wamid-${logicalTurnId}`,
      receivedAtUnixSeconds: 1_780_000_000,
      replaySafe: true,
      senderJid: '15550009999@s.whatsapp.net',
      senderName: null,
      text: 'original turn',
      isGroup: false,
    },
    contentType: 'text',
    toolScopeKey: scope === 'per_chat' ? conversationKey : '__global__',
  });
}

const adminSender = '15550100001@s.whatsapp.net';

function makePerChatSession(active: boolean, dbRowId: number | null, startedAt: string | null) {
  return {
    ...mockSession,
    getStatus: vi.fn(() => ({
      active,
      pid: active ? 123 : null,
      sessionId: active ? 'sess-x' : null,
      startedAt,
      messageCount: active ? 4 : 0,
      lastMessageAt: null,
    })),
    getDbRowId: vi.fn((): number | null => dbRowId),
    shutdown: vi.fn(async () => {}),
  };
}

describe('AgentRuntime reset teardown ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    capturedOnEventRef.current = null;
    capturedOnCrashRef.current = null;
    capturedNotifyUserRef.current = null;
    mockSession.spawnSession.mockReset().mockResolvedValue(undefined);
    mockSession.shutdown.mockReset().mockResolvedValue(undefined);
    mockSession.waitForProviderTurnToTerminalize.mockReset().mockResolvedValue(undefined);
    mockSession.getStatus.mockReset().mockReturnValue({
      active: false,
      pid: null,
      sessionId: null,
      startedAt: null,
      messageCount: 0,
      lastMessageAt: null,
    });
    mockSession.sendTurn.mockReset().mockResolvedValue(undefined);
    mockSession.getDbRowId.mockReset().mockReturnValue(null);
    mockQueue.flush.mockReset().mockResolvedValue(undefined);
    mockQueue.flushTurnEvidence.mockReset().mockImplementation(async (turnId: string) => ({
      turnId,
      answerOpIds: [],
      lifecycleOpIds: [],
      statusOpIds: [],
    }));
    mockQueue.abortTurn.mockReset();
    mockQueue.targetChatJid = 'test@s.whatsapp.net';
    mockConfig.adminPhones = new Set<string>([adminSender]);
    mockConfig.controlPeers.clear();
  });
  it('durably terminalizes a published per-chat turn on /new after session and queue ownership are lost', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const { durability } = attachRuntimeFaultMarkerSpies(runtime);
    const mapKey = 'test@s.whatsapp.net';
    const context = makeRuntimeTurnContext(
      'per_chat',
      'test',
      mapKey,
      81,
      'turn-new-per-chat-81',
    );
    const state = runtime as unknown as {
      chatQueues: Map<string, typeof mockQueue>;
      chatSessions: Map<string, typeof mockSession>;
      perChatInboundSeqQueue: Map<string, number[]>;
      perChatRuntimeTurnContexts: Map<string, Array<typeof context>>;
      perChatTurnQueues: Map<string, unknown>;
    };
    await runtime.start();

    // Model the post-publication ownership-loss window: the immutable context
    // and durable FIFO still prove the turn, while the session and processor
    // maps have already lost their owner.
    state.chatQueues.set(mapKey, mockQueue);
    state.perChatInboundSeqQueue.set(mapKey, [81]);
    state.perChatRuntimeTurnContexts.set(mapKey, [context]);
    state.chatSessions.delete(mapKey);
    state.perChatTurnQueues.delete(mapKey);

    await sendAndDrain(runtime, makeMsg({ content: '/new', inboundSeq: 82 }));

    expect(durability.finalizeTurnTerminal).toHaveBeenCalledOnce();
    expect(mockQueue.abortTurn.mock.calls.every(
      ([options]) => (options as { preserveEvidence?: boolean } | undefined)?.preserveEvidence === true,
    )).toBe(true);
    expect(state.perChatRuntimeTurnContexts.has(mapKey)).toBe(false);
    expect(state.perChatInboundSeqQueue.has(mapKey)).toBe(false);
  });

  it('preserves per-chat reset ownership when durable /new terminalization fails', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const { durability } = attachRuntimeFaultMarkerSpies(runtime);
    const mapKey = 'test@s.whatsapp.net';
    const context = makeRuntimeTurnContext(
      'per_chat',
      'test',
      mapKey,
      83,
      'turn-new-per-chat-failure-83',
    );
    const state = runtime as unknown as {
      chatQueues: Map<string, typeof mockQueue>;
      chatSessions: Map<string, typeof mockSession>;
      perChatInboundSeqQueue: Map<string, number[]>;
      perChatRuntimeTurnContexts: Map<string, Array<typeof context>>;
      perChatTurnQueues: Map<string, TurnQueue>;
    };
    await runtime.start();
    state.chatQueues.set(mapKey, mockQueue);
    state.chatSessions.set(mapKey, mockSession);
    state.perChatInboundSeqQueue.set(mapKey, [83]);
    state.perChatRuntimeTurnContexts.set(mapKey, [context]);
    const runtimeQueue = new TurnQueue();
    state.perChatTurnQueues.set(mapKey, runtimeQueue);
    durability.finalizeTurnTerminal.mockImplementation(() => {
      throw new Error('durable reset terminalization failed');
    });
    mockSession.shutdown.mockClear();

    await sendAndDrain(runtime, makeMsg({ content: '/new', inboundSeq: 84 }));

    expect(mockSession.shutdown).not.toHaveBeenCalled();
    expect(state.chatSessions.get(mapKey)).toBe(mockSession);
    expect(state.perChatTurnQueues.get(mapKey)).toBe(runtimeQueue);
    expect(state.perChatRuntimeTurnContexts.get(mapKey)).toEqual([context]);
    expect(state.perChatInboundSeqQueue.get(mapKey)).toEqual([83]);
  });

  it('durably terminalizes an active and a never-dispatched queued per-chat turn on /new', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const { durability } = attachRuntimeFaultMarkerSpies(runtime);
    const mapKey = 'test@s.whatsapp.net';
    const state = runtime as unknown as {
      perChatInboundSeqQueue: Map<string, number[]>;
      perChatRuntimeTurnContexts: Map<string, unknown[]>;
      perChatTurnQueues: Map<string, TurnQueue>;
      turnChain: Promise<void>;
    };
    let markSendStarted!: () => void;
    let releaseSend!: () => void;
    const sendStarted = new Promise<void>((resolve) => {
      markSendStarted = resolve;
    });
    const sendBlocked = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    await runtime.start();
    mockSession.getStatus.mockReturnValue({
      active: true,
      pid: 123,
      sessionId: 'per-chat-active-plus-pending',
      startedAt: new Date().toISOString(),
      messageCount: 0,
      lastMessageAt: null,
    });
    mockSession.sendTurn.mockImplementationOnce(async () => {
      markSendStarted();
      await sendBlocked;
    });
    mockSession.shutdown.mockImplementationOnce(async () => {
      releaseSend();
    });

    await runtime.handleMessage(makeMsg({ content: 'active turn', inboundSeq: 95 }));
    await state.turnChain;
    await sendStarted;
    const interruptedRuntimeQueue = state.perChatTurnQueues.get(mapKey)!;
    await runtime.handleMessage(makeMsg({
      content: 'queued behind active',
      inboundSeq: 96,
      messageId: 'msg-queued-96',
    }));
    await state.turnChain;
    expect(interruptedRuntimeQueue.isProcessing).toBe(true);
    expect(interruptedRuntimeQueue.pending).toBe(1);
    expect(state.perChatInboundSeqQueue.get(mapKey)).toEqual([95]);

    try {
      await sendAndDrain(runtime, makeMsg({ content: '/new', inboundSeq: 97 }));

      expect(durability.finalizeTurnTerminal).toHaveBeenCalledTimes(2);
      expect(mockSession.shutdown).toHaveBeenCalledWith(false);
      expect(state.perChatTurnQueues.has(mapKey)).toBe(false);
      expect(state.perChatRuntimeTurnContexts.has(mapKey)).toBe(false);
      expect(state.perChatInboundSeqQueue.has(mapKey)).toBe(false);
      await interruptedRuntimeQueue.idle();
    } finally {
      releaseSend();
    }
  });

  it('preserves singleton reset ownership when an undispatched durable /new terminalization is unproven', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    const { durability } = attachRuntimeFaultMarkerSpies(runtime);
    const context = makeRuntimeTurnContext(
      'singleton',
      'test',
      'test@s.whatsapp.net',
      85,
      'turn-new-singleton-pending-failure-85',
    );
    const state = runtime as unknown as {
      currentInboundSeq?: number;
      pendingSingletonRuntimeTurnContext: typeof context | null;
      session: typeof mockSession | null;
      turnQueue: TurnQueue;
    };
    await runtime.start();
    const runtimeQueue = new TurnQueue();
    state.turnQueue = runtimeQueue;
    state.currentInboundSeq = 85;
    state.pendingSingletonRuntimeTurnContext = context;
    durability.finalizeTurnTerminal.mockImplementation(() => {
      throw new Error('undispatched durable reset terminalization failed');
    });
    mockSession.shutdown.mockClear();

    await sendAndDrain(runtime, makeMsg({
      content: '/new',
      inboundSeq: 86,
      senderJid: '15550100001@s.whatsapp.net',
    }));

    expect(mockSession.shutdown).not.toHaveBeenCalled();
    expect(state.session).toBe(mockSession);
    expect(state.pendingSingletonRuntimeTurnContext).toBe(context);
    expect(runtimeQueue.enqueue(makeQueuedTurn({ inboundSeq: 87 }))).toBe(true);
    expect(runtimeQueue.pending).toBe(1);
  });

  it('restores a pending shared turn when /new finalization fails before supervisor retention', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    attachRuntimeFaultMarkerSpies(runtime);
    const context = makeRuntimeTurnContext(
      'singleton',
      'test',
      'test@s.whatsapp.net',
      88,
      'turn-new-singleton-queued-failure-88',
    );
    const state = runtime as unknown as {
      durability: unknown | null;
      session: typeof mockSession | null;
      turnQueue: TurnQueue;
    };
    await runtime.start();
    const runtimeQueue = new TurnQueue();
    const pending = makeQueuedTurn({
      sourceMessageId: 'queued-before-new-failure',
      inboundSeq: 88,
      runtimeContext: context,
    });
    state.turnQueue = runtimeQueue;
    expect(runtimeQueue.enqueue(pending)).toBe(true);
    state.durability = null;
    mockSession.shutdown.mockClear();

    await sendAndDrain(runtime, makeMsg({
      content: '/new',
      inboundSeq: 89,
      senderJid: '15550100001@s.whatsapp.net',
    }));

    expect(mockSession.shutdown).not.toHaveBeenCalled();
    expect(state.session).toBe(mockSession);
    expect(runtimeQueue.pending).toBe(1);
    const later = makeQueuedTurn({
      sourceMessageId: 'queued-after-new-failure',
      inboundSeq: 90,
    });
    expect(runtimeQueue.enqueue(later)).toBe(true);
    expect(runtimeQueue.closeAndTakePendingTurns()).toEqual([pending, later]);
  });

  it('does not await unrelated runtime finalizations during scoped /new terminalization', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    attachRuntimeFaultMarkerSpies(runtime);
    const context = makeRuntimeTurnContext(
      'singleton',
      'test',
      'test@s.whatsapp.net',
      87,
      'turn-new-singleton-scoped-87',
    );
    const state = runtime as unknown as {
      currentRuntimeTurnContext: typeof context | null;
      currentInboundSeq?: number;
      queue: IOutboundQueue | null;
      runtimeTurnCoordinator: {
        activeFinalizations: Map<string, Promise<unknown>>;
        terminalizeGlobalTurnForReset(): Promise<void>;
      };
    };
    await runtime.start();
    state.currentRuntimeTurnContext = context;
    state.currentInboundSeq = 87;
    state.queue = mockQueue;
    let releaseUnrelated!: () => void;
    const unrelated = new Promise<void>((resolve) => {
      releaseUnrelated = resolve;
    });
    state.runtimeTurnCoordinator.activeFinalizations.set('unrelated-turn', unrelated);

    const terminalization = state.runtimeTurnCoordinator.terminalizeGlobalTurnForReset();
    const outcome = await Promise.race([
      terminalization.then(() => 'settled' as const),
      new Promise<'blocked'>((resolve) => setImmediate(() => resolve('blocked'))),
    ]);
    releaseUnrelated();
    state.runtimeTurnCoordinator.activeFinalizations.delete('unrelated-turn');
    await terminalization;

    expect(outcome).toBe('settled');
  });

  it('publishes one joinable global teardown before durable finalization and lets shutdown join it', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    const context = makeRuntimeTurnContext(
      'singleton',
      'test',
      'test@s.whatsapp.net',
      871,
      'turn-new-singleton-join-871',
    );
    const state = runtime as unknown as {
      turnQueue: TurnQueue;
      runtimeTurnCoordinator: {
        hasGlobalTeardownPending(): boolean;
        terminalizeGlobalTurnForReset(): Promise<unknown>;
        retireGlobalTurnQueueAfterReset(teardown: unknown): Promise<void>;
        finalizeActiveRuntimeTurnsForShutdown(deadlineAt?: number): Promise<void>;
        finalizeUndispatchedRuntimeTurn: (...args: unknown[]) => Promise<unknown>;
      };
    };
    await runtime.start();
    const runtimeQueue = new TurnQueue();
    runtimeQueue.enqueue(makeQueuedTurn({ inboundSeq: 871, runtimeContext: context }));
    state.turnQueue = runtimeQueue;
    let releaseFinalization!: () => void;
    const finalizationBlocked = new Promise<void>((resolve) => {
      releaseFinalization = resolve;
    });
    state.runtimeTurnCoordinator.finalizeUndispatchedRuntimeTurn = vi.fn(async () => {
      await finalizationBlocked;
      return {
        kind: 'durable_failure_incident',
        mayAdvance: true,
      };
    });

    const first = state.runtimeTurnCoordinator.terminalizeGlobalTurnForReset();
    expect(state.runtimeTurnCoordinator.hasGlobalTeardownPending()).toBe(true);
    const second = state.runtimeTurnCoordinator.terminalizeGlobalTurnForReset();
    const shutdown = state.runtimeTurnCoordinator.finalizeActiveRuntimeTurnsForShutdown(
      Date.now() + 2_000,
    );
    await expect(Promise.race([
      shutdown.then(() => 'settled' as const),
      new Promise<'pending'>((resolve) => setImmediate(() => resolve('pending'))),
    ])).resolves.toBe('pending');

    releaseFinalization();
    const [firstTeardown, secondTeardown] = await Promise.all([first, second]);
    expect(secondTeardown).toBe(firstTeardown);
    await state.runtimeTurnCoordinator.retireGlobalTurnQueueAfterReset(firstTeardown);
    await expect(shutdown).resolves.toBeUndefined();
    expect(state.runtimeTurnCoordinator.hasGlobalTeardownPending()).toBe(false);
  });

  it('atomically rolls back and clears a failed global teardown so the exact queue can retry', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    const context = makeRuntimeTurnContext(
      'singleton',
      'test',
      'test@s.whatsapp.net',
      872,
      'turn-new-singleton-retry-872',
    );
    const state = runtime as unknown as {
      turnQueue: TurnQueue;
      runtimeTurnCoordinator: {
        hasGlobalTeardownPending(): boolean;
        terminalizeGlobalTurnForReset(): Promise<unknown>;
        retireGlobalTurnQueueAfterReset(teardown: unknown): Promise<void>;
        finalizeUndispatchedRuntimeTurn: (...args: unknown[]) => Promise<unknown>;
      };
    };
    await runtime.start();
    const runtimeQueue = new TurnQueue();
    const pending = makeQueuedTurn({ inboundSeq: 872, runtimeContext: context });
    runtimeQueue.enqueue(pending);
    state.turnQueue = runtimeQueue;
    state.runtimeTurnCoordinator.finalizeUndispatchedRuntimeTurn = vi.fn()
      .mockRejectedValueOnce(new Error('global durable finalization failed'))
      .mockResolvedValueOnce({
        kind: 'durable_failure_incident',
        mayAdvance: true,
      });

    await expect(
      state.runtimeTurnCoordinator.terminalizeGlobalTurnForReset(),
    ).rejects.toThrow('singleton/shared reset turn finalization failed');
    expect(state.runtimeTurnCoordinator.hasGlobalTeardownPending()).toBe(false);
    expect(runtimeQueue.pending).toBe(1);

    const retry = await state.runtimeTurnCoordinator.terminalizeGlobalTurnForReset();
    await state.runtimeTurnCoordinator.retireGlobalTurnQueueAfterReset(retry);
    expect(state.runtimeTurnCoordinator.hasGlobalTeardownPending()).toBe(false);
  });

  it('atomically rolls back and clears a failed per-chat teardown so the exact queue can retry', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const mapKey = 'test@s.whatsapp.net';
    const context = makeRuntimeTurnContext(
      'per_chat',
      mapKey,
      mapKey,
      873,
      'turn-new-per-chat-retry-873',
    );
    const state = runtime as unknown as {
      perChatTurnQueues: Map<string, TurnQueue>;
      runtimeTurnCoordinator: {
        hasPerChatTeardownPending(mapKey: string): boolean;
        terminalizePerChatTurnQueueForKill(mapKey: string): Promise<unknown>;
        retirePerChatTurnQueueAfterKill(teardown: unknown): Promise<void>;
        finalizeUndispatchedRuntimeTurn: (...args: unknown[]) => Promise<unknown>;
      };
    };
    await runtime.start();
    const runtimeQueue = new TurnQueue();
    const pending = makeQueuedTurn({
      conversationKey: mapKey,
      chatJid: mapKey,
      inboundSeq: 873,
      runtimeContext: context,
    });
    runtimeQueue.enqueue(pending);
    state.perChatTurnQueues.set(mapKey, runtimeQueue);
    state.runtimeTurnCoordinator.finalizeUndispatchedRuntimeTurn = vi.fn()
      .mockRejectedValueOnce(new Error('per-chat durable finalization failed'))
      .mockResolvedValueOnce({
        kind: 'durable_failure_incident',
        mayAdvance: true,
      });

    await expect(
      state.runtimeTurnCoordinator.terminalizePerChatTurnQueueForKill(mapKey),
    ).rejects.toThrow('kill-session runtime turn finalization failed');
    expect(state.runtimeTurnCoordinator.hasPerChatTeardownPending(mapKey)).toBe(false);
    expect(runtimeQueue.pending).toBe(1);

    const retry = await state.runtimeTurnCoordinator.terminalizePerChatTurnQueueForKill(mapKey);
    await state.runtimeTurnCoordinator.retirePerChatTurnQueueAfterKill(retry);
    expect(state.runtimeTurnCoordinator.hasPerChatTeardownPending(mapKey)).toBe(false);
  });

  it('interrupts an unsequenced synthetic per-chat turn owning the runtime queue on /new', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const state = runtime as unknown as {
      perChatInboundSeqQueue: Map<string, number[]>;
      perChatTurnQueues: Map<string, { isProcessing: boolean; idle: () => Promise<void> }>;
    };
    const mutableConfig = mockConfig as typeof mockConfig & {
      memory?: { adminJid: string };
    };
    const previousMemory = mutableConfig.memory;
    let markSendStarted!: () => void;
    let releaseSend!: () => void;
    const sendStarted = new Promise<void>((resolve) => {
      markSendStarted = resolve;
    });
    const sendBlocked = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });

    await runtime.start();
    // A local command initializes the per-chat session without admitting a turn.
    await sendAndDrain(runtime, makeMsg({ content: '/status' }));
    mutableConfig.memory = { adminJid: '15550100001@s.whatsapp.net' };
    mockSession.getStatus.mockReturnValue({
      active: true,
      pid: 123,
      sessionId: 'synthetic-session',
      startedAt: new Date().toISOString(),
      messageCount: 0,
      lastMessageAt: null,
    });
    mockSession.sendTurn.mockImplementationOnce(async () => {
      markSendStarted();
      await sendBlocked;
    });
    mockSession.shutdown.mockImplementationOnce(async () => {
      releaseSend();
    });

    try {
      expect(runtime.dispatchAgentJob({
        beadId: 7,
        triggerId: 11,
        prompt: 'Summarize the current state.',
        title: 'Synthetic status',
        reportChatJid: 'test@s.whatsapp.net',
      })).toMatchObject({ dispatched: true });
      await sendStarted;
      await (runtime as unknown as { turnChain: Promise<void> }).turnChain;

      // Synthetic jobs deliberately have no journal seq; queue ownership is
      // the only active-turn proof in this state.
      expect(state.perChatInboundSeqQueue.get('test@s.whatsapp.net')).toEqual([]);
      expect(state.perChatTurnQueues.get('test@s.whatsapp.net')?.isProcessing).toBe(true);
      mockQueue.abortTurn.mockClear();
      mockSession.shutdown.mockClear();

      await sendAndDrain(runtime, makeMsg({ content: '/new' }));

      // Queue ownership alone is active-turn proof — /new interrupts it now
      // (teardown + terminalization) instead of bouncing. The interrupt deletes
      // the chat's outbound queue, so the ack rides the messenger fallback.
      expect(mockSession.shutdown).toHaveBeenCalledWith(false);
      const ackTexts = [
        ...mockQueue.enqueueText.mock.calls.map((args) => args[0] as string),
        ...(messenger.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map((args) => args[1] as string),
      ];
      expect(ackTexts.some((t) => t.includes('Interrupted the running task'))).toBe(true);
      expect(ackTexts.some((t) => t.includes('still in progress'))).toBe(false);
    } finally {
      releaseSend();
      if (previousMemory === undefined) delete mutableConfig.memory;
      else mutableConfig.memory = previousMemory;
    }
    await state.perChatTurnQueues.get('test@s.whatsapp.net')?.idle();
  });

  it('interrupts /new-blocking shared-queue ownership after flag handoff instead of bouncing', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { shared: true });
    const state = runtime as unknown as {
      currentInboundSeq?: number;
      currentTurnChatJid: string | null;
      turnQueue: { isProcessing: boolean; idle: () => Promise<void> };
    };
    let markSendStarted!: () => void;
    let releaseSend!: () => void;
    const sendStarted = new Promise<void>((resolve) => {
      markSendStarted = resolve;
    });
    const sendBlocked = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });

    await runtime.start();
    mockSession.getStatus.mockReturnValue({
      active: true,
      pid: 123,
      sessionId: 'shared-session',
      startedAt: new Date().toISOString(),
      messageCount: 0,
      lastMessageAt: null,
    });
    mockSession.sendTurn.mockImplementationOnce(async () => {
      markSendStarted();
      await sendBlocked;
    });
    mockSession.shutdown.mockImplementationOnce(async () => {
      releaseSend();
    });

    await runtime.handleMessage(makeMsg({ senderJid: '15550100001@s.whatsapp.net' }));
    await (runtime as unknown as { turnChain: Promise<void> }).turnChain;
    await sendStarted;
    expect(state.turnQueue.isProcessing).toBe(true);

    // Terminal bookkeeping clears these legacy flags before the queue's
    // processor ownership necessarily drains. Model that handoff explicitly.
    state.currentInboundSeq = undefined;
    state.currentTurnChatJid = null;
    mockQueue.abortTurn.mockClear();
    mockSession.handleNew.mockClear();

    try {
      await sendAndDrain(runtime, makeMsg({
        content: '/new',
        senderJid: '15550100001@s.whatsapp.net',
      }));

      // Residual queue ownership is still an active turn — /new interrupts it.
      expect(mockSession.shutdown).toHaveBeenCalledWith(false);
      expect(mockSession.handleNew).not.toHaveBeenCalled();
      const enqueuedTexts = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
      expect(enqueuedTexts.some((t) => t.includes('Interrupted the running task'))).toBe(true);
      expect(enqueuedTexts.some((t) => t.includes('still in progress'))).toBe(false);
    } finally {
      releaseSend();
    }
    await state.turnQueue.idle();
  });

  it('durably terminalizes a published shared turn on /new while processor ownership remains stuck', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { shared: true });
    const { durability } = attachRuntimeFaultMarkerSpies(runtime);
    const state = runtime as unknown as {
      currentInboundSeq?: number;
      currentRuntimeTurnContext: ReturnType<typeof makeRuntimeTurnContext> | null;
      currentTurnChatJid: string | null;
      activeChatJid: string | null;
      outboundQueues: Map<string, IOutboundQueue>;
      turnQueue: TurnQueue;
      turnChain: Promise<void>;
    };
    let markSendStarted!: () => void;
    let releaseSend!: () => void;
    const sendStarted = new Promise<void>((resolve) => {
      markSendStarted = resolve;
    });
    const sendBlocked = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });

    await runtime.start();
    mockSession.getStatus.mockReturnValue({
      active: true,
      pid: 123,
      sessionId: 'shared-durable-session',
      startedAt: new Date().toISOString(),
      messageCount: 0,
      lastMessageAt: null,
    });
    mockSession.sendTurn.mockImplementationOnce(async () => {
      markSendStarted();
      await sendBlocked;
    });

    await runtime.handleMessage(makeMsg({
      content: 'long-running shared turn',
      inboundSeq: 91,
      senderJid: '15550100001@s.whatsapp.net',
    }));
    await state.turnChain;
    await sendStarted;
    expect(state.turnQueue.isProcessing).toBe(true);
    expect(state.currentRuntimeTurnContext?.identity.inboundSeq).toBe(91);
    const interruptedRuntimeQueue = state.turnQueue;
    const interruptedOutboundQueue = makeQueueMock('test@s.whatsapp.net');
    const unrelatedOutboundQueue = makeQueueMock('other@s.whatsapp.net');
    state.outboundQueues.set('test@s.whatsapp.net', interruptedOutboundQueue);
    state.outboundQueues.set('other@s.whatsapp.net', unrelatedOutboundQueue);

    // Reproduce the stuck-processing handoff: legacy flags no longer prove the
    // turn, but the published immutable context and queue processor still do.
    // A different chat may become the shared runtime's active fallback while
    // the exact turn is draining; reset must never abort that unrelated queue.
    state.currentInboundSeq = undefined;
    state.currentTurnChatJid = null;
    state.activeChatJid = 'other@s.whatsapp.net';
    mockSession.shutdown.mockImplementationOnce(async () => {
      releaseSend();
    });

    try {
      await sendAndDrain(runtime, makeMsg({
        content: '/new',
        inboundSeq: 92,
        senderJid: '15550100001@s.whatsapp.net',
      }));

      expect(durability.finalizeTurnTerminal).toHaveBeenCalledOnce();
      expect(state.currentRuntimeTurnContext).toBeNull();
      expect(interruptedOutboundQueue.abortTurn).toHaveBeenCalledWith({ preserveEvidence: true });
      const interruptedAbort = vi.mocked(interruptedOutboundQueue.abortTurn);
      const interruptedEvidence = vi.mocked(interruptedOutboundQueue.flushTurnEvidence);
      const evidenceCollectionOrder = interruptedEvidence.mock.invocationCallOrder[0];
      const destructiveAbortOrders = interruptedAbort.mock.calls.flatMap(
        ([options], index) => (
          (options as { preserveEvidence?: boolean } | undefined)?.preserveEvidence === true
            ? []
            : [interruptedAbort.mock.invocationCallOrder[index]]
        ),
      );
      expect(destructiveAbortOrders.every((order) => order > evidenceCollectionOrder)).toBe(true);
      expect(unrelatedOutboundQueue.abortTurn).not.toHaveBeenCalled();
      expect(state.turnQueue).not.toBe(interruptedRuntimeQueue);
      await interruptedRuntimeQueue.idle();
    } finally {
      releaseSend();
    }
    await state.turnQueue.idle();
  });

  it('durably terminalizes and retires a published shared turn on /kill-session', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { shared: true });
    const { durability } = attachRuntimeFaultMarkerSpies(runtime);
    const state = runtime as unknown as {
      currentRuntimeTurnContext: ReturnType<typeof makeRuntimeTurnContext> | null;
      currentTurnChatJid: string | null;
      activeChatJid: string | null;
      outboundQueues: Map<string, IOutboundQueue>;
      turnQueue: TurnQueue;
      turnChain: Promise<void>;
    };
    let markSendStarted!: () => void;
    let releaseSend!: () => void;
    const sendStarted = new Promise<void>((resolve) => {
      markSendStarted = resolve;
    });
    const sendBlocked = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    await runtime.start();
    mockSession.getStatus.mockReturnValue({
      active: true,
      pid: 123,
      sessionId: 'shared-kill-durable-session',
      startedAt: new Date().toISOString(),
      messageCount: 1,
      lastMessageAt: null,
    });
    mockSession.sendTurn.mockImplementationOnce(async () => {
      markSendStarted();
      await sendBlocked;
    });

    await runtime.handleMessage(makeMsg({
      content: 'shared turn killed by operator',
      inboundSeq: 98,
      senderJid: '15550100001@s.whatsapp.net',
    }));
    await state.turnChain;
    await sendStarted;
    const interruptedRuntimeQueue = state.turnQueue;
    const interruptedOutboundQueue = makeQueueMock('test@s.whatsapp.net');
    const unrelatedOutboundQueue = makeQueueMock('other@s.whatsapp.net');
    state.outboundQueues.set('test@s.whatsapp.net', interruptedOutboundQueue);
    state.outboundQueues.set('other@s.whatsapp.net', unrelatedOutboundQueue);
    state.currentTurnChatJid = null;
    state.activeChatJid = 'other@s.whatsapp.net';
    mockSession.shutdown.mockImplementationOnce(async () => {
      releaseSend();
    });

    try {
      await sendAndDrain(runtime, makeMsg({
        content: '/kill-session 1',
        inboundSeq: 99,
        senderJid: '15550100001@s.whatsapp.net',
      }));

      expect(durability.finalizeTurnTerminal).toHaveBeenCalledOnce();
      expect(vi.mocked(interruptedOutboundQueue.abortTurn).mock.calls.every(
        ([options]) => (options as { preserveEvidence?: boolean } | undefined)?.preserveEvidence === true,
      )).toBe(true);
      expect(unrelatedOutboundQueue.abortTurn).not.toHaveBeenCalled();
      expect(state.currentRuntimeTurnContext).toBeNull();
      expect(state.turnQueue).not.toBe(interruptedRuntimeQueue);
      await interruptedRuntimeQueue.idle();
    } finally {
      releaseSend();
    }
  });

  it('retires an exact empty halted global queue after durable kill proof', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    const state = runtime as unknown as {
      session: typeof mockSession | null;
      turnQueue: TurnQueue;
    };
    await runtime.start();
    mockSession.getStatus.mockReturnValue({
      active: true,
      pid: 123,
      sessionId: 'halted-global-retire',
      startedAt: new Date().toISOString(),
      messageCount: 1,
      lastMessageAt: null,
    });
    const haltedQueue = new TurnQueue();
    haltedQueue.setProcessor(async () => {
      throw new Error('halt global queue');
    });
    haltedQueue.enqueue(makeQueuedTurn({ inboundSeq: undefined }));
    await expect(haltedQueue.idle()).rejects.toThrow('halt global queue');
    expect(haltedQueue.pending).toBe(0);
    state.turnQueue = haltedQueue;
    state.session = mockSession;

    await sendAndDrain(runtime, makeMsg({
      content: '/kill-session 1',
      senderJid: '15550100001@s.whatsapp.net',
    }));

    expect(state.turnQueue).not.toBe(haltedQueue);
    expect(state.session).toBeNull();
    expect(mockSession.shutdown).toHaveBeenCalledWith(false);
  });

  it('retries the same exact global /new teardown after session shutdown fails', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    const state = runtime as unknown as {
      session: typeof mockSession | null;
      turnQueue: TurnQueue;
      runtimeTurnCoordinator: {
        hasGlobalTeardownPending(): boolean;
      };
    };
    await runtime.start();
    const interruptedQueue = new TurnQueue();
    interruptedQueue.enqueue(makeQueuedTurn({ inboundSeq: undefined }));
    state.turnQueue = interruptedQueue;
    state.session = mockSession;
    mockSession.shutdown
      .mockRejectedValueOnce(new Error('global shutdown failed'))
      .mockResolvedValueOnce(undefined);

    await sendAndDrain(runtime, makeMsg({
      content: '/new',
      senderJid: '15550100001@s.whatsapp.net',
    }));
    expect(state.session).toBe(mockSession);
    expect(state.turnQueue).toBe(interruptedQueue);
    expect(state.runtimeTurnCoordinator.hasGlobalTeardownPending()).toBe(true);

    await sendAndDrain(runtime, makeMsg({
      content: '/new',
      senderJid: '15550100001@s.whatsapp.net',
    }));

    expect(mockSession.shutdown).toHaveBeenCalledTimes(2);
    expect(state.session).toBeNull();
    expect(state.turnQueue).not.toBe(interruptedQueue);
    expect(state.runtimeTurnCoordinator.hasGlobalTeardownPending()).toBe(false);
  });

  it('refuses to retire a superseded global queue transaction', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    const state = runtime as unknown as {
      turnQueue: TurnQueue;
      runtimeTurnCoordinator: {
        terminalizeGlobalTurnForReset(): Promise<unknown>;
        retireGlobalTurnQueueAfterReset(teardown: unknown): Promise<void>;
      };
    };
    await runtime.start();
    const terminalizedQueue = new TurnQueue();
    terminalizedQueue.enqueue(makeQueuedTurn({ inboundSeq: undefined }));
    state.turnQueue = terminalizedQueue;
    const teardown = await state.runtimeTurnCoordinator.terminalizeGlobalTurnForReset();
    const replacement = new TurnQueue();
    state.turnQueue = replacement;

    await expect(
      state.runtimeTurnCoordinator.retireGlobalTurnQueueAfterReset(teardown),
    ).rejects.toThrow(/superseded.*TurnQueue/i);

    expect(state.turnQueue).toBe(replacement);
  });

  it('preserves singleton ownership when /kill-session durable terminalization is unproven', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    const { durability } = attachRuntimeFaultMarkerSpies(runtime);
    const context = makeRuntimeTurnContext(
      'singleton',
      'test',
      'test@s.whatsapp.net',
      100,
      'turn-kill-singleton-failure-100',
    );
    const state = runtime as unknown as {
      session: typeof mockSession | null;
      queue: IOutboundQueue | null;
      activeChatJid: string | null;
      currentInboundSeq?: number;
      currentRuntimeTurnContext: typeof context | null;
    };
    await runtime.start();
    mockSession.getStatus.mockReturnValue({
      active: true,
      pid: 123,
      sessionId: 'singleton-kill-failure',
      startedAt: new Date().toISOString(),
      messageCount: 1,
      lastMessageAt: null,
    });
    state.session = mockSession;
    state.queue = mockQueue;
    state.activeChatJid = 'test@s.whatsapp.net';
    state.currentInboundSeq = 100;
    state.currentRuntimeTurnContext = context;
    durability.finalizeTurnTerminal.mockImplementation(() => {
      throw new Error('singleton kill terminalization failed');
    });
    mockSession.shutdown.mockClear();

    await sendAndDrain(runtime, makeMsg({
      content: '/kill-session 1',
      inboundSeq: 101,
      senderJid: '15550100001@s.whatsapp.net',
    }));

    expect(mockSession.shutdown).not.toHaveBeenCalled();
    expect(state.session).toBe(mockSession);
    expect(state.queue).toBe(mockQueue);
    expect(state.currentRuntimeTurnContext).toBe(context);
    expect(state.currentInboundSeq).toBe(100);
  });

    it('/kill-session retires an exact empty halted per-chat runtime TurnQueue', async () => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const state = runtime as unknown as {
        chatSessions: Map<string, ReturnType<typeof makePerChatSession>>;
        chatQueues: Map<string, IOutboundQueue>;
        perChatTurnQueues: Map<string, TurnQueue>;
      };
      const groupKey = '111111100000000100@g.us';
      const targetSession = makePerChatSession(true, 11, new Date().toISOString());
      const haltedQueue = new TurnQueue();
      haltedQueue.setProcessor(async () => {
        throw new Error('halt per-chat queue');
      });
      haltedQueue.enqueue(makeQueuedTurn({
        conversationKey: groupKey,
        chatJid: groupKey,
        inboundSeq: undefined,
      }));
      await expect(haltedQueue.idle()).rejects.toThrow('halt per-chat queue');
      expect(haltedQueue.pending).toBe(0);
      await runtime.start();
      state.chatSessions.set(groupKey, targetSession);
      state.chatQueues.set(groupKey, makeQueueMock(groupKey));
      state.perChatTurnQueues.set(groupKey, haltedQueue);

      await sendAndDrain(runtime, makeMsg({ content: '/kill-session 1', senderJid: adminSender }));

      expect(targetSession.shutdown).toHaveBeenCalledWith(false);
      expect(state.perChatTurnQueues.has(groupKey)).toBe(false);
      expect(state.chatSessions.has(groupKey)).toBe(false);
    });

    it('/new retries the same exact per-chat teardown after session shutdown fails', async () => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const state = runtime as unknown as {
        chatSessions: Map<string, ReturnType<typeof makePerChatSession>>;
        chatQueues: Map<string, IOutboundQueue>;
        perChatTurnQueues: Map<string, TurnQueue>;
        runtimeTurnCoordinator: {
          hasPerChatTeardownPending(mapKey: string): boolean;
        };
      };
      const mapKey = 'test@s.whatsapp.net';
      const targetSession = makePerChatSession(true, 11, new Date().toISOString());
      const interruptedQueue = new TurnQueue();
      interruptedQueue.enqueue(makeQueuedTurn({ inboundSeq: undefined }));
      targetSession.shutdown
        .mockRejectedValueOnce(new Error('per-chat shutdown failed'))
        .mockResolvedValueOnce(undefined);
      await runtime.start();
      state.chatSessions.set(mapKey, targetSession);
      state.chatQueues.set(mapKey, makeQueueMock(mapKey));
      state.perChatTurnQueues.set(mapKey, interruptedQueue);

      await sendAndDrain(runtime, makeMsg({ content: '/new' }));
      expect(state.chatSessions.get(mapKey)).toBe(targetSession);
      expect(state.perChatTurnQueues.get(mapKey)).toBe(interruptedQueue);
      expect(state.runtimeTurnCoordinator.hasPerChatTeardownPending(mapKey)).toBe(true);

      await sendAndDrain(runtime, makeMsg({ content: '/new' }));

      expect(targetSession.shutdown).toHaveBeenCalledTimes(2);
      expect(state.chatSessions.has(mapKey)).toBe(false);
      expect(state.perChatTurnQueues.has(mapKey)).toBe(false);
      expect(state.runtimeTurnCoordinator.hasPerChatTeardownPending(mapKey)).toBe(false);
    });

    it('refuses to retire a superseded per-chat queue transaction', async () => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const mapKey = 'test@s.whatsapp.net';
      const state = runtime as unknown as {
        perChatTurnQueues: Map<string, TurnQueue>;
        runtimeTurnCoordinator: {
          terminalizePerChatTurnQueueForKill(mapKey: string): Promise<unknown>;
          retirePerChatTurnQueueAfterKill(teardown: unknown): Promise<void>;
        };
      };
      await runtime.start();
      const terminalizedQueue = new TurnQueue();
      terminalizedQueue.enqueue(makeQueuedTurn({ inboundSeq: undefined }));
      state.perChatTurnQueues.set(mapKey, terminalizedQueue);
      const teardown = await state.runtimeTurnCoordinator
        .terminalizePerChatTurnQueueForKill(mapKey);
      const replacement = new TurnQueue();
      state.perChatTurnQueues.set(mapKey, replacement);

      await expect(
        state.runtimeTurnCoordinator.retirePerChatTurnQueueAfterKill(teardown),
      ).rejects.toThrow(/superseded.*TurnQueue/i);

      expect(state.perChatTurnQueues.get(mapKey)).toBe(replacement);
    });

    it('/kill-session preserves the per-chat owner when durable turn terminalization is unproven', async () => {
      const db = makeDb();
      const { messenger, sentMessages } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const { durability } = attachRuntimeFaultMarkerSpies(runtime);
      const groupKey = '111111100000000100@g.us';
      const context = makeRuntimeTurnContext(
        'per_chat',
        groupKey,
        groupKey,
        93,
        'turn-kill-per-chat-failure-93',
      );
      const state = runtime as unknown as {
        chatSessions: Map<string, ReturnType<typeof makePerChatSession>>;
        chatQueues: Map<string, IOutboundQueue>;
        perChatInboundSeqQueue: Map<string, number[]>;
        perChatRuntimeTurnContexts: Map<string, Array<typeof context>>;
        perChatTurnQueues: Map<string, TurnQueue>;
      };
      await runtime.start();
      const targetSession = makePerChatSession(true, 11, new Date().toISOString());
      const runtimeQueue = new TurnQueue();
      const outboundQueue = makeQueueMock(groupKey);
      state.chatSessions.set(groupKey, targetSession);
      state.chatQueues.set(groupKey, outboundQueue);
      state.perChatInboundSeqQueue.set(groupKey, [93]);
      state.perChatRuntimeTurnContexts.set(groupKey, [context]);
      state.perChatTurnQueues.set(groupKey, runtimeQueue);
      durability.finalizeTurnTerminal.mockImplementation(() => {
        throw new Error('durable kill terminalization failed');
      });

      await sendAndDrain(runtime, makeMsg({ content: '/kill-session 1', senderJid: adminSender }));

      expect(targetSession.shutdown).not.toHaveBeenCalled();
      expect(state.chatSessions.get(groupKey)).toBe(targetSession);
      expect(state.perChatTurnQueues.get(groupKey)).toBe(runtimeQueue);
      expect(state.perChatRuntimeTurnContexts.get(groupKey)).toEqual([context]);
      expect(state.perChatInboundSeqQueue.get(groupKey)).toEqual([93]);
      expect(runtimeQueue.enqueue(makeQueuedTurn({
        sourceMessageId: 'post-kill-failure-turn',
        conversationKey: groupKey,
        chatJid: groupKey,
        inboundSeq: 94,
      }))).toBe(true);
      expect(runtimeQueue.pending).toBe(1);
      expect(vi.mocked(outboundQueue.abortTurn).mock.calls.every(
        ([options]) => (options as { preserveEvidence?: boolean } | undefined)?.preserveEvidence === true,
      )).toBe(true);
      const texts = [
        ...sentMessages.map((message) => message.text),
        ...mockQueue.enqueueText.mock.calls.map((args) => args[0] as string),
      ];
      expect(texts.some((text) => text.includes('Session not killed'))).toBe(true);
    });
});
