import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';
import type { IOutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';
import type { SessionGenerationIdentity } from '../../../src/runtimes/agent/session.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import { createRuntimeTurnContext, type RuntimeTurnContext } from '../../../src/runtimes/agent/runtime-turn-context.ts';
import type {
  PendingPollQuestion,
  PollVote,
} from '../../../src/runtimes/agent/runtime.ts';
import type { ResponseWorkflow } from '../../../src/runtimes/agent/response-registry.ts';

const {
  createdSessions,
  createdQueues,
  createdControlQueues,
  mockRuntimeLogger,
  mockEmitAlert,
  mockRunDiagnosticBundle,
  mockBuildDiagnosticProbes,
  mockConfig,
} = vi.hoisted(() => {
  type SessionOptions = {
    chatJid: string;
    cwd?: string;
    actorJid?: string;
    mcpSocketPath?: string;
    whatsoupMcpSocket?: string;
    mcpSessionContext?: { actorJid?: string };
    onEvent: (event: AgentEvent) => void;
    onCrash?: (info: {
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      sessionId: string | null;
      dbRowId: number | null;
      provider?: string;
      crashClass?: string;
      stderrPreview?: string;
    }) => void;
    notifyUser?: (message: string) => void;
    onResumeFailed?: () => void;
  };

  type MockSession = {
    spawnSession: ReturnType<typeof vi.fn>;
    sendTurn: ReturnType<typeof vi.fn>;
    getProviderId: ReturnType<typeof vi.fn>;
    handleNew: ReturnType<typeof vi.fn>;
    getStatus: ReturnType<typeof vi.fn>;
    shutdown: ReturnType<typeof vi.fn>;
    clearTurnWatchdog: ReturnType<typeof vi.fn>;
    tickWatchdog: ReturnType<typeof vi.fn>;
    trackToolStart: ReturnType<typeof vi.fn>;
    trackToolEnd: ReturnType<typeof vi.fn>;
    getDbRowId: ReturnType<typeof vi.fn>;
    setDurability: ReturnType<typeof vi.fn>;
    bindGenerationOwnership: ReturnType<typeof vi.fn>;
    resolveGenerationOwnership: () => SessionGenerationIdentity | null;
    recoverStalledOperation: ReturnType<typeof vi.fn>;
    probeLiveness: ReturnType<typeof vi.fn>;
  };

  const createdSessions: Array<{ opts: SessionOptions; session: MockSession }> = [];
  const createdQueues: unknown[] = [];
  const createdControlQueues: unknown[] = [];
  const mockRuntimeLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const mockEmitAlert = vi.fn(() => true);
  const mockRunDiagnosticBundle = vi.fn(async () => ({
    errorClass: 'provider_usage_limit',
    providerKind: 'usage-limit',
    findings: [
      { id: 'health-snapshot', ok: true, confidence: 'confirmed', summary: 'healthy enough for test' },
    ],
    resetAt: Date.now() + 60_000,
    collectedAt: Date.now(),
  }));
  const mockBuildDiagnosticProbes = vi.fn((_args?: unknown) => ({}));
  const mockConfig = {
    adminPhones: new Set<string>(),
    controlPeers: new Map<string, string>(),
    toolUpdateMode: 'full' as const,
    toolUpdateRedirectJid: null as string | null,
    textAggregateDelayMs: 2_000,
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
    agentMaxQueueDepth: 25,
    agentProvider: 'claude-cli',
    agentProviderConfig: undefined as Record<string, unknown> | undefined,
    agentFallbackProvider: undefined as string | undefined,
    agentFallbackModel: undefined as string | undefined,
    agentFallbacks: undefined as Array<{ provider: string; model?: string }> | undefined,
    operationTracker: { enabled: false } as { enabled: boolean; [key: string]: unknown },
  };

  return {
    createdSessions,
    createdQueues,
    createdControlQueues,
    mockRuntimeLogger,
    mockEmitAlert,
    mockRunDiagnosticBundle,
    mockBuildDiagnosticProbes,
    mockConfig,
  };
});

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => mockRuntimeLogger,
}));

vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlert: mockEmitAlert,
  emitAlertChecked: mockEmitAlert,
  clearAlertSource: vi.fn(() => true),
  clearAlertSourceChecked: vi.fn(() => true),
}));

vi.mock('../../../src/config.ts', () => ({
  config: mockConfig,
}));

vi.mock('../../../src/mcp/register-all.ts', () => ({
  registerAllTools: vi.fn(),
}));

vi.mock('../../../src/mcp/registry.ts', () => ({
  ToolRegistry: class {
    register = vi.fn();
    listTools = vi.fn(() => []);
    call = vi.fn();
    getChatScopedToolNames = vi.fn(() => []);
    setDurability = vi.fn();
  },
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
  insertTokenEvent: vi.fn(),
  accumulateTokensWithEvent: vi.fn(),
  getSessionTokenSnapshot: vi.fn(() => null),
  markSessionCompacted: vi.fn(),
}));

vi.mock('../../../src/runtimes/agent/fallback-state-db.ts', () => ({
  ensureFallbackStateSchema: vi.fn(),
  saveFallbackState: vi.fn(),
  loadFallbackState: vi.fn(() => null),
  clearFallbackState: vi.fn(),
}));

vi.mock('../../../src/runtimes/agent/session-classifier.ts', () => ({
  classifyActiveSessions: vi.fn(() => []),
}));

vi.mock('../../../src/lib/keyring.ts', () => ({
  lookupCredential: vi.fn(() => 'present-key'),
  resolveProviderKeyService: vi.fn((provider: unknown, model: unknown) => {
    if (provider === 'opencode-cli' && typeof model === 'string') return 'opencode-test-key';
    if (provider === 'openai-api') return 'openai';
    if (provider === 'anthropic-api') return 'anthropic';
    return null;
  }),
}));

vi.mock('../../../src/runtimes/agent/providers/credential-verify.ts', () => ({
  verifyFallbackCredential: vi.fn(async () => 'unknown'),
}));

vi.mock('../../../src/runtimes/agent/providers/binary-preflight.ts', () => ({
  probeFallbackBinary: vi.fn(async () => ({ status: 'unknown', version: null })),
  probeModelCatalog: vi.fn(async () => ({ status: 'unknown', suggestion: null })),
  probeBinaryAuthStatus: vi.fn(async () => ({ ok: false, summary: 'not checked' })),
}));

vi.mock('../../../src/runtimes/agent/providers/primary-model-usability.ts', () => ({
  probePrimaryModelUsability: vi.fn(async () => ({
    status: 'usable',
    provider: 'claude-cli',
    model: null,
  })),
  primaryModelUsabilityRequiresAlert: vi.fn(() => false),
}));

vi.mock('../../../src/runtimes/agent/providers/primary-model-usability-adapters.ts', () => ({
  createPrimaryModelProbeAdapters: vi.fn(() => ({})),
}));

vi.mock('../../../src/runtimes/agent/diagnostic-bundle.ts', () => ({
  runDiagnosticBundle: mockRunDiagnosticBundle,
}));

vi.mock('../../../src/runtimes/agent/diagnostic-probes.ts', () => ({
  buildDiagnosticProbes: mockBuildDiagnosticProbes,
}));

vi.mock('../../../src/runtimes/agent/session.ts', () => ({
  // eslint-disable-next-line prefer-arrow-callback -- constructor mock requires function keyword; expires 2026-12-31
  SessionManager: vi.fn().mockImplementation(function (opts: unknown) {
    const session = makeSession();
    createdSessions.push({ opts: opts as never, session });
    return session;
  }),
  formatAge: vi.fn(() => 'now'),
  getProviderBinary: vi.fn(() => null),
}));

vi.mock('../../../src/runtimes/agent/outbound-queue.ts', () => ({
  // eslint-disable-next-line prefer-arrow-callback -- constructor mock requires function keyword; expires 2026-12-31
  OutboundQueue: vi.fn().mockImplementation(function (_messenger: Messenger, chatJid: string) {
    const queue = makeQueue(chatJid);
    createdQueues.push(queue);
    return queue;
  }),
}));

vi.mock('../../../src/runtimes/agent/control-queue.ts', () => ({
  ControlQueue: vi.fn().mockImplementation(function (_chatJid: string, _messenger: Messenger) {
    const queue = {
      targetChatJid: ['control', 'heal.internal'].join('@'),
      sendControlMessage: vi.fn(async () => ({ waMessageId: null })),
      enqueueText: vi.fn(),
      enqueueStreamingText: vi.fn(),
      enqueueResultText: vi.fn(),
      enqueueToolUpdate: vi.fn(),
      enqueueProgressUpdate: vi.fn(),
      setToolUpdateMode: vi.fn(),
      setToolUpdateRedirectJid: vi.fn(),
      setTextAggregateDelayMs: vi.fn(),
      indicateTyping: vi.fn(),
      enqueuePoll: vi.fn(async (fn: () => Promise<void>) => { await fn(); }),
      hasPendingPoll: vi.fn(() => false),
      setPollPending: vi.fn(),
      flush: vi.fn(async () => {}),
      shutdown: vi.fn(async () => {}),
      abortTurn: vi.fn(),
      updateDeliveryJid: vi.fn(),
      setInboundSeq: vi.fn(),
      getLastOpId: vi.fn(() => undefined),
      clearLastOpId: vi.fn(),
      markLastTerminal: vi.fn(),
      setDurability: vi.fn(),
      endTurn: vi.fn(),
    };
    createdControlQueues.push(queue);
    return queue;
  }),
}));

vi.mock('../../../src/core/messages.ts', () => ({
  getRecentMessages: vi.fn(() => []),
  getMessagesSince: vi.fn(() => []),
  updateMediaPath: vi.fn(),
  updateTranscription: vi.fn(),
}));

vi.mock('../../../src/runtimes/chat/providers/elevenlabs.ts', () => ({
  synthesizeSpeech: vi.fn(),
}));

vi.mock('../../../src/core/media-download.ts', () => ({
  writeTempFile: vi.fn(() => '/tmp/voice-reply.mp3'),
  downloadMedia: vi.fn(),
}));

