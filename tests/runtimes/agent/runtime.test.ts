import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Database } from '../../../src/core/database.ts';
import type { IncomingMessage, Messenger } from '../../../src/core/types.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import type { IOutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';

// ─── Hoisted mocks ────────────────────────────────────────────────────────────
// vi.hoisted values are available inside vi.mock factory callbacks.

const { mockSession, mockQueue, capturedSessionManagerOptsRef, capturedOnEventRef, capturedOnResumeFailedRef, capturedOnCrashRef, capturedNotifyUserRef } = vi.hoisted(() => {
  type CapturedCrashInfo = {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    sessionId: string | null;
    dbRowId: number | null;
    provider?: string;
    crashClass?: string;
    stderrPreview?: string;
  };
  const capturedSessionManagerOptsRef: {
    current: {
      allowM365Mutations?: boolean;
      configSystemPrompt?: string;
      mcpBridge?: {
        executeTool: (name: string, params: Record<string, unknown>) => Promise<unknown>;
        listTools: () => unknown[];
      };
      mcpSessionContext?: {
        tier: string;
        conversationKey?: string;
        deliveryJid?: string;
        actorJid?: string;
        allowedRoot?: string;
      };
      whatsoupInstance?: string;
      whatsoupMcpSocket?: string;
    } | null;
  } = { current: null };
  const capturedOnEventRef: { current: ((event: AgentEvent) => void) | null } = { current: null };
  const capturedOnResumeFailedRef: { current: (() => void) | null } = { current: null };
  const capturedOnCrashRef: { current: ((info: CapturedCrashInfo) => void) | null } = { current: null };
  const capturedNotifyUserRef: { current: ((msg: string) => void) | null } = { current: null };

  const mockSession = {
    spawnSession: vi.fn(async () => {}),
    sendTurn: vi.fn(async () => {}),
    handleNew: vi.fn(async () => {}),
    getStatus: vi.fn(() => ({ active: false, pid: null as number | null, sessionId: null as string | null, startedAt: null as string | null, messageCount: 0, lastMessageAt: null as string | null })),
    shutdown: vi.fn(async () => {}),
    clearTurnWatchdog: vi.fn(() => {}),
    tickWatchdog: vi.fn(() => {}),
    trackToolStart: vi.fn((_toolId: string) => {}),
    trackToolEnd: vi.fn((_toolId: string) => {}),
    getDbRowId: vi.fn((): number | null => null),
    setDurability: vi.fn((_durability: unknown) => {}),
    getProviderId: vi.fn((): string => 'claude-cli'),
  };

  // NOTE: IOutboundQueue cannot be imported inside vi.hoisted() (runs before imports),
  // but the satisfies check below (outside hoisted) enforces interface compliance
  // at compile time. TypeScript will error if OutboundQueue gains a new public
  // method that isn't reflected here — the mock cannot silently diverge.
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

  return { mockSession, mockQueue, capturedSessionManagerOptsRef, capturedOnEventRef, capturedOnResumeFailedRef, capturedOnCrashRef, capturedNotifyUserRef };
});

const { mockRuntimeLogger, mockReaddirSync } = vi.hoisted(() => ({
  mockRuntimeLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  mockReaddirSync: vi.fn(() => ['0', '1', '2']),
}));

const { mockEmitAlert, mockClearAlertSource } = vi.hoisted(() => ({
  mockEmitAlert: vi.fn(),
  mockClearAlertSource: vi.fn(),
}));

const { mockProbePrimaryModelUsability, mockCreatePrimaryModelProbeAdapters } = vi.hoisted(() => ({
  mockProbePrimaryModelUsability: vi.fn(async (target: { provider: string; model?: string | null }): Promise<{
    status: 'usable' | 'model-unavailable' | 'credential-unavailable' | 'provider-unavailable' | 'timeout' | 'unknown';
    provider: string;
    model: string | null;
    reason?: string;
    suggestion?: string | null;
  }> => ({
    status: target.model ? 'usable' : 'unknown',
    provider: target.provider,
    model: target.model ?? null,
    ...(target.model ? {} : { reason: 'model-not-configured' }),
  })),
  mockCreatePrimaryModelProbeAdapters: vi.fn(() => ({})),
}));

// ─── Module mocks ─────────────────────────────────────────────────────────────

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
}));

type ActiveSessionRow = { id: number; session_id: string | null; chat_jid: string | null; claude_pid: number; status: string; started_at: string; last_message_at: string | null; message_count: number } | null;
const { mockGetActiveSession } = vi.hoisted(() => {
  return { mockGetActiveSession: vi.fn(() => null as ActiveSessionRow) };
});

const { mockBackfillWorkspaceKeys, mockGetResumableSessionForChat, mockGetSessionTokenSnapshot, mockMarkSessionCompacted, mockAccumulateTokensWithEvent } = vi.hoisted(() => ({
  mockBackfillWorkspaceKeys: vi.fn(),
  mockGetResumableSessionForChat: vi.fn(() => null as { id: number; session_id: string; chat_jid: string } | null),
  mockGetSessionTokenSnapshot: vi.fn(() => null as {
    totalInputTokens: number;
    totalOutputTokens: number;
    lastCompactInputTokens: number;
    lastCompactOutputTokens: number;
  } | null),
  mockMarkSessionCompacted: vi.fn(),
  mockAccumulateTokensWithEvent: vi.fn(),
}));

vi.mock('../../../src/runtimes/agent/session-db.ts', () => ({
  ensureAgentSchema: vi.fn(),
  createSession: vi.fn(() => 1),
  accumulateSessionTokens: vi.fn(),
  incrementMessageCount: vi.fn(),
  updateSessionId: vi.fn(),
  updateSessionStatus: vi.fn(),
  getActiveSession: mockGetActiveSession,
  backfillWorkspaceKeys: mockBackfillWorkspaceKeys,
  markOrphaned: vi.fn(),
  getResumableSessionForChat: mockGetResumableSessionForChat,
  backfillSessionProvider: vi.fn(),
  accumulateTokensWithEvent: mockAccumulateTokensWithEvent,
  getSessionTokenSnapshot: mockGetSessionTokenSnapshot,
  markSessionCompacted: mockMarkSessionCompacted,
}));

vi.mock('../../../src/runtimes/agent/session-classifier.ts', () => ({
  classifyActiveSessions: vi.fn(() => []),
}));

vi.mock('../../../src/runtimes/agent/session.ts', () => ({
  // eslint-disable-next-line prefer-arrow-callback -- vi.fn().mockImplementation requires function keyword for constructor mocks; expires 2026-12-31
  SessionManager: vi.fn().mockImplementation(function (
    opts: {
      allowM365Mutations?: boolean;
      configSystemPrompt?: string;
      whatsoupInstance?: string;
      whatsoupMcpSocket?: string;
      onEvent: (event: AgentEvent) => void;
      onResumeFailed?: () => void;
      onCrash?: (info: { exitCode: number | null; signal: NodeJS.Signals | null; sessionId: string | null; dbRowId: number | null; provider?: string; crashClass?: string; stderrPreview?: string }) => void;
      notifyUser?: (msg: string) => void;
    },
  ) {
    capturedSessionManagerOptsRef.current = opts;
    capturedOnEventRef.current = opts.onEvent;
    capturedOnResumeFailedRef.current = opts.onResumeFailed ?? null;
    capturedOnCrashRef.current = opts.onCrash ?? null;
    capturedNotifyUserRef.current = opts.notifyUser ?? null;
    return mockSession;
  }),
  formatAge: vi.fn((isoString: string) => {
    const ms = Date.now() - new Date(isoString).getTime();
    if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
    return `${Math.floor(ms / 3_600_000)}h ago`;
  }),
  getProviderBinary: vi.fn(() => null),
}));

vi.mock('../../../src/runtimes/agent/outbound-queue.ts', () => ({
  // eslint-disable-next-line prefer-arrow-callback -- vi.fn().mockImplementation requires function keyword for constructor mocks; expires 2026-12-31
  OutboundQueue: vi.fn().mockImplementation(function () {
    return mockQueue;
  }),
}));

// Mock config — includes adminPhones and an empty controlPeers map.
// emit_heal_result tool registration is gated on controlPeers.size > 0;
// keeping it empty here avoids that path (which requires heal.ts / durability mocks).
// mockConfig is mutable so individual tests can override voiceReply for voice reply tests.
const { mockConfig, mockSynthesizeSpeech, mockWriteTempFile } = vi.hoisted(() => {
  const mockConfig = {
    adminPhones: new Set<string>(['15550100001']),
    controlPeers: new Map<string, string>(),
    toolUpdateMode: 'full' as 'full' | 'minimal' | 'friendly',
    toolUpdateRedirectJid: null as string | null,
    textAggregateDelayMs: 2_000,
    startupNotifications: true,
    proactiveResumeOnStartup: true,
    mediaDir: '/tmp/whatsoup-test-media/tmp',
    pineconeAllowedIndexes: [] as string[],
    voiceReply: 'never' as 'always' | 'when_received' | 'never',
    elevenlabs: {
      defaultVoiceId: 'test-voice-id',
      defaultModel: 'eleven_multilingual_v2',
      stability: 0.5,
      similarityBoost: 0.75,
    },
  };
  const mockSynthesizeSpeech = vi.fn();
  const mockWriteTempFile = vi.fn().mockReturnValue('/tmp/voice-reply.mp3');
  return { mockConfig, mockSynthesizeSpeech, mockWriteTempFile };
});

const { mockPrepareContentForAgent, actualPrepareContentForAgentRef } = vi.hoisted(() => {
  const actualPrepareContentForAgentRef: {
    current: ((...args: unknown[]) => Promise<string>) | null;
  } = { current: null };
  return {
    mockPrepareContentForAgent: vi.fn(),
    actualPrepareContentForAgentRef,
  };
});

vi.mock('../../../src/config.ts', () => ({ config: mockConfig }));

// Mock ElevenLabs synthesizeSpeech for voice reply tests
vi.mock('../../../src/runtimes/chat/providers/elevenlabs.ts', () => ({
  synthesizeSpeech: mockSynthesizeSpeech,
}));

// Mock writeTempFile and downloadMedia for voice reply tests
vi.mock('../../../src/core/media-download.ts', () => ({
  writeTempFile: mockWriteTempFile,
  downloadMedia: vi.fn(),
}));

vi.mock('../../../src/runtimes/agent/media-prep.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/runtimes/agent/media-prep.ts')>();
  actualPrepareContentForAgentRef.current = actual.prepareContentForAgent as (...args: unknown[]) => Promise<string>;
  mockPrepareContentForAgent.mockImplementation((...args: unknown[]) => actualPrepareContentForAgentRef.current!(...args));
  return {
    ...actual,
    prepareContentForAgent: mockPrepareContentForAgent,
  };
});

// extractLocal is a pure function — no need to mock, but mock the module so
// vi.mock doesn't try to load the real database-importing module chain.
vi.mock('../../../src/core/access-list.ts', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../../../src/core/access-list.ts');
  return actual;
});

// Mock workspace utilities so sandboxPerChat tests don't touch the filesystem
const { mockChatJidToWorkspace, mockProvisionWorkspace } = vi.hoisted(() => ({
  mockChatJidToWorkspace: vi.fn((_instanceCwd: string, chatJid: string) => {
    // Default: strip @s.whatsapp.net → phone as key
    const key = chatJid.replace('@s.whatsapp.net', '').replace('@lid', '');
    return {
      kind: 'dm' as const,
      workspaceKey: key,
      workspacePath: `/tmp/${key}`,
    };
  }),
  mockProvisionWorkspace: vi.fn(() => '/tmp/workspace/.claude/whatsoup.sock'),
}));

vi.mock('../../../src/core/workspace.ts', () => ({
  chatJidToWorkspace: mockChatJidToWorkspace,
  provisionWorkspace: mockProvisionWorkspace,
  writeSandboxArtifacts: vi.fn(),
  ensurePermissionsSettings: vi.fn(),
  writePrivateFileSync: vi.fn(),
}));

// Mock WhatSoupSocketServer so tests don't bind real Unix sockets.
// mockSocketServerInstance is hoisted so vi.mock factory can reference it,
// and MockWhatSoupSocketServer is a vi.fn() so tests can inspect constructor calls.
const { mockSocketServerInstance, MockWhatSoupSocketServer } = vi.hoisted(() => {
  const mockSocketServerInstance = {
    start: vi.fn(),
    stop: vi.fn(),
    updateDeliveryJid: vi.fn(),
    updateActorJid: vi.fn(),
    updateConversationKey: vi.fn(),
  };
  // eslint-disable-next-line prefer-arrow-callback -- vi.fn().mockImplementation requires function keyword for constructor mocks; expires 2026-12-31
  const MockWhatSoupSocketServer = vi.fn().mockImplementation(function () {
    return mockSocketServerInstance;
  });
  return { mockSocketServerInstance, MockWhatSoupSocketServer };
});

vi.mock('../../../src/mcp/socket-server.ts', () => ({
  WhatSoupSocketServer: MockWhatSoupSocketServer,
}));

const { mockMediaBridgeHandle, mockStartMediaBridge, mockSetMediaBridgeChat } = vi.hoisted(() => {
  const mockMediaBridgeHandle = vi.fn() as unknown as ReturnType<typeof vi.fn> & {
    _server: null;
    _currentChatJid: string | null;
  };
  mockMediaBridgeHandle._server = null;
  mockMediaBridgeHandle._currentChatJid = null;

  const mockStartMediaBridge = vi.fn(() => mockMediaBridgeHandle);
  const mockSetMediaBridgeChat = vi.fn((bridge: { _currentChatJid: string | null }, chatJid: string) => {
    bridge._currentChatJid = chatJid;
  });

  return { mockMediaBridgeHandle, mockStartMediaBridge, mockSetMediaBridgeChat };
});

vi.mock('../../../src/runtimes/agent/media-bridge.ts', () => ({
  startMediaBridge: mockStartMediaBridge,
  setMediaBridgeChat: mockSetMediaBridgeChat,
}));

vi.mock('../../../src/runtimes/agent/providers/primary-model-usability.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/runtimes/agent/providers/primary-model-usability.ts')>();
  return {
    ...actual,
    probePrimaryModelUsability: mockProbePrimaryModelUsability,
  };
});

vi.mock('../../../src/runtimes/agent/providers/primary-model-usability-adapters.ts', () => ({
  createPrimaryModelProbeAdapters: mockCreatePrimaryModelProbeAdapters,
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

// Mock node:fs for socket server path creation in start()
vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn().mockReturnValue(Buffer.from('fake-audio-data')),
    readdirSync: mockReaddirSync,
  };
});

// ─── Compile-time mock interface enforcement ──────────────────────────────────
// This assignment fails TypeScript compilation if mockQueue is missing any
// method declared in IOutboundQueue — the mock cannot silently diverge from
// the real OutboundQueue public interface.
const _mockQueueTypeCheck: IOutboundQueue = mockQueue;
void _mockQueueTypeCheck; // suppress unused-variable warning

// ─── Import after mocks ───────────────────────────────────────────────────────

import * as registerAllModule from '../../../src/mcp/register-all.ts';
import { AgentRuntime, isUsageLimitMessage, serializePendingPoll, type PendingPollQuestion } from '../../../src/runtimes/agent/runtime.ts';
import { parseGeminiAcpEvent } from '../../../src/runtimes/agent/providers/gemini-acp-parser.ts';
import { providerUnknownTerminalNotice, renderUserMessage } from '../../../src/runtimes/agent/response-templates.ts';
import { toConversationKey } from '../../../src/core/conversation-key.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';
// View onto the extracted AutoCompactController's bookkeeping (private runtime.autoCompact).
// Loose value types (unknown) preserve the existing pokes (e.g. silentCompactScopes.set(key, 0)).
type AutoCompactView = {
  cooldownUntil: Map<string, number>;
  lastSuccessAt: Map<string, number>;
  rapidRearmRecordedForSuccessAt: Map<string, number>;
  consecutiveRapidRearms: Map<string, number>;
  measureNextTurn: Set<string>;
  compactBoundaryScopes: Set<string>;
  silentCompactScopes: Map<string, unknown>;
  waiters: Map<string, unknown>;
};
type ImageCoalescerView = {
  buffers: Map<string, {
    texts: string[];
    timer: ReturnType<typeof setTimeout>;
    msg: IncomingMessage;
    inboundSeqs: number[];
  }>;
};
import { Database as RealDatabase } from '../../../src/core/database.ts';
import { getRecentMessages } from '../../../src/core/messages.ts';
import { tmpdir } from 'node:os';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDb(): Database {
  return {
    raw: {
      prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) })),
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

function setMockMemoryConfig(): () => void {
  const configWithMemory = mockConfig as typeof mockConfig & {
    memory?: {
      adminJid: string | null;
      sweep: { reviewByDays: number };
    };
  };
  const previous = configWithMemory.memory;
  configWithMemory.memory = {
    adminJid: null,
    sweep: { reviewByDays: 7 },
  };

  return () => {
    if (previous === undefined) {
      delete configWithMemory.memory;
    } else {
      configWithMemory.memory = previous;
    }
  };
}

function fakeTimerHandle(label: string): ReturnType<typeof setTimeout> {
  return { label } as unknown as ReturnType<typeof setTimeout>;
}

type RegisteredTool = {
  name: string;
  handler: (params: unknown) => Promise<unknown>;
};

function getRegisteredTool(runtime: AgentRuntime, name: string): RegisteredTool {
  const registry = (runtime as unknown as {
    registry: { register: ReturnType<typeof vi.fn> };
  }).registry;
  const tools = registry.register.mock.calls.map(([tool]) => tool as RegisteredTool);
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`registered tool not found: ${name}`);
  return tool;
}

async function expectRejectsWithError(promise: Promise<unknown>, message: string): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('Error');
    expect((err as Error).message).toBe(message);
    return;
  }

  throw new Error(`expected rejection: ${message}`);
}

/**
 * Call handleMessage and wait for the turn chain to settle.
 * handleMessage enqueues work onto turnChain without awaiting it, so tests
 * must drain the chain to observe side effects synchronously.
 */
async function sendAndDrain(runtime: AgentRuntime, msg: IncomingMessage): Promise<void> {
  await runtime.handleMessage(msg);
  // Access the private turnChain field to wait for the queued inner work.
  await (runtime as unknown as { turnChain: Promise<void> }).turnChain;
}

/**
 * Like sendAndDrain, but also waits for the TurnQueue to fully drain.
 * Required for shared-mode tests where turns are processed asynchronously
 * inside the TurnQueue rather than inline in _handleMessageInner.
 */
async function sendAndDrainShared(runtime: AgentRuntime, msg: IncomingMessage): Promise<void> {
  await sendAndDrain(runtime, msg);
  // Wait for the TurnQueue to fully drain
  await (runtime as unknown as { turnQueue: { idle: () => Promise<void> } }).turnQueue.idle();
}

function attachRuntimeFaultMarkerSpies(runtime: AgentRuntime): {
  durability: {
    completeInbound: ReturnType<typeof vi.fn>;
    markContinuityCandidateIfNoTerminalOutbound: ReturnType<typeof vi.fn>;
    markInboundFailed: ReturnType<typeof vi.fn>;
    upsertSessionCheckpoint: ReturnType<typeof vi.fn>;
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
  };
  const replyGuarantee = {
    arm: vi.fn(),
    disarm: vi.fn(),
    isArmed: vi.fn(() => true),
    shutdown: vi.fn(),
  };
  (runtime as unknown as { durability: unknown }).durability = durability;
  (runtime as unknown as { replyGuarantee: unknown }).replyGuarantee = replyGuarantee;
  return { durability, replyGuarantee };
}

function mockActiveAgentSession(rowId = 42): void {
  mockSession.getStatus.mockReturnValue({
    active: true,
    pid: 123,
    sessionId: 'session-1',
    startedAt: '2026-05-30T00:00:00.000Z',
    messageCount: 1,
    lastMessageAt: null,
  });
  mockSession.getDbRowId.mockReturnValue(rowId);
}

function mockTokenSnapshot(totalInputTokens: number, lastCompactInputTokens: number): void {
  mockGetSessionTokenSnapshot.mockReturnValue({
    totalInputTokens,
    totalOutputTokens: 0,
    lastCompactInputTokens,
    lastCompactOutputTokens: 0,
  });
}

async function emitAgentResult(inputTokens: number, text: string | null = null): Promise<void> {
  capturedOnEventRef.current?.({ type: 'result', text, inputTokens, outputTokens: 0 });
  await Promise.resolve();
}

async function emitAgentResultWithoutTokens(text: string | null = null): Promise<void> {
  capturedOnEventRef.current?.({ type: 'result', text });
  await Promise.resolve();
}

async function emitTokenUsage(inputTokens: number): Promise<void> {
  capturedOnEventRef.current?.({ type: 'token_usage', inputTokens, outputTokens: 0 });
  await Promise.resolve();
}

async function emitSuccessfulCompactResult(inputTokens = 0): Promise<void> {
  capturedOnEventRef.current?.({ type: 'compact_boundary' });
  await emitAgentResult(inputTokens);
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

type PerChatCleanupRuntimeState = {
  cleanupPerChatState: (mapKey: string) => void;
  crashes: { record(k: string): number; count(k: string): number; size: number };
  perChatInboundSeqQueue: Map<string, number[]>;
  perChatTurnContentType: Map<string, string>;
  perChatTurnText: Map<string, string>;
  perChatAssistantItemText: Map<string, Map<string, string>>;
  pendingTurnText: Map<string, string>;
  pendingPolls: { questions: Map<string, PendingPollQuestion> };
  resumeFailedHandling: Set<string>;
  autoCompact: AutoCompactView;
  imageCoalesce: ImageCoalescerView;
};

type PerChatSendTurnRuntimeState = PerChatCleanupRuntimeState & {
  chatSessions: Map<string, unknown>;
  durability: { markInboundFailed: ReturnType<typeof vi.fn> } | null;
  ensureSessionAndQueue: ReturnType<typeof vi.fn>;
  ensureSessionAndQueueSync: ReturnType<typeof vi.fn>;
  pendingTurnActorJid: Map<string, string | undefined>;
  replyGuarantee: { disarm: ReturnType<typeof vi.fn> };
  sendTurnPerChat: (chatJid: string, text: string, mapKey: string, actorJid?: string) => Promise<void>;
};

function getPerChatCleanupState(runtime: AgentRuntime): PerChatCleanupRuntimeState {
  return runtime as unknown as PerChatCleanupRuntimeState;
}

describe('isUsageLimitMessage', () => {
  it('does not suppress ordinary discussion of usage limits or quotas', () => {
    expect(isUsageLimitMessage(
      'Please document how usage limit and quota exceeded errors should be handled.',
    )).toBe(false);
  });

  it('matches distinctive provider usage-cap notices', () => {
    expect(isUsageLimitMessage("You're out of extra usage. Claude will be available at 8pm.")).toBe(true);
    expect(isUsageLimitMessage('You have hit your usage limit.')).toBe(true);
    expect(isUsageLimitMessage('Insufficient credits for Anthropic API request.')).toBe(true);
    expect(isUsageLimitMessage('Insufficient credits for this request.')).toBe(false);
  });

  it('requires reset-time evidence for generic quota wording', () => {
    expect(isUsageLimitMessage('The integration returned quota exceeded while replaying fixtures.')).toBe(false);
    expect(isUsageLimitMessage('Quota exceeded. Usage resets at 8pm.')).toBe(true);
  });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AgentRuntime', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    capturedOnEventRef.current = null;
    capturedOnCrashRef.current = null;
    capturedNotifyUserRef.current = null;
    capturedOnResumeFailedRef.current = null;
    capturedSessionManagerOptsRef.current = null;
    mockSession.spawnSession.mockResolvedValue(undefined);
    mockSession.getStatus.mockReturnValue({ active: false, pid: null, sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null });
    mockSession.sendTurn.mockResolvedValue(undefined);
    mockSession.getDbRowId.mockReturnValue(null);
    mockGetActiveSession.mockReturnValue(null);
    mockGetResumableSessionForChat.mockReturnValue(null);
    mockGetSessionTokenSnapshot.mockReturnValue(null);
    mockMarkSessionCompacted.mockClear();
    mockAccumulateTokensWithEvent.mockClear();
    mockChatJidToWorkspace.mockImplementation((_instanceCwd: string, chatJid: string) => {
      const key = chatJid.replace('@s.whatsapp.net', '').replace('@lid', '');
      return { kind: 'dm' as const, workspaceKey: key, workspacePath: `/tmp/${key}` };
    });
    mockProvisionWorkspace.mockImplementation(() => '/tmp/workspace/.claude/whatsoup.sock');
    mockStartMediaBridge.mockImplementation(() => mockMediaBridgeHandle);
    mockMediaBridgeHandle._currentChatJid = null;
    mockReaddirSync.mockReturnValue(['0', '1', '2']);
    // Reset SessionManager mock to the default hoisted implementation.
    // Some tests (per_chat /status, per_chat /new) override it; reset so voice reply
    // tests (and others) see the default mock that captures capturedOnEventRef.
    const { SessionManager: SessionManagerMock } = await import('../../../src/runtimes/agent/session.ts');
    (SessionManagerMock as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      function (opts: {
        allowM365Mutations?: boolean;
        whatsoupInstance?: string;
        whatsoupMcpSocket?: string;
        onEvent: (event: AgentEvent) => void;
        onResumeFailed?: () => void;
        onCrash?: (info: { exitCode: number | null; signal: NodeJS.Signals | null; sessionId: string | null; dbRowId: number | null; provider?: string; crashClass?: string; stderrPreview?: string }) => void;
        notifyUser?: (msg: string) => void;
      }) {
        capturedSessionManagerOptsRef.current = opts;
        capturedOnEventRef.current = opts.onEvent;
        capturedOnResumeFailedRef.current = opts.onResumeFailed ?? null;
        capturedOnCrashRef.current = opts.onCrash ?? null;
        capturedNotifyUserRef.current = opts.notifyUser ?? null;
        return mockSession;
      },
    );
    // Reset voice reply config to default (never) between tests
    mockConfig.voiceReply = 'never';
    mockConfig.adminPhones = new Set<string>(['15550100001']);
    mockConfig.controlPeers.clear();
    mockConfig.toolUpdateMode = 'full';
    mockConfig.toolUpdateRedirectJid = null;
    mockConfig.textAggregateDelayMs = 2_000;
    mockConfig.startupNotifications = true;
    mockConfig.proactiveResumeOnStartup = true;
    mockSynthesizeSpeech.mockClear();
    mockWriteTempFile.mockClear();
    mockPrepareContentForAgent.mockImplementation((...args: unknown[]) => actualPrepareContentForAgentRef.current!(...args));
    mockRuntimeLogger.info.mockClear();
    mockRuntimeLogger.warn.mockClear();
    mockRuntimeLogger.error.mockClear();
    mockRuntimeLogger.debug.mockClear();
    mockEmitAlert.mockClear();
    mockClearAlertSource.mockClear();
    mockCreatePrimaryModelProbeAdapters.mockClear();
    mockProbePrimaryModelUsability.mockReset();
    mockProbePrimaryModelUsability.mockImplementation(async (target: { provider: string; model?: string | null }) => ({
      status: target.model ? 'usable' : 'unknown',
      provider: target.provider,
      model: target.model ?? null,
      ...(target.model ? {} : { reason: 'model-not-configured' }),
    }));
    const agentConfig = mockConfig as typeof mockConfig & {
      agentProvider?: string;
      agentProviderConfig?: Record<string, unknown>;
      agentFallbackProvider?: string;
      agentFallbackModel?: string;
      model?: string;
    };
    delete agentConfig.agentProvider;
    delete agentConfig.agentProviderConfig;
    delete agentConfig.agentFallbackProvider;
    delete agentConfig.agentFallbackModel;
    delete agentConfig.model;
    // Ensure mockQueue.flush always returns a resolved Promise (clearAllMocks wipes this)
    mockQueue.flush.mockResolvedValue(undefined);
    mockQueue.targetChatJid = 'test@s.whatsapp.net';
  });

  it('start() calls ensureAgentSchema', async () => {
    const { ensureAgentSchema } = await import('../../../src/runtimes/agent/session-db.ts');
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();

    expect(ensureAgentSchema).toHaveBeenCalledWith(db);
  });

  it('capDedupeMap evicts oldest-first down to max over an object-valued map (BEAD-050)', () => {
    // groupMetadataCache holds object values, so capDedupeMap must operate on
    // Map<string, unknown> (widened from Map<string, number>). Insertion order is
    // FIFO, so eviction must drop the oldest keys first.
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
    // Oldest six (0..5) evicted; newest four (6..9) retained.
    expect([...map.keys()]).toEqual([
      'group-6@g.us',
      'group-7@g.us',
      'group-8@g.us',
      'group-9@g.us',
    ]);

    // Idempotent when already at/under max.
    cap(map, 4);
    expect(map.size).toBe(4);
  });

  it('start() records primary model usability and alerts on unusable primary model', async () => {
    const agentConfig = mockConfig as typeof mockConfig & {
      agentProvider?: string;
      agentProviderConfig?: Record<string, unknown>;
    };
    agentConfig.agentProvider = 'claude-cli';
    agentConfig.agentProviderConfig = { apiKeyService: 'do-not-log-this' };
    mockProbePrimaryModelUsability.mockResolvedValueOnce({
      status: 'model-unavailable',
      provider: 'claude-cli',
      model: 'configured-primary',
      reason: 'selected-model-rejected',
    });

    const runtime = new AgentRuntime(makeDb(), makeMessenger().messenger, 'test', {
      model: 'configured-primary',
    });
    await runtime.start();

    await vi.waitFor(() => {
      expect(mockProbePrimaryModelUsability).toHaveBeenCalledWith(
        { provider: 'claude-cli', model: 'configured-primary' },
        {},
      );
    });

    await vi.waitFor(() => {
      expect(runtime.getFallbackState().primaryModelUsability).toMatchObject({
        status: 'model-unavailable',
        provider: 'claude-cli',
        model: 'configured-primary',
        reason: 'selected-model-rejected',
        probeInFlight: false,
      });
    });
    expect(mockEmitAlert).toHaveBeenCalledWith(
      'test',
      'primary_model_unusable',
      'Primary model usability probe failed',
      expect.stringContaining('status=model-unavailable'),
      'warning',
    );
    const evidence = mockEmitAlert.mock.calls.find((call) => call[1] === 'primary_model_unusable')?.[3] as string;
    expect(evidence).toContain('provider=claude-cli');
    expect(evidence).toContain('model=configured-primary');
    expect(evidence).not.toContain('do-not-log-this');
  });

  it('applies outbound status routing config when creating queues', () => {
    mockConfig.toolUpdateMode = 'friendly';
    mockConfig.toolUpdateRedirectJid = 'status-log@g.us';
    mockConfig.textAggregateDelayMs = 30_000;
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);

    const queue = (runtime as unknown as {
      createOutboundQueue(chatJid: string, reason: string): typeof mockQueue;
    }).createOutboundQueue('15550100001@s.whatsapp.net', 'unit test');

    expect(queue).toBe(mockQueue);
    expect(mockQueue.setToolUpdateMode).toHaveBeenCalledWith('friendly');
    expect(mockQueue.setToolUpdateRedirectJid).toHaveBeenCalledWith('status-log@g.us');
    expect(mockQueue.setTextAggregateDelayMs).toHaveBeenCalledWith(30_000);
  });

  it('start() calls ensurePermissionsSettings with agent type', async () => {
    const { ensurePermissionsSettings } = await import('../../../src/core/workspace.ts');
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();

    expect(ensurePermissionsSettings).toHaveBeenCalledWith(
      expect.stringContaining('.claude'),
      'agent',
      undefined, // no enabledPlugins configured
      { hasSandbox: false }, // no sandbox config → reconciler strips any orphaned sandbox hook
    );
  });

  it('start() also reconciles the user-level ~/.claude orphan when cwd != home', async () => {
    const { ensurePermissionsSettings } = await import('../../../src/core/workspace.ts');
    const { homedir } = await import('node:os');
    const { join } = await import('node:path');
    const db = makeDb();
    const { messenger } = makeMessenger();

    // cwd != home: the agent-sandbox hook in user-level ~/.claude is cwd-independent
    // (applies to every session) and is NOT covered by reconciling the cwd-derived dir.
    const runtime = new AgentRuntime(db, messenger, 'test', { cwd: '/tmp/whatsoup-non-home-cwd' });
    await runtime.start();

    expect(ensurePermissionsSettings).toHaveBeenCalledWith(
      join(homedir(), '.claude'),
      'agent',
      undefined,
      { hasSandbox: false },
    );
  });

  it('handleMessage ignores null content', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: null }));

    expect(mockSession.sendTurn).not.toHaveBeenCalled();
  });

  it('handleMessage ignores empty content', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: '   ' }));

    expect(mockSession.sendTurn).not.toHaveBeenCalled();
  });

  it('forwards allowM365Mutations into created sessions', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { allowM365Mutations: true });

    await runtime.start();
    await sendAndDrain(runtime, makeMsg({ content: 'hello claude' }));

    expect(capturedSessionManagerOptsRef.current).toMatchObject({
      allowM365Mutations: true,
    });
  });

  it('auto-compacts silently and advances baseline only after compact_boundary', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { autoCompactInputTokens: 100 });
    mockSession.getStatus.mockReturnValue({
      active: true,
      pid: 123,
      sessionId: 'session-1',
      startedAt: '2026-05-18T00:00:00.000Z',
      messageCount: 1,
      lastMessageAt: null,
    });
    mockSession.getDbRowId.mockReturnValue(42);
    mockGetSessionTokenSnapshot
      .mockReturnValueOnce({
        totalInputTokens: 250,
        totalOutputTokens: 5,
        lastCompactInputTokens: 100,
        lastCompactOutputTokens: 0,
      })
      .mockReturnValue({
        totalInputTokens: 260,
        totalOutputTokens: 6,
        lastCompactInputTokens: 260,
        lastCompactOutputTokens: 6,
      });

    await runtime.start();
    await sendAndDrain(runtime, makeMsg({ content: 'hello' }));
    capturedOnEventRef.current?.({ type: 'result', text: null, inputTokens: 250, outputTokens: 5 });
    await Promise.resolve();

    expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');

    // Emit the SDK's compact_boundary first, then the terminating result.
    capturedOnEventRef.current?.({ type: 'compact_boundary' });
    capturedOnEventRef.current?.({ type: 'result', text: null, inputTokens: 10, outputTokens: 1 });

    expect(mockMarkSessionCompacted).toHaveBeenCalledWith(db, 42);
    expect(mockMarkSessionCompacted).toHaveBeenCalledTimes(1);
    expect(mockQueue.enqueueResultText).not.toHaveBeenCalled();
  });

  it('does not advance the baseline when the auto-compact result arrives without a compact_boundary', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { autoCompactInputTokens: 100 });
    mockSession.getStatus.mockReturnValue({
      active: true,
      pid: 123,
      sessionId: 'session-1',
      startedAt: '2026-05-18T00:00:00.000Z',
      messageCount: 1,
      lastMessageAt: null,
    });
    mockSession.getDbRowId.mockReturnValue(42);
    mockGetSessionTokenSnapshot.mockReturnValue({
      totalInputTokens: 250,
      totalOutputTokens: 5,
      lastCompactInputTokens: 100,
      lastCompactOutputTokens: 0,
    });

    await runtime.start();
    await sendAndDrain(runtime, makeMsg({ content: 'hello' }));
    capturedOnEventRef.current?.({ type: 'result', text: null, inputTokens: 250, outputTokens: 5 });
    await Promise.resolve();

    expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');

    // No compact_boundary — only a terminating result (failed compact case).
    capturedOnEventRef.current?.({ type: 'result', text: null, inputTokens: 10, outputTokens: 1 });

    expect(mockMarkSessionCompacted).not.toHaveBeenCalled();

    mockSession.sendTurn.mockClear();
    await emitAgentResult(200);
    expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');
  });

  it('initialises baseline silently for existing sessions already over threshold (no compact storm on rollout)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { autoCompactInputTokens: 100 });
    mockSession.getStatus.mockReturnValue({
      active: true,
      pid: 123,
      sessionId: 'session-1',
      startedAt: '2026-05-18T00:00:00.000Z',
      messageCount: 1,
      lastMessageAt: null,
    });
    mockSession.getDbRowId.mockReturnValue(42);
    // lastCompactInputTokens=0 + totalInputTokens past threshold = bootstrap path
    mockGetSessionTokenSnapshot.mockReturnValue({
      totalInputTokens: 5_000_000,
      totalOutputTokens: 1000,
      lastCompactInputTokens: 0,
      lastCompactOutputTokens: 0,
    });

    await runtime.start();
    await sendAndDrain(runtime, makeMsg({ content: 'hello' }));
    capturedOnEventRef.current?.({ type: 'result', text: null, inputTokens: 5_000_000, outputTokens: 1000 });
    await Promise.resolve();

    // Baseline initialised silently; /compact never fired on the agent.
    expect(mockMarkSessionCompacted).toHaveBeenCalledWith(db, 42);
    expect(mockMarkSessionCompacted).toHaveBeenCalledTimes(1);
    expect(mockSession.sendTurn).not.toHaveBeenCalledWith('/compact');
  });

  it('persists baseline on crash cleanup when compact_boundary was observed before the crash', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { autoCompactInputTokens: 100 });
    const scopeKey = 'test@s.whatsapp.net';
    (runtime as unknown as { autoCompact: AutoCompactView }).autoCompact.compactBoundaryScopes.add(scopeKey);

    (runtime as unknown as {
      persistBaselineIfBoundaryObserved: (k: string, r: number | null) => void;
    }).persistBaselineIfBoundaryObserved(scopeKey, 42);

    expect(mockMarkSessionCompacted).toHaveBeenCalledWith(db, 42);
    expect(mockMarkSessionCompacted).toHaveBeenCalledTimes(1);
    const state = runtime as unknown as {
      autoCompact: AutoCompactView;
    };
    expect(state.autoCompact.cooldownUntil.has(scopeKey)).toBe(true);
    expect(state.autoCompact.measureNextTurn.has(scopeKey)).toBe(true);
  });

  it('does not persist baseline on crash cleanup when no compact_boundary was observed', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { autoCompactInputTokens: 100 });
    const scopeKey = 'test@s.whatsapp.net';

    (runtime as unknown as {
      persistBaselineIfBoundaryObserved: (k: string, r: number | null) => void;
    }).persistBaselineIfBoundaryObserved(scopeKey, 42);

    expect(mockMarkSessionCompacted).not.toHaveBeenCalled();
  });

  it('does not persist baseline on crash cleanup when rowId is null even if boundary was observed', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { autoCompactInputTokens: 100 });
    const scopeKey = 'test@s.whatsapp.net';
    (runtime as unknown as { autoCompact: AutoCompactView }).autoCompact.compactBoundaryScopes.add(scopeKey);

    (runtime as unknown as {
      persistBaselineIfBoundaryObserved: (k: string, r: number | null) => void;
    }).persistBaselineIfBoundaryObserved(scopeKey, null);

    expect(mockMarkSessionCompacted).not.toHaveBeenCalled();
  });

  it('cleans up auto-compact rapid-rearm state with per-chat session state', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat', autoCompactInputTokens: 100 });
    const mapKey = 'chat-a@s.whatsapp.net';
    const state = runtime as unknown as {
      autoCompact: AutoCompactView;
      cleanupPerChatState: (k: string) => void;
    };

    state.autoCompact.lastSuccessAt.set(mapKey, 100);
    state.autoCompact.rapidRearmRecordedForSuccessAt.set(mapKey, 100);
    state.autoCompact.consecutiveRapidRearms.set(mapKey, 2);
    state.autoCompact.measureNextTurn.add(mapKey);

    state.cleanupPerChatState(mapKey);

    expect(state.autoCompact.lastSuccessAt.has(mapKey)).toBe(false);
    expect(state.autoCompact.rapidRearmRecordedForSuccessAt.has(mapKey)).toBe(false);
    expect(state.autoCompact.consecutiveRapidRearms.has(mapKey)).toBe(false);
    expect(state.autoCompact.measureNextTurn.has(mapKey)).toBe(false);
  });

  it('initialises baseline at the exact threshold boundary (>= not >)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { autoCompactInputTokens: 100 });
    mockSession.getStatus.mockReturnValue({
      active: true,
      pid: 123,
      sessionId: 'session-1',
      startedAt: '2026-05-18T00:00:00.000Z',
      messageCount: 1,
      lastMessageAt: null,
    });
    mockSession.getDbRowId.mockReturnValue(42);
    // total === threshold exactly: bootstrap MUST trigger; pre-fix used > and missed this case.
    mockGetSessionTokenSnapshot.mockReturnValue({
      totalInputTokens: 100,
      totalOutputTokens: 0,
      lastCompactInputTokens: 0,
      lastCompactOutputTokens: 0,
    });

    await runtime.start();
    await sendAndDrain(runtime, makeMsg({ content: 'hello' }));
    capturedOnEventRef.current?.({ type: 'result', text: null, inputTokens: 100, outputTokens: 0 });
    await Promise.resolve();

    expect(mockMarkSessionCompacted).toHaveBeenCalledWith(db, 42);
    expect(mockSession.sendTurn).not.toHaveBeenCalledWith('/compact');
  });

  // ── QR-105: auto-compact must be provider-gated (/compact is claude-cli only) ──

  it('QR-105: does NOT fire /compact when the session provider is not claude-cli', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { autoCompactInputTokens: 100 });
    mockSession.getProviderId.mockReturnValue('codex-cli');
    mockSession.getStatus.mockReturnValue({
      active: true, pid: 123, sessionId: 'session-1',
      startedAt: '2026-05-18T00:00:00.000Z', messageCount: 1, lastMessageAt: null,
    });
    mockSession.getDbRowId.mockReturnValue(42);
    // Well over threshold, lastCompactInputTokens > 0 (not the bootstrap path) — a
    // claude-cli session here WOULD fire /compact.
    mockGetSessionTokenSnapshot.mockReturnValue({
      totalInputTokens: 5_000, totalOutputTokens: 10,
      lastCompactInputTokens: 100, lastCompactOutputTokens: 0,
    });

    (runtime as unknown as {
      maybeStartAutoCompact: (s: typeof mockSession, k?: string) => void;
    }).maybeStartAutoCompact(mockSession, 'test@s.whatsapp.net');

    // Gated out: no /compact sent, and the counter is NOT advanced (no false success).
    expect(mockSession.sendTurn).not.toHaveBeenCalledWith('/compact');
    expect(mockMarkSessionCompacted).not.toHaveBeenCalled();
  });

  it('QR-105: DOES fire /compact for a claude-cli session over threshold (gate does not regress the happy path)', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { autoCompactInputTokens: 100 });
    mockSession.getProviderId.mockReturnValue('claude-cli');
    mockSession.getStatus.mockReturnValue({
      active: true, pid: 123, sessionId: 'session-1',
      startedAt: '2026-05-18T00:00:00.000Z', messageCount: 1, lastMessageAt: null,
    });
    mockSession.getDbRowId.mockReturnValue(42);
    mockGetSessionTokenSnapshot.mockReturnValue({
      totalInputTokens: 5_000, totalOutputTokens: 10,
      lastCompactInputTokens: 100, lastCompactOutputTokens: 0,
    });

    (runtime as unknown as {
      maybeStartAutoCompact: (s: typeof mockSession, k?: string) => void;
    }).maybeStartAutoCompact(mockSession, 'test@s.whatsapp.net');

    expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');
  });

  it('waits for an in-flight auto-compact before sending the next turn', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { autoCompactInputTokens: 100 });
    mockSession.getStatus.mockReturnValue({
      active: true,
      pid: 123,
      sessionId: 'session-1',
      startedAt: '2026-05-18T00:00:00.000Z',
      messageCount: 1,
      lastMessageAt: null,
    });
    mockSession.getDbRowId.mockReturnValue(42);
    mockGetSessionTokenSnapshot
      .mockReturnValueOnce({
        totalInputTokens: 250,
        totalOutputTokens: 5,
        lastCompactInputTokens: 100,
        lastCompactOutputTokens: 0,
      })
      .mockReturnValue({
        totalInputTokens: 260,
        totalOutputTokens: 6,
        lastCompactInputTokens: 260,
        lastCompactOutputTokens: 6,
      });

    await runtime.start();
    await sendAndDrain(runtime, makeMsg({ content: 'hello' }));
    capturedOnEventRef.current?.({ type: 'result', text: null, inputTokens: 250, outputTokens: 5 });
    await Promise.resolve();

    expect(mockSession.sendTurn).toHaveBeenNthCalledWith(1, 'hello');
    expect(mockSession.sendTurn).toHaveBeenNthCalledWith(2, '/compact');

    const followUp = sendAndDrain(runtime, makeMsg({ content: 'follow-up' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(mockSession.sendTurn).toHaveBeenCalledTimes(2);

    capturedOnEventRef.current?.({ type: 'compact_boundary' });
    capturedOnEventRef.current?.({ type: 'result', text: null, inputTokens: 10, outputTokens: 1 });
    await followUp;

    expect(mockSession.sendTurn).toHaveBeenNthCalledWith(3, 'follow-up');
  });

  it('clears auto-compact bookkeeping when the compact send fails immediately', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { autoCompactInputTokens: 100 });
    const state = runtime as unknown as {
      autoCompact: AutoCompactView;
      pendingSystemResults: { counts: Map<string, number> };
    };
    const globalScope = '__global__';
    mockActiveAgentSession();
    mockTokenSnapshot(250, 100);
    mockSession.sendTurn
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('compact stdin closed'));

    await runtime.start();
    await sendAndDrain(runtime, makeMsg({ content: 'hello' }));
    await emitAgentResult(150);

    expect(mockSession.sendTurn).toHaveBeenNthCalledWith(2, '/compact');
    await Promise.resolve();
    await Promise.resolve();

    expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        rowId: 42,
        scopeKey: globalScope,
      }),
      'auto compact send failed',
    );
    expect(state.pendingSystemResults.counts.get(globalScope) ?? 0).toBe(0);
    expect(state.autoCompact.waiters.has(globalScope)).toBe(false);
    expect(state.autoCompact.silentCompactScopes.has(globalScope)).toBe(false);

    mockSession.sendTurn.mockClear();
    mockSession.sendTurn.mockResolvedValue(undefined);
    await emitAgentResult(200);

    expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');
  });

  it('does not retry auto-compact within the cooldown window after a timeout', async () => {
    vi.useFakeTimers();
    try {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { autoCompactInputTokens: 100 });
      mockSession.getStatus.mockReturnValue({
        active: true,
        pid: 123,
        sessionId: 'session-1',
        startedAt: '2026-05-18T00:00:00.000Z',
        messageCount: 1,
        lastMessageAt: null,
      });
      mockSession.getDbRowId.mockReturnValue(42);
      // lastCompactInputTokens > 0 so the rollout-bootstrap path does not
      // kick in for this scenario; we want to exercise the cooldown branch
      // after a real /compact attempt times out.
      mockGetSessionTokenSnapshot.mockReturnValue({
        totalInputTokens: 250,
        totalOutputTokens: 5,
        lastCompactInputTokens: 100,
        lastCompactOutputTokens: 0,
      });

      await runtime.start();
      await sendAndDrain(runtime, makeMsg({ content: 'hello' }));
      capturedOnEventRef.current?.({ type: 'result', text: null, inputTokens: 250, outputTokens: 5 });
      await Promise.resolve();

      expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');

      // Advance past the 4-minute compact timeout - no compact_boundary event arrived.
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000 + 100);

      // A subsequent result event would normally trigger maybeStartAutoCompact again.
      // While the post-timeout backoff is active, /compact must NOT be re-sent.
      mockSession.sendTurn.mockClear();
      capturedOnEventRef.current?.({ type: 'result', text: null, inputTokens: 200, outputTokens: 10 });
      await Promise.resolve();

      expect(mockSession.sendTurn).not.toHaveBeenCalledWith('/compact');

      // Once the (now shorter) 5-minute backoff elapses, auto-compact may retry —
      // bounding how far a stuck session grows between attempts instead of
      // degrading for a long window.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);
      mockSession.sendTurn.mockClear();
      capturedOnEventRef.current?.({ type: 'result', text: null, inputTokens: 200, outputTokens: 10 });
      await Promise.resolve();

      expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not re-arm auto-compact immediately after a successful compact in single mode', async () => {
    vi.useFakeTimers();
    try {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { autoCompactInputTokens: 100 });
      mockActiveAgentSession();
      mockTokenSnapshot(250, 100);

      await runtime.start();
      await sendAndDrain(runtime, makeMsg({ content: 'hello' }));
      await emitAgentResult(150);
      expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');

      await emitSuccessfulCompactResult();

      mockSession.sendTurn.mockClear();
      mockTokenSnapshot(600, 250);
      await emitAgentResult(350);

      expect(mockSession.sendTurn).not.toHaveBeenCalledWith('/compact');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not re-arm auto-compact immediately after a successful compact in per-chat mode', async () => {
    vi.useFakeTimers();
    try {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', {
        sessionScope: 'per_chat',
        autoCompactInputTokens: 100,
      });
      mockActiveAgentSession();
      mockTokenSnapshot(250, 100);

      await runtime.start();
      await sendAndDrain(runtime, makeMsg({ chatJid: 'chat-a@s.whatsapp.net', senderJid: 'chat-a@s.whatsapp.net', content: 'hello' }));
      await emitAgentResult(150);
      expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');

      await emitSuccessfulCompactResult();

      mockSession.sendTurn.mockClear();
      mockTokenSnapshot(600, 250);
      await emitAgentResult(350);

      expect(mockSession.sendTurn).not.toHaveBeenCalledWith('/compact');
    } finally {
      vi.useRealTimers();
    }
  });

  it('escalates auto-compact cooldown tiers on consecutive rapid re-arms', async () => {
    vi.useFakeTimers();
    try {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { autoCompactInputTokens: 100 });
      mockActiveAgentSession();

      await runtime.start();
      await sendAndDrain(runtime, makeMsg({ content: 'hello' }));

      const triggerCompact = async (totalInputTokens: number, lastCompactInputTokens: number) => {
        mockSession.sendTurn.mockClear();
        mockTokenSnapshot(totalInputTokens, lastCompactInputTokens);
        await emitAgentResult(totalInputTokens - lastCompactInputTokens);
        expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');
        await emitSuccessfulCompactResult();
      };

      const triggerRapidRearm = async (totalInputTokens: number, lastCompactInputTokens: number) => {
        mockSession.sendTurn.mockClear();
        mockTokenSnapshot(totalInputTokens, lastCompactInputTokens);
        await emitAgentResult(totalInputTokens - lastCompactInputTokens);
        expect(mockSession.sendTurn).not.toHaveBeenCalledWith('/compact');
      };

      await triggerCompact(250, 100);
      await triggerRapidRearm(600, 250);
      expect(runtime.getHealthSnapshot().details.autoCompactIneffective).toBe(1);
      expect(runtime.getHealthSnapshot().details.autoCompactConsecutiveRapidRearmsMax).toBe(1);

      await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
      mockSession.sendTurn.mockClear();
      mockTokenSnapshot(650, 250);
      await emitAgentResult(400);
      expect(mockSession.sendTurn).not.toHaveBeenCalledWith('/compact');

      await vi.advanceTimersByTimeAsync(9 * 60 * 1000 + 100);
      await triggerCompact(700, 250);
      await triggerRapidRearm(1_100, 700);
      expect(runtime.getHealthSnapshot().details.autoCompactIneffective).toBe(2);
      expect(runtime.getHealthSnapshot().details.autoCompactConsecutiveRapidRearmsMax).toBe(2);

      await vi.advanceTimersByTimeAsync(16 * 60 * 1000);
      mockSession.sendTurn.mockClear();
      mockTokenSnapshot(1_200, 700);
      await emitAgentResult(500);
      expect(mockSession.sendTurn).not.toHaveBeenCalledWith('/compact');

      await vi.advanceTimersByTimeAsync(14 * 60 * 1000 + 100);
      await triggerCompact(1_300, 700);
      await triggerRapidRearm(1_700, 1_300);
      expect(runtime.getHealthSnapshot().details.autoCompactIneffective).toBe(3);
      expect(runtime.getHealthSnapshot().details.autoCompactConsecutiveRapidRearmsMax).toBe(3);

      await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
      mockSession.sendTurn.mockClear();
      mockTokenSnapshot(1_800, 1_300);
      await emitAgentResult(500);
      expect(mockSession.sendTurn).not.toHaveBeenCalledWith('/compact');
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets rapid-rearm escalation after a recovered compact cycle', async () => {
    vi.useFakeTimers();
    try {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { autoCompactInputTokens: 100 });
      mockActiveAgentSession();

      await runtime.start();
      await sendAndDrain(runtime, makeMsg({ content: 'hello' }));

      mockTokenSnapshot(250, 100);
      await emitAgentResult(150);
      expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');
      await emitSuccessfulCompactResult();

      mockSession.sendTurn.mockClear();
      mockTokenSnapshot(600, 250);
      await emitAgentResult(350);
      expect(mockSession.sendTurn).not.toHaveBeenCalledWith('/compact');
      expect(runtime.getHealthSnapshot().details.autoCompactConsecutiveRapidRearmsMax).toBe(1);

      await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 100);
      mockSession.sendTurn.mockClear();
      mockTokenSnapshot(700, 250);
      await emitAgentResult(450);
      expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');
      await emitSuccessfulCompactResult();

      await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
      mockSession.sendTurn.mockClear();
      mockTokenSnapshot(900, 700);
      await emitAgentResult(200);
      expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');
      await emitSuccessfulCompactResult();

      mockSession.sendTurn.mockClear();
      mockTokenSnapshot(1_200, 900);
      await emitAgentResult(300);
      expect(mockSession.sendTurn).not.toHaveBeenCalledWith('/compact');

      await vi.advanceTimersByTimeAsync(16 * 60 * 1000);
      mockSession.sendTurn.mockClear();
      mockTokenSnapshot(1_300, 900);
      await emitAgentResult(400);
      expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts only the first real high-input turn after a successful compact', async () => {
    vi.useFakeTimers();
    try {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { autoCompactInputTokens: 100 });
      mockActiveAgentSession();

      await runtime.start();
      await sendAndDrain(runtime, makeMsg({ content: 'hello' }));
      mockTokenSnapshot(250, 100);
      await emitAgentResult(150);
      expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');

      await emitSuccessfulCompactResult(250);
      expect(runtime.getHealthSnapshot().details.autoCompactNextTurnOverThreshold).toBe(0);

      await sendAndDrain(runtime, makeMsg({ content: 'large follow-up' }));
      await emitAgentResult(250, 'ok');
      expect(runtime.getHealthSnapshot().details.autoCompactNextTurnOverThreshold).toBe(1);
      expect(runtime.getHealthSnapshot().details.autoCompactIneffective).toBe(1);

      await emitAgentResult(250, 'still ok');
      expect(runtime.getHealthSnapshot().details.autoCompactNextTurnOverThreshold).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses token_usage events for next-turn measurement when result has no token counts', async () => {
    vi.useFakeTimers();
    try {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { autoCompactInputTokens: 100 });
      mockActiveAgentSession();

      await runtime.start();
      await sendAndDrain(runtime, makeMsg({ content: 'hello' }));
      mockTokenSnapshot(250, 100);
      await emitAgentResult(150);
      expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');

      await emitSuccessfulCompactResult();
      expect(runtime.getHealthSnapshot().details.autoCompactNextTurnOverThreshold).toBe(0);

      await sendAndDrain(runtime, makeMsg({ content: 'large codex follow-up' }));
      await emitTokenUsage(250);
      await emitAgentResultWithoutTokens('ok');

      expect(runtime.getHealthSnapshot().details.autoCompactNextTurnOverThreshold).toBe(1);
      expect(runtime.getHealthSnapshot().details.autoCompactIneffective).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not count single-session system-turn token_usage as the first post-compact user turn', async () => {
    vi.useFakeTimers();
    try {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { autoCompactInputTokens: 100 });
      const state = runtime as unknown as {
        pendingSystemResults: { counts: Map<string, number> };
        autoCompact: AutoCompactView;
      };
      const globalKey = '__global__';
      mockActiveAgentSession();

      await runtime.start();
      await sendAndDrain(runtime, makeMsg({ content: 'hello' }));
      mockTokenSnapshot(250, 100);
      await emitAgentResult(150);
      await emitSuccessfulCompactResult();

      state.pendingSystemResults.counts.set(globalKey, 1);
      await emitTokenUsage(250);
      expect(runtime.getHealthSnapshot().details.autoCompactNextTurnOverThreshold).toBe(0);
      expect(state.autoCompact.measureNextTurn.has(globalKey)).toBe(true);

      state.pendingSystemResults.counts.delete(globalKey);
      await emitTokenUsage(250);
      expect(runtime.getHealthSnapshot().details.autoCompactNextTurnOverThreshold).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not count per-chat system-turn token_usage as the first post-compact user turn', async () => {
    vi.useFakeTimers();
    try {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', {
        sessionScope: 'per_chat',
        autoCompactInputTokens: 100,
      });
      const chatJid = 'chat-a@s.whatsapp.net';
      const state = runtime as unknown as {
        pendingSystemResults: { counts: Map<string, number> };
        autoCompact: AutoCompactView;
      };
      mockActiveAgentSession();

      await runtime.start();
      await sendAndDrain(runtime, makeMsg({ chatJid, senderJid: chatJid, content: 'hello' }));
      mockTokenSnapshot(250, 100);
      await emitAgentResult(150);
      await emitSuccessfulCompactResult();

      state.pendingSystemResults.counts.set(chatJid, 1);
      await emitTokenUsage(250);
      expect(runtime.getHealthSnapshot().details.autoCompactNextTurnOverThreshold).toBe(0);
      expect(state.autoCompact.measureNextTurn.has(chatJid)).toBe(true);

      state.pendingSystemResults.counts.delete(chatJid);
      await emitTokenUsage(250);
      expect(runtime.getHealthSnapshot().details.autoCompactNextTurnOverThreshold).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('forwards reply-guarantee instance and global MCP socket env into created sessions', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'line-a', { cwd: '/tmp/rgp-global' });

    await runtime.start();
    await sendAndDrain(runtime, makeMsg({ content: 'hello claude' }));

    expect(capturedSessionManagerOptsRef.current).toMatchObject({
      whatsoupInstance: 'line-a',
      whatsoupMcpSocket: '/tmp/rgp-global/.claude/whatsoup.sock',
    });
  });

  it('cleans up partial global MCP socket resources when startup fails', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const startErr = new Error('socket bind failed');
    mockSocketServerInstance.start.mockImplementationOnce(() => {
      throw startErr;
    });
    const runtime = new AgentRuntime(db, messenger, 'line-a', { cwd: '/tmp/rgp-global-fail' });

    await expect(runtime.start()).rejects.toThrow('socket bind failed');

    const state = runtime as unknown as {
      globalSocketServer: unknown;
      globalMcpSocketPath: string | null;
    };
    expect(mockSocketServerInstance.stop).toHaveBeenCalledTimes(1);
    expect(state.globalSocketServer).toBeNull();
    expect(state.globalMcpSocketPath).toBeNull();
    expect(mockRuntimeLogger.error).toHaveBeenCalledWith(
      { err: startErr, agentCwd: '/tmp/rgp-global-fail' },
      'failed to initialize global MCP socket resources',
    );
  });

  it('logs cleanup failures after global MCP socket startup errors', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const startErr = new Error('socket bind failed');
    const stopErr = new Error('socket cleanup failed');
    mockSocketServerInstance.start.mockImplementationOnce(() => {
      throw startErr;
    });
    mockSocketServerInstance.stop.mockImplementationOnce(() => {
      throw stopErr;
    });
    const runtime = new AgentRuntime(db, messenger, 'line-a', { cwd: '/tmp/rgp-global-stop-fail' });

    await expect(runtime.start()).rejects.toThrow('socket bind failed');

    const state = runtime as unknown as {
      globalSocketServer: unknown;
      globalMcpSocketPath: string | null;
    };
    expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
      { err: stopErr, agentCwd: '/tmp/rgp-global-stop-fail' },
      'failed to clean up global socket server after startup error',
    );
    expect(mockRuntimeLogger.error).toHaveBeenCalledWith(
      { err: startErr, agentCwd: '/tmp/rgp-global-stop-fail' },
      'failed to initialize global MCP socket resources',
    );
    expect(state.globalSocketServer).toBeNull();
    expect(state.globalMcpSocketPath).toBeNull();
    expect(mockSocketServerInstance.stop).toHaveBeenCalledTimes(1);
  });

  it('forwards configured system prompt into created sessions', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'line-a', {
      cwd: '/tmp/config-prompt',
      configSystemPrompt: 'Configured operator prompt.',
    });

    await runtime.start();
    await sendAndDrain(runtime, makeMsg({ content: 'hello claude' }));

    expect(capturedSessionManagerOptsRef.current).toMatchObject({
      configSystemPrompt: 'Configured operator prompt.',
    });
  });

  it('forwards reply-guarantee workspace socket env for sandbox per-chat sessions', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'line-a', {
      cwd: '/tmp/rgp-workspaces',
      sessionScope: 'per_chat',
      sandboxPerChat: true,
      sandbox: { allowedPaths: [], allowedTools: [], bash: { enabled: false } },
    });

    await runtime.start();
    await sendAndDrain(runtime, makeMsg({ content: 'hello claude' }));

    expect(capturedSessionManagerOptsRef.current).toMatchObject({
      whatsoupInstance: 'line-a',
      whatsoupMcpSocket: '/tmp/workspace/.claude/whatsoup.sock',
    });
  });

  it('arms and disarms reply guarantee around a non-shared turn', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'line-a', { cwd: '/tmp/rgp-turn' });
    const durability = {
      getInboundStatus: vi.fn(() => 'processing'),
      completeTurn: vi.fn(),
      markInboundFailed: vi.fn(),
    };
    const replyGuarantee = {
      arm: vi.fn(),
      disarm: vi.fn(),
      shutdown: vi.fn(),
      isArmed: vi.fn(() => false),
    };

    runtime.setDurability(durability as never);
    (runtime as unknown as { replyGuarantee: typeof replyGuarantee }).replyGuarantee = replyGuarantee;
    await runtime.start();
    await sendAndDrain(runtime, makeMsg({ content: 'hello claude', inboundSeq: 31 }));
    capturedOnEventRef.current?.({ type: 'result', text: 'done' });

    expect(replyGuarantee.arm).toHaveBeenCalledWith({
      inboundSeq: 31,
      chatJid: 'test@s.whatsapp.net',
    });
    expect(replyGuarantee.disarm).toHaveBeenCalledWith(31);
  });

  it('continues the agent turn when inline extraction hits a recoverable persistence error', async () => {
    const restoreMemory = setMockMemoryConfig();
    try {
      const db = makeDb();
      const raw = db.raw as unknown as { exec: ReturnType<typeof vi.fn> };
      raw.exec.mockImplementation((sql: string) => {
        if (sql === 'BEGIN') throw new Error('constraint failed');
      });
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'line-a');

      await runtime.start();
      await sendAndDrain(runtime, makeMsg({
        content: 'remind me to check backup status',
        senderJid: '15550100001@s.whatsapp.net',
      }));

      expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
        { err: expect.any(Error), messageId: 'msg-1' },
        'inline extractor hook failed (continuing)',
      );
      expect(mockEmitAlert).not.toHaveBeenCalledWith(
        'line-a',
        'substrate-inline-hook',
        expect.any(String),
        expect.any(String),
      );
      expect(mockSession.sendTurn).toHaveBeenCalledWith('remind me to check backup status');
    } finally {
      restoreMemory();
    }
  });

  it('alerts and marks inbound failed when inline extraction hits an unrecoverable DB error', async () => {
    const restoreMemory = setMockMemoryConfig();
    try {
      const db = makeDb();
      const raw = db.raw as unknown as { exec: ReturnType<typeof vi.fn> };
      const diskFull = Object.assign(new Error('SQLITE_FULL: database or disk is full'), {
        code: 'SQLITE_FULL',
      });
      raw.exec.mockImplementation((sql: string) => {
        if (sql === 'BEGIN') throw diskFull;
      });
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'line-a');
      const durability = {
        markInboundFailed: vi.fn(),
      };
      const replyGuarantee = {
        disarm: vi.fn(),
        isArmed: vi.fn(() => false),
      };
      const state = runtime as unknown as {
        durability: typeof durability;
        replyGuarantee: typeof replyGuarantee;
      };
      state.durability = durability;
      state.replyGuarantee = replyGuarantee;

      await runtime.start();
      await expect(runtime.handleMessage(makeMsg({
        content: 'remind me to inspect disk pressure',
        senderJid: '15550100001@s.whatsapp.net',
        inboundSeq: 42,
      }))).rejects.toThrow(/SQLITE_FULL/);

      expect(mockRuntimeLogger.error).toHaveBeenCalledWith(
        { err: diskFull, messageId: 'msg-1', code: 'SQLITE_FULL' },
        expect.stringContaining('inline extractor hook hit unrecoverable DB error'),
      );
      expect(mockEmitAlert).toHaveBeenCalledWith(
        'line-a',
        'substrate-inline-hook',
        expect.stringContaining('Unrecoverable DB error in inline extractor: SQLITE_FULL'),
        expect.stringContaining('messageId=msg-1 chatJid=test@s.whatsapp.net code=SQLITE_FULL'),
      );
      expect(replyGuarantee.disarm).toHaveBeenCalledWith(42);
      expect(durability.markInboundFailed).toHaveBeenCalledWith(42);
      expect(mockSession.sendTurn).not.toHaveBeenCalled();
    } finally {
      restoreMemory();
    }
  });

  it('handleMessage /new calls session.handleNew and notifies user', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await sendAndDrain(runtime, makeMsg({ content: '/new' }));

    expect(mockSession.handleNew).toHaveBeenCalled();
    const enqueuedTexts = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
    expect(enqueuedTexts.some((t) => t.includes('new session'))).toBe(true);
  });

  // QR-108: /new is a clean reset — it must drop the one-message-handoff latches
  // (standby notice + handoff artifact) for the conversation, else they leak into
  // the next reply/prelude (both keyed by the stable conversation_key). This
  // harness uses a mock db, so we assert /new issues the two DELETE statements
  // rather than round-tripping real rows.
  it('handleMessage /new clears the standby notice and handoff artifact for the chat', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    // Isolate /new's DB activity from setup/start().
    const prepareSpy = db.raw.prepare as unknown as { mock: { calls: unknown[][] }; mockClear: () => void };
    prepareSpy.mockClear();

    await sendAndDrain(runtime, makeMsg({ content: '/new' }));

    const sql = prepareSpy.mock.calls.map((c) => String(c[0]));
    expect(sql.some((s) => s.includes('DELETE FROM standby_notice'))).toBe(true);
    expect(sql.some((s) => s.includes('DELETE FROM agent_handoff_artifacts'))).toBe(true);
  });

  it('/new calls abortTurn() on the old queue before replacing it', async () => {
    // abortTurn() must fire BEFORE the new queue is created — it clears the typing
    // heartbeat interval and tool timers so the old session's state does not bleed
    // into the new one.
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    // First message seeds the queue
    await sendAndDrain(runtime, makeMsg({ content: 'start a turn' }));
    mockQueue.abortTurn.mockClear();

    await sendAndDrain(runtime, makeMsg({ content: '/new' }));

    expect(mockQueue.abortTurn).toHaveBeenCalledTimes(1);
  });

  it('/new clears single-session auto-compact state before replacing the session', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { autoCompactInputTokens: 100 });
    const state = runtime as unknown as {
      autoCompact: AutoCompactView;
    };
    const globalKey = '__global__';

    await runtime.start();
    state.autoCompact.cooldownUntil.set(globalKey, 1_700_000_900_000);
    state.autoCompact.lastSuccessAt.set(globalKey, 1_700_000_000_000);
    state.autoCompact.rapidRearmRecordedForSuccessAt.set(globalKey, 1_700_000_000_000);
    state.autoCompact.consecutiveRapidRearms.set(globalKey, 2);
    state.autoCompact.measureNextTurn.add(globalKey);

    await sendAndDrain(runtime, makeMsg({ content: '/new' }));

    expect(state.autoCompact.cooldownUntil.has(globalKey)).toBe(false);
    expect(state.autoCompact.lastSuccessAt.has(globalKey)).toBe(false);
    expect(state.autoCompact.rapidRearmRecordedForSuccessAt.has(globalKey)).toBe(false);
    expect(state.autoCompact.consecutiveRapidRearms.has(globalKey)).toBe(false);
    expect(state.autoCompact.measureNextTurn.has(globalKey)).toBe(false);
  });

  it('/kill-session clears single-session auto-compact state', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { autoCompactInputTokens: 100 });
    const state = runtime as unknown as {
      autoCompact: AutoCompactView;
    };
    const globalKey = '__global__';

    mockSession.getStatus.mockReturnValue({
      active: true,
      pid: 123,
      sessionId: 'ses_kill',
      startedAt: new Date().toISOString(),
      messageCount: 1,
      lastMessageAt: null,
    });
    await runtime.start();
    state.autoCompact.cooldownUntil.set(globalKey, 1_700_000_900_000);
    state.autoCompact.lastSuccessAt.set(globalKey, 1_700_000_000_000);
    state.autoCompact.rapidRearmRecordedForSuccessAt.set(globalKey, 1_700_000_000_000);
    state.autoCompact.consecutiveRapidRearms.set(globalKey, 2);
    state.autoCompact.measureNextTurn.add(globalKey);

    await sendAndDrain(runtime, makeMsg({
      content: '/kill-session 1',
      senderJid: '15550100001@s.whatsapp.net',
    }));

    expect(state.autoCompact.cooldownUntil.has(globalKey)).toBe(false);
    expect(state.autoCompact.lastSuccessAt.has(globalKey)).toBe(false);
    expect(state.autoCompact.rapidRearmRecordedForSuccessAt.has(globalKey)).toBe(false);
    expect(state.autoCompact.consecutiveRapidRearms.has(globalKey)).toBe(false);
    expect(state.autoCompact.measureNextTurn.has(globalKey)).toBe(false);
  });

  it('per_chat crash callbacks consume inbound seq, preserve replay text, clear dirty turn state, and notify the user', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    await runtime.start();

    const { durability } = attachRuntimeFaultMarkerSpies(runtime);

    await sendAndDrain(runtime, makeMsg({ content: 'hello', inboundSeq: 77 }));

    (runtime as unknown as { chatQueues: Map<string, typeof mockQueue> }).chatQueues.set('test@s.whatsapp.net', mockQueue);
    (runtime as unknown as { perChatInboundSeqQueue: Map<string, number[]> }).perChatInboundSeqQueue.set('test@s.whatsapp.net', [77]);
    (runtime as unknown as { pendingTurnText: Map<string, string> }).pendingTurnText.set('test@s.whatsapp.net', 'hello');
    (runtime as unknown as { perChatTurnContentType: Map<string, string | null> }).perChatTurnContentType.set('test@s.whatsapp.net', 'text');
    (runtime as unknown as { perChatTurnText: Map<string, string> }).perChatTurnText.set('test@s.whatsapp.net', 'partial');
    (runtime as unknown as { perChatAssistantItemText: Map<string, Map<number, string>> }).perChatAssistantItemText.set('test@s.whatsapp.net', new Map([[1, 'tool output']]));
    // Tool-scope keys are `${mapKey}#${ordinal}` — seed one for the crashing chat.
    (runtime as unknown as { activeToolNames: Map<string, Map<string, string>> }).activeToolNames.set('test@s.whatsapp.net#1', new Map([['tool-1', 'search_contacts']]));
    mockQueue.abortTurn.mockClear();
    mockQueue.enqueueText.mockClear();
    mockQueue.flush.mockClear();

    (runtime as unknown as {
      handlePerChatCrash: (
        mapKey: string,
        chatJid?: string,
        info?: { exitCode: number | null; signal: NodeJS.Signals | null; sessionId: string | null; dbRowId: number | null },
      ) => void;
    }).handlePerChatCrash('test@s.whatsapp.net', 'test@s.whatsapp.net', {
      exitCode: 1,
      signal: null,
      sessionId: 'opencode-cli-123',
      dbRowId: 42,
    });
    (runtime as unknown as {
      handleCrashNotify: (msg: string, chatJid?: string) => void;
    }).handleCrashNotify('Agent session ended (exited with code 1). Send any message to start a new session.', 'test@s.whatsapp.net');

    expect(mockQueue.abortTurn).toHaveBeenCalledTimes(1);
    expect((durability as { markContinuityCandidateIfNoTerminalOutbound: ReturnType<typeof vi.fn> }).markContinuityCandidateIfNoTerminalOutbound)
      .toHaveBeenCalledWith(77, 'runtime_fault_no_terminal_outbound', 'runtime_fault_disarm');
    expect((durability as { markInboundFailed: ReturnType<typeof vi.fn> }).markInboundFailed).toHaveBeenCalledWith(77);
    expect((runtime as unknown as { perChatInboundSeqQueue: Map<string, number[]> }).perChatInboundSeqQueue.get('test@s.whatsapp.net')).toEqual([]);
    expect((runtime as unknown as { pendingTurnText: Map<string, string> }).pendingTurnText.get('test@s.whatsapp.net')).toBe('hello');
    expect((runtime as unknown as { perChatTurnContentType: Map<string, string | null> }).perChatTurnContentType.has('test@s.whatsapp.net')).toBe(false);
    expect((runtime as unknown as { perChatTurnText: Map<string, string> }).perChatTurnText.has('test@s.whatsapp.net')).toBe(false);
    expect((runtime as unknown as { perChatAssistantItemText: Map<string, Map<number, string>> }).perChatAssistantItemText.has('test@s.whatsapp.net')).toBe(false);
    expect((runtime as unknown as { activeToolNames: Map<string, string> }).activeToolNames.size).toBe(0);
    expect(mockQueue.enqueueText).toHaveBeenCalledWith(expect.stringContaining('exited with code 1'));
    expect(mockQueue.flush).toHaveBeenCalledTimes(1);
  });

  // QR-103: a fallback replay must NOT fire when the turn already delivered a
  // visible reply — otherwise the user gets BOTH the primary streamed answer and
  // the backup answer (double-send). scheduleFallbackReplay must suppress the
  // replay when the turn produced visible output.
  {
    const makeActivation = () => ({
      primaryProvider: 'claude-cli', fallbackProvider: 'openai-api', fallbackModel: undefined,
      reason: 'usage-limit', resetAt: null, activeUntil: 0, extended: false,
      keyPresent: true, recoveryProbeRequired: false,
    });

    it('QR-103: single/shared — suppresses replay when a visible reply was already sent', () => {
      const runtime = new AgentRuntime(makeDb(), makeMessenger().messenger);
      const state = runtime as unknown as {
        currentTurnReplayText: string | null;
        turnHadVisibleOutput: boolean;
        scheduleFallbackReplay: (a: unknown) => boolean;
      };
      // A replay text exists (so the pre-fix code would pass the replayText gate
      // and dispatch), and a visible reply was already streamed this turn.
      state.currentTurnReplayText = 'original user question';
      state.turnHadVisibleOutput = true;

      const result = state.scheduleFallbackReplay({
        activation: makeActivation(), chatJid: 'test@s.whatsapp.net', oldSession: null, hadToolActivity: false,
      });

      expect(result).toBe(false); // suppressed — no second reply
    });

    it('QR-103: per_chat — suppresses replay when perChatTurnText holds a streamed reply', () => {
      const runtime = new AgentRuntime(makeDb(), makeMessenger().messenger, 'test', { sessionScope: 'per_chat' });
      const state = runtime as unknown as {
        perChatTurnText: Map<string, string>;
        pendingTurnText: Map<string, string>;
        scheduleFallbackReplay: (a: unknown) => boolean;
      };
      const mk = 'mk-1';
      state.perChatTurnText.set(mk, 'a streamed reply the user already saw');
      state.pendingTurnText.set(mk, 'original user question'); // replayText gate would pass

      const result = state.scheduleFallbackReplay({
        activation: makeActivation(), chatJid: 'test@s.whatsapp.net', mapKey: mk, oldSession: null, hadToolActivity: false,
      });

      expect(result).toBe(false);
    });
  }

  it('single-session crash callback marks runtime-fault continuity candidate before failing inbound', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    const { durability } = attachRuntimeFaultMarkerSpies(runtime);

    await runtime.start();
    await sendAndDrain(runtime, makeMsg({ content: 'hello', inboundSeq: 88 }));
    expect(capturedOnCrashRef.current).toBeTypeOf('function');

    capturedOnCrashRef.current!({
      exitCode: 1,
      signal: null,
      sessionId: 'opencode-cli-456',
      dbRowId: 43,
    });

    expect(durability.markContinuityCandidateIfNoTerminalOutbound)
      .toHaveBeenCalledWith(88, 'runtime_fault_no_terminal_outbound', 'runtime_fault_disarm');
    expect(durability.markInboundFailed).toHaveBeenCalledWith(88);
    expect((runtime as unknown as { currentInboundSeq: number | undefined }).currentInboundSeq).toBeUndefined();
  });

  it('tracks pending auto-respawn timers per crash and removes them after firing', async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const queue = makeQueueMock('chat-a@s.whatsapp.net');
      const session = {
        ...mockSession,
        spawnSession: vi.fn(async () => {}),
        getStatus: vi.fn(() => ({
          active: false,
          pid: null,
          sessionId: null,
          startedAt: null,
          messageCount: 0,
          lastMessageAt: null,
        })),
      };
      const runtimeState = runtime as unknown as {
        chatSessions: Map<string, typeof session>;
        chatQueues: Map<string, IOutboundQueue>;
        pendingRespawnTimers?: Set<ReturnType<typeof setTimeout>>;
        handlePerChatCrash: (
          mapKey: string,
          chatJid?: string,
          info?: { exitCode: number | null; signal: NodeJS.Signals | null; sessionId: string | null; dbRowId: number | null },
        ) => void;
      };

      runtimeState.chatSessions.set('chat-a', session);
      runtimeState.chatQueues.set('chat-a', queue);

      runtimeState.handlePerChatCrash('chat-a', 'chat-a@s.whatsapp.net', {
        exitCode: 1,
        signal: null,
        sessionId: 'sess-1',
        dbRowId: 42,
      });

      expect(runtimeState.pendingRespawnTimers?.size).toBe(1);

      await vi.advanceTimersByTimeAsync(1_500);

      expect(runtimeState.pendingRespawnTimers?.size ?? 0).toBe(0);
      expect(session.spawnSession).toHaveBeenCalledWith('sess-1', 42);
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('auto-respawn aborts when the crashed session is replaced before the timer fires', async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const queue = makeQueueMock('chat-replaced@s.whatsapp.net');
      const staleSession = {
        ...mockSession,
        spawnSession: vi.fn(async () => {}),
        sendTurn: vi.fn(),
        getStatus: vi.fn(() => ({
          active: false,
          pid: null,
          sessionId: 'stale-sess',
          startedAt: null,
          messageCount: 0,
          lastMessageAt: null,
        })),
      };
      const replacementSession = {
        ...mockSession,
        spawnSession: vi.fn(async () => {}),
        getStatus: vi.fn(() => ({
          active: false,
          pid: null,
          sessionId: 'replacement-sess',
          startedAt: null,
          messageCount: 0,
          lastMessageAt: null,
        })),
      };
      const state = runtime as unknown as {
        chatSessions: Map<string, typeof staleSession>;
        chatQueues: Map<string, IOutboundQueue>;
        injectMissedMessages: ReturnType<typeof vi.fn>;
        pendingSystemResults: { counts: Map<string, number> };
        handlePerChatCrash: (
          mapKey: string,
          chatJid?: string,
          info?: { exitCode: number | null; signal: NodeJS.Signals | null; sessionId: string | null; dbRowId: number | null },
        ) => void;
      };

      state.chatSessions.set('chat-replaced', staleSession);
      state.chatQueues.set('chat-replaced', queue);
      state.injectMissedMessages = vi.fn(async () => true);

      state.handlePerChatCrash('chat-replaced', 'chat-replaced@s.whatsapp.net', {
        exitCode: 1,
        signal: null,
        sessionId: 'stale-sess',
        dbRowId: 42,
      });

      state.chatSessions.set('chat-replaced', replacementSession);
      await vi.advanceTimersByTimeAsync(1_500);

      expect(staleSession.spawnSession).not.toHaveBeenCalled();
      expect(staleSession.sendTurn).not.toHaveBeenCalled();
      expect(state.injectMissedMessages).not.toHaveBeenCalled();
      expect(replacementSession.getStatus).not.toHaveBeenCalled();
      expect(state.pendingSystemResults.counts.get('chat-replaced') ?? 0).toBe(0);
      expect(mockRuntimeLogger.info).not.toHaveBeenCalledWith(
        expect.objectContaining({ mapKey: 'chat-replaced', sessionId: 'stale-sess' }),
        'auto-respawn: attempting resume',
      );
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('auto-respawn unmarks only the failed continuation after injecting missed messages', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T10:00:00Z'));
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const queue = makeQueueMock('chat-auto@s.whatsapp.net');
      const session = {
        ...mockSession,
        spawnSession: vi.fn(async () => {}),
        sendTurn: vi.fn().mockRejectedValueOnce(new Error('stdin closed after respawn')),
        getStatus: vi
          .fn()
          .mockReturnValueOnce({
            active: false,
            pid: null,
            sessionId: 'sess-auto',
            startedAt: null,
            messageCount: 0,
            lastMessageAt: null,
          })
          .mockReturnValue({
            active: true,
            pid: 123,
            sessionId: 'sess-auto',
            startedAt: new Date().toISOString(),
            messageCount: 1,
            lastMessageAt: null,
          }),
      };
      const state = runtime as unknown as {
        chatSessions: Map<string, typeof session>;
        chatQueues: Map<string, IOutboundQueue>;
        injectMissedMessages: ReturnType<typeof vi.fn>;
        pendingSystemResults: { counts: Map<string, number> };
        handlePerChatCrash: (
          mapKey: string,
          chatJid?: string,
          info?: { exitCode: number | null; signal: NodeJS.Signals | null; sessionId: string | null; dbRowId: number | null },
        ) => void;
      };

      state.chatSessions.set('chat-auto', session);
      state.chatQueues.set('chat-auto', queue);
      state.injectMissedMessages = vi.fn(async () => true);

      state.handlePerChatCrash('chat-auto', 'chat-auto@s.whatsapp.net', {
        exitCode: 1,
        signal: null,
        sessionId: 'sess-auto',
        dbRowId: 42,
      });

      await vi.advanceTimersByTimeAsync(2_500);

      expect(state.injectMissedMessages).toHaveBeenCalledWith(
        session,
        'chat-auto@s.whatsapp.net',
        Math.floor(new Date('2026-06-10T10:00:00Z').getTime() / 1000),
      );
      expect(session.sendTurn).toHaveBeenCalledWith(
        expect.stringContaining('session resumed after crash'),
      );
      expect(session.sendTurn).toHaveBeenCalledWith(
        expect.stringContaining('continue where you left off'),
      );
      expect(state.pendingSystemResults.counts.get('chat-auto') ?? 0).toBe(1);
      expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.any(Error),
          mapKey: 'chat-auto',
        }),
        'failed to send continuation turn after auto-respawn',
      );
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('tracks per-chat crash counts independently when scheduling auto-respawn', () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const makeSession = () => ({
        ...mockSession,
        spawnSession: vi.fn(async () => {}),
        getStatus: vi.fn(() => ({
          active: false,
          pid: null,
          sessionId: null,
          startedAt: null,
          messageCount: 0,
          lastMessageAt: null,
        })),
      });
      const runtimeState = runtime as unknown as {
        chatSessions: Map<string, ReturnType<typeof makeSession>>;
        chatQueues: Map<string, IOutboundQueue>;
        handlePerChatCrash: (
          mapKey: string,
          chatJid?: string,
          info?: { exitCode: number | null; signal: NodeJS.Signals | null; sessionId: string | null; dbRowId: number | null },
        ) => void;
      };

      runtimeState.chatSessions.set('chat-a', makeSession());
      runtimeState.chatSessions.set('chat-b', makeSession());
      runtimeState.chatSessions.set('chat-c', makeSession());
      runtimeState.chatQueues.set('chat-a', makeQueueMock('chat-a@s.whatsapp.net'));
      runtimeState.chatQueues.set('chat-b', makeQueueMock('chat-b@s.whatsapp.net'));
      runtimeState.chatQueues.set('chat-c', makeQueueMock('chat-c@s.whatsapp.net'));

      mockRuntimeLogger.info.mockClear();

      runtimeState.handlePerChatCrash('chat-a', 'chat-a@s.whatsapp.net', {
        exitCode: 1,
        signal: null,
        sessionId: 'sess-a',
        dbRowId: 1,
      });
      runtimeState.handlePerChatCrash('chat-b', 'chat-b@s.whatsapp.net', {
        exitCode: 1,
        signal: null,
        sessionId: 'sess-b',
        dbRowId: 2,
      });
      runtimeState.handlePerChatCrash('chat-c', 'chat-c@s.whatsapp.net', {
        exitCode: 1,
        signal: null,
        sessionId: 'sess-c',
        dbRowId: 3,
      });

      const attempts = mockRuntimeLogger.info.mock.calls
        .filter((call) => call[1] === 'scheduling auto-respawn')
        .map((call) => (call[0] as { attempt?: number }).attempt);

      expect(attempts).toEqual([1, 1, 1]);
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('chat A exhausting respawns does not block chat B auto-respawn', () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const makeSession = () => ({
        ...mockSession,
        spawnSession: vi.fn(async () => {}),
        getStatus: vi.fn(() => ({
          active: false,
          pid: null,
          sessionId: null,
          startedAt: null,
          messageCount: 0,
          lastMessageAt: null,
        })),
      });
      const runtimeState = runtime as unknown as {
        chatSessions: Map<string, ReturnType<typeof makeSession>>;
        chatQueues: Map<string, IOutboundQueue>;
        pendingRespawnTimers?: Set<ReturnType<typeof setTimeout>>;
        handlePerChatCrash: (
          mapKey: string,
          chatJid?: string,
          info?: { exitCode: number | null; signal: NodeJS.Signals | null; sessionId: string | null; dbRowId: number | null },
        ) => void;
      };

      runtimeState.chatSessions.set('chat-a', makeSession());
      runtimeState.chatSessions.set('chat-b', makeSession());
      runtimeState.chatQueues.set('chat-a', makeQueueMock('chat-a@s.whatsapp.net'));
      runtimeState.chatQueues.set('chat-b', makeQueueMock('chat-b@s.whatsapp.net'));

      runtimeState.handlePerChatCrash('chat-a', 'chat-a@s.whatsapp.net', {
        exitCode: 1,
        signal: null,
        sessionId: 'sess-a',
        dbRowId: 1,
      });
      runtimeState.handlePerChatCrash('chat-a', 'chat-a@s.whatsapp.net', {
        exitCode: 1,
        signal: null,
        sessionId: 'sess-a',
        dbRowId: 1,
      });
      runtimeState.handlePerChatCrash('chat-a', 'chat-a@s.whatsapp.net', {
        exitCode: 1,
        signal: null,
        sessionId: 'sess-a',
        dbRowId: 1,
      });
      runtimeState.handlePerChatCrash('chat-b', 'chat-b@s.whatsapp.net', {
        exitCode: 1,
        signal: null,
        sessionId: 'sess-b',
        dbRowId: 2,
      });

      expect(runtimeState.pendingRespawnTimers?.size).toBe(4);
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('startup proactive-resume notifyUser cleanup removes only the crashed chat state', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const state = runtime as unknown as PerChatCleanupRuntimeState & {
      chatSessions: Map<string, { getStatus: () => ReturnType<typeof mockSession.getStatus> }>;
      chatQueues: Map<string, IOutboundQueue>;
      durability: {
        getResumableCheckpoints: () => Array<{ conversation_key: string }>;
        getSessionCheckpoint: (key: string) => { session_id: string } | null;
      } | null;
    };
    const targetKey = '15550001111@lid';
    const otherKey = 'other@s.whatsapp.net';

    mockSession.spawnSession.mockImplementation(() => new Promise<void>(() => {}));
    state.durability = {
      getResumableCheckpoints: () => [{ conversation_key: '15550001111' }],
      getSessionCheckpoint: () => ({ session_id: 'resume-1' }),
    };

    await runtime.start();

    expect(capturedNotifyUserRef.current).toBeTypeOf('function');

    state.perChatInboundSeqQueue.set(targetKey, [1]);
    state.perChatTurnContentType.set(targetKey, 'text');
    state.perChatTurnText.set(targetKey, 'partial');
    state.perChatAssistantItemText.set(targetKey, new Map([['item-a', 'value-a']]));
    state.pendingTurnText.set(targetKey, 'pending');
    state.resumeFailedHandling.add(targetKey);

    state.chatSessions.set(otherKey, { getStatus: () => mockSession.getStatus() });
    state.chatQueues.set(otherKey, makeQueueMock(otherKey));
    state.perChatInboundSeqQueue.set(otherKey, [2]);
    state.perChatTurnContentType.set(otherKey, 'audio');
    state.perChatTurnText.set(otherKey, 'other');
    state.perChatAssistantItemText.set(otherKey, new Map([['item-b', 'value-b']]));
    state.pendingTurnText.set(otherKey, 'other-pending');
    state.resumeFailedHandling.add(otherKey);

    capturedNotifyUserRef.current?.('session crashed');

    expect(state.chatSessions.has(targetKey)).toBe(false);
    expect(state.chatQueues.has(targetKey)).toBe(false);
    expect(state.perChatInboundSeqQueue.has(targetKey)).toBe(false);
    expect(state.perChatTurnContentType.has(targetKey)).toBe(false);
    expect(state.perChatTurnText.has(targetKey)).toBe(false);
    expect(state.perChatAssistantItemText.has(targetKey)).toBe(false);
    expect(state.pendingTurnText.has(targetKey)).toBe(false);
    expect(state.resumeFailedHandling.has(targetKey)).toBe(false);

    expect(state.chatSessions.has(otherKey)).toBe(true);
    expect(state.chatQueues.has(otherKey)).toBe(true);
    expect(state.perChatInboundSeqQueue.get(otherKey)).toEqual([2]);
    expect(state.perChatTurnContentType.get(otherKey)).toBe('audio');
    expect(state.perChatTurnText.get(otherKey)).toBe('other');
    expect(state.perChatAssistantItemText.get(otherKey)?.get('item-b')).toBe('value-b');
    expect(state.pendingTurnText.get(otherKey)).toBe('other-pending');
    expect(state.resumeFailedHandling.has(otherKey)).toBe(true);
  });

  it('skips proactive resume on startup when proactiveResumeOnStartup is false', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    mockConfig.proactiveResumeOnStartup = false;
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const state = runtime as unknown as {
      durability: {
        getResumableCheckpoints: () => Array<{ conversation_key: string }>;
        getSessionCheckpoint: (key: string) => { session_id: string } | null;
      } | null;
    };
    // Both gates that the existing resume test relies on are satisfied (a
    // resumable checkpoint with a session_id exists); only the new gate is off.
    const getResumableCheckpoints = vi.fn(() => [{ conversation_key: '15550001111' }]);
    const getSessionCheckpoint = vi.fn(() => ({ session_id: 'resume-1' }));
    state.durability = { getResumableCheckpoints, getSessionCheckpoint };

    await runtime.start();

    // The gate short-circuits the whole resume branch: no notifyUser wired,
    // no session spawned, and the checkpoint scan is never even reached.
    expect(capturedNotifyUserRef.current).toBeNull();
    expect(mockSession.spawnSession).not.toHaveBeenCalled();
    expect(getSessionCheckpoint).not.toHaveBeenCalled();
    expect(getResumableCheckpoints).not.toHaveBeenCalled();
  });

  // QR-099: a conversation whose prior-instance child the startup sweep classified
  // authoritative_live (verified-live) must NOT also be proactively resumed — that
  // would spawn a SECOND session for one chat (duplicate turns/replies, contended
  // per-chat state). The in-loop chatSessions.has() guard can't see the prior-
  // instance child, so the sweep must record the live key and the resume loop skip it.
  it('does not proactively resume a conversation with an authoritative_live session (QR-099)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const { classifyActiveSessions: mockClassify } = await import('../../../src/runtimes/agent/session-classifier.ts');
    // Sweep leaves a verified-live child in place for this conversation_key.
    (mockClassify as ReturnType<typeof vi.fn>).mockReturnValueOnce([{
      id: 1, sessionId: 'sess-live', claudePid: process.pid,
      chatJid: null, conversationKey: '15550001111',
      status: 'active', classification: 'authoritative_live', reason: 'pid alive + checkpoint active',
    }]);

    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const state = runtime as unknown as {
      durability: {
        getResumableCheckpoints: () => Array<{ conversation_key: string }>;
        getSessionCheckpoint: (key: string) => { session_id: string } | null;
      } | null;
    };
    // Same key ALSO has a resumable checkpoint — the double-spawn precondition.
    state.durability = {
      getResumableCheckpoints: () => [{ conversation_key: '15550001111' }],
      getSessionCheckpoint: () => ({ session_id: 'resume-1' }),
    };

    await runtime.start();

    // The live child is left in place: no resume session is wired (notifyUser
    // stays unset) and — the load-bearing assertion — NO second session is
    // spawned for the already-live conversation.
    expect(capturedNotifyUserRef.current).toBeNull();
    expect(mockSession.spawnSession).not.toHaveBeenCalled();
  });

  it('sandbox per_chat notifyUser cleanup removes only the crashed workspace state', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', {
      sessionScope: 'per_chat',
      sandboxPerChat: true,
      cwd: '/agent/cwd',
    });
    const state = runtime as unknown as PerChatCleanupRuntimeState & {
      chatSessions: Map<string, { getStatus: () => ReturnType<typeof mockSession.getStatus> }>;
      chatQueues: Map<string, IOutboundQueue>;
    };
    const targetChatJid = '15550002222@s.whatsapp.net';
    const targetKey = '15550002222';
    const otherKey = '15550003333';

    await runtime.start();
    await sendAndDrain(runtime, makeMsg({ chatJid: targetChatJid, senderJid: targetChatJid, content: 'hello sandbox' }));

    expect(capturedNotifyUserRef.current).toBeTypeOf('function');

    state.perChatInboundSeqQueue.set(targetKey, [10]);
    state.perChatTurnContentType.set(targetKey, 'text');
    state.perChatTurnText.set(targetKey, 'target');
    state.perChatAssistantItemText.set(targetKey, new Map([['item-a', 'value-a']]));
    state.pendingTurnText.set(targetKey, 'pending-target');
    state.resumeFailedHandling.add(targetKey);

    state.chatSessions.set(otherKey, { getStatus: () => mockSession.getStatus() });
    state.chatQueues.set(otherKey, makeQueueMock(otherKey));
    state.perChatInboundSeqQueue.set(otherKey, [20]);
    state.perChatTurnContentType.set(otherKey, 'audio');
    state.perChatTurnText.set(otherKey, 'other');
    state.perChatAssistantItemText.set(otherKey, new Map([['item-b', 'value-b']]));
    state.pendingTurnText.set(otherKey, 'pending-other');
    state.resumeFailedHandling.add(otherKey);

    capturedNotifyUserRef.current?.('workspace crashed');

    expect(state.chatSessions.has(targetKey)).toBe(false);
    expect(state.chatQueues.has(targetKey)).toBe(false);
    expect(state.perChatInboundSeqQueue.has(targetKey)).toBe(false);
    expect(state.perChatTurnContentType.has(targetKey)).toBe(false);
    expect(state.perChatTurnText.has(targetKey)).toBe(false);
    expect(state.perChatAssistantItemText.has(targetKey)).toBe(false);
    expect(state.pendingTurnText.has(targetKey)).toBe(false);
    expect(state.resumeFailedHandling.has(targetKey)).toBe(false);

    expect(state.chatSessions.has(otherKey)).toBe(true);
    expect(state.chatQueues.has(otherKey)).toBe(true);
    expect(state.perChatInboundSeqQueue.get(otherKey)).toEqual([20]);
    expect(state.perChatTurnContentType.get(otherKey)).toBe('audio');
    expect(state.perChatTurnText.get(otherKey)).toBe('other');
    expect(state.perChatAssistantItemText.get(otherKey)?.get('item-b')).toBe('value-b');
    expect(state.pendingTurnText.get(otherKey)).toBe('pending-other');
    expect(state.resumeFailedHandling.has(otherKey)).toBe(true);
  });

  it('handleJidAliasChanged cleans the old key after migrating per-chat state', () => {
    vi.useFakeTimers();
    try {
      const canonicalJid = '15550004444@s.whatsapp.net';
      const db = makeDb();
      (db.raw.prepare as ReturnType<typeof vi.fn>).mockReturnValue({
        run: vi.fn(),
        get: vi.fn(() => ({ phone_jid: canonicalJid })),
      });
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const state = runtime as unknown as PerChatCleanupRuntimeState & {
        chatSessions: Map<string, { getStatus: () => ReturnType<typeof mockSession.getStatus> }>;
        chatQueues: Map<string, IOutboundQueue>;
      };
      const lidKey = '15550004444@lid';
      const sessionRef = { getStatus: () => mockSession.getStatus() };
      const queueRef = makeQueueMock(lidKey);
      const imageTimer = fakeTimerHandle('lid-image-coalesce');
      const pollSoftTimer = fakeTimerHandle('lid-poll-soft-expiry');
      const pollHardTimer = fakeTimerHandle('lid-poll-hard-expiry');

      state.chatSessions.set(lidKey, sessionRef);
      state.chatQueues.set(lidKey, queueRef);
      state.perChatInboundSeqQueue.set(lidKey, [4, 5]);
      state.perChatTurnContentType.set(lidKey, 'text');
      state.perChatTurnText.set(lidKey, 'reply');
      state.perChatAssistantItemText.set(lidKey, new Map([['item-1', 'chunk']]));
      state.pendingTurnText.set(lidKey, 'pending');
      state.crashes.record(lidKey); state.crashes.record(lidKey);
      state.resumeFailedHandling.add(lidKey);
      state.autoCompact.cooldownUntil.set(lidKey, 1_700_000_900_000);
      state.autoCompact.lastSuccessAt.set(lidKey, 1_700_000_000_000);
      state.autoCompact.rapidRearmRecordedForSuccessAt.set(lidKey, 1_700_000_000_000);
      state.autoCompact.consecutiveRapidRearms.set(lidKey, 2);
      state.autoCompact.measureNextTurn.add(lidKey);
      state.imageCoalesce.buffers.set(lidKey, {
        texts: ['image-a', 'image-b'],
        timer: imageTimer,
        msg: makeMsg({ chatJid: lidKey, contentType: 'image', inboundSeq: 6 }),
        inboundSeqs: [6, 7],
      });
      state.pendingPolls.questions.set(lidKey, {
        questions: [{
          question: 'Pick one',
          header: 'Alias',
          options: [
            { label: 'Node', description: 'Runtime' },
            { label: 'Go', description: 'Runtime' },
          ],
          multiSelect: false,
        }],
        toolId: 'tool-alias-poll',
        chatJid: lidKey,
        chatJidAliases: new Set([lidKey]),
        mode: 'poll',
        pollMessageIdToQuestionIndex: new Map([['POLL_ALIAS', 0]]),
        currentQuestionIndex: 0,
        answersCollected: {},
        createdAt: Date.now(),
        softExpiryTimer: pollSoftTimer,
        hardExpiryTimer: pollHardTimer,
        resolution: 'first-vote-wins',
        timeoutMs: 60_000,
        votesByQuestion: new Map(),
        adminJids: null,
        source: 'askuser',
        sentPollMessageIds: ['POLL_ALIAS'],
      });

      expect(() => runtime.handleJidAliasChanged('15550004444', canonicalJid)).not.toThrow();

      expect(state.chatSessions.get(canonicalJid)).toBe(sessionRef);
      expect(state.chatQueues.get(canonicalJid)).toBe(queueRef);
      expect(queueRef.updateDeliveryJid).toHaveBeenCalledWith(canonicalJid);
      expect(state.perChatInboundSeqQueue.get(canonicalJid)).toEqual([4, 5]);
      expect(state.perChatTurnContentType.get(canonicalJid)).toBe('text');
      expect(state.perChatTurnText.get(canonicalJid)).toBe('reply');
      expect(state.perChatAssistantItemText.get(canonicalJid)?.get('item-1')).toBe('chunk');
      expect(state.pendingTurnText.get(canonicalJid)).toBe('pending');
      expect(state.crashes.count(canonicalJid)).toBe(2);
      expect(state.resumeFailedHandling.has(canonicalJid)).toBe(true);
      expect(state.autoCompact.cooldownUntil.get(canonicalJid)).toBe(1_700_000_900_000);
      expect(state.autoCompact.lastSuccessAt.get(canonicalJid)).toBe(1_700_000_000_000);
      expect(state.autoCompact.rapidRearmRecordedForSuccessAt.get(canonicalJid)).toBe(1_700_000_000_000);
      expect(state.autoCompact.consecutiveRapidRearms.get(canonicalJid)).toBe(2);
      expect(state.autoCompact.measureNextTurn.has(canonicalJid)).toBe(true);
      expect(state.imageCoalesce.buffers.get(canonicalJid)).toMatchObject({
        texts: ['image-a', 'image-b'],
        inboundSeqs: [6, 7],
      });
      expect(state.imageCoalesce.buffers.get(canonicalJid)?.msg.chatJid).toBe(canonicalJid);
      expect(state.imageCoalesce.buffers.get(canonicalJid)?.timer).not.toBe(imageTimer);
      const migratedPoll = state.pendingPolls.questions.get(canonicalJid);
      expect(migratedPoll?.chatJid).toBe(canonicalJid);
      expect(migratedPoll?.chatJidAliases.has(lidKey)).toBe(true);
      expect(migratedPoll?.chatJidAliases.has(canonicalJid)).toBe(true);
      expect(migratedPoll?.pollMessageIdToQuestionIndex.get('POLL_ALIAS')).toBe(0);
      expect(migratedPoll?.softExpiryTimer).not.toBe(pollSoftTimer);
      expect(migratedPoll?.hardExpiryTimer).not.toBe(pollHardTimer);

      expect(state.chatSessions.has(lidKey)).toBe(false);
      expect(state.chatQueues.has(lidKey)).toBe(false);
      expect(state.crashes.count(lidKey)).toBe(0);
      expect(state.perChatInboundSeqQueue.has(lidKey)).toBe(false);
      expect(state.perChatTurnContentType.has(lidKey)).toBe(false);
      expect(state.perChatTurnText.has(lidKey)).toBe(false);
      expect(state.perChatAssistantItemText.has(lidKey)).toBe(false);
      expect(state.pendingTurnText.has(lidKey)).toBe(false);
      expect(state.pendingPolls.questions.has(lidKey)).toBe(false);
      expect(state.resumeFailedHandling.has(lidKey)).toBe(false);
      expect(state.autoCompact.cooldownUntil.has(lidKey)).toBe(false);
      expect(state.autoCompact.lastSuccessAt.has(lidKey)).toBe(false);
      expect(state.autoCompact.rapidRearmRecordedForSuccessAt.has(lidKey)).toBe(false);
      expect(state.autoCompact.consecutiveRapidRearms.has(lidKey)).toBe(false);
      expect(state.autoCompact.measureNextTurn.has(lidKey)).toBe(false);
      expect(state.imageCoalesce.buffers.has(lidKey)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pending AskUser poll votes remain correlated after LID remap', async () => {
    const canonicalJid = '15550004444@s.whatsapp.net';
    const lidKey = '15550004444@lid';
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const state = runtime as unknown as PerChatCleanupRuntimeState & {
      chatSessions: Map<string, typeof mockSession>;
      chatQueues: Map<string, IOutboundQueue>;
      handlePollVoteReceived: (data: {
        pollMessageId: string;
        chatJid: string;
        voterJid: string;
        selectedOptions: string[];
      }) => void;
    };

    await runtime.start();
    state.chatSessions.set(lidKey, mockSession);
    state.chatQueues.set(lidKey, mockQueue);
    state.pendingPolls.questions.set(lidKey, {
      questions: [{
        question: 'Pick a runtime',
        header: 'Runtime',
        options: [
          { label: 'Node', description: 'JavaScript runtime' },
          { label: 'Go', description: 'Compiled runtime' },
        ],
        multiSelect: false,
      }],
      toolId: 'tool-alias-vote',
      chatJid: lidKey,
      chatJidAliases: new Set([lidKey]),
      mode: 'poll',
      pollMessageIdToQuestionIndex: new Map([['POLL_ALIAS_VOTE', 0]]),
      currentQuestionIndex: 0,
      answersCollected: {},
      createdAt: Date.now(),
      resolution: 'first-vote-wins',
      timeoutMs: 60_000,
      votesByQuestion: new Map(),
      adminJids: null,
      source: 'askuser',
      sentPollMessageIds: ['POLL_ALIAS_VOTE'],
    });

    runtime.handleJidAliasChanged('15550004444', canonicalJid);
    mockSession.sendTurn.mockClear();

    state.handlePollVoteReceived({
      pollMessageId: 'POLL_ALIAS_VOTE',
      chatJid: lidKey,
      voterJid: lidKey,
      selectedOptions: ['Go'],
    });

    await vi.waitFor(() => {
      expect(mockSession.sendTurn).toHaveBeenCalledWith(expect.stringContaining('A: Go'));
    });
    expect(state.pendingPolls.questions.has(canonicalJid)).toBe(false);
  });

  it('normalizes legacy pending poll timeout during LID remap before re-arming timers', async () => {
    const canonicalJid = '15550004444@s.whatsapp.net';
    const lidKey = '15550004444@lid';
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const state = runtime as unknown as PerChatCleanupRuntimeState & {
      chatSessions: Map<string, typeof mockSession>;
      chatQueues: Map<string, IOutboundQueue>;
    };

    await runtime.start();
    state.chatSessions.set(lidKey, mockSession);
    state.chatQueues.set(lidKey, mockQueue);
    state.pendingPolls.questions.set(lidKey, {
      questions: [{
        question: 'Pick a runtime',
        header: 'Runtime',
        options: [
          { label: 'Node', description: 'JavaScript runtime' },
          { label: 'Go', description: 'Compiled runtime' },
        ],
        multiSelect: false,
      }],
      toolId: 'tool-legacy-timeout',
      chatJid: lidKey,
      chatJidAliases: new Set([lidKey]),
      mode: 'poll',
      pollMessageIdToQuestionIndex: new Map([['POLL_LEGACY_TIMEOUT', 0]]),
      currentQuestionIndex: 0,
      answersCollected: {},
      createdAt: Date.now(),
      resolution: 'first-vote-wins',
      votesByQuestion: new Map(),
      adminJids: null,
      source: 'askuser',
      sentPollMessageIds: ['POLL_LEGACY_TIMEOUT'],
    } as PendingPollQuestion);

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    setTimeoutSpy.mockClear();

    try {
      runtime.handleJidAliasChanged('15550004444', canonicalJid);

      const migratedPoll = state.pendingPolls.questions.get(canonicalJid);
      expect(migratedPoll?.timeoutMs).toBe(3_600_000);
      for (const [, delay] of setTimeoutSpy.mock.calls) {
        expect(delay).toEqual(expect.any(Number));
        expect(Number.isFinite(delay as number)).toBe(true);
        expect(delay as number).toBeGreaterThan(0);
      }
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('per_chat active-session events keep delivering results after LID remap', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const state = runtime as unknown as PerChatCleanupRuntimeState & {
      chatSessions: Map<string, typeof mockSession>;
      chatQueues: Map<string, IOutboundQueue>;
    };
    const lidKey = '15550004444@lid';
    const canonicalJid = '15550004444@s.whatsapp.net';

    await runtime.start();
    await sendAndDrain(runtime, makeMsg({
      chatJid: lidKey,
      senderJid: lidKey,
      content: 'hello',
      inboundSeq: 41,
    }));

    expect(capturedOnEventRef.current).toBeTypeOf('function');

    mockQueue.enqueueResultText.mockClear();
    mockRuntimeLogger.debug.mockClear();

    runtime.handleJidAliasChanged('15550004444', canonicalJid);
    capturedOnEventRef.current!({ type: 'result', text: 'remapped result' });

    expect(state.chatSessions.has(canonicalJid)).toBe(true);
    expect(state.chatQueues.get(canonicalJid)).toBe(mockQueue);
    expect(mockQueue.enqueueResultText).toHaveBeenCalledWith('remapped result');
    expect(state.perChatInboundSeqQueue.get(canonicalJid)).toEqual([]);
    expect(state.pendingTurnText.has(canonicalJid)).toBe(false);
    expect(mockRuntimeLogger.debug.mock.calls.some(
      ([, message]) => message === 'event dropped — no queue for chat',
    )).toBe(false);
  });

  it('per_chat mid-turn streaming survives LID remap without dropping remaining events', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const state = runtime as unknown as PerChatCleanupRuntimeState & {
      perChatTurnText: Map<string, string>;
    };
    const lidKey = '15550004444@lid';
    const canonicalJid = '15550004444@s.whatsapp.net';

    await runtime.start();
    await sendAndDrain(runtime, makeMsg({
      chatJid: lidKey,
      senderJid: lidKey,
      content: 'hello',
      inboundSeq: 42,
    }));

    expect(capturedOnEventRef.current).toBeTypeOf('function');

    mockQueue.enqueueStreamingText.mockClear();
    mockQueue.enqueueResultText.mockClear();

    runtime.handleJidAliasChanged('15550004444', canonicalJid);
    capturedOnEventRef.current!({ type: 'assistant_text', text: 'Hello ' });
    capturedOnEventRef.current!({ type: 'assistant_text', text: 'world' });

    expect(state.perChatTurnText.get(canonicalJid)).toBe('Hello world');

    capturedOnEventRef.current!({ type: 'result', text: '!' });

    expect(mockQueue.enqueueStreamingText.mock.calls.map(([text]) => text)).toEqual(['Hello ', 'world']);
    expect(mockQueue.enqueueResultText).toHaveBeenCalledWith('!');
    expect(state.perChatTurnText.has(canonicalJid)).toBe(false);
  });

  it('continues with a fallback label when media prep throws', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const durability = {
      markInboundSkipped: vi.fn(),
      markInboundFailed: vi.fn(),
    };
    mockPrepareContentForAgent.mockRejectedValueOnce(new Error('transcriber unavailable'));
    mockSession.getStatus.mockReturnValue({
      active: true,
      pid: 1,
      sessionId: 'sess',
      startedAt: null,
      messageCount: 0,
      lastMessageAt: null,
    });

    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    await runtime.start();
    (runtime as unknown as { durability: typeof durability }).durability = durability;

    await sendAndDrain(runtime, makeMsg({
      messageId: 'aud-prep-fail',
      content: null,
      contentType: 'audio',
      inboundSeq: 77,
    }));

    expect(mockPrepareContentForAgent).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'aud-prep-fail', contentType: 'audio' }),
      db,
      'aud-prep-fail',
    );
    expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        contentType: 'audio',
        messageId: 'aud-prep-fail',
      }),
      'media processing failed — using fallback label',
    );
    expect(mockSession.sendTurn).toHaveBeenCalledWith('[audio message — processing failed]');
    expect(durability.markInboundSkipped).not.toHaveBeenCalled();
    expect(durability.markInboundFailed).not.toHaveBeenCalled();
  });

  it('marks media turns skipped when media prep returns empty content', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const durability = {
      markInboundSkipped: vi.fn(),
      markInboundFailed: vi.fn(),
    };
    mockPrepareContentForAgent.mockResolvedValueOnce('   ');

    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    await runtime.start();
    (runtime as unknown as { durability: typeof durability }).durability = durability;

    await sendAndDrain(runtime, makeMsg({
      messageId: 'img-empty-prep',
      content: null,
      contentType: 'image',
      inboundSeq: 78,
    }));

    expect(mockPrepareContentForAgent).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'img-empty-prep', contentType: 'image' }),
      db,
      'img-empty-prep',
    );
    expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
      { messageId: 'img-empty-prep', contentType: 'image' },
      'empty content after media processing — skipping',
    );
    expect(durability.markInboundSkipped).toHaveBeenCalledWith(78, 'empty_content');
    expect(durability.markInboundFailed).not.toHaveBeenCalled();
    expect(mockSession.sendTurn).not.toHaveBeenCalled();
  });

  it('image coalescing flushes a batch when the timer fires', async () => {
    vi.useFakeTimers();
    try {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const durability = {
        markInboundSkipped: vi.fn(),
        markInboundFailed: vi.fn(),
      };
      mockSession.getStatus.mockReturnValue({ active: true, pid: 1, sessionId: 'sess', startedAt: null, messageCount: 0, lastMessageAt: null });

      await runtime.start();
      (runtime as unknown as { durability: typeof durability }).durability = durability;
      await sendAndDrain(runtime, makeMsg({ messageId: 'img-1', content: 'image one', contentType: 'image', inboundSeq: 1 }));
      await sendAndDrain(runtime, makeMsg({ messageId: 'img-2', content: 'image two', contentType: 'image', inboundSeq: 2 }));

      expect(mockSession.sendTurn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(3_000);

      expect(mockSession.sendTurn).toHaveBeenCalledTimes(1);
      expect(mockSession.sendTurn).toHaveBeenCalledWith('[2 images received]\nimage one\nimage two');
      expect(durability.markInboundSkipped).toHaveBeenCalledWith(1, 'coalesced_image');
      expect(mockQueue.setInboundSeq).toHaveBeenCalledWith(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('image coalescing flushes buffered images before a following text turn', async () => {
    vi.useFakeTimers();
    try {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      mockSession.getStatus.mockReturnValue({ active: true, pid: 1, sessionId: 'sess', startedAt: null, messageCount: 0, lastMessageAt: null });

      await runtime.start();
      await sendAndDrain(runtime, makeMsg({ messageId: 'img-1', content: 'image one', contentType: 'image', inboundSeq: 10 }));
      await sendAndDrain(runtime, makeMsg({ messageId: 'txt-1', content: 'after image', contentType: 'text', inboundSeq: 11 }));

      const sentTurns = (mockSession.sendTurn.mock.calls as unknown as Array<[string]>).map(([text]) => text);
      expect(sentTurns).toEqual(['image one', 'after image']);
      expect(mockQueue.setInboundSeq.mock.calls.map(([seq]) => seq)).toEqual([10, 11]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('image coalescing queues only the representative seq and consumes it on result', async () => {
    vi.useFakeTimers();
    try {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const state = runtime as unknown as PerChatCleanupRuntimeState;
      mockSession.getStatus.mockReturnValue({ active: true, pid: 1, sessionId: 'sess', startedAt: null, messageCount: 0, lastMessageAt: null });

      await runtime.start();
      await sendAndDrain(runtime, makeMsg({ messageId: 'img-1', content: 'image one', contentType: 'image', inboundSeq: 21 }));
      await sendAndDrain(runtime, makeMsg({ messageId: 'img-2', content: 'image two', contentType: 'image', inboundSeq: 22 }));
      await sendAndDrain(runtime, makeMsg({ messageId: 'img-3', content: 'image three', contentType: 'image', inboundSeq: 23 }));

      await vi.advanceTimersByTimeAsync(3_000);

      expect(state.perChatInboundSeqQueue.get('test@s.whatsapp.net')).toEqual([23]);
      capturedOnEventRef.current!({ type: 'result', text: null });
      expect(state.perChatInboundSeqQueue.get('test@s.whatsapp.net')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('image coalescing sends one turn for multiple images in a timer batch', async () => {
    vi.useFakeTimers();
    try {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      mockSession.getStatus.mockReturnValue({ active: true, pid: 1, sessionId: 'sess', startedAt: null, messageCount: 0, lastMessageAt: null });

      await runtime.start();
      await sendAndDrain(runtime, makeMsg({ messageId: 'img-1', content: 'image one', contentType: 'image', inboundSeq: 31 }));
      await sendAndDrain(runtime, makeMsg({ messageId: 'img-2', content: 'image two', contentType: 'image', inboundSeq: 32 }));
      await sendAndDrain(runtime, makeMsg({ messageId: 'img-3', content: 'image three', contentType: 'image', inboundSeq: 33 }));

      await vi.advanceTimersByTimeAsync(3_000);

      expect(mockSession.sendTurn).toHaveBeenCalledTimes(1);
      const firstTurn = (mockSession.sendTurn.mock.calls as unknown as Array<[string]>)[0][0];
      expect(firstTurn).toContain('[3 images received]');
    } finally {
      vi.useRealTimers();
    }
  });

  it('image coalescing flushes immediately at the max batch size', async () => {
    vi.useFakeTimers();
    try {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      mockSession.getStatus.mockReturnValue({ active: true, pid: 1, sessionId: 'sess', startedAt: null, messageCount: 0, lastMessageAt: null });

      await runtime.start();
      for (let i = 1; i <= 20; i += 1) {
        await sendAndDrain(runtime, makeMsg({
          messageId: `img-${i}`,
          content: `image ${i}`,
          contentType: 'image',
          inboundSeq: 100 + i,
        }));
      }

      expect(mockSession.sendTurn).toHaveBeenCalledTimes(1);
      const firstTurn = (mockSession.sendTurn.mock.calls as unknown as Array<[string]>)[0][0];
      expect(firstTurn).toContain('[20 images received]');
    } finally {
      vi.useRealTimers();
    }
  });

  it('image coalescing aborts instead of sending while resume-failed recovery owns the chat', async () => {
    vi.useFakeTimers();
    try {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const state = runtime as unknown as PerChatCleanupRuntimeState & {
        flushImageCoalesce: (mapKey: string) => Promise<void>;
        durability: { markInboundSkipped: ReturnType<typeof vi.fn> } | null;
      };
      const timer = fakeTimerHandle('resume-failed-image-coalesce');
      const markInboundSkipped = vi.fn();
      state.durability = { markInboundSkipped };
      state.resumeFailedHandling.add('test@s.whatsapp.net');
      state.imageCoalesce.buffers.set('test@s.whatsapp.net', {
        texts: ['image one'],
        timer,
        msg: makeMsg({ content: 'image one', contentType: 'image', inboundSeq: 141 }),
        inboundSeqs: [141],
      });

      await state.flushImageCoalesce('test@s.whatsapp.net');

      expect(mockSession.sendTurn).not.toHaveBeenCalled();
      expect(state.imageCoalesce.buffers.has('test@s.whatsapp.net')).toBe(false);
      expect(markInboundSkipped).toHaveBeenCalledWith(141, 'resume_failed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('image coalescing marks representative failed and clears turn state when send fails', async () => {
    vi.useFakeTimers();
    try {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const state = runtime as unknown as PerChatCleanupRuntimeState & {
        durability: {
          markInboundSkipped: ReturnType<typeof vi.fn>;
          markInboundFailed: ReturnType<typeof vi.fn>;
        } | null;
      };
      const durability = {
        markInboundSkipped: vi.fn(),
        markInboundFailed: vi.fn(),
      };
      mockSession.getStatus.mockReturnValue({ active: true, pid: 1, sessionId: 'sess', startedAt: null, messageCount: 0, lastMessageAt: null });
      mockSession.sendTurn.mockRejectedValueOnce(new Error('send failed'));

      await runtime.start();
      state.durability = durability;
      await sendAndDrain(runtime, makeMsg({ messageId: 'img-fail-1', content: 'image one', contentType: 'image', inboundSeq: 151 }));
      await sendAndDrain(runtime, makeMsg({ messageId: 'img-fail-2', content: 'image two', contentType: 'image', inboundSeq: 152 }));

      await vi.advanceTimersByTimeAsync(3_000);

      expect(mockSession.sendTurn).toHaveBeenCalledTimes(1);
      expect(durability.markInboundSkipped).toHaveBeenCalledWith(151, 'coalesced_image');
      expect(durability.markInboundFailed).toHaveBeenCalledWith(152);
      expect(state.imageCoalesce.buffers.has('test@s.whatsapp.net')).toBe(false);
      expect(state.perChatInboundSeqQueue.has('test@s.whatsapp.net')).toBe(false);
      expect(state.pendingTurnText.has('test@s.whatsapp.net')).toBe(false);
      expect(state.perChatTurnContentType.has('test@s.whatsapp.net')).toBe(false);
      expect(state.perChatTurnText.has('test@s.whatsapp.net')).toBe(false);
      expect(state.perChatAssistantItemText.has('test@s.whatsapp.net')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('per_chat startup failure clears pending turn state, marks inbound failed, and notifies the chat', async () => {
    const cases = [
      {
        label: 'standard per-chat',
        options: { sessionScope: 'per_chat' as const },
        installStartupStub(state: PerChatSendTurnRuntimeState): ReturnType<typeof vi.fn> {
          const ensureSessionAndQueueSync = vi.fn();
          state.ensureSessionAndQueueSync = ensureSessionAndQueueSync;
          return ensureSessionAndQueueSync;
        },
        expectedArgs: ['startup-fail@s.whatsapp.net', 'startup-fail', 'actor@s.whatsapp.net'],
      },
      {
        label: 'sandbox per-chat',
        options: { sessionScope: 'per_chat' as const, sandboxPerChat: true as const },
        installStartupStub(state: PerChatSendTurnRuntimeState): ReturnType<typeof vi.fn> {
          const ensureSessionAndQueue = vi.fn(async () => {});
          state.ensureSessionAndQueue = ensureSessionAndQueue;
          return ensureSessionAndQueue;
        },
        expectedArgs: ['startup-fail@s.whatsapp.net', 'actor@s.whatsapp.net'],
      },
    ];

    for (const testCase of cases) {
      mockSession.sendTurn.mockClear();
      mockRuntimeLogger.error.mockClear();
      const db = makeDb();
      const { messenger, sentMessages } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', testCase.options);
      const state = runtime as unknown as PerChatSendTurnRuntimeState;
      const durability = { markInboundFailed: vi.fn() };
      const replyGuarantee = { disarm: vi.fn(), isArmed: vi.fn(() => false) };
      const startupStub = testCase.installStartupStub(state);
      state.durability = durability;
      state.replyGuarantee = replyGuarantee;
      state.perChatInboundSeqQueue.set('startup-fail', [321]);

      await state.sendTurnPerChat(
        'startup-fail@s.whatsapp.net',
        `message for ${testCase.label}`,
        'startup-fail',
        'actor@s.whatsapp.net',
      );

      expect(startupStub, testCase.label).toHaveBeenCalledWith(...testCase.expectedArgs);
      expect(state.chatSessions.has('startup-fail'), testCase.label).toBe(false);
      expect(state.pendingTurnText.has('startup-fail'), testCase.label).toBe(false);
      expect(state.pendingTurnActorJid.has('startup-fail'), testCase.label).toBe(false);
      expect(replyGuarantee.disarm, testCase.label).toHaveBeenCalledWith(321);
      expect(durability.markInboundFailed, testCase.label).toHaveBeenCalledWith(321);
      expect(mockSession.sendTurn, testCase.label).not.toHaveBeenCalled();
      expect(sentMessages, testCase.label).toContainEqual({
        jid: 'startup-fail@s.whatsapp.net',
        text: 'Something went wrong starting a session. Try sending your message again.',
      });
      expect(mockRuntimeLogger.error, testCase.label).toHaveBeenCalledWith(
        { chatJid: 'startup-fail@s.whatsapp.net', mapKey: 'startup-fail' },
        'failed to create session for chat — message dropped',
      );
    }
  });

  it('handleMessage /status sends status when inactive', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockSession.getStatus.mockReturnValue({ active: false, pid: null, sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null });

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: '/status' }));

    const enqueuedTexts = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
    expect(enqueuedTexts.some((t) => t.includes('No active session'))).toBe(true);
  });

  it('handleMessage /status sends status when active', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockSession.getStatus.mockReturnValue({ active: true, pid: 9999, sessionId: 'ses_abc', startedAt: new Date(Date.now() - 120_000).toISOString(), messageCount: 3, lastMessageAt: new Date(Date.now() - 30_000).toISOString() });

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: '/status' }));

    const enqueuedTexts = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
    expect(enqueuedTexts.some((t) => t.includes('9999'))).toBe(true);
  });

  it('/status with active session includes all fields', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockSession.getStatus.mockReturnValue({
      active: true,
      pid: 1234,
      sessionId: 'abc12345-xyz',
      startedAt: new Date(Date.now() - 300_000).toISOString(),
      messageCount: 7,
      lastMessageAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: '/status' }));

    const enqueuedTexts = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
    expect(enqueuedTexts).toHaveLength(1);
    const text = enqueuedTexts[0];
    expect(text).toContain('Session active');
    expect(text).toContain('PID: `1234`');
    expect(text).toContain('Session: `abc12345...');
    expect(text).toContain('Messages: 7');
    expect(text).toContain('Started:');
    expect(text).toContain('Last activity:');
  });

  it('/status with no session returns no-session message', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockSession.getStatus.mockReturnValue({ active: false, pid: null, sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null });

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: '/status' }));

    const enqueuedTexts = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
    expect(enqueuedTexts.some((t) => t.includes('No active session'))).toBe(true);
  });

  it('/status session ID truncated to 8 chars + ellipsis', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockSession.getStatus.mockReturnValue({
      active: true,
      pid: 42,
      sessionId: 'abcdefghijklmnop',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      messageCount: 1,
      lastMessageAt: new Date(Date.now() - 10_000).toISOString(),
    });

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: '/status' }));

    const enqueuedTexts = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
    expect(enqueuedTexts.some((t) => t.includes('abcdefgh...'))).toBe(true);
  });

  it('handleMessage /help sends help text', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: '/help' }));

    const enqueuedTexts = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
    expect(enqueuedTexts.some((t) => t.includes('/new'))).toBe(true);
    expect(enqueuedTexts.some((t) => t.includes('/status'))).toBe(true);
  });

  it('handleMessage regular message calls sendTurn and spawnSession if not active', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockSession.getStatus.mockReturnValue({ active: false, pid: null, sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null });

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await sendAndDrain(runtime, makeMsg({ content: 'hello claude' }));

    expect(mockSession.spawnSession).toHaveBeenCalled();
    expect(mockSession.sendTurn).toHaveBeenCalledWith('hello claude');
  });

  it('handleMessage regular message does not re-spawn if already active', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockSession.getStatus.mockReturnValue({ active: true, pid: 123, sessionId: 'ses_x', startedAt: new Date(Date.now() - 60_000).toISOString(), messageCount: 1, lastMessageAt: new Date(Date.now() - 10_000).toISOString() });

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'follow-up' }));

    expect(mockSession.spawnSession).not.toHaveBeenCalled();
    expect(mockSession.sendTurn).toHaveBeenCalledWith('follow-up');
  });

  it('forwarded slash command is sent as a turn', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockSession.getStatus.mockReturnValue({ active: true, pid: 123, sessionId: 'ses_x', startedAt: new Date(Date.now() - 60_000).toISOString(), messageCount: 1, lastMessageAt: new Date(Date.now() - 10_000).toISOString() });

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: '/compact' }));

    expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');
  });

  it('per_chat handleAgentCommand silently sends /compact to the target session', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const groupJid = '120363555555555003@g.us';

    mockSession.getStatus.mockReturnValue({ active: true, pid: 123, sessionId: 'ses_x', startedAt: new Date(Date.now() - 60_000).toISOString(), messageCount: 1, lastMessageAt: new Date(Date.now() - 10_000).toISOString() });

    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    await runtime.start();
    await sendAndDrain(runtime, makeMsg({ chatJid: groupJid, isGroup: true, content: 'hello' }));
    mockSession.sendTurn.mockClear();
    mockQueue.indicateTyping.mockClear();
    mockQueue.enqueueText.mockClear();
    mockQueue.enqueueResultText.mockClear();
    mockQueue.flush.mockResolvedValue(undefined);

    const result = await runtime.handleAgentCommand({
      command: 'compact',
      chatJid: groupJid,
      silent: true,
    });

    expect(result).toEqual({ ok: true, command: 'compact', chatJid: groupJid, silent: true });
    expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');
    expect(mockQueue.indicateTyping).not.toHaveBeenCalled();

    capturedOnEventRef.current!({ type: 'compact_boundary' });
    expect(mockQueue.enqueueText).not.toHaveBeenCalled();

    capturedOnEventRef.current!({ type: 'result', text: 'compact complete' });
    await vi.waitFor(() => {
      expect(mockQueue.flush).toHaveBeenCalled();
    });
    expect(mockQueue.enqueueResultText).not.toHaveBeenCalled();

    capturedOnEventRef.current!({ type: 'compact_boundary' });
    expect(mockQueue.enqueueText).toHaveBeenCalledWith(expect.stringContaining('ompact'));
  });

  it('per_chat handleAgentCommand rejects compact while the target chat has a turn in progress', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const groupJid = '120363555555555003@g.us';

    mockSession.getStatus.mockReturnValue({ active: true, pid: 123, sessionId: 'ses_x', startedAt: new Date(Date.now() - 60_000).toISOString(), messageCount: 1, lastMessageAt: new Date(Date.now() - 10_000).toISOString() });

    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    await runtime.start();
    await sendAndDrain(runtime, makeMsg({ chatJid: groupJid, isGroup: true, content: 'hello' }));
    mockSession.sendTurn.mockClear();
    (runtime as unknown as { perChatInboundSeqQueue: Map<string, number[]> }).perChatInboundSeqQueue.set(groupJid, [42]);

    await expect(runtime.handleAgentCommand({
      command: 'compact',
      chatJid: groupJid,
      silent: true,
    })).rejects.toMatchObject({ code: 'turn_in_progress', statusCode: 409 });
    expect(mockSession.sendTurn).not.toHaveBeenCalled();
  });

  it('handleAgentCommand rejects compact precondition failures before sending system turns', async () => {
    const activeStatus = { active: true, pid: 123, sessionId: 'ses_x', startedAt: new Date(Date.now() - 60_000).toISOString(), messageCount: 1, lastMessageAt: new Date(Date.now() - 10_000).toISOString() };
    const inactiveStatus = { active: false, pid: null, sessionId: 'ses_x', startedAt: new Date(Date.now() - 60_000).toISOString(), messageCount: 1, lastMessageAt: new Date(Date.now() - 10_000).toISOString() };
    const groupJid = 'command-preconditions@g.us';

    await expect(new AgentRuntime(makeDb(), makeMessenger().messenger).handleAgentCommand({
      command: 'restart' as 'compact',
    })).rejects.toMatchObject({ code: 'unsupported_command', statusCode: 400 });

    const missingChatRuntime = new AgentRuntime(makeDb(), makeMessenger().messenger, 'test', { sessionScope: 'per_chat' });
    await missingChatRuntime.start();
    await expect(missingChatRuntime.handleAgentCommand({
      command: 'compact',
    })).rejects.toMatchObject({ code: 'chat_jid_required', statusCode: 400 });

    const missingSessionRuntime = new AgentRuntime(makeDb(), makeMessenger().messenger, 'test', { sessionScope: 'per_chat' });
    await missingSessionRuntime.start();
    await expect(missingSessionRuntime.handleAgentCommand({
      command: 'compact',
      chatJid: groupJid,
    })).rejects.toMatchObject({ code: 'session_not_found', statusCode: 404 });

    const inactivePerChatRuntime = new AgentRuntime(makeDb(), makeMessenger().messenger, 'test', { sessionScope: 'per_chat' });
    await inactivePerChatRuntime.start();
    (inactivePerChatRuntime as unknown as { chatSessions: Map<string, typeof mockSession> }).chatSessions.set(groupJid, mockSession);
    mockSession.getStatus.mockReturnValue(inactiveStatus);
    await expect(inactivePerChatRuntime.handleAgentCommand({
      command: 'compact',
      chatJid: groupJid,
    })).rejects.toMatchObject({ code: 'session_inactive', statusCode: 409 });

    const noSessionRuntime = new AgentRuntime(makeDb(), makeMessenger().messenger, 'test');
    await expect(noSessionRuntime.handleAgentCommand({
      command: 'compact',
      chatJid: '15550100004@s.whatsapp.net',
    })).rejects.toMatchObject({ code: 'session_not_found', statusCode: 404 });

    mockSession.getStatus.mockReturnValue(inactiveStatus);
    const inactiveSingleRuntime = new AgentRuntime(makeDb(), makeMessenger().messenger, 'test');
    await inactiveSingleRuntime.start();
    (inactiveSingleRuntime as unknown as { session: typeof mockSession }).session = mockSession;
    await expect(inactiveSingleRuntime.handleAgentCommand({
      command: 'compact',
      chatJid: '15550100005@s.whatsapp.net',
    })).rejects.toMatchObject({ code: 'session_inactive', statusCode: 409 });

    mockSession.getStatus.mockReturnValue(activeStatus);
    const missingQueueRuntime = new AgentRuntime(makeDb(), makeMessenger().messenger, 'test');
    await missingQueueRuntime.start();
    (missingQueueRuntime as unknown as { queue: typeof mockQueue | null; session: typeof mockSession }).session = mockSession;
    (missingQueueRuntime as unknown as { queue: typeof mockQueue | null }).queue = null;
    await expect(missingQueueRuntime.handleAgentCommand({
      command: 'compact',
      chatJid: '15550100006@s.whatsapp.net',
    })).rejects.toMatchObject({ code: 'session_queue_not_found', statusCode: 409 });

    const busySingleRuntime = new AgentRuntime(makeDb(), makeMessenger().messenger, 'test');
    await busySingleRuntime.start();
    (busySingleRuntime as unknown as { currentInboundSeq: number; session: typeof mockSession }).session = mockSession;
    (busySingleRuntime as unknown as { currentInboundSeq: number }).currentInboundSeq = 44;
    await expect(busySingleRuntime.handleAgentCommand({
      command: 'compact',
      chatJid: '15550100007@s.whatsapp.net',
    })).rejects.toMatchObject({ code: 'turn_in_progress', statusCode: 409 });

    expect(mockSession.sendTurn).not.toHaveBeenCalled();
  });

  it('handleAgentCommand clears pending compact bookkeeping when sendTurn fails', async () => {
    const activeStatus = { active: true, pid: 123, sessionId: 'ses_x', startedAt: new Date(Date.now() - 60_000).toISOString(), messageCount: 1, lastMessageAt: new Date(Date.now() - 10_000).toISOString() };
    const groupJid = 'command-send-failure@g.us';
    const chatJid = '15550100008@s.whatsapp.net';

    mockSession.getStatus.mockReturnValue(activeStatus);
    const perChatRuntime = new AgentRuntime(makeDb(), makeMessenger().messenger, 'test', { sessionScope: 'per_chat' });
    const perChatState = perChatRuntime as unknown as {
      autoCompact: AutoCompactView;
      chatSessions: Map<string, typeof mockSession>;
      pendingSystemResults: { counts: Map<string, number> };
    };
    await perChatRuntime.start();
    perChatState.chatSessions.set(groupJid, mockSession);
    mockSession.sendTurn.mockRejectedValueOnce(new Error('per-chat compact send failed'));

    await expect(perChatRuntime.handleAgentCommand({
      command: 'compact',
      chatJid: groupJid,
      silent: true,
    })).rejects.toThrow('per-chat compact send failed');

    expect(perChatState.pendingSystemResults.counts.get(groupJid) ?? 0).toBe(0);
    expect(perChatState.autoCompact.silentCompactScopes.has(groupJid)).toBe(false);

    mockSession.sendTurn.mockReset();
    mockSession.sendTurn.mockRejectedValueOnce(new Error('single compact send failed'));
    mockSession.getStatus.mockReturnValue(activeStatus);
    const singleRuntime = new AgentRuntime(makeDb(), makeMessenger().messenger, 'test');
    const singleState = singleRuntime as unknown as {
      autoCompact: AutoCompactView;
      currentTurnChatJid: string | null;
      pendingSystemResults: { counts: Map<string, number> };
      queue: typeof mockQueue | null;
      session: typeof mockSession;
    };
    await singleRuntime.start();
    singleState.session = mockSession;
    singleState.queue = mockQueue;

    await expect(singleRuntime.handleAgentCommand({
      command: 'compact',
      chatJid,
      silent: true,
    })).rejects.toThrow('single compact send failed');

    expect(singleState.pendingSystemResults.counts.get('__global__') ?? 0).toBe(0);
    expect(singleState.autoCompact.silentCompactScopes.has('__global__')).toBe(false);
    expect(singleState.currentTurnChatJid).toBeNull();
    expect(mockSession.sendTurn).toHaveBeenLastCalledWith('/compact');
  });

  it('per_chat manual /compact marks a system result so its turn does not arm the gate', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const groupJid = '120363555555555000@g.us';
    mockSession.getStatus.mockReturnValue({ active: true, pid: 123, sessionId: 'ses_x', startedAt: new Date(Date.now() - 60_000).toISOString(), messageCount: 1, lastMessageAt: new Date(Date.now() - 10_000).toISOString() });

    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const state = runtime as unknown as {
      pendingSystemResults: { counts: Map<string, number> };
      postTurnGate: Set<string>;
    };
    await runtime.start();
    await sendAndDrain(runtime, makeMsg({ chatJid: groupJid, isGroup: true, content: 'hello' }));
    mockSession.sendTurn.mockClear();

    // Non-silent so isSilentCompact does not independently suppress the follow-up.
    await runtime.handleAgentCommand({ command: 'compact', chatJid: groupJid, silent: false });
    expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');
    // The manual /compact registered a pending system result for this chat.
    expect(state.pendingSystemResults.counts.get(groupJid)).toBe(1);

    // Its result must not arm the gate, and a real reply after it is delivered.
    capturedOnEventRef.current!({ type: 'result', text: null });
    expect(state.postTurnGate.has(groupJid)).toBe(false);
    mockQueue.enqueueStreamingText.mockClear();
    capturedOnEventRef.current!({ type: 'assistant_text', text: 'After compact' });
    expect(mockQueue.enqueueStreamingText).toHaveBeenCalledWith('After compact');
  });

  it('single handleAgentCommand silently sends /compact without compact output or fallback', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockSession.getStatus.mockReturnValue({ active: true, pid: 123, sessionId: 'ses_x', startedAt: new Date(Date.now() - 60_000).toISOString(), messageCount: 1, lastMessageAt: new Date(Date.now() - 10_000).toISOString() });

    const runtime = new AgentRuntime(db, messenger, 'test');
    await runtime.start();
    await sendAndDrain(runtime, makeMsg({ chatJid: '15550100001@s.whatsapp.net', content: 'hello' }));
    capturedOnEventRef.current!({ type: 'result', text: 'ready' });
    await vi.waitFor(() => {
      expect(mockQueue.flush).toHaveBeenCalled();
    });
    mockSession.sendTurn.mockClear();
    mockQueue.enqueueText.mockClear();
    mockQueue.enqueueResultText.mockClear();
    mockQueue.flush.mockClear();
    mockQueue.flush.mockResolvedValue(undefined);

    const result = await runtime.handleAgentCommand({
      command: 'compact',
      silent: true,
    });

    expect(result).toEqual({ ok: true, command: 'compact', chatJid: '15550100001@s.whatsapp.net', silent: true });
    expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');

    capturedOnEventRef.current!({ type: 'compact_boundary' });
    capturedOnEventRef.current!({ type: 'result', text: 'compact complete' });
    await vi.waitFor(() => {
      expect(mockQueue.flush).toHaveBeenCalled();
    });

    expect(mockQueue.enqueueText).not.toHaveBeenCalledWith(expect.stringContaining('ompact'));
    expect(mockQueue.enqueueText).not.toHaveBeenCalledWith('_(no response)_');
    expect(mockQueue.enqueueResultText).not.toHaveBeenCalled();
    expect(mockQueue.flush).toHaveBeenCalled();
  });

  it('shared handleAgentCommand requires chatJid and silently routes compact completion', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const chatJid = '15550100002@s.whatsapp.net';

    mockSession.getStatus.mockReturnValue({ active: true, pid: 123, sessionId: 'ses_x', startedAt: new Date(Date.now() - 60_000).toISOString(), messageCount: 1, lastMessageAt: new Date(Date.now() - 10_000).toISOString() });

    const runtime = new AgentRuntime(db, messenger, 'test', { shared: true });
    await runtime.start();
    await sendAndDrainShared(runtime, makeMsg({ chatJid, content: 'hello' }));
    capturedOnEventRef.current!({ type: 'result', text: 'ready' });
    await vi.waitFor(() => {
      expect(mockQueue.flush).toHaveBeenCalled();
    });
    mockSession.sendTurn.mockClear();
    mockQueue.enqueueText.mockClear();
    mockQueue.enqueueResultText.mockClear();
    mockQueue.flush.mockClear();
    mockQueue.flush.mockResolvedValue(undefined);

    await expect(runtime.handleAgentCommand({
      command: 'compact',
      silent: true,
    })).rejects.toMatchObject({ code: 'chat_jid_required', statusCode: 400 });

    const result = await runtime.handleAgentCommand({
      command: 'compact',
      chatJid,
      silent: true,
    });

    expect(result).toEqual({ ok: true, command: 'compact', chatJid, silent: true });
    expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');

    capturedOnEventRef.current!({ type: 'compact_boundary' });
    capturedOnEventRef.current!({ type: 'result', text: 'compact complete' });
    await vi.waitFor(() => {
      expect(mockQueue.flush).toHaveBeenCalled();
    });

    expect(mockQueue.enqueueText).not.toHaveBeenCalledWith(expect.stringContaining('ompact'));
    expect(mockQueue.enqueueText).not.toHaveBeenCalledWith('_(no response)_');
    expect(mockQueue.enqueueResultText).not.toHaveBeenCalled();
    expect(mockQueue.flush).toHaveBeenCalled();
  });

  it('emit_heal_result rejects when no repair session is active', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    mockConfig.controlPeers.set('loops', '15550100002');

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    const emitHealResult = getRegisteredTool(runtime, 'emit_heal_result');

    await expectRejectsWithError(emitHealResult.handler({
      reportId: 'report-1',
      errorClass: 'crash__boom',
      result: 'fixed',
      commitSha: 'abc1234',
      diagnosis: 'fixed it',
    }), 'No active repair session');
  });

  it('emit_heal_result rejects mismatched reports and missing control queue', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    mockConfig.controlPeers.set('loops', '15550100002');

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    const emitHealResult = getRegisteredTool(runtime, 'emit_heal_result');
    const runtimeState = runtime as unknown as { activeControlReportId: string | null };
    runtimeState.activeControlReportId = 'report-active';

    await expectRejectsWithError(emitHealResult.handler({
      reportId: 'report-other',
      errorClass: 'crash__boom',
      result: 'fixed',
      commitSha: 'abc1234',
      diagnosis: 'fixed it',
    }), 'No active repair for reportId report-other. Active: report-active');

    await expectRejectsWithError(emitHealResult.handler({
      reportId: 'report-active',
      errorClass: 'crash__boom',
      result: 'fixed',
      commitSha: 'abc1234',
      diagnosis: 'fixed it',
    }), 'Control queue not found');
  });

  it('emit_heal_result fixed path notifies loops and clears the control slot', async () => {
    const db = makeDb();
    const { messenger, sentMessages } = makeMessenger();
    mockConfig.controlPeers.set('loops', '15550100002');

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    const emitHealResult = getRegisteredTool(runtime, 'emit_heal_result');
    const timeout = fakeTimerHandle('emit-heal-result-timeout');
    const controlQueue = {
      sendControlMessage: vi.fn(async () => ({ waMessageId: null })),
    };
    const controlKey = ['control', 'heal.internal'].join('@');
    const runtimeState = runtime as unknown as {
      activeControlReportId: string | null;
      controlSessionTimeout: ReturnType<typeof setTimeout> | null;
      chatQueues: Map<string, unknown>;
    };
    runtimeState.activeControlReportId = 'report-fixed';
    runtimeState.controlSessionTimeout = timeout;
    runtimeState.chatQueues.set(controlKey, controlQueue);

    const result = await emitHealResult.handler({
      reportId: 'report-fixed',
      errorClass: 'crash__boom',
      result: 'fixed',
      commitSha: 'abc1234',
      diagnosis: 'fixed it',
    });

    expect(result).toEqual({ sent: true, reportId: 'report-fixed', result: 'fixed' });
    expect(controlQueue.sendControlMessage).toHaveBeenCalledWith(
      '15550100002@s.whatsapp.net',
      'HEAL_COMPLETE',
      {
        reportId: 'report-fixed',
        errorClass: 'crash__boom',
        result: 'fixed',
        commitSha: 'abc1234',
        diagnosis: 'fixed it',
      },
      undefined,
    );
    expect(runtimeState.activeControlReportId).toBeNull();
    expect(runtimeState.controlSessionTimeout).toBeNull();
    expect(sentMessages).toEqual([]);
  });

  it('emit_heal_result escalates to loops and admin before dispatching the next queued report', async () => {
    const queuedRow = {
      report_id: 'report-next',
      error_class: 'service_crash__next',
      error_type: 'service_crash',
      state: 'queued',
      attempt_count: 1,
      cooldown_until: null,
      context: '{"type":"service_crash","recentLogs":"next stack"}',
      created_at: '2026-06-10T09:58:00Z',
    };
    const prepare = vi.fn((sql: string) => {
      if (sql.includes('SELECT report_id, error_class, state FROM heal_reports')) {
        return { all: vi.fn(() => []) };
      }
      if (sql.includes("SELECT * FROM heal_reports WHERE state = 'queued'")) {
        return { get: vi.fn(() => queuedRow) };
      }
      return { run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) };
    });
    const db = {
      raw: { prepare, exec: vi.fn() },
    } as unknown as Database;
    const { messenger, sentMessages } = makeMessenger();
    mockConfig.controlPeers.set('loops', '15550100002');
    mockConfig.adminPhones = new Set(['15550100003']);

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    const emitHealResult = getRegisteredTool(runtime, 'emit_heal_result');
    const controlQueue = {
      sendControlMessage: vi.fn(async () => ({ waMessageId: null })),
    };
    const controlKey = ['control', 'heal.internal'].join('@');
    const runtimeState = runtime as unknown as {
      activeControlReportId: string | null;
      chatQueues: Map<string, unknown>;
      handleControlTurn: ReturnType<typeof vi.fn>;
    };
    runtimeState.activeControlReportId = 'report-escalate';
    runtimeState.chatQueues.set(controlKey, controlQueue);
    runtimeState.handleControlTurn = vi.fn(async () => {});

    const result = await emitHealResult.handler({
      reportId: 'report-escalate',
      errorClass: 'crash__boom',
      result: 'escalate',
      diagnosis: 'needs human repair',
    });

    expect(result).toEqual({ sent: true, reportId: 'report-escalate', result: 'escalate' });
    expect(controlQueue.sendControlMessage).toHaveBeenCalledWith(
      '15550100002@s.whatsapp.net',
      'HEAL_ESCALATE',
      {
        reportId: 'report-escalate',
        errorClass: 'crash__boom',
        diagnosis: 'needs human repair',
      },
      undefined,
    );
    expect(sentMessages).toEqual([
      {
        jid: '15550100003@s.whatsapp.net',
        text: '[HEAL_ESCALATE] Repair for crash__boom escalated.\n\nneeds human repair',
      },
    ]);
    expect(runtimeState.activeControlReportId).toBeNull();
    expect(runtimeState.handleControlTurn).toHaveBeenCalledWith(
      'report-next',
      JSON.stringify({
        type: 'service_crash',
        recentLogs: 'next stack',
        reportId: 'report-next',
        errorClass: 'service_crash__next',
      }),
    );
  });

  // ─── B02: STDIN_WRITE_TIMEOUT handling ────────────────────────────────────

  it('handleMessage catches STDIN_WRITE_TIMEOUT and sends user-facing message', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockSession.getStatus.mockReturnValue({ active: true, pid: 123, sessionId: 'ses_x', startedAt: new Date(Date.now() - 60_000).toISOString(), messageCount: 1, lastMessageAt: new Date(Date.now() - 10_000).toISOString() });
    mockSession.sendTurn.mockRejectedValue(new Error('STDIN_WRITE_TIMEOUT: agent not reading input'));

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await sendAndDrain(runtime, makeMsg({ content: 'hello' }));

    const enqueuedTexts = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
    expect(enqueuedTexts.some((t) => t.includes('not responding'))).toBe(true);
    expect(enqueuedTexts.some((t) => t.includes('/new'))).toBe(true);
  });

  it('handleMessage non-timeout errors from sendTurn do not propagate to caller (swallowed by chain)', async () => {
    // The turn serializer chain uses .catch(() => {}) to prevent one failed turn
    // from breaking subsequent turns. Non-timeout errors are therefore swallowed
    // rather than re-thrown to the handleMessage caller.
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockSession.getStatus.mockReturnValue({ active: true, pid: 123, sessionId: 'ses_x', startedAt: new Date(Date.now() - 60_000).toISOString(), messageCount: 1, lastMessageAt: new Date(Date.now() - 10_000).toISOString() });
    mockSession.sendTurn.mockRejectedValue(new Error('some other error'));

    const runtime = new AgentRuntime(db, messenger);
    const { durability } = attachRuntimeFaultMarkerSpies(runtime);
    await runtime.start();

    // handleMessage must not reject — error is swallowed by the chain's .catch(() => {})
    await expect(sendAndDrain(runtime, makeMsg({ content: 'hello', inboundSeq: 89 }))).resolves.toBeUndefined();
    expect(durability.markContinuityCandidateIfNoTerminalOutbound)
      .toHaveBeenCalledWith(89, 'runtime_fault_no_terminal_outbound', 'runtime_fault_disarm');
    expect(durability.markInboundFailed).toHaveBeenCalledWith(89);
  });

  // ─── Event routing ─────────────────────────────────────────────────────────

  it('assistant_text event enqueues text', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    // trigger session creation
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    capturedOnEventRef.current!({ type: 'assistant_text', text: 'Hello there!' });

    expect(mockQueue.enqueueStreamingText).toHaveBeenCalledWith('Hello there!');
  });

  it('suppresses provider usage-cap assistant text and logs a preview', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    capturedOnEventRef.current!({ type: 'assistant_text', text: "You're out of extra usage. Claude will be available at 8pm." });

    expect(mockQueue.enqueueStreamingText).not.toHaveBeenCalled();
    expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'test@s.whatsapp.net',
        textPreview: expect.stringContaining('out of extra usage'),
      }),
      'suppressed provider-failure message from assistant_text',
    );
  });

  it('delivers ambient auth-topic assistant text instead of dropping it (QR-209)', async () => {
    // The exact defect: a genuine reply that DISCUSSES an expired OAuth token
    // matched the permissive classifier and was silently dropped. It must now be
    // delivered (ambient), with a structured warn recording the classification.
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'my oauth broke, what do we do?' }));

    const reply = 'Yes — it looks like the OAuth token expired, so we should reconnect the account and re-run login.';
    capturedOnEventRef.current!({ type: 'assistant_text', text: reply });

    expect(mockQueue.enqueueStreamingText).toHaveBeenCalledWith(reply);
    expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ chatJid: 'test@s.whatsapp.net', kind: 'auth-required' }),
      'delivered assistant_text despite provider-failure classification',
    );
  });

  it('delivers ambient auth-topic assistant text on the shared handler too (QR-209)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const chatJid = '15550100003@s.whatsapp.net';

    const runtime = new AgentRuntime(db, messenger, 'test', { shared: true });
    await runtime.start();
    await sendAndDrainShared(runtime, makeMsg({ chatJid, content: 'my oauth broke, what do we do?' }));

    const reply = 'Right — the OAuth token expired; let us reconnect the provider account and continue.';
    capturedOnEventRef.current!({ type: 'assistant_text', text: reply });

    expect(mockQueue.enqueueStreamingText).toHaveBeenCalledWith(reply);
    expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'auth-required' }),
      'delivered assistant_text despite provider-failure classification',
    );
  });

  it('a suppressed streaming banner followed by a clean result does not arm fallback (QR-209 unknown-b)', async () => {
    // Streaming never arms fallback; the terminal result classifies event.text, and
    // a successful turn carries text:null — so a suppressed streaming banner cannot
    // double-fire fallback on a genuine success.
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    capturedOnEventRef.current!({ type: 'assistant_text', text: "You're out of extra usage. Claude will be available at 8pm." });
    expect(mockQueue.enqueueStreamingText).not.toHaveBeenCalled();

    capturedOnEventRef.current!({ type: 'result', text: null, isError: false });

    expect(runtime.getFallbackState().fallbackReason).toBeNull();
    expect(runtime.getFallbackState().fallbackActiveUntil).toBeNull();
  });

  it('streams ordinary OAuth troubleshooting prose and updates reply activity', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const replyGuarantee = { notifyActivity: vi.fn() };

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await sendAndDrain(runtime, makeMsg({ content: 'hi' }));
    (runtime as unknown as { replyGuarantee: typeof replyGuarantee }).replyGuarantee = replyGuarantee;
    mockQueue.enqueueStreamingText.mockClear();
    mockRuntimeLogger.warn.mockClear();

    const text = 'Your OAuth token has expired - run claude login to reconnect, then retry.';
    capturedOnEventRef.current!({ type: 'assistant_text', text });

    expect(mockQueue.enqueueStreamingText).toHaveBeenCalledWith(text);
    expect(replyGuarantee.notifyActivity).toHaveBeenCalledWith('test@s.whatsapp.net');
    expect(mockRuntimeLogger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ textPreview: expect.stringContaining('OAuth token') }),
      'suppressed provider-failure message from assistant_text',
    );
  });

  it('tool_use event enqueues tool update', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    capturedOnEventRef.current!({ type: 'tool_use', toolName: 'Bash', toolId: 'tool_1', toolInput: { command: 'git status' } });

    expect(mockQueue.enqueueToolUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'running' }),
    );
  });

  it('buildToolUpdate Bash — no description: detail is monospace first command line', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    capturedOnEventRef.current!({ type: 'tool_use', toolName: 'Bash', toolId: 't1', toolInput: { command: 'git status\ngit diff' } });

    expect(mockQueue.enqueueToolUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'running', detail: '`git status`' }),
    );
  });

  it('buildToolUpdate Bash — with description: detail is plain text (no backticks)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    capturedOnEventRef.current!({ type: 'tool_use', toolName: 'Bash', toolId: 't2', toolInput: { command: 'git status', description: 'Show git status' } });

    expect(mockQueue.enqueueToolUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'running', detail: 'Show git status' }),
    );
  });

  it('buildToolUpdate Read — includes line range in detail when limit/offset present', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    capturedOnEventRef.current!({ type: 'tool_use', toolName: 'Read', toolId: 't3', toolInput: { file_path: '/workspace/WhatSoup/src/main.ts', offset: 10, limit: 5 } });

    const call = (mockQueue.enqueueToolUpdate.mock.calls.at(-1) as [{ category: string; detail: string }])[0];
    expect(call.category).toBe('reading');
    expect(call.detail).toContain('L10');
    expect(call.detail).toContain('L14');
  });

  it('buildToolUpdate Glob — uses two-line format with scope on second line', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    capturedOnEventRef.current!({ type: 'tool_use', toolName: 'Glob', toolId: 't4', toolInput: { pattern: '**/*.ts', path: '/workspace/WhatSoup/src' } });

    const call = (mockQueue.enqueueToolUpdate.mock.calls.at(-1) as [{ category: string; detail: string }])[0];
    expect(call.category).toBe('searching');
    expect(call.detail).toContain('`**/*.ts`');
    expect(call.detail).toContain('\n→');
  });

  it('buildToolUpdate Grep — uses two-line format with scope on second line', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    capturedOnEventRef.current!({ type: 'tool_use', toolName: 'Grep', toolId: 't5', toolInput: { pattern: 'flushToolBuffer', glob: '*.ts' } });

    const call = (mockQueue.enqueueToolUpdate.mock.calls.at(-1) as [{ category: string; detail: string }])[0];
    expect(call.category).toBe('searching');
    expect(call.detail).toContain('`flushToolBuffer`');
    expect(call.detail).toContain('\n→');
  });

  // @check CHK-023
  // @traces REQ-005.AC-05
  it('compact_boundary event enqueues notification through queue', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    capturedOnEventRef.current!({ type: 'compact_boundary' });

    expect(mockQueue.enqueueText).toHaveBeenCalledWith(
      expect.stringContaining('ompact'),
    );
  });

  it('result event with prior text flushes queue without fallback', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    capturedOnEventRef.current!({ type: 'assistant_text', text: 'Hello' });
    capturedOnEventRef.current!({ type: 'result', text: null });
    await vi.waitFor(() => expect(mockQueue.flush).toHaveBeenCalled());
    // Should not add fallback because there was prior text
    const calls = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
    expect(calls).not.toContain('_(no response)_');
  });

  it('result event with no prior text enqueues fallback message', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    // No assistant_text event — go straight to result
    capturedOnEventRef.current!({ type: 'result', text: null });
    await vi.waitFor(() => expect(mockQueue.enqueueText).toHaveBeenCalledWith('_(no response)_'));

    const calls = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
    expect(calls).toContain('_(no response)_');
    expect(mockQueue.flush).toHaveBeenCalled();
  });

  it('result event with text enqueues the text', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    capturedOnEventRef.current!({ type: 'result', text: 'Context limit reached' });
    await vi.waitFor(() => expect(mockQueue.enqueueResultText).toHaveBeenCalledWith('Context limit reached'));

    const calls = mockQueue.enqueueResultText.mock.calls.map((args) => args[0] as string);
    expect(calls).toContain('Context limit reached');
    expect(mockQueue.flush).toHaveBeenCalled();
  });

  it('context-overflow provider result sends the template notice instead of raw provider text', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    const raw = 'Error: prompt is too long for the context window';
    capturedOnEventRef.current!({ type: 'result', text: raw, isError: true });

    const expected = renderUserMessage('context-overflow', {
      hasContinuation: false,
      bundle: null,
      formatClock: () => 'unused',
    });
    await vi.waitFor(() => expect(mockQueue.enqueueText).toHaveBeenCalledWith(expected));
    expect(mockQueue.enqueueResultText).not.toHaveBeenCalledWith(raw);
    expect(mockSession.shutdown).toHaveBeenCalled();
  });

  it('model-unavailable result is not forwarded raw to the user (single path)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    const raw = "There's an issue with the selected model (some-test-model). It may not exist or you may not have access to it. Run --model to pick a different model.";
    capturedOnEventRef.current!({ type: 'result', text: raw, isError: true });

    await vi.waitFor(() =>
      expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ textPreview: expect.stringContaining('issue with the selected model') }),
        'suppressed provider model-unavailable message from result — session will be shut down',
      ),
    );
    const forwarded = mockQueue.enqueueResultText.mock.calls.map((a) => a[0] as string);
    expect(forwarded).not.toContain(raw);
    const turnCapability = (runtime.getHealthSnapshot().details as Record<string, any>).turnCapability;
    expect(turnCapability.lastTurnErrorClass).toBe('model-unavailable');
    expect(turnCapability.lastTurnErrorAt).toEqual(expect.any(Number));
    expect(JSON.stringify(turnCapability)).not.toContain(raw);
  });

  it('unknown terminal (is_error) result is default-denied: generic notice, never raw', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    const raw = 'Unexpected provider explosion exposing internal-detail-xyz';
    capturedOnEventRef.current!({ type: 'result', text: raw, isError: true });

    await vi.waitFor(() =>
      expect(mockQueue.enqueueText).toHaveBeenCalledWith(expect.stringContaining('an operator has been notified')),
    );
    const forwardedRaw = mockQueue.enqueueResultText.mock.calls.map((a) => a[0] as string);
    expect(forwardedRaw).not.toContain(raw);
    const allText = mockQueue.enqueueText.mock.calls.map((a) => a[0] as string).join('\n');
    expect(allText).not.toContain('internal-detail-xyz');

    let turnCapability = (runtime.getHealthSnapshot().details as Record<string, any>).turnCapability;
    expect(turnCapability.lastTurnErrorClass).toBe('unknown-terminal');
    expect(turnCapability.lastTurnErrorAt).toEqual(expect.any(Number));
    expect(JSON.stringify(turnCapability)).not.toContain('internal-detail-xyz');
    const failedAt = turnCapability.lastTurnErrorAt as number;

    mockQueue.enqueueResultText.mockClear();
    await runtime.handleMessage(makeMsg({ content: 'follow up' }));
    capturedOnEventRef.current!({ type: 'result', text: 'Recovered reply', isError: false });
    await vi.waitFor(() => expect(mockQueue.enqueueResultText).toHaveBeenCalledWith('Recovered reply'));

    turnCapability = (runtime.getHealthSnapshot().details as Record<string, any>).turnCapability;
    expect(turnCapability.lastSuccessfulTurnAt).toEqual(expect.any(Number));
    expect(turnCapability.lastSuccessfulTurnAt).toBeGreaterThanOrEqual(failedAt);
    expect({
      lastTurnErrorClass: turnCapability.lastTurnErrorClass,
      lastTurnErrorAt: turnCapability.lastTurnErrorAt,
    }).toEqual({
      lastTurnErrorClass: null,
      lastTurnErrorAt: null,
    });
  });

  it('end-to-end: a Gemini ACP in-band error update is default-denied (suppressed + ops-alerted), not leaked raw (BEAD-058)', async () => {
    // Systemic proof crossing the parser -> runtime boundary: a raw Gemini ACP
    // `session/update` of type `error` must be parsed with isError set, so the
    // runtime default-deny handler suppresses the raw provider/CLI text and
    // raises a provider_unknown_terminal ops alert. Before the parser fix the
    // event carried no isError flag, so the runtime forwarded the raw text to
    // the user (enqueueResultText) and skipped the alert — the leak this guards.
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    const raw = 'Gemini ACP internal failure exposing secret-token-xyz789';
    const parsed = parseGeminiAcpEvent(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'session-e2e',
          update: { type: 'error', message: raw },
        },
      }),
    );
    // Boundary anchor: the parser must flag the in-band error for default-deny.
    // Without the source fix this is undefined and every assertion below fails.
    expect(parsed).toEqual({ type: 'result', text: raw, isError: true });

    mockEmitAlert.mockClear();
    capturedOnEventRef.current!(parsed as AgentEvent);

    // Ops is alerted on the unknown terminal provider error...
    await vi.waitFor(() =>
      expect(mockEmitAlert).toHaveBeenCalledWith(
        expect.any(String),
        'provider_unknown_terminal',
        'Unclassified terminal provider error suppressed from user',
        expect.stringContaining('secret-token-xyz789'),
      ),
    );
    // ...the user gets only the generic notice...
    const allUserText = mockQueue.enqueueText.mock.calls.map((a) => a[0] as string).join('\n');
    expect(allUserText).toContain('an operator has been notified');
    expect(allUserText).not.toContain('secret-token-xyz789');
    // ...and the raw provider text is NEVER forwarded to the user.
    const forwardedRaw = mockQueue.enqueueResultText.mock.calls.map((a) => a[0] as string);
    expect(forwardedRaw).not.toContain(raw);
    const turnCapability = (runtime.getHealthSnapshot().details as Record<string, any>).turnCapability;
    expect(turnCapability.lastTurnErrorClass).toBe('unknown-terminal');
    expect(JSON.stringify(turnCapability)).not.toContain('secret-token-xyz789');
  });

  it('end-to-end: a Gemini ACP successful turn result is still forwarded raw (no over-suppression, BEAD-058)', async () => {
    // The fix is error-branch-only: a normal turn_complete / final reply must NOT
    // acquire isError and must continue to reach the user verbatim.
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    const parsedSuccess = parseGeminiAcpEvent(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 9,
        result: { stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 } },
      }),
    );
    // A bare end-of-turn carries no text; emit a genuine assistant reply first,
    // then prove the (non-error) result path forwards visible text untouched.
    capturedOnEventRef.current!({ type: 'result', text: 'a genuine Gemini reply', isError: false });
    await vi.waitFor(() => expect(mockQueue.enqueueResultText).toHaveBeenCalledWith('a genuine Gemini reply'));
    // The parsed success event must not have been flagged as an error.
    expect((parsedSuccess as { isError?: boolean }).isError).toBeUndefined();
  });

  it('transient-network (socket-close) is_error result emits provider_transient_network WARNING, not provider_unknown_terminal CRITICAL (single path)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    const socketText = 'API Error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()';
    mockEmitAlert.mockClear();
    capturedOnEventRef.current!({ type: 'result', text: socketText, isError: true });

    await vi.waitFor(() =>
      expect(mockEmitAlert).toHaveBeenCalledWith(
        expect.any(String),
        'provider_transient_network',
        'Transient provider connection drop (recoverable)',
        expect.stringContaining('socket connection was closed unexpectedly'),
        'warning',
      ),
    );
    // Must NOT emit the CRITICAL unknown-terminal alert
    const unknownCriticalCall = mockEmitAlert.mock.calls.find((c) => c[1] === 'provider_unknown_terminal');
    expect(unknownCriticalCall).toBeUndefined();
    // Raw provider text must not be forwarded to the user
    const forwardedRaw = mockQueue.enqueueResultText.mock.calls.map((a) => a[0] as string);
    expect(forwardedRaw).not.toContain(socketText);
    // A generic notice is sent
    const allText = mockQueue.enqueueText.mock.calls.map((a) => a[0] as string).join('\n');
    expect(allText).toMatch(/operator has been notified|try again/i);
    // Turn capability records transient-network
    const turnCapability = (runtime.getHealthSnapshot().details as Record<string, any>).turnCapability;
    expect(turnCapability.lastTurnErrorClass).toBe('transient-network');
  });

  it('server-error result arms fallback instead of default-denying to unknown-terminal (single path)', async () => {
    const agentConfig = mockConfig as typeof mockConfig & {
      agentProvider?: string;
      agentFallbackProvider?: string;
      agentFallbackModel?: string;
    };
    agentConfig.agentProvider = 'claude-cli';
    agentConfig.agentFallbackProvider = 'opencode-cli';
    agentConfig.agentFallbackModel = 'minimax/minimax-m2';

    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    const raw = 'API Error 503: Service temporarily unavailable. overloaded_error';
    mockEmitAlert.mockClear();
    capturedOnEventRef.current!({ type: 'result', text: raw, isError: true });

    await vi.waitFor(() =>
      expect(runtime.getFallbackState().fallbackActiveUntil).toEqual(expect.any(Number)),
    );
    const fallbackState = runtime.getFallbackState();
    expect(fallbackState.fallbackReason).toBe('server-error');
    expect(fallbackState.effectiveProvider).toBe('opencode-cli');

    const forwardedRaw = mockQueue.enqueueResultText.mock.calls.map((a) => a[0] as string);
    expect(forwardedRaw).not.toContain(raw);
    expect(mockEmitAlert.mock.calls.find((c) => c[1] === 'provider_unknown_terminal')).toBeUndefined();
    const turnCapability = (runtime.getHealthSnapshot().details as Record<string, any>).turnCapability;
    expect(turnCapability.lastTurnErrorClass).toBe('server-error');
  });

  it('auth-required result arms fallback and shuts down when replay is blocked by tool activity (single path)', async () => {
    const savedMinimaxKey = process.env.MINIMAX_API_KEY;
    process.env.MINIMAX_API_KEY = 'test-minimax-key';
    try {
      const agentConfig = mockConfig as typeof mockConfig & {
        agentProvider?: string;
        agentFallbackProvider?: string;
        agentFallbackModel?: string;
      };
      agentConfig.agentProvider = 'claude-cli';
      agentConfig.agentFallbackProvider = 'opencode-cli';
      agentConfig.agentFallbackModel = 'minimax/minimax-m2';

      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger);
      await runtime.start();
      await runtime.handleMessage(makeMsg({ content: 'hi' }));

      (runtime as unknown as { singleTurnHadToolActivity: boolean }).singleTurnHadToolActivity = true;
      const raw = 'Authentication required. Sign in to continue.';
      capturedOnEventRef.current!({ type: 'result', text: raw, isError: true });

      await vi.waitFor(() => expect(runtime.getFallbackState().fallbackReason).toBe('auth-required'));
      expect(runtime.getFallbackState().effectiveProvider).toBe('opencode-cli');
      expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ textPreview: raw }),
        'suppressed provider auth-required message from result — session will be shut down',
      );
      expect(mockEmitAlert).toHaveBeenCalledWith(
        expect.any(String),
        'provider_fallback_activated',
        'Provider fallback window activated',
        expect.stringContaining('reason=auth-required'),
      );
      expect(mockQueue.enqueueText).toHaveBeenCalledWith(expect.stringContaining('will not replay it automatically'));
      expect(mockSession.shutdown).toHaveBeenCalled();
      expect(mockEmitAlert.mock.calls.find((c) => c[1] === 'provider_fallback_replayed')).toBeUndefined();
      expect(mockQueue.enqueueResultText).not.toHaveBeenCalledWith(raw);
      const turnCapability = (runtime.getHealthSnapshot().details as Record<string, any>).turnCapability;
      expect(turnCapability.lastTurnErrorClass).toBe('auth-required');
    } finally {
      if (savedMinimaxKey === undefined) delete process.env.MINIMAX_API_KEY;
      else process.env.MINIMAX_API_KEY = savedMinimaxKey;
    }
  });

  it('server-error result without fallback sends the safe terminal notice and shuts down (single path)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    const raw = 'API Error 503: Service temporarily unavailable. overloaded_error';
    capturedOnEventRef.current!({ type: 'result', text: raw, isError: true });

    await vi.waitFor(() => expect(mockQueue.enqueueText).toHaveBeenCalledWith(providerUnknownTerminalNotice()));
    expect(runtime.getFallbackState().fallbackReason).toBeNull();
    expect(mockSession.shutdown).toHaveBeenCalled();
    expect(mockQueue.enqueueResultText).not.toHaveBeenCalledWith(raw);
    expect(mockEmitAlert.mock.calls.find((c) => c[1] === 'provider_unknown_terminal')).toBeUndefined();
    const turnCapability = (runtime.getHealthSnapshot().details as Record<string, any>).turnCapability;
    expect(turnCapability.lastTurnErrorClass).toBe('server-error');
  });

  it('model-unavailable result with fallback notifies and shuts down when replay is blocked (single path)', async () => {
    const savedMinimaxKey = process.env.MINIMAX_API_KEY;
    process.env.MINIMAX_API_KEY = 'test-minimax-key';
    try {
      const agentConfig = mockConfig as typeof mockConfig & {
        agentProvider?: string;
        agentFallbackProvider?: string;
        agentFallbackModel?: string;
      };
      agentConfig.agentProvider = 'claude-cli';
      agentConfig.agentFallbackProvider = 'opencode-cli';
      agentConfig.agentFallbackModel = 'minimax/minimax-m2';

      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger);
      await runtime.start();
      await runtime.handleMessage(makeMsg({ content: 'hi' }));

      (runtime as unknown as { singleTurnHadToolActivity: boolean }).singleTurnHadToolActivity = true;
      const raw = "There's an issue with the selected model (some-test-model). It may not exist or you may not have access to it.";
      capturedOnEventRef.current!({ type: 'result', text: raw, isError: true });

      await vi.waitFor(() => expect(runtime.getFallbackState().fallbackReason).toBe('model-unavailable'));
      expect(runtime.getFallbackState().effectiveProvider).toBe('opencode-cli');
      expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ textPreview: raw }),
        'suppressed provider model-unavailable message from result — session will be shut down',
      );
      expect(mockEmitAlert).toHaveBeenCalledWith(
        expect.any(String),
        'provider_fallback_activated',
        'Provider fallback window activated',
        expect.stringContaining('reason=model-unavailable'),
      );
      expect(mockQueue.enqueueText).toHaveBeenCalledWith(expect.stringContaining('will not replay it automatically'));
      expect(mockSession.shutdown).toHaveBeenCalled();
      expect(mockEmitAlert.mock.calls.find((c) => c[1] === 'provider_fallback_replayed')).toBeUndefined();
      expect(mockQueue.enqueueResultText).not.toHaveBeenCalledWith(raw);
      const turnCapability = (runtime.getHealthSnapshot().details as Record<string, any>).turnCapability;
      expect(turnCapability.lastTurnErrorClass).toBe('model-unavailable');
    } finally {
      if (savedMinimaxKey === undefined) delete process.env.MINIMAX_API_KEY;
      else process.env.MINIMAX_API_KEY = savedMinimaxKey;
    }
  });

  it('assistant_text auto-switch notices are surfaced without arming fallback', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    capturedOnEventRef.current!({
      type: 'assistant_text',
      text: 'Switched to Opus 4.7 due to high demand for Opus 4.8',
    });

    expect(mockQueue.enqueueStreamingText).toHaveBeenCalledWith(
      '_Model auto-switched from Opus 4.8 to Opus 4.7 (high demand). Continuing normally._',
    );
    expect(runtime.getFallbackState().fallbackActiveUntil).toBeNull();
    expect(mockRuntimeLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'Opus 4.8', to: 'Opus 4.7', reason: 'high-demand' }),
      'surfaced provider auto-switch notice',
    );
  });

  it('non-error result with text is still forwarded (no over-suppression)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    capturedOnEventRef.current!({ type: 'result', text: 'a genuine terminal reply', isError: false });
    await vi.waitFor(() => expect(mockQueue.enqueueResultText).toHaveBeenCalledWith('a genuine terminal reply'));
  });

  it('model-unavailable assistant_text is suppressed from streaming (single path)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    capturedOnEventRef.current!({
      type: 'assistant_text',
      text: "There's an issue with the selected model (m). It may not exist or you may not have access to it.",
    });
    expect(mockQueue.enqueueStreamingText).not.toHaveBeenCalled();
  });

  it('assistant_text after result event is suppressed (post-turn gate)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    // Complete the turn
    capturedOnEventRef.current!({ type: 'assistant_text', text: 'Hello' });
    capturedOnEventRef.current!({ type: 'result', text: null });
    await vi.waitFor(() => expect(mockQueue.flush).toHaveBeenCalled());

    // Reset mocks to isolate post-turn behavior
    mockQueue.enqueueStreamingText.mockClear();
    mockQueue.enqueueText.mockClear();
    mockQueue.enqueueResultText.mockClear();

    // SDK injects system-reminder, model reacts with assistant_text
    capturedOnEventRef.current!({ type: 'assistant_text', text: 'I am still working on this.' });

    // Post-turn gate should suppress this — nothing enqueued
    expect(mockQueue.enqueueStreamingText).not.toHaveBeenCalled();
    expect(mockQueue.enqueueText).not.toHaveBeenCalled();
    expect(mockQueue.enqueueResultText).not.toHaveBeenCalled();
  });

  it('post-turn gate clears when next user message arrives', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    // Complete turn 1
    capturedOnEventRef.current!({ type: 'assistant_text', text: 'Hello' });
    capturedOnEventRef.current!({ type: 'result', text: null });
    await vi.waitFor(() => expect(mockQueue.flush).toHaveBeenCalled());

    // Send a new user message — this should clear the gate
    mockQueue.enqueueStreamingText.mockClear();
    mockQueue.flush.mockClear();
    mockSession.sendTurn.mockClear();
    await runtime.handleMessage(makeMsg({ content: 'follow up' }));
    // Wait for the turn chain to settle — sendTurnNonShared runs async
    await vi.waitFor(() => expect(mockSession.sendTurn).toHaveBeenCalledWith('follow up'));

    // Now assistant_text for turn 2 should go through
    capturedOnEventRef.current!({ type: 'assistant_text', text: 'Turn 2 response' });
    expect(mockQueue.enqueueStreamingText).toHaveBeenCalledWith('Turn 2 response');
  });

  it('tool_use after result event is suppressed (post-turn gate)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    // Complete the turn
    capturedOnEventRef.current!({ type: 'assistant_text', text: 'Hello' });
    capturedOnEventRef.current!({ type: 'result', text: null });
    await vi.waitFor(() => expect(mockQueue.flush).toHaveBeenCalled());

    // Reset mocks
    mockQueue.enqueueToolUpdate.mockClear();

    // SDK phantom: model tries to use a tool post-turn
    capturedOnEventRef.current!({ type: 'tool_use', toolId: 'phantom-1', toolName: 'TodoWrite', toolInput: {} });

    // Should be suppressed
    expect(mockQueue.enqueueToolUpdate).not.toHaveBeenCalled();
    expect(mockEmitAlert).not.toHaveBeenCalled();
  });

  it('second result event after gate does not throw', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    capturedOnEventRef.current!({ type: 'assistant_text', text: 'Hello' });
    capturedOnEventRef.current!({ type: 'result', text: null });
    await vi.waitFor(() => expect(mockQueue.flush).toHaveBeenCalled());

    // Phantom result from SDK — should not throw
    expect(() => {
      capturedOnEventRef.current!({ type: 'result', text: null });
    }).not.toThrow();
  });

  it('per_chat: system-turn result does not arm the post-turn gate (real reply still delivered)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const state = runtime as unknown as {
      pendingSystemResults: { counts: Map<string, number> };
      postTurnGate: Set<string>;
    };
    const chatJid = '15550001111@s.whatsapp.net';

    await runtime.start();
    await sendAndDrain(runtime, makeMsg({ chatJid, senderJid: chatJid, content: 'hello', inboundSeq: 1 }));
    expect(capturedOnEventRef.current).toBeTypeOf('function');

    // A system turn is in flight (context injection on respawn, resume
    // continuation, or auto-compact /compact). Its result must NOT arm the
    // post-turn gate, otherwise the real user turn that follows is suppressed.
    state.pendingSystemResults.counts.set(chatJid, 1);
    capturedOnEventRef.current!({ type: 'result', text: null });

    expect(state.postTurnGate.has(chatJid)).toBe(false);

    // The real user turn's output that follows must be delivered, not gated.
    mockQueue.enqueueStreamingText.mockClear();
    capturedOnEventRef.current!({ type: 'assistant_text', text: 'Real reply' });
    expect(mockQueue.enqueueStreamingText).toHaveBeenCalledWith('Real reply');
  });

  it('per_chat: real user-turn result still arms the post-turn gate (phantom suppressed)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const state = runtime as unknown as { postTurnGate: Set<string> };
    const chatJid = '15550002222@s.whatsapp.net';

    await runtime.start();
    await sendAndDrain(runtime, makeMsg({ chatJid, senderJid: chatJid, content: 'hello', inboundSeq: 1 }));
    expect(capturedOnEventRef.current).toBeTypeOf('function');

    // No system result pending — this is a genuine user-turn completion.
    capturedOnEventRef.current!({ type: 'result', text: null });
    expect(state.postTurnGate.has(chatJid)).toBe(true);

    // SDK phantom output after a real turn is still suppressed.
    mockQueue.enqueueStreamingText.mockClear();
    capturedOnEventRef.current!({ type: 'assistant_text', text: 'phantom' });
    expect(mockQueue.enqueueStreamingText).not.toHaveBeenCalled();
  });

  it('single-mode: system-turn result does not arm the post-turn gate (real reply delivered)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    const state = runtime as unknown as {
      pendingSystemResults: { counts: Map<string, number> };
      postTurnGate: Set<string>;
    };

    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    // A system turn is in flight (single-mode auto-compact /compact is keyed by
    // the global scope). Its result must NOT arm the post-turn gate.
    state.pendingSystemResults.counts.set('__global__', 1);
    capturedOnEventRef.current!({ type: 'result', text: null });

    expect(state.postTurnGate.has('__global__')).toBe(false);

    // Real output that follows the system turn must be delivered, not gated.
    mockQueue.enqueueStreamingText.mockClear();
    capturedOnEventRef.current!({ type: 'assistant_text', text: 'Real reply' });
    expect(mockQueue.enqueueStreamingText).toHaveBeenCalledWith('Real reply');
  });

  it('per_chat: a failed context-injection send does not leak a pending system result', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const state = runtime as unknown as { pendingSystemResults: { counts: Map<string, number> } };
    const chatJid = '15550004444@s.whatsapp.net';

    // Recent messages exist, so a fresh (inactive) session triggers context
    // injection on the next turn.
    vi.mocked(getRecentMessages).mockReturnValue([
      {
        pk: 1,
        chatJid,
        conversationKey: 'k',
        senderJid: 'sender@s.whatsapp.net',
        senderName: 'Alice',
        messageId: 'm1',
        content: 'earlier message',
        contentType: 'text',
        isFromMe: false,
        timestamp: 1_700_000_000,
        quotedMessageId: null,
        enrichmentProcessedAt: null,
        enrichmentRetries: 0,
        createdAt: new Date().toISOString(),
        mediaPath: null,
        contentText: null,
      },
    ]);
    // Session is inactive so sendTurnToSession respawns and injects context;
    // make that injection sendTurn fail. The injection mark must be reversed.
    mockSession.getStatus.mockReturnValue({ active: false, pid: null, sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null });
    mockSession.sendTurn.mockRejectedValueOnce(new Error('inject send failed'));

    await runtime.start();
    await sendAndDrain(runtime, makeMsg({ chatJid, senderJid: chatJid, content: 'hello', inboundSeq: 1 }));

    // No stranded +1 — otherwise the next real user-turn result would be
    // misclassified as a system turn.
    expect(state.pendingSystemResults.counts.get(chatJid) ?? 0).toBe(0);
  });

  // QR-095: in single/shared mode the context-injection system turn must be
  // marked under GLOBAL_TOOL_SCOPE_KEY (the key the single/shared result handler
  // consumes), NOT under an undefined mapKey (which is a no-op → the injected
  // '[Recent chat context]' turn's result would be mis-classified as a USER turn
  // and leak to the user).
  it('single/shared: context-injection system turn is marked under the global scope (QR-095)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger); // single/shared (no sessionScope)
    const chatJid = '15550005555@s.whatsapp.net';
    const state = runtime as unknown as {
      pendingSystemResults: { mark: (k: string) => void };
    };

    vi.mocked(getRecentMessages).mockReturnValue([
      {
        pk: 1, chatJid, conversationKey: 'k', senderJid: 'sender@s.whatsapp.net',
        senderName: 'Alice', messageId: 'm1', content: 'earlier message', contentType: 'text',
        isFromMe: false, timestamp: 1_700_000_000, quotedMessageId: null,
        enrichmentProcessedAt: null, enrichmentRetries: 0, createdAt: new Date().toISOString(),
        mediaPath: null, contentText: null,
      },
    ]);
    // Inactive session → sendTurnToSession respawns and injects context.
    mockSession.getStatus.mockReturnValue({ active: false, pid: null, sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null });

    await runtime.start();
    const markSpy = vi.spyOn(state.pendingSystemResults, 'mark');
    await sendAndDrain(runtime, makeMsg({ chatJid, senderJid: chatJid, content: 'hello', inboundSeq: 1 }));

    const markedKeys = markSpy.mock.calls.map((c) => c[0]);
    // RED pre-fix: the injection marked `undefined` (a no-op → phantom leak).
    expect(markedKeys).not.toContain(undefined);
    // GREEN post-fix: marked under the global scope the single/shared handler consumes.
    expect(markedKeys).toContain('__global__');
  });

  it('shared-session: assistant_text after result is suppressed (post-turn gate)', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { shared: true });
    const queue = makeQueueMock('111@s.whatsapp.net');

    const state = runtime as unknown as {
      session: typeof mockSession;
      activeChatJid: string | null;
      currentTurnChatJid: string | null;
      turnHadVisibleOutput: boolean;
      outboundQueues: Map<string, IOutboundQueue>;
      handleEvent: (event: AgentEvent) => void;
    };
    state.session = Object.assign({}, mockSession, {
      getDbRowId: vi.fn(() => null),
      clearTurnWatchdog: vi.fn(),
    });
    state.activeChatJid = '111@s.whatsapp.net';
    state.currentTurnChatJid = '111@s.whatsapp.net';
    state.turnHadVisibleOutput = true;
    state.outboundQueues.set('111@s.whatsapp.net', queue);

    // Simulate a turn with text + result
    state.handleEvent({ type: 'assistant_text', text: 'Hello' });
    state.handleEvent({ type: 'result', text: null });

    // Reset mocks to isolate post-turn behavior
    (queue.enqueueStreamingText as ReturnType<typeof vi.fn>).mockClear();
    (queue.enqueueText as ReturnType<typeof vi.fn>).mockClear();

    // Phantom assistant_text after result — should be suppressed by gate
    state.handleEvent({ type: 'assistant_text', text: 'Phantom from SDK reminder' });

    expect(queue.enqueueStreamingText).not.toHaveBeenCalled();
    expect(queue.enqueueText).not.toHaveBeenCalled();
  });

  it('shared-session event switch handles init, AskUser fallthrough, compact, tool errors, and post-turn tool suppression', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { shared: true });
    const queue = makeQueueMock('111@s.whatsapp.net');
    const tracker = {
      onAnyActivity: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
      onTurnComplete: vi.fn(),
    };

    const state = runtime as unknown as {
      session: typeof mockSession;
      activeChatJid: string | null;
      currentTurnChatJid: string | null;
      outboundQueues: Map<string, IOutboundQueue>;
      operationTracker: typeof tracker;
      postTurnGate: Set<string>;
      singleTurnHadToolActivity: boolean;
      activeToolNames: Map<string, Map<string, string>>;
      handleEvent: (event: AgentEvent) => void;
    };
    state.session = Object.assign({}, mockSession, {
      tickWatchdog: vi.fn(),
      trackToolStart: vi.fn(),
      trackToolEnd: vi.fn(),
    });
    state.operationTracker = tracker;
    state.activeChatJid = '111@s.whatsapp.net';
    state.currentTurnChatJid = '111@s.whatsapp.net';
    state.outboundQueues.set('111@s.whatsapp.net', queue);

    state.handleEvent({ type: 'init', sessionId: 'shared-session-id' });
    expect(mockRuntimeLogger.debug).toHaveBeenCalledWith(
      { chatJid: '111@s.whatsapp.net', sessionId: 'shared-session-id' },
      'session init',
    );

    state.handleEvent({
      type: 'tool_use',
      toolId: 'ask-user-shared',
      toolName: 'AskUserQuestion',
      toolInput: { question: 'Pick one', options: ['A', 'B'] },
    });
    expect(state.singleTurnHadToolActivity).toBe(true);
    expect(queue.enqueueToolUpdate).toHaveBeenCalledWith(expect.objectContaining({
      category: expect.any(String),
    }));
    expect(tracker.onToolStart).toHaveBeenCalledWith(
      'ask-user-shared',
      'AskUserQuestion',
      expect.any(String),
    );

    state.handleEvent({ type: 'compact_boundary' });
    expect(queue.indicateTyping).toHaveBeenCalledTimes(1);
    expect(queue.enqueueText).toHaveBeenCalledWith(expect.stringContaining('Context compacted'));
    expect(tracker.onAnyActivity).toHaveBeenCalled();

    state.handleEvent({
      type: 'tool_result',
      toolId: 'ask-user-shared',
      isError: true,
      content: 'E'.repeat(240),
    });
    expect(queue.enqueueToolUpdate).toHaveBeenCalledWith(expect.objectContaining({
      category: 'error',
    }));
    expect(tracker.onToolEnd).toHaveBeenCalledWith('ask-user-shared');
    expect(state.activeToolNames.has('__global__')).toBe(false);

    (queue.enqueueToolUpdate as ReturnType<typeof vi.fn>).mockClear();
    state.postTurnGate.add('__global__');
    state.handleEvent({
      type: 'tool_use',
      toolId: 'phantom-tool',
      toolName: 'Bash',
      toolInput: { command: 'date' },
    });

    expect(queue.enqueueToolUpdate).not.toHaveBeenCalled();
    expect(mockRuntimeLogger.info).toHaveBeenCalledWith(
      { toolName: 'Bash' },
      'post-turn gate: suppressed phantom tool_use (shared)',
    );
  });

  it('singleton crash callback marks the active inbound failed and keeps heal-report failures contained', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    mockConfig.controlPeers.set('q', '15550100004');
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'single' });
    const durability = {
      markInboundFailed: vi.fn(),
    };
    const replyGuarantee = {
      disarm: vi.fn(),
      isArmed: vi.fn(() => false),
    };
    const state = runtime as unknown as {
      currentInboundSeq: number | undefined;
      durability: typeof durability;
      replyGuarantee: typeof replyGuarantee;
      ensureSessionAndQueueSync(chatJid: string): void;
    };
    state.durability = durability;
    state.replyGuarantee = replyGuarantee;
    state.currentInboundSeq = 77;

    state.ensureSessionAndQueueSync('crash-single@s.whatsapp.net');
    capturedOnCrashRef.current?.({
      exitCode: 1,
      signal: null,
      sessionId: 'session-crash',
      dbRowId: 12,
      provider: 'claude-cli',
      crashClass: 'boom',
      stderrPreview: 'stack trace',
    });

    expect(replyGuarantee.disarm).toHaveBeenCalledWith(77);
    expect(durability.markInboundFailed).toHaveBeenCalledWith(77);
    expect(state.currentInboundSeq).toBeUndefined();
    expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'failed to emit heal report for session crash',
    );

    mockRuntimeLogger.warn.mockClear();
    capturedOnCrashRef.current?.({
      exitCode: null,
      signal: null,
      sessionId: 'session-crash-null-exit',
      dbRowId: 13,
      provider: undefined,
      crashClass: undefined,
      stderrPreview: undefined,
    });

    expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'failed to emit heal report for session crash',
    );
  });

  it('startup-resumed shared crash callback marks the active inbound failed', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    mockConfig.controlPeers.set('q', '15550100004');
    mockGetActiveSession.mockReturnValue({
      id: 8,
      session_id: 'startup-shared-crash',
      chat_jid: 'startup-crash@s.whatsapp.net',
      claude_pid: 0,
      status: 'active',
      started_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      last_message_at: null,
      message_count: 0,
    });

    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'shared' });
    const durability = {
      getSessionCheckpoint: vi.fn(() => ({
        session_id: 'startup-shared-crash',
        updated_at: new Date(Date.now() - 5 * 60_000).toISOString().replace('Z', ''),
      })),
      upsertSessionCheckpoint: vi.fn(),
      markInboundFailed: vi.fn(),
    };
    const replyGuarantee = {
      disarm: vi.fn(),
      isArmed: vi.fn(() => false),
    };
    const state = runtime as unknown as {
      currentInboundSeq: number | undefined;
      durability: typeof durability;
      replyGuarantee: typeof replyGuarantee;
    };
    state.durability = durability;
    state.replyGuarantee = replyGuarantee;

    await runtime.start();
    state.currentInboundSeq = 88;
    capturedOnCrashRef.current?.({
      exitCode: 2,
      signal: 'SIGTERM',
      sessionId: 'startup-shared-crash',
      dbRowId: 8,
      provider: 'claude-cli',
      crashClass: 'boom',
      stderrPreview: 'startup trace',
    });

    expect(replyGuarantee.disarm).toHaveBeenCalledWith(88);
    expect(durability.markInboundFailed).toHaveBeenCalledWith(88);
    expect(state.currentInboundSeq).toBeUndefined();
    expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'failed to emit heal report for session crash',
    );

    mockRuntimeLogger.warn.mockClear();
    capturedOnCrashRef.current?.({
      exitCode: null,
      signal: null,
      sessionId: 'startup-shared-crash-null-exit',
      dbRowId: 9,
      provider: undefined,
      crashClass: undefined,
      stderrPreview: undefined,
    });

    expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'failed to emit heal report for session crash',
    );
  });

  it('tool_result with isError enqueues tool error update', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    capturedOnEventRef.current!({ type: 'tool_result', isError: true, toolId: 'test', content: 'error msg' });

    // classifyToolError uses content to determine error vs blocked.
    // toolName is 'unknown' here (no prior tool_use event), so detail is just the reason.
    expect(mockQueue.enqueueToolUpdate).toHaveBeenCalledWith({ category: 'error', detail: 'error msg' });
  });

  it('tool_result with isError emits a provider-wide BOT ERRORS alert', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const agentConfig = mockConfig as typeof mockConfig & { agentProvider?: string };
    agentConfig.agentProvider = 'claude-cli';
    const runtime = new AgentRuntime(db, messenger, 'ana-bot');
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    capturedOnEventRef.current!({
      type: 'tool_use',
      toolId: 'tool-1',
      toolName: 'Bash',
      toolInput: { command: 'npm test' },
    });
    // Operator-actionable signature (disk exhaustion) — exercises the alert path.
    capturedOnEventRef.current!({
      type: 'tool_result',
      isError: true,
      toolId: 'tool-1',
      content: 'ENOSPC: no space left on device\ntoken=plain-secret',
    });

    expect(mockEmitAlert).toHaveBeenCalledOnce();
    expect(mockEmitAlert).toHaveBeenCalledWith(
      'ana-bot',
      'runtime-tool-error:claude-cli:Bash',
      'Agent tool failure: Bash',
      expect.stringContaining('runtime_source=src/runtimes/agent/runtime.ts:tool_result'),
      'warning',
    );
    const evidence = mockEmitAlert.mock.calls[0]?.[3] as string;
    expect(evidence).toContain('provider=claude-cli');
    expect(evidence).toContain('chat_jid=test at s.whatsapp.net');
    expect(evidence).toContain('tool_id=tool-1');
    expect(evidence).toContain('tool_name=Bash');
    expect(evidence).toContain('classification=error');
    expect(evidence).toContain('error_excerpt:');
  });

  it('deduplicates repeated tool_result BOT ERRORS alerts in one runtime', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger, 'ana-bot');
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    capturedOnEventRef.current!({
      type: 'tool_use',
      toolId: 'tool-1',
      toolName: 'Bash',
      toolInput: { command: 'npm test' },
    });
    capturedOnEventRef.current!({
      type: 'tool_result',
      isError: true,
      toolId: 'tool-1',
      content: 'ENOSPC: no space left on device',
    });
    capturedOnEventRef.current!({
      type: 'tool_use',
      toolId: 'tool-2',
      toolName: 'Bash',
      toolInput: { command: 'npm test' },
    });
    capturedOnEventRef.current!({
      type: 'tool_result',
      isError: true,
      toolId: 'tool-2',
      content: 'ENOSPC: no space left on device',
    });

    expect(mockQueue.enqueueToolUpdate).toHaveBeenCalledTimes(4);
    expect(mockEmitAlert).toHaveBeenCalledOnce();
  });

  it('does NOT alert for benign agent-recoverable tool errors (noise gate)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger, 'ana-bot');
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    capturedOnEventRef.current!({
      type: 'tool_use',
      toolId: 'tool-1',
      toolName: 'Bash',
      toolInput: { command: 'grep -r needle .' },
    });
    // zsh glob no-match → claude-cli marks is_error, but it is normal agent flow.
    capturedOnEventRef.current!({
      type: 'tool_result',
      isError: true,
      toolId: 'tool-1',
      content: '(eval):1: no matches found: *statement*',
    });

    // The humanized ToolUpdate is still enqueued for the user/log…
    expect(mockQueue.enqueueToolUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'error' }),
    );
    // …but no operator alert fires.
    expect(mockEmitAlert).not.toHaveBeenCalled();
  });

  it('tool_result with isError=false does not enqueue anything', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' }));

    capturedOnEventRef.current!({ type: 'tool_result', isError: false, toolId: 'test', content: '' });

    expect(mockQueue.enqueueToolUpdate).not.toHaveBeenCalled();
  });

  // ─── Health snapshot ───────────────────────────────────────────────────────

  it('getHealthSnapshot returns healthy with session counts', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();

    const snap = runtime.getHealthSnapshot();
    expect(snap.status).toBe('healthy');
    expect(snap.details).toHaveProperty('active');
    expect(snap.details).toHaveProperty('pid');
    expect(snap.details).toHaveProperty('sessionId');
  });

  // ─── Shutdown ──────────────────────────────────────────────────────────────

  it('shutdown calls session.shutdown and queue.shutdown', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hi' })); // creates session + queue

    await runtime.shutdown();

    expect(mockSession.shutdown).toHaveBeenCalled();
    expect(mockQueue.shutdown).toHaveBeenCalled();
  });

  it('cleanupPerChatState removes all auxiliary per-chat state for one key only', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test');
    const state = getPerChatCleanupState(runtime);

    const targetKey = 'target@s.whatsapp.net';
    const otherKey = 'other@s.whatsapp.net';
    state.crashes.record(targetKey); state.crashes.record(targetKey);
    state.crashes.record(otherKey);
    state.perChatInboundSeqQueue.set(targetKey, [1, 2]);
    state.perChatInboundSeqQueue.set(otherKey, [3]);
    state.perChatTurnContentType.set(targetKey, 'audio');
    state.perChatTurnContentType.set(otherKey, 'text');
    state.perChatTurnText.set(targetKey, 'target text');
    state.perChatTurnText.set(otherKey, 'other text');
    state.perChatAssistantItemText.set(targetKey, new Map([['item-a', 'value-a']]));
    state.perChatAssistantItemText.set(otherKey, new Map([['item-b', 'value-b']]));
    state.pendingTurnText.set(targetKey, 'replay target');
    state.pendingTurnText.set(otherKey, 'replay other');
    state.resumeFailedHandling.add(targetKey);
    state.resumeFailedHandling.add(otherKey);

    state.cleanupPerChatState(targetKey);

    expect(state.crashes.count(targetKey)).toBe(0);
    expect(state.perChatInboundSeqQueue.has(targetKey)).toBe(false);
    expect(state.perChatTurnContentType.has(targetKey)).toBe(false);
    expect(state.perChatTurnText.has(targetKey)).toBe(false);
    expect(state.perChatAssistantItemText.has(targetKey)).toBe(false);
    expect(state.pendingTurnText.has(targetKey)).toBe(false);
    expect(state.resumeFailedHandling.has(targetKey)).toBe(false);

    expect(state.crashes.count(otherKey)).toBe(1);
    expect(state.perChatInboundSeqQueue.get(otherKey)).toEqual([3]);
    expect(state.perChatTurnContentType.get(otherKey)).toBe('text');
    expect(state.perChatTurnText.get(otherKey)).toBe('other text');
    expect(state.perChatAssistantItemText.get(otherKey)?.get('item-b')).toBe('value-b');
    expect(state.pendingTurnText.get(otherKey)).toBe('replay other');
    expect(state.resumeFailedHandling.has(otherKey)).toBe(true);
  });

  it('cleanupPerChatState is idempotent for missing keys', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test');
    const state = getPerChatCleanupState(runtime);

    const survivorKey = 'survivor@s.whatsapp.net';
    state.crashes.record(survivorKey); state.crashes.record(survivorKey);
    state.perChatInboundSeqQueue.set(survivorKey, [7]);
    state.perChatTurnContentType.set(survivorKey, 'text');
    state.perChatTurnText.set(survivorKey, 'still here');
    state.perChatAssistantItemText.set(survivorKey, new Map([['item', 'value']]));
    state.pendingTurnText.set(survivorKey, 'pending');
    state.resumeFailedHandling.add(survivorKey);

    expect(() => state.cleanupPerChatState('missing@s.whatsapp.net')).not.toThrow();

    expect(state.crashes.count(survivorKey)).toBe(2);
    expect(state.perChatInboundSeqQueue.get(survivorKey)).toEqual([7]);
    expect(state.perChatTurnContentType.get(survivorKey)).toBe('text');
    expect(state.perChatTurnText.get(survivorKey)).toBe('still here');
    expect(state.perChatAssistantItemText.get(survivorKey)?.get('item')).toBe('value');
    expect(state.pendingTurnText.get(survivorKey)).toBe('pending');
    expect(state.resumeFailedHandling.has(survivorKey)).toBe(true);
  });

  it('cleanupPerChatState marks buffered image seqs skipped before deleting the buffer', () => {
    vi.useFakeTimers();
    try {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test');
      const state = getPerChatCleanupState(runtime) as PerChatCleanupRuntimeState & {
        durability: { markInboundSkipped: ReturnType<typeof vi.fn> } | null;
      };
      const targetKey = 'target@s.whatsapp.net';
      const otherKey = 'other@s.whatsapp.net';
      const targetTimer = fakeTimerHandle('target-image-coalesce');
      const otherTimer = fakeTimerHandle('other-image-coalesce');
      const markInboundSkipped = vi.fn();
      state.durability = { markInboundSkipped };

      state.imageCoalesce.buffers.set(targetKey, {
        texts: ['img-a', 'img-b'],
        timer: targetTimer,
        msg: makeMsg({ chatJid: targetKey, contentType: 'image' }),
        inboundSeqs: [11, 12],
      });
      state.imageCoalesce.buffers.set(otherKey, {
        texts: ['other-img'],
        timer: otherTimer,
        msg: makeMsg({ chatJid: otherKey, contentType: 'image' }),
        inboundSeqs: [21],
      });

      state.cleanupPerChatState(targetKey);

      expect(state.imageCoalesce.buffers.has(targetKey)).toBe(false);
      expect(state.imageCoalesce.buffers.has(otherKey)).toBe(true);
      expect(markInboundSkipped).toHaveBeenCalledWith(11, 'cleanup_aborted');
      expect(markInboundSkipped).toHaveBeenCalledWith(12, 'cleanup_aborted');
      expect(markInboundSkipped).not.toHaveBeenCalledWith(21, 'cleanup_aborted');
    } finally {
      vi.useRealTimers();
    }
  });

  it('per_chat shutdown calls cleanupPerChatState for each chat key and clears auxiliary maps', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const state = runtime as unknown as PerChatCleanupRuntimeState & {
      chatSessions: Map<string, { shutdown: () => Promise<void> }>;
      chatQueues: Map<string, IOutboundQueue>;
      cleanupPerChatState: (mapKey: string) => void;
    };

    state.chatSessions.set('chat-a', { shutdown: vi.fn(async () => {}) });
    state.chatSessions.set('chat-b', { shutdown: vi.fn(async () => {}) });
    state.chatQueues.set('chat-a', makeQueueMock('chat-a@s.whatsapp.net'));
    state.chatQueues.set('chat-b', makeQueueMock('chat-b@s.whatsapp.net'));
    state.crashes.record('chat-a');
    state.crashes.record('chat-b'); state.crashes.record('chat-b');
    state.perChatInboundSeqQueue.set('chat-a', [1]);
    state.perChatInboundSeqQueue.set('chat-b', [2]);
    state.perChatTurnContentType.set('chat-a', 'text');
    state.perChatTurnContentType.set('chat-b', 'audio');
    state.perChatTurnText.set('chat-a', 'reply-a');
    state.perChatTurnText.set('chat-b', 'reply-b');
    state.perChatAssistantItemText.set('chat-a', new Map([['item-a', 'value-a']]));
    state.perChatAssistantItemText.set('chat-b', new Map([['item-b', 'value-b']]));
    state.pendingTurnText.set('chat-a', 'pending-a');
    state.pendingTurnText.set('chat-b', 'pending-b');
    state.resumeFailedHandling.add('chat-a');
    state.resumeFailedHandling.add('chat-b');

    const originalCleanup = state.cleanupPerChatState.bind(runtime as unknown as object);
    const cleanupCalls: string[] = [];
    state.cleanupPerChatState = ((mapKey: string) => {
      cleanupCalls.push(mapKey);
      originalCleanup(mapKey);
    }) as typeof state.cleanupPerChatState;

    await runtime.shutdown();

    expect(cleanupCalls).toEqual(['chat-a', 'chat-b']);
    expect(state.crashes.size).toBe(0);
    expect(state.perChatInboundSeqQueue.size).toBe(0);
    expect(state.perChatTurnContentType.size).toBe(0);
    expect(state.perChatTurnText.size).toBe(0);
    expect(state.perChatAssistantItemText.size).toBe(0);
    expect(state.pendingTurnText.size).toBe(0);
    expect(state.resumeFailedHandling.size).toBe(0);
  });

  it('per_chat shutdown runs session shutdown before cleanupPerChatState for each key', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const state = runtime as unknown as PerChatCleanupRuntimeState & {
      chatSessions: Map<string, { shutdown: () => Promise<void> }>;
      chatQueues: Map<string, IOutboundQueue>;
      cleanupPerChatState: (mapKey: string) => void;
    };
    const order: string[] = [];

    const makeSession = (mapKey: string) => ({
      shutdown: vi.fn(async () => {
        order.push(`session:${mapKey}`);
        expect(state.pendingTurnText.get(mapKey)).toBe(`${mapKey}-pending`);
        expect(state.resumeFailedHandling.has(mapKey)).toBe(true);
      }),
    });

    state.chatSessions.set('chat-a', makeSession('chat-a'));
    state.chatSessions.set('chat-b', makeSession('chat-b'));
    state.chatQueues.set('chat-a', makeQueueMock('chat-a@s.whatsapp.net'));
    state.chatQueues.set('chat-b', makeQueueMock('chat-b@s.whatsapp.net'));
    state.pendingTurnText.set('chat-a', 'chat-a-pending');
    state.pendingTurnText.set('chat-b', 'chat-b-pending');
    state.resumeFailedHandling.add('chat-a');
    state.resumeFailedHandling.add('chat-b');

    const originalCleanup = state.cleanupPerChatState.bind(runtime as unknown as object);
    state.cleanupPerChatState = ((mapKey: string) => {
      order.push(`cleanup:${mapKey}`);
      originalCleanup(mapKey);
    }) as typeof state.cleanupPerChatState;

    await runtime.shutdown();

    expect(order.indexOf('session:chat-a')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('session:chat-b')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('cleanup:chat-a')).toBeGreaterThan(order.indexOf('session:chat-a'));
    expect(order.indexOf('cleanup:chat-b')).toBeGreaterThan(order.indexOf('session:chat-b'));
  });

  it('shutdown continues cleanup after individual failures and clears runtime state', async () => {
    vi.useFakeTimers();
    try {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger);
      const sessionShutdown = vi.fn(async () => {
        throw new Error('session boom');
      });
      const queue = makeQueueMock('test@s.whatsapp.net');
      const queueShutdown = vi.fn(async () => {});
      queue.shutdown = queueShutdown;
      const globalSocketStop = vi.fn(() => {
        throw new Error('global socket boom');
      });
      const workspaceSocketStopA = vi.fn(() => {
        throw new Error('workspace socket boom');
      });
      const workspaceMediaStopA = vi.fn(() => {
        throw new Error('workspace media boom');
      });
      const workspaceSocketStopB = vi.fn();
      const workspaceMediaStopB = vi.fn();
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
      const timeout = fakeTimerHandle('control-session');
      const imageTimer = fakeTimerHandle('shutdown-image-coalesce');
      const markInboundSkipped = vi.fn();

      const runtimeState = runtime as unknown as {
        session: { shutdown: () => Promise<void> } | null;
        queue: IOutboundQueue | null;
        globalSocketServer: { stop: () => void } | null;
        workspaceResources: Map<string, {
          socketPath: string;
          workspacePath: string;
          socketServer: { stop: () => void } | null;
          mediaBridge: (() => void) | null;
          lastActivity: number;
        }>;
        controlSessionTimeout: ReturnType<typeof setTimeout> | null;
        activeToolNames: Map<string, Map<string, string>>;
        perChatInboundSeqQueue: Map<string, number[]>;
        perChatTurnContentType: Map<string, string>;
        perChatTurnText: Map<string, string>;
        perChatAssistantItemText: Map<string, Map<string, string>>;
        pendingTurnText: Map<string, string>;
        resumeFailedHandling: Set<string>;
        imageCoalesce: ImageCoalescerView;
        durability: { markInboundSkipped: ReturnType<typeof vi.fn> } | null;
      };

      runtimeState.session = { shutdown: sessionShutdown };
      runtimeState.queue = queue;
      runtimeState.globalSocketServer = { stop: globalSocketStop };
      runtimeState.workspaceResources = new Map([
        ['chat-a', {
          socketPath: '/tmp/a.sock',
          workspacePath: '/tmp/a',
          socketServer: { stop: workspaceSocketStopA },
          mediaBridge: workspaceMediaStopA,
          lastActivity: Date.now(),
        }],
        ['chat-b', {
          socketPath: '/tmp/b.sock',
          workspacePath: '/tmp/b',
          socketServer: { stop: workspaceSocketStopB },
          mediaBridge: workspaceMediaStopB,
          lastActivity: Date.now(),
        }],
      ]);
      runtimeState.controlSessionTimeout = timeout;
      runtimeState.durability = { markInboundSkipped };
      runtimeState.activeToolNames.set('scope', new Map([['tool-1', 'Read']]));
      runtimeState.perChatInboundSeqQueue.set('chat-a', [1]);
      runtimeState.perChatTurnContentType.set('chat-a', 'text');
      runtimeState.perChatTurnText.set('chat-a', 'reply');
      runtimeState.perChatAssistantItemText.set('chat-a', new Map([['item-1', 'chunk']]));
      runtimeState.pendingTurnText.set('chat-a', 'hello');
      runtimeState.resumeFailedHandling.add('chat-a');
      runtimeState.imageCoalesce.buffers.set('chat-a', {
        texts: ['image-a'],
        timer: imageTimer,
        msg: makeMsg({ chatJid: 'chat-a@s.whatsapp.net', contentType: 'image' }),
        inboundSeqs: [31],
      });

      await expect(runtime.shutdown()).resolves.toBeUndefined();

      expect(sessionShutdown).toHaveBeenCalledTimes(1);
      expect(queueShutdown).toHaveBeenCalledTimes(1);
      expect(globalSocketStop).toHaveBeenCalledTimes(1);
      expect(workspaceSocketStopA).toHaveBeenCalledTimes(1);
      expect(workspaceMediaStopA).toHaveBeenCalledTimes(1);
      expect(workspaceSocketStopB).toHaveBeenCalledTimes(1);
      expect(workspaceMediaStopB).toHaveBeenCalledTimes(1);
      expect(clearTimeoutSpy).toHaveBeenCalledWith(timeout);
      expect(runtimeState.session).toBeNull();
      expect(runtimeState.queue).toBeNull();
      expect(runtimeState.globalSocketServer).toBeNull();
      expect(runtimeState.controlSessionTimeout).toBeNull();
      expect(runtimeState.workspaceResources.size).toBe(0);
      expect(runtimeState.activeToolNames.size).toBe(0);
      expect(runtimeState.perChatInboundSeqQueue.size).toBe(0);
      expect(runtimeState.perChatTurnContentType.size).toBe(0);
      expect(runtimeState.perChatTurnText.size).toBe(0);
      expect(runtimeState.perChatAssistantItemText.size).toBe(0);
      expect(runtimeState.pendingTurnText.size).toBe(0);
      expect(runtimeState.resumeFailedHandling.size).toBe(0);
      expect(runtimeState.imageCoalesce.buffers.size).toBe(0);
      expect(markInboundSkipped).toHaveBeenCalledWith(31, 'cleanup_aborted');
    } finally {
      vi.useRealTimers();
    }
  });

  it('per_chat crash cleanup scopes tool-state to the crashing mapKey (does not stomp other chats)', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const state = runtime as unknown as {
      activeToolNames: Map<string, Map<string, string>>;
      turnHadToolActivity: Set<string>;
      cleanupPerChatCrashTurnState: (mapKey: string) => void;
    };
    // Two concurrent chats each have in-flight tool state (scope keys are `${mapKey}#${ordinal}`).
    state.activeToolNames.set('chat-a#1', new Map([['t1', 'Read']]));
    state.activeToolNames.set('chat-b#1', new Map([['t2', 'Bash']]));
    state.turnHadToolActivity.add('chat-a#1');
    state.turnHadToolActivity.add('chat-b#1');

    // chat-a crashes — only chat-a's scope must be cleared; chat-b is mid-turn.
    state.cleanupPerChatCrashTurnState('chat-a');

    expect(state.activeToolNames.has('chat-a#1')).toBe(false);
    expect(state.turnHadToolActivity.has('chat-a#1')).toBe(false);
    expect(state.activeToolNames.has('chat-b#1')).toBe(true);
    expect(state.turnHadToolActivity.has('chat-b#1')).toBe(true);
  });

  it('shutdown clears pending auto-respawn timers before per_chat session cleanup', async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
    try {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const sessionShutdown = vi.fn(async () => {});
      const session = {
        ...mockSession,
        shutdown: sessionShutdown,
        spawnSession: vi.fn(async () => {}),
        getStatus: vi.fn(() => ({
          active: false,
          pid: null,
          sessionId: null,
          startedAt: null,
          messageCount: 0,
          lastMessageAt: null,
        })),
      };
      const queue = makeQueueMock('chat-a@s.whatsapp.net');
      const runtimeState = runtime as unknown as {
        chatSessions: Map<string, typeof session>;
        chatQueues: Map<string, IOutboundQueue>;
        pendingRespawnTimers?: Set<ReturnType<typeof setTimeout>>;
        handlePerChatCrash: (
          mapKey: string,
          chatJid?: string,
          info?: { exitCode: number | null; signal: NodeJS.Signals | null; sessionId: string | null; dbRowId: number | null },
        ) => void;
      };

      runtimeState.chatSessions.set('chat-a', session);
      runtimeState.chatQueues.set('chat-a', queue);

      runtimeState.handlePerChatCrash('chat-a', 'chat-a@s.whatsapp.net', {
        exitCode: 1,
        signal: null,
        sessionId: 'sess-1',
        dbRowId: 42,
      });

      const [pendingTimer] = Array.from(runtimeState.pendingRespawnTimers ?? []);
      expect(pendingTimer).toBeDefined();

      await runtime.shutdown();

      expect(clearTimeoutSpy).toHaveBeenCalledWith(pendingTimer);
      expect(runtimeState.pendingRespawnTimers?.size ?? 0).toBe(0);
      expect(clearTimeoutSpy.mock.invocationCallOrder[0]).toBeLessThan(sessionShutdown.mock.invocationCallOrder[0]);
    } finally {
      clearTimeoutSpy.mockRestore();
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('emits periodic health stats every 60s and stops after shutdown', async () => {
    vi.useFakeTimers();
    try {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test');
      await runtime.start();

      const runtimeState = runtime as unknown as {
        chatSessions: Map<string, unknown>;
        chatQueues: Map<string, unknown>;
        outboundQueues: Map<string, unknown>;
        workspaceResources: Map<string, {
          socketPath: string;
          workspacePath: string;
          socketServer: { stop: () => void } | null;
          mediaBridge: (() => void) | null;
          lastActivity: number;
        }>;
        healthStatsTimer: ReturnType<typeof setInterval> | null;
      };

      runtimeState.chatSessions.set('chat-a', mockSession);
      runtimeState.chatSessions.set('chat-b', mockSession);
      runtimeState.chatQueues.set('chat-a', makeQueueMock('chat-a@s.whatsapp.net'));
      runtimeState.outboundQueues.set('shared-a', makeQueueMock('shared-a@s.whatsapp.net'));
      runtimeState.workspaceResources.set('workspace-a', {
        socketPath: '/tmp/a.sock',
        workspacePath: '/tmp/a',
        socketServer: null,
        mediaBridge: null,
        lastActivity: Date.now(),
      });

      mockRuntimeLogger.info.mockClear();

      await vi.advanceTimersByTimeAsync(59_000);
      expect(mockRuntimeLogger.info).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);

      expect(mockRuntimeLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          instanceName: 'test',
          sessionScope: 'single',
          chatSessions: 2,
          chatQueues: 1,
          outboundQueues: 1,
          workspaceResources: 1,
          fdCount: 3,
          memoryUsage: expect.objectContaining({
            rss: expect.any(Number),
            heapTotal: expect.any(Number),
            heapUsed: expect.any(Number),
            external: expect.any(Number),
            arrayBuffers: expect.any(Number),
          }),
        }),
        'agent runtime health stats',
      );

      mockRuntimeLogger.info.mockClear();
      await runtime.shutdown();

      expect(runtimeState.healthStatsTimer).toBeNull();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(
        mockRuntimeLogger.info.mock.calls.some((call) => call[1] === 'agent runtime health stats'),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shared sweepIdleQueues evicts idle outbound queues and shuts them down', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'loops', { shared: true });
    const staleQueue = Object.assign(makeQueueMock('idle@s.whatsapp.net'), {
      lastActivity: Date.now() - (61 * 60_000),
      hasPendingWork: vi.fn(() => false),
      shutdown: vi.fn(async () => {}),
    });
    const runtimeState = runtime as unknown as {
      outboundQueues: Map<string, typeof staleQueue>;
      sweepIdleQueues: () => void;
    };

    runtimeState.outboundQueues.set('idle@s.whatsapp.net', staleQueue);

    runtimeState.sweepIdleQueues();

    expect(staleQueue.shutdown).toHaveBeenCalledTimes(1);
    expect(runtimeState.outboundQueues.has('idle@s.whatsapp.net')).toBe(false);
  });

  it('shared sweepIdleQueues preserves recently active outbound queues', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'loops', { shared: true });
    const activeQueue = Object.assign(makeQueueMock('active@s.whatsapp.net'), {
      lastActivity: Date.now() - (5 * 60_000),
      hasPendingWork: vi.fn(() => false),
      shutdown: vi.fn(async () => {}),
    });
    const runtimeState = runtime as unknown as {
      outboundQueues: Map<string, typeof activeQueue>;
      sweepIdleQueues: () => void;
    };

    runtimeState.outboundQueues.set('active@s.whatsapp.net', activeQueue);

    runtimeState.sweepIdleQueues();

    expect(activeQueue.shutdown).not.toHaveBeenCalled();
    expect(runtimeState.outboundQueues.has('active@s.whatsapp.net')).toBe(true);
  });

  it('shared sweepIdleQueues preserves queues with pending work even if idle', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'loops', { shared: true });
    const busyQueue = Object.assign(makeQueueMock('busy@s.whatsapp.net'), {
      lastActivity: Date.now() - (2 * 60 * 60_000),
      hasPendingWork: vi.fn(() => true),
      shutdown: vi.fn(async () => {}),
    });
    const runtimeState = runtime as unknown as {
      outboundQueues: Map<string, typeof busyQueue>;
      sweepIdleQueues: () => void;
    };

    runtimeState.outboundQueues.set('busy@s.whatsapp.net', busyQueue);

    runtimeState.sweepIdleQueues();

    expect(busyQueue.shutdown).not.toHaveBeenCalled();
    expect(runtimeState.outboundQueues.has('busy@s.whatsapp.net')).toBe(true);
  });

  it('shared ensureOutboundQueue recreates an evicted outbound queue on demand', async () => {
    const { OutboundQueue: MockOutboundQueueCtor } = await import('../../../src/runtimes/agent/outbound-queue.ts');
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'loops', { shared: true });
    const runtimeState = runtime as unknown as {
      ensureOutboundQueue: (chatJid: string) => void;
      outboundQueues: Map<string, IOutboundQueue>;
    };

    runtimeState.ensureOutboundQueue('recreated@s.whatsapp.net');

    expect(runtimeState.outboundQueues.has('recreated@s.whatsapp.net')).toBe(true);
    expect(MockOutboundQueueCtor).toHaveBeenCalledWith(messenger, 'recreated@s.whatsapp.net');
  });

  it('shared createOutboundQueue inherits the prior queue token for the same chat (QR-069)', async () => {
    const { OutboundQueue: MockOutboundQueueCtor } = await import('../../../src/runtimes/agent/outbound-queue.ts');
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'loops', { shared: true });
    const runtimeState = runtime as unknown as {
      createOutboundQueue: (chatJid: string, reason: string) => unknown;
      outboundQueues: Map<string, IOutboundQueue>;
    };

    // Seed a prior queue for the chat exposing a known echo-guard token. A
    // replacement built by createOutboundQueue must INHERIT it (3-arg ctor),
    // so the predecessor's still-active group cooldown does not flood-suppress
    // the replacement's first reply.
    const priorToken = 'inherited-token-qr069';
    runtimeState.outboundQueues.set('inherit@s.whatsapp.net', {
      getSenderToken: () => priorToken,
    } as unknown as IOutboundQueue);

    runtimeState.createOutboundQueue('inherit@s.whatsapp.net', 'test replacement');

    expect(MockOutboundQueueCtor).toHaveBeenCalledWith(messenger, 'inherit@s.whatsapp.net', priorToken);
  });

  it('shared queue sweep timer is started with the runtime and cleared on shutdown', async () => {
    vi.useFakeTimers();
    try {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'loops', { shared: true });
      const runtimeState = runtime as unknown as {
        queueSweepTimer: ReturnType<typeof setInterval> | null;
      };

      await runtime.start();
      expect(runtimeState.queueSweepTimer).not.toBeNull();

      await runtime.shutdown();
      expect(runtimeState.queueSweepTimer).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sandboxPerChat sweepIdleWorkspaces evicts idle workspace resources', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const sandbox = { allowedPaths: ['/fake'], allowedTools: [], bash: { enabled: false } };
    const runtime = new AgentRuntime(db, messenger, 'sandbox', {
      sessionScope: 'per_chat',
      sandboxPerChat: true,
      sandbox,
      cwd: tmpdir(),
    });
    const socketStop = vi.fn();
    const mediaBridgeStop = vi.fn();
    const runtimeState = runtime as unknown as {
      workspaceResources: Map<string, {
        socketPath: string;
        workspacePath: string;
        socketServer: { stop: () => void } | null;
        mediaBridge: (() => void) | null;
        lastActivity: number;
      }>;
      workspaceSweeper: { sweep: () => void };
    };

    runtimeState.workspaceResources.set('chat-a', {
      socketPath: '/tmp/a.sock',
      workspacePath: '/tmp/a',
      socketServer: { stop: socketStop },
      mediaBridge: mediaBridgeStop,
      lastActivity: Date.now() - (31 * 60_000),
    });

    runtimeState.workspaceSweeper.sweep();

    expect(socketStop).toHaveBeenCalledTimes(1);
    expect(mediaBridgeStop).toHaveBeenCalledTimes(1);
    expect(runtimeState.workspaceResources.has('chat-a')).toBe(false);
  });

  it('sandboxPerChat sweepIdleWorkspaces preserves active chat sessions and refreshes lastActivity', () => {
    vi.useFakeTimers();
    try {
      const now = new Date('2026-04-06T16:00:00.000Z');
      vi.setSystemTime(now);

      const db = makeDb();
      const { messenger } = makeMessenger();
      const sandbox = { allowedPaths: ['/fake'], allowedTools: [], bash: { enabled: false } };
      const runtime = new AgentRuntime(db, messenger, 'sandbox', {
        sessionScope: 'per_chat',
        sandboxPerChat: true,
        sandbox,
        cwd: tmpdir(),
      });
      const socketStop = vi.fn();
      const mediaBridgeStop = vi.fn();
      const runtimeState = runtime as unknown as {
        chatSessions: Map<string, { getStatus: () => { active: boolean } }>;
        workspaceResources: Map<string, {
          socketPath: string;
          workspacePath: string;
          socketServer: { stop: () => void } | null;
          mediaBridge: (() => void) | null;
          lastActivity: number;
        }>;
        workspaceSweeper: { sweep: () => void };
      };

      runtimeState.chatSessions.set('chat-a', {
        getStatus: () => ({ active: true }),
      });
      runtimeState.workspaceResources.set('chat-a', {
        socketPath: '/tmp/a.sock',
        workspacePath: '/tmp/a',
        socketServer: { stop: socketStop },
        mediaBridge: mediaBridgeStop,
        lastActivity: Date.now() - (60 * 60_000),
      });

      runtimeState.workspaceSweeper.sweep();

      const entry = runtimeState.workspaceResources.get('chat-a');
      expect(entry).toBeDefined();
      expect(entry?.lastActivity).toBe(now.getTime());
      expect(socketStop).not.toHaveBeenCalled();
      expect(mediaBridgeStop).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sandboxPerChat recreates workspace resources on the next message after eviction', async () => {
    const { WhatSoupSocketServer: MockSocketServer } = await import('../../../src/mcp/socket-server.ts');
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockChatJidToWorkspace.mockImplementation((_instanceCwd: string, _chatJid: string) => ({
      kind: 'dm' as const,
      workspaceKey: '15550100001',
      workspacePath: '/tmp/15550100001',
    }));

    const sandbox = { allowedPaths: ['/fake'], allowedTools: [], bash: { enabled: false } };
    const runtime = new AgentRuntime(db, messenger, 'sandbox', {
      sessionScope: 'per_chat',
      sandboxPerChat: true,
      sandbox,
      cwd: tmpdir(),
    });
    await runtime.start();

    await sendAndDrain(runtime, makeMsg({ chatJid: '15550100001@s.whatsapp.net', content: 'hello' }));

    const runtimeState = runtime as unknown as {
      workspaceResources: Map<string, unknown>;
      chatSessions: Map<string, unknown>;
      chatQueues: Map<string, unknown>;
    };

    runtimeState.workspaceResources.clear();
    runtimeState.chatSessions.clear();
    runtimeState.chatQueues.clear();
    mockSocketServerInstance.start.mockClear();
    (MockSocketServer as unknown as ReturnType<typeof vi.fn>).mockClear();

    await sendAndDrain(runtime, makeMsg({
      messageId: 'msg-2',
      chatJid: '15550100001@s.whatsapp.net',
      content: 'hello again',
    }));

    expect(runtimeState.workspaceResources.has('15550100001')).toBe(true);
    expect(MockSocketServer).toHaveBeenCalledTimes(1);
    expect(mockSocketServerInstance.start).toHaveBeenCalledTimes(1);
  });

  it('sandboxPerChat refreshes workspace lastActivity on turn completion', async () => {
    vi.useFakeTimers();
    try {
      const firstTurnAt = new Date('2026-04-06T15:00:00.000Z');
      const resultAt = new Date('2026-04-06T15:10:00.000Z');
      vi.setSystemTime(firstTurnAt);

      const db = makeDb();
      const { messenger } = makeMessenger();
      mockChatJidToWorkspace.mockImplementation((_instanceCwd: string, _chatJid: string) => ({
        kind: 'dm' as const,
        workspaceKey: '15550100001',
        workspacePath: '/tmp/15550100001',
      }));

      const sandbox = { allowedPaths: ['/fake'], allowedTools: [], bash: { enabled: false } };
      const runtime = new AgentRuntime(db, messenger, 'sandbox', {
        sessionScope: 'per_chat',
        sandboxPerChat: true,
        sandbox,
        cwd: tmpdir(),
      });
      await runtime.start();

      await sendAndDrain(runtime, makeMsg({ chatJid: '15550100001@s.whatsapp.net', content: 'hello' }));

      const runtimeState = runtime as unknown as {
        workspaceResources: Map<string, {
          socketPath: string;
          workspacePath: string;
          socketServer: { stop: () => void } | null;
          mediaBridge: (() => void) | null;
          lastActivity: number;
        }>;
      };

      const entry = runtimeState.workspaceResources.get('15550100001');
      expect(entry).toBeDefined();
      entry!.lastActivity = firstTurnAt.getTime() - (31 * 60_000);

      vi.setSystemTime(resultAt);
      capturedOnEventRef.current?.({ type: 'result', text: 'done' });

      expect(runtimeState.workspaceResources.get('15550100001')?.lastActivity).toBe(resultAt.getTime());
    } finally {
      vi.useRealTimers();
    }
  });

  it('sandboxPerChat workspace sweep timer is started with the runtime and cleared on shutdown', async () => {
    vi.useFakeTimers();
    try {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const sandbox = { allowedPaths: ['/fake'], allowedTools: [], bash: { enabled: false } };
      const runtime = new AgentRuntime(db, messenger, 'sandbox', {
        sessionScope: 'per_chat',
        sandboxPerChat: true,
        sandbox,
        cwd: tmpdir(),
      });
      const runtimeState = runtime as unknown as {
        workspaceSweeper: { timer: ReturnType<typeof setInterval> | null };
      };

      await runtime.start();
      expect(runtimeState.workspaceSweeper.timer).not.toBeNull();

      await runtime.shutdown();
      expect(runtimeState.workspaceSweeper.timer).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // ─── Session resume ────────────────────────────────────────────────────────

  it('start() with resumable session — spawns with resume and sets pending startup message', async () => {
    const db = makeDb();
    const { messenger, sentMessages } = makeMessenger();

    mockGetActiveSession.mockReturnValue({
      id: 1,
      session_id: 'sess-123',
      chat_jid: 'user@s.whatsapp.net',
      claude_pid: 0,
      status: 'active',
      started_at: new Date(Date.now() - 120_000).toISOString(),
      last_message_at: null,
      message_count: 0,
    });

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();

    expect(mockSession.spawnSession).toHaveBeenCalledWith('sess-123', 1);
    // start() defers the message via pendingStartupMessage (main.ts pops it after WA connects)
    expect(sentMessages).toHaveLength(0);
    const pending = runtime.popStartupMessage();
    expect(pending).not.toBeNull();
    expect(pending!.chatJid).toBe('user@s.whatsapp.net');
    expect(pending!.text).toContain('Resuming');
  });

  it('resume failure — sends expiry message and spawns fresh session', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockGetActiveSession.mockReturnValue({
      id: 1,
      session_id: 'sess-expired',
      chat_jid: 'user@s.whatsapp.net',
      claude_pid: 0,
      status: 'active',
      started_at: new Date(Date.now() - 1_800_000).toISOString(),
      last_message_at: null,
      message_count: 0,
    });

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();

    // Pop the pending startup message to simulate WA connecting
    runtime.popStartupMessage();

    // Simulate SessionManager calling onResumeFailed (WA is now connected)
    expect(capturedOnResumeFailedRef.current).not.toBeNull();
    capturedOnResumeFailedRef.current!();

    // Should enqueue the expiry message through the queue (WA connected, pending already popped)
    await vi.waitFor(() => {
      const enqueuedTexts = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
      expect(enqueuedTexts.some((t) => t.includes('expired'))).toBe(true);
      expect(enqueuedTexts.some((t) => t.includes('fresh'))).toBe(true);
    });

    // Should spawn a fresh session (no resume ID)
    // spawnSession called once for the initial resume attempt, then once fresh
    expect(mockSession.spawnSession).toHaveBeenCalledTimes(2);
    expect(mockSession.spawnSession).toHaveBeenLastCalledWith();
  });

  it('resume failure before WA connects — overrides pending startup message', async () => {
    const db = makeDb();
    const { messenger, sentMessages } = makeMessenger();

    mockGetActiveSession.mockReturnValue({
      id: 1,
      session_id: 'sess-expired',
      chat_jid: 'user@s.whatsapp.net',
      claude_pid: 0,
      status: 'active',
      started_at: new Date(Date.now() - 1_800_000).toISOString(),
      last_message_at: null,
      message_count: 0,
    });

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();

    // Don't pop — simulate failure before WA connects
    capturedOnResumeFailedRef.current!();

    // Should NOT have sent directly (WA not connected)
    expect(sentMessages).toHaveLength(0);

    // The pending message should now be the expiry message (not the resume message)
    const pending = runtime.popStartupMessage();
    expect(pending).not.toBeNull();
    expect(pending!.text).toContain('expired');
    expect(pending!.text).not.toContain('Resuming');
  });

  it('start() with no active session — no spawn, no message', async () => {
    const db = makeDb();
    const { messenger, sentMessages } = makeMessenger();

    mockGetActiveSession.mockReturnValue(null);

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();

    expect(mockSession.spawnSession).not.toHaveBeenCalled();
    expect(sentMessages).toHaveLength(0);
  });

  it('start() with active session but no session_id — no resume', async () => {
    const db = makeDb();
    const { messenger, sentMessages } = makeMessenger();

    mockGetActiveSession.mockReturnValue({
      id: 1,
      session_id: null,
      chat_jid: 'user@s.whatsapp.net',
      claude_pid: 0,
      status: 'active',
      started_at: new Date(Date.now() - 60_000).toISOString(),
      last_message_at: null,
      message_count: 0,
    });

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();

    expect(mockSession.spawnSession).not.toHaveBeenCalled();
    expect(sentMessages).toHaveLength(0);
  });

  // ─── P3-C: resume failure with recent messages injects CONTEXT RECOVERY ──────

  it('resume failure — sendTurn called with CONTEXT RECOVERY prefix when messages exist', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockGetActiveSession.mockReturnValue({
      id: 1,
      session_id: 'sess-expired',
      chat_jid: 'user@s.whatsapp.net',
      claude_pid: 0,
      status: 'active',
      started_at: new Date(Date.now() - 1_800_000).toISOString(),
      last_message_at: null,
      message_count: 0,
    });

    // Provide mock recent messages
    vi.mocked(getRecentMessages).mockReturnValue([
      {
        pk: 1,
        chatJid: 'user@s.whatsapp.net',
        conversationKey: 'user_at_s.whatsapp.net',
        senderJid: 'sender@s.whatsapp.net',
        senderName: 'Alice',
        messageId: 'msg-1',
        content: 'Hello there',
        contentType: 'text',
        isFromMe: false,
        timestamp: 1_700_000_000,
        quotedMessageId: null,
        enrichmentProcessedAt: null,
        enrichmentRetries: 0,
        createdAt: new Date().toISOString(),
        mediaPath: null,
        contentText: null,
      },
    ]);

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    runtime.popStartupMessage();

    capturedOnResumeFailedRef.current!();

    let contextCall: [string] | undefined;
    await vi.waitFor(() => {
      const sendTurnCalls = mockSession.sendTurn.mock.calls as unknown as [string][];
      contextCall = sendTurnCalls.find((args) =>
        args[0].includes('CONTEXT RECOVERY'),
      );
      expect(contextCall).toBeDefined();
    });
    expect(contextCall).toBeDefined();
    expect(contextCall![0]).toContain('Alice');
  });

  it('/new creates a fresh OutboundQueue to isolate sessions', async () => {
    const { OutboundQueue: MockOutboundQueueCtor } = await import('../../../src/runtimes/agent/outbound-queue.ts');
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await sendAndDrain(runtime, makeMsg({ content: 'hi' }));

    const constructorCallsBefore = (MockOutboundQueueCtor as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

    mockSession.getStatus.mockReturnValue({ active: false, pid: null, sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null });
    await sendAndDrain(runtime, makeMsg({ content: '/new' }));

    const constructorCallsAfter = (MockOutboundQueueCtor as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(constructorCallsAfter).toBeGreaterThan(constructorCallsBefore);
  });

  // ─── Shared session: multi-chat routing ──────────────────────────────────

  // @check CHK-062
// @traces REQ-012.AC-01
  it('shared: messages enqueue to TurnQueue and are processed one at a time', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockSession.getStatus.mockReturnValue({ active: true, pid: 123, sessionId: 'ses_x', startedAt: new Date().toISOString(), messageCount: 0, lastMessageAt: null });

    const runtime = new AgentRuntime(db, messenger, 'loops', { shared: true });
    await runtime.start();

    await sendAndDrainShared(runtime, makeMsg({ chatJid: 'chat-a@g.us', senderJid: '111@s.whatsapp.net', content: 'hello from A', isGroup: true }));
    await sendAndDrainShared(runtime, makeMsg({ chatJid: 'chat-b@s.whatsapp.net', senderJid: '222@s.whatsapp.net', content: 'hello from B', isGroup: false }));

    // Both messages should be forwarded to Claude Code as turns
    expect(mockSession.sendTurn).toHaveBeenCalledTimes(2);
  });

  it('shared: STDIN_WRITE_TIMEOUT notifies the originating chat without breaking the queue', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockSession.getStatus.mockReturnValue({
      active: true,
      pid: 456,
      sessionId: 'ses_shared',
      startedAt: new Date().toISOString(),
      messageCount: 0,
      lastMessageAt: null,
    });
    mockSession.sendTurn.mockRejectedValueOnce(new Error('STDIN_WRITE_TIMEOUT: agent not reading input'));

    const runtime = new AgentRuntime(db, messenger, 'loops', { shared: true });
    await runtime.start();

    await expect(sendAndDrainShared(runtime, makeMsg({
      chatJid: 'chat-timeout@g.us',
      senderJid: '15550100001@s.whatsapp.net',
      senderName: 'Taylor',
      content: 'wake up',
      isGroup: true,
    }))).resolves.toBeUndefined();

    expect(mockSession.sendTurn).toHaveBeenCalledWith(
      expect.stringContaining('[Group: chat-timeout@g.us — Taylor]'),
    );
    expect(mockSession.sendTurn).toHaveBeenCalledWith(
      expect.stringContaining('wake up'),
    );
    expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'chat-timeout@g.us',
        sessionId: 'ses_shared',
        pid: 456,
      }),
      'stdin write timed out — notifying user',
    );
    expect(mockQueue.enqueueText).toHaveBeenCalledWith(
      'Agent is not responding — try /new to start a fresh session.',
    );
  });

  it('shared: binds global MCP context to the active turn conversation', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockSession.getStatus.mockReturnValue({ active: true, pid: 123, sessionId: 'ses_x', startedAt: new Date().toISOString(), messageCount: 0, lastMessageAt: null });

    const runtime = new AgentRuntime(db, messenger, 'loops', { shared: true });
    await runtime.start();

    const runtimeState = runtime as unknown as { registry: { call: ReturnType<typeof vi.fn> } };
    runtimeState.registry.call.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

    await sendAndDrainShared(runtime, makeMsg({ chatJid: 'chat-a@g.us', senderJid: 'sender-a@s.whatsapp.net', content: 'turn A', isGroup: true }));

    const opts = capturedSessionManagerOptsRef.current;
    expect(opts?.mcpSessionContext).toMatchObject({
      tier: 'global',
      conversationKey: 'chat-a_at_g.us',
    });

    await opts?.mcpBridge?.executeTool('probe_tool', { chatJid: 'chat-b@g.us' });

    expect(runtimeState.registry.call).toHaveBeenLastCalledWith(
      'probe_tool',
      { chatJid: 'chat-b@g.us' },
      expect.objectContaining({ conversationKey: 'chat-a_at_g.us' }),
    );
    expect(mockSocketServerInstance.updateConversationKey).toHaveBeenLastCalledWith('chat-a_at_g.us');

    await sendAndDrainShared(runtime, makeMsg({ chatJid: 'chat-c@g.us', senderJid: 'sender-c@s.whatsapp.net', content: 'turn B', isGroup: true }));

    expect(opts?.mcpSessionContext?.conversationKey).toBe('chat-c_at_g.us');
    expect(mockSocketServerInstance.updateConversationKey).toHaveBeenLastCalledWith('chat-c_at_g.us');
  });

  it('per_chat: does not bind the singleton MCP conversation context', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockSession.getStatus.mockReturnValue({ active: true, pid: 123, sessionId: 'ses_x', startedAt: new Date().toISOString(), messageCount: 0, lastMessageAt: null });

    const runtime = new AgentRuntime(db, messenger, 'loops', { sessionScope: 'per_chat' });
    await runtime.start();
    await sendAndDrain(runtime, makeMsg({ chatJid: 'chat-a@g.us', senderJid: 'sender-a@s.whatsapp.net', content: 'per chat', isGroup: true }));

    expect(capturedSessionManagerOptsRef.current?.mcpSessionContext).toMatchObject({
      tier: 'chat-scoped',
      conversationKey: 'chat-a_at_g.us',
      deliveryJid: 'chat-a@g.us',
    });
    expect(mockSocketServerInstance.updateConversationKey).not.toHaveBeenCalled();
  });

  // @check CHK-063
// @traces REQ-012.AC-04
  it('shared: queued messages produce no system acknowledgment', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockSession.getStatus.mockReturnValue({ active: true, pid: 123, sessionId: 'ses_x', startedAt: new Date().toISOString(), messageCount: 0, lastMessageAt: null });

    const runtime = new AgentRuntime(db, messenger, 'loops', { shared: true });
    await runtime.start();
    await sendAndDrainShared(runtime, makeMsg({ chatJid: 'chat-a@s.whatsapp.net', content: 'hello' }));

    // No system message should be enqueued for a regular message
    const textsBefore = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
    expect(textsBefore.some((t) => t.includes('queued') || t.includes('wait'))).toBe(false);
  });

  // @check CHK-064
// @traces REQ-012.AC-02
  it('shared: DM turn prefixed with [DM from <name> (<phone>)]', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockSession.getStatus.mockReturnValue({ active: true, pid: 123, sessionId: 'ses_x', startedAt: new Date().toISOString(), messageCount: 0, lastMessageAt: null });

    const runtime = new AgentRuntime(db, messenger, 'loops', { shared: true });
    await runtime.start();
    await sendAndDrainShared(runtime, makeMsg({
      chatJid: '15550100001@s.whatsapp.net',
      senderJid: '15550100001@s.whatsapp.net',
      senderName: 'Jason',
      content: 'test message',
      isGroup: false,
    }));

    expect(mockSession.sendTurn).toHaveBeenCalledWith(
      expect.stringContaining('[DM from Jason (15550100001)]'),
    );
    expect(mockSession.sendTurn).toHaveBeenCalledWith(
      expect.stringContaining('test message'),
    );
  });

  // @check CHK-064
// @traces REQ-012.AC-02
  it('shared: group turn prefixed with [Group: <chatJid> — <senderName>]', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockSession.getStatus.mockReturnValue({ active: true, pid: 123, sessionId: 'ses_x', startedAt: new Date().toISOString(), messageCount: 0, lastMessageAt: null });

    const runtime = new AgentRuntime(db, messenger, 'loops', { shared: true });
    await runtime.start();
    await sendAndDrainShared(runtime, makeMsg({
      chatJid: 'the-group@g.us',
      senderJid: '15550100001@s.whatsapp.net',
      senderName: 'Jason',
      content: 'group message',
      isGroup: true,
    }));

    expect(mockSession.sendTurn).toHaveBeenCalledWith(
      expect.stringContaining('[Group: the-group@g.us — Jason]'),
    );
    expect(mockSession.sendTurn).toHaveBeenCalledWith(
      expect.stringContaining('group message'),
    );
  });

  // @check CHK-065
// @traces REQ-012.AC-03
  it('shared: events route to the originating chat outbound queue', async () => {
    const { OutboundQueue: MockOutboundQueueCtor } = await import('../../../src/runtimes/agent/outbound-queue.ts');
    const db = makeDb();
    const { messenger } = makeMessenger();

    // Track which chatJids OutboundQueue was constructed with
    const constructedFor: string[] = [];
    // Must use 'function' (not arrow) — arrow functions cannot be constructors
    // eslint-disable-next-line prefer-arrow-callback -- vi.fn().mockImplementation requires function keyword for constructor mocks; expires 2026-12-31
    (MockOutboundQueueCtor as unknown as ReturnType<typeof vi.fn>).mockImplementation(function (
      _messenger: unknown,
      chatJid: string,
    ) {
      constructedFor.push(chatJid);
      return mockQueue;
    });

    mockSession.getStatus.mockReturnValue({ active: true, pid: 123, sessionId: 'ses_x', startedAt: new Date().toISOString(), messageCount: 0, lastMessageAt: null });

    const runtime = new AgentRuntime(db, messenger, 'loops', { shared: true });
    await runtime.start();

    // Send a message from chat-a — an OutboundQueue should be created for it
    await sendAndDrainShared(runtime, makeMsg({ chatJid: 'chat-a@s.whatsapp.net', content: 'hello' }));

    expect(constructedFor).toContain('chat-a@s.whatsapp.net');
  });

  // @check CHK-066
// @traces REQ-012.AC-05
  it('shared: each chat gets its own OutboundQueue', async () => {
    const { OutboundQueue: MockOutboundQueueCtor } = await import('../../../src/runtimes/agent/outbound-queue.ts');
    const db = makeDb();
    const { messenger } = makeMessenger();

    const constructedFor: string[] = [];
    // Must use 'function' (not arrow) — arrow functions cannot be constructors
    // eslint-disable-next-line prefer-arrow-callback -- vi.fn().mockImplementation requires function keyword for constructor mocks; expires 2026-12-31
    (MockOutboundQueueCtor as unknown as ReturnType<typeof vi.fn>).mockImplementation(function (
      _messenger: unknown,
      chatJid: string,
    ) {
      constructedFor.push(chatJid);
      return mockQueue;
    });

    mockSession.getStatus.mockReturnValue({ active: true, pid: 123, sessionId: 'ses_x', startedAt: new Date().toISOString(), messageCount: 0, lastMessageAt: null });

    const runtime = new AgentRuntime(db, messenger, 'loops', { shared: true });
    await runtime.start();

    await sendAndDrainShared(runtime, makeMsg({ chatJid: 'chat-a@s.whatsapp.net', content: 'msg1' }));
    await sendAndDrainShared(runtime, makeMsg({ chatJid: 'chat-b@s.whatsapp.net', content: 'msg2' }));
    // Third message from chat-a — should NOT create a second queue for it
    await sendAndDrainShared(runtime, makeMsg({ chatJid: 'chat-a@s.whatsapp.net', content: 'msg3' }));

    const queuedForA = constructedFor.filter((jid) => jid === 'chat-a@s.whatsapp.net');
    const queuedForB = constructedFor.filter((jid) => jid === 'chat-b@s.whatsapp.net');
    expect(queuedForA).toHaveLength(1);
    expect(queuedForB).toHaveLength(1);
  });

  // @check CHK-067
// @traces REQ-012.AC-06
  it('shared: /new is silently ignored for non-admin senders', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger, 'loops', { shared: true });
    await runtime.start();
    await sendAndDrain(runtime, makeMsg({
      content: '/new',
      senderJid: '99999999@s.whatsapp.net', // not in adminPhones
    }));

    // handleNew should NOT have been called
    expect(mockSession.handleNew).not.toHaveBeenCalled();
    // No response sent
    expect(mockQueue.enqueueText).not.toHaveBeenCalled();
  });

  // @check CHK-067
// @traces REQ-012.AC-06
  it('shared: /new is allowed for admin senders', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger, 'loops', { shared: true });
    await runtime.start();
    // Seed session first — use a non-turn message to ensure session is initialized
    await sendAndDrainShared(runtime, makeMsg({ content: 'hello', senderJid: '15550100001@s.whatsapp.net' }));

    mockQueue.enqueueText.mockClear();
    mockSession.handleNew.mockClear();

    await sendAndDrain(runtime, makeMsg({
      content: '/new',
      senderJid: '15550100001@s.whatsapp.net', // in adminPhones
    }));

    expect(mockSession.handleNew).toHaveBeenCalled();
    const texts = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
    expect(texts.some((t) => t.includes('new session'))).toBe(true);
  });

  it('non-shared: /new is allowed for any sender (backward compat)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger); // default: shared=false
    await runtime.start();
    await sendAndDrain(runtime, makeMsg({ content: 'hello', senderJid: '99999999@s.whatsapp.net' }));

    await sendAndDrain(runtime, makeMsg({
      content: '/new',
      senderJid: '99999999@s.whatsapp.net', // not admin, but non-shared allows it
    }));

    expect(mockSession.handleNew).toHaveBeenCalled();
  });

  it('non-sandboxed per_chat serializes same-chat messages while spawnSession is pending', async () => {
    const { SessionManager: MockSessionManagerCtor } = await import('../../../src/runtimes/agent/session.ts');
    const db = makeDb();
    const { messenger } = makeMessenger();

    let active = false;
    let markSpawnStarted!: () => void;
    let releaseSpawn!: () => void;
    const spawnStarted = new Promise<void>((resolve) => {
      markSpawnStarted = resolve;
    });
    const spawnBlocked = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });

    const localSession = {
      ...mockSession,
      getStatus: vi.fn(() => ({
        active,
        pid: active ? 123 : null,
        sessionId: active ? 'sess-per-chat' : null,
        startedAt: active ? new Date().toISOString() : null,
        messageCount: 0,
        lastMessageAt: null,
      })),
      spawnSession: vi.fn(async () => {
        markSpawnStarted();
        await spawnBlocked;
        active = true;
      }),
      sendTurn: vi.fn(async () => {}),
      shutdown: vi.fn(async () => {}),
    };
    (MockSessionManagerCtor as unknown as ReturnType<typeof vi.fn>).mockImplementation(function () {
      return localSession;
    });

    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    await runtime.start();

    await runtime.handleMessage(makeMsg({ messageId: 'msg-1', chatJid: 'same@s.whatsapp.net', content: 'first' }));
    await spawnStarted;
    await runtime.handleMessage(makeMsg({ messageId: 'msg-2', chatJid: 'same@s.whatsapp.net', content: 'second' }));

    expect(localSession.spawnSession).toHaveBeenCalledTimes(1);
    expect(localSession.sendTurn).not.toHaveBeenCalled();
    expect((MockSessionManagerCtor as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);

    releaseSpawn();
    await (runtime as unknown as { turnChain: Promise<void> }).turnChain;

    const chatSessions = (runtime as unknown as { chatSessions: Map<string, unknown> }).chatSessions;
    expect(chatSessions.size).toBe(1);
    expect(chatSessions.has('same@s.whatsapp.net')).toBe(true);
    expect(localSession.shutdown).toHaveBeenCalledTimes(1);
    expect(localSession.spawnSession).toHaveBeenCalledTimes(1);
    const userTurns = (localSession.sendTurn.mock.calls as unknown as Array<[string]>)
      .map(([turnText]) => turnText as string)
      .filter((turnText) => turnText === 'first' || turnText === 'second');
    expect(userTurns).toEqual(['first', 'second']);
  });

  it('per_chat reuses the canonical session across JID variants in non-sandbox mode', async () => {
    const { SessionManager: MockSessionManagerCtor } = await import('../../../src/runtimes/agent/session.ts');
    const canonicalJid = '15550100001@s.whatsapp.net';
    const db = makeDb();
    const lidLookup = { run: vi.fn(), get: vi.fn(() => ({ phone_jid: canonicalJid })) };
    (db.raw.prepare as ReturnType<typeof vi.fn>).mockImplementation((sql: string) => {
      if (sql.includes('SELECT phone_jid FROM lid_mappings')) return lidLookup;
      return { run: vi.fn(), get: vi.fn() };
    });
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    await runtime.start();

    await sendAndDrain(runtime, makeMsg({ messageId: 'msg-1', chatJid: canonicalJid, content: 'hello' }));
    await sendAndDrain(runtime, makeMsg({ messageId: 'msg-2', chatJid: '15550100001@lid', content: 'follow-up' }));

    const chatSessions = (runtime as unknown as { chatSessions: Map<string, unknown> }).chatSessions;
    const chatQueues = (runtime as unknown as { chatQueues: Map<string, unknown> }).chatQueues;

    expect((MockSessionManagerCtor as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect(chatSessions.size).toBe(1);
    expect(chatSessions.has(canonicalJid)).toBe(true);
    expect(chatQueues.has(canonicalJid)).toBe(true);
    expect(mockQueue.updateDeliveryJid).toHaveBeenCalledWith('15550100001@lid');

    const userTurns = (mockSession.sendTurn.mock.calls as unknown as Array<[string]>)
      .map(([turnText]) => turnText as string)
      .filter((turnText) => turnText === 'hello' || turnText === 'follow-up');
    expect(userTurns).toEqual(['hello', 'follow-up']);
  });

  // ─── sandboxPerChat workspace isolation ────────────────────────────────────

  it('sandboxPerChat provisions workspace MCP config for the effective fallback provider', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const agentConfig = mockConfig as typeof mockConfig & {
      agentProvider?: string;
      agentFallbackProvider?: string;
      agentFallbackModel?: string;
    };
    agentConfig.agentProvider = 'claude-cli';
    agentConfig.agentFallbackProvider = 'opencode-cli';
    agentConfig.agentFallbackModel = 'minimax/minimax-m2';

    const sandbox = { allowedPaths: ['/fake'], allowedTools: [], bash: { enabled: false } };
    const runtime = new AgentRuntime(db, messenger, 'test', {
      sessionScope: 'per_chat',
      sandboxPerChat: true,
      sandbox,
      cwd: tmpdir(),
    });
    await runtime.start();

    (runtime as unknown as { fallbackWindow: { activeUntil: number | null } }).fallbackWindow.activeUntil =
      Date.now() + 60_000;
    await sendAndDrain(runtime, makeMsg({ chatJid: '15550100001@s.whatsapp.net', content: 'hello fallback' }));

    expect(mockProvisionWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'opencode-cli',
    }));
    expect(capturedSessionManagerOptsRef.current).toMatchObject({
      provider: 'opencode-cli',
      model: 'minimax/minimax-m2',
    });
  });

  it('sandboxPerChat does not pass primary custom endpoint config to fallback opencode workspaces', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const agentConfig = mockConfig as typeof mockConfig & {
      agentProvider?: string;
      agentProviderConfig?: Record<string, unknown>;
      agentFallbackProvider?: string;
      agentFallbackModel?: string;
    };
    agentConfig.agentProvider = 'claude-cli';
    agentConfig.agentProviderConfig = {
      baseUrl: 'https://primary.example.invalid/v1',
      apiKeyService: 'openai',
    };
    agentConfig.agentFallbackProvider = 'opencode-cli';
    agentConfig.agentFallbackModel = 'minimax/minimax-m2';

    const sandbox = { allowedPaths: ['/fake'], allowedTools: [], bash: { enabled: false } };
    const runtime = new AgentRuntime(db, messenger, 'test', {
      sessionScope: 'per_chat',
      sandboxPerChat: true,
      sandbox,
      cwd: tmpdir(),
    });
    await runtime.start();

    (runtime as unknown as { fallbackWindow: { activeUntil: number | null } }).fallbackWindow.activeUntil =
      Date.now() + 60_000;
    await sendAndDrain(runtime, makeMsg({ chatJid: '15550100001@s.whatsapp.net', content: 'hello fallback' }));

    const provisionCalls = mockProvisionWorkspace.mock.calls as unknown as Array<[{
      provider?: string;
      providerConfig?: unknown;
    }]>;
    const fallbackProvision = provisionCalls.find(([opts]) => opts.provider === 'opencode-cli')?.[0];
    expect(fallbackProvision?.providerConfig).toBeUndefined();
    expect(capturedSessionManagerOptsRef.current).toMatchObject({
      provider: 'opencode-cli',
      model: 'minimax/minimax-m2',
      providerConfig: {},
    });
  });

  it('sandboxPerChat passes custom endpoint config for primary opencode workspaces', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const agentConfig = mockConfig as typeof mockConfig & {
      agentProvider?: string;
      agentProviderConfig?: Record<string, unknown>;
    };
    agentConfig.agentProvider = 'opencode-cli';
    agentConfig.agentProviderConfig = {
      baseUrl: 'https://api.example.invalid/v1',
      apiKeyService: 'openai',
    };

    const sandbox = { allowedPaths: ['/fake'], allowedTools: [], bash: { enabled: false } };
    const runtime = new AgentRuntime(db, messenger, 'test', {
      sessionScope: 'per_chat',
      sandboxPerChat: true,
      sandbox,
      cwd: tmpdir(),
      model: 'model-a',
    });
    await runtime.start();

    await sendAndDrain(runtime, makeMsg({ chatJid: '15550100001@s.whatsapp.net', content: 'hello primary' }));

    expect(mockProvisionWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'opencode-cli',
      providerConfig: {
        baseUrl: 'https://api.example.invalid/v1',
        model: 'model-a',
        apiKeyService: 'openai',
      },
    }));
    expect(capturedSessionManagerOptsRef.current).toMatchObject({
      provider: 'opencode-cli',
      model: 'model-a',
      providerConfig: {
        baseUrl: 'https://api.example.invalid/v1',
        apiKeyService: 'openai',
      },
    });
  });

  it('sandboxPerChat: two DMs from different JIDs produce different sessions', async () => {
    const { SessionManager: MockSessionManagerCtor } = await import('../../../src/runtimes/agent/session.ts');
    const db = makeDb();
    const { messenger } = makeMessenger();

    // Map different JIDs to different workspace keys
    mockChatJidToWorkspace.mockImplementation((_instanceCwd: string, chatJid: string) => {
      const key = chatJid.replace('@s.whatsapp.net', '');
      return { kind: 'dm' as const, workspaceKey: key, workspacePath: `/tmp/${key}` };
    });
    mockGetResumableSessionForChat.mockReturnValue(null);

    const sandbox = { allowedPaths: ['/fake'], allowedTools: [], bash: { enabled: false } };
    const runtime = new AgentRuntime(db, messenger, 'test', {
      sessionScope: 'per_chat',
      sandboxPerChat: true,
      sandbox,
      cwd: tmpdir(),
    });
    await runtime.start();

    await sendAndDrain(runtime, makeMsg({ chatJid: '111@s.whatsapp.net', content: 'hello' }));
    await sendAndDrain(runtime, makeMsg({ chatJid: '222@s.whatsapp.net', content: 'hello' }));

    // Two different sessions should have been created
    const constructorCalls = (MockSessionManagerCtor as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(constructorCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('sandboxPerChat: same person with @lid and @s.whatsapp.net variant maps to same session', async () => {
    const { SessionManager: MockSessionManagerCtor } = await import('../../../src/runtimes/agent/session.ts');
    const db = makeDb();
    const { messenger } = makeMessenger();

    // Both JID variants map to the same workspace key (phone number)
    mockChatJidToWorkspace.mockImplementation((_instanceCwd: string, _chatJid: string) => ({
      kind: 'dm' as const,
      workspaceKey: '15550100001',
      workspacePath: '/tmp/15550100001',
    }));
    mockGetResumableSessionForChat.mockReturnValue(null);

    const sandbox = { allowedPaths: ['/fake'], allowedTools: [], bash: { enabled: false } };
    const runtime = new AgentRuntime(db, messenger, 'test', {
      sessionScope: 'per_chat',
      sandboxPerChat: true,
      sandbox,
      cwd: tmpdir(),
    });
    await runtime.start();

    const constructorCallsBefore = (MockSessionManagerCtor as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

    // First message via @s.whatsapp.net
    await sendAndDrain(runtime, makeMsg({ chatJid: '15550100001@s.whatsapp.net', content: 'hello' }));
    const afterFirst = (MockSessionManagerCtor as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

    // Second message via @lid variant — same workspace key → should reuse existing session
    await sendAndDrain(runtime, makeMsg({ chatJid: '15550100001@lid', content: 'follow-up' }));
    const afterSecond = (MockSessionManagerCtor as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

    expect(afterFirst - constructorCallsBefore).toBe(1);  // one session created
    expect(afterSecond - afterFirst).toBe(0);             // no new session on second message
  });

  it('sandboxPerChat: /new preserves workspace resources (socket server survives)', async () => {
    const { WhatSoupSocketServer: MockSocketServer } = await import('../../../src/mcp/socket-server.ts');
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockChatJidToWorkspace.mockImplementation((_instanceCwd: string, _chatJid: string) => ({
      kind: 'dm' as const,
      workspaceKey: '15550100001',
      workspacePath: '/tmp/15550100001',
    }));
    mockGetResumableSessionForChat.mockReturnValue(null);

    const sandbox = { allowedPaths: ['/fake'], allowedTools: [], bash: { enabled: false } };
    const runtime = new AgentRuntime(db, messenger, 'test', {
      sessionScope: 'per_chat',
      sandboxPerChat: true,
      sandbox,
      cwd: tmpdir(),
    });
    await runtime.start();

    // First message seeds the session + workspace resources
    await sendAndDrain(runtime, makeMsg({ chatJid: '15550100001@s.whatsapp.net', content: 'hello' }));
    const socketServerCallsAfterFirst = (MockSocketServer as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

    // /new should NOT create a new socket server again (workspace resources survive)
    await sendAndDrain(runtime, makeMsg({ chatJid: '15550100001@s.whatsapp.net', content: '/new' }));
    await sendAndDrain(runtime, makeMsg({ chatJid: '15550100001@s.whatsapp.net', content: 'hello again' }));
    const socketServerCallsAfterNew = (MockSocketServer as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

    expect(socketServerCallsAfterNew).toBe(socketServerCallsAfterFirst); // no new socket server started
    // session.handleNew should have been called
    expect(mockSession.handleNew).toHaveBeenCalled();
  });

  it('sandboxPerChat: delivery JID updated on each message via updateDeliveryJid', async () => {
    const { OutboundQueue: MockOutboundQueueCtor } = await import('../../../src/runtimes/agent/outbound-queue.ts');
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockChatJidToWorkspace.mockImplementation((_instanceCwd: string, _chatJid: string) => ({
      kind: 'dm' as const,
      workspaceKey: '15550100001',
      workspacePath: '/tmp/15550100001',
    }));
    mockGetResumableSessionForChat.mockReturnValue(null);

    // Track updateDeliveryJid calls
    const updateDeliveryJidCalls: string[] = [];
    (MockOutboundQueueCtor as unknown as ReturnType<typeof vi.fn>).mockImplementation(function () {
      return {
        ...mockQueue,
        updateDeliveryJid: vi.fn((jid: string) => { updateDeliveryJidCalls.push(jid); }),
      };
    });

    const sandbox = { allowedPaths: ['/fake'], allowedTools: [], bash: { enabled: false } };
    const runtime = new AgentRuntime(db, messenger, 'test', {
      sessionScope: 'per_chat',
      sandboxPerChat: true,
      sandbox,
      cwd: tmpdir(),
    });
    await runtime.start();

    // First message with @s.whatsapp.net variant
    await sendAndDrain(runtime, makeMsg({ chatJid: '15550100001@s.whatsapp.net', content: 'msg1' }));
    // Second message with @lid variant
    await sendAndDrain(runtime, makeMsg({ chatJid: '15550100001@lid', content: 'msg2' }));

    // updateDeliveryJid should have been called at least twice (once per message)
    expect(updateDeliveryJidCalls.length).toBeGreaterThanOrEqual(2);
    // The calls should include both JID variants
    expect(updateDeliveryJidCalls).toContain('15550100001@s.whatsapp.net');
    expect(updateDeliveryJidCalls).toContain('15550100001@lid');
  });

  it('sandboxPerChat: start() calls backfillWorkspaceKeys and classifyActiveSessions', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const sandbox = { allowedPaths: ['/fake'], allowedTools: [], bash: { enabled: false } };
    const runtime = new AgentRuntime(db, messenger, 'test', {
      sessionScope: 'per_chat',
      sandboxPerChat: true,
      sandbox,
      cwd: tmpdir(),
    });
    runtime.setDurability({} as any);
    await runtime.start();

    expect(mockBackfillWorkspaceKeys).toHaveBeenCalledWith(db, tmpdir());
    const { classifyActiveSessions } = await import('../../../src/runtimes/agent/session-classifier.ts');
    expect(classifyActiveSessions).toHaveBeenCalled();
  });

  it('start() with per_chat session scope and null durability logs warning and skips classification', async () => {
    const { classifyActiveSessions } = await import('../../../src/runtimes/agent/session-classifier.ts');
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });

    await expect(runtime.start()).resolves.toBeUndefined();

    expect(classifyActiveSessions).not.toHaveBeenCalled();
    expect(mockRuntimeLogger.warn).toHaveBeenCalledWith('durability engine not set — skipping active session classification');
  });

  it('sandboxPerChat: stale_dead sessions are marked orphaned during start()', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const { markOrphaned: mockMarkOrphaned } = await import('../../../src/runtimes/agent/session-db.ts');
    const { classifyActiveSessions: mockClassify } = await import('../../../src/runtimes/agent/session-classifier.ts');

    // Simulate classifier finding a stale_dead session
    (mockClassify as ReturnType<typeof vi.fn>).mockReturnValue([{
      id: 42, sessionId: 'ses-old', claudePid: 99999999,
      chatJid: 'test@s.whatsapp.net', conversationKey: 'test',
      status: 'active', classification: 'stale_dead', reason: 'PID dead',
    }]);

    const sandbox = { allowedPaths: ['/fake'], allowedTools: [], bash: { enabled: false } };
    const runtime = new AgentRuntime(db, messenger, 'test', {
      sessionScope: 'per_chat',
      sandboxPerChat: true,
      sandbox,
      cwd: tmpdir(),
    });
    runtime.setDurability({} as any);
    await runtime.start();

    expect(mockMarkOrphaned).toHaveBeenCalledWith(db, 42);
  });

  it('sandboxPerChat: stale_live sessions are terminated and marked orphaned during start()', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const { markOrphaned: mockMarkOrphaned } = await import('../../../src/runtimes/agent/session-db.ts');
    const { classifyActiveSessions: mockClassify } = await import('../../../src/runtimes/agent/session-classifier.ts');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    (mockClassify as ReturnType<typeof vi.fn>).mockReturnValue([{
      id: 43,
      sessionId: 'ses-live-stale',
      claudePid: 4321,
      chatJid: 'stale-live@s.whatsapp.net',
      conversationKey: 'stale-live',
      status: 'active',
      classification: 'stale_live',
      reason: 'superseded by checkpoint',
    }]);

    const sandbox = { allowedPaths: ['/fake'], allowedTools: [], bash: { enabled: false } };
    const runtime = new AgentRuntime(db, messenger, 'test', {
      sessionScope: 'per_chat',
      sandboxPerChat: true,
      sandbox,
      cwd: tmpdir(),
    });
    runtime.setDurability({} as any);

    try {
      await runtime.start();
      expect(killSpy).toHaveBeenCalledWith(4321, 'SIGTERM');
      expect(mockMarkOrphaned).toHaveBeenCalledWith(db, 43);
      expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
        {
          id: 43,
          pid: 4321,
          conversationKey: 'stale-live',
          reason: 'superseded by checkpoint',
        },
        'reaping stale session',
      );
    } finally {
      killSpy.mockRestore();
    }
  });

  it('sandboxPerChat: ambiguous startup sessions warn without terminating or orphaning', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const { markOrphaned: mockMarkOrphaned } = await import('../../../src/runtimes/agent/session-db.ts');
    const { classifyActiveSessions: mockClassify } = await import('../../../src/runtimes/agent/session-classifier.ts');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    (mockClassify as ReturnType<typeof vi.fn>).mockReturnValue([{
      id: 44,
      sessionId: 'ses-ambiguous',
      claudePid: 9876,
      chatJid: 'ambiguous@s.whatsapp.net',
      conversationKey: 'ambiguous',
      status: 'active',
      classification: 'ambiguous',
      reason: 'ownership unverified',
    }]);

    const sandbox = { allowedPaths: ['/fake'], allowedTools: [], bash: { enabled: false } };
    const runtime = new AgentRuntime(db, messenger, 'test', {
      sessionScope: 'per_chat',
      sandboxPerChat: true,
      sandbox,
      cwd: tmpdir(),
    });
    runtime.setDurability({} as any);

    try {
      await runtime.start();
      expect(killSpy).not.toHaveBeenCalled();
      expect(mockMarkOrphaned).not.toHaveBeenCalledWith(db, 44);
      expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
        {
          id: 44,
          pid: 9876,
          conversationKey: 'ambiguous',
          reason: 'ownership unverified',
        },
        'ambiguous session — not touching',
      );
    } finally {
      killSpy.mockRestore();
    }
  });

  it('sandboxPerChat: eager session resume skipped on start()', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    // getActiveSession returns a resumable session
    mockGetActiveSession.mockReturnValue({
      id: 1,
      session_id: 'sess-123',
      chat_jid: 'user@s.whatsapp.net',
      claude_pid: 0,
      status: 'active',
      started_at: new Date().toISOString(),
      last_message_at: null,
      message_count: 0,
    });

    const sandbox = { allowedPaths: ['/fake'], allowedTools: [], bash: { enabled: false } };
    const runtime = new AgentRuntime(db, messenger, 'test', {
      sessionScope: 'per_chat',
      sandboxPerChat: true,
      sandbox,
      cwd: tmpdir(),
    });
    await runtime.start();

    // In sandboxPerChat mode, getActiveSession should NOT be called at start
    // (resumption is lazy, per-chat)
    expect(mockSession.spawnSession).not.toHaveBeenCalled();
  });

  it('sandboxPerChat: lazy resume called on first message when resumable session exists', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockChatJidToWorkspace.mockImplementation((_instanceCwd: string, _chatJid: string) => ({
      kind: 'dm' as const,
      workspaceKey: '15550100001',
      workspacePath: '/tmp/15550100001',
    }));

    // Resumable session exists for this workspace key
    mockGetResumableSessionForChat.mockReturnValue({
      id: 5,
      session_id: 'sess-resumed',
      chat_jid: '15550100001@s.whatsapp.net',
    });

    const sandbox = { allowedPaths: ['/fake'], allowedTools: [], bash: { enabled: false } };
    const runtime = new AgentRuntime(db, messenger, 'test', {
      sessionScope: 'per_chat',
      sandboxPerChat: true,
      sandbox,
      cwd: tmpdir(),
    });
    await runtime.start();

    expect(mockSession.spawnSession).not.toHaveBeenCalled();

    // First message triggers lazy resume
    await sendAndDrain(runtime, makeMsg({ chatJid: '15550100001@s.whatsapp.net', content: 'hello' }));

    expect(mockSession.spawnSession).toHaveBeenCalledWith('sess-resumed', 5);
  });

  it('sandboxPerChat: provisioning failure leaves no partial workspace resources', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockChatJidToWorkspace.mockImplementation((_instanceCwd: string, _chatJid: string) => ({
      kind: 'dm' as const,
      workspaceKey: '15550100001',
      workspacePath: '/tmp/15550100001',
    }));
    mockGetResumableSessionForChat.mockReturnValue(null);
    mockProvisionWorkspace.mockImplementation(() => {
      throw new Error('ENOSPC');
    });

    const sandbox = { allowedPaths: ['/fake'], allowedTools: [], bash: { enabled: false } };
    const runtime = new AgentRuntime(db, messenger, 'test', {
      sessionScope: 'per_chat',
      sandboxPerChat: true,
      sandbox,
      cwd: tmpdir(),
    });
    await runtime.start();

    await sendAndDrain(runtime, makeMsg({ chatJid: '15550100001@s.whatsapp.net', content: 'hello' }));

    const workspaceResources = (runtime as unknown as { workspaceResources: Map<string, unknown> }).workspaceResources;
    const chatSessions = (runtime as unknown as { chatSessions: Map<string, unknown> }).chatSessions;
    const chatQueues = (runtime as unknown as { chatQueues: Map<string, unknown> }).chatQueues;

    expect(workspaceResources.has('15550100001')).toBe(false);
    expect(chatSessions.has('15550100001')).toBe(false);
    expect(chatQueues.has('15550100001')).toBe(false);
    expect(mockSocketServerInstance.start).not.toHaveBeenCalled();
    expect(mockStartMediaBridge).not.toHaveBeenCalled();
  });

  it('sandboxPerChat: failed resume fallback cleans up workspace resources', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockChatJidToWorkspace.mockImplementation((_instanceCwd: string, _chatJid: string) => ({
      kind: 'dm' as const,
      workspaceKey: '15550100001',
      workspacePath: '/tmp/15550100001',
    }));
    mockGetResumableSessionForChat.mockReturnValue({
      id: 5,
      session_id: 'sess-resumed',
      chat_jid: '15550100001@s.whatsapp.net',
    });
    mockSession.spawnSession
      .mockRejectedValueOnce(new Error('resume failed'))
      .mockRejectedValueOnce(new Error('fresh spawn failed'));

    const sandbox = { allowedPaths: ['/fake'], allowedTools: [], bash: { enabled: false } };
    const runtime = new AgentRuntime(db, messenger, 'test', {
      sessionScope: 'per_chat',
      sandboxPerChat: true,
      sandbox,
      cwd: tmpdir(),
    });
    await runtime.start();

    await sendAndDrain(runtime, makeMsg({ chatJid: '15550100001@s.whatsapp.net', content: 'hello' }));

    const workspaceResources = (runtime as unknown as { workspaceResources: Map<string, unknown> }).workspaceResources;
    const chatSessions = (runtime as unknown as { chatSessions: Map<string, unknown> }).chatSessions;
    const chatQueues = (runtime as unknown as { chatQueues: Map<string, unknown> }).chatQueues;

    expect(mockSession.spawnSession).toHaveBeenNthCalledWith(1, 'sess-resumed', 5);
    expect(mockSession.spawnSession).toHaveBeenNthCalledWith(2);
    expect(workspaceResources.has('15550100001')).toBe(false);
    expect(chatSessions.has('15550100001')).toBe(false);
    expect(chatQueues.has('15550100001')).toBe(false);
    expect(mockSocketServerInstance.stop).toHaveBeenCalled();
    expect(mockMediaBridgeHandle).toHaveBeenCalled();
  });

  it('sandboxPerChat: chat-scoped socket server provisioned with correct SessionContext', async () => {
    const { WhatSoupSocketServer: MockSocketServer } = await import('../../../src/mcp/socket-server.ts');
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockChatJidToWorkspace.mockImplementation((_instanceCwd: string, _chatJid: string) => ({
      kind: 'dm' as const,
      workspaceKey: '15550100001',
      workspacePath: '/tmp/15550100001',
    }));
    mockGetResumableSessionForChat.mockReturnValue(null);

    const sandbox = { allowedPaths: ['/fake'], allowedTools: [], bash: { enabled: false } };
    const runtime = new AgentRuntime(db, messenger, 'test', {
      sessionScope: 'per_chat',
      sandboxPerChat: true,
      sandbox,
      cwd: tmpdir(),
    });
    await runtime.start();

    // First message triggers workspace provisioning
    await sendAndDrain(runtime, makeMsg({ chatJid: '15550100001@s.whatsapp.net', content: 'hello' }));

    // WhatSoupSocketServer should have been constructed with chat-scoped session context
    const calls = (MockSocketServer as unknown as ReturnType<typeof vi.fn>).mock.calls;
    // Filter to calls made after start() (global socket server call may exist for non-sandboxPerChat mode)
    const chatScopedCall = calls.find((args: unknown[]) => {
      const ctx = args[2] as { tier: string; conversationKey?: string };
      return ctx?.tier === 'chat-scoped';
    });
    expect(chatScopedCall).toBeDefined();
    const sessionCtx = chatScopedCall![2] as { tier: string; conversationKey: string; deliveryJid: string; actorJid?: string };
    expect(sessionCtx.tier).toBe('chat-scoped');
    expect(sessionCtx.conversationKey).toBe('15550100001');
    expect(sessionCtx.deliveryJid).toBe('15550100001@s.whatsapp.net');
    expect(sessionCtx.actorJid).toBe('sender@s.whatsapp.net');
  });

  it('sandboxPerChat: updateDeliveryJid called on socket server when JID changes', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockChatJidToWorkspace.mockImplementation((_instanceCwd: string, _chatJid: string) => ({
      kind: 'dm' as const,
      workspaceKey: '15550100001',
      workspacePath: '/tmp/15550100001',
    }));
    mockGetResumableSessionForChat.mockReturnValue(null);

    const sandbox = { allowedPaths: ['/fake'], allowedTools: [], bash: { enabled: false } };
    const runtime = new AgentRuntime(db, messenger, 'test', {
      sessionScope: 'per_chat',
      sandboxPerChat: true,
      sandbox,
      cwd: tmpdir(),
    });
    await runtime.start();
    mockSocketServerInstance.updateDeliveryJid.mockClear();

    // First message via @s.whatsapp.net
    await sendAndDrain(runtime, makeMsg({ chatJid: '15550100001@s.whatsapp.net', content: 'hello' }));
    // Second message via @lid variant
    await sendAndDrain(runtime, makeMsg({ chatJid: '15550100001@lid', content: 'follow-up' }));

    // updateDeliveryJid should have been called on the socket server for each subsequent message
    expect(mockSocketServerInstance.updateDeliveryJid).toHaveBeenCalled();
    const jidArgs = mockSocketServerInstance.updateDeliveryJid.mock.calls.map((c: unknown[]) => c[0]);
    expect(jidArgs).toContain('15550100001@lid');
  });

  // ─── Per-chat shared state race regression tests ─────────────────────────────
  // Before fix: ensureSessionAndQueue mutated this.session/this.queue shared fields,
  // so /new and /status from chat A could target chat B's session if B messaged last.

  it('per_chat /status reads from correct chat session, not last-processed shared field', async () => {
    const { SessionManager: MockSessionManagerCtor } = await import('../../../src/runtimes/agent/session.ts');
    const db = makeDb();
    const { messenger, sentMessages } = makeMessenger();

    // Create distinct sessions per workspace key so we can tell them apart
    const sessionsByKey = new Map<string, Record<string, ReturnType<typeof vi.fn>>>();
    (MockSessionManagerCtor as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      function (opts: { chatJid: string; onEvent: (event: AgentEvent) => void }) {
        const key = opts.chatJid.replace('@s.whatsapp.net', '');
        const perChatSession = {
          spawnSession: vi.fn(async () => {}),
          sendTurn: vi.fn(async () => {}),
          handleNew: vi.fn(async () => {}),
          getStatus: vi.fn(() => ({
            active: true,
            pid: parseInt(key) || 999,
            sessionId: `session-${key}`,
            startedAt: new Date().toISOString(),
            messageCount: 1,
            lastMessageAt: new Date().toISOString(),
          })),
          shutdown: vi.fn(async () => {}),
          clearTurnWatchdog: vi.fn(() => {}),
          tickWatchdog: vi.fn(() => {}),
          trackToolStart: vi.fn((_toolId: string) => {}),
          trackToolEnd: vi.fn((_toolId: string) => {}),
        };
        sessionsByKey.set(key, perChatSession);
        return perChatSession;
      },
    );

    // Each chat maps to its own workspace key
    mockChatJidToWorkspace.mockImplementation((_cwd: string, chatJid: string) => {
      const key = chatJid.replace('@s.whatsapp.net', '');
      return { kind: 'dm' as const, workspaceKey: key, workspacePath: `/tmp/${key}` };
    });
    mockGetResumableSessionForChat.mockReturnValue(null);

    const sandbox = { allowedPaths: ['/fake'], allowedTools: [], bash: { enabled: false } };
    const runtime = new AgentRuntime(db, messenger, 'test', {
      sessionScope: 'per_chat',
      sandboxPerChat: true,
      sandbox,
      cwd: tmpdir(),
    });
    await runtime.start();

    // Chat A sends a message → creates session for chat A
    await sendAndDrain(runtime, makeMsg({ chatJid: '111@s.whatsapp.net', content: 'hello from A' }));
    // Chat B sends a message → creates session for chat B
    // (OLD BUG: this would set this.session to B's session)
    await sendAndDrain(runtime, makeMsg({ chatJid: '222@s.whatsapp.net', content: 'hello from B' }));

    // Clear getStatus call tracking on both sessions
    const sessionA = sessionsByKey.get('111');
    const sessionB = sessionsByKey.get('222');
    expect(sessionA).toBeDefined();
    expect(sessionB).toBeDefined();
    sessionA!.getStatus.mockClear();
    sessionB!.getStatus.mockClear();

    // Chat A asks for /status — should query A's session, not B's
    await sendAndDrain(runtime, makeMsg({
      chatJid: '111@s.whatsapp.net',
      senderJid: '111@s.whatsapp.net',
      content: '/status',
    }));

    // getStatus should have been called on A's session, not B's
    expect(sessionA!.getStatus).toHaveBeenCalled();
    expect(sessionB!.getStatus).not.toHaveBeenCalled();
  });

  it('per_chat /new resets correct chat session, not last-processed shared field', async () => {
    const { SessionManager: MockSessionManagerCtor } = await import('../../../src/runtimes/agent/session.ts');
    const db = makeDb();
    const { messenger, sentMessages } = makeMessenger();

    // Track which session gets handleNew called
    const handleNewCalls: string[] = [];
    (MockSessionManagerCtor as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      function (opts: { chatJid: string; onEvent: (event: AgentEvent) => void }) {
        const key = opts.chatJid.replace('@s.whatsapp.net', '');
        return {
          spawnSession: vi.fn(async () => {}),
          sendTurn: vi.fn(async () => {}),
          handleNew: vi.fn(async () => { handleNewCalls.push(key); }),
          getStatus: vi.fn(() => ({
            active: true, pid: parseInt(key) || 999, sessionId: `session-${key}`,
            startedAt: new Date().toISOString(), messageCount: 1, lastMessageAt: new Date().toISOString(),
          })),
          shutdown: vi.fn(async () => {}),
          clearTurnWatchdog: vi.fn(() => {}),
          tickWatchdog: vi.fn(() => {}),
          trackToolStart: vi.fn((_toolId: string) => {}),
          trackToolEnd: vi.fn((_toolId: string) => {}),
        };
      },
    );

    mockChatJidToWorkspace.mockImplementation((_cwd: string, chatJid: string) => {
      const key = chatJid.replace('@s.whatsapp.net', '');
      return { kind: 'dm' as const, workspaceKey: key, workspacePath: `/tmp/${key}` };
    });
    mockGetResumableSessionForChat.mockReturnValue(null);

    const sandbox = { allowedPaths: ['/fake'], allowedTools: [], bash: { enabled: false } };
    const runtime = new AgentRuntime(db, messenger, 'test', {
      sessionScope: 'per_chat',
      sandboxPerChat: true,
      sandbox,
      cwd: tmpdir(),
    });
    await runtime.start();

    // Chat A and B both establish sessions
    await sendAndDrain(runtime, makeMsg({ chatJid: '111@s.whatsapp.net', content: 'hello from A' }));
    await sendAndDrain(runtime, makeMsg({ chatJid: '222@s.whatsapp.net', content: 'hello from B' }));

    // Chat A sends /new — should reset A's session, not B's
    handleNewCalls.length = 0;
    sentMessages.length = 0;
    await sendAndDrain(runtime, makeMsg({
      chatJid: '111@s.whatsapp.net',
      senderJid: '15550100001@s.whatsapp.net',  // admin phone (required for /new)
      content: '/new',
    }));

    // handleNew should have been called on A's session (key '111'), not B's ('222')
    expect(handleNewCalls).toContain('111');
    expect(handleNewCalls).not.toContain('222');
  });

  it('per_chat handleEventWithContext: assistant_text after result is suppressed (post-turn gate)', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    const queue = makeQueueMock('111@s.whatsapp.net');
    const handleEventWithContext = (
      runtime as unknown as {
        handleEventWithContext: (
          event: AgentEvent,
          queue: IOutboundQueue,
          session: null,
          conversationKey?: string,
          inboundSeq?: number,
          mapKey?: string,
          toolScopeKey?: string,
        ) => void;
      }
    ).handleEventWithContext.bind(runtime);

    // Turn with text + result
    handleEventWithContext(
      { type: 'assistant_text', text: 'Hello' },
      queue, null, undefined, undefined, '111', '111#session',
    );
    handleEventWithContext(
      { type: 'result', text: null },
      queue, null, undefined, undefined, '111', '111#session',
    );

    // Reset mocks
    (queue.enqueueStreamingText as ReturnType<typeof vi.fn>).mockClear();
    (queue.enqueueText as ReturnType<typeof vi.fn>).mockClear();
    (queue.enqueueToolUpdate as ReturnType<typeof vi.fn>).mockClear();

    // Phantom assistant_text — should be suppressed
    handleEventWithContext(
      { type: 'assistant_text', text: 'Phantom from SDK reminder' },
      queue, null, undefined, undefined, '111', '111#session',
    );

    // Phantom tool_use — should also be suppressed
    handleEventWithContext(
      { type: 'tool_use', toolName: 'TodoWrite', toolId: 'phantom-todo', toolInput: {} },
      queue, null, undefined, undefined, '111', '111#session',
    );

    expect(queue.enqueueStreamingText).not.toHaveBeenCalled();
    expect(queue.enqueueText).not.toHaveBeenCalled();
    expect(queue.enqueueToolUpdate).not.toHaveBeenCalled();
  });

  it('per_chat late result from a replaced session does not wipe the new session tool name scope', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    const queueOld = makeQueueMock('111@s.whatsapp.net');
    const queueNew = makeQueueMock('111@s.whatsapp.net');
    const handleEventWithContext = (
      runtime as unknown as {
        handleEventWithContext: (
          event: AgentEvent,
          queue: IOutboundQueue,
          session: null,
          conversationKey?: string,
          inboundSeq?: number,
          mapKey?: string,
          toolScopeKey?: string,
        ) => void;
      }
    ).handleEventWithContext.bind(runtime);

    handleEventWithContext(
      { type: 'tool_use', toolName: 'Read', toolId: 'old-tool', toolInput: { file_path: '/tmp/old.txt' } },
      queueOld,
      null,
      undefined,
      undefined,
      '111',
      '111#old-session',
    );
    handleEventWithContext(
      { type: 'tool_use', toolName: 'Bash', toolId: 'new-tool', toolInput: { command: 'git status' } },
      queueNew,
      null,
      undefined,
      undefined,
      '111',
      '111#new-session',
    );

    handleEventWithContext(
      { type: 'result', text: null },
      queueOld,
      null,
      undefined,
      undefined,
      '111',
      '111#old-session',
    );
    handleEventWithContext(
      { type: 'tool_result', isError: true, toolId: 'new-tool', content: 'boom' },
      queueNew,
      null,
      undefined,
      undefined,
      '111',
      '111#new-session',
    );

    expect(queueNew.enqueueToolUpdate).toHaveBeenLastCalledWith({ category: 'error', detail: 'Bash — boom' });
  });

  it('per_chat result from one chat leaves another chat tool name scope intact', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    const queueA = makeQueueMock('111@s.whatsapp.net');
    const queueB = makeQueueMock('222@s.whatsapp.net');
    const handleEventWithContext = (
      runtime as unknown as {
        handleEventWithContext: (
          event: AgentEvent,
          queue: IOutboundQueue,
          session: null,
          conversationKey?: string,
          inboundSeq?: number,
          mapKey?: string,
          toolScopeKey?: string,
        ) => void;
      }
    ).handleEventWithContext.bind(runtime);

    handleEventWithContext(
      { type: 'tool_use', toolName: 'Read', toolId: 'tool-a', toolInput: { file_path: '/tmp/a.txt' } },
      queueA,
      null,
      undefined,
      undefined,
      '111',
      '111#session',
    );
    handleEventWithContext(
      { type: 'tool_use', toolName: 'Bash', toolId: 'tool-b', toolInput: { command: 'git status' } },
      queueB,
      null,
      undefined,
      undefined,
      '222',
      '222#session',
    );

    handleEventWithContext(
      { type: 'result', text: null },
      queueA,
      null,
      undefined,
      undefined,
      '111',
      '111#session',
    );
    handleEventWithContext(
      { type: 'tool_result', isError: true, toolId: 'tool-b', content: 'boom' },
      queueB,
      null,
      undefined,
      undefined,
      '222',
      '222#session',
    );

    expect(queueB.enqueueToolUpdate).toHaveBeenLastCalledWith({ category: 'error', detail: 'Bash — boom' });
  });

  it('per_chat result batches turn completion writes through durability.completeTurn', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const queue = makeQueueMock('111@s.whatsapp.net');
    const completeTurn = vi.fn();
    const session = {
      clearTurnWatchdog: vi.fn(),
      shutdown: vi.fn(),
      getDbRowId: vi.fn(() => 41),
      getStatus: vi.fn(() => ({ active: true })),
    };
    (queue.getLastOpId as ReturnType<typeof vi.fn>).mockReturnValue(77);
    (runtime as unknown as { durability: { completeTurn: typeof completeTurn } }).durability = {
      completeTurn,
    };
    const handleEventWithContext = (
      runtime as unknown as {
        handleEventWithContext: (
          event: AgentEvent,
          queue: IOutboundQueue,
          session: {
            clearTurnWatchdog: ReturnType<typeof vi.fn>;
            shutdown: ReturnType<typeof vi.fn>;
            getDbRowId: ReturnType<typeof vi.fn>;
          } | null,
          conversationKey?: string,
          inboundSeq?: number,
          mapKey?: string,
          toolScopeKey?: string,
        ) => void;
      }
    ).handleEventWithContext.bind(runtime);

    handleEventWithContext(
      { type: 'result', text: null, inputTokens: 3, outputTokens: 5 },
      queue,
      session,
      'conv-111',
      17,
      '111',
      '111#session',
    );

    expect(completeTurn).toHaveBeenCalledWith({
      sessionTokens: { dbRowId: 41, inputTokens: 3, outputTokens: 5 },
      checkpoint: {
        conversationKey: 'conv-111',
        fields: {
          activeTurnId: null,
          lastInboundSeq: 17,
          lastFlushedOutboundId: 77,
        },
      },
      inbound: { seq: 17, terminalReason: 'response_sent' },
      lastOpId: 77,
    });
    expect(queue.markLastTerminal).toHaveBeenCalledWith({
      dedupeText: false,
      skipDurabilityMark: true,
    });
    expect(queue.clearLastOpId).not.toHaveBeenCalled();
  });

  it('per_chat error result terminalizes with text dedupe after durability completion', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const queue = makeQueueMock('111@s.whatsapp.net');
    const completeTurn = vi.fn();
    const session = {
      clearTurnWatchdog: vi.fn(),
      shutdown: vi.fn(),
      getDbRowId: vi.fn(() => 41),
      getStatus: vi.fn(() => ({ active: true })),
    };
    (queue.getLastOpId as ReturnType<typeof vi.fn>).mockReturnValue(77);
    (runtime as unknown as { durability: { completeTurn: typeof completeTurn } }).durability = {
      completeTurn,
    };
    const handleEventWithContext = (
      runtime as unknown as {
        handleEventWithContext: (
          event: AgentEvent,
          queue: IOutboundQueue,
          session: {
            clearTurnWatchdog: ReturnType<typeof vi.fn>;
            shutdown: ReturnType<typeof vi.fn>;
            getDbRowId: ReturnType<typeof vi.fn>;
          } | null,
          conversationKey?: string,
          inboundSeq?: number,
          mapKey?: string,
          toolScopeKey?: string,
        ) => void;
      }
    ).handleEventWithContext.bind(runtime);

    handleEventWithContext(
      { type: 'result', text: 'raw terminal provider failure', isError: true },
      queue,
      session,
      'conv-111',
      17,
      '111',
      '111#session',
    );

    expect(queue.enqueueText).toHaveBeenCalledWith(expect.stringContaining('operator has been notified'));
    expect(completeTurn).toHaveBeenCalledWith(expect.objectContaining({ lastOpId: 77 }));
    expect(queue.markLastTerminal).toHaveBeenCalledWith({
      dedupeText: true,
      skipDurabilityMark: true,
    });
    expect(queue.clearLastOpId).not.toHaveBeenCalled();
  });

  it('per_chat transient-network (socket-close) result emits provider_transient_network WARNING, not provider_unknown_terminal CRITICAL', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const queue = makeQueueMock('111@s.whatsapp.net');
    const completeTurn = vi.fn();
    const session = {
      clearTurnWatchdog: vi.fn(),
      shutdown: vi.fn(),
      getDbRowId: vi.fn(() => 41),
      getStatus: vi.fn(() => ({ active: true })),
    };
    (queue.getLastOpId as ReturnType<typeof vi.fn>).mockReturnValue(77);
    (runtime as unknown as { durability: { completeTurn: typeof completeTurn } }).durability = { completeTurn };
    const handleEventWithContext = (
      runtime as unknown as {
        handleEventWithContext: (
          event: AgentEvent,
          queue: IOutboundQueue,
          session: {
            clearTurnWatchdog: ReturnType<typeof vi.fn>;
            shutdown: ReturnType<typeof vi.fn>;
            getDbRowId: ReturnType<typeof vi.fn>;
          } | null,
          conversationKey?: string,
          inboundSeq?: number,
          mapKey?: string,
          toolScopeKey?: string,
        ) => void;
      }
    ).handleEventWithContext.bind(runtime);

    const socketText = 'API Error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()';
    mockEmitAlert.mockClear();

    handleEventWithContext(
      { type: 'result', text: socketText, isError: true },
      queue,
      session,
      'conv-111',
      17,
      '111',
      '111#session',
    );

    // Must emit provider_transient_network at warning severity
    expect(mockEmitAlert).toHaveBeenCalledWith(
      expect.any(String),
      'provider_transient_network',
      'Transient provider connection drop (recoverable)',
      expect.stringContaining('socket connection was closed unexpectedly'),
      'warning',
    );
    // Must NOT emit the CRITICAL unknown-terminal alert
    const unknownCriticalCall = mockEmitAlert.mock.calls.find((c) => c[1] === 'provider_unknown_terminal');
    expect(unknownCriticalCall).toBeUndefined();
    // Raw provider text must not be forwarded
    const forwardedRaw = (queue.enqueueResultText as ReturnType<typeof vi.fn>).mock.calls.map((a: unknown[]) => a[0] as string);
    expect(forwardedRaw).not.toContain(socketText);
    // Generic user notice is sent
    expect(queue.enqueueText).toHaveBeenCalledWith(expect.stringContaining('operator has been notified'));
  });

  // Regression guard: under WHATSOUP_RESPONSE_REGISTRY_DISPATCH=1, server-error
  // and transient-network terminal-result texts bridge to registry workflows
  // (provider_server_error / provider_network_error) whose providerKind is null.
  // The registry dispatcher must NOT swallow these — handleProviderFailureResult
  // returns immediately on a null providerKind, so dispatch must fall through to
  // the legacy ladders (which emit the user notice, the ops alert, and record the
  // turn failure). Before the fix, dispatch returned true and the caller `break`d
  // BEFORE the legacy handling, producing a silent no-op (lost notice/alert/turn-
  // failure accounting). These tests must FAIL on the pre-fix code.
  describe('registry dispatch — null-providerKind classes fall through to legacy (not silent no-op)', () => {
    const SOCKET_TEXT = 'API Error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()';
    const SERVER_TEXT = 'API Error 503: Service temporarily unavailable. overloaded_error';

    afterEach(() => {
      delete process.env['WHATSOUP_RESPONSE_REGISTRY_DISPATCH'];
    });

    function makePerChatDispatchHarness() {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const queue = makeQueueMock('111@s.whatsapp.net');
      const session = {
        clearTurnWatchdog: vi.fn(),
        shutdown: vi.fn(),
        getDbRowId: vi.fn(() => 41),
        getStatus: vi.fn(() => ({ active: true })),
      };
      (queue.getLastOpId as ReturnType<typeof vi.fn>).mockReturnValue(77);
      (runtime as unknown as {
        durability: {
          completeTurn: ReturnType<typeof vi.fn>;
          upsertSessionCheckpoint: ReturnType<typeof vi.fn>;
          completeInbound: ReturnType<typeof vi.fn>;
        };
      }).durability = {
        completeTurn: vi.fn(),
        upsertSessionCheckpoint: vi.fn(),
        completeInbound: vi.fn(),
      };
      const handleEventWithContext = (
        runtime as unknown as {
          handleEventWithContext: (
            event: AgentEvent,
            queue: IOutboundQueue,
            session: unknown,
            conversationKey?: string,
            inboundSeq?: number,
            mapKey?: string,
            toolScopeKey?: string,
          ) => void;
        }
      ).handleEventWithContext.bind(runtime);
      return { runtime, queue, session, handleEventWithContext };
    }

    it('transient-network result with dispatch enabled still emits WARNING alert + notice + records turn failure', () => {
      process.env['WHATSOUP_RESPONSE_REGISTRY_DISPATCH'] = '1';
      const { runtime, queue, session, handleEventWithContext } = makePerChatDispatchHarness();
      mockEmitAlert.mockClear();

      handleEventWithContext(
        { type: 'result', text: SOCKET_TEXT, isError: true },
        queue,
        session,
        'conv-111',
        17,
        '111',
        '111#session',
      );

      // Observable outcome: WARNING transient-network alert (NOT a silent no-op).
      expect(mockEmitAlert).toHaveBeenCalledWith(
        expect.any(String),
        'provider_transient_network',
        'Transient provider connection drop (recoverable)',
        expect.stringContaining('socket connection was closed unexpectedly'),
        'warning',
      );
      // Generic notice reaches the user.
      expect(queue.enqueueText).toHaveBeenCalledWith(expect.stringContaining('operator has been notified'));
      // Raw provider text is not forwarded.
      const forwardedRaw = (queue.enqueueResultText as ReturnType<typeof vi.fn>).mock.calls.map((a: unknown[]) => a[0] as string);
      expect(forwardedRaw).not.toContain(SOCKET_TEXT);
      // Turn-capability accounting records the transient-network failure.
      const turnCapability = (runtime.getHealthSnapshot().details as Record<string, unknown>).turnCapability as { lastTurnErrorClass?: string };
      expect(turnCapability.lastTurnErrorClass).toBe('transient-network');
    });

    it('server-error result with dispatch enabled arms fallback + records turn failure', () => {
      process.env['WHATSOUP_RESPONSE_REGISTRY_DISPATCH'] = '1';
      const agentConfig = mockConfig as typeof mockConfig & {
        agentProvider?: string;
        agentFallbackProvider?: string;
        agentFallbackModel?: string;
      };
      agentConfig.agentProvider = 'claude-cli';
      agentConfig.agentFallbackProvider = 'opencode-cli';
      agentConfig.agentFallbackModel = 'minimax/minimax-m2';
      const { runtime, queue, session, handleEventWithContext } = makePerChatDispatchHarness();
      mockEmitAlert.mockClear();

      handleEventWithContext(
        { type: 'result', text: SERVER_TEXT, isError: true },
        queue,
        session,
        'conv-111',
        17,
        '111',
        '111#session',
      );

      expect(runtime.getFallbackState().fallbackReason).toBe('server-error');
      expect(runtime.getFallbackState().fallbackActiveUntil).toEqual(expect.any(Number));
      expect(mockEmitAlert.mock.calls.find((c) => c[1] === 'provider_unknown_terminal')).toBeUndefined();
      // Raw provider text is not forwarded.
      const forwardedRaw = (queue.enqueueResultText as ReturnType<typeof vi.fn>).mock.calls.map((a: unknown[]) => a[0] as string);
      expect(forwardedRaw).not.toContain(SERVER_TEXT);
      // Turn-capability accounting records the real provider failure class.
      const turnCapability = (runtime.getHealthSnapshot().details as Record<string, unknown>).turnCapability as { lastTurnErrorClass?: string };
      expect(turnCapability.lastTurnErrorClass).toBe('server-error');
    });
  });

  it('per_chat system-turn result does not terminate the user inbound seq or disarm its reply guarantee', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const queue = makeQueueMock('111@s.whatsapp.net');
    const completeTurn = vi.fn();
    const disarm = vi.fn();
    const session = {
      clearTurnWatchdog: vi.fn(),
      shutdown: vi.fn(),
      getDbRowId: vi.fn(() => 41),
      getStatus: vi.fn(() => ({ active: true })),
    };
    (queue.getLastOpId as ReturnType<typeof vi.fn>).mockReturnValue(77);
    (runtime as unknown as { durability: { completeTurn: typeof completeTurn } }).durability = { completeTurn };
    (runtime as unknown as { replyGuarantee: { disarm: typeof disarm } }).replyGuarantee = { disarm };
    const handleEventWithContext = (
      runtime as unknown as {
        handleEventWithContext: (
          event: AgentEvent,
          queue: IOutboundQueue,
          session: {
            clearTurnWatchdog: ReturnType<typeof vi.fn>;
            shutdown: ReturnType<typeof vi.fn>;
            getDbRowId: ReturnType<typeof vi.fn>;
          } | null,
          conversationKey?: string,
          inboundSeq?: number,
          mapKey?: string,
          toolScopeKey?: string,
          isSystemResult?: boolean,
        ) => void;
      }
    ).handleEventWithContext.bind(runtime);

    // isSystemResult = true (e.g. context injection on respawn) carries the
    // peeked user seq (17) but must NOT mark it response_sent or disarm its
    // reply guarantee — otherwise a crash before the real turn replies drops it.
    handleEventWithContext(
      { type: 'result', text: null, inputTokens: 3, outputTokens: 5 },
      queue,
      session,
      'conv-111',
      17,
      '111',
      '111#session',
      true,
    );

    const arg = completeTurn.mock.calls[0][0] as { inbound?: unknown; sessionTokens?: unknown };
    expect(arg.inbound).toBeUndefined();
    expect(disarm).not.toHaveBeenCalled();
    // Token/checkpoint accounting still runs for the system turn.
    expect(arg.sessionTokens).toEqual({ dbRowId: 41, inputTokens: 3, outputTokens: 5 });
  });

  it('shared model-unavailable result is not forwarded raw to the user (shared path)', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { shared: true });
    const queue = makeQueueMock('111@s.whatsapp.net');

    const state = runtime as unknown as {
      durability: {
        completeTurn: ReturnType<typeof vi.fn>;
        upsertSessionCheckpoint: ReturnType<typeof vi.fn>;
        completeInbound: ReturnType<typeof vi.fn>;
      };
      session: typeof mockSession;
      activeChatJid: string | null;
      currentTurnChatJid: string | null;
      currentInboundSeq: number | undefined;
      outboundQueues: Map<string, IOutboundQueue>;
      handleEvent: (event: AgentEvent) => void;
    };
    state.durability = { completeTurn: vi.fn(), upsertSessionCheckpoint: vi.fn(), completeInbound: vi.fn() };
    state.session = Object.assign({}, mockSession, { shutdown: vi.fn(), clearTurnWatchdog: vi.fn() });
    state.activeChatJid = '111@s.whatsapp.net';
    state.currentTurnChatJid = '111@s.whatsapp.net';
    state.currentInboundSeq = 1;
    state.outboundQueues.set('111@s.whatsapp.net', queue);

    const raw = "There's an issue with the selected model (x). It may not exist or you may not have access to it.";
    state.handleEvent({ type: 'result', text: raw, isError: true });

    const forwarded = (queue.enqueueResultText as ReturnType<typeof vi.fn>).mock.calls.map((a) => a[0] as string);
    expect(forwarded).not.toContain(raw);
    const turnCapability = (runtime.getHealthSnapshot().details as Record<string, any>).turnCapability;
    expect(turnCapability.lastTurnErrorClass).toBe('model-unavailable');
    expect(turnCapability.lastTurnErrorAt).toEqual(expect.any(Number));
    expect(JSON.stringify(turnCapability)).not.toContain(raw);
  });

  it('shared result batches turn completion writes through durability.completeTurn', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { shared: true });
    const queue = makeQueueMock('111@s.whatsapp.net');
    const completeTurn = vi.fn();
    (queue.getLastOpId as ReturnType<typeof vi.fn>).mockReturnValue(88);

    const state = runtime as unknown as {
      durability: { completeTurn: typeof completeTurn };
      session: typeof mockSession;
      activeChatJid: string | null;
      currentTurnChatJid: string | null;
      currentInboundSeq: number | undefined;
      turnHadVisibleOutput: boolean;
      outboundQueues: Map<string, IOutboundQueue>;
      handleEvent: (event: AgentEvent) => void;
    };
    state.durability = { completeTurn };
    state.session = Object.assign({}, mockSession, {
      getDbRowId: vi.fn(() => 52),
      clearTurnWatchdog: vi.fn(),
    });
    state.activeChatJid = '111@s.whatsapp.net';
    state.currentTurnChatJid = '111@s.whatsapp.net';
    state.currentInboundSeq = 23;
    state.turnHadVisibleOutput = true;
    state.outboundQueues.set('111@s.whatsapp.net', queue);

    state.handleEvent({ type: 'result', text: 'done', inputTokens: 8, outputTokens: 13 });

    expect(completeTurn).toHaveBeenCalledWith({
      sessionTokens: { dbRowId: 52, inputTokens: 8, outputTokens: 13 },
      checkpoint: {
        conversationKey: '111',
        fields: {
          activeTurnId: null,
          lastInboundSeq: 23,
          lastFlushedOutboundId: 88,
        },
      },
      inbound: { seq: 23, terminalReason: 'response_sent' },
      lastOpId: 88,
    });
    expect(queue.markLastTerminal).toHaveBeenCalledWith({
      dedupeText: false,
      skipDurabilityMark: true,
    });
    expect(queue.clearLastOpId).not.toHaveBeenCalled();
    expect(queue.enqueueResultText).toHaveBeenCalledWith('done');
    expect(queue.enqueueText).not.toHaveBeenCalledWith('_(no response)_');
    expect(queue.flush).toHaveBeenCalledOnce();
    expect({
      activeTurnChatJid: state.currentTurnChatJid,
      pendingInboundSeq: state.currentInboundSeq,
      visibleOutputForNextTurn: state.turnHadVisibleOutput,
    }).toEqual({
      activeTurnChatJid: null,
      pendingInboundSeq: undefined,
      visibleOutputForNextTurn: false,
    });
  });

  it('shared error result terminalizes with text dedupe after durability completion', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { shared: true });
    const queue = makeQueueMock('111@s.whatsapp.net');
    const completeTurn = vi.fn();
    (queue.getLastOpId as ReturnType<typeof vi.fn>).mockReturnValue(88);

    const state = runtime as unknown as {
      durability: { completeTurn: typeof completeTurn };
      session: typeof mockSession;
      activeChatJid: string | null;
      currentTurnChatJid: string | null;
      currentInboundSeq: number | undefined;
      turnHadVisibleOutput: boolean;
      outboundQueues: Map<string, IOutboundQueue>;
      handleEvent: (event: AgentEvent) => void;
    };
    state.durability = { completeTurn };
    state.session = Object.assign({}, mockSession, {
      getDbRowId: vi.fn(() => 52),
      clearTurnWatchdog: vi.fn(),
    });
    state.activeChatJid = '111@s.whatsapp.net';
    state.currentTurnChatJid = '111@s.whatsapp.net';
    state.currentInboundSeq = 23;
    state.turnHadVisibleOutput = true;
    state.outboundQueues.set('111@s.whatsapp.net', queue);

    state.handleEvent({ type: 'result', text: 'raw terminal provider failure', isError: true });

    expect(queue.enqueueText).toHaveBeenCalledWith(expect.stringContaining('operator has been notified'));
    expect(completeTurn).toHaveBeenCalledWith(expect.objectContaining({ lastOpId: 88 }));
    expect(queue.markLastTerminal).toHaveBeenCalledWith({
      dedupeText: true,
      skipDurabilityMark: true,
    });
    expect(queue.clearLastOpId).not.toHaveBeenCalled();
  });

  // ─── Voice reply integration tests (SP4) ─────────────────────────────────────

  describe('voice reply (SP4)', () => {
    it('does NOT call synthesizeSpeech when voiceReply is "never"', async () => {
      mockConfig.voiceReply = 'never';
      mockSession.getStatus.mockReturnValue({ active: true, pid: 1, sessionId: 's1', startedAt: new Date().toISOString(), messageCount: 0, lastMessageAt: null });

      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger);
      await runtime.start();

      await sendAndDrain(runtime, makeMsg({ content: 'hello', contentType: 'audio' }));

      // Fire result event to complete the turn
      capturedOnEventRef.current?.({ type: 'assistant_text', text: 'Hi there!' });
      capturedOnEventRef.current?.({ type: 'result', text: null });
      await mockQueue.flush.mock.results[0]?.value;

      expect(mockSynthesizeSpeech).not.toHaveBeenCalled();
    });

    it('synthesizes and sends voice when voiceReply is "always" and inbound is text', async () => {
      mockConfig.voiceReply = 'always';
      // Set up synthesizeSpeech to resolve on every call
      mockSynthesizeSpeech.mockResolvedValue({
        buffer: Buffer.from('audio-bytes'),
        duration: 3,
        mimeType: 'audio/mpeg',
      });
      mockSession.getStatus.mockReturnValue({ active: true, pid: 1, sessionId: 's1', startedAt: new Date().toISOString(), messageCount: 0, lastMessageAt: null });

      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger);
      await runtime.start();

      await sendAndDrain(runtime, makeMsg({ content: 'hello', contentType: 'text' }));

      capturedOnEventRef.current?.({ type: 'assistant_text', text: 'Hello back!' });
      capturedOnEventRef.current?.({ type: 'result', text: null });
      // Wait for flush and async voice reply chain to settle
      await vi.waitFor(() => {
        expect(mockSynthesizeSpeech).toHaveBeenCalledWith('Hello back!', expect.objectContaining({
          voiceId: 'test-voice-id',
        }));
      }, { timeout: 500 });

      expect(messenger.sendMedia).toHaveBeenCalledWith(
        'test@s.whatsapp.net',
        expect.objectContaining({ ptt: true, type: 'audio' }),
      );
    });

    it('synthesizes voice when voiceReply is "when_received" and inbound is audio', async () => {
      mockConfig.voiceReply = 'when_received';
      mockSynthesizeSpeech.mockResolvedValue({
        buffer: Buffer.from('audio-bytes'),
        duration: 5,
        mimeType: 'audio/mpeg',
      });
      mockSession.getStatus.mockReturnValue({ active: true, pid: 1, sessionId: 's1', startedAt: new Date().toISOString(), messageCount: 0, lastMessageAt: null });

      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger);
      await runtime.start();

      await sendAndDrain(runtime, makeMsg({ content: '[Voice note transcription]: test audio', contentType: 'audio' }));

      capturedOnEventRef.current?.({ type: 'assistant_text', text: 'I heard you!' });
      capturedOnEventRef.current?.({ type: 'result', text: null });
      await vi.waitFor(() => {
        expect(mockSynthesizeSpeech).toHaveBeenCalledWith('I heard you!', expect.anything());
      }, { timeout: 500 });
    });

    it('does NOT synthesize voice when voiceReply is "when_received" and inbound is text', async () => {
      mockConfig.voiceReply = 'when_received';
      mockSession.getStatus.mockReturnValue({ active: true, pid: 1, sessionId: 's1', startedAt: new Date().toISOString(), messageCount: 0, lastMessageAt: null });

      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger);
      await runtime.start();

      await sendAndDrain(runtime, makeMsg({ content: 'hello', contentType: 'text' }));

      capturedOnEventRef.current?.({ type: 'assistant_text', text: 'Reply text' });
      capturedOnEventRef.current?.({ type: 'result', text: null });
      await mockQueue.flush.mock.results[0]?.value;

      expect(mockSynthesizeSpeech).not.toHaveBeenCalled();
    });

    it('does not propagate synthesis errors — text response already sent', async () => {
      mockConfig.voiceReply = 'always';
      mockSynthesizeSpeech.mockRejectedValue(new Error('ElevenLabs circuit breaker open'));
      mockSession.getStatus.mockReturnValue({ active: true, pid: 1, sessionId: 's1', startedAt: new Date().toISOString(), messageCount: 0, lastMessageAt: null });

      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger);
      await runtime.start();

      await sendAndDrain(runtime, makeMsg({ content: 'hello', contentType: 'text' }));

      capturedOnEventRef.current?.({ type: 'assistant_text', text: 'Response text' });
      capturedOnEventRef.current?.({ type: 'result', text: null });
      // Should not throw — error is swallowed (non-fatal)
      await vi.waitFor(() => {
        expect(mockSynthesizeSpeech).toHaveBeenCalled();
      }, { timeout: 500 });
    });
  });

  // ─── AE1: Group Resume Suppression ───────────────────────────────────────────
  describe('AE1 — group resume suppression', () => {
    it('skips proactive resume for group checkpoints and marks them ended, resumes DMs normally', async () => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });

      mockSession.spawnSession.mockImplementation(() => new Promise<void>(() => {}));

      const mockDurability = {
        getResumableCheckpoints: vi.fn(() => [
          { conversation_key: '111111100000000001_at_g.us' },
          { conversation_key: '15551230006' },
        ]),
        getSessionCheckpoint: vi.fn((key: string) => {
          if (key === '111111100000000001_at_g.us') return { session_id: 'group-sess-1' };
          if (key === '15551230006') return { session_id: 'dm-sess-1' };
          return null;
        }),
        upsertSessionCheckpoint: vi.fn(),
      };
      (runtime as unknown as { durability: unknown }).durability = mockDurability;

      await runtime.start();

      // Group checkpoint must be tombstoned as 'ended'
      expect(mockDurability.upsertSessionCheckpoint).toHaveBeenCalledWith(
        '111111100000000001_at_g.us',
        { sessionStatus: 'ended' },
      );

      // DM must have triggered spawnSession (session was created)
      expect(mockSession.spawnSession).toHaveBeenCalledTimes(1);

      // Group must NOT have triggered spawnSession
      const spawnCalls = mockSession.spawnSession.mock.calls;
      // spawnSession is called on a SessionManager instance, not with the key directly —
      // verify it was called exactly once (for the DM) and not twice (which would mean group was also resumed)
      expect(spawnCalls).toHaveLength(1);
    });

    it('DM-only resume works normally when no group checkpoints present', async () => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });

      mockSession.spawnSession.mockImplementation(() => new Promise<void>(() => {}));

      const mockDurability = {
        getResumableCheckpoints: vi.fn(() => [
          { conversation_key: '15551230006' },
        ]),
        getSessionCheckpoint: vi.fn((_key: string) => ({ session_id: 'dm-sess-2' })),
        upsertSessionCheckpoint: vi.fn(),
      };
      (runtime as unknown as { durability: unknown }).durability = mockDurability;

      await runtime.start();

      // DM checkpoint must have spawned a session
      expect(mockSession.spawnSession).toHaveBeenCalledTimes(1);

      // No tombstoning should have occurred for DMs
      expect(mockDurability.upsertSessionCheckpoint).not.toHaveBeenCalledWith(
        '15551230006',
        { sessionStatus: 'ended' },
      );
    });

    it('proactive resume skips invalid, stale, and already-active checkpoints before resuming a service-key chat', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-10T10:00:00Z'));
      try {
        const db = makeDb();
        const { messenger } = makeMessenger();
        const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
        const state = runtime as unknown as {
          chatSessions: Map<string, unknown>;
        };
        state.chatSessions.set('already-active@lid', mockSession);
        mockSession.spawnSession.mockImplementation(() => new Promise<void>(() => {}));

        const mockDurability = {
          getResumableCheckpoints: vi.fn(() => [
            { conversation_key: 'missing-session' },
            { conversation_key: 'stale-dm' },
            { conversation_key: 'already-active' },
            { conversation_key: '15551230009_at_s.whatsapp.net' },
          ]),
          getSessionCheckpoint: vi.fn((key: string) => {
            if (key === 'missing-session') return null;
            if (key === 'stale-dm') {
              return {
                session_id: 'stale-session',
                updated_at: '2026-06-10T08:00:00',
              };
            }
            if (key === 'already-active') {
              return {
                session_id: 'duplicate-session',
                updated_at: '2026-06-10T09:59:00',
              };
            }
            return {
              session_id: 'service-session',
              updated_at: '2026-06-10T09:59:00',
            };
          }),
          upsertSessionCheckpoint: vi.fn(),
        };
        (runtime as unknown as { durability: unknown }).durability = mockDurability;

        await runtime.start();

        expect(mockSession.spawnSession).toHaveBeenCalledTimes(1);
        expect(mockSession.spawnSession).toHaveBeenCalledWith('service-session');
        expect(state.chatSessions.has('already-active@lid')).toBe(true);
        expect(state.chatSessions.has('15551230009@s.whatsapp.net')).toBe(true);
        expect(mockDurability.upsertSessionCheckpoint).toHaveBeenCalledWith(
          'stale-dm',
          { sessionStatus: 'ended' },
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('proactive resume callbacks drop orphaned events and clean inactive queues on notify', async () => {
      const db = makeDb();
      const { messenger, sentMessages } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });

      mockSession.spawnSession.mockImplementation(() => new Promise<void>(() => {}));
      mockSession.getStatus.mockReturnValue({
        active: false,
        pid: null,
        sessionId: 'dm-sess-callbacks',
        startedAt: new Date().toISOString(),
        messageCount: 1,
        lastMessageAt: null,
      });

      const mockDurability = {
        getResumableCheckpoints: vi.fn(() => [
          { conversation_key: '15551230007' },
        ]),
        getSessionCheckpoint: vi.fn((_key: string) => ({ session_id: 'dm-sess-callbacks' })),
        upsertSessionCheckpoint: vi.fn(),
      };
      (runtime as unknown as { durability: unknown }).durability = mockDurability;

      const state = runtime as unknown as {
        chatSessions: Map<string, unknown>;
        chatQueues: Map<string, typeof mockQueue>;
        handleEventPerChat: ReturnType<typeof vi.fn>;
      };
      state.handleEventPerChat = vi.fn();

      await runtime.start();

      const mapKey = [...state.chatSessions.keys()][0] ?? '';
      expect(mapKey).toBe('15551230007@lid');
      const resumedQueue = state.chatQueues.get(mapKey);
      expect(resumedQueue).toBeDefined();

      capturedNotifyUserRef.current?.('resume callback notice');

      expect(resumedQueue?.abortTurn).toHaveBeenCalledTimes(1);
      expect(state.chatSessions.has(mapKey)).toBe(false);
      expect(state.chatQueues.has(mapKey)).toBe(false);
      expect(sentMessages).toEqual([
        { jid: '15551230007@lid', text: 'resume callback notice' },
      ]);

      capturedOnEventRef.current?.({ type: 'result', text: 'late result' });

      expect(state.handleEventPerChat).not.toHaveBeenCalled();
      expect(mockRuntimeLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          initialMapKey: mapKey,
          chatJid: '15551230007@lid',
          eventType: 'result',
        }),
        'event dropped — session key missing for per-chat callback',
      );
    });

    it('proactive resume injects missed messages and unmarks failed continuation sends', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-10T10:00:00Z'));
      try {
        const db = makeDb();
        const { messenger } = makeMessenger();
        const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });

        mockSession.getStatus.mockReturnValue({
          active: true,
          pid: 123,
          sessionId: 'dm-sess-continuation',
          startedAt: new Date().toISOString(),
          messageCount: 1,
          lastMessageAt: null,
        });
        mockSession.sendTurn.mockRejectedValueOnce(new Error('stdin closed'));

        const mockDurability = {
          getResumableCheckpoints: vi.fn(() => [
            { conversation_key: '15551230008' },
          ]),
          getSessionCheckpoint: vi.fn((_key: string) => ({
            session_id: 'dm-sess-continuation',
            updated_at: '2026-06-10T09:59:00',
          })),
          completeTurn: vi.fn(),
          upsertSessionCheckpoint: vi.fn(),
        };
        (runtime as unknown as { durability: unknown }).durability = mockDurability;

        const state = runtime as unknown as {
          injectMissedMessages: ReturnType<typeof vi.fn>;
          pendingSystemResults: {
            counts: Map<string, number>;
          };
        };
        state.injectMissedMessages = vi.fn(async () => true);

        await runtime.start();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1_000);

        expect(state.injectMissedMessages).toHaveBeenCalledWith(
          mockSession,
          '15551230008@lid',
          Math.floor(new Date('2026-06-10T09:59:00Z').getTime() / 1000),
        );
        expect(mockSession.sendTurn).toHaveBeenCalledWith(
          '[System: session resumed after service restart — continue where you left off]',
        );
        expect(state.pendingSystemResults.counts.get('15551230008@lid') ?? 0).toBe(1);
        expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
          expect.objectContaining({
            err: expect.any(Error),
            chatJid: '15551230008@lid',
          }),
          'failed to send continuation turn after resume',
        );

        await emitAgentResult(25, 'context received');

        expect(state.pendingSystemResults.counts.get('15551230008@lid') ?? 0).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('proactive resume continuation stops when inactive and sends once when no messages were missed', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-10T10:00:00Z'));
      try {
        const inactiveRuntime = new AgentRuntime(makeDb(), makeMessenger().messenger, 'test', { sessionScope: 'per_chat' });
        const inactiveDurability = {
          getResumableCheckpoints: vi.fn(() => [
            { conversation_key: '15551230010' },
          ]),
          getSessionCheckpoint: vi.fn(() => ({
            session_id: 'inactive-session',
            updated_at: '2026-06-10T09:59:00',
          })),
          upsertSessionCheckpoint: vi.fn(),
        };
        (inactiveRuntime as unknown as { durability: unknown }).durability = inactiveDurability;
        const inactiveState = inactiveRuntime as unknown as {
          injectMissedMessages: ReturnType<typeof vi.fn>;
        };
        inactiveState.injectMissedMessages = vi.fn(async () => true);
        mockSession.getStatus.mockReturnValueOnce({
          active: false,
          pid: null,
          sessionId: 'inactive-session',
          startedAt: null,
          messageCount: 0,
          lastMessageAt: null,
        });

        await inactiveRuntime.start();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1_000);

        expect(inactiveState.injectMissedMessages).not.toHaveBeenCalled();
        expect(mockSession.sendTurn).not.toHaveBeenCalledWith(
          '[System: session resumed after service restart — continue where you left off]',
        );

        vi.clearAllMocks();
        mockSession.spawnSession.mockResolvedValue(undefined);
        const activeRuntime = new AgentRuntime(makeDb(), makeMessenger().messenger, 'test', { sessionScope: 'per_chat' });
        const activeDurability = {
          getResumableCheckpoints: vi.fn(() => [
            { conversation_key: '15551230011' },
          ]),
          getSessionCheckpoint: vi.fn(() => ({
            session_id: 'active-session',
            updated_at: '2026-06-10T09:59:00',
          })),
          upsertSessionCheckpoint: vi.fn(),
        };
        (activeRuntime as unknown as { durability: unknown }).durability = activeDurability;
        const activeState = activeRuntime as unknown as {
          injectMissedMessages: ReturnType<typeof vi.fn>;
          pendingSystemResults: {
            mark: ReturnType<typeof vi.fn>;
            unmark: ReturnType<typeof vi.fn>;
          };
        };
        activeState.injectMissedMessages = vi.fn(async () => false);
        activeState.pendingSystemResults.mark = vi.fn();
        activeState.pendingSystemResults.unmark = vi.fn();
        mockSession.getStatus.mockReturnValue({
          active: true,
          pid: 123,
          sessionId: 'active-session',
          startedAt: new Date().toISOString(),
          messageCount: 1,
          lastMessageAt: null,
        });
        mockSession.sendTurn.mockResolvedValue(undefined);

        await activeRuntime.start();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1_000);

        expect(activeState.injectMissedMessages).toHaveBeenCalledWith(
          mockSession,
          '15551230011@lid',
          Math.floor(new Date('2026-06-10T09:59:00Z').getTime() / 1000),
        );
        expect(activeState.pendingSystemResults.mark).toHaveBeenCalledTimes(1);
        expect(activeState.pendingSystemResults.mark).toHaveBeenCalledWith('15551230011@lid');
        expect(activeState.pendingSystemResults.unmark).not.toHaveBeenCalled();
        expect(mockSession.sendTurn).toHaveBeenCalledWith(
          '[System: session resumed after service restart — continue where you left off]',
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ─── AE2: Shared/Single Mode Staleness + Group Guard ─────────────────────────
  describe('AE2 — shared/single staleness + group guard', () => {
    beforeEach(() => {
      mockGetActiveSession.mockReset();
      mockSession.spawnSession.mockReset();
      mockSession.spawnSession.mockResolvedValue(undefined);
      mockSession.shutdown.mockReset();
      mockSession.shutdown.mockResolvedValue(undefined);
    });

    it('legacy active rows with no chat_jid are skipped before checkpoint lookup', async () => {
      const db = makeDb();
      const { messenger } = makeMessenger();

      mockGetActiveSession.mockReturnValue({
        id: 8,
        session_id: 'sess-legacy-null-chat',
        chat_jid: null,
        claude_pid: 0,
        status: 'active',
        started_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        last_message_at: null,
        message_count: 0,
      });

      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'single' });
      const mockDurability = {
        getSessionCheckpoint: vi.fn(),
        upsertSessionCheckpoint: vi.fn(),
      };
      (runtime as unknown as { durability: unknown }).durability = mockDurability;

      await runtime.start();

      expect(mockDurability.getSessionCheckpoint).not.toHaveBeenCalled();
      expect(mockDurability.upsertSessionCheckpoint).not.toHaveBeenCalled();
      expect(mockSession.spawnSession).not.toHaveBeenCalled();
      expect(runtime.popStartupMessage()).toBeNull();
      expect(mockRuntimeLogger.info).toHaveBeenCalledWith(
        'skipping shared/single resume — no chat_jid on session row',
      );
    });

    it('stale session skipped — single mode, session older than 60 min', async () => {
      const db = makeDb();
      const { messenger } = makeMessenger();

      mockGetActiveSession.mockReturnValue({
        id: 1,
        session_id: 'sess-stale',
        chat_jid: 'user@s.whatsapp.net',
        claude_pid: 0,
        status: 'active',
        started_at: new Date(Date.now() - 120 * 60_000).toISOString(),
        last_message_at: null,
        message_count: 0,
      });

      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'single' });

      const mockDurability = {
        getSessionCheckpoint: vi.fn(() => ({
          id: 1,
          conversation_key: 'user',
          session_id: 'sess-stale',
          transcript_path: null,
          active_turn_id: null,
          last_inbound_seq: null,
          last_flushed_outbound_id: null,
          watchdog_state: null,
          workspace_path: null,
          claude_pid: null,
          session_status: 'active',
          checkpoint_version: 1,
          updated_at: new Date(Date.now() - 120 * 60_000).toISOString().replace('Z', ''),
        })),
        upsertSessionCheckpoint: vi.fn(),
      };
      (runtime as unknown as { durability: unknown }).durability = mockDurability;

      await runtime.start();

      // Session too stale — should NOT spawn
      expect(mockSession.spawnSession).not.toHaveBeenCalled();
      // Checkpoint should be tombstoned
      expect(mockDurability.upsertSessionCheckpoint).toHaveBeenCalledWith(
        'user',
        { sessionStatus: 'ended' },
      );
    });

    it('shared mode group suppression — session spawned but no startup message', async () => {
      const db = makeDb();
      const { messenger } = makeMessenger();

      mockGetActiveSession.mockReturnValue({
        id: 2,
        session_id: 'sess-shared-group',
        chat_jid: '111111100000000001@g.us',
        claude_pid: 0,
        status: 'active',
        started_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        last_message_at: null,
        message_count: 0,
      });

      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'shared' });

      const mockDurability = {
        getSessionCheckpoint: vi.fn(() => ({
          id: 2,
          conversation_key: '111111100000000001_at_g.us',
          session_id: 'sess-shared-group',
          transcript_path: null,
          active_turn_id: null,
          last_inbound_seq: null,
          last_flushed_outbound_id: null,
          watchdog_state: null,
          workspace_path: null,
          claude_pid: null,
          session_status: 'active',
          checkpoint_version: 1,
          updated_at: new Date(Date.now() - 5 * 60_000).toISOString().replace('Z', ''),
        })),
        upsertSessionCheckpoint: vi.fn(),
      };
      (runtime as unknown as { durability: unknown }).durability = mockDurability;

      await runtime.start();

      // Session IS spawned (shared mode serves all chats)
      expect(mockSession.spawnSession).toHaveBeenCalledWith('sess-shared-group', 2);
      // But NO startup message (group chat)
      expect(runtime.popStartupMessage()).toBeNull();
      // Session remains alive
      expect(mockSession.shutdown).not.toHaveBeenCalled();
    });

    it('single mode group skip — no spawn, no shutdown (Bug I2 fix)', async () => {
      const db = makeDb();
      const { messenger } = makeMessenger();

      mockGetActiveSession.mockReturnValue({
        id: 3,
        session_id: 'sess-single-group',
        chat_jid: '111111100000000001@g.us',
        claude_pid: 0,
        status: 'active',
        started_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        last_message_at: null,
        message_count: 0,
      });

      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'single' });

      const mockDurability = {
        getSessionCheckpoint: vi.fn(() => ({
          id: 3,
          conversation_key: '111111100000000001_at_g.us',
          session_id: 'sess-single-group',
          transcript_path: null,
          active_turn_id: null,
          last_inbound_seq: null,
          last_flushed_outbound_id: null,
          watchdog_state: null,
          workspace_path: null,
          claude_pid: null,
          session_status: 'active',
          checkpoint_version: 1,
          updated_at: new Date(Date.now() - 5 * 60_000).toISOString().replace('Z', ''),
        })),
        upsertSessionCheckpoint: vi.fn(),
      };
      (runtime as unknown as { durability: unknown }).durability = mockDurability;

      await runtime.start();

      // Bug I2 fix: single+group skips entirely — no spawn, no shutdown
      expect(mockSession.spawnSession).not.toHaveBeenCalled();
      expect(mockSession.shutdown).not.toHaveBeenCalled();
      // No startup message
      expect(runtime.popStartupMessage()).toBeNull();
    });

    it('fresh DM resumes normally — single mode', async () => {
      const db = makeDb();
      const { messenger } = makeMessenger();

      mockGetActiveSession.mockReturnValue({
        id: 4,
        session_id: 'sess-dm-fresh',
        chat_jid: 'user@s.whatsapp.net',
        claude_pid: 0,
        status: 'active',
        started_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        last_message_at: null,
        message_count: 0,
      });

      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'single' });

      const mockDurability = {
        getSessionCheckpoint: vi.fn(() => ({
          id: 4,
          conversation_key: 'user',
          session_id: 'sess-dm-fresh',
          transcript_path: null,
          active_turn_id: null,
          last_inbound_seq: null,
          last_flushed_outbound_id: null,
          watchdog_state: null,
          workspace_path: null,
          claude_pid: null,
          session_status: 'active',
          checkpoint_version: 1,
          updated_at: new Date(Date.now() - 5 * 60_000).toISOString().replace('Z', ''),
        })),
        upsertSessionCheckpoint: vi.fn(),
      };
      (runtime as unknown as { durability: unknown }).durability = mockDurability;

      await runtime.start();

      // Session spawned normally
      expect(mockSession.spawnSession).toHaveBeenCalledWith('sess-dm-fresh', 4);
      // Startup message IS set (DM, not group)
      const pending = runtime.popStartupMessage();
      expect(pending).not.toBeNull();
      expect(pending!.chatJid).toBe('user@s.whatsapp.net');
      expect(pending!.text).toContain('Resuming');
      // Session NOT shutdown
      expect(mockSession.shutdown).not.toHaveBeenCalled();
    });

    it('checkpoint exists but updated_at is null — skip resume, do not spawn', async () => {
      const db = makeDb();
      const { messenger } = makeMessenger();

      mockGetActiveSession.mockReturnValue({
        id: 5,
        session_id: 'sess-null-ts',
        chat_jid: 'user@s.whatsapp.net',
        claude_pid: 0,
        status: 'active',
        started_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        last_message_at: null,
        message_count: 0,
      });

      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'single' });

      const mockDurability = {
        getSessionCheckpoint: vi.fn(() => ({
          id: 5,
          conversation_key: 'user',
          session_id: 'sess-null-ts',
          transcript_path: null,
          active_turn_id: null,
          last_inbound_seq: null,
          last_flushed_outbound_id: null,
          watchdog_state: null,
          workspace_path: null,
          claude_pid: null,
          session_status: 'active',
          checkpoint_version: 1,
          updated_at: null,
        })),
        upsertSessionCheckpoint: vi.fn(),
      };
      (runtime as unknown as { durability: unknown }).durability = mockDurability;

      await runtime.start();

      // Checkpoint exists but updated_at is null — cannot verify freshness, must skip
      expect(mockSession.spawnSession).not.toHaveBeenCalled();
    });

    it('single-mode DM spawnSession failure — runtime continues without session (C1 error path)', async () => {
      const db = makeDb();
      const { messenger } = makeMessenger();

      mockGetActiveSession.mockReturnValue({
        id: 6,
        session_id: 'sess-spawn-fail-single',
        chat_jid: 'user@s.whatsapp.net',
        claude_pid: 0,
        status: 'active',
        started_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        last_message_at: null,
        message_count: 0,
      });

      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'single' });

      const mockDurability = {
        getSessionCheckpoint: vi.fn(() => ({
          id: 6,
          conversation_key: 'user',
          session_id: 'sess-spawn-fail-single',
          transcript_path: null,
          active_turn_id: null,
          last_inbound_seq: null,
          last_flushed_outbound_id: null,
          watchdog_state: null,
          workspace_path: null,
          claude_pid: null,
          session_status: 'active',
          checkpoint_version: 1,
          updated_at: new Date(Date.now() - 5 * 60_000).toISOString().replace('Z', ''),
        })),
        upsertSessionCheckpoint: vi.fn(),
      };
      (runtime as unknown as { durability: unknown }).durability = mockDurability;

      // Simulate spawnSession throwing
      mockSession.spawnSession.mockRejectedValueOnce(new Error('spawn failed'));

      await runtime.start();

      // spawnSession was called but failed
      expect(mockSession.spawnSession).toHaveBeenCalledWith('sess-spawn-fail-single', 6);
      // No startup message — session cleaned up in catch
      expect(runtime.popStartupMessage()).toBeNull();
      // Runtime did not throw — it continues gracefully
    });

    it('shared-mode DM spawnSession failure — runtime continues without session (C1 error path)', async () => {
      const db = makeDb();
      const { messenger } = makeMessenger();

      mockGetActiveSession.mockReturnValue({
        id: 7,
        session_id: 'sess-spawn-fail-shared',
        chat_jid: 'user@s.whatsapp.net',
        claude_pid: 0,
        status: 'active',
        started_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        last_message_at: null,
        message_count: 0,
      });

      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'shared' });

      const mockDurability = {
        getSessionCheckpoint: vi.fn(() => ({
          id: 7,
          conversation_key: 'user',
          session_id: 'sess-spawn-fail-shared',
          transcript_path: null,
          active_turn_id: null,
          last_inbound_seq: null,
          last_flushed_outbound_id: null,
          watchdog_state: null,
          workspace_path: null,
          claude_pid: null,
          session_status: 'active',
          checkpoint_version: 1,
          updated_at: new Date(Date.now() - 5 * 60_000).toISOString().replace('Z', ''),
        })),
        upsertSessionCheckpoint: vi.fn(),
      };
      (runtime as unknown as { durability: unknown }).durability = mockDurability;

      // Simulate spawnSession throwing
      mockSession.spawnSession.mockRejectedValueOnce(new Error('spawn failed'));

      await runtime.start();

      // spawnSession was called but failed
      expect(mockSession.spawnSession).toHaveBeenCalledWith('sess-spawn-fail-shared', 7);
      // No startup message — session cleaned up in catch
      expect(runtime.popStartupMessage()).toBeNull();
      // Runtime did not throw — it continues gracefully
    });
  });

  describe('knowledge search registration', () => {
    let registerAllSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      registerAllSpy = vi.spyOn(registerAllModule, 'registerAllTools');
      delete (mockConfig as Record<string, unknown>).memory;
    });

    afterEach(() => {
      registerAllSpy.mockRestore();
      delete (mockConfig as Record<string, unknown>).memory;
    });

    it.each([
      { sandboxPerChat: false, allowGlobalAgentSessions: false, expectedEnabled: false },
      { sandboxPerChat: false, allowGlobalAgentSessions: true, expectedEnabled: true },
      { sandboxPerChat: true, allowGlobalAgentSessions: false, expectedEnabled: true },
      { sandboxPerChat: true, allowGlobalAgentSessions: true, expectedEnabled: true },
    ])(
      'sets enableKnowledgeSearch=$expectedEnabled when sandboxPerChat=$sandboxPerChat and global access=$allowGlobalAgentSessions',
      ({ sandboxPerChat, allowGlobalAgentSessions, expectedEnabled }) => {
        (mockConfig as Record<string, unknown>).memory = {
          pinecone: { knowledgeSearch: { allowGlobalAgentSessions } },
        };

        const db = makeDb();
        const { messenger } = makeMessenger();
        const options = sandboxPerChat
          ? { sandboxPerChat: true as const, sessionScope: 'per_chat' as const }
          : undefined;

        new AgentRuntime(db, messenger, 'test', options);

        expect(registerAllSpy).toHaveBeenCalledOnce();
        const [, , , callOptions] = registerAllSpy.mock.calls[0];
        expect(callOptions).toMatchObject({ enableKnowledgeSearch: expectedEnabled });
      },
    );
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AskUserQuestion → Poll bridge: runtime queue behavior
  // ═══════════════════════════════════════════════════════════════════════════

  describe('AskUserQuestion poll bridge queue behavior', () => {
    // Build a messenger with sendPollMessage and event subscription support
    function makePollMessenger(
      sendResult: { waMessageId: string | null; hasSecret: boolean }
        | Array<{ waMessageId: string | null; hasSecret: boolean }>,
    ) {
      const sentMessages: Array<{ jid: string; text: string }> = [];
      const pollSends: Array<{ chatJid: string; name: string; values: string[]; selectableCount: number }> = [];
      const eventHandlers = new Map<string, Function>();
      let sendIndex = 0;

      const messenger = {
        sendMessage: vi.fn(async (jid: string, text: string) => {
          sentMessages.push({ jid, text });
          return { waMessageId: null };
        }),
        sendMedia: vi.fn(async () => ({ waMessageId: null })),
        // ConnectionManager-shaped additions for poll bridge
        sendPollMessage: vi.fn(async (chatJid: string, name: string, values: string[], selectableCount: number) => {
          pollSends.push({ chatJid, name, values, selectableCount });
          if (Array.isArray(sendResult)) {
            return sendResult[Math.min(sendIndex++, sendResult.length - 1)];
          }
          return sendResult;
        }),
        on: vi.fn((event: string, handler: Function) => {
          eventHandlers.set(event, handler);
          return messenger;
        }),
      };
      return { messenger: messenger as unknown as Messenger, sentMessages, pollSends, eventHandlers };
    }

    function sendTurnTexts(): string[] {
      return mockSession.sendTurn.mock.calls.map((call) => String((call as unknown as [unknown])[0]));
    }

    it('sends poll with no follow-up when all descriptions fit in poll options', async () => {
      const { messenger, pollSends } = makePollMessenger({ waMessageId: 'POLL_OK', hasSecret: true });
      const db = makeDb();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });

      await runtime.start();
      await sendAndDrain(runtime, makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }));

      mockQueue.enqueueText.mockClear();
      mockQueue.enqueueToolUpdate.mockClear();

      // Fire AskUserQuestion tool_use with short descriptions that fit
      capturedOnEventRef.current!({
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolId: 'tool-poll-1',
        toolInput: {
          questions: [{
            question: 'Pick a language',
            header: 'Language',
            options: [
              { label: 'Python', description: 'Dynamic typing' },
              { label: 'Go', description: 'Compiled, fast' },
            ],
            multiSelect: false,
          }],
        },
      });

      // Let async poll send complete
      await vi.waitFor(() => expect(pollSends.length).toBe(1));

      // Poll was sent with rich option text
      expect(pollSends[0].values).toEqual([
        'Python — Dynamic typing',
        'Go — Compiled, fast',
        'Other — propose a different option',
      ]);

      // No follow-up description text enqueued (all descriptions fit)
      expect(mockQueue.enqueueText).not.toHaveBeenCalled();
    });

    it('does not append default Other when an escape hatch option is already present', async () => {
      const { messenger, pollSends } = makePollMessenger({ waMessageId: 'POLL_ESCAPE', hasSecret: true });
      const db = makeDb();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });

      await runtime.start();
      await sendAndDrain(runtime, makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }));

      capturedOnEventRef.current!({
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolId: 'tool-escape-1',
        toolInput: {
          questions: [{
            question: 'Continue?',
            header: 'Continue',
            options: [
              { label: 'Proceed', description: 'Continue with the plan' },
              { label: 'Need more context', description: 'Pause and ask follow-up questions' },
            ],
            multiSelect: false,
          }],
        },
      });

      await vi.waitFor(() => expect(pollSends.length).toBe(1));
      expect(pollSends[0].values).toEqual([
        'Proceed — Continue with the plan',
        'Need more context — Pause and ask follow-up questions',
      ]);
    });

    it('keeps default Other when labels only contain false-positive words', async () => {
      const { messenger, pollSends } = makePollMessenger({ waMessageId: 'POLL_FALSE_POSITIVE', hasSecret: true });
      const db = makeDb();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });

      await runtime.start();
      await sendAndDrain(runtime, makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }));

      capturedOnEventRef.current!({
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolId: 'tool-false-positive-1',
        toolInput: {
          questions: [{
            question: 'Pick an operational action',
            header: 'Action',
            options: [
              { label: 'Other databases', description: 'Evaluate database options' },
              { label: 'Cancel subscription', description: 'End the vendor plan' },
            ],
            multiSelect: false,
          }],
        },
      });

      await vi.waitFor(() => expect(pollSends.length).toBe(1));
      expect(pollSends[0].values).toEqual([
        'Other databases — Evaluate database options',
        'Cancel subscription — End the vendor plan',
        'Other — propose a different option',
      ]);
    });

    it('does not append default Other when the option list is already at WhatsApp cap', async () => {
      const { messenger, pollSends } = makePollMessenger({ waMessageId: 'POLL_CAP', hasSecret: true });
      const db = makeDb();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const options = Array.from({ length: 12 }, (_, index) => ({
        label: `Option ${index + 1}`,
        description: `Description ${index + 1}`,
      }));

      await runtime.start();
      await sendAndDrain(runtime, makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }));

      capturedOnEventRef.current!({
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolId: 'tool-cap-1',
        toolInput: {
          questions: [{
            question: 'Pick one capped option',
            header: 'Cap',
            options,
            multiSelect: true,
          }],
        },
      });

      await vi.waitFor(() => expect(pollSends.length).toBe(1));
      expect(pollSends[0].values).toHaveLength(12);
      expect(pollSends[0].values).not.toContain('Other — propose a different option');
      expect(pollSends[0].selectableCount).toBe(12);
      expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ optionCount: 12 }),
        'AskUserQuestion options at WhatsApp cap — default Other option not appended',
      );
    });

    it('sends companion details when at least one option needs out-of-band text', async () => {
      const { messenger, pollSends } = makePollMessenger({ waMessageId: 'POLL_OK', hasSecret: true });
      const db = makeDb();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });

      await runtime.start();
      await sendAndDrain(runtime, makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }));

      mockQueue.enqueueText.mockClear();
      mockQueue.flush.mockClear();
      (messenger as unknown as { sendPollMessage: ReturnType<typeof vi.fn> }).sendPollMessage.mockClear();

      // Fire with one description too long to fit (>95 chars combined)
      const longDesc = 'A very long description that definitely exceeds the ninety-five character budget for WhatsApp poll option text display';
      capturedOnEventRef.current!({
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolId: 'tool-poll-2',
        toolInput: {
          questions: [{
            question: 'Pick one',
            header: 'Choice',
            options: [
              { label: 'Short', description: 'Fits fine' },
              { label: 'Long option', description: longDesc },
            ],
            multiSelect: false,
          }],
        },
      });

      await vi.waitFor(() => expect(pollSends.length).toBe(1));

      // Detail text is flushed before the poll so users read context before tapping.
      expect(pollSends[0].values).toEqual(['Short', 'Long option', 'Other — propose a different option']);
      expect(mockQueue.enqueueText).toHaveBeenCalledTimes(1);
      const followUp = mockQueue.enqueueText.mock.calls[0][0] as string;
      expect(followUp).toContain('Details for poll: Pick one');
      expect(followUp).toContain('Use the poll below to choose. Full option details:');
      expect(followUp).toContain('1. *Short*\nFits fine');
      expect(followUp).toContain(`2. *Long option*\n${longDesc}`);
      expect(mockQueue.enqueueText.mock.invocationCallOrder[0]).toBeLessThan(mockQueue.flush.mock.invocationCallOrder[0]);
      expect(mockQueue.flush.mock.invocationCallOrder[0]).toBeLessThan(
        (messenger as unknown as { sendPollMessage: ReturnType<typeof vi.fn> }).sendPollMessage.mock.invocationCallOrder[0],
      );
    });

    it('still sends the poll if pre-poll detail flushing fails', async () => {
      const { messenger, pollSends } = makePollMessenger({ waMessageId: 'POLL_AFTER_FLUSH_FAIL', hasSecret: true });
      const db = makeDb();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });

      await runtime.start();
      await sendAndDrain(runtime, makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }));

      mockQueue.enqueueText.mockClear();
      mockQueue.flush.mockReset();
      mockQueue.flush.mockRejectedValueOnce(new Error('flush failed'));

      capturedOnEventRef.current!({
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolId: 'tool-poll-flush-fail-1',
        toolInput: {
          questions: [{
            question: 'Pick one',
            header: 'Choice',
            options: [
              { label: 'Short', description: 'Fits fine' },
              { label: 'Long option', description: 'A'.repeat(120) },
            ],
            multiSelect: false,
          }],
        },
      });

      await vi.waitFor(() => expect(pollSends.length).toBe(1));
      expect(pollSends[0].values).toEqual(['Short', 'Long option', 'Other — propose a different option']);
      expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ chatJid: pollSends[0].chatJid }),
        'failed to flush poll details before poll send',
      );
    });

    it('sends only text fallback (no separate follow-up) when poll send fails', async () => {
      // sendPollMessage returns hasSecret=false → text fallback
      const { messenger } = makePollMessenger({ waMessageId: 'POLL_FAIL', hasSecret: false });
      const db = makeDb();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });

      await runtime.start();
      await sendAndDrain(runtime, makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }));

      mockQueue.enqueueText.mockClear();

      capturedOnEventRef.current!({
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolId: 'tool-poll-3',
        toolInput: {
          questions: [{
            question: 'Which database?',
            header: 'DB',
            options: [
              { label: 'PostgreSQL', description: 'Relational, ACID compliant' },
              { label: 'SQLite', description: 'Embedded, zero-config' },
            ],
            multiSelect: false,
          }],
        },
      });

      await vi.waitFor(() => expect(mockQueue.enqueueText).toHaveBeenCalled());

      // Exactly ONE enqueueText call: the numbered text fallback
      expect(mockQueue.enqueueText).toHaveBeenCalledTimes(1);
      const fallbackText = mockQueue.enqueueText.mock.calls[0][0] as string;
      // Text fallback includes question + numbered options with descriptions
      expect(fallbackText).toContain('Which database?');
      expect(fallbackText).toContain('1. *PostgreSQL*');
      expect(fallbackText).toContain('2. *SQLite*');
      expect(fallbackText).toContain('Reply with option number or text');
      // No separate follow-up description message
    });

    it('falls back to text when one AskUserQuestion poll send throws after a prior poll succeeds', async () => {
      const { messenger } = makePollMessenger({ waMessageId: 'POLL_UNUSED', hasSecret: true });
      const db = makeDb();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const pollSender = (messenger as unknown as { sendPollMessage: ReturnType<typeof vi.fn> }).sendPollMessage;

      pollSender
        .mockResolvedValueOnce({ waMessageId: 'POLL_FIRST', hasSecret: true })
        .mockRejectedValueOnce(new Error('poll send unavailable'));

      await runtime.start();
      await sendAndDrain(runtime, makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }));

      mockQueue.enqueueText.mockClear();

      capturedOnEventRef.current!({
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolId: 'tool-poll-send-throws',
        toolInput: {
          questions: [
            {
              question: 'Which database?',
              header: 'DB',
              options: [
                { label: 'PostgreSQL', description: 'Relational, ACID compliant' },
                { label: 'SQLite', description: 'Embedded, zero-config' },
              ],
              multiSelect: false,
            },
            {
              question: 'Which cache?',
              header: 'Cache',
              options: [
                { label: 'Redis', description: 'Networked cache' },
                { label: 'Memory', description: 'In-process cache' },
              ],
              multiSelect: false,
            },
          ],
        },
      });

      await vi.waitFor(() => expect(mockQueue.enqueueText).toHaveBeenCalledTimes(2));

      expect(pollSender).toHaveBeenNthCalledWith(
        1,
        expect.any(String),
        'Which database?',
        ['PostgreSQL — Relational, ACID compliant', 'SQLite — Embedded, zero-config', 'Other — propose a different option'],
        1,
      );
      expect(pollSender).toHaveBeenNthCalledWith(
        2,
        expect.any(String),
        'Which cache?',
        ['Redis — Networked cache', 'Memory — In-process cache', 'Other — propose a different option'],
        1,
      );
      expect(mockRuntimeLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          chatJid: expect.any(String),
          err: expect.any(Error),
          question: 'Which cache?',
        }),
        'failed to send poll for AskUserQuestion',
      );

      const state = runtime as unknown as {
        pendingPolls: { questions: Map<string, { mode: 'poll' | 'textFallback'; pollMessageIdToQuestionIndex: Map<string, number> }> };
      };
      const pending = state.pendingPolls.questions.get('5678@s.whatsapp.net');
      expect(pending?.mode).toBe('textFallback');
      expect(pending?.pollMessageIdToQuestionIndex.size).toBe(0);

      const fallbackText = mockQueue.enqueueText.mock.calls[0][0] as string;
      expect(fallbackText).toContain('Which database?');
      expect(fallbackText).toContain('1. *PostgreSQL*');
      expect(fallbackText).toContain('2. *SQLite*');
      expect(fallbackText).toContain('Reply with option number or text');

      const secondFallbackText = mockQueue.enqueueText.mock.calls[1][0] as string;
      expect(secondFallbackText).toContain('Which cache?');
      expect(secondFallbackText).toContain('1. *Redis*');
      expect(secondFallbackText).toContain('2. *Memory*');
      expect(secondFallbackText).toContain('Reply with option number or text');
    });

    it('does not duplicate long option details in immediate text fallback after poll send fails', async () => {
      const { messenger } = makePollMessenger({ waMessageId: 'POLL_FAIL_LONG_DETAILS', hasSecret: false });
      const db = makeDb();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });

      await runtime.start();
      await sendAndDrain(runtime, makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }));

      mockQueue.enqueueText.mockClear();
      mockQueue.flush.mockClear();

      const longDesc = 'A'.repeat(140);
      capturedOnEventRef.current!({
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolId: 'tool-poll-fail-long-detail',
        toolInput: {
          questions: [{
            question: 'Pick one',
            header: 'Choice',
            options: [
              { label: 'Short', description: 'Fits fine' },
              { label: 'Long option', description: longDesc },
            ],
            multiSelect: false,
          }],
        },
      });

      await vi.waitFor(() => expect(mockQueue.enqueueText).toHaveBeenCalledTimes(2));

      const detailText = mockQueue.enqueueText.mock.calls[0][0] as string;
      const fallbackText = mockQueue.enqueueText.mock.calls[1][0] as string;
      expect(detailText).toContain(longDesc);
      expect(fallbackText).toContain('Pick one');
      expect(fallbackText).toContain('_Full option details were sent above._');
      expect(fallbackText).toContain('1. *Short*');
      expect(fallbackText).toContain('2. *Long option*');
      expect(fallbackText).toContain('3. *Other — propose a different option*');
      expect(fallbackText).not.toContain(longDesc);
      expect(fallbackText).not.toContain('Fits fine');
      expect(fallbackText).toContain('Reply with option number or text');
    });

    it('sets selectableCount to option count for multiSelect polls', async () => {
      const { messenger, pollSends } = makePollMessenger({ waMessageId: 'POLL_MULTI', hasSecret: true });
      const db = makeDb();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });

      await runtime.start();
      await sendAndDrain(runtime, makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }));

      capturedOnEventRef.current!({
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolId: 'tool-multiselect-1',
        toolInput: {
          questions: [{
            question: 'Pick runtimes',
            header: 'Runtime',
            options: [
              { label: 'Node', description: 'JavaScript runtime' },
              { label: 'Python', description: 'Scripting runtime' },
              { label: 'Go', description: 'Compiled runtime' },
            ],
            multiSelect: true,
          }],
        },
      });

      await vi.waitFor(() => expect(pollSends.length).toBe(1));
      expect(pollSends[0].selectableCount).toBe(4);
    });

    it('injects a pollVoteReceived answer back into the active per-chat session', async () => {
      const { messenger, pollSends, eventHandlers } = makePollMessenger({ waMessageId: 'POLL_ANSWER', hasSecret: true });
      const db = makeDb();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });

      await runtime.start();
      await sendAndDrain(runtime, makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }));

      capturedOnEventRef.current!({
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolId: 'tool-answer-1',
        toolInput: {
          questions: [{
            question: 'Pick a runtime',
            header: 'Runtime',
            options: [
              { label: 'Node', description: 'JavaScript runtime' },
              { label: 'Go', description: 'Compiled runtime' },
            ],
            multiSelect: false,
          }],
        },
      });

      await vi.waitFor(() => expect(pollSends.length).toBe(1));
      mockSession.sendTurn.mockClear();

      eventHandlers.get('pollVoteReceived')!({
        pollMessageId: 'POLL_ANSWER',
        chatJid: pollSends[0].chatJid,
        voterJid: '5678@s.whatsapp.net',
        selectedOptions: ['Go'],
      });

      await vi.waitFor(() => {
        expect(sendTurnTexts().some((arg) => arg.includes('A: Go'))).toBe(true);
      });
      const injected = sendTurnTexts().find((arg) => arg.includes('A: Go'))!;
      expect(injected).toContain('[User answered poll]');
      expect(injected).toContain('Q: Pick a runtime');
    });

    it('drops an out-of-range poll vote mapping without injecting an answer', async () => {
      const { messenger, pollSends, eventHandlers } = makePollMessenger({ waMessageId: 'POLL_ANSWER', hasSecret: true });
      const db = makeDb();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });

      await runtime.start();
      await sendAndDrain(runtime, makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }));

      capturedOnEventRef.current!({
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolId: 'tool-corrupt-poll-index',
        toolInput: {
          questions: [{
            question: 'Pick a runtime',
            header: 'Runtime',
            options: [
              { label: 'Node', description: 'JavaScript runtime' },
              { label: 'Go', description: 'Compiled runtime' },
            ],
            multiSelect: false,
          }],
        },
      });

      await vi.waitFor(() => expect(pollSends.length).toBe(1));

      const state = runtime as unknown as {
        pendingPolls: {
          questions: Map<string, {
            answersCollected: Record<number, string>;
            pollMessageIdToQuestionIndex: Map<string, number>;
          }>;
        };
      };
      const pending = state.pendingPolls.questions.get('5678@s.whatsapp.net');
      expect(pending).toBeDefined();
      pending!.pollMessageIdToQuestionIndex.set('POLL_ANSWER', 99);
      mockSession.sendTurn.mockClear();

      eventHandlers.get('pollVoteReceived')!({
        pollMessageId: 'POLL_ANSWER',
        chatJid: pollSends[0].chatJid,
        voterJid: '5678@s.whatsapp.net',
        selectedOptions: ['Go'],
      });

      expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ index: 99 }),
        'poll vote for out-of-range question index',
      );
      expect(pending!.pollMessageIdToQuestionIndex.has('POLL_ANSWER')).toBe(false);
      expect(pending!.answersCollected).toEqual({});
      expect(mockSession.sendTurn).not.toHaveBeenCalled();
    });

    it('collects multi-question poll votes by poll message id before injecting answers', async () => {
      const { messenger, pollSends, eventHandlers } = makePollMessenger([
        { waMessageId: 'POLL_Q1', hasSecret: true },
        { waMessageId: 'POLL_Q2', hasSecret: true },
      ]);
      const db = makeDb();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });

      await runtime.start();
      await sendAndDrain(runtime, makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }));

      capturedOnEventRef.current!({
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolId: 'tool-two-question-1',
        toolInput: {
          questions: [
            {
              question: 'First question?',
              header: 'First',
              options: [
                { label: 'First A', description: 'First option' },
                { label: 'First B', description: 'Second option' },
              ],
              multiSelect: false,
            },
            {
              question: 'Second question?',
              header: 'Second',
              options: [
                { label: 'Second A', description: 'First option' },
                { label: 'Second B', description: 'Second option' },
              ],
              multiSelect: false,
            },
          ],
        },
      });

      await vi.waitFor(() => expect(pollSends.length).toBe(2));
      mockSession.sendTurn.mockClear();

      eventHandlers.get('pollVoteReceived')!({
        pollMessageId: 'POLL_Q2',
        chatJid: pollSends[1].chatJid,
        voterJid: '5678@s.whatsapp.net',
        selectedOptions: ['Second B'],
      });
      expect(mockSession.sendTurn).not.toHaveBeenCalled();

      eventHandlers.get('pollVoteReceived')!({
        pollMessageId: 'POLL_Q1',
        chatJid: pollSends[0].chatJid,
        voterJid: '5678@s.whatsapp.net',
        selectedOptions: ['First A'],
      });

      await vi.waitFor(() => {
        expect(sendTurnTexts().some((arg) => arg.includes('A: First A'))).toBe(true);
      });
      const injected = sendTurnTexts().find((arg) => arg.includes('A: First A'))!;
      expect(injected).toContain('Q: First question?');
      expect(injected).toContain('Q: Second question?');
      expect(injected).toContain('A: Second B');
      expect(injected).not.toContain('(no answer)');
    });

    it('ignores duplicate multi-question poll votes from a stale retained poll mapping', async () => {
      const { messenger, pollSends, eventHandlers } = makePollMessenger([
        { waMessageId: 'POLL_DUP_Q1', hasSecret: true },
        { waMessageId: 'POLL_DUP_Q2', hasSecret: true },
      ]);
      const db = makeDb();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });

      await runtime.start();
      await sendAndDrain(runtime, makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }));

      capturedOnEventRef.current!({
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolId: 'tool-two-question-duplicate',
        toolInput: {
          questions: [
            {
              question: 'First question?',
              header: 'First',
              options: [
                { label: 'First A', description: 'First option' },
                { label: 'First B', description: 'Second option' },
              ],
              multiSelect: false,
            },
            {
              question: 'Second question?',
              header: 'Second',
              options: [
                { label: 'Second A', description: 'First option' },
                { label: 'Second B', description: 'Second option' },
              ],
              multiSelect: false,
            },
          ],
        },
      });

      await vi.waitFor(() => expect(pollSends.length).toBe(2));
      mockSession.sendTurn.mockClear();
      mockRuntimeLogger.debug.mockClear();

      eventHandlers.get('pollVoteReceived')!({
        pollMessageId: 'POLL_DUP_Q2',
        chatJid: pollSends[1].chatJid,
        voterJid: '5678@s.whatsapp.net',
        selectedOptions: ['Second B'],
      });

      const state = runtime as unknown as {
        pendingPolls: {
          questions: Map<string, {
            answersCollected: Record<number, string>;
            pollMessageIdToQuestionIndex: Map<string, number>;
          }>;
        };
      };
      const pending = state.pendingPolls.questions.get('5678@s.whatsapp.net');
      expect(pending?.answersCollected[1]).toBe('Second B');
      expect(pending?.pollMessageIdToQuestionIndex.has('POLL_DUP_Q2')).toBe(false);
      expect(mockSession.sendTurn).not.toHaveBeenCalled();

      // Simulate stale/corrupt persisted state where the already-answered poll id
      // was retained or restored. The duplicate guard must still prevent overwrite.
      pending?.pollMessageIdToQuestionIndex.set('POLL_DUP_Q2', 1);
      eventHandlers.get('pollVoteReceived')!({
        pollMessageId: 'POLL_DUP_Q2',
        chatJid: pollSends[1].chatJid,
        voterJid: '5678@s.whatsapp.net',
        selectedOptions: ['Second A'],
      });

      expect(pending?.answersCollected[1]).toBe('Second B');
      expect(mockRuntimeLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ pollMessageId: 'POLL_DUP_Q2', index: 1 }),
        'duplicate poll vote ignored',
      );
      expect(mockSession.sendTurn).not.toHaveBeenCalled();

      eventHandlers.get('pollVoteReceived')!({
        pollMessageId: 'POLL_DUP_Q1',
        chatJid: pollSends[0].chatJid,
        voterJid: '5678@s.whatsapp.net',
        selectedOptions: ['First A'],
      });

      await vi.waitFor(() => {
        expect(sendTurnTexts().filter((arg) => arg.includes('[User answered poll]'))).toHaveLength(1);
      });
      const injected = sendTurnTexts().find((arg) => arg.includes('[User answered poll]'))!;
      expect(injected).toContain('A: First A');
      expect(injected).toContain('A: Second B');
      expect(injected).not.toContain('A: Second A');
    });

    it('treats text while a poll is pending as a free-text Other answer', async () => {
      const { messenger, pollSends } = makePollMessenger({ waMessageId: 'POLL_OTHER', hasSecret: true });
      const db = makeDb();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });

      await runtime.start();
      await sendAndDrain(runtime, makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }));

      capturedOnEventRef.current!({
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolId: 'tool-other-1',
        toolInput: {
          questions: [{
            question: 'Pick a database',
            header: 'Database',
            options: [
              { label: 'PostgreSQL', description: 'Server database' },
              { label: 'SQLite', description: 'Embedded database' },
            ],
            multiSelect: false,
          }],
        },
      });

      await vi.waitFor(() => expect(pollSends.length).toBe(1));
      mockSession.sendTurn.mockClear();

      await sendAndDrain(runtime, makeMsg({
        content: 'Use DuckDB instead',
        chatJid: '5678@s.whatsapp.net',
        senderJid: '5678@s.whatsapp.net',
      }));

      await vi.waitFor(() => {
        expect(sendTurnTexts().some((arg) => arg.includes('A: Use DuckDB instead (free-text response)'))).toBe(true);
      });
      const injected = sendTurnTexts().find((arg) => arg.includes('A: Use DuckDB instead (free-text response)'))!;
      expect(injected).toContain('Q: Pick a database');
      expect(mockSession.sendTurn).not.toHaveBeenCalledWith('Use DuckDB instead');
    });

    it('does not resolve a pending poll from a generic vote-status text reply', async () => {
      const { messenger, sentMessages, pollSends, eventHandlers } = makePollMessenger({ waMessageId: 'POLL_STATUS_TEXT', hasSecret: true });
      const db = makeDb();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });

      await runtime.start();
      await sendAndDrain(runtime, makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }));

      capturedOnEventRef.current!({
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolId: 'tool-status-text-1',
        toolInput: {
          questions: [{
            question: 'Pick a database',
            header: 'Database',
            options: [
              { label: 'PostgreSQL', description: 'Server database' },
              { label: 'SQLite', description: 'Embedded database' },
            ],
            multiSelect: false,
          }],
        },
      });

      await vi.waitFor(() => expect(pollSends.length).toBe(1));
      mockQueue.enqueueText.mockClear();
      mockSession.sendTurn.mockClear();

      await sendAndDrain(runtime, makeMsg({
        content: 'I voted',
        chatJid: '5678@s.whatsapp.net',
        senderJid: '5678@s.whatsapp.net',
      }));

      expect(sendTurnTexts().some((arg) => arg.includes('[User answered poll]'))).toBe(false);
      const clarificationTexts = [
        ...mockQueue.enqueueText.mock.calls.map((call) => String(call[0])),
        ...sentMessages.map((message) => message.text),
      ];
      expect(clarificationTexts.some((text) => text.includes('waiting for the poll vote itself'))).toBe(true);

      eventHandlers.get('pollVoteReceived')!({
        pollMessageId: 'POLL_STATUS_TEXT',
        chatJid: pollSends[0].chatJid,
        voterJid: '5678@s.whatsapp.net',
        selectedOptions: ['SQLite'],
      });

      await vi.waitFor(() => expect(sendTurnTexts().some((arg) => arg.includes('A: SQLite'))).toBe(true));
    });

    it('terminalizes low-signal pending poll text replies without waiting for an agent result', async () => {
      const { messenger, pollSends } = makePollMessenger({ waMessageId: 'POLL_STATUS_DURABILITY', hasSecret: true });
      const db = makeDb();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const durability = { completeInbound: vi.fn() };
      const replyGuarantee = { arm: vi.fn(), disarm: vi.fn(), shutdown: vi.fn(), isArmed: vi.fn(() => false) };

      await runtime.start();
      (runtime as unknown as { durability: typeof durability }).durability = durability;
      (runtime as unknown as { replyGuarantee: typeof replyGuarantee }).replyGuarantee = replyGuarantee;
      await sendAndDrain(runtime, makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }));

      capturedOnEventRef.current!({
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolId: 'tool-status-durability-1',
        toolInput: {
          questions: [{
            question: 'Pick a database',
            header: 'Database',
            options: [
              { label: 'PostgreSQL', description: 'Server database' },
              { label: 'SQLite', description: 'Embedded database' },
            ],
            multiSelect: false,
          }],
        },
      });

      await vi.waitFor(() => expect(pollSends.length).toBe(1));
      mockQueue.enqueueText.mockClear();
      mockQueue.flush.mockClear();
      mockSession.sendTurn.mockClear();
      replyGuarantee.arm.mockClear();

      await sendAndDrain(runtime, makeMsg({
        content: 'I voted',
        chatJid: '5678@s.whatsapp.net',
        senderJid: '5678@s.whatsapp.net',
        inboundSeq: 701,
      }));

      expect(replyGuarantee.arm).toHaveBeenCalledWith({ inboundSeq: 701, chatJid: '5678@s.whatsapp.net' });
      expect(durability.completeInbound).toHaveBeenCalledWith(701, 'poll_status_reply');
      expect(replyGuarantee.disarm).toHaveBeenCalledWith(701);
      expect(mockQueue.enqueueText).toHaveBeenCalledWith(expect.stringContaining('waiting for the poll vote itself'));
      expect(mockQueue.flush).toHaveBeenCalled();
      expect(mockSession.sendTurn).not.toHaveBeenCalled();
      expect((runtime as unknown as { perChatInboundSeqQueue: Map<string, number[]> }).perChatInboundSeqQueue.has('5678@s.whatsapp.net')).toBe(false);
    });

    it('terminalizes partial pending poll text answers while waiting for remaining questions', async () => {
      const { messenger, pollSends } = makePollMessenger([
        { waMessageId: 'POLL_PARTIAL_DURABILITY_1', hasSecret: true },
        { waMessageId: 'POLL_PARTIAL_DURABILITY_2', hasSecret: true },
      ]);
      const db = makeDb();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const durability = { completeInbound: vi.fn() };
      const replyGuarantee = { arm: vi.fn(), disarm: vi.fn(), shutdown: vi.fn(), isArmed: vi.fn(() => false) };

      await runtime.start();
      (runtime as unknown as { durability: typeof durability }).durability = durability;
      (runtime as unknown as { replyGuarantee: typeof replyGuarantee }).replyGuarantee = replyGuarantee;
      await sendAndDrain(runtime, makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }));

      capturedOnEventRef.current!({
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolId: 'tool-partial-durability-1',
        toolInput: {
          questions: [
            {
              question: 'First question?',
              header: 'First',
              options: [
                { label: 'First A', description: 'First option' },
                { label: 'First B', description: 'Second option' },
              ],
              multiSelect: false,
            },
            {
              question: 'Second question?',
              header: 'Second',
              options: [
                { label: 'Second A', description: 'First option' },
                { label: 'Second B', description: 'Second option' },
              ],
              multiSelect: false,
            },
          ],
        },
      });

      await vi.waitFor(() => expect(pollSends.length).toBe(2));
      mockSession.sendTurn.mockClear();
      replyGuarantee.arm.mockClear();

      await sendAndDrain(runtime, makeMsg({
        content: 'First A',
        chatJid: '5678@s.whatsapp.net',
        senderJid: '5678@s.whatsapp.net',
        inboundSeq: 702,
      }));

      expect(replyGuarantee.arm).toHaveBeenCalledWith({ inboundSeq: 702, chatJid: '5678@s.whatsapp.net' });
      expect(durability.completeInbound).toHaveBeenCalledWith(702, 'poll_partial_answer_collected');
      expect(replyGuarantee.disarm).toHaveBeenCalledWith(702);
      expect(mockSession.sendTurn).not.toHaveBeenCalled();
      expect((runtime as unknown as { perChatInboundSeqQueue: Map<string, number[]> }).perChatInboundSeqQueue.has('5678@s.whatsapp.net')).toBe(false);
    });

    it('accepts a typed option label even when the label looks like generic vote status', async () => {
      const { messenger, pollSends } = makePollMessenger({ waMessageId: 'POLL_SUBMITTED_OPTION', hasSecret: true });
      const db = makeDb();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });

      await runtime.start();
      await sendAndDrain(runtime, makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }));

      capturedOnEventRef.current!({
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolId: 'tool-submitted-option-1',
        toolInput: {
          questions: [{
            question: 'Pick the ticket state',
            header: 'State',
            options: [
              { label: 'Submitted', description: 'The request was filed' },
              { label: 'Draft', description: 'The request is still being edited' },
            ],
            multiSelect: false,
          }],
        },
      });

      await vi.waitFor(() => expect(pollSends.length).toBe(1));
      mockQueue.enqueueText.mockClear();
      mockSession.sendTurn.mockClear();

      await sendAndDrain(runtime, makeMsg({
        content: 'submitted',
        chatJid: '5678@s.whatsapp.net',
        senderJid: '5678@s.whatsapp.net',
      }));

      await vi.waitFor(() => {
        expect(sendTurnTexts().some((arg) => arg.includes('A: Submitted'))).toBe(true);
      });
      expect(mockQueue.enqueueText).not.toHaveBeenCalledWith(expect.stringContaining('waiting for the poll vote itself'));
    });

    it('injects an Other poll vote as a structured interview directive', async () => {
      const { messenger, pollSends, eventHandlers } = makePollMessenger({ waMessageId: 'POLL_OTHER_DIRECTIVE', hasSecret: true });
      const db = makeDb();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });

      await runtime.start();
      await sendAndDrain(runtime, makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }));

      capturedOnEventRef.current!({
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolId: 'tool-other-directive-1',
        toolInput: {
          questions: [{
            question: 'Pick a database',
            header: 'Database',
            options: [
              { label: 'PostgreSQL', description: 'Server database' },
              { label: 'SQLite', description: 'Embedded database' },
            ],
            multiSelect: false,
          }],
        },
      });

      await vi.waitFor(() => expect(pollSends.length).toBe(1));
      mockSession.sendTurn.mockClear();

      eventHandlers.get('pollVoteReceived')!({
        pollMessageId: 'POLL_OTHER_DIRECTIVE',
        chatJid: pollSends[0].chatJid,
        voterJid: '5678@s.whatsapp.net',
        selectedOptions: ['Other — propose a different option'],
      });

      await vi.waitFor(() => {
        expect(sendTurnTexts().some((arg) => arg.includes('[User selected Other'))).toBe(true);
      });
      const injected = sendTurnTexts().find((arg) => arg.includes('[User selected Other'))!;
      expect(injected).toContain("A:\n[User selected Other");
      expect(injected).toContain('Question requiring follow-up: Pick a database');
      expect(injected).toContain('Original options:');
      expect(injected).toContain('1. *PostgreSQL*');
      expect(injected).toContain('2. *SQLite*');
      expect(injected).toContain('Directive:');
    });

    it('sends polls in group chats and registers AskUser poll suppression', async () => {
      const { messenger, pollSends } = makePollMessenger({ waMessageId: 'POLL_GROUP', hasSecret: true });
      const db = makeDb();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const groupQueue = makeQueueMock('111111100000000099@g.us');
      const handleEventWithContext = (
        runtime as unknown as {
          handleEventWithContext: (
            event: AgentEvent,
            queue: IOutboundQueue,
            session: typeof mockSession,
            conversationKey?: string,
            inboundSeq?: number,
            mapKey?: string,
            toolScopeKey?: string,
          ) => void;
        }
      ).handleEventWithContext.bind(runtime);

      handleEventWithContext(
        {
          type: 'tool_use',
          toolName: 'AskUserQuestion',
          toolId: 'tool-group-1',
          toolInput: {
            questions: [{
              question: 'Pick one',
              header: 'Group',
              options: [
                { label: 'A', description: 'First' },
                { label: 'B', description: 'Second' },
              ],
              multiSelect: false,
            }],
          },
        },
        groupQueue,
        mockSession,
        undefined,
        undefined,
        'group-map-key',
        'group-map-key',
      );

      // Yield to let the async poll send fire
      await Promise.resolve();

      expect(pollSends).toHaveLength(1);
      // enqueueToolUpdate should NOT have been called — poll bridge short-circuits normal handling
      expect(groupQueue.enqueueToolUpdate).toHaveBeenCalledTimes(0);
    });

    it('soft-expiry switches all unanswered poll questions to text fallback', async () => {
      vi.useFakeTimers();
      try {
        const { messenger, pollSends, sentMessages } = makePollMessenger([
          { waMessageId: 'POLL_EXPIRY_1', hasSecret: true },
          { waMessageId: 'POLL_EXPIRY_2', hasSecret: true },
        ]);
        const db = makeDb();
        const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });

        await runtime.start();
        await sendAndDrain(runtime, makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }));

        capturedOnEventRef.current!({
          type: 'tool_use',
          toolName: 'AskUserQuestion',
          toolId: 'tool-soft-expiry-1',
          toolInput: {
            questions: [
              {
                question: 'First question?',
                header: 'First',
                options: [
                  { label: 'First A', description: 'First option' },
                  { label: 'First B', description: 'Second option' },
                ],
                multiSelect: false,
              },
              {
                question: 'Second question?',
                header: 'Second',
                options: [
                  { label: 'Second A', description: 'First option' },
                  { label: 'Second B', description: 'Second option' },
                ],
                multiSelect: false,
              },
            ],
          },
        });

        await vi.waitFor(() => expect(pollSends.length).toBe(2));
        sentMessages.length = 0;

        // Soft deadline = pending.timeoutMs (derived from config.pollResolution.defaultTimeoutMs).
        // Advance must exceed that default; fake timer wall-clock cost is constant.
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 100);

        expect(sentMessages.filter((message) => message.text.includes('option number or text'))).toHaveLength(2);
        expect(sentMessages.some((message) => message.text.includes('First question?'))).toBe(true);
        expect(sentMessages.some((message) => message.text.includes('Second question?'))).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('clears old poll expiry timers when a pending AskUserQuestion is replaced', async () => {
      vi.useFakeTimers();
      try {
        const { messenger, pollSends, sentMessages } = makePollMessenger([
          { waMessageId: 'POLL_REPLACED_OLD', hasSecret: true },
          { waMessageId: 'POLL_REPLACED_NEW', hasSecret: true },
        ]);
        const db = makeDb();
        const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
        const state = runtime as unknown as { pendingPolls: PerChatCleanupRuntimeState['pendingPolls'] };

        await runtime.start();
        await sendAndDrain(runtime, makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }));

        capturedOnEventRef.current!({
          type: 'tool_use',
          toolName: 'AskUserQuestion',
          toolId: 'tool-replaced-old',
          toolInput: {
            questions: [{
              question: 'Old decision?',
              header: 'Old',
              options: [
                { label: 'Old A', description: 'First old option' },
                { label: 'Old B', description: 'Second old option' },
              ],
              multiSelect: false,
            }],
          },
        });

        await vi.waitFor(() => expect(pollSends.length).toBe(1));
        await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

        capturedOnEventRef.current!({
          type: 'tool_use',
          toolName: 'AskUserQuestion',
          toolId: 'tool-replaced-new',
          toolInput: {
            questions: [{
              question: 'New decision?',
              header: 'New',
              options: [
                { label: 'New A', description: 'First new option' },
                { label: 'New B', description: 'Second new option' },
              ],
              multiSelect: false,
            }],
          },
        });

        await vi.waitFor(() => expect(pollSends.length).toBe(2));
        sentMessages.length = 0;

        await vi.advanceTimersByTimeAsync(3 * 60 * 1000 + 1);

        expect(sentMessages.some((message) => message.text.includes('option number or text'))).toBe(false);
        const pending = state.pendingPolls.questions.get('5678@s.whatsapp.net');
        expect(pending?.mode).toBe('poll');
        expect(pending?.pollMessageIdToQuestionIndex.has('POLL_REPLACED_NEW')).toBe(true);
        expect(pending?.pollMessageIdToQuestionIndex.has('POLL_REPLACED_OLD')).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('ignores stale async poll-send continuations after a pending AskUserQuestion is replaced', async () => {
      let resolveOldPoll: ((value: { waMessageId: string | null; hasSecret: boolean }) => void) | null = null;
      const oldPollSend = new Promise<{ waMessageId: string | null; hasSecret: boolean }>((resolve) => {
        resolveOldPoll = resolve;
      });
      const pollSends: Array<{ chatJid: string; name: string; values: string[]; selectableCount: number }> = [];
      const eventHandlers = new Map<string, Function>();
      const messenger = {
        sendMessage: vi.fn(async () => ({ waMessageId: null })),
        sendMedia: vi.fn(async () => ({ waMessageId: null })),
        sendPollMessage: vi.fn((chatJid: string, name: string, values: string[], selectableCount: number) => {
          pollSends.push({ chatJid, name, values, selectableCount });
          if (pollSends.length === 1) return oldPollSend;
          return Promise.resolve({ waMessageId: 'POLL_STALE_NEW', hasSecret: true });
        }),
        on: vi.fn((event: string, handler: Function) => {
          eventHandlers.set(event, handler);
          return messenger;
        }),
      };
      const db = makeDb();
      const runtime = new AgentRuntime(db, messenger as unknown as Messenger, 'test', { sessionScope: 'per_chat' });
      const state = runtime as unknown as { pendingPolls: PerChatCleanupRuntimeState['pendingPolls'] };

      await runtime.start();
      await sendAndDrain(runtime, makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }));

      capturedOnEventRef.current!({
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolId: 'tool-stale-old',
        toolInput: {
          questions: [{
            question: 'Old async decision?',
            header: 'Old async',
            options: [
              { label: 'Old async A', description: 'First old async option' },
              { label: 'Old async B', description: 'Second old async option' },
            ],
            multiSelect: false,
          }],
        },
      });

      await vi.waitFor(() => expect(pollSends.length).toBe(1));

      capturedOnEventRef.current!({
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolId: 'tool-stale-new',
        toolInput: {
          questions: [{
            question: 'New async decision?',
            header: 'New async',
            options: [
              { label: 'New async A', description: 'First new async option' },
              { label: 'New async B', description: 'Second new async option' },
            ],
            multiSelect: false,
          }],
        },
      });

      await vi.waitFor(() => expect(pollSends.length).toBe(2));
      mockQueue.enqueueText.mockClear();

      resolveOldPoll!({ waMessageId: 'POLL_STALE_OLD', hasSecret: false });
      await vi.waitFor(() => expect(mockRuntimeLogger.debug.mock.calls.some(
        ([meta, message]) => message === 'AskUserQuestion poll send abandoned after pending poll was replaced'
          && (meta as { toolId?: string }).toolId === 'tool-stale-old',
      )).toBe(true));

      const pending = state.pendingPolls.questions.get('5678@s.whatsapp.net');
      expect(pending?.mode).toBe('poll');
      expect(pending?.pollMessageIdToQuestionIndex.has('POLL_STALE_NEW')).toBe(true);
      expect(pending?.pollMessageIdToQuestionIndex.has('POLL_STALE_OLD')).toBe(false);
      expect(mockQueue.enqueueText).not.toHaveBeenCalledWith(expect.stringContaining('Old async decision?'));
    });

    it('hard-expiry clears pending poll state and ignores later replies', async () => {
      vi.useFakeTimers();
      try {
        const { messenger, pollSends, sentMessages } = makePollMessenger({ waMessageId: 'POLL_HARD_EXPIRY', hasSecret: true });
        const db = makeDb();
        const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });

        await runtime.start();
        await sendAndDrain(runtime, makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }));

        capturedOnEventRef.current!({
          type: 'tool_use',
          toolName: 'AskUserQuestion',
          toolId: 'tool-hard-expiry-1',
          toolInput: {
            questions: [{
              question: 'Pick a runtime',
              header: 'Runtime',
              options: [
                { label: 'Node', description: 'JavaScript runtime' },
                { label: 'Go', description: 'Compiled runtime' },
              ],
              multiSelect: false,
            }],
          },
        });

        await vi.waitFor(() => expect(pollSends.length).toBe(1));
        sentMessages.length = 0;
        mockSession.sendTurn.mockClear();

        // Hard deadline = pending.timeoutMs * 2 (timeoutMs derived from
        // config.pollResolution.defaultTimeoutMs). Advance must exceed 2 * default.
        await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000 + 100);
        expect(sentMessages.some((message) => message.text.includes('This decision has expired'))).toBe(true);

        await sendAndDrain(runtime, makeMsg({
          content: 'Go',
          chatJid: '5678@s.whatsapp.net',
          senderJid: '5678@s.whatsapp.net',
        }));

        expect(sendTurnTexts().some((arg) => arg.includes('[User answered poll]'))).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('pollVoteFailed switches to idempotent text fallback and accepts typed option', async () => {
      const { messenger, pollSends, eventHandlers, sentMessages } = makePollMessenger({ waMessageId: 'POLL_DECRYPT_FAIL', hasSecret: true });
      const db = makeDb();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });

      await runtime.start();
      await sendAndDrain(runtime, makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }));

      capturedOnEventRef.current!({
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolId: 'tool-poll-failed-1',
        toolInput: {
          questions: [{
            question: 'Pick a runtime',
            header: 'Runtime',
            options: [
              { label: 'Node', description: 'JavaScript runtime' },
              { label: 'Go', description: 'Compiled runtime' },
            ],
            multiSelect: false,
          }],
        },
      });

      await vi.waitFor(() => expect(pollSends.length).toBe(1));
      sentMessages.length = 0;

      const failPayload = {
        pollMessageId: 'POLL_DECRYPT_FAIL',
        chatJid: pollSends[0].chatJid,
        reason: 'decrypt_failed',
      };
      eventHandlers.get('pollVoteFailed')!(failPayload);
      eventHandlers.get('pollVoteFailed')!(failPayload);

      expect(sentMessages.filter((message) => message.text.includes("couldn't read your poll vote"))).toHaveLength(1);
      expect(sentMessages[0].text).toContain('1. *Node*');
      expect(sentMessages[0].text).toContain('2. *Go*');

      mockSession.sendTurn.mockClear();
      await sendAndDrain(runtime, makeMsg({
        content: 'Go',
        chatJid: '5678@s.whatsapp.net',
        senderJid: '5678@s.whatsapp.net',
      }));

      await vi.waitFor(() => expect(sendTurnTexts().some((arg) => arg.includes('A: Go'))).toBe(true));
    });

    it('ignores stale poll votes after partial poll send falls back to text', async () => {
      const { messenger, pollSends, eventHandlers } = makePollMessenger([
        { waMessageId: 'POLL_PARTIAL_1', hasSecret: true },
        { waMessageId: 'POLL_PARTIAL_2', hasSecret: false },
      ]);
      const db = makeDb();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });

      await runtime.start();
      await sendAndDrain(runtime, makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }));

      capturedOnEventRef.current!({
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolId: 'tool-partial-fallback-1',
        toolInput: {
          questions: [
            {
              question: 'First fallback question?',
              header: 'First',
              options: [
                { label: 'A', description: 'First A' },
                { label: 'B', description: 'First B' },
              ],
              multiSelect: false,
            },
            {
              question: 'Second fallback question?',
              header: 'Second',
              options: [
                { label: 'C', description: 'Second C' },
                { label: 'D', description: 'Second D' },
              ],
              multiSelect: false,
            },
          ],
        },
      });

      await vi.waitFor(() => expect(pollSends.length).toBe(2));
      mockSession.sendTurn.mockClear();

      eventHandlers.get('pollVoteReceived')!({
        pollMessageId: 'POLL_PARTIAL_1',
        chatJid: pollSends[0].chatJid,
        voterJid: '5678@s.whatsapp.net',
        selectedOptions: ['B'],
      });
      expect(mockSession.sendTurn).not.toHaveBeenCalled();

      await sendAndDrain(runtime, makeMsg({
        content: 'fallback answer one',
        chatJid: '5678@s.whatsapp.net',
        senderJid: '5678@s.whatsapp.net',
      }));
      expect(mockSession.sendTurn).not.toHaveBeenCalledWith(expect.stringContaining('fallback answer one'));

      await sendAndDrain(runtime, makeMsg({
        content: 'fallback answer two',
        chatJid: '5678@s.whatsapp.net',
        senderJid: '5678@s.whatsapp.net',
      }));

      await vi.waitFor(() => {
        expect(sendTurnTexts().some((arg) => arg.includes('A: fallback answer two (free-text response)'))).toBe(true);
      });
      const injected = sendTurnTexts().find((arg) => arg.includes('A: fallback answer two (free-text response)'))!;
      expect(injected).toContain('Q: First fallback question?');
      expect(injected).toContain('A: fallback answer one (free-text response)');
      expect(injected).toContain('Q: Second fallback question?');
      expect(injected).not.toContain('A: B');
    });

    it('suppresses auto-resolved tool_result for intercepted AskUserQuestion', async () => {
      const { messenger } = makePollMessenger({ waMessageId: 'POLL_OK', hasSecret: true });
      const db = makeDb();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });

      await runtime.start();
      await sendAndDrain(runtime, makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }));

      mockQueue.enqueueToolUpdate.mockClear();

      // tool_use
      capturedOnEventRef.current!({
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolId: 'tool-suppress-1',
        toolInput: {
          questions: [{
            question: 'Pick',
            header: 'Test',
            options: [
              { label: 'A', description: 'a' },
              { label: 'B', description: 'b' },
            ],
            multiSelect: false,
          }],
        },
      });

      // Auto-resolved tool_result arrives immediately
      capturedOnEventRef.current!({
        type: 'tool_result',
        toolId: 'tool-suppress-1',
        isError: true,
        content: 'Answer questions?',
      });

      // tool_result error should NOT be forwarded to queue
      const errorCalls = mockQueue.enqueueToolUpdate.mock.calls.filter(
        ([update]) => (update as { category?: string }).category === 'error',
      );
      expect(errorCalls).toHaveLength(0);
    });
  });

  // ── AdminE2E: admin-only voter policy ─────────────────────────────────────
  // End-to-end verification of admin-only resolution across both poll sources:
  //   - askuser: handlePollVoteReceived → settlePoll → injectPollAnswers → sendTurn
  //   - send_poll: handlePollVoteReceived → settlePoll → awaitResolve resolves the
  //     promise returned by registerSendPollAwaiter
  // Plus a non-resolution case proving non-admin votes are RECORDED but do not
  // settle, distinguishing real admin gating from incidental no-op behavior.

  describe('admin-only voter policy E2E', () => {
    type AdminPollPending = {
      questions: Array<{ question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }>;
      toolId: string;
      chatJid: string;
      chatJidAliases: Set<string>;
      mode: 'poll' | 'textFallback';
      pollMessageIdToQuestionIndex: Map<string, number>;
      currentQuestionIndex: number;
      answersCollected: Record<number, string>;
      createdAt: number;
      resolution?: string;
      timeoutMs?: number;
      adminJids?: Set<string> | null;
      votesByQuestion?: Map<number, Map<string, { voterJid: string; selectedOptions: string[]; isAdmin: boolean; timestamp: number }>>;
      awaitResolve?: (answer: string) => void;
      awaitReject?: (err: Error) => void;
      source?: 'askuser' | 'send_poll';
      sentPollMessageIds?: string[];
    };

    type AdminRuntimeState = {
      pendingPolls: { questions: Map<string, AdminPollPending> };
      chatSessions: Map<string, typeof mockSession>;
      chatQueues: Map<string, IOutboundQueue>;
      handlePollVoteReceived: (data: {
        pollMessageId: string;
        chatJid: string;
        voterJid: string;
        selectedOptions: string[];
      }) => void;
      handlePollVoteFailed: (data: {
        pollMessageId: string;
        chatJid: string;
        reason: string;
      }) => void;
      registerSendPollAwaiter: (
        pollId: string,
        chatJid: string,
        options: string[],
        resolution: 'first-vote-wins' | 'admin-only' | 'admin-wins' | 'majority-after-timeout',
        timeoutMs: number,
      ) => Promise<string>;
      deletePendingPollQuestions: (mapKey: string) => void;
    };

    const groupJid = 'test-group@g.us';
    const adminJid = '15550001111@s.whatsapp.net';
    const nonAdminA = '15550002222@s.whatsapp.net';
    const nonAdminB = '15550003333@s.whatsapp.net';

    function seedAdminOnlyPending(
      state: AdminRuntimeState,
      mapKey: string,
      source: 'askuser' | 'send_poll',
      pollMessageId: string,
      awaitResolve?: (answer: string) => void,
    ): AdminPollPending {
      const pending: AdminPollPending = {
        questions: [{
          question: 'Approve deploy?',
          header: 'Deploy',
          options: [
            { label: 'Yes', description: 'ship it' },
            { label: 'No', description: 'hold' },
          ],
          multiSelect: false,
        }],
        toolId: source === 'send_poll' ? `send_poll:${pollMessageId}` : 'tool-admin-vote',
        chatJid: groupJid,
        chatJidAliases: new Set([groupJid]),
        mode: 'poll',
        pollMessageIdToQuestionIndex: new Map([[pollMessageId, 0]]),
        currentQuestionIndex: 0,
        answersCollected: {},
        createdAt: Date.now(),
        resolution: 'admin-only',
        timeoutMs: 60_000,
        adminJids: new Set([adminJid]),
        votesByQuestion: new Map(),
        source,
        sentPollMessageIds: [pollMessageId],
      };
      if (source === 'send_poll' && awaitResolve) {
        pending.awaitResolve = awaitResolve;
      }
      state.pendingPolls.questions.set(mapKey, pending);
      return pending;
    }

    it('E2Ea — askuser source: non-admin votes are recorded but do not resolve; admin vote settles via sendTurn with the admin selection', async () => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const state = runtime as unknown as AdminRuntimeState;
      await runtime.start();

      state.chatSessions.set(groupJid, mockSession);
      state.chatQueues.set(groupJid, mockQueue);
      const pollMessageId = 'POLL_ADMIN_ASKUSER';
      const pending = seedAdminOnlyPending(state, groupJid, 'askuser', pollMessageId);

      mockSession.sendTurn.mockClear();

      // Non-admin vote — recorded but does not resolve
      state.handlePollVoteReceived({
        pollMessageId,
        chatJid: groupJid,
        voterJid: nonAdminA,
        selectedOptions: ['No'],
      });

      expect(mockSession.sendTurn).not.toHaveBeenCalled();
      expect(pending.answersCollected[0]).toBeUndefined();
      expect(pending.votesByQuestion?.get(0)?.size).toBe(1);
      const nonAdminVote = pending.votesByQuestion?.get(0)?.get(nonAdminA);
      expect(nonAdminVote?.isAdmin).toBe(false);
      expect(nonAdminVote?.selectedOptions).toEqual(['No']);

      // Admin vote — resolves with admin's selection
      state.handlePollVoteReceived({
        pollMessageId,
        chatJid: groupJid,
        voterJid: adminJid,
        selectedOptions: ['Yes'],
      });

      await vi.waitFor(() => {
        expect(mockSession.sendTurn).toHaveBeenCalledWith(expect.stringContaining('Yes'));
      });
      expect(mockSession.sendTurn).not.toHaveBeenCalledWith(expect.stringContaining('No'));
      expect(state.pendingPolls.questions.has(groupJid)).toBe(false);
    });

    it('E2Eb — send_poll source: admin vote resolves the awaitResolve promise with the admin selection', async () => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const state = runtime as unknown as AdminRuntimeState;
      await runtime.start();

      const pollMessageId = 'POLL_ADMIN_SENDPOLL';
      const mapKey = `send_poll:${pollMessageId}`;
      let resolved: string | null = null;
      const awaitResolve = (answer: string): void => { resolved = answer; };
      const pending = seedAdminOnlyPending(state, mapKey, 'send_poll', pollMessageId, awaitResolve);

      mockSession.sendTurn.mockClear();

      // Non-admin vote — recorded but does not resolve
      state.handlePollVoteReceived({
        pollMessageId,
        chatJid: groupJid,
        voterJid: nonAdminA,
        selectedOptions: ['No'],
      });
      expect(resolved).toBeNull();
      expect(pending.answersCollected[0]).toBeUndefined();
      expect(pending.votesByQuestion?.get(0)?.size).toBe(1);

      // Admin vote — resolves the promise with admin selection
      state.handlePollVoteReceived({
        pollMessageId,
        chatJid: groupJid,
        voterJid: adminJid,
        selectedOptions: ['Yes'],
      });

      await vi.waitFor(() => {
        expect(resolved).toBe('Yes');
      });
      expect(state.pendingPolls.questions.has(mapKey)).toBe(false);
      // send_poll source does NOT use sendTurn — assert it stays untouched
      expect(mockSession.sendTurn).not.toHaveBeenCalled();
    });

    it('E2Eb2 — send_poll source: vote failure rejects the awaiter without AskUser text fallback', async () => {
      const db = makeDb();
      const { messenger, sentMessages } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const state = runtime as unknown as AdminRuntimeState;
      await runtime.start();

      const pollMessageId = 'POLL_SENDPOLL_DECRYPT_FAIL';
      const mapKey = `send_poll:${pollMessageId}`;
      const rejectedErrors: Error[] = [];
      const awaitReject = (err: Error): void => { rejectedErrors.push(err); };
      const pending = seedAdminOnlyPending(state, mapKey, 'send_poll', pollMessageId);
      pending.awaitReject = awaitReject;
      state.chatQueues.set(mapKey, mockQueue);

      mockQueue.setPollPending.mockClear();
      mockSession.sendTurn.mockClear();
      sentMessages.length = 0;

      state.handlePollVoteFailed({
        pollMessageId,
        chatJid: groupJid,
        reason: 'decrypt_failed',
      });

      expect(rejectedErrors.map((err) => err.message)).toEqual(['Poll expiry: [Poll vote decryption failed]']);
      expect(state.pendingPolls.questions.has(mapKey)).toBe(false);
      expect(mockQueue.setPollPending).toHaveBeenCalledWith(false);
      expect(mockSession.sendTurn).not.toHaveBeenCalled();
      expect(sentMessages.some((message) => message.text.includes("couldn't read your poll vote"))).toBe(false);
      expect(mockRuntimeLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ mapKey, reason: 'expiry', source: 'send_poll' }),
        'poll settled',
      );
    });

    it('E2Ec — multiple non-admin votes are recorded with isAdmin:false but the poll stays open until an admin vote or timeout', async () => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const state = runtime as unknown as AdminRuntimeState;
      await runtime.start();

      state.chatSessions.set(groupJid, mockSession);
      state.chatQueues.set(groupJid, mockQueue);
      const pollMessageId = 'POLL_ADMIN_NONACCUM';
      const pending = seedAdminOnlyPending(state, groupJid, 'askuser', pollMessageId);

      mockSession.sendTurn.mockClear();

      for (const [voter, selection] of [[nonAdminA, 'Yes'], [nonAdminB, 'No']] as const) {
        state.handlePollVoteReceived({
          pollMessageId,
          chatJid: groupJid,
          voterJid: voter,
          selectedOptions: [selection],
        });
      }

      // All non-admin votes recorded
      expect(pending.votesByQuestion?.get(0)?.size).toBe(2);
      const recordedVoteA = pending.votesByQuestion?.get(0)?.get(nonAdminA);
      const recordedVoteB = pending.votesByQuestion?.get(0)?.get(nonAdminB);
      expect(recordedVoteA?.isAdmin).toBe(false);
      expect(recordedVoteB?.isAdmin).toBe(false);
      expect(recordedVoteA?.selectedOptions).toEqual(['Yes']);
      expect(recordedVoteB?.selectedOptions).toEqual(['No']);

      // Poll NOT resolved: no answer collected, pending still present, sendTurn not called
      expect(pending.answersCollected[0]).toBeUndefined();
      expect(state.pendingPolls.questions.has(groupJid)).toBe(true);
      expect(mockSession.sendTurn).not.toHaveBeenCalled();
    });

    it('QR-036 — admin-only group poll does NOT downgrade to first-vote-wins when group metadata is unavailable (fail-closed)', async () => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const state = runtime as unknown as AdminRuntimeState & {
        registerSendPollAwaiter: (pollId: string, chatJid: string, options: string[], resolution: string, timeoutMs: number) => Promise<string>;
        fetchGroupAdminJids: (chatJid: string) => Promise<Set<string> | null>;
      };
      await runtime.start();

      // Transient group-metadata fetch failure → null admin set.
      const spy = vi.spyOn(state, 'fetchGroupAdminJids').mockResolvedValue(null);

      const pollId = 'POLL_QR036';
      const mapKey = `send_poll:${pollId}`;
      // Fire-and-forget the awaiter (its promise resolves only on a qualifying vote / timeout).
      void state.registerSendPollAwaiter(pollId, groupJid, ['Yes', 'No'], 'admin-only', 60_000);

      await vi.waitFor(() => expect(spy).toHaveBeenCalledWith(groupJid));
      await Promise.resolve(); // flush the fetchGroupAdminJids().then() microtask

      const pending = state.pendingPolls.questions.get(mapKey);
      expect(pending).toBeDefined();
      // FAIL-CLOSED: the strategy stays admin-only with a null admin set (pre-QR-036
      // this was downgraded to 'first-vote-wins', letting any member resolve).
      expect(pending!.resolution).toBe('admin-only');
      expect(pending!.adminJids ?? null).toBeNull();

      // A non-admin vote must NOT resolve the gated decision.
      state.handlePollVoteReceived({ pollMessageId: pollId, chatJid: groupJid, voterJid: nonAdminA, selectedOptions: ['No'] });
      expect(pending!.answersCollected[0]).toBeUndefined();
      expect(state.pendingPolls.questions.has(mapKey)).toBe(true);
      expect(mockSession.sendTurn).not.toHaveBeenCalled();
    });

    it('QR-051 — send_poll admin-only stays fail-closed when group admin metadata is unavailable', async () => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const state = runtime as unknown as AdminRuntimeState;
      await runtime.start();

      const pollMessageId = 'POLL_ADMIN_METADATA_UNAVAILABLE';
      const mapKey = `send_poll:${pollMessageId}`;
      let settled: string | null = null;
      const awaiter = state
        .registerSendPollAwaiter(pollMessageId, groupJid, ['Delete the database', 'Cancel'], 'admin-only', 60_000)
        .then((answer) => { settled = answer; })
        .catch((err: Error) => { settled = `rejected:${err.message}`; });

      await vi.waitFor(() => {
        expect(state.pendingPolls.questions.get(mapKey)?.resolution).toBe('admin-only');
      });

      const pending = state.pendingPolls.questions.get(mapKey);
      expect(pending?.adminJids).toBeNull();

      state.handlePollVoteReceived({
        pollMessageId,
        chatJid: groupJid,
        voterJid: nonAdminA,
        selectedOptions: ['Delete the database'],
      });

      await Promise.resolve();
      expect(settled).toBeNull();
      expect(pending?.answersCollected[0]).toBeUndefined();
      expect(state.pendingPolls.questions.has(mapKey)).toBe(true);

      state.deletePendingPollQuestions(mapKey);
      await vi.waitFor(() => expect(settled).toMatch(/^rejected:Poll abandoned/));
      await awaiter;
    });
  });

  // ── P2 hardening: rehydrate consolidation + persistence error counter ─────

  describe('poll persistence hardening', () => {
    function makeRealDb(): RealDatabase {
      const db = new RealDatabase(':memory:');
      db.open();
      return db;
    }

    function buildPayload(overrides: Partial<PendingPollQuestion>): string {
      const pending: PendingPollQuestion = {
        questions: [{
          question: 'Pick',
          header: 'H',
          options: [{ label: 'A', description: '' }, { label: 'B', description: '' }],
          multiSelect: false,
        }],
        toolId: 'tool-x',
        chatJid: 'chat@g.us',
        chatJidAliases: new Set(['chat@g.us']),
        mode: 'poll',
        pollMessageIdToQuestionIndex: new Map([['POLL_X', 0]]),
        currentQuestionIndex: 0,
        answersCollected: {},
        createdAt: 1_700_000_000_000,
        resolution: 'first-vote-wins',
        timeoutMs: 3_600_000,
        votesByQuestion: new Map(),
        adminJids: null,
        source: 'askuser',
        sentPollMessageIds: ['POLL_X'],
        ...overrides,
      };
      return JSON.stringify(serializePendingPoll(pending));
    }

    function insertRow(
      db: RealDatabase,
      mapKey: string,
      chatJid: string,
      hardClosesAt: number | null,
      payload: string,
    ): void {
      db.raw.prepare(
        `INSERT INTO pending_polls (map_key, chat_jid, tool_id, source, resolution, payload, created_at, closes_at, hard_closes_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(mapKey, chatJid, mapKey, 'askuser', 'first-vote-wins', payload, 1_700_000_000_000, hardClosesAt, hardClosesAt);
    }

    it('rehydrate consolidates expired-during-downtime notices to one message per chat', async () => {
      const db = makeRealDb();
      const { messenger, sentMessages } = makeMessenger();
      const past = Date.now() - 10_000;
      const future = Date.now() + 3_600_000;

      // chatA: 3 stranded polls → one consolidated "3 polls" notice
      insertRow(db, 'send_poll:a1', 'chatA@g.us', past, buildPayload({ chatJid: 'chatA@g.us' }));
      insertRow(db, 'send_poll:a2', 'chatA@g.us', past, buildPayload({ chatJid: 'chatA@g.us' }));
      insertRow(db, 'send_poll:a3', 'chatA@g.us', past, buildPayload({ chatJid: 'chatA@g.us' }));
      // chatB: 1 stranded poll → one single-poll notice
      insertRow(db, 'send_poll:b1', 'chatB@g.us', past, buildPayload({ chatJid: 'chatB@g.us' }));
      // chatC: live poll → restored, no notice
      insertRow(db, 'send_poll:c1', 'chatC@g.us', future, buildPayload({
        chatJid: 'chatC@g.us',
        pollMessageIdToQuestionIndex: new Map([['POLL_C', 0]]),
        sentPollMessageIds: ['POLL_C'],
      }));

      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      await (runtime as unknown as { rehydratePendingPolls(): Promise<void> }).rehydratePendingPolls();

      // Exactly 2 chats notified (chatA + chatB), not 4 messages
      expect(sentMessages).toHaveLength(2);
      const byChat = new Map(sentMessages.map((m) => [m.jid, m.text]));
      expect(byChat.get('chatA@g.us')).toMatch(/3 polls/);
      expect(byChat.get('chatB@g.us')).toMatch(/A poll I was waiting on/);
      expect(byChat.has('chatC@g.us')).toBe(false);

      // chatC live poll restored into the in-memory map; expired rows deleted from table
      const state = runtime as unknown as { pendingPolls: { questions: Map<string, unknown> } };
      expect(state.pendingPolls.questions.has('send_poll:c1')).toBe(true);
      expect(state.pendingPolls.questions.has('send_poll:a1')).toBe(false);
      const remaining = db.raw.prepare('SELECT COUNT(*) AS cnt FROM pending_polls').get() as { cnt: number };
      expect(remaining.cnt).toBe(1);

      db.close();
    });

    it('rehydrate logs and drops expired polls when the downtime notice send rejects', async () => {
      const db = makeRealDb();
      const { messenger } = makeMessenger();
      const past = Date.now() - 10_000;
      const sendError = new Error('socket closed');
      messenger.sendMessage = vi.fn(async () => {
        throw sendError;
      });
      mockRuntimeLogger.warn.mockClear();

      insertRow(db, 'send_poll:reject', 'chatReject@g.us', past, buildPayload({ chatJid: 'chatReject@g.us' }));

      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      await expect((runtime as unknown as { rehydratePendingPolls(): Promise<void> }).rehydratePendingPolls()).resolves.toBeUndefined();
      await Promise.resolve();

      expect(messenger.sendMessage).toHaveBeenCalledWith(
        'chatReject@g.us',
        expect.stringContaining('A poll I was waiting on expired'),
      );
      expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
        { err: sendError, chatJid: 'chatReject@g.us' },
        'notifyPollExpiredDuringDowntime: send failed (non-fatal)',
      );
      const remaining = db.raw.prepare('SELECT COUNT(*) AS cnt FROM pending_polls').get() as { cnt: number };
      expect(remaining.cnt).toBe(0);

      db.close();
    });

    it('rehydrate logs and drops expired polls when downtime notice dispatch throws synchronously', async () => {
      const db = makeRealDb();
      const { messenger } = makeMessenger();
      const past = Date.now() - 10_000;
      const dispatchError = new Error('transport unavailable');
      messenger.sendMessage = vi.fn(() => {
        throw dispatchError;
      }) as unknown as Messenger['sendMessage'];
      mockRuntimeLogger.warn.mockClear();

      insertRow(db, 'send_poll:throw', 'chatThrow@g.us', past, buildPayload({ chatJid: 'chatThrow@g.us' }));

      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      await expect((runtime as unknown as { rehydratePendingPolls(): Promise<void> }).rehydratePendingPolls()).resolves.toBeUndefined();

      expect(messenger.sendMessage).toHaveBeenCalledWith(
        'chatThrow@g.us',
        expect.stringContaining('A poll I was waiting on expired'),
      );
      expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
        { err: dispatchError, chatJid: 'chatThrow@g.us' },
        'notifyPollExpiredDuringDowntime: dispatch failed (non-fatal)',
      );
      const remaining = db.raw.prepare('SELECT COUNT(*) AS cnt FROM pending_polls').get() as { cnt: number };
      expect(remaining.cnt).toBe(0);

      db.close();
    });

    it('persistPendingPoll failure increments pollPersistenceErrors and surfaces it in the health snapshot', async () => {
      const db = makeRealDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });

      const snapBefore = runtime.getHealthSnapshot();
      expect((snapBefore.details as { pollPersistenceErrors: number }).pollPersistenceErrors).toBe(0);

      // Drop the table AFTER construction so the constructor's own prepares
      // succeed but persist/remove INSERT/DELETE hit "no such table" and the
      // catch blocks increment the counter.
      db.raw.prepare('DROP TABLE pending_polls').run();

      const pending: PendingPollQuestion = {
        questions: [{ question: 'Q', header: 'H', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }], multiSelect: false }],
        toolId: 'tool-y',
        chatJid: 'chatErr@g.us',
        chatJidAliases: new Set(['chatErr@g.us']),
        mode: 'poll',
        pollMessageIdToQuestionIndex: new Map([['POLL_Y', 0]]),
        currentQuestionIndex: 0,
        answersCollected: {},
        createdAt: Date.now(),
        resolution: 'first-vote-wins',
        timeoutMs: 3_600_000,
        votesByQuestion: new Map(),
        adminJids: null,
        source: 'send_poll',
        sentPollMessageIds: ['POLL_Y'],
      };

      (runtime as unknown as { pollPersistence: { save(k: string, p: PendingPollQuestion): void } })
        .pollPersistence.save('send_poll:y', pending);
      (runtime as unknown as { pollPersistence: { remove(k: string): void } })
        .pollPersistence.remove('send_poll:y');

      const snapAfter = runtime.getHealthSnapshot();
      expect((snapAfter.details as { pollPersistenceErrors: number }).pollPersistenceErrors).toBe(2);

      db.close();
    });

    it('normalizes legacy pending poll timeout before persistence', () => {
      const db = makeRealDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const createdAt = 1_700_000_000_000;
      const pending = {
        questions: [{ question: 'Q', header: 'H', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }], multiSelect: false }],
        toolId: 'tool-legacy-timeout',
        chatJid: 'chatLegacy@g.us',
        chatJidAliases: new Set(['chatLegacy@g.us']),
        mode: 'poll',
        pollMessageIdToQuestionIndex: new Map([['POLL_LEGACY', 0]]),
        currentQuestionIndex: 0,
        answersCollected: {},
        createdAt,
        resolution: 'first-vote-wins',
        votesByQuestion: new Map(),
        adminJids: null,
        source: 'askuser',
        sentPollMessageIds: ['POLL_LEGACY'],
      } as PendingPollQuestion;

      (runtime as unknown as { pollPersistence: { save(k: string, p: PendingPollQuestion): void } })
        .pollPersistence.save('legacy-timeout', pending);

      const row = db.raw
        .prepare('SELECT payload, closes_at, hard_closes_at FROM pending_polls WHERE map_key = ?')
        .get('legacy-timeout') as { payload: string; closes_at: number; hard_closes_at: number };
      const payload = JSON.parse(row.payload) as { timeoutMs?: number };
      expect(payload.timeoutMs).toBe(3_600_000);
      expect(row.closes_at).toBe(createdAt + 3_600_000);
      expect(row.hard_closes_at).toBe(createdAt + 7_200_000);

      db.close();
    });

    it('clamps out-of-range legacy pending poll timeout before persistence', () => {
      const db = makeRealDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const createdAt = 1_700_000_000_000;
      const pending = {
        questions: [{ question: 'Q', header: 'H', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }], multiSelect: false }],
        toolId: 'tool-huge-timeout',
        chatJid: 'chatHuge@g.us',
        chatJidAliases: new Set(['chatHuge@g.us']),
        mode: 'poll',
        pollMessageIdToQuestionIndex: new Map([['POLL_HUGE', 0]]),
        currentQuestionIndex: 0,
        answersCollected: {},
        createdAt,
        resolution: 'first-vote-wins',
        timeoutMs: Number.MAX_SAFE_INTEGER,
        votesByQuestion: new Map(),
        adminJids: null,
        source: 'askuser',
        sentPollMessageIds: ['POLL_HUGE'],
      } as PendingPollQuestion;

      (runtime as unknown as { pollPersistence: { save(k: string, p: PendingPollQuestion): void } })
        .pollPersistence.save('huge-timeout', pending);

      const row = db.raw
        .prepare('SELECT payload, closes_at, hard_closes_at FROM pending_polls WHERE map_key = ?')
        .get('huge-timeout') as { payload: string; closes_at: number; hard_closes_at: number };
      const payload = JSON.parse(row.payload) as { timeoutMs?: number };
      expect(payload.timeoutMs).toBe(86_400_000);
      expect(row.closes_at).toBe(createdAt + 86_400_000);
      expect(row.hard_closes_at).toBe(createdAt + 172_800_000);

      db.close();
    });
  });

  // ── Admin session commands: /sessions and /kill-session ───────────────────
  // Covers the `case 'sessions':` and `case 'kill-session':` handler blocks in
  // _handleMessageInner (single + per_chat scopes, admin guards, token
  // formatting, invalid-index handling). These responses use sendDirect(...,
  // bypassEchoGuard=true), so they land in messenger.sendMessage (sentMessages),
  // not the outbound queue.
  describe('admin session commands', () => {
    const adminSender = '15550100001@s.whatsapp.net';
    const nonAdminSender = '15559998888@s.whatsapp.net';

    /**
     * Mock Database whose prepared SELECT against agent_sessions returns a
     * controlled token row. Used to exercise the token-formatting branches in
     * the /sessions handler (>1000 → "k" suffix vs raw count).
     */
    function makeDbWithTokenRow(
      tokenRow: { total_input_tokens: number | null; total_output_tokens: number | null } | undefined,
    ): Database {
      return {
        raw: {
          prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn(() => tokenRow) })),
          exec: vi.fn(),
        },
      } as unknown as Database;
    }

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

    it('/sessions is ignored for a non-admin sender', async () => {
      const db = makeDb();
      const { messenger, sentMessages } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger);
      await runtime.start();

      await sendAndDrain(runtime, makeMsg({ content: '/sessions', senderJid: nonAdminSender }));

      // Non-admin guard returns before any send.
      expect(sentMessages.map((m) => m.text)).toEqual([]);
    });

    it('/sessions (single scope) reports an active session with k-suffixed token total', async () => {
      const db = makeDbWithTokenRow({ total_input_tokens: 1500, total_output_tokens: 700 });
      const { messenger, sentMessages } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger);
      await runtime.start();

      const state = runtime as unknown as {
        session: typeof mockSession;
        activeChatJid: string | null;
      };
      mockSession.getStatus.mockReturnValue({
        active: true,
        pid: 321,
        sessionId: 'sess-single',
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        messageCount: 5,
        lastMessageAt: null,
      });
      mockSession.getDbRowId.mockReturnValue(42);
      state.session = mockSession;
      state.activeChatJid = 'owner@s.whatsapp.net';

      await sendAndDrain(runtime, makeMsg({ content: '/sessions', senderJid: adminSender }));

      const texts = sentMessages.map((m) => m.text);
      const listText = texts.find((t) => t.includes('Active Sessions'));
      expect(listText).toContain('Active Sessions (1)');
      // (1500 + 700) / 1000 = 2.2k
      expect(listText).toContain('2.2k tokens');
      expect(listText).toContain('owner@s.whatsapp.net');
    });

    it('/sessions (single scope) reports raw token count when total <= 1000', async () => {
      const db = makeDbWithTokenRow({ total_input_tokens: 300, total_output_tokens: 200 });
      const { messenger, sentMessages } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger);
      await runtime.start();

      const state = runtime as unknown as {
        session: typeof mockSession;
        activeChatJid: string | null;
      };
      mockSession.getStatus.mockReturnValue({
        active: true,
        pid: 322,
        sessionId: 'sess-single-2',
        startedAt: new Date(Date.now() - 30_000).toISOString(),
        messageCount: 2,
        lastMessageAt: null,
      });
      mockSession.getDbRowId.mockReturnValue(7);
      state.session = mockSession;
      state.activeChatJid = null; // exercises the `?? 'unknown'` fallback

      await sendAndDrain(runtime, makeMsg({ content: '/sessions', senderJid: adminSender }));

      const listText = sentMessages.map((m) => m.text).find((t) => t.includes('Active Sessions'));
      expect(listText).toContain('500 tokens');
      expect(listText).toContain('1. unknown');
    });

    it('/sessions (single scope) reports no active sessions when session inactive', async () => {
      const db = makeDb();
      const { messenger, sentMessages } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger);
      await runtime.start();

      mockSession.getStatus.mockReturnValue({ active: false, pid: null, sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null });
      (runtime as unknown as { session: typeof mockSession }).session = mockSession;

      await sendAndDrain(runtime, makeMsg({ content: '/sessions', senderJid: adminSender }));

      const text = sentMessages.map((m) => m.text).find((t) => t.includes('No active sessions'));
      expect(text).toBe('_No active sessions._');
    });

    it('/sessions (per_chat scope) lists DM and Group active sessions, skips inactive, formats tokens', async () => {
      const db = makeDbWithTokenRow({ total_input_tokens: 2000, total_output_tokens: 0 });
      const { messenger, sentMessages } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      await runtime.start();

      const state = runtime as unknown as {
        chatSessions: Map<string, ReturnType<typeof makePerChatSession>>;
      };
      const startedAt = new Date(Date.now() - 90_000).toISOString();
      state.chatSessions.set('15551112222', makePerChatSession(true, 11, startedAt)); // DM
      state.chatSessions.set('111111100000000100@g.us', makePerChatSession(true, 12, startedAt)); // Group
      state.chatSessions.set('15553334444', makePerChatSession(false, null, null)); // inactive → skipped

      await sendAndDrain(runtime, makeMsg({ content: '/sessions', senderJid: adminSender }));

      const listText = sentMessages.map((m) => m.text).find((t) => t.includes('Active Sessions'));
      expect(listText).toContain('Active Sessions (2)');
      expect(listText).toContain('(DM)');
      expect(listText).toContain('(Group)');
      expect(listText).toContain('2.0k tokens');
      expect(listText).not.toContain('15553334444');
    });

    it('/sessions (per_chat scope) shows 0 tokens when dbRowId is null', async () => {
      const db = makeDb();
      const { messenger, sentMessages } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      await runtime.start();

      const state = runtime as unknown as {
        chatSessions: Map<string, ReturnType<typeof makePerChatSession>>;
      };
      state.chatSessions.set('15551112222', makePerChatSession(true, null, new Date().toISOString()));

      await sendAndDrain(runtime, makeMsg({ content: '/sessions', senderJid: adminSender }));

      const listText = sentMessages.map((m) => m.text).find((t) => t.includes('Active Sessions'));
      expect(listText).toContain('0 tokens');
    });

    it('/sessions (per_chat scope) treats null token columns as 0', async () => {
      const db = makeDbWithTokenRow({ total_input_tokens: null, total_output_tokens: null });
      const { messenger, sentMessages } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      await runtime.start();

      const state = runtime as unknown as {
        chatSessions: Map<string, ReturnType<typeof makePerChatSession>>;
      };
      // dbRowId non-null → token query runs; row present but columns null → 0
      state.chatSessions.set('15551112222', makePerChatSession(true, 11, new Date().toISOString()));

      await sendAndDrain(runtime, makeMsg({ content: '/sessions', senderJid: adminSender }));

      const listText = sentMessages.map((m) => m.text).find((t) => t.includes('Active Sessions'));
      expect(listText).toContain('0 tokens');
    });

    it('/sessions (per_chat scope) shows ? age when startedAt is null', async () => {
      const db = makeDb();
      const { messenger, sentMessages } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      await runtime.start();

      const state = runtime as unknown as {
        chatSessions: Map<string, ReturnType<typeof makePerChatSession>>;
      };
      // active but no startedAt → age formatting falls back to '?'
      state.chatSessions.set('15551112222', makePerChatSession(true, null, null));

      await sendAndDrain(runtime, makeMsg({ content: '/sessions', senderJid: adminSender }));

      const listText = sentMessages.map((m) => m.text).find((t) => t.includes('Active Sessions'));
      expect(listText).toContain('— ?,');
    });

    it('/kill-session is ignored for a non-admin sender', async () => {
      const db = makeDb();
      const { messenger, sentMessages } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger);
      await runtime.start();

      await sendAndDrain(runtime, makeMsg({ content: '/kill-session 1', senderJid: nonAdminSender }));

      expect(sentMessages.map((m) => m.text)).toEqual([]);
    });

    it('/kill-session rejects a non-numeric index with usage help', async () => {
      const db = makeDb();
      const { messenger, sentMessages } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger);
      await runtime.start();

      await sendAndDrain(runtime, makeMsg({ content: '/kill-session abc', senderJid: adminSender }));

      const text = sentMessages.map((m) => m.text).find((t) => t.includes('Usage: /kill-session'));
      expect(text).toContain('Run /sessions first');
    });

    it('/kill-session rejects index below 1 with usage help', async () => {
      const db = makeDb();
      const { messenger, sentMessages } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger);
      await runtime.start();

      await sendAndDrain(runtime, makeMsg({ content: '/kill-session 0', senderJid: adminSender }));

      const text = sentMessages.map((m) => m.text).find((t) => t.includes('Usage: /kill-session'));
      expect(text).toContain('Run /sessions first');
    });

    it('/kill-session (single scope) reports no active session to kill', async () => {
      const db = makeDb();
      const { messenger, sentMessages } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger);
      await runtime.start();

      mockSession.getStatus.mockReturnValue({ active: false, pid: null, sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null });
      (runtime as unknown as { session: typeof mockSession }).session = mockSession;

      await sendAndDrain(runtime, makeMsg({ content: '/kill-session 1', senderJid: adminSender }));

      const text = sentMessages.map((m) => m.text).find((t) => t.includes('No active session to kill'));
      expect(text).toBe('_No active session to kill._');
    });

    it('/kill-session (per_chat scope) rejects an out-of-range index', async () => {
      const db = makeDb();
      const { messenger, sentMessages } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      await runtime.start();

      const state = runtime as unknown as {
        chatSessions: Map<string, ReturnType<typeof makePerChatSession>>;
      };
      state.chatSessions.set('15551112222', makePerChatSession(true, 11, new Date().toISOString()));

      // Only 1 active session, ask to kill #5
      await sendAndDrain(runtime, makeMsg({ content: '/kill-session 5', senderJid: adminSender }));

      const text = sentMessages.map((m) => m.text).find((t) => t.includes('Invalid session number'));
      expect(text).toBe('_Invalid session number. 1 active._');
    });

    it('/kill-session (per_chat scope) kills the targeted Group session and reports it', async () => {
      const db = makeDb();
      const { messenger, sentMessages } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      await runtime.start();

      const state = runtime as unknown as {
        chatSessions: Map<string, ReturnType<typeof makePerChatSession>>;
        chatQueues: Map<string, IOutboundQueue>;
      };
      const groupKey = '111111100000000100@g.us';
      const targetSession = makePerChatSession(true, 11, new Date().toISOString());
      state.chatSessions.set(groupKey, targetSession);
      const groupQueue = makeQueueMock('group@g.us');
      state.chatQueues.set(groupKey, groupQueue);

      await sendAndDrain(runtime, makeMsg({ content: '/kill-session 1', senderJid: adminSender }));

      expect(groupQueue.abortTurn).toHaveBeenCalledTimes(1);
      expect(targetSession.shutdown).toHaveBeenCalledWith(false);
      expect(state.chatSessions.has(groupKey)).toBe(false);
      expect(state.chatQueues.has(groupKey)).toBe(false);
      const text = sentMessages.map((m) => m.text).find((t) => t.includes('Session killed:'));
      expect(text).toBe(`_Session killed: ${groupKey} (Group)_`);
    });

    it('/kill-session (per_chat scope) kills the targeted DM session and reports it', async () => {
      const db = makeDb();
      const { messenger, sentMessages } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      await runtime.start();

      const state = runtime as unknown as {
        chatSessions: Map<string, ReturnType<typeof makePerChatSession>>;
        chatQueues: Map<string, IOutboundQueue>;
      };
      const dmKey = '15551112222';
      const targetSession = makePerChatSession(true, 11, new Date().toISOString());
      state.chatSessions.set(dmKey, targetSession);
      state.chatQueues.set(dmKey, makeQueueMock('dm@s.whatsapp.net'));

      await sendAndDrain(runtime, makeMsg({ content: '/kill-session 1', senderJid: adminSender }));

      expect(targetSession.shutdown).toHaveBeenCalledWith(false);
      const text = sentMessages.map((m) => m.text).find((t) => t.includes('Session killed:'));
      expect(text).toBe(`_Session killed: ${dmKey} (DM)_`);
    });
  });

  describe('cross-conversation binding invariant (#1095)', () => {
    const ALICE_JID = '15550100001@s.whatsapp.net';
    const BOB_JID = '15550100002@s.whatsapp.net';

    type BindView = {
      singletonProviderToolSession: SessionContext | null;
      globalSocketServer: { updateConversationKey: (k: string | undefined) => void } | null;
      enforceGlobalConversationBinding: (chatJid: string) => void;
    };

    function makeBindingRuntime(sessionScope: 'single' | 'shared' | 'per_chat'): {
      view: BindView;
      socketUpdates: Array<string | undefined>;
    } {
      const runtime = new AgentRuntime(makeDb(), makeMessenger().messenger, 'test', { sessionScope });
      const view = runtime as unknown as BindView;
      const socketUpdates: Array<string | undefined> = [];
      view.singletonProviderToolSession = { tier: 'global' };
      view.globalSocketServer = { updateConversationKey: (k) => { socketUpdates.push(k); } };
      return { view, socketUpdates };
    }

    it('pins an unbound shared/global session to the originating chat at turn dispatch (no drift error)', () => {
      const { view, socketUpdates } = makeBindingRuntime('shared');
      view.enforceGlobalConversationBinding(ALICE_JID);
      expect(view.singletonProviderToolSession?.conversationKey).toBe(toConversationKey(ALICE_JID));
      expect(socketUpdates).toEqual([toConversationKey(ALICE_JID)]);
      expect(mockRuntimeLogger.error).not.toHaveBeenCalled();
    });

    it('re-pins fail-closed and loudly logs when the session is bound to a DIFFERENT chat (the dangerous drift)', () => {
      const { view, socketUpdates } = makeBindingRuntime('single');
      // Simulate an entry path that left the session pinned to a stale/other chat.
      view.singletonProviderToolSession!.conversationKey = toConversationKey(BOB_JID);
      view.enforceGlobalConversationBinding(ALICE_JID);
      // Re-pinned to the chat this turn actually belongs to → a cross-send to BOB is rejected by the guard.
      expect(view.singletonProviderToolSession?.conversationKey).toBe(toConversationKey(ALICE_JID));
      expect(socketUpdates).toEqual([toConversationKey(ALICE_JID)]);
      expect(mockRuntimeLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ expected: toConversationKey(ALICE_JID), bound: toConversationKey(BOB_JID) }),
        expect.stringContaining('binding drift'),
      );
    });

    it('leaves a per_chat session untouched (already isolated by forced deliveryJid)', () => {
      const { view, socketUpdates } = makeBindingRuntime('per_chat');
      view.enforceGlobalConversationBinding(ALICE_JID);
      expect(view.singletonProviderToolSession?.conversationKey).toBeUndefined();
      expect(socketUpdates).toEqual([]);
      expect(mockRuntimeLogger.error).not.toHaveBeenCalled();
    });
  });

  // ─── Layer 1 wiring: endTurn() called on every result branch ─────────────

  describe('typing indicator — endTurn() choke point', () => {
    it('clears the typing indicator on a result even when the turn early-returns (usage-limit)', async () => {
      const runtime = new AgentRuntime(makeDb(), makeMessenger().messenger);
      await runtime.handleMessage(makeMsg({ content: 'hello' }));
      await (runtime as unknown as { turnChain: Promise<void> }).turnChain;

      mockQueue.endTurn.mockClear();

      // Emit a usage-limit result — this is an early-break branch that would
      // have skipped flush() before the endTurn() choke point was added.
      capturedOnEventRef.current?.({
        type: 'result',
        text: 'Claude usage limit reached. Your limit will reset at 3pm.',
        inputTokens: 0,
        outputTokens: 0,
      });
      await Promise.resolve();

      expect(mockQueue.endTurn).toHaveBeenCalledTimes(1);
    });

    it('clears the typing indicator on a normal (flush) result branch too', async () => {
      const runtime = new AgentRuntime(makeDb(), makeMessenger().messenger);
      await runtime.handleMessage(makeMsg({ content: 'hello' }));
      await (runtime as unknown as { turnChain: Promise<void> }).turnChain;

      mockQueue.endTurn.mockClear();

      // Normal result (no early break) — endTurn() must still be called once.
      capturedOnEventRef.current?.({ type: 'result', text: null, inputTokens: 10, outputTokens: 5 });
      await Promise.resolve();

      expect(mockQueue.endTurn).toHaveBeenCalledTimes(1);
    });

    it('per-chat path: endTurn() called on handleEventPerChat result (usage-limit early-break)', () => {
      // Drive a result through the per_chat code path (handleEventPerChat →
      // handleEventWithContext) and verify endTurn() is reached on the per-chat
      // queue, not just the shared queue. This would fail if queue.endTurn() were
      // removed from handleEventWithContext.
      const runtime = new AgentRuntime(makeDb(), makeMessenger().messenger, 'test', { sessionScope: 'per_chat' });
      const MAP_KEY = 'chat-x@s.whatsapp.net';
      const perChatQueue = makeQueueMock(MAP_KEY);

      type PerChatRuntimeView = {
        chatQueues: Map<string, IOutboundQueue>;
        perChatInboundSeqQueue: Map<string, number[]>;
        handleEventPerChat(mapKey: string, event: AgentEvent, toolScopeKey: string): void;
      };
      const view = runtime as unknown as PerChatRuntimeView;

      view.chatQueues.set(MAP_KEY, perChatQueue);
      view.perChatInboundSeqQueue.set(MAP_KEY, [1]);

      // Drive a usage-limit result — early-break branch in handleEventWithContext
      view.handleEventPerChat(MAP_KEY, {
        type: 'result',
        text: 'Claude usage limit reached. Your limit will reset at 3pm.',
        inputTokens: 0,
        outputTokens: 0,
      }, MAP_KEY);

      expect(perChatQueue.endTurn).toHaveBeenCalledTimes(1);
    });
  });
});

// ─── NL routing handler matrix (slices 1.5 + 2; review gap F14/B4) ───────────
// Integration coverage for the /model //why //reset handlers and the spawn
// steering wiring, on a REAL sqlite store (in-memory) behind the runtime,
// with the file's SessionManager/queue/config mocks. Appended last in this
// file; mockConfig routing keys are restored in afterEach.
describe('NL routing handlers (nlRouting flag)', () => {
  const CHAT = '15550000100@s.whatsapp.net';
  const GROUP = '111222333@g.us';
  const SENDER_A = '15550000111@s.whatsapp.net';
  const SENDER_B = '15550000222@s.whatsapp.net';
  const SENDER_A_LID = '11111110000042@lid';

  let routingDb: Database;
  let routingDbPath: string;
  let eventsDir: string;
  let ensurePrefSchema: ((db: Database) => void) | null = null;

  function cfgAny(): Record<string, unknown> {
    return mockConfig as unknown as Record<string, unknown>;
  }

  beforeEach(async () => {
    // REAL store DB: the full schema via Database.open() (migrations), so the
    // constructor's genuine SQL (outbound_sends writer, lid_mappings, the
    // flag-gated preference schema) runs for real instead of against stubs.
    const { Database: RealDatabase } = await import('../../../src/core/database.ts');
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const crypto = await import('node:crypto');
    routingDbPath = path.join(os.tmpdir(), `routing-h-${crypto.randomBytes(6).toString('hex')}.db`);
    const real = new RealDatabase(routingDbPath);
    real.open();
    routingDb = real as unknown as Database;
    const prefMod = await import('../../../src/runtimes/agent/chat-preference-db.ts');
    ensurePrefSchema = prefMod.ensureChatPreferenceSchema;
    eventsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-ev-'));
    cfgAny().nlRouting = true;
    cfgAny().nlRoutingEventsDir = eventsDir;
    // The runtime reads its provider from config (config.agentProvider), which
    // the file-wide mockConfig does not set — routing needs a real primary.
    cfgAny().agentProvider = 'claude-cli';
    capturedSessionManagerOptsRef.current = null;
    mockQueue.enqueueText.mockClear();
    mockSession.sendTurn.mockClear();
    mockSession.getStatus.mockReturnValue({ active: false, pid: null, sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null });
    (mockSession as unknown as Record<string, unknown>).getModelRef = vi.fn(() => undefined);
  });

  afterEach(async () => {
    delete cfgAny().nlRouting;
    delete cfgAny().nlRoutingTiers;
    delete cfgAny().nlRoutingEventsDir;
    delete cfgAny().agentFallbacks;
    delete cfgAny().agentProvider;
    delete cfgAny().agentProviderConfig;
    vi.useRealTimers();
    const fs = await import('node:fs');
    (routingDb as unknown as { close: () => void }).close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(routingDbPath + suffix)) fs.unlinkSync(routingDbPath + suffix);
    }
  });

  function makeRoutingRuntime(): { runtime: AgentRuntime; sentMessages: Array<{ jid: string; text: string }> } {
    const { messenger, sentMessages } = makeMessenger();
    const runtime = new AgentRuntime(routingDb, messenger, 'test', {});
    // Mirror the flag-gated schema init that runtime.start() performs in
    // production (tests do not call start(); its other side effects are
    // out of scope here).
    if (cfgAny().nlRouting === true) ensurePrefSchema?.(routingDb);
    return { runtime, sentMessages };
  }

  function allReplies(sentMessages: Array<{ jid: string; text: string }>): string[] {
    return [
      ...sentMessages.map((s) => s.text),
      ...mockQueue.enqueueText.mock.calls.map((c) => String(c[0])),
    ];
  }

  function prefRows(): Array<Record<string, unknown>> {
    return (routingDb.raw as unknown as { prepare: (s: string) => { all: () => Array<Record<string, unknown>> } })
      .prepare('SELECT * FROM chat_model_preference').all();
  }

  async function readEvents(): Promise<Array<Record<string, unknown>>> {
    // node:fs is partially mocked file-wide (readFileSync is stubbed);
    // node:fs/promises is NOT mocked, so reads go to the real file that the
    // sidecar's (real) appendFileSync wrote.
    const fsp = await import('node:fs/promises');
    const path = await import('node:path');
    const file = path.join(eventsDir, 'route-events.ndjson');
    try {
      const raw = await fsp.readFile(file, 'utf8');
      return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    } catch {
      return [];
    }
  }

  it('flag off: no preference table is created and /model forwards to the session', async () => {
    cfgAny().nlRouting = false;
    const { runtime } = makeRoutingRuntime();
    const tables = (routingDb.raw as unknown as { prepare: (s: string) => { all: () => unknown[] } })
      .prepare("SELECT name FROM sqlite_master WHERE name='chat_model_preference'");
    expect(tables.all()).toHaveLength(0);
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model strongest' }));
    expect(tables.all()).toHaveLength(0);
    expect(mockSession.sendTurn).toHaveBeenCalled();
  });

  it('writes the preference row under CANONICAL keys when the sender presents as @lid', async () => {
    (routingDb.raw as unknown as { prepare: (s: string) => { run: (...a: unknown[]) => unknown } })
      .prepare('INSERT INTO lid_mappings (lid, phone_jid) VALUES (?, ?)')
      .run('11111110000042', SENDER_A);
    const { runtime, sentMessages } = makeRoutingRuntime();
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A_LID, content: '/model strongest' }));
    const rows = prefRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].chat_jid).toBe(CHAT);
    expect(rows[0].sender_jid).toBe(SENDER_A);
    expect(allReplies(sentMessages).join('\n')).toContain('Okay — preferring my strongest model');
    const events = await readEvents();
    expect(events.some((e) => e.event === 'model_preference_set' && e.reasonCode === 'intent_strongest_set')).toBe(true);
  });

  it('/model status renders the recorded preference and the honest authority line', async () => {
    const { runtime, sentMessages } = makeRoutingRuntime();
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model strongest' }));
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model status' }));
    const status = allReplies(sentMessages).find((t) => t.includes('*Current route:*'));
    expect(status).toBeDefined();
    expect(status).toContain('Preference: strongest for you in this chat');
    expect(status).toContain('steers new sessions');
    expect(status).toContain('Authority: routing never changes what I am allowed to do');
    expect(status).not.toContain('no live actions authorized');
  });

  it('an identical repeat EXTENDS the TTL instead of a misleading no-op', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_800_000_000_000);
    const { runtime, sentMessages } = makeRoutingRuntime();
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model fastest' }));
    const first = prefRows()[0].expires_at as number;
    expect(first).toBe(1_800_000_000_000 + 24 * 60 * 60 * 1000);
    vi.setSystemTime(1_800_000_000_000 + 60 * 60 * 1000);
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model fastest', messageId: 'msg-2' }));
    const second = prefRows()[0].expires_at as number;
    expect(second).toBe(1_800_000_000_000 + 60 * 60 * 1000 + 24 * 60 * 60 * 1000);
    expect(allReplies(sentMessages).join('\n')).toContain('Already set — extended for another 24h');
  });

  it('/reset is idempotent: same reply twice, row gone', async () => {
    const { runtime, sentMessages } = makeRoutingRuntime();
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model strongest' }));
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/reset', messageId: 'msg-2' }));
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/reset', messageId: 'msg-3' }));
    expect(prefRows()).toHaveLength(0);
    const resets = allReplies(sentMessages).filter((t) => t.includes('Back to the default route'));
    expect(resets).toHaveLength(2);
    const events = await readEvents();
    expect(events.filter((e) => e.event === 'model_preference_cleared')).toHaveLength(2);
  });

  it('rejects a pin the instance cannot route to — honest copy, NO row written', async () => {
    const { runtime, sentMessages } = makeRoutingRuntime();
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model opencode-cli' }));
    expect(prefRows()).toHaveLength(0);
    const reply = allReplies(sentMessages).join('\n');
    expect(reply).toContain("opencode-cli isn't available on this instance");
    expect(reply).toContain('Available: claude-cli');
  });

  it('a routable pin steers the NEXT session spawn (provider + provider-default model)', async () => {
    cfgAny().agentFallbacks = [{ provider: 'codex-cli' }];
    // Steering is spawn-scoped by design (provider/model are per-session and
    // read-only; the /model echo says "applies from your next session").
    // Single-scope /new restarts the session IN PLACE, so use a fresh runtime
    // on the same db — the restart/new-process spawn path.
    const first = makeRoutingRuntime();
    await sendAndDrain(first.runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model codex-cli' }));
    const { runtime } = makeRoutingRuntime();
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: 'hello there', messageId: 'msg-2' }));
    const opts = capturedSessionManagerOptsRef.current as unknown as { provider?: string; model?: string } | null;
    expect(opts).not.toBeNull();
    expect(opts?.provider).toBe('codex-cli');
    expect(opts?.model).toBeUndefined();
    const events = await readEvents();
    expect(events.some((e) => e.event === 'runtime_selected' && e.source === 'user' && e.reasonCode === 'user_pin')).toBe(true);
  });

  it('group preferences are per-sender: A sets, B is unaffected', async () => {
    const { runtime, sentMessages } = makeRoutingRuntime();
    await sendAndDrain(runtime, makeMsg({ chatJid: GROUP, senderJid: SENDER_A, isGroup: true, content: '/model strongest' }));
    await sendAndDrain(runtime, makeMsg({ chatJid: GROUP, senderJid: SENDER_B, isGroup: true, content: '/model status', messageId: 'msg-2' }));
    const bStatus = allReplies(sentMessages).find((t) => t.includes('*Current route:*'));
    expect(bStatus).toContain('Preference: none');
    const rows = prefRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].sender_jid).toBe(SENDER_A);
  });

  it('a blocked pin gets ONE visible notice per transition, default route, pin survives', async () => {
    // Pin recorded while routable, then the chain is dropped (new runtime,
    // same db) — the strict pin must fail VISIBLY, never impersonate.
    cfgAny().agentFallbacks = [{ provider: 'codex-cli' }];
    const first = makeRoutingRuntime();
    await sendAndDrain(first.runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model codex-cli' }));
    cfgAny().agentFallbacks = [];
    const { runtime, sentMessages } = makeRoutingRuntime();
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: 'hello', messageId: 'msg-2' }));
    const opts = capturedSessionManagerOptsRef.current as unknown as { provider?: string } | null;
    expect(opts?.provider).toBe('claude-cli');
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/new', messageId: 'msg-3' }));
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: 'hello again', messageId: 'msg-4' }));
    const notices = allReplies(sentMessages).filter((t) => t.includes("pinned codex-cli isn't available"));
    expect(notices).toHaveLength(1);
    expect(prefRows()).toHaveLength(1);
    const events = await readEvents();
    expect(events.filter((e) => e.event === 'user_pin_unreachable').length).toBeGreaterThanOrEqual(1);
  });

  it('locally-handled aliases terminally complete the inbound durability journal', async () => {
    const { runtime } = makeRoutingRuntime();
    const durability = {
      completeInbound: vi.fn(),
      markContinuityCandidateIfNoTerminalOutbound: vi.fn(() => true),
      markInboundFailed: vi.fn(),
      upsertSessionCheckpoint: vi.fn(),
    };
    (runtime as unknown as { durability: unknown }).durability = durability;
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model status', inboundSeq: 42 }));
    expect(durability.completeInbound).toHaveBeenCalledWith(42, 'routing_alias_handled');
  });

  it('/why reports the live session provider once a session is active', async () => {
    const { runtime, sentMessages } = makeRoutingRuntime();
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: 'hello' }));
    mockSession.getStatus.mockReturnValue({ active: true, pid: 1, sessionId: 's', startedAt: new Date().toISOString(), messageCount: 1, lastMessageAt: null });
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/why', messageId: 'msg-2' }));
    const why = allReplies(sentMessages).find((t) => t.includes('Route:'));
    expect(why).toContain("serving this chat's current session");
    expect(why).toContain('routing never changes what I am allowed to do');
  });
  it('injects the NL routing prompt contract at spawn (flag on) and omits it when off', async () => {
    const { runtime } = makeRoutingRuntime();
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: 'hello' }));
    const opts = capturedSessionManagerOptsRef.current as unknown as Record<string, unknown>;
    expect(opts).toBeTruthy();
    const block = (opts.routingSystemBlock as (() => string | null) | undefined)?.();
    expect(block).toBeTruthy();
    expect(String(block)).toContain('[[wa-route: strongest]]');
    expect(String(block)).toContain('current provider: claude-cli');
    expect(String(block)).toContain('owner-gated');

    cfgAny().nlRouting = false;
    capturedSessionManagerOptsRef.current = null;
    const second = makeRoutingRuntime();
    await sendAndDrain(second.runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: 'hello' }));
    const offOpts = capturedSessionManagerOptsRef.current as unknown as Record<string, unknown>;
    expect(offOpts).toBeTruthy();
    expect(offOpts.routingSystemBlock).toBeUndefined();
  });

  it('NL typed-intent marker feeds the SAME preference path as the aliases and is stripped from delivery', async () => {
    const { runtime } = makeRoutingRuntime();
    await runtime.handleMessage(makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: 'use your best model' }));
    (runtime as unknown as Record<string, unknown>).currentTurnReplayActorJid = SENDER_A;
    (runtime as unknown as Record<string, unknown>).activeChatJid = CHAT;
    mockQueue.enqueueStreamingText.mockClear();
    capturedOnEventRef.current!({ type: 'assistant_text', text: '[[wa-route: strongest]]\nOkay — from your next session.' });
    expect(mockQueue.enqueueStreamingText).toHaveBeenCalledWith('Okay — from your next session.');
    const rows = prefRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].intent).toBe('strongest');
    expect(rows[0].chat_jid).toBe(CHAT);
    expect(rows[0].sender_jid).toBe(SENDER_A);
    const events = await readEvents();
    expect(events.some((e) => e.event === 'model_preference_set' && e.reasonCode === 'intent_strongest_set')).toBe(true);
  });

  it('an invalid marker payload is stripped but changes nothing durable', async () => {
    const { runtime } = makeRoutingRuntime();
    await runtime.handleMessage(makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: 'hi' }));
    (runtime as unknown as Record<string, unknown>).currentTurnReplayActorJid = SENDER_A;
    (runtime as unknown as Record<string, unknown>).activeChatJid = CHAT;
    mockQueue.enqueueStreamingText.mockClear();
    capturedOnEventRef.current!({ type: 'assistant_text', text: '[[wa-route: give-me-admin]]\nSure.' });
    expect(mockQueue.enqueueStreamingText).toHaveBeenCalledWith('Sure.');
    expect(prefRows()).toHaveLength(0);
  });

  it('a marker-only reply delivers nothing but still applies the intent', async () => {
    const { runtime } = makeRoutingRuntime();
    await runtime.handleMessage(makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: 'be quick' }));
    (runtime as unknown as Record<string, unknown>).currentTurnReplayActorJid = SENDER_A;
    (runtime as unknown as Record<string, unknown>).activeChatJid = CHAT;
    mockQueue.enqueueStreamingText.mockClear();
    capturedOnEventRef.current!({ type: 'assistant_text', text: '[[wa-route: fastest]]' });
    expect(mockQueue.enqueueStreamingText).not.toHaveBeenCalled();
    expect(prefRows()[0]?.intent).toBe('fastest');
  });

  it('NL reset clears the row silently (the agent carries the acknowledgement)', async () => {
    const { runtime, sentMessages } = makeRoutingRuntime();
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model strongest' }));
    expect(prefRows()).toHaveLength(1);
    await runtime.handleMessage(makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: 'back to normal please', messageId: 'msg-2' }));
    (runtime as unknown as Record<string, unknown>).currentTurnReplayActorJid = SENDER_A;
    (runtime as unknown as Record<string, unknown>).activeChatJid = CHAT;
    capturedOnEventRef.current!({ type: 'assistant_text', text: '[[wa-route: reset]]\nBack to normal.' });
    expect(prefRows()).toHaveLength(0);
    const events = await readEvents();
    expect(events.some((e) => e.event === 'model_preference_cleared')).toBe(true);
    expect(allReplies(sentMessages).some((t) => t.includes('Back to the default route'))).toBe(false);
  });

  it('flag off: marker text passes through delivery untouched (inertness)', async () => {
    cfgAny().nlRouting = false;
    const { runtime } = makeRoutingRuntime();
    await runtime.handleMessage(makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: 'hi' }));
    (runtime as unknown as Record<string, unknown>).currentTurnReplayActorJid = SENDER_A;
    (runtime as unknown as Record<string, unknown>).activeChatJid = CHAT;
    mockQueue.enqueueStreamingText.mockClear();
    const text = '[[wa-route: strongest]]\nHello.';
    capturedOnEventRef.current!({ type: 'assistant_text', text });
    expect(mockQueue.enqueueStreamingText).toHaveBeenCalledWith(text);
    const tables = (routingDb.raw as unknown as { prepare: (s: string) => { all: () => unknown[] } })
      .prepare("SELECT name FROM sqlite_master WHERE name='chat_model_preference'");
    expect(tables.all()).toHaveLength(0);
  });

  it('fallback window arm/extend/clear emits exactly one started and one cleared event', async () => {
    cfgAny().agentFallbacks = [{ provider: 'opencode-cli' }];
    const { runtime } = makeRoutingRuntime();
    const r = runtime as unknown as {
      armFallbackWindow: (until: number, reason: string) => boolean;
      deactivateProviderFallback: (reason: string) => void;
    };
    expect(r.armFallbackWindow.call(runtime, Date.now() + 60_000, 'usage-limit')).toBe(true);
    r.armFallbackWindow.call(runtime, Date.now() + 120_000, 'usage-limit');
    r.deactivateProviderFallback.call(runtime, 'primary_recovered');
    const events = await readEvents();
    const started = events.filter((e) => e.event === 'auto_fallback_started');
    const cleared = events.filter((e) => e.event === 'auto_fallback_cleared');
    expect(started).toHaveLength(1);
    expect(cleared).toHaveLength(1);
    expect(started[0].provider).toBe('opencode-cli');
    expect(started[0].conversationKey).toBeNull();
    expect(started[0].chatScope).toBe('instance');
    expect(started[0].userVisible).toBe(true);
    expect(cleared[0].userVisible).toBe(false);
    expect(cleared[0].reasonCode).toBe('primary_recovered');
  });

  it('a spawn that lands on a different provider than the previous spawn records runtime_switched', async () => {
    const { runtime } = makeRoutingRuntime();
    const note = (provider: string, source: string, reasonCode: string) =>
      (runtime as unknown as { noteRouteAtSpawn: (c: string, k: string, r: unknown) => void })
        .noteRouteAtSpawn(CHAT, CHAT, { provider, model: undefined, source, reasonCode, pinnedProvider: null });
    note('claude-cli', 'default', 'no_preference');
    note('opencode-cli', 'preference', 'user_pin');
    const events = await readEvents();
    expect(events.filter((e) => e.event === 'runtime_selected')).toHaveLength(0);
    const switched = events.filter((e) => e.event === 'runtime_switched');
    expect(switched).toHaveLength(1);
    expect(switched[0].provider).toBe('opencode-cli');
    expect(switched[0].source).toBe('user');
    expect(switched[0].authority).toBe('advisory_only');
  });

  it('spawn fails OPEN to the default route when the preference store read throws (never drops a turn)', async () => {
    const { runtime } = makeRoutingRuntime();
    // Corrupt the store so getPreference throws inside resolveRouteForTurn at spawn.
    routingDb.raw.exec('DROP TABLE chat_model_preference');
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: 'hello' }));
    // The turn still ran — a routing-preference read failure must never drop it.
    expect(capturedSessionManagerOptsRef.current).toBeTruthy();
    expect(mockSession.sendTurn).toHaveBeenCalled();
    expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ instance: 'test' }),
      'preference read failed - routing on default',
    );
  });

  it('an NL marker apply that throws still delivers the reply (fail-open, no state change)', async () => {
    const { runtime } = makeRoutingRuntime();
    await runtime.handleMessage(makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: 'best model please' }));
    (runtime as unknown as Record<string, unknown>).currentTurnReplayActorJid = SENDER_A;
    (runtime as unknown as Record<string, unknown>).activeChatJid = CHAT;
    // Drop the table so recordRoutePreference's store write throws in consumeRouteIntents.
    routingDb.raw.exec('DROP TABLE chat_model_preference');
    mockQueue.enqueueStreamingText.mockClear();
    capturedOnEventRef.current!({ type: 'assistant_text', text: '[[wa-route: strongest]]\nDone.' });
    // Reply is delivered (marker stripped) even though the apply failed.
    expect(mockQueue.enqueueStreamingText).toHaveBeenCalledWith('Done.');
    expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ intent: 'strongest', instance: 'test' }),
      'route-intent apply failed - reply delivered without state change',
    );
  });

  it('an uncredentialed fallback is NOT pinnable — routablePinTargets skips it, /model rejects, no row (F07)', async () => {
    // Determinism: resolveProviderKeyService returns the config apiKeyService for
    // anthropic-api; a random name is absent from SERVICE_ENV_MAP (no env read),
    // the keyring, the file store, and opencode auth, so lookupCredential returns
    // null with no keychain dependency — the fallback is filtered from routable
    // pins and a strict pin to it must fail at SET time rather than impersonate.
    const absentService = `wa-test-absent-${Math.random().toString(36).slice(2)}`;
    cfgAny().agentProviderConfig = { apiKeyService: absentService };
    cfgAny().agentFallbacks = [{ provider: 'anthropic-api' }];
    const { runtime, sentMessages } = makeRoutingRuntime();
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model anthropic-api' }));
    expect(prefRows()).toHaveLength(0);
    const reply = allReplies(sentMessages).join('\n');
    expect(reply).toContain("anthropic-api isn't available on this instance");
    // Only the always-routable primary is offered; the uncredentialed fallback is absent.
    expect(reply).toContain('Available: claude-cli.');
  });

  it('an identical repeat of a STICKY pin is kept, never silently demoted to a 24h TTL', async () => {
    const { runtime, sentMessages } = makeRoutingRuntime();
    // Seed a sticky (expires_at NULL) strongest pin directly, then re-assert it.
    routingDb.raw
      .prepare(`INSERT INTO chat_model_preference
        (chat_jid, sender_jid, intent, requested_provider, scope, pin_strict, fallback_permitted, updated_at, expires_at)
        VALUES (?, ?, 'strongest', NULL, 'sticky', 1, 0, ?, NULL)`)
      .run(CHAT, SENDER_A, Date.now());
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model strongest' }));
    expect(allReplies(sentMessages).some((t) => t.includes('Already set (sticky)'))).toBe(true);
    const rows = prefRows();
    expect(rows).toHaveLength(1);
    // The sticky row survives untouched — a repeat must not demote it to ephemeral.
    expect(rows[0].expires_at).toBeNull();
    expect(rows[0].scope).toBe('sticky');
  });

  it('a routable opencode-cli pin strips primary baseUrl/apiKeyService from the spawned provider config', async () => {
    // opencode-cli fallback with NO model → resolveProviderKeyService returns a
    // null service → not credential-filtered → routable.
    cfgAny().agentProviderConfig = { baseUrl: 'https://primary.example', apiKeyService: 'anthropic', extraOpt: 'kept' };
    cfgAny().agentFallbacks = [{ provider: 'opencode-cli' }];
    const first = makeRoutingRuntime();
    await sendAndDrain(first.runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model opencode-cli' }));
    const { runtime } = makeRoutingRuntime();
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: 'hello there', messageId: 'msg-2' }));
    const opts = capturedSessionManagerOptsRef.current as unknown as { provider?: string; providerConfig?: Record<string, unknown> };
    expect(opts.provider).toBe('opencode-cli');
    // baseUrl + apiKeyService (primary-specific) removed; other keys preserved.
    expect(opts.providerConfig).toEqual({ extraOpt: 'kept' });
  });

  it('/model default clears the preference via the same path as /reset', async () => {
    const { runtime, sentMessages } = makeRoutingRuntime();
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model strongest' }));
    expect(prefRows()).toHaveLength(1);
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model default', messageId: 'msg-2' }));
    expect(prefRows()).toHaveLength(0);
    expect(allReplies(sentMessages).some((t) => t.includes('Back to the default route'))).toBe(true);
    const events = await readEvents();
    expect(events.some((e) => e.event === 'model_preference_cleared')).toBe(true);
  });

});