import { RESPONSE_WORKFLOWS } from '../../../src/runtimes/agent/response-registry.ts';
import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import { getRecentMessages, type StoredMessage } from '../../../src/core/messages.ts';
import { getSessionTokenSnapshot } from '../../../src/runtimes/agent/session-db.ts';

type QueueMock = IOutboundQueue & {
  enqueueText: ReturnType<typeof vi.fn>;
  setPollPending: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
  abortTurn: ReturnType<typeof vi.fn>;
};

type RuntimeView = {
  pendingPolls: { questions: Map<string, PendingPollQuestion> };
  pollPersistence: {
    save: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    loadRows: ReturnType<typeof vi.fn>;
  };
  groupMetadataCache: Map<string, { adminJids: Set<string>; fetchedAt: number }>;
  outboundQueues: Map<string, IOutboundQueue>;
  chatQueues: Map<string, IOutboundQueue>;
  chatSessions: Map<string, unknown>;
  operationTrackers: Map<string, {
    shutdown: () => void;
    onToolStart?: (toolId: string, toolName: string, category: 'running') => void;
    onToolEnd?: (toolId: string) => void;
  }>;
  operationTracker: { shutdown: () => void } | null;
  queue: IOutboundQueue | null;
  session: unknown;
  currentTurnChatJid: string | null;
  activeChatJid: string | null;
  currentInboundSeq?: number;
  singleTurnHadToolActivity: boolean;
  workspaceResources: Map<string, {
    workspacePath: string;
    socketPath?: string;
    lastActivity: number;
    socketServer?: { updateDeliveryJid: ReturnType<typeof vi.fn> };
  }>;
  perChatInboundSeqQueue: Map<string, number[]>;
  perChatRuntimeTurnContexts: Map<string, RuntimeTurnContext[]>;
  perChatTurnQueues: Map<string, { pending: number; isProcessing: boolean; haltedError: unknown; idle(): Promise<void> }>;
  currentRuntimeTurnContext: RuntimeTurnContext | null;
  pendingTurnText: Map<string, string>;
  pendingTurnActorJid: Map<string, string | undefined>;
  perChatTurnContentType: Map<string, string>;
  perChatTurnText: Map<string, string>;
  perChatAssistantItemText: Map<string, Map<string, string>>;
  resumeFailedHandling: Set<string>;
  pendingSystemResults: {
    counts: Map<string | undefined, number>;
    mark: (scopeKey?: string) => void;
    unmark: (scopeKey?: string) => void;
  };
  imageCoalesce: {
    buffers: Map<string, {
      timer: ReturnType<typeof setTimeout>;
      msg: { chatJid: string };
    }>;
  };
  autoCompact: {
    lastSuccessAt: Map<string, number>;
    cooldownUntil: Map<string, number>;
    consecutiveRapidRearms: Map<string, number>;
    ineffective: number;
  };
  currentTurnReplayText: string | null;
  currentTurnReplayActorJid: string | undefined;
  handleEventPerChat: ReturnType<typeof vi.fn>;
  handleEvent(event: AgentEvent): void;
  handlePerChatCrash: ReturnType<typeof vi.fn>;
  handleCrashNotify: ReturnType<typeof vi.fn>;
  handleResumeFailed(chatJid: string): void;
  activateProviderFallback(resetAt: Date | null, reason?: string): {
    reason: 'usage-limit' | 'auth-required' | 'rate-limit' | 'server-error' | 'model-unavailable' | 'empty-output' | 'probe-unusable';
    fallbackProvider: string;
    fallbackModel?: string;
    activeUntil: number;
    resetAt: number | null;
    extended: boolean;
    keyPresent: boolean | null;
  } | null;
  notifyProviderFallbackActivated(
    queue: IOutboundQueue,
    activation: {
      reason: 'usage-limit' | 'auth-required' | 'rate-limit' | 'server-error' | 'model-unavailable' | 'empty-output' | 'probe-unusable';
      fallbackProvider: string;
      fallbackModel?: string;
      activeUntil: number;
      resetAt: number | null;
      extended: boolean;
      keyPresent: boolean | null;
    },
    replay?: { replayScheduled: boolean; blockedByToolActivity?: boolean },
  ): void;
  scheduleFallbackReplay(args: {
    activation: {
      reason: 'usage-limit' | 'auth-required' | 'rate-limit' | 'server-error' | 'model-unavailable' | 'empty-output' | 'probe-unusable';
      fallbackProvider: string;
      fallbackModel?: string;
      activeUntil: number;
      resetAt: number | null;
      extended: boolean;
      keyPresent: boolean | null;
    };
    chatJid: string;
    mapKey?: string;
    oldSession: { shutdown: ReturnType<typeof vi.fn> } | null;
    hadToolActivity?: boolean;
  }): boolean;
  fetchGroupAdminJids(chatJid: string): Promise<Set<string> | null>;
  registerSendPollAwaiter(
    pollId: string,
    chatJid: string,
    options: string[],
    resolution: 'first-vote-wins' | 'admin-only' | 'admin-wins' | 'majority-after-timeout',
    timeoutMs: number,
    abortSignal?: AbortSignal,
  ): Promise<string>;
  coalesceImageTurn(mapKey: string, chatJid: string, text: string, msg: unknown): Promise<void>;
  flushImageCoalesce: (mapKey: string) => Promise<void>;
  normalizeAssistantTextForDelivery(
    event: Extract<AgentEvent, { type: 'assistant_text' }>,
    mapKey?: string,
  ): string | null;
  sendDirect(chatJid: string, text: string, bypassEchoGuard?: boolean): void;
  maybeStartAutoCompact(session: { getStatus: ReturnType<typeof vi.fn>; getDbRowId: ReturnType<typeof vi.fn>; sendTurn: ReturnType<typeof vi.fn> }, mapKey?: string): void;
  startQueueSweepTimer(): void;
  ensureSessionAndQueueSync(chatJid: string, initialMapKey?: string, actorJid?: string): void;
  handleProviderFailureResult(wf: ResponseWorkflow, ctx: {
    queue: IOutboundQueue;
    session: { shutdown: ReturnType<typeof vi.fn> } | null;
    providerText: string;
    turnHadToolWork: boolean;
    logChatJid?: string | null;
    scheduleReplayMapKey?: string;
    cleanupArgs: { inboundSeq?: number; conversationKey?: string; mapKey?: string; clearCurrentInboundSeq?: boolean };
    recordTurnFailure: (errorClass: string) => void;
  }): void;
  handleEventWithContext(
    event: AgentEvent,
    queue: IOutboundQueue,
    session: {
      clearTurnWatchdog: ReturnType<typeof vi.fn>;
      getDbRowId: ReturnType<typeof vi.fn>;
      shutdown: ReturnType<typeof vi.fn>;
      tickWatchdog: ReturnType<typeof vi.fn>;
    } | null,
    conversationKey?: string,
    inboundSeq?: number,
    mapKey?: string,
    toolScopeKey?: string,
    isSystemResult?: boolean,
  ): void;
  kickDiagnosticBundle(wf: ResponseWorkflow, providerText: string): void;
  recreatePerChatSessionForFallback(mapKey: string, chatJid: string, actorJid?: string): void;
  recreateSingletonSessionForFallback(chatJid: string, actorJid?: string): void;
  handleControlTurn(reportId: string, payload: string): Promise<void>;
  getFallbackState(): { fallbackReason: string | null; fallbackActiveUntil: number | null };
  setOwnedPerChatSession(mapKey: string, session: unknown): void;
  deleteOwnedPerChatSession(mapKey: string, expected?: unknown): boolean;
};

function makeSession() {
  let resolveGenerationOwnership: (() => SessionGenerationIdentity | null) | null = null;
  return {
    spawnSession: vi.fn(async () => {}),
    sendTurn: vi.fn(async () => {}),
    // QR-105: maybeStartAutoCompact is provider-gated to claude-cli sessions.
    getProviderId: vi.fn(() => 'claude-cli'),
    handleNew: vi.fn(async () => {}),
    getStatus: vi.fn(() => ({
      active: false,
      pid: null,
      sessionId: null,
      startedAt: null,
      messageCount: 0,
      lastMessageAt: null,
    })),
    shutdown: vi.fn(async () => {}),
    clearTurnWatchdog: vi.fn(),
    tickWatchdog: vi.fn(),
    trackToolStart: vi.fn(),
    trackToolEnd: vi.fn(),
    getDbRowId: vi.fn(() => null),
    setDurability: vi.fn(),
    bindGenerationOwnership: vi.fn((resolve: () => SessionGenerationIdentity | null) => {
      resolveGenerationOwnership = resolve;
    }),
    resolveGenerationOwnership: () => resolveGenerationOwnership?.() ?? null,
    recoverStalledOperation: vi.fn(),
    probeLiveness: vi.fn(),
  };
}

function makeQueue(chatJid = 'chat-edge@s.whatsapp.net'): QueueMock {
  return {
    targetChatJid: chatJid,
    enqueueText: vi.fn(),
    enqueueStreamingText: vi.fn(),
    enqueueResultText: vi.fn(),
    enqueueToolUpdate: vi.fn(),
    enqueueProgressUpdate: vi.fn(),
    setToolUpdateMode: vi.fn(),
    setToolUpdateRedirectJid: vi.fn(),
    setTextAggregateDelayMs: vi.fn(),
    indicateTyping: vi.fn(),
    enqueuePoll: vi.fn(async (fn: () => Promise<void>) => { await fn(); }),
    hasPendingPoll: vi.fn(() => false),
    setPollPending: vi.fn(),
    flush: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    abortTurn: vi.fn(),
    updateDeliveryJid: vi.fn(),
    setInboundSeq: vi.fn(),
    getLastOpId: vi.fn(() => undefined),
    clearLastOpId: vi.fn(),
    markLastTerminal: vi.fn(),
    setDurability: vi.fn(),
    endTurn: vi.fn(),
    beginTurnEvidence: vi.fn(),
    flushTurnEvidence: vi.fn(async (turnId: string) => ({
      turnId,
      answerOpIds: [],
      lifecycleOpIds: [],
      statusOpIds: [],
    })),
  } as unknown as QueueMock;
}

function makeDb(): Database {
  return {
    assertWritableCompatibility: vi.fn(),
    raw: {
      prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) })),
      exec: vi.fn(),
    },
  } as unknown as Database;
}

function makeStoredMessage(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    pk: 1,
    chatJid: '15551237777@s.whatsapp.net',
    conversationKey: '15551237777',
    senderJid: 'sender-edge@s.whatsapp.net',
    senderName: 'Sender Edge',
    messageId: 'message-edge',
    content: 'previous chat context',
    contentType: 'text',
    isFromMe: false,
    timestamp: 1_781_095_200,
    quotedMessageId: null,
    enrichmentProcessedAt: null,
    enrichmentRetries: 0,
    createdAt: '2026-06-10T09:20:00.000Z',
    mediaPath: null,
    contentText: 'previous chat context',
    ...overrides,
  };
}

function makeMessenger(groupMetadata?: ReturnType<typeof vi.fn>): Messenger & {
  sendMessage: ReturnType<typeof vi.fn>;
  sendMedia: ReturnType<typeof vi.fn>;
  clearPollTracking: ReturnType<typeof vi.fn>;
  getSocket: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
} {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
    clearPollTracking: vi.fn(),
    getSocket: vi.fn(() => groupMetadata ? { groupMetadata } : null),
    on: vi.fn(),
  } as unknown as Messenger & {
    sendMessage: ReturnType<typeof vi.fn>;
    sendMedia: ReturnType<typeof vi.fn>;
    clearPollTracking: ReturnType<typeof vi.fn>;
    getSocket: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  };
}

function view(runtime: AgentRuntime): RuntimeView {
  return runtime as unknown as RuntimeView;
}

function makeRuntime(
  options: ConstructorParameters<typeof AgentRuntime>[3] = {},
  messenger: ReturnType<typeof makeMessenger> = makeMessenger(),
): AgentRuntime {
  mockConfig.agentProvider = 'claude-cli';
  mockConfig.agentFallbackProvider = 'opencode-cli';
  mockConfig.agentFallbackModel = 'backup-model';
  mockConfig.agentFallbacks = undefined;
  mockConfig.operationTracker = { enabled: false };
  return new AgentRuntime(makeDb(), messenger, 'test', options);
}

function installPollPersistenceStub(runtime: AgentRuntime) {
  const persistence = {
    save: vi.fn(),
    remove: vi.fn(),
    loadRows: vi.fn(() => []),
  };
  view(runtime).pollPersistence = persistence;
  return persistence;
}

function installDurabilityStub(runtime: AgentRuntime) {
  const durability = {
    completeTurn: vi.fn(),
    upsertSessionCheckpoint: vi.fn(),
    completeInbound: vi.fn(),
    markInboundSkipped: vi.fn(),
    markInboundFailed: vi.fn(),
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
  (runtime as unknown as { durability: typeof durability }).durability = durability;
  return durability;
}

function runtimeContext(
  scope: 'per_chat' | 'shared',
  conversationKey: string,
  deliveryJid: string,
  inboundSeq: number,
  logicalTurnId: string,
): RuntimeTurnContext {
  return createRuntimeTurnContext({
    identity: { scope, conversationKey, deliveryJid, inboundSeq, logicalTurnId, managerId: `manager-${scope}`, generation: 1 },
    recoveryOwner: { logicalTurnId: `${logicalTurnId}:recovery`, managerId: 'manager-recovery', generation: 2 },
    replay: {
      sourceMessageId: `wamid-${logicalTurnId}`,
      replaySafe: true,
      senderJid: 'sender-edge@s.whatsapp.net',
      senderName: null,
      text: 'original edge turn',
      isGroup: false,
    },
    contentType: 'text',
    toolScopeKey: scope === 'per_chat' ? conversationKey : '__global__',
  });
}

async function drainMicrotasks(iterations = 8): Promise<void> {
  for (let i = 0; i < iterations; i += 1) {
    await Promise.resolve();
  }
}

describe('AgentRuntime edge coverage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T10:00:00Z'));
    createdSessions.length = 0;
    createdQueues.length = 0;
    createdControlQueues.length = 0;
    mockEmitAlert.mockClear();
    mockRuntimeLogger.info.mockClear();
    mockRuntimeLogger.warn.mockClear();
    mockRuntimeLogger.error.mockClear();
    mockRuntimeLogger.debug.mockClear();
    mockRunDiagnosticBundle.mockClear();
    mockBuildDiagnosticProbes.mockClear();
    vi.mocked(getRecentMessages).mockReset();
    vi.mocked(getRecentMessages).mockReturnValue([]);
    mockConfig.adminPhones = new Set<string>();
    mockConfig.controlPeers = new Map<string, string>();
    delete process.env['WHATSOUP_DIAGNOSTIC_BUNDLE'];
  });

  afterEach(() => {
    delete process.env['WHATSOUP_DIAGNOSTIC_BUNDLE'];
    delete process.env['WHATSOUP_RESPONSE_REGISTRY_DISPATCH'];
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('caches group admin metadata and reuses it without refetching', async () => {
    const groupMetadata = vi.fn(async () => ({
      participants: [
        { id: 'admin-edge@s.whatsapp.net', admin: 'admin' },
        { id: 'owner-edge@s.whatsapp.net', admin: 'superadmin' },
        { id: 'member-edge@s.whatsapp.net', admin: undefined },
      ],
    }));
    const runtime = makeRuntime({}, makeMessenger(groupMetadata));

    const first = await view(runtime).fetchGroupAdminJids('group-edge@g.us');
    const second = await view(runtime).fetchGroupAdminJids('group-edge@g.us');

    expect(first).not.toBeNull();
    expect(first!.has('admin-edge@s.whatsapp.net')).toBe(true);
    expect(first!.has('owner-edge@s.whatsapp.net')).toBe(true);
    expect(first!.has('member-edge@s.whatsapp.net')).toBe(false);
    expect(second).toBe(first);
    expect(groupMetadata).toHaveBeenCalledTimes(1);
  });

  it('registers a DM send_poll awaiter, degrades admin-only, and rejects on abort', async () => {
    const messenger = makeMessenger();
    const runtime = makeRuntime({}, messenger);
    const persistence = installPollPersistenceStub(runtime);
    const abort = new AbortController();

    const promise = view(runtime).registerSendPollAwaiter(
      'poll-dm-edge',
      'direct-edge@s.whatsapp.net',
      ['Approve', 'Deny'],
      'admin-only',
      60_000,
      abort.signal,
    );
    const mapKey = 'send_poll:poll-dm-edge';
    const pending = view(runtime).pendingPolls.questions.get(mapKey);

    expect(pending?.resolution).toBe('first-vote-wins');
    expect(persistence.save).toHaveBeenCalledWith(mapKey, pending);

    abort.abort();

    await expect(promise).rejects.toThrow('Poll abort: MCP client disconnected');
    expect(messenger.clearPollTracking).toHaveBeenCalledWith('poll-dm-edge');
    expect(view(runtime).pendingPolls.questions.has(mapKey)).toBe(false);
    expect(persistence.remove).toHaveBeenCalledWith(mapKey);
  });

  it('keeps the admin gate fail-closed for a group send_poll awaiter when admin metadata cannot be fetched (QR-036)', async () => {
    const groupMetadata = vi.fn(async () => {
      throw new Error('metadata unavailable');
    });
    const runtime = makeRuntime({}, makeMessenger(groupMetadata));
    installPollPersistenceStub(runtime);
    const abort = new AbortController();

    const promise = view(runtime).registerSendPollAwaiter(
      'poll-group-edge',
      'group-edge@g.us',
      ['Ship', 'Hold'],
      'admin-wins',
      60_000,
      abort.signal,
    );
    await Promise.resolve();
    await Promise.resolve();
    const pending = view(runtime).pendingPolls.questions.get('send_poll:poll-group-edge');

    expect(pending?.adminJids).toBeNull();
    // QR-036: admin metadata loss keeps the admin strategy (fail-closed); it no
    // longer degrades to first-vote-wins.
    expect(pending?.resolution).toBe('admin-wins');
    expect(groupMetadata).toHaveBeenCalledWith('group-edge@g.us');

    abort.abort();
    await expect(promise).rejects.toThrow('Poll abort: MCP client disconnected');
  });

  it('arms fallback from registry provider failures, runs diagnostics, and blocks replay after tool activity', async () => {
    process.env['WHATSOUP_DIAGNOSTIC_BUNDLE'] = '1';
    const runtime = makeRuntime({ sessionScope: 'per_chat' });
    const queue = makeQueue();
    const session = makeSession();
    const recordTurnFailure = vi.fn();

    view(runtime).handleProviderFailureResult(RESPONSE_WORKFLOWS.provider_usage_limit, {
      queue,
      session,
      providerText: 'Usage limit reached. Your limit will reset at 11:00 AM.',
      turnHadToolWork: true,
      logChatJid: queue.targetChatJid,
      scheduleReplayMapKey: queue.targetChatJid,
      cleanupArgs: { mapKey: queue.targetChatJid },
      recordTurnFailure,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(recordTurnFailure).toHaveBeenCalledWith('usage-limit');
    expect(view(runtime).getFallbackState().fallbackReason).toBe('usage-limit');
    expect(queue.enqueueText).toHaveBeenCalledWith(expect.stringContaining('will not replay it automatically'));
    expect(session.shutdown).toHaveBeenCalledTimes(1);
    expect(mockBuildDiagnosticProbes).toHaveBeenCalledWith(expect.objectContaining({
      providerText: expect.stringContaining('Usage limit reached'),
    }));
    expect(mockRunDiagnosticBundle).toHaveBeenCalledWith(expect.objectContaining({
      workflow: RESPONSE_WORKFLOWS.provider_usage_limit,
    }));
    expect(mockEmitAlert).toHaveBeenCalledWith(
      'test',
      'provider_failure_diagnostics',
      'Diagnostics for usage-limit on claude-cli',
      expect.stringContaining('health-snapshot:ok/confirmed'),
    );
  });

  it('per-chat terminal provider results suppress non-arming failures through the terminal coordinator', async () => {
    process.env['WHATSOUP_RESPONSE_REGISTRY_DISPATCH'] = '1';
    const cases: Array<{
      reason: 'policy-block' | 'context-overflow';
      text: string;
      expectNotice: boolean;
      logger: 'warn' | 'error';
      message: string;
    }> = [
      {
        reason: 'policy-block',
        text: 'This request violates our policy and is blocked by policy.',
        expectNotice: false,
        logger: 'error',
        message: 'suppressed provider policy-block message from result — session will be killed',
      },
      {
        reason: 'context-overflow',
        text: 'Error: prompt is too long for the context window.',
        expectNotice: true,
        logger: 'warn',
        message: 'prompt too long — killing session',
      },
    ];

    for (const item of cases) {
      const runtime = makeRuntime({ sessionScope: 'per_chat' });
      const state = view(runtime);
      const queue = makeQueue(`${item.reason}@s.whatsapp.net`);
      const session = makeSession();
      const durability = installDurabilityStub(runtime);
      const mapKey = `${item.reason}-map`;
      const conversationKey = `${item.reason}-conversation`;
      const context = runtimeContext('per_chat', conversationKey, queue.targetChatJid, 41, `turn-${item.reason}`);

      mockRuntimeLogger.warn.mockClear();
      mockRuntimeLogger.error.mockClear();
      state.perChatTurnContentType.set(mapKey, 'text');
      state.perChatTurnText.set(mapKey, 'provider text');
      state.perChatAssistantItemText.set(mapKey, new Map([['item-edge', 'partial']]));
      state.perChatRuntimeTurnContexts.set(mapKey, [context]);
      state.perChatInboundSeqQueue.set(mapKey, [41]);

      state.handleEventWithContext(
        { type: 'result', text: item.text, isError: true },
        queue,
        session,
        conversationKey,
        41,
        mapKey,
        mapKey,
      );

      expect(session.clearTurnWatchdog).toHaveBeenCalledTimes(1);
      expect(queue.endTurn).toHaveBeenCalledTimes(1);
      expect(session.shutdown).toHaveBeenCalledTimes(1);
      expect(queue.enqueueResultText).not.toHaveBeenCalledWith(item.text);
      if (item.expectNotice) {
        expect(queue.enqueueText).toHaveBeenCalledWith(expect.stringContaining('Context limit'));
      } else {
        expect(queue.enqueueText).not.toHaveBeenCalled();
      }
      expect(mockRuntimeLogger[item.logger]).toHaveBeenCalledWith(
        expect.objectContaining({
          chatJid: queue.targetChatJid,
          textPreview: item.text,
        }),
        item.message,
      );
      await vi.waitFor(() => expect(durability.finalizeTurnTerminal).toHaveBeenCalledOnce());
      expect(durability.finalizeTurnTerminal).toHaveBeenCalledWith(expect.objectContaining({
        terminal: expect.objectContaining({
          logicalTurnId: `turn-${item.reason}`,
          inboundSeq: 41,
          attemptKind: item.reason === 'policy-block' ? 'suppressed_by_policy' : 'failed',
          ...(item.reason === 'context-overflow' ? { attemptFailureClass: item.reason } : {}),
        }),
        bookkeeping: expect.objectContaining({
          checkpoint: {
            conversationKey,
            fields: expect.objectContaining({ activeTurnId: null, lastInboundSeq: 41 }),
          },
        }),
      }));
      expect(durability.completeInbound).not.toHaveBeenCalled();
      expect(durability.upsertSessionCheckpoint).not.toHaveBeenCalled();
      expect(queue.flushTurnEvidence).toHaveBeenCalledWith(`turn-${item.reason}`);
      expect(queue.flush).not.toHaveBeenCalled();
      expect(state.perChatTurnContentType.has(mapKey)).toBe(false);
      expect(state.perChatTurnText.has(mapKey)).toBe(false);
      expect(state.perChatAssistantItemText.has(mapKey)).toBe(false);
      const turnCapability = (runtime.getHealthSnapshot().details as Record<string, unknown>).turnCapability as { lastTurnErrorClass?: string };
      expect(turnCapability.lastTurnErrorClass).toBe(item.reason);
    }
  });

  it('per-chat terminal provider results arm fallback variants through the terminal coordinator', async () => {
    process.env['WHATSOUP_RESPONSE_REGISTRY_DISPATCH'] = '1';
    const cases: Array<{
      reason: 'auth-required' | 'rate-limit' | 'server-error' | 'model-unavailable';
      text: string;
      message: string;
    }> = [
      {
        reason: 'auth-required',
        text: 'Authentication required. Sign in to continue.',
        message: 'suppressed provider auth-required message from result — session will be shut down',
      },
      {
        reason: 'rate-limit',
        text: 'API Error 429: rate_limit_error',
        message: 'terminal provider rate-limit result observed',
      },
      {
        reason: 'server-error',
        text: 'API Error 503: Service temporarily unavailable. overloaded_error',
        message: 'terminal provider server-error result observed',
      },
      {
        reason: 'model-unavailable',
        text: 'The requested model does not exist or you do not have access.',
        message: 'suppressed provider model-unavailable message from result — session will be shut down',
      },
    ];

    for (const item of cases) {
      const runtime = makeRuntime({ sessionScope: 'per_chat' });
      const state = view(runtime);
      const queue = makeQueue(`${item.reason}@s.whatsapp.net`);
      const session = makeSession();
      const durability = installDurabilityStub(runtime);
      const conversationKey = `${item.reason}-conversation`;
      const context = runtimeContext('per_chat', conversationKey, queue.targetChatJid, 42, `turn-${item.reason}`);

      mockRuntimeLogger.warn.mockClear();
      mockEmitAlert.mockClear();
      state.perChatRuntimeTurnContexts.set(item.reason, [context]);
      state.perChatInboundSeqQueue.set(item.reason, [42]);

      state.handleEventWithContext(
        { type: 'result', text: item.text, isError: true },
        queue,
        session,
        conversationKey,
        42,
        item.reason,
        item.reason,
      );

      expect(runtime.getFallbackState().fallbackReason).toBe(item.reason);
      expect(queue.enqueueText).toHaveBeenCalledWith(expect.stringContaining('backup'));
      expect(queue.enqueueResultText).not.toHaveBeenCalledWith(item.text);
      expect(mockEmitAlert).toHaveBeenCalledWith(
        'test',
        'provider_fallback_activated',
        'Provider fallback window activated',
        expect.stringContaining(`reason=${item.reason}`),
      );
      expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          chatJid: queue.targetChatJid,
          textPreview: item.text,
        }),
        item.message,
      );
      expect(session.shutdown).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(durability.finalizeTurnTerminal).toHaveBeenCalledOnce());
      expect(durability.finalizeTurnTerminal).toHaveBeenCalledWith(expect.objectContaining({
        terminal: expect.objectContaining({
          logicalTurnId: `turn-${item.reason}`,
          inboundSeq: 42,
          attemptKind: 'failed',
          attemptFailureClass: item.reason,
        }),
      }));
      expect(durability.completeInbound).not.toHaveBeenCalled();
      expect(queue.flush).not.toHaveBeenCalled();
      const turnCapability = (runtime.getHealthSnapshot().details as Record<string, unknown>).turnCapability as { lastTurnErrorClass?: string };
      expect(turnCapability.lastTurnErrorClass).toBe(item.reason);
    }
  });

  it('shared terminal provider results use the same non-arming terminal transaction', async () => {
    const cases: Array<{
      reason: 'policy-block' | 'context-overflow';
      text: string;
      expectNotice: boolean;
    }> = [
      {
        reason: 'policy-block',
        text: 'This response is blocked by policy.',
        expectNotice: false,
      },
      {
        reason: 'context-overflow',
        text: 'maximum context length exceeded for this turn',
        expectNotice: true,
      },
    ];

    for (const item of cases) {
      const runtime = makeRuntime({ shared: true });
      const state = view(runtime);
      const queue = makeQueue(`${item.reason}@s.whatsapp.net`);
      const session = makeSession();
      const durability = installDurabilityStub(runtime);
      const context = runtimeContext('shared', `${item.reason}-conversation`, queue.targetChatJid, 84, `turn-shared-${item.reason}`);

      state.session = session;
      state.activeChatJid = queue.targetChatJid;
      state.currentTurnChatJid = queue.targetChatJid;
      state.currentInboundSeq = 84;
      state.currentRuntimeTurnContext = context;
      state.singleTurnHadToolActivity = true;
      state.outboundQueues.set(queue.targetChatJid, queue);

      state.handleEvent({ type: 'result', text: item.text, isError: true });

      expect(session.clearTurnWatchdog).toHaveBeenCalledTimes(1);
      expect(queue.endTurn).toHaveBeenCalledTimes(1);
      expect(session.shutdown).toHaveBeenCalledTimes(1);
      expect(queue.enqueueResultText).not.toHaveBeenCalledWith(item.text);
      if (item.expectNotice) {
        expect(queue.enqueueText).toHaveBeenCalledWith(expect.stringContaining('Context limit'));
      } else {
        expect(queue.enqueueText).not.toHaveBeenCalled();
      }
      await vi.waitFor(() => expect(durability.finalizeTurnTerminal).toHaveBeenCalledOnce());
      expect(durability.finalizeTurnTerminal).toHaveBeenCalledWith(expect.objectContaining({
        terminal: expect.objectContaining({
          logicalTurnId: `turn-shared-${item.reason}`,
          inboundSeq: 84,
          attemptKind: item.reason === 'policy-block' ? 'suppressed_by_policy' : 'failed',
        }),
      }));
      expect(durability.completeInbound).not.toHaveBeenCalled();
      expect(state.currentInboundSeq).toBeUndefined();
      expect(queue.flush).not.toHaveBeenCalled();
      const turnCapability = (runtime.getHealthSnapshot().details as Record<string, unknown>).turnCapability as { lastTurnErrorClass?: string };
      expect(turnCapability.lastTurnErrorClass).toBe(item.reason);
    }
  });

  it('recreates per-chat fallback sessions with scoped callbacks and queue preservation', () => {
    const runtime = makeRuntime({ sessionScope: 'per_chat', sandboxPerChat: true, cwd: '/tmp/runtime-edge' });
    const state = view(runtime);
    const oldTracker = { shutdown: vi.fn() };
    state.operationTrackers.set('group-edge@g.us', oldTracker);
    state.workspaceResources.set('group-edge@g.us', {
      workspacePath: '/tmp/runtime-edge/workspaces/group-edge',
      socketPath: '/tmp/runtime-edge/workspaces/group-edge/agent.sock',
      lastActivity: 0,
    });
    state.handleEventPerChat = vi.fn();
    state.handlePerChatCrash = vi.fn();
    state.handleCrashNotify = vi.fn();
    state.handleResumeFailed = vi.fn();

    state.recreatePerChatSessionForFallback(
      'group-edge@g.us',
      'group-edge@g.us',
      'actor-edge@s.whatsapp.net',
    );
    const created = createdSessions.at(-1)!;

    expect(oldTracker.shutdown).toHaveBeenCalledTimes(1);
    expect(created.opts.cwd).toBe('/tmp/runtime-edge/workspaces/group-edge');
    expect(created.opts.whatsoupMcpSocket).toBe('/tmp/runtime-edge/workspaces/group-edge/agent.sock');
    expect(created.opts.mcpSessionContext?.actorJid).toBe('actor-edge@s.whatsapp.net');
    expect(state.chatSessions.get('group-edge@g.us')).toBe(created.session);
    expect(state.chatQueues.has('group-edge@g.us')).toBe(true);
    expect(created.session.resolveGenerationOwnership()).toEqual({
      managerId: expect.any(String),
      generation: 1,
    });

    created.opts.onEvent({ type: 'result', text: 'stand-in reply' });
    expect(state.handleEventPerChat).toHaveBeenCalledWith(
      'group-edge@g.us',
      { type: 'result', text: 'stand-in reply' },
      expect.stringMatching(/^group-edge@g\.us#/),
    );

    created.opts.onCrash?.({
      exitCode: 1,
      signal: null,
      sessionId: 'fallback-session',
      dbRowId: 9,
      provider: 'opencode-cli',
    });
    expect(state.handlePerChatCrash).toHaveBeenCalledWith(
      'group-edge@g.us',
      'group-edge@g.us',
      expect.objectContaining({ sessionId: 'fallback-session' }),
      created.session,
    );

    created.opts.notifyUser?.('fallback session crashed');
    expect(state.handleCrashNotify).toHaveBeenCalledWith('fallback session crashed', 'group-edge@g.us');

    created.opts.onResumeFailed?.();
    expect(state.handleResumeFailed).toHaveBeenCalledWith('group-edge@g.us');

    expect(state.deleteOwnedPerChatSession('group-edge@g.us', created.session)).toBe(true);
    expect(created.session.resolveGenerationOwnership()).toBeNull();
    created.opts.onEvent({ type: 'result', text: 'late event' });
    expect(state.handleEventPerChat).toHaveBeenCalledTimes(1);
  });

  it('wires operation tracker callbacks to queue progress and session recovery', async () => {
    const runtime = makeRuntime({ sessionScope: 'per_chat', cwd: '/tmp/runtime-edge-tracker' });
    mockConfig.operationTracker = {
      enabled: true,
      progressIntervalMs: 10,
      thinkingLongMs: 40,
      thinkingStallMs: 60,
      progressPlaceholderRateLimitMs: 0,
      toolThresholds: {
        default: { expectedMs: 20, slowMultiplier: 2, stallMultiplier: 3 },
        bash: { expectedMs: 20, slowMultiplier: 2, stallMultiplier: 3 },
      },
    };
    const state = view(runtime);

    state.recreatePerChatSessionForFallback('tracker-edge@g.us', 'tracker-edge@g.us');
    const session = createdSessions.at(-1)!.session;
    const queue = state.chatQueues.get('tracker-edge@g.us') as QueueMock;
    const tracker = state.operationTrackers.get('tracker-edge@g.us');

    expect(tracker?.onToolStart).toBeTypeOf('function');
    tracker!.onToolStart!('tool-edge', 'Bash', 'running');
    await vi.advanceTimersByTimeAsync(10);

    expect(queue.enqueueProgressUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'operation_progress', toolId: 'tool-edge' }),
      'test',
    );

    await vi.advanceTimersByTimeAsync(50);
    expect(session.recoverStalledOperation).toHaveBeenCalledWith('tool-edge', 'Bash');
    expect(queue.enqueueProgressUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'operation_stalled', toolId: 'tool-edge' }),
      'test',
    );

    tracker!.onToolEnd!('tool-edge');
    await vi.advanceTimersByTimeAsync(60);

    expect(queue.enqueueProgressUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'thinking_stalled' }),
      'test',
    );
    expect(session.probeLiveness).toHaveBeenCalledTimes(1);
    tracker!.shutdown();
  });

  it('migrates LID-keyed per-chat state when a phone alias arrives', async () => {
    const runtime = makeRuntime({ sessionScope: 'per_chat' });
    const state = view(runtime);
    state.flushImageCoalesce = vi.fn(async () => {});
    const conversationKey = '15551234567';
    const lidKey = `${conversationKey}@lid`;
    const phoneJid = `${conversationKey}@s.whatsapp.net`;
    const session = makeSession();
    const chatQueue = makeQueue(lidKey);
    const singletonQueue = makeQueue('single-edge@s.whatsapp.net');
    const sharedQueue = makeQueue(lidKey);
    const socketServer = { updateDeliveryJid: vi.fn() };
    const imageTimer = 0 as unknown as ReturnType<typeof setTimeout>;
    const pendingPoll = {
      toolUseId: 'tool-poll-edge',
      pollId: 'poll-edge',
      chatJid: lidKey,
      chatJidAliases: new Set<string>([lidKey]),
      options: ['Yes', 'No'],
      resolution: 'first-vote-wins',
      adminJids: null,
      votes: new Map<string, PollVote>(),
      timeoutMs: 60_000,
      createdAt: Date.now(),
      resolve: vi.fn(),
      reject: vi.fn(),
    } as unknown as PendingPollQuestion;

    installPollPersistenceStub(runtime);
    state.setOwnedPerChatSession(lidKey, session);
    state.chatQueues.set(lidKey, chatQueue);
    state.perChatInboundSeqQueue.set(lidKey, [7]);
    state.pendingTurnText.set(lidKey, 'pending alias turn');
    state.pendingTurnActorJid.set(lidKey, 'actor-edge@s.whatsapp.net');
    state.perChatTurnContentType.set(lidKey, 'text');
    state.perChatTurnText.set(lidKey, 'streaming text');
    state.perChatAssistantItemText.set(lidKey, new Map([['item-1', 'partial']]));
    state.resumeFailedHandling.add(lidKey);
    state.pendingPolls.questions.set(lidKey, pendingPoll);
    state.imageCoalesce.buffers.set(lidKey, {
      timer: imageTimer,
      msg: { chatJid: lidKey },
    });
    state.workspaceResources.set(conversationKey, {
      workspacePath: '/tmp/runtime-edge-alias',
      lastActivity: Date.now(),
      socketServer,
    });
    state.outboundQueues.set(lidKey, sharedQueue);
    state.queue = singletonQueue;

    runtime.handleJidAliasChanged(conversationKey, phoneJid);

    expect(chatQueue.updateDeliveryJid).toHaveBeenCalledWith(phoneJid);
    expect(socketServer.updateDeliveryJid).toHaveBeenCalledWith(phoneJid);
    expect(singletonQueue.updateDeliveryJid).toHaveBeenCalledWith(phoneJid);
    expect(sharedQueue.updateDeliveryJid).toHaveBeenCalledWith(phoneJid);
    expect(state.chatSessions.get(phoneJid)).toBe(session);
    expect(state.chatSessions.has(lidKey)).toBe(false);
    expect(state.chatQueues.get(phoneJid)).toBe(chatQueue);
    expect(state.perChatInboundSeqQueue.get(phoneJid)).toEqual([7]);
    expect(state.pendingTurnText.get(phoneJid)).toBe('pending alias turn');
    expect(state.pendingTurnActorJid.get(phoneJid)).toBe('actor-edge@s.whatsapp.net');
    expect(state.perChatTurnContentType.get(phoneJid)).toBe('text');
    expect(state.perChatTurnText.get(phoneJid)).toBe('streaming text');
    expect(state.perChatAssistantItemText.get(phoneJid)?.get('item-1')).toBe('partial');
    expect(state.resumeFailedHandling.has(phoneJid)).toBe(true);
    expect(state.pendingPolls.questions.get(phoneJid)?.chatJid).toBe(phoneJid);
    expect(state.imageCoalesce.buffers.get(phoneJid)?.msg.chatJid).toBe(phoneJid);
    expect(state.outboundQueues.get(phoneJid)).toBe(sharedQueue);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(state.flushImageCoalesce).toHaveBeenCalledWith(phoneJid);
  });

  it('wires standard per-chat and singleton session setup callbacks', async () => {
    const trackerConfig = {
      enabled: true,
      progressIntervalMs: 10,
      thinkingLongMs: 40,
      thinkingStallMs: 60,
      progressPlaceholderRateLimitMs: 0,
      toolThresholds: {
        default: { expectedMs: 20, slowMultiplier: 2, stallMultiplier: 3 },
        bash: { expectedMs: 20, slowMultiplier: 2, stallMultiplier: 3 },
      },
    };
    const perChatMessenger = makeMessenger();
    const perChatRuntime = makeRuntime({ sessionScope: 'per_chat' }, perChatMessenger);
    mockConfig.operationTracker = trackerConfig;
    const perChatState = view(perChatRuntime);
    perChatState.handleEventPerChat = vi.fn();
    perChatState.handlePerChatCrash = vi.fn();

    perChatState.ensureSessionAndQueueSync(
      'per-setup@s.whatsapp.net',
      'per-setup@s.whatsapp.net',
      'actor-edge@s.whatsapp.net',
    );
    const perChatCreated = createdSessions.at(-1)!;
    const perChatQueue = perChatState.chatQueues.get('per-setup@s.whatsapp.net') as QueueMock;
    const perChatTracker = perChatState.operationTrackers.get('per-setup@s.whatsapp.net');

    perChatCreated.opts.onEvent({ type: 'result', text: 'per-chat result' });
    expect(perChatState.handleEventPerChat).toHaveBeenCalledWith(
      'per-setup@s.whatsapp.net',
      { type: 'result', text: 'per-chat result' },
      expect.stringMatching(/^per-setup@s\.whatsapp\.net#/),
    );

    perChatTracker!.onToolStart!('per-tool', 'Bash', 'running');
    await vi.advanceTimersByTimeAsync(60);
    expect(perChatCreated.session.recoverStalledOperation).toHaveBeenCalledWith('per-tool', 'Bash');
    expect(perChatQueue.enqueueProgressUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'operation_stalled', toolId: 'per-tool' }),
      'test',
    );

    perChatCreated.opts.onCrash?.({
      exitCode: 9,
      signal: null,
      sessionId: 'per-session',
      dbRowId: 9,
      provider: 'claude-cli',
    });
    expect(perChatState.handlePerChatCrash).toHaveBeenCalledWith(
      'per-setup@s.whatsapp.net',
      'per-setup@s.whatsapp.net',
      expect.objectContaining({ sessionId: 'per-session' }),
      perChatCreated.session,
    );

    perChatCreated.opts.notifyUser?.('per-chat crash notice');
    await Promise.resolve();
    expect(perChatQueue.abortTurn).not.toHaveBeenCalled();
    expect(perChatQueue.enqueueText).toHaveBeenCalledWith('per-chat crash notice');
    expect(perChatQueue.flush).toHaveBeenCalledTimes(1);
    expect(perChatMessenger.sendMessage).not.toHaveBeenCalled();
    expect(
      perChatState.deleteOwnedPerChatSession('per-setup@s.whatsapp.net', perChatCreated.session),
    ).toBe(true);
    expect(perChatCreated.session.resolveGenerationOwnership()).toBeNull();
    perChatCreated.opts.onEvent({ type: 'result', text: 'late event' });
    expect(perChatState.handleEventPerChat).toHaveBeenCalledTimes(1);

    const singleRuntime = makeRuntime({ sessionScope: 'single' });
    mockConfig.operationTracker = trackerConfig;
    const singleState = view(singleRuntime);
    singleState.handleEvent = vi.fn();
    singleState.ensureSessionAndQueueSync(
      'single-setup@s.whatsapp.net',
      undefined,
      'actor-edge@s.whatsapp.net',
    );
    const singleCreated = createdSessions.at(-1)!;
    const singleQueue = singleState.queue as QueueMock;
    const singleTracker = singleState.operationTracker as {
      onToolStart: (toolId: string, toolName: string, category: 'running') => void;
      shutdown: () => void;
    };

    singleCreated.opts.onEvent({ type: 'result', text: 'singleton result' });
    expect(singleState.handleEvent).toHaveBeenCalledWith({ type: 'result', text: 'singleton result' });
    singleCreated.opts.notifyUser?.('singleton crash notice');
    expect(singleQueue.enqueueText).toHaveBeenCalledWith('singleton crash notice');
    await vi.waitFor(() => {
      expect(singleQueue.flush).toHaveBeenCalled();
    });

    singleTracker.onToolStart('single-tool', 'Bash', 'running');
    await vi.advanceTimersByTimeAsync(60);
    expect(singleCreated.session.recoverStalledOperation).toHaveBeenCalledWith('single-tool', 'Bash');
    expect(singleQueue.enqueueProgressUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'operation_stalled', toolId: 'single-tool' }),
      'test',
    );

    singleCreated.opts.onCrash?.({
      exitCode: 1,
      signal: null,
      sessionId: 'single-session',
      dbRowId: 10,
      provider: 'claude-cli',
    });
    expect(singleState.operationTracker).toBeNull();
    expect(singleQueue.abortTurn.mock.calls).toEqual([[]]);
  });

  it('renders fallback activation notices with provider labels and credential-missing copy', () => {
    const runtime = makeRuntime();
    const queue = makeQueue();
    const state = view(runtime);
    const activeUntil = Date.now() + 60_000;
    const providers = [
      ['claude-cli', 'Claude'],
      ['codex-cli', 'Codex'],
      ['gemini-cli', 'Gemini'],
      ['openai-api', 'OpenAI'],
      ['anthropic-api', 'Anthropic'],
      ['custom-provider', 'custom-provider'],
    ] as const;

    for (const [provider, label] of providers) {
      state.notifyProviderFallbackActivated(queue, {
        reason: 'rate-limit',
        fallbackProvider: provider,
        activeUntil,
        resetAt: null,
        extended: false,
        keyPresent: true,
      });
      expect(queue.enqueueText).toHaveBeenLastCalledWith(expect.stringContaining(label));
    }

    state.notifyProviderFallbackActivated(queue, {
      reason: 'usage-limit',
      fallbackProvider: 'openai-api',
      fallbackModel: 'backup-model',
      activeUntil: activeUntil + 1,
      resetAt: null,
      extended: false,
      keyPresent: false,
    });

    expect(queue.enqueueText).toHaveBeenLastCalledWith(expect.stringContaining('credentials'));
  });

  it('recreates singleton fallback sessions and wires lifecycle callbacks', () => {
    const runtime = makeRuntime({ sessionScope: 'single', cwd: '/tmp/runtime-edge-single' });
    const state = view(runtime);
    const oldTracker = { shutdown: vi.fn() };
    state.operationTracker = oldTracker;
    state.queue = makeQueue('direct-edge@s.whatsapp.net');
    state.handleEvent = vi.fn();
    state.handleCrashNotify = vi.fn();
    state.handleResumeFailed = vi.fn();

    state.recreateSingletonSessionForFallback('direct-edge@s.whatsapp.net', 'actor-edge@s.whatsapp.net');
    const created = createdSessions.at(-1)!;

    expect(oldTracker.shutdown).toHaveBeenCalledTimes(1);
    expect(state.session).toBe(created.session);
    expect(state.activeChatJid).toBe('direct-edge@s.whatsapp.net');
    expect(created.opts.cwd).toBe('/tmp/runtime-edge-single');
    expect(created.opts.mcpSessionContext?.actorJid).toBe('actor-edge@s.whatsapp.net');

    created.opts.onEvent({ type: 'result', text: 'singleton reply' });
    expect(state.handleEvent).toHaveBeenCalledWith({ type: 'result', text: 'singleton reply' });

    created.opts.onCrash?.({
      exitCode: 1,
      signal: 'SIGTERM',
      sessionId: 'singleton-session',
      dbRowId: 12,
      provider: 'opencode-cli',
      stderrPreview: 'closed',
    });
    expect((state.queue as QueueMock).abortTurn).toHaveBeenCalledTimes(1);

    created.opts.notifyUser?.('singleton fallback crashed');
    expect(state.handleCrashNotify).toHaveBeenCalledWith('singleton fallback crashed');

    created.opts.onResumeFailed?.();
    expect(state.handleResumeFailed).toHaveBeenCalledWith('direct-edge@s.whatsapp.net');
  });

  it('schedules and reports a successful singleton fallback replay', async () => {
    const runtime = makeRuntime({ sessionScope: 'single' });
    const state = view(runtime);
    const oldSession = makeSession();
    const activation = state.activateProviderFallback(null, 'usage-limit');
    expect(activation).not.toBeNull();
    state.currentTurnReplayText = 'retry this interrupted turn';
    state.currentTurnReplayActorJid = 'actor-edge@s.whatsapp.net';

    const scheduled = state.scheduleFallbackReplay({
      activation: activation!,
      chatJid: 'direct-edge@s.whatsapp.net',
      oldSession,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(scheduled).toBe(true);
    expect(oldSession.shutdown).toHaveBeenCalledWith(false);
    await vi.waitFor(() => {
      expect(createdSessions.at(-1)!.session.sendTurn).toHaveBeenCalledWith('retry this interrupted turn');
      expect(mockEmitAlert).toHaveBeenCalledWith(
        'test',
        'provider_fallback_replayed',
        'Interrupted turn replayed on fallback provider',
        expect.stringContaining('provider=opencode-cli'),
        'info',
      );
    });
  });

  it('runs a control repair turn and escalates on timeout', async () => {
    mockConfig.controlPeers = new Map([['loops', '15550000001']]);
    mockConfig.adminPhones = new Set(['15550000002']);
    const messenger = makeMessenger();
    const runtime = makeRuntime({ cwd: '/tmp/runtime-edge-control' }, messenger);
    const state = view(runtime);

    await state.handleControlTurn('report-edge', '{"symptom":"stuck"}');
    const controlSession = createdSessions.at(-1)!.session;
    const controlQueue = createdControlQueues.at(-1)! as {
      sendControlMessage: ReturnType<typeof vi.fn>;
    };

    expect(controlSession.spawnSession).toHaveBeenCalledTimes(1);
    expect(controlSession.sendTurn).toHaveBeenCalledWith(expect.stringContaining('[REPAIR REQUEST'));
    expect(controlSession.sendTurn).toHaveBeenCalledWith(expect.stringContaining('report-edge'));

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    await Promise.resolve();

    expect(runtime.currentControlReportId).toBeNull();
    expect(controlQueue.sendControlMessage.mock.calls).toEqual([[
      '15550000001@s.whatsapp.net',
      'HEAL_ESCALATE',
      expect.objectContaining({ reportId: 'report-edge', errorClass: 'timeout' }),
      undefined,
    ]]);
    expect(messenger.sendMessage).toHaveBeenCalledWith(
      '15550000002@s.whatsapp.net',
      expect.stringContaining('report report-edge timed out'),
    );
    expect(controlSession.shutdown).toHaveBeenCalledTimes(1);
  });

  it('wires control-session event, crash, and tracker callbacks', async () => {
    const runtime = makeRuntime({ cwd: '/tmp/runtime-edge-control-callbacks' });
    mockConfig.operationTracker = {
      enabled: true,
      progressIntervalMs: 10,
      thinkingLongMs: 40,
      thinkingStallMs: 60,
      progressPlaceholderRateLimitMs: 0,
      toolThresholds: {
        default: { expectedMs: 20, slowMultiplier: 2, stallMultiplier: 3 },
        bash: { expectedMs: 20, slowMultiplier: 2, stallMultiplier: 3 },
      },
    };
    const state = view(runtime);
    state.handleEventPerChat = vi.fn();

    await state.handleControlTurn('report-callbacks', '{"symptom":"loop"}');
    const created = createdSessions.at(-1)!;
    const controlQueue = createdControlQueues.at(-1)! as QueueMock;
    const controlJid = ['control', 'heal.internal'].join('@');
    const tracker = state.operationTrackers.get(controlJid);

    created.opts.onEvent({ type: 'result', text: 'control event' });
    expect(state.handleEventPerChat).toHaveBeenCalledWith(
      controlJid,
      { type: 'result', text: 'control event' },
      expect.stringMatching(new RegExp('^control' + '@' + 'heal\\.internal#')),
    );

    tracker!.onToolStart!('control-tool', 'Bash', 'running');
    await vi.advanceTimersByTimeAsync(60);
    expect(created.session.recoverStalledOperation).toHaveBeenCalledWith('control-tool', 'Bash');
    expect(controlQueue.enqueueProgressUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'operation_stalled', toolId: 'control-tool' }),
      'test',
    );

    created.opts.notifyUser?.('ignored user notice');
    created.opts.onResumeFailed?.();
    created.opts.onCrash?.({
      exitCode: 1,
      signal: null,
      sessionId: 'control-session',
      dbRowId: 13,
      provider: 'claude-cli',
    });

    expect(runtime.currentControlReportId).toBeNull();
    expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reportId: 'report-callbacks', sessionId: 'control-session' }),
      'control session crashed',
    );
  });

  it('builds diagnostic probes with runtime health and primary recovery callbacks', async () => {
    const runtime = makeRuntime({ cwd: '/tmp/runtime-edge-diagnostics' });
    const state = view(runtime);
    const invoked: {
      health?: unknown;
      reset?: number | null;
      usability?: Promise<unknown>;
      recovery?: Promise<unknown>;
    } = {};
    mockBuildDiagnosticProbes.mockImplementationOnce((argsUnknown: unknown) => {
      const args = argsUnknown as {
      getHealthSnapshot: () => unknown;
      parseUsageLimitReset: (text: string) => number | null;
      runPrimaryModelUsability: () => Promise<unknown>;
      runPrimaryRecoveryProbe: () => Promise<unknown>;
      };
      invoked.health = args.getHealthSnapshot();
      invoked.reset = args.parseUsageLimitReset('Usage limit reached. Your limit will reset at 11:00 AM.');
      invoked.usability = args.runPrimaryModelUsability();
      invoked.recovery = args.runPrimaryRecoveryProbe();
      return {};
    });
    mockRunDiagnosticBundle.mockRejectedValueOnce(new Error('diagnostic failed'));

    state.kickDiagnosticBundle(
      RESPONSE_WORKFLOWS.provider_usage_limit,
      'Usage limit reached. Your limit will reset at 11:00 AM.',
    );
    await Promise.all([invoked.usability, invoked.recovery]);
    await Promise.resolve();

    expect(invoked.health).toEqual(expect.objectContaining({
      summary: expect.stringContaining('effective=claude-cli'),
    }));
    expect(invoked.reset).toBeTypeOf('number');
    expect(mockRunDiagnosticBundle).toHaveBeenCalledWith(expect.objectContaining({
      workflow: RESPONSE_WORKFLOWS.provider_usage_limit,
    }));
    expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'claude-cli' }),
      'diagnostic bundle failed',
    );
  });

  it('records rapid auto-compact rearm and sweeps idle shared queues', async () => {
    const runtime = makeRuntime({ sessionScope: 'per_chat', autoCompactInputTokens: 50 });
    const state = view(runtime);
    const session = makeSession();
    session.getStatus.mockReturnValue({
      active: true,
      pid: 123,
      sessionId: 'compact-session',
      startedAt: new Date().toISOString(),
      messageCount: 1,
      lastMessageAt: new Date().toISOString(),
    } as never);
    session.getDbRowId.mockReturnValue(41 as never);
    session.sendTurn.mockRejectedValueOnce(new Error('compact send failed'));
    vi.mocked(getSessionTokenSnapshot).mockReturnValueOnce({
      totalInputTokens: 140,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      lastCompactInputTokens: 70,
      lastCompactOutputTokens: 0,
      lastCompactCacheReadTokens: 0,
    });
    state.autoCompact.lastSuccessAt.set('compact-scope', Date.now() - 1_000);

    state.maybeStartAutoCompact(session, 'compact-scope');
    await Promise.resolve();

    expect(state.autoCompact.ineffective).toBe(1);
    expect(state.autoCompact.consecutiveRapidRearms.get('compact-scope')).toBe(1);
    expect(session.sendTurn).not.toHaveBeenCalled();

    const sharedRuntime = makeRuntime({ shared: true });
    const sharedState = view(sharedRuntime);
    const idleQueue = makeQueue('idle-edge@s.whatsapp.net') as QueueMock & {
      lastActivity: number;
      hasPendingWork: ReturnType<typeof vi.fn>;
    };
    idleQueue.lastActivity = Date.now() - (61 * 60 * 1000);
    idleQueue.hasPendingWork = vi.fn(() => false);
    idleQueue.shutdown.mockRejectedValueOnce(new Error('idle shutdown failed'));
    sharedState.outboundQueues.set('idle-edge@s.whatsapp.net', idleQueue);

    sharedState.startQueueSweepTimer();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await Promise.resolve();

    expect(sharedState.outboundQueues.has('idle-edge@s.whatsapp.net')).toBe(false);
    expect(idleQueue.shutdown.mock.calls).toEqual([[]]);
  });

  it('keeps active, busy, and recently touched shared queues during idle sweeps', async () => {
    const runtime = makeRuntime({ shared: true });
    const state = view(runtime);
    const currentQueue = makeQueue('current-edge@s.whatsapp.net') as QueueMock & {
      lastActivity: number;
      hasPendingWork: ReturnType<typeof vi.fn>;
    };
    const busyQueue = makeQueue('busy-edge@s.whatsapp.net') as QueueMock & {
      lastActivity: number;
      hasPendingWork: ReturnType<typeof vi.fn>;
    };
    const freshQueue = makeQueue('fresh-edge@s.whatsapp.net') as QueueMock & {
      hasPendingWork: ReturnType<typeof vi.fn>;
    };
    currentQueue.lastActivity = Date.now() - (61 * 60 * 1000);
    currentQueue.hasPendingWork = vi.fn(() => false);
    busyQueue.lastActivity = Date.now() - (61 * 60 * 1000);
    busyQueue.hasPendingWork = vi.fn(() => true);
    freshQueue.hasPendingWork = vi.fn(() => false);
    state.currentTurnChatJid = currentQueue.targetChatJid;
    state.outboundQueues.set(currentQueue.targetChatJid, currentQueue);
    state.outboundQueues.set(busyQueue.targetChatJid, busyQueue);
    state.outboundQueues.set(freshQueue.targetChatJid, freshQueue);

    state.startQueueSweepTimer();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    expect(state.outboundQueues.has(currentQueue.targetChatJid)).toBe(true);
    expect(state.outboundQueues.has(busyQueue.targetChatJid)).toBe(true);
    expect(state.outboundQueues.has(freshQueue.targetChatJid)).toBe(true);
    expect(currentQueue.shutdown).not.toHaveBeenCalled();
    expect(busyQueue.shutdown).not.toHaveBeenCalled();
    expect(freshQueue.shutdown).not.toHaveBeenCalled();
  });

  it('fires image coalesce timers and logs direct-send failures', async () => {
    const messenger = makeMessenger();
    messenger.sendMessage
      .mockRejectedValueOnce(new Error('send failed'))
      .mockRejectedValueOnce(new Error('fallback failed'))
      .mockRejectedValueOnce(new Error('crash fallback failed'));
    const runtime = makeRuntime({ sessionScope: 'per_chat' }, messenger);
    const state = view(runtime);
    state.flushImageCoalesce = vi.fn(async () => {});

    await state.coalesceImageTurn(
      'image-edge@s.whatsapp.net',
      'image-edge@s.whatsapp.net',
      '[image:/tmp/edge.png]',
      {
        chatJid: 'image-edge@s.whatsapp.net',
        senderJid: 'sender-edge@s.whatsapp.net',
        inboundSeq: 17,
      },
    );
    await vi.advanceTimersByTimeAsync(3_000);

    state.sendDirect('direct-edge@s.whatsapp.net', 'admin notice', true);
    state.sendDirect('fallback-edge@s.whatsapp.net', 'fallback notice');
    (state.handleCrashNotify as unknown as (msg: string, chatJid?: string) => void)(
      'crash notice',
      'crash-edge@s.whatsapp.net',
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(state.flushImageCoalesce).toHaveBeenCalledWith('image-edge@s.whatsapp.net');
    expect(mockRuntimeLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'sendDirect bypass failed',
    );
    expect(mockRuntimeLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'sendDirect fallback failed',
    );
    expect(mockRuntimeLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'crash notice fallback send failed',
    );
  });

  it('flushes image coalesce at the batch cap and cleans failed representative seq state', async () => {
    vi.useRealTimers();
    const runtime = makeRuntime({ sessionScope: 'per_chat' });
    const state = view(runtime);
    const mapKey = 'image-batch-edge@s.whatsapp.net';
    const session = makeSession();
    session.getStatus.mockReturnValue({
      active: true,
      pid: 123,
      sessionId: 'image-batch-session',
      startedAt: new Date().toISOString(),
      messageCount: 1,
      lastMessageAt: new Date().toISOString(),
    } as never);
    session.sendTurn.mockRejectedValueOnce(new Error('coalesced send failed'));
    const queue = makeQueue(mapKey);
    const durability = installDurabilityStub(runtime);
    state.setOwnedPerChatSession(mapKey, session);
    state.chatQueues.set(mapKey, queue);

    for (let i = 0; i < 20; i += 1) {
      await state.coalesceImageTurn(
        mapKey,
        mapKey,
        `[image:/tmp/edge-${i}.png]`,
        {
          messageId: `image-edge-${i}`,
          chatJid: mapKey,
          senderJid: 'sender-edge@s.whatsapp.net',
          senderName: null,
          contentType: 'image',
          isGroup: false,
          ...(i === 0 || i === 1 ? {} : { inboundSeq: i + 1 }),
        },
      );
    }
    await state.perChatTurnQueues.get(mapKey)!.idle();

    expect(state.imageCoalesce.buffers.has(mapKey)).toBe(false);
    expect(session.sendTurn).toHaveBeenCalledWith(expect.stringContaining('[20 images received]'));
    expect(durability.finalizeTurnTerminal).toHaveBeenCalledOnce();
    expect(durability.finalizeTurnTerminal).toHaveBeenCalledWith(expect.objectContaining({
      terminal: expect.objectContaining({ inboundSeq: 20, attemptKind: 'failed', attemptFailureClass: 'processor_throw' }),
    }));
    expect(state.perChatInboundSeqQueue.has(mapKey)).toBe(false);
    expect(state.pendingTurnText.has(mapKey)).toBe(false);
    expect(state.pendingTurnActorJid.has(mapKey)).toBe(false);
    expect(state.perChatTurnContentType.has(mapKey)).toBe(false);
    expect(state.perChatTurnText.has(mapKey)).toBe(false);
    expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ mapKey, bufferedCount: 20, maxBatch: 20 }),
      'image coalesce batch limit reached — flushing immediately',
    );
    expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), chatJid: mapKey }),
      'turn processor error — finalizing before queue advance',
    );
  });

  it('flushes a single unsequenced coalesced image without inventing inbound seq state', async () => {
    const runtime = makeRuntime({ sessionScope: 'per_chat' });
    const state = view(runtime);
    const mapKey = 'image-unsequenced-edge@s.whatsapp.net';
    const session = makeSession();
    session.getStatus.mockReturnValue({
      active: true,
      pid: 123,
      sessionId: 'image-unsequenced-session',
      startedAt: new Date().toISOString(),
      messageCount: 1,
      lastMessageAt: new Date().toISOString(),
    } as never);
    const queue = makeQueue(mapKey);
    state.setOwnedPerChatSession(mapKey, session);
    state.chatQueues.set(mapKey, queue);

    await state.coalesceImageTurn(
      mapKey,
      mapKey,
      '[image:/tmp/unsequenced.png]',
      {
        chatJid: mapKey,
        senderJid: 'sender-edge@s.whatsapp.net',
      },
    );
    await state.flushImageCoalesce(mapKey);
    await drainMicrotasks();
    await state.perChatTurnQueues.get(mapKey)!.idle();

    expect(session.sendTurn).toHaveBeenCalledWith('[image:/tmp/unsequenced.png]');
    expect(queue.setInboundSeq).toHaveBeenCalledWith(undefined);
    expect(state.perChatInboundSeqQueue.get(mapKey)).toEqual([]);
    expect(state.imageCoalesce.buffers.has(mapKey)).toBe(false);
  });

  it('aborts pending image coalesce flush while resume-failed recovery owns the chat', async () => {
    const runtime = makeRuntime({ sessionScope: 'per_chat' });
    const state = view(runtime);
    const mapKey = 'image-resume-edge@s.whatsapp.net';
    const session = makeSession();
    const queue = makeQueue(mapKey);
    state.setOwnedPerChatSession(mapKey, session);
    state.chatQueues.set(mapKey, queue);

    await state.coalesceImageTurn(
      mapKey,
      mapKey,
      '[image:/tmp/resume-owned.png]',
      {
        chatJid: mapKey,
        senderJid: 'sender-edge@s.whatsapp.net',
        inboundSeq: 41,
      },
    );
    state.resumeFailedHandling.add(mapKey);
    await state.flushImageCoalesce(mapKey);

    expect(state.imageCoalesce.buffers.has(mapKey)).toBe(false);
    expect(session.sendTurn).not.toHaveBeenCalled();
    expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ mapKey }),
      'image coalesce flush skipped during resume-failed recovery',
    );
  });

  it('recovers recent context and replays the pending turn after resume failure', async () => {
    const runtime = makeRuntime({ sessionScope: 'per_chat', sandboxPerChat: true, cwd: '/tmp/runtime-recovery' });
    const state = view(runtime);
    const session = makeSession();
    const chatJid = '15551237777@s.whatsapp.net';
    const mapKey = '15551237777';
    const mark = vi.fn<(scopeKey?: string) => void>();
    const unmark = vi.fn<(scopeKey?: string) => void>();
    const coalesceTimer = 0 as unknown as ReturnType<typeof setTimeout>;

    state.setOwnedPerChatSession(mapKey, session);
    state.pendingTurnText.set(mapKey, 'lost user turn after rejected resume');
    state.pendingTurnActorJid.set(mapKey, 'actor-recovery@s.whatsapp.net');
    state.imageCoalesce.buffers.set(mapKey, {
      timer: coalesceTimer,
      msg: { chatJid },
    });
    state.pendingSystemResults.mark = mark;
    state.pendingSystemResults.unmark = unmark;
    vi.mocked(getRecentMessages).mockReturnValueOnce([
      makeStoredMessage({
        pk: 1,
        messageId: 'older-context',
        senderName: 'Ada',
        content: 'older context',
        timestamp: 1_781_095_100,
      }),
      makeStoredMessage({
        pk: 2,
        messageId: 'newer-media',
        senderJid: 'grace-edge@s.whatsapp.net',
        senderName: null,
        content: null,
        contentType: 'image',
        timestamp: 1_781_095_200,
      }),
    ]);

    state.handleResumeFailed(chatJid);
    await drainMicrotasks();

    expect(session.spawnSession).toHaveBeenCalledTimes(1);
    expect(state.imageCoalesce.buffers.has(mapKey)).toBe(false);
    expect(getRecentMessages).toHaveBeenCalledWith(expect.anything(), mapKey, 30);
    expect(mark).toHaveBeenCalledWith(mapKey);
    expect(unmark).not.toHaveBeenCalled();
    expect(session.sendTurn).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('[CONTEXT RECOVERY'),
    );
    const sendTurnCalls = session.sendTurn.mock.calls as unknown as Array<[string]>;
    expect(sendTurnCalls[0]![0]).toContain('[media]');
    expect(sendTurnCalls[0]![0]).toContain('Ada: older context');
    expect(session.sendTurn).toHaveBeenNthCalledWith(2, 'lost user turn after rejected resume');
    expect(state.resumeFailedHandling.has(mapKey)).toBe(false);
  });

  it('unmarks failed context recovery and still replays the pending turn', async () => {
    const runtime = makeRuntime({ sessionScope: 'per_chat', sandboxPerChat: true, cwd: '/tmp/runtime-recovery' });
    const state = view(runtime);
    const session = makeSession();
    const chatJid = '15551237778@s.whatsapp.net';
    const mapKey = '15551237778';
    const mark = vi.fn<(scopeKey?: string) => void>();
    const unmark = vi.fn<(scopeKey?: string) => void>();

    session.sendTurn
      .mockRejectedValueOnce(new Error('context pipe closed'))
      .mockResolvedValueOnce(undefined);
    state.setOwnedPerChatSession(mapKey, session);
    state.pendingTurnText.set(mapKey, 'turn survives context failure');
    state.pendingTurnActorJid.set(mapKey, 'actor-recovery@s.whatsapp.net');
    state.pendingSystemResults.mark = mark;
    state.pendingSystemResults.unmark = unmark;
    vi.mocked(getRecentMessages).mockReturnValueOnce([
      makeStoredMessage({
        chatJid,
        conversationKey: mapKey,
        content: 'context that fails to send',
      }),
    ]);

    state.handleResumeFailed(chatJid);
    await drainMicrotasks();

    expect(mark).toHaveBeenCalledWith(mapKey);
    expect(unmark).toHaveBeenCalledWith(mapKey);
    expect(session.sendTurn).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('context that fails to send'),
    );
    expect(session.sendTurn).toHaveBeenNthCalledWith(2, 'turn survives context failure');
    expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), chatJid }),
      'context recovery failed — starting blank session',
    );
    expect(state.resumeFailedHandling.has(mapKey)).toBe(false);
  });

  it('drops stale pending-turn state when replay after resume failure cannot be sent', async () => {
    const runtime = makeRuntime({ sessionScope: 'per_chat', sandboxPerChat: true, cwd: '/tmp/runtime-recovery' });
    const state = view(runtime);
    const session = makeSession();
    const chatJid = '15551237779@s.whatsapp.net';
    const mapKey = '15551237779';

    session.sendTurn.mockRejectedValueOnce(new Error('replay pipe closed'));
    state.setOwnedPerChatSession(mapKey, session);
    state.pendingTurnText.set(mapKey, 'stale pending turn');
    state.pendingTurnActorJid.set(mapKey, 'actor-recovery@s.whatsapp.net');

    state.handleResumeFailed(chatJid);
    await drainMicrotasks();

    expect(getRecentMessages).toHaveBeenCalledWith(expect.anything(), mapKey, 30);
    expect(session.sendTurn).toHaveBeenCalledWith('stale pending turn');
    expect(state.pendingTurnText.has(mapKey)).toBe(false);
    expect(state.pendingTurnActorJid.has(mapKey)).toBe(false);
    expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), chatJid }),
      'pending turn replay failed',
    );
    expect(state.resumeFailedHandling.has(mapKey)).toBe(false);
  });

  it('cleans a fresh resume-failure session that loses ownership during spawn', async () => {
    const runtime = makeRuntime({ sessionScope: 'per_chat', sandboxPerChat: true, cwd: '/tmp/runtime-recovery' });
    const state = view(runtime);
    const session = makeSession();
    const chatJid = '15551237780@s.whatsapp.net';
    const mapKey = '15551237780';

    session.spawnSession.mockImplementationOnce(async () => {
      expect(state.deleteOwnedPerChatSession(mapKey, session)).toBe(true);
      expect(session.resolveGenerationOwnership()).toBeNull();
    });
    state.setOwnedPerChatSession(mapKey, session);
    state.pendingTurnText.set(mapKey, 'do not replay to stale session');

    state.handleResumeFailed(chatJid);
    await drainMicrotasks();

    expect(session.spawnSession).toHaveBeenCalledTimes(1);
    expect(getRecentMessages).not.toHaveBeenCalled();
    expect(session.sendTurn).not.toHaveBeenCalled();
    expect(session.shutdown).toHaveBeenCalledWith(false);
    expect(mockRuntimeLogger.error).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'failed to spawn fresh session after resume failure',
    );
    expect(state.resumeFailedHandling.has(mapKey)).toBe(false);
  });

});
