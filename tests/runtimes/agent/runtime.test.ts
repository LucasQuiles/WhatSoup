import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Database } from '../../../src/core/database.ts';
import type { IncomingMessage, Messenger } from '../../../src/core/types.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import type { IOutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';
import { createRuntimeTurnContext } from '../../../src/runtimes/agent/runtime-turn-context.ts';
import { createOpenCodeParser } from '../../../src/runtimes/agent/providers/opencode-parser.ts';
import type {
  MarkSystemTurnInput,
  PendingSystemTurnSnapshot,
  SystemTurnLeaseToken,
  SystemTurnPurpose,
} from '../../../src/runtimes/agent/pending-system-result-tracker.ts';

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

const { mockKillSessionTree } = vi.hoisted(() => ({
  mockKillSessionTree: vi.fn(async () => {}),
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

vi.mock('../../../src/runtimes/agent/process-tree.ts', () => ({
  killSessionTree: mockKillSessionTree,
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
    totalCacheReadTokens: number;
    lastCompactInputTokens: number;
    lastCompactOutputTokens: number;
    lastCompactCacheReadTokens: number;
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

vi.mock('../../../src/runtimes/agent/session-classifier.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/runtimes/agent/session-classifier.ts')>();
  return {
    ...actual,
    // resolveAmbiguousAgeFallback stays real (pure function, no I/O) so the
    // #1756 interval-sweep tests exercise the actual age-fallback logic.
    classifyActiveSessions: vi.fn(() => []),
  };
});

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
    stateRoot: '/tmp/whatsoup-test-state-runtime',
    restartLoopGuard: { enabled: true, maxRestarts: 3, windowMs: 300_000 },
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

// B21-A F4b: overridable classifier/registry seams to simulate a FUTURE
// COMMAND_REGISTRY entry the local-command switch has no case for. Default
// (current == null) delegates to the real implementations, so every other
// test sees byte-identical behavior.
const { classifyInputOverrideRef, commandSpecOverrideRef } = vi.hoisted(() => ({
  classifyInputOverrideRef: { current: null as null | ((text: string) => unknown) },
  commandSpecOverrideRef: { current: null as null | ((name: string) => unknown) },
}));

vi.mock('../../../src/runtimes/agent/commands.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/runtimes/agent/commands.ts')>();
  return {
    ...actual,
    classifyInput: ((text: string, opts?: { routingAliases?: boolean }) =>
      classifyInputOverrideRef.current
        ? classifyInputOverrideRef.current(text)
        : actual.classifyInput(text, opts)) as typeof actual.classifyInput,
  };
});

vi.mock('../../../src/runtimes/agent/command-registry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/runtimes/agent/command-registry.ts')>();
  return {
    ...actual,
    getCommandSpec: ((name: string) =>
      commandSpecOverrideRef.current
        ? commandSpecOverrideRef.current(name)
        : actual.getCommandSpec(name as never)) as typeof actual.getCommandSpec,
  };
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

vi.mock('../../../src/core/user-claude-settings.ts', () => ({
  inspectUserClaudeSettings: vi.fn(),
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
    setSensitiveToolAuthorizer = vi.fn();
    withModule = vi.fn((_name: string, fn: () => void) => fn());
  },
}));

// Mock node:fs for socket server path creation in start()
vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    // Delegate to real writeFileSync so private-fs writes persist; a no-op stub left a 0-byte opencode.json the fail-closed reader rejects on the next start().
    writeFileSync: vi.fn((...args: Parameters<typeof actual.writeFileSync>) => actual.writeFileSync(...args)),
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
import { __resetModelCatalogueCacheForTest } from '../../../src/runtimes/agent/model-catalogue-resolver.ts';
import { providerServerErrorNoFallbackNotice, providerUnknownTerminalNotice, renderUserMessage } from '../../../src/runtimes/agent/response-templates.ts';
import { toConversationKey } from '../../../src/core/conversation-key.ts';
import { TurnQueue } from '../../../src/runtimes/agent/turn-queue.ts';
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
import { DurabilityEngine, type SessionCheckpointRow } from '../../../src/core/durability.ts';
import { getRecentMessages } from '../../../src/core/messages.ts';
import { tmpdir } from 'node:os';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDb(): Database {
  return {
    assertWritableCompatibility: vi.fn(),
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

function completedCheckpoint(args: {
  conversationKey: string;
  deliveryJid: string;
  deliveryNamespace: 's.whatsapp.net' | 'lid' | 'g.us';
  scope: 'per_chat' | 'shared' | 'singleton';
  sessionId: string;
  id?: number;
  inboundSeq?: number;
  logicalTurnId?: string;
  managerId?: string;
  generation?: number;
  updatedAt?: string | null;
}): SessionCheckpointRow {
  const inboundSeq = args.inboundSeq ?? 1;
  return {
    id: args.id ?? 1,
    conversation_key: args.conversationKey,
    session_id: args.sessionId,
    transcript_path: null,
    active_turn_id: null,
    last_inbound_seq: inboundSeq,
    completed_inbound_seq: inboundSeq,
    last_flushed_outbound_id: null,
    watchdog_state: null,
    workspace_path: null,
    claude_pid: null,
    session_status: 'active',
    checkpoint_version: 1,
    completed_delivery_jid: args.deliveryJid,
    completed_delivery_namespace: args.deliveryNamespace,
    completed_scope: args.scope,
    completed_logical_turn_id: args.logicalTurnId ?? `turn-${inboundSeq}`,
    completed_manager_id: args.managerId ?? 'resume-manager',
    completed_generation: args.generation ?? 1,
    updated_at: args.updatedAt === undefined
      ? new Date().toISOString().replace('T', ' ').replace('Z', '')
      : args.updatedAt,
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

type ProviderOwnerView = {
  currentRuntimeTurnContext: unknown | null;
  perChatRuntimeTurnContexts: Map<string, unknown[]>;
  legacyProviderTurnOwners: Map<string, unknown>;
};

function hasPublishedProviderOwner(runtime: AgentRuntime, scopeKey: string): boolean {
  const state = runtime as unknown as ProviderOwnerView;
  if (scopeKey === '__global__') {
    return state.currentRuntimeTurnContext !== null
      || state.legacyProviderTurnOwners.has(scopeKey);
  }
  return (state.perChatRuntimeTurnContexts.get(scopeKey)?.length ?? 0) > 0
    || state.legacyProviderTurnOwners.has(scopeKey);
}

async function waitForProviderDispatch(
  runtime: AgentRuntime,
  scopeKey = '__global__',
): Promise<void> {
  await vi.waitFor(() => {
    const state = runtime as unknown as ProviderOwnerView;
    const diagnostic = runtime as unknown as {
      chatSessions: Map<string, unknown>;
      perChatTurnQueues: Map<string, { activeTurn: unknown }>;
    };
    expect(
      hasPublishedProviderOwner(runtime, scopeKey),
      `provider owner was not published for ${scopeKey}; runtime scopes=${[
        ...state.perChatRuntimeTurnContexts.keys(),
      ].join(',')}; legacy scopes=${[...state.legacyProviderTurnOwners.keys()].join(',')}; sessions=${[
        ...diagnostic.chatSessions.keys(),
      ].join(',')}; turn queues=${[...diagnostic.perChatTurnQueues.entries()].map(([key, queue]) => `${key}:${queue.activeTurn === null ? 'idle' : 'active'}`).join(',')}; sends=${mockSession.sendTurn.mock.calls.length}; errors=${mockRuntimeLogger.error.mock.calls.map((call) => String((call[0] as { err?: unknown })?.err ?? call[1])).join('|')}`,
    ).toBe(true);
  });
}

async function sendAndAwaitProviderDispatch(
  runtime: AgentRuntime,
  msg: IncomingMessage,
  scopeKey = '__global__',
): Promise<void> {
  await runtime.handleMessage(msg);
  await waitForProviderDispatch(runtime, scopeKey);
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
    totalCacheReadTokens: 0,
    lastCompactInputTokens,
    lastCompactOutputTokens: 0,
    lastCompactCacheReadTokens: 0,
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

type ToolResultEvent = Extract<AgentEvent, { type: 'tool_result' }>;

function parseOpenCodeToolResult(
  toolName: string | undefined,
  isError: boolean,
  toolId: string,
): ToolResultEvent {
  const event = createOpenCodeParser().parse(JSON.stringify({
    type: 'tool_use',
    part: {
      type: 'tool',
      ...(toolName === undefined ? {} : { tool: toolName }),
      callID: toolId,
      state: isError
        ? { status: 'rejected', error: 'permission requested; auto-rejecting' }
        : { status: 'completed', output: 'completed' },
    },
  }));
  if (event?.type !== 'tool_result') {
    throw new Error(`Expected OpenCode tool_result, received ${event?.type ?? 'null'}`);
  }
  return event;
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
  pendingRecycle: Set<string>;
  lastSpawnRouteProvider: Map<string, string>;
  lastPinBlockNotice: Map<string, string>;
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
  processPerChatTurn(
    scopeRef: { value: string },
    turn: {
      sourceMessageId: string;
      conversationKey: string;
      chatJid: string;
      senderJid: string;
      senderName: string | null;
      text: string;
      isGroup: boolean;
      contentType: 'text';
      runtimeContext: ReturnType<typeof makeRuntimeTurnContext>;
      inboundSeq: number;
    },
  ): Promise<void>;
};

function getPerChatCleanupState(runtime: AgentRuntime): PerChatCleanupRuntimeState {
  return runtime as unknown as PerChatCleanupRuntimeState;
}

function setOwnedTestSession(
  runtime: AgentRuntime,
  mapKey: string,
  session: object,
  toolScopeKey = `${mapKey}#test`,
): string {
  const state = runtime as unknown as {
    setOwnedPerChatSession: (key: string, value: unknown) => void;
    sessionEventToolScopes: WeakMap<object, string>;
  };
  state.setOwnedPerChatSession(mapKey, session);
  state.sessionEventToolScopes.set(session, toolScopeKey);
  return toolScopeKey;
}

type PendingSystemResultTrackerView = {
  mark(input: MarkSystemTurnInput): SystemTurnLeaseToken;
  cancel(lease: SystemTurnLeaseToken | null | undefined): boolean;
  peek(scopeKey: string): PendingSystemTurnSnapshot | null;
  count(scopeKey: string): number;
  blockingCount(scopeKey: string): number;
};

function pendingSystemResults(runtime: AgentRuntime): PendingSystemResultTrackerView {
  return (runtime as unknown as {
    pendingSystemResults: PendingSystemResultTrackerView;
  }).pendingSystemResults;
}

function markOwnedSystemTurn(
  runtime: AgentRuntime,
  sourceSession: object,
  scopeKey: string,
  purpose: SystemTurnPurpose,
  routeChatJid?: string,
): SystemTurnLeaseToken {
  const state = runtime as unknown as {
    captureSystemTurnOwner(
      session: object,
      key: string,
    ): MarkSystemTurnInput['owner'];
  };
  return pendingSystemResults(runtime).mark({
    scopeKey,
    purpose,
    owner: state.captureSystemTurnOwner(sourceSession, scopeKey),
    ...(routeChatJid !== undefined ? { routeChatJid } : {}),
  });
}

function publishSingletonTestOwner(
  runtime: AgentRuntime,
  sourceSession: object,
  routeChatJid: string,
): void {
  const state = runtime as unknown as {
    session: object | null;
    managerIdFor(session: object): string;
    sessionEventToolScopes: WeakMap<object, string>;
    publishLegacyProviderTurn(
      session: object,
      scopeKey: string,
      routeChatJid: string,
    ): unknown;
  };
  state.session = sourceSession;
  state.managerIdFor(sourceSession);
  state.sessionEventToolScopes.set(sourceSession, '__global__');
  state.publishLegacyProviderTurn(sourceSession, '__global__', routeChatJid);
}

function handlePerChatProviderEvent(
  runtime: AgentRuntime,
  sourceSession: object,
  event: AgentEvent,
): void {
  const state = runtime as unknown as {
    sessionEventToolScopes: WeakMap<object, string>;
    handleEventPerChat(session: object, event: AgentEvent, toolScopeKey: string): void;
  };
  const toolScopeKey = state.sessionEventToolScopes.get(sourceSession);
  if (!toolScopeKey) throw new Error('test source session has no registered tool scope');
  state.handleEventPerChat(sourceSession, event, toolScopeKey);
}

/**
 * Exercise downstream event behavior without claiming provider admission.
 * Admission/source-binding tests must use the captured provider callback or
 * the private source-bound handleEvent/handleEventPerChat entry points instead.
 */
function handleEventDownstreamWithoutAdmission(
  runtime: AgentRuntime,
  event: AgentEvent,
  options: {
    queue?: IOutboundQueue;
    session?: object | null;
    conversationKey?: string;
    inboundSeq?: number;
    mapKey?: string;
    toolScopeKey?: string;
    isSystemResult?: boolean;
    systemTurnPurpose?: SystemTurnPurpose | null;
  } = {},
): void {
  const queue = options.queue ?? mockQueue;
  (runtime as unknown as {
    handleEventWithContext(
      event: AgentEvent,
      queue: IOutboundQueue,
      session: object | null,
      conversationKey?: string,
      inboundSeq?: number,
      mapKey?: string,
      toolScopeKey?: string,
      isSystemResult?: boolean,
      systemTurnPurpose?: SystemTurnPurpose | null,
    ): void;
  }).handleEventWithContext(
    event,
    queue,
    options.session === undefined ? mockSession : options.session,
    options.conversationKey,
    options.inboundSeq,
    options.mapKey,
    options.toolScopeKey,
    options.isSystemResult,
    options.systemTurnPurpose,
  );
}

function currentCrashIdentity(runtime: AgentRuntime, mapKey: string): {
  generationIdentity: { managerId: string; generation: number };
} {
  const owner = (runtime as unknown as {
    sessionOwnership: { get: (key: string) => { managerId: string; generation: number } | undefined };
  }).sessionOwnership.get(mapKey);
  if (!owner) throw new Error(`missing test owner for ${mapKey}`);
  return {
    generationIdentity: {
      managerId: owner.managerId,
      generation: owner.generation,
    },
  };
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
    // Reset implementations as well as call history. A fail-fast test can leave
    // a mockRejectedValueOnce queued; allowing that to bleed into the next test
    // makes the suite order-dependent and obscures the real terminal owner.
    mockSession.spawnSession.mockReset().mockResolvedValue(undefined);
    mockSession.shutdown.mockReset().mockResolvedValue(undefined);
    mockSession.waitForProviderTurnToTerminalize.mockReset().mockResolvedValue(undefined);
    mockSession.getStatus.mockReset().mockReturnValue({ active: false, pid: null, sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null });
    mockSession.sendTurn.mockReset().mockResolvedValue(undefined);
    mockSession.getDbRowId.mockReset().mockReturnValue(null);
    mockQueue.flushTurnEvidence.mockReset().mockImplementation(async (turnId: string) => ({
      turnId,
      answerOpIds: [],
      lifecycleOpIds: [],
      statusOpIds: [],
    }));
    mockQueue.abortTurn.mockReset();
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
    delete (mockConfig as Record<string, unknown>).pollResolution;
    mockSynthesizeSpeech.mockClear();
    mockWriteTempFile.mockClear();
    mockPrepareContentForAgent.mockImplementation((...args: unknown[]) => actualPrepareContentForAgentRef.current!(...args));
    vi.mocked(getRecentMessages).mockReset();
    vi.mocked(getRecentMessages).mockReturnValue([]);
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
    mockQueue.flushTurnEvidence.mockImplementation(async (turnId: string) => ({
      turnId,
      answerOpIds: [],
      lifecycleOpIds: [],
      statusOpIds: [],
    }));
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

  it('start() uses the read-only inspector for user-level ~/.claude when cwd != home', async () => {
    const { ensurePermissionsSettings } = await import('../../../src/core/workspace.ts');
    const { inspectUserClaudeSettings } = await import('../../../src/core/user-claude-settings.ts');
    const { homedir } = await import('node:os');
    const { join } = await import('node:path');
    const db = makeDb();
    const { messenger } = makeMessenger();
    // cwd != home: the agent-sandbox hook in user-level ~/.claude is cwd-independent
    // (applies to every session) and is NOT covered by reconciling the cwd-derived dir.
    const runtime = new AgentRuntime(db, messenger, 'test', { cwd: '/tmp/whatsoup-non-home-cwd' });
    await runtime.start();

    expect(inspectUserClaudeSettings).toHaveBeenCalledWith(join(homedir(), '.claude'), expect.stringMatching(/deploy\/hooks\/agent-sandbox\.sh$/));
    expect(ensurePermissionsSettings).toHaveBeenCalledTimes(1);
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
        totalCacheReadTokens: 0,
        lastCompactInputTokens: 100,
        lastCompactOutputTokens: 0,
        lastCompactCacheReadTokens: 0,
      })
      .mockReturnValue({
        totalInputTokens: 260,
        totalOutputTokens: 6,
        totalCacheReadTokens: 0,
        lastCompactInputTokens: 260,
        lastCompactOutputTokens: 6,
        lastCompactCacheReadTokens: 0,
      });

    await runtime.start();
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hello' }));
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
      totalCacheReadTokens: 0,
      lastCompactInputTokens: 100,
      lastCompactOutputTokens: 0,
      lastCompactCacheReadTokens: 0,
    });

    await runtime.start();
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hello' }));
    capturedOnEventRef.current?.({ type: 'result', text: null, inputTokens: 250, outputTokens: 5 });
    await Promise.resolve();

    expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');

    // No compact_boundary — only a terminating result (failed compact case).
    capturedOnEventRef.current?.({ type: 'result', text: null, inputTokens: 10, outputTokens: 1 });

    expect(mockMarkSessionCompacted).not.toHaveBeenCalled();

    mockSession.sendTurn.mockClear();
    await sendAndAwaitProviderDispatch(runtime, makeMsg({
      messageId: 'msg-compact-retry',
      content: 'retry after incomplete compact',
    }));
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
      totalCacheReadTokens: 0,
      lastCompactInputTokens: 0,
      lastCompactOutputTokens: 0,
      lastCompactCacheReadTokens: 0,
    });

    await runtime.start();
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hello' }));
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
      totalCacheReadTokens: 0,
      lastCompactInputTokens: 0,
      lastCompactOutputTokens: 0,
      lastCompactCacheReadTokens: 0,
    });

    await runtime.start();
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hello' }));
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
      totalInputTokens: 5_000, totalOutputTokens: 10, totalCacheReadTokens: 0,
      lastCompactInputTokens: 100, lastCompactOutputTokens: 0, lastCompactCacheReadTokens: 0,
    });

    publishSingletonTestOwner(runtime, mockSession, 'test@s.whatsapp.net');

    (runtime as unknown as {
      maybeStartAutoCompact: (s: typeof mockSession, k?: string) => void;
    }).maybeStartAutoCompact(mockSession);

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
      totalInputTokens: 5_000, totalOutputTokens: 10, totalCacheReadTokens: 0,
      lastCompactInputTokens: 100, lastCompactOutputTokens: 0, lastCompactCacheReadTokens: 0,
    });

    publishSingletonTestOwner(runtime, mockSession, 'test@s.whatsapp.net');

    (runtime as unknown as {
      maybeStartAutoCompact: (s: typeof mockSession, k?: string) => void;
    }).maybeStartAutoCompact(mockSession);

    expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');
  });

  it('#1774: fires /compact at the same combined-total trigger point the pre-split single column held (regression pin)', () => {
    // Before the total_input_tokens/total_cache_read_tokens split, a single
    // combined column drove this trigger. Model a session where genuinely-new
    // input is small but the re-read context is huge (the realistic case that
    // motivated #1774) — the combined read below must reproduce the exact
    // same trigger arithmetic the old undivided column used to, so rollout
    // does not silently defang auto-compact fleet-wide. If maybeStartAutoCompact
    // read total_input_tokens alone (the naive, regressed form), (55 - 5) = 50
    // would NOT clear the threshold and /compact would never fire despite a
    // 10,000-token context.
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { autoCompactInputTokens: 9_990 });
    mockSession.getProviderId.mockReturnValue('claude-cli');
    mockSession.getStatus.mockReturnValue({
      active: true, pid: 123, sessionId: 'session-1',
      startedAt: '2026-05-18T00:00:00.000Z', messageCount: 1, lastMessageAt: null,
    });
    mockSession.getDbRowId.mockReturnValue(42);
    mockGetSessionTokenSnapshot.mockReturnValue({
      totalInputTokens: 55, totalOutputTokens: 10, totalCacheReadTokens: 9_950,
      lastCompactInputTokens: 5, lastCompactOutputTokens: 0, lastCompactCacheReadTokens: 0,
    });

    publishSingletonTestOwner(runtime, mockSession, 'test@s.whatsapp.net');

    (runtime as unknown as {
      maybeStartAutoCompact: (s: typeof mockSession, k?: string) => void;
    }).maybeStartAutoCompact(mockSession);

    // Combined delta: (55 + 9_950) - (5 + 0) = 9_995 >= 9_990 → fires.
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
        totalCacheReadTokens: 0,
        lastCompactInputTokens: 100,
        lastCompactOutputTokens: 0,
        lastCompactCacheReadTokens: 0,
      })
      .mockReturnValue({
        totalInputTokens: 260,
        totalOutputTokens: 6,
        totalCacheReadTokens: 0,
        lastCompactInputTokens: 260,
        lastCompactOutputTokens: 6,
        lastCompactCacheReadTokens: 0,
      });

    await runtime.start();
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hello' }));
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
    };
    const globalScope = '__global__';
    mockActiveAgentSession();
    mockTokenSnapshot(250, 100);
    mockSession.sendTurn
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('compact stdin closed'));

    await runtime.start();
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hello' }));
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
    expect(pendingSystemResults(runtime).count(globalScope)).toBe(0);
    expect(state.autoCompact.waiters.has(globalScope)).toBe(false);
    expect(state.autoCompact.silentCompactScopes.has(globalScope)).toBe(false);

    mockSession.sendTurn.mockClear();
    mockSession.sendTurn.mockResolvedValue(undefined);
    await sendAndAwaitProviderDispatch(runtime, makeMsg({
      messageId: 'msg-after-compact-send-failure',
      content: 'retry compact after send failure',
    }));
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
        totalCacheReadTokens: 0,
        lastCompactInputTokens: 100,
        lastCompactOutputTokens: 0,
        lastCompactCacheReadTokens: 0,
      });

      await runtime.start();
      await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hello' }));
      capturedOnEventRef.current?.({ type: 'result', text: null, inputTokens: 250, outputTokens: 5 });
      await Promise.resolve();

      expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');

      // Advance past the 4-minute compact timeout - no compact_boundary event arrived.
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000 + 100);

      // A subsequent result event would normally trigger maybeStartAutoCompact again.
      // While the post-timeout backoff is active, /compact must NOT be re-sent.
      mockSession.sendTurn.mockClear();
      await sendAndAwaitProviderDispatch(runtime, makeMsg({
        messageId: 'msg-compact-timeout-cooldown',
        content: 'turn during compact cooldown',
      }));
      capturedOnEventRef.current?.({ type: 'result', text: null, inputTokens: 200, outputTokens: 10 });
      await Promise.resolve();

      expect(mockSession.sendTurn).not.toHaveBeenCalledWith('/compact');

      // Once the (now shorter) 5-minute backoff elapses, auto-compact may retry —
      // bounding how far a stuck session grows between attempts instead of
      // degrading for a long window.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);
      mockSession.sendTurn.mockClear();
      await sendAndAwaitProviderDispatch(runtime, makeMsg({
        messageId: 'msg-compact-timeout-retry',
        content: 'turn after compact cooldown',
      }));
      capturedOnEventRef.current?.({ type: 'result', text: null, inputTokens: 200, outputTokens: 10 });
      await Promise.resolve();

      expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');
    } finally {
      vi.useRealTimers();
    }
  });

  it('quarantines a timed-out auto-compact source before admitting and finalizing the next user turn', async () => {
    vi.useFakeTimers();
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { autoCompactInputTokens: 100 });
    try {
      const globalScope = '__global__';
      const { durability } = attachRuntimeFaultMarkerSpies(runtime);
      const tracker = pendingSystemResults(runtime);
      const cancelSpy = vi.spyOn(tracker, 'cancel');
      mockQueue.flushTurnEvidence.mockImplementation(async (turnId: string) => ({
        turnId,
        answerOpIds: [9001],
        lifecycleOpIds: [],
        statusOpIds: [],
      }));
      durability.getOutboundDeliverySnapshot.mockImplementation((opId, expected) => ({
        opId,
        ...expected,
        status: 'echoed',
      }));
      mockActiveAgentSession();
      mockTokenSnapshot(250, 100);

      await runtime.start();
      await sendAndAwaitProviderDispatch(
        runtime,
        makeMsg({ content: 'trigger compact', inboundSeq: 501 }),
      );
      await emitAgentResult(150, 'initial reply');
      await vi.waitFor(() => expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact'));
      await vi.waitFor(() => expect(durability.finalizeTurnTerminal).toHaveBeenCalledWith(
        expect.objectContaining({ terminal: expect.objectContaining({ inboundSeq: 501 }) }),
      ));

      const compactTurn = tracker.peek(globalScope);
      expect(compactTurn).toMatchObject({
        purpose: 'auto_compact_silent',
        blocking: true,
      });
      const compactLease = compactTurn!.lease;
      durability.finalizeTurnTerminal.mockClear();

      const followUpDispatch = sendAndAwaitProviderDispatch(
        runtime,
        makeMsg({ content: 'user turn after compact timeout', inboundSeq: 502 }),
      );
      await Promise.resolve();
      expect(mockSession.sendTurn).not.toHaveBeenCalledWith('user turn after compact timeout');

      await vi.advanceTimersByTimeAsync(4 * 60 * 1000 + 100);
      await followUpDispatch;

      const followUpIndex = (mockSession.sendTurn.mock.calls as unknown as Array<[string]>).findIndex(
        ([text]) => text === 'user turn after compact timeout',
      );
      const followUpOrder = mockSession.sendTurn.mock.invocationCallOrder[followUpIndex]
        ?? Number.MAX_SAFE_INTEGER;
      const shutdownOrder = mockSession.shutdown.mock.invocationCallOrder[0]
        ?? Number.MAX_SAFE_INTEGER;
      const cancelCallIndex = cancelSpy.mock.calls.findIndex(([lease]) => lease?.id === compactLease.id);
      const cancelOrder = cancelSpy.mock.invocationCallOrder[cancelCallIndex]
        ?? Number.MAX_SAFE_INTEGER;

      expect.soft(mockSession.shutdown).toHaveBeenCalledOnce();
      expect.soft(cancelSpy).toHaveBeenCalledWith(compactLease);
      expect.soft(shutdownOrder).toBeLessThan(cancelOrder);
      expect.soft(cancelOrder).toBeLessThan(followUpOrder);
      expect.soft(tracker.peek(globalScope)).toBeNull();
      expect.soft(tracker.blockingCount(globalScope)).toBe(0);

      mockTokenSnapshot(260, 260);
      capturedOnEventRef.current?.({
        type: 'result',
        text: 'follow-up complete',
        inputTokens: 10,
        outputTokens: 1,
      });
      await (runtime as unknown as { turnChain: Promise<void> }).turnChain;

      expect.soft(durability.finalizeTurnTerminal).toHaveBeenCalledWith(
        expect.objectContaining({
          terminal: expect.objectContaining({
            inboundSeq: 502,
            attemptKind: 'completed',
            inboundDisposition: 'finalized_replied',
          }),
        }),
      );
      expect.soft(tracker.count(globalScope)).toBe(0);
      expect.soft(mockMarkSessionCompacted).not.toHaveBeenCalled();
    } finally {
      await runtime.shutdown();
      vi.useRealTimers();
    }
  });

  it('applies an activity-independent wall deadline after provider admission', async () => {
    vi.useFakeTimers();
    let proveShutdown!: () => void;
    mockSession.shutdown.mockImplementationOnce(() => new Promise<void>((resolve) => {
      proveShutdown = resolve;
    }));
    const runtime = new AgentRuntime(makeDb(), makeMessenger().messenger, 'test');
    try {
      await runtime.start();
      const state = runtime as unknown as {
        session: typeof mockSession | null;
        managerIdFor(session: typeof mockSession): string;
        sessionEventToolScopes: WeakMap<typeof mockSession, string>;
        markSystemTurn: (...args: [typeof mockSession, string, 'fresh_session_context', string]) => SystemTurnLeaseToken;
        requireSystemTurnProviderBoundary(lease: SystemTurnLeaseToken): void;
      };
      state.session = mockSession;
      state.managerIdFor(mockSession);
      state.sessionEventToolScopes.set(mockSession, '__global__');
      const lease = state.markSystemTurn(
        mockSession,
        '__global__',
        'fresh_session_context',
        '15550001111@s.whatsapp.net',
      );
      state.requireSystemTurnProviderBoundary(lease);

      // First expiry grants one retry window while the lease keeps blocking dispatch.
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000);

      expect(mockSession.shutdown).not.toHaveBeenCalled();
      expect(pendingSystemResults(runtime).count('__global__')).toBe(1);

      // Second consecutive expiry quarantines exactly as before.
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000);

      expect(mockSession.shutdown).toHaveBeenCalledOnce();
      expect(pendingSystemResults(runtime).count('__global__')).toBe(1);

      proveShutdown();
      await vi.waitFor(() => expect(pendingSystemResults(runtime).count('__global__')).toBe(0));
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
      await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hello' }));
      await emitAgentResult(150);
      expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');

      await emitSuccessfulCompactResult();

      mockSession.sendTurn.mockClear();
      mockTokenSnapshot(600, 250);
      await sendAndAwaitProviderDispatch(runtime, makeMsg({
        messageId: 'msg-single-rapid-rearm',
        content: 'rapid follow-up',
      }));
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
      await sendAndAwaitProviderDispatch(
        runtime,
        makeMsg({ chatJid: 'chat-a@s.whatsapp.net', senderJid: 'chat-a@s.whatsapp.net', content: 'hello' }),
        'chat-a@s.whatsapp.net',
      );
      await emitAgentResult(150);
      expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');

      await emitSuccessfulCompactResult();

      mockSession.sendTurn.mockClear();
      mockTokenSnapshot(600, 250);
      await sendAndAwaitProviderDispatch(
        runtime,
        makeMsg({
          messageId: 'msg-per-chat-rapid-rearm',
          chatJid: 'chat-a@s.whatsapp.net',
          senderJid: 'chat-a@s.whatsapp.net',
          content: 'rapid follow-up',
        }),
        'chat-a@s.whatsapp.net',
      );
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
      let userTurn = 0;

      const emitUserResult = async (inputTokens: number) => {
        userTurn += 1;
        await sendAndAwaitProviderDispatch(runtime, makeMsg({
          messageId: `msg-escalation-${userTurn}`,
          content: `escalation turn ${userTurn}`,
        }));
        await emitAgentResult(inputTokens);
      };

      const triggerCompact = async (totalInputTokens: number, lastCompactInputTokens: number) => {
        mockSession.sendTurn.mockClear();
        mockTokenSnapshot(totalInputTokens, lastCompactInputTokens);
        await emitUserResult(totalInputTokens - lastCompactInputTokens);
        expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');
        await emitSuccessfulCompactResult();
      };

      const triggerRapidRearm = async (totalInputTokens: number, lastCompactInputTokens: number) => {
        mockSession.sendTurn.mockClear();
        mockTokenSnapshot(totalInputTokens, lastCompactInputTokens);
        await emitUserResult(totalInputTokens - lastCompactInputTokens);
        expect(mockSession.sendTurn).not.toHaveBeenCalledWith('/compact');
      };

      await triggerCompact(250, 100);
      await triggerRapidRearm(600, 250);
      expect(runtime.getHealthSnapshot().details.autoCompactIneffective).toBe(1);
      expect(runtime.getHealthSnapshot().details.autoCompactConsecutiveRapidRearmsMax).toBe(1);

      await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
      mockSession.sendTurn.mockClear();
      mockTokenSnapshot(650, 250);
      await emitUserResult(400);
      expect(mockSession.sendTurn).not.toHaveBeenCalledWith('/compact');

      await vi.advanceTimersByTimeAsync(9 * 60 * 1000 + 100);
      await triggerCompact(700, 250);
      await triggerRapidRearm(1_100, 700);
      expect(runtime.getHealthSnapshot().details.autoCompactIneffective).toBe(2);
      expect(runtime.getHealthSnapshot().details.autoCompactConsecutiveRapidRearmsMax).toBe(2);

      await vi.advanceTimersByTimeAsync(16 * 60 * 1000);
      mockSession.sendTurn.mockClear();
      mockTokenSnapshot(1_200, 700);
      await emitUserResult(500);
      expect(mockSession.sendTurn).not.toHaveBeenCalledWith('/compact');

      await vi.advanceTimersByTimeAsync(14 * 60 * 1000 + 100);
      await triggerCompact(1_300, 700);
      await triggerRapidRearm(1_700, 1_300);
      expect(runtime.getHealthSnapshot().details.autoCompactIneffective).toBe(3);
      expect(runtime.getHealthSnapshot().details.autoCompactConsecutiveRapidRearmsMax).toBe(3);

      await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
      mockSession.sendTurn.mockClear();
      mockTokenSnapshot(1_800, 1_300);
      await emitUserResult(500);
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
      let userTurn = 0;
      const emitUserResult = async (inputTokens: number) => {
        userTurn += 1;
        await sendAndAwaitProviderDispatch(runtime, makeMsg({
          messageId: `msg-recovery-${userTurn}`,
          content: `recovery turn ${userTurn}`,
        }));
        await emitAgentResult(inputTokens);
      };

      mockTokenSnapshot(250, 100);
      await emitUserResult(150);
      expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');
      await emitSuccessfulCompactResult();

      mockSession.sendTurn.mockClear();
      mockTokenSnapshot(600, 250);
      await emitUserResult(350);
      expect(mockSession.sendTurn).not.toHaveBeenCalledWith('/compact');
      expect(runtime.getHealthSnapshot().details.autoCompactConsecutiveRapidRearmsMax).toBe(1);

      await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 100);
      mockSession.sendTurn.mockClear();
      mockTokenSnapshot(700, 250);
      await emitUserResult(450);
      expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');
      await emitSuccessfulCompactResult();

      await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
      mockSession.sendTurn.mockClear();
      mockTokenSnapshot(900, 700);
      await emitUserResult(200);
      expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');
      await emitSuccessfulCompactResult();

      mockSession.sendTurn.mockClear();
      mockTokenSnapshot(1_200, 900);
      await emitUserResult(300);
      expect(mockSession.sendTurn).not.toHaveBeenCalledWith('/compact');

      await vi.advanceTimersByTimeAsync(16 * 60 * 1000);
      mockSession.sendTurn.mockClear();
      mockTokenSnapshot(1_300, 900);
      await emitUserResult(400);
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
      await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hello' }));
      mockTokenSnapshot(250, 100);
      await emitAgentResult(150);
      expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');

      await emitSuccessfulCompactResult(250);
      expect(runtime.getHealthSnapshot().details.autoCompactNextTurnOverThreshold).toBe(0);

      await sendAndAwaitProviderDispatch(runtime, makeMsg({
        messageId: 'msg-large-follow-up',
        content: 'large follow-up',
      }));
      await emitAgentResult(250, 'ok');
      expect(runtime.getHealthSnapshot().details.autoCompactNextTurnOverThreshold).toBe(1);
      expect(runtime.getHealthSnapshot().details.autoCompactIneffective).toBe(1);

      await sendAndAwaitProviderDispatch(runtime, makeMsg({
        messageId: 'msg-second-follow-up',
        content: 'second follow-up',
      }));
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
      await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hello' }));
      mockTokenSnapshot(250, 100);
      await emitAgentResult(150);
      expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');

      await emitSuccessfulCompactResult();
      expect(runtime.getHealthSnapshot().details.autoCompactNextTurnOverThreshold).toBe(0);

      await sendAndAwaitProviderDispatch(runtime, makeMsg({
        messageId: 'msg-large-codex-follow-up',
        content: 'large codex follow-up',
      }));
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
        autoCompact: AutoCompactView;
      };
      const globalKey = '__global__';
      mockActiveAgentSession();

      await runtime.start();
      await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hello' }));
      mockTokenSnapshot(250, 100);
      await emitAgentResult(150);
      await emitSuccessfulCompactResult();

      const lease = markOwnedSystemTurn(
        runtime,
        mockSession,
        globalKey,
        'manual_compact_silent',
        'test@s.whatsapp.net',
      );
      await emitTokenUsage(250);
      expect(runtime.getHealthSnapshot().details.autoCompactNextTurnOverThreshold).toBe(0);
      expect(state.autoCompact.measureNextTurn.has(globalKey)).toBe(true);

      pendingSystemResults(runtime).cancel(lease);
      await sendAndAwaitProviderDispatch(runtime, makeMsg({
        messageId: 'msg-single-token-measurement',
        content: 'real user turn after compact',
      }));
      await emitTokenUsage(250);
      expect(runtime.getHealthSnapshot().details.autoCompactNextTurnOverThreshold).toBe(1);
      await emitAgentResultWithoutTokens('done');
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
        autoCompact: AutoCompactView;
      };
      mockActiveAgentSession();

      await runtime.start();
      await sendAndAwaitProviderDispatch(
        runtime,
        makeMsg({ chatJid, senderJid: chatJid, content: 'hello' }),
        chatJid,
      );
      mockTokenSnapshot(250, 100);
      await emitAgentResult(150);
      await emitSuccessfulCompactResult();

      const lease = markOwnedSystemTurn(
        runtime,
        mockSession,
        chatJid,
        'manual_compact_silent',
        chatJid,
      );
      await emitTokenUsage(250);
      expect(runtime.getHealthSnapshot().details.autoCompactNextTurnOverThreshold).toBe(0);
      expect(state.autoCompact.measureNextTurn.has(chatJid)).toBe(true);

      pendingSystemResults(runtime).cancel(lease);
      await sendAndAwaitProviderDispatch(
        runtime,
        makeMsg({
          messageId: 'msg-per-chat-token-measurement',
          chatJid,
          senderJid: chatJid,
          content: 'real user turn after compact',
        }),
        chatJid,
      );
      await emitTokenUsage(250);
      expect(runtime.getHealthSnapshot().details.autoCompactNextTurnOverThreshold).toBe(1);
      await emitAgentResultWithoutTokens('done');
    } finally {
      vi.useRealTimers();
    }
  });

  it('forwards reply-guarantee instance and global MCP socket env into created sessions', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'line-a', { cwd: '/tmp/rgp-global' });

    await runtime.start();
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hello claude' }));

    expect(capturedSessionManagerOptsRef.current).toMatchObject({
      whatsoupInstance: 'line-a',
      whatsoupMcpSocket: '/tmp/rgp-global/.claude/whatsoup.sock',
    });

    await emitAgentResultWithoutTokens('done');
    await (runtime as unknown as { turnChain: Promise<void> }).turnChain;
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
      ...makeTerminalDurabilityMock(),
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
    await runtime.handleMessage(makeMsg({ content: 'hello claude', inboundSeq: 31 }));
    await vi.waitFor(() => expect(mockSession.sendTurn).toHaveBeenCalledWith('hello claude'));
    capturedOnEventRef.current?.({ type: 'result', text: 'done' });
    await (runtime as unknown as { turnChain: Promise<void> }).turnChain;

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
      // The inline-extractor SQLITE_FULL fault classifies to db_error.
      expect(durability.markInboundFailed).toHaveBeenCalledWith(42, 'db_error');
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
    // single mode: /new hits SHARED session state (this.session is one session
    // across all chats), so it now requires admin (W1-T3 RULING).
    await sendAndDrain(runtime, makeMsg({ content: '/new', senderJid: '15550100001@s.whatsapp.net' }));

    expect(mockSession.handleNew).toHaveBeenCalled();
    const enqueuedTexts = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
    expect(enqueuedTexts.some((t) => t.includes('new session'))).toBe(true);
  });

  it('rejects /new without resetting singleton state while a user turn is active', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    const state = runtime as unknown as {
      currentInboundSeq?: number;
      currentTurnChatJid: string | null;
    };
    await runtime.start();
    state.currentInboundSeq = 77;
    state.currentTurnChatJid = 'test@s.whatsapp.net';
    mockSession.handleNew.mockClear();
    mockQueue.abortTurn.mockClear();

    // Admin sender: exercises the turn-active rejection, not the admin gate
    // (single mode requires admin for /new since W1-T3's RULING).
    await sendAndDrain(runtime, makeMsg({ content: '/new', inboundSeq: 78, senderJid: '15550100001@s.whatsapp.net' }));

    expect(mockSession.handleNew).not.toHaveBeenCalled();
    expect(mockQueue.abortTurn).not.toHaveBeenCalled();
    expect(state.currentInboundSeq).toBe(77);
    expect(state.currentTurnChatJid).toBe('test@s.whatsapp.net');
    expect(mockQueue.enqueueText).toHaveBeenCalledWith(
      expect.stringContaining('still in progress'),
    );
  });

  it('rejects /new without deleting per-chat turn ownership while a user turn is active', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const state = runtime as unknown as {
      perChatInboundSeqQueue: Map<string, number[]>;
      chatSessions: Map<string, typeof mockSession>;
    };
    await runtime.start();
    state.perChatInboundSeqQueue.set('test@s.whatsapp.net', [81]);
    mockQueue.abortTurn.mockClear();

    await sendAndDrain(runtime, makeMsg({ content: '/new', inboundSeq: 82 }));

    expect(mockQueue.abortTurn).not.toHaveBeenCalled();
    expect(state.perChatInboundSeqQueue.get('test@s.whatsapp.net')).toEqual([81]);
    expect(state.chatSessions.has('test@s.whatsapp.net')).toBe(true);
    expect(mockQueue.enqueueText).toHaveBeenCalledWith(
      expect.stringContaining('still in progress'),
    );
  });

  it('rejects /new while an unsequenced synthetic per-chat turn owns the runtime queue', async () => {
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

      expect(mockQueue.abortTurn).not.toHaveBeenCalled();
      expect(mockSession.shutdown).not.toHaveBeenCalled();
      expect(mockQueue.enqueueText).toHaveBeenCalledWith(
        expect.stringContaining('still in progress'),
      );
    } finally {
      releaseSend();
      if (previousMemory === undefined) delete mutableConfig.memory;
      else mutableConfig.memory = previousMemory;
    }
    await state.perChatTurnQueues.get('test@s.whatsapp.net')?.idle();
  });

  it('rejects /new while the shared runtime queue still owns a turn after flag handoff', async () => {
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

      expect(mockQueue.abortTurn).not.toHaveBeenCalled();
      expect(mockSession.handleNew).not.toHaveBeenCalled();
      expect(mockQueue.enqueueText).toHaveBeenCalledWith(
        expect.stringContaining('still in progress'),
      );
    } finally {
      releaseSend();
    }
    await state.turnQueue.idle();
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

    // single mode: /new requires admin (W1-T3 RULING — SHARED session state).
    await sendAndDrain(runtime, makeMsg({ content: '/new', senderJid: '15550100001@s.whatsapp.net' }));

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
    await emitAgentResultWithoutTokens('done');
    mockQueue.abortTurn.mockClear();

    // single mode: /new requires admin (W1-T3 RULING — SHARED session state).
    await sendAndDrain(runtime, makeMsg({ content: '/new', senderJid: '15550100001@s.whatsapp.net' }));

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

    // single mode: /new requires admin (W1-T3 RULING — SHARED session state).
    await sendAndDrain(runtime, makeMsg({ content: '/new', senderJid: '15550100001@s.whatsapp.net' }));

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

  // ── W2a: local commands finalize their journaled inbound row ──────────────
  // A local command (/new, /status, /help, /sessions, /kill-session) never
  // dispatches an agent turn, so no downstream path completes the journaled
  // inbound row — without an explicit finalization it stays 'processing' forever
  // (unbounded growth; retention never reclaims it). Merged design: the R14
  // post-switch completion (landed via the NL-routing PR) finalizes the row as
  // complete/'local_command_handled' when no forward happens, and this PR wraps
  // the switch in try/catch so a throwing handler cannot escape to the turnChain
  // catch-all (which would falsely stamp the row failed/'error'); the completion
  // still runs after the catch. The gate's deny path returns BEFORE the switch,
  // so it finalizes its row itself (markInboundSkipped/'not_authorized', B21-A F1)
  // — no early-return path may leave a row stranded in 'processing'.
  describe('local-command inbound finalization (W2a)', () => {
    it.each(['/help', '/'])('finalizes the journaled inbound row for local help input %s', async (content) => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger);
      const duraDb = new RealDatabase(':memory:');
      duraDb.open();
      const durability = new DurabilityEngine(duraDb);
      runtime.setDurability(durability);
      await runtime.start();

      const seq = durability.journalInbound(`m-help-${content.length}`, 'k-help', 'test@s.whatsapp.net', 'agent');
      await sendAndDrain(runtime, makeMsg({ content, inboundSeq: seq }));

      const row = duraDb.raw.prepare(
        'SELECT processing_status, terminal_reason FROM inbound_events WHERE seq = ?',
      ).get(seq) as { processing_status: string; terminal_reason: string | null };
      expect(row.processing_status).toBe('complete');
      expect(row.terminal_reason).toBe('local_command_handled');

      duraDb.close();
    });

    it('admin-denied gated command finalizes the row terminally — never strands it in processing (B21-A F1)', async () => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      // Non-admin sender (admin is 15550100001 in mockConfig): /sessions is
      // denied. The deny path returns BEFORE the R14 post-switch completion, so
      // it must finalize the row ITSELF — markInboundSkipped/'not_authorized',
      // mirroring the 'empty_content' skip — otherwise the row strands in
      // 'processing' until the stuck-inbound sweep falsely reclaims it as a
      // FAILURE (stale_reclaim), counting an authz denial as a processing fault.
      const runtime = new AgentRuntime(db, messenger);
      const duraDb = new RealDatabase(':memory:');
      duraDb.open();
      const durability = new DurabilityEngine(duraDb);
      runtime.setDurability(durability);
      await runtime.start();

      const seq = durability.journalInbound('m-sessions', 'k-sessions', 'test@s.whatsapp.net', 'agent');
      await sendAndDrain(runtime, makeMsg({
        content: '/sessions',
        senderJid: '15550001111@s.whatsapp.net',
        inboundSeq: seq,
      }));

      const row = duraDb.raw.prepare(
        'SELECT processing_status, terminal_reason FROM inbound_events WHERE seq = ?',
      ).get(seq) as { processing_status: string; terminal_reason: string | null };
      expect(row.processing_status).toBe('complete'); // terminal — NOT 'processing'
      expect(row.terminal_reason).toBe('not_authorized');

      // Nothing left for the stuck-inbound sweep to reclaim as a false failure.
      duraDb.raw.prepare(`UPDATE inbound_events SET received_at = datetime('now', '-25 hours') WHERE seq = ?`).run(seq);
      expect(durability.sweepStuckInbound().failedStale).toBe(0);

      duraDb.close();
    });

    it('a throwing local-command handler does not overwrite the local_command finalization', async () => {
      const db = makeDb();
      const { messenger, sentMessages } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger);
      const duraDb = new RealDatabase(':memory:');
      duraDb.open();
      const durability = new DurabilityEngine(duraDb);
      runtime.setDurability(durability);
      await runtime.start();

      // /new's handleNew() rejects AFTER the top-of-block finalization ran. The
      // rejection must be contained inside the local-command block — if it
      // escapes to the turnChain catch-all, its unguarded markInboundFailed
      // flips the finalized row to failed/'error' (a silent second terminal
      // write that would count a command-handler fault as an inbound failure).
      mockSession.handleNew.mockRejectedValueOnce(new Error('session reset failed'));

      const seq = durability.journalInbound('m-new-throw', 'k-new-throw', 'test@s.whatsapp.net', 'agent');
      // single mode: /new requires admin (W1-T3 RULING — SHARED session state).
      await sendAndDrain(runtime, makeMsg({ content: '/new', inboundSeq: seq, senderJid: '15550100001@s.whatsapp.net' }));

      expect(mockSession.handleNew).toHaveBeenCalled();
      const row = duraDb.raw.prepare(
        'SELECT processing_status, terminal_reason FROM inbound_events WHERE seq = ?',
      ).get(seq) as { processing_status: string; terminal_reason: string | null };
      expect(row.processing_status).toBe('complete');
      expect(row.terminal_reason).toBe('local_command_handled');
      // The user still hears about the failure (local notification via the
      // outbound queue, not the generic turn-chain one).
      const enqueuedTexts = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
      expect(enqueuedTexts.some((t) => t.includes('Something went wrong processing that command'))).toBe(true);
      expect(sentMessages.length).toBe(0);

      duraDb.close();
    });
  });

  it('per_chat crash callbacks terminalize the immutable turn, preserve replay text, and notify the user', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    await runtime.start();

    const { durability } = attachRuntimeFaultMarkerSpies(runtime);

    await sendAndDrain(runtime, makeMsg({ content: 'hello', inboundSeq: 77 }));
    await vi.waitFor(() => expect(mockSession.sendTurn).toHaveBeenCalledWith('hello'));

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
      ...currentCrashIdentity(runtime, 'test@s.whatsapp.net'),
    });
    (runtime as unknown as {
      handleCrashNotify: (msg: string, chatJid?: string) => void;
    }).handleCrashNotify('Agent session ended (exited with code 1). Send any message to start a new session.', 'test@s.whatsapp.net');

    expect(mockQueue.abortTurn).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(durability.finalizeTurnTerminal).toHaveBeenCalledOnce());
    expect(durability.finalizeTurnTerminal).toHaveBeenCalledWith(expect.objectContaining({
      terminal: expect.objectContaining({
        inboundSeq: 77,
        attemptKind: 'failed',
        attemptFailureClass: 'crash',
      }),
    }));
    // Reply-guarantee breach marking: a crash landing failed_terminal with no
    // delivery durably marks the inbound as a continuity candidate.
    expect(durability.markContinuityCandidateIfNoTerminalOutbound).toHaveBeenCalledWith(
      77,
      'runtime_fault_no_terminal_outbound',
      'runtime_fault_disarm',
    );
    expect(durability.markInboundFailed).not.toHaveBeenCalled();
    expect((runtime as unknown as { perChatInboundSeqQueue: Map<string, number[]> }).perChatInboundSeqQueue.has('test@s.whatsapp.net')).toBe(false);
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

  it('single-session crash callback terminalizes through the immutable turn transaction', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    const { durability } = attachRuntimeFaultMarkerSpies(runtime);

    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: 'hello', inboundSeq: 88 }));
    await vi.waitFor(() => expect(mockSession.sendTurn).toHaveBeenCalledWith('hello'));
    expect(capturedOnCrashRef.current).toBeTypeOf('function');

    capturedOnCrashRef.current!({
      exitCode: 1,
      signal: null,
      sessionId: 'opencode-cli-456',
      dbRowId: 43,
    });

    await vi.waitFor(() => expect(durability.finalizeTurnTerminal).toHaveBeenCalledOnce());
    expect(durability.finalizeTurnTerminal).toHaveBeenCalledWith(expect.objectContaining({
      terminal: expect.objectContaining({
        inboundSeq: 88,
        attemptKind: 'failed',
        attemptFailureClass: 'crash',
      }),
    }));
    // Reply-guarantee breach marking (see per_chat variant above).
    expect(durability.markContinuityCandidateIfNoTerminalOutbound).toHaveBeenCalledWith(
      88,
      'runtime_fault_no_terminal_outbound',
      'runtime_fault_disarm',
    );
    expect(durability.markInboundFailed).not.toHaveBeenCalled();
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

      setOwnedTestSession(runtime, 'chat-a', session);
      runtimeState.chatQueues.set('chat-a', queue);

      runtimeState.handlePerChatCrash('chat-a', 'chat-a@s.whatsapp.net', {
        exitCode: 1,
        signal: null,
        sessionId: 'sess-1',
        dbRowId: 42,
        ...currentCrashIdentity(runtime, 'chat-a'),
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
        handlePerChatCrash: (
          mapKey: string,
          chatJid?: string,
          info?: { exitCode: number | null; signal: NodeJS.Signals | null; sessionId: string | null; dbRowId: number | null },
        ) => void;
      };

      setOwnedTestSession(runtime, 'chat-replaced', staleSession);
      state.chatQueues.set('chat-replaced', queue);
      state.injectMissedMessages = vi.fn(async () => true);

      state.handlePerChatCrash('chat-replaced', 'chat-replaced@s.whatsapp.net', {
        exitCode: 1,
        signal: null,
        sessionId: 'stale-sess',
        dbRowId: 42,
        ...currentCrashIdentity(runtime, 'chat-replaced'),
      });

      state.chatSessions.set('chat-replaced', replacementSession);
      await vi.advanceTimersByTimeAsync(1_500);

      expect(staleSession.spawnSession).not.toHaveBeenCalled();
      expect(staleSession.sendTurn).not.toHaveBeenCalled();
      expect(state.injectMissedMessages).not.toHaveBeenCalled();
      expect(replacementSession.getStatus).not.toHaveBeenCalled();
      expect(pendingSystemResults(runtime).count('chat-replaced')).toBe(0);
      expect(mockRuntimeLogger.info).not.toHaveBeenCalledWith(
        expect.objectContaining({ mapKey: 'chat-replaced', sessionId: 'stale-sess' }),
        'auto-respawn: attempting resume',
      );
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('auto-respawn waits for injected context to terminalize before quarantining a failed continuation', async () => {
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
            turnInFlight: true,
          }),
      };
      const state = runtime as unknown as {
        chatSessions: Map<string, typeof session>;
        chatQueues: Map<string, IOutboundQueue>;
        injectMissedMessages: ReturnType<typeof vi.fn>;
        handlePerChatCrash: (
          mapKey: string,
          chatJid?: string,
          info?: { exitCode: number | null; signal: NodeJS.Signals | null; sessionId: string | null; dbRowId: number | null },
        ) => void;
      };

      setOwnedTestSession(runtime, 'chat-auto', session);
      state.chatQueues.set('chat-auto', queue);
      let missedContextMarkedBeforeInjection = false;
      state.injectMissedMessages = vi.fn(async (_session: typeof session, _chatJid: string, _sinceUnixSec: number, onProviderBoundaryReady: () => void) => {
        missedContextMarkedBeforeInjection = pendingSystemResults(runtime).count('chat-auto') === 1;
        onProviderBoundaryReady();
        return true;
      });

      state.handlePerChatCrash('chat-auto', 'chat-auto@s.whatsapp.net', {
        exitCode: 1,
        signal: null,
        sessionId: 'sess-auto',
        dbRowId: 42,
        ...currentCrashIdentity(runtime, 'chat-auto'),
      });

      await vi.advanceTimersByTimeAsync(2_500);

      expect(state.injectMissedMessages).toHaveBeenCalledWith(
        session,
        'chat-auto@s.whatsapp.net',
        Math.floor(new Date('2026-06-10T10:00:00Z').getTime() / 1000), expect.any(Function),
      );
      expect(missedContextMarkedBeforeInjection).toBe(true);
      expect(session.sendTurn).not.toHaveBeenCalled();
      expect(pendingSystemResults(runtime).count('chat-auto')).toBe(1);

      handlePerChatProviderEvent(runtime, session, { type: 'result', text: null });
      await vi.waitFor(() => {
        expect(session.sendTurn).toHaveBeenCalledWith(
          expect.stringContaining('session resumed after crash'),
        );
      });
      expect(session.sendTurn).toHaveBeenCalledWith(
        expect.stringContaining('continue where you left off'),
      );
      await vi.waitFor(() => expect(pendingSystemResults(runtime).count('chat-auto')).toBe(0));
      expect(session.shutdown).toHaveBeenCalled();
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

  it('auto-respawn cancels its context lease when missed-message injection throws', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T10:00:00Z'));
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const mapKey = 'chat-auto-inject-error';
      const chatJid = 'chat-auto-inject-error@s.whatsapp.net';
      const queue = makeQueueMock(chatJid);
      const injectionError = new Error('missed-message lookup failed');
      const session = {
        ...mockSession,
        spawnSession: vi.fn(async () => {}),
        sendTurn: vi.fn(),
        getStatus: vi
          .fn()
          .mockReturnValueOnce({
            active: false,
            pid: null,
            sessionId: 'sess-auto-inject-error',
            startedAt: null,
            messageCount: 0,
            lastMessageAt: null,
          })
          .mockReturnValue({
            active: true,
            pid: 123,
            sessionId: 'sess-auto-inject-error',
            startedAt: new Date().toISOString(),
            messageCount: 1,
            lastMessageAt: null,
          }),
      };
      const state = runtime as unknown as {
        chatQueues: Map<string, IOutboundQueue>;
        injectMissedMessages: ReturnType<typeof vi.fn>;
        handlePerChatCrash: (
          key: string,
          deliveryJid?: string,
          info?: {
            exitCode: number | null;
            signal: NodeJS.Signals | null;
            sessionId: string | null;
            dbRowId: number | null;
          },
        ) => void;
      };

      setOwnedTestSession(runtime, mapKey, session);
      state.chatQueues.set(mapKey, queue);
      state.injectMissedMessages = vi.fn(async () => {
        expect(pendingSystemResults(runtime).count(mapKey)).toBe(1);
        throw injectionError;
      });

      state.handlePerChatCrash(mapKey, chatJid, {
        exitCode: 1,
        signal: null,
        sessionId: 'sess-auto-inject-error',
        dbRowId: 42,
        ...currentCrashIdentity(runtime, mapKey),
      });

      await vi.advanceTimersByTimeAsync(2_500);

      expect(state.injectMissedMessages).toHaveBeenCalledOnce();
      expect(session.sendTurn).not.toHaveBeenCalled();
      expect(pendingSystemResults(runtime).count(mapKey)).toBe(0);
      expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: injectionError, mapKey }),
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

      setOwnedTestSession(runtime, 'chat-a', makeSession());
      setOwnedTestSession(runtime, 'chat-b', makeSession());
      setOwnedTestSession(runtime, 'chat-c', makeSession());
      runtimeState.chatQueues.set('chat-a', makeQueueMock('chat-a@s.whatsapp.net'));
      runtimeState.chatQueues.set('chat-b', makeQueueMock('chat-b@s.whatsapp.net'));
      runtimeState.chatQueues.set('chat-c', makeQueueMock('chat-c@s.whatsapp.net'));

      mockRuntimeLogger.info.mockClear();

      runtimeState.handlePerChatCrash('chat-a', 'chat-a@s.whatsapp.net', {
        exitCode: 1,
        signal: null,
        sessionId: 'sess-a',
        dbRowId: 1,
        ...currentCrashIdentity(runtime, 'chat-a'),
      });
      runtimeState.handlePerChatCrash('chat-b', 'chat-b@s.whatsapp.net', {
        exitCode: 1,
        signal: null,
        sessionId: 'sess-b',
        dbRowId: 2,
        ...currentCrashIdentity(runtime, 'chat-b'),
      });
      runtimeState.handlePerChatCrash('chat-c', 'chat-c@s.whatsapp.net', {
        exitCode: 1,
        signal: null,
        sessionId: 'sess-c',
        dbRowId: 3,
        ...currentCrashIdentity(runtime, 'chat-c'),
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
        crashes: { record: (mapKey: string) => number };
        sessionOwnership: { get: (mapKey: string) => unknown };
        pendingRespawnTimers?: Set<ReturnType<typeof setTimeout>>;
        handlePerChatCrash: (
          mapKey: string,
          chatJid?: string,
          info?: { exitCode: number | null; signal: NodeJS.Signals | null; sessionId: string | null; dbRowId: number | null },
        ) => void;
      };

      const chatA = makeSession();
      const chatB = makeSession();
      setOwnedTestSession(runtime, 'chat-a', chatA);
      setOwnedTestSession(runtime, 'chat-b', chatB);
      runtimeState.chatQueues.set('chat-a', makeQueueMock('chat-a@s.whatsapp.net'));
      runtimeState.chatQueues.set('chat-b', makeQueueMock('chat-b@s.whatsapp.net'));

      runtimeState.crashes.record('chat-a');
      runtimeState.crashes.record('chat-a');
      runtimeState.crashes.record('chat-a');
      runtimeState.handlePerChatCrash('chat-a', 'chat-a@s.whatsapp.net', {
        exitCode: 1,
        signal: null,
        sessionId: 'sess-a',
        dbRowId: 1,
        ...currentCrashIdentity(runtime, 'chat-a'),
      });
      runtimeState.handlePerChatCrash('chat-b', 'chat-b@s.whatsapp.net', {
        exitCode: 1,
        signal: null,
        sessionId: 'sess-b',
        dbRowId: 2,
        ...currentCrashIdentity(runtime, 'chat-b'),
      });

      expect(runtimeState.pendingRespawnTimers?.size).toBe(1);
      expect(runtimeState.chatSessions.has('chat-a')).toBe(false);
      expect(runtimeState.chatQueues.has('chat-a')).toBe(false);
      expect(runtimeState.sessionOwnership.get('chat-a')).toBeUndefined();
      expect(runtimeState.chatSessions.get('chat-b')).toBe(chatB);
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('startup proactive-resume notification preserves the crashed owner and its state', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const state = runtime as unknown as PerChatCleanupRuntimeState & {
      chatSessions: Map<string, { getStatus: () => ReturnType<typeof mockSession.getStatus> }>;
      chatQueues: Map<string, IOutboundQueue>;
      durability: {
        getResumableCheckpoints: () => Array<{ conversation_key: string; session_id: string | null }>;
        getSessionCheckpoint: (key: string) => SessionCheckpointRow | null;
      } | null;
    };
    const targetKey = '15550001111@s.whatsapp.net';
    const otherKey = 'other@s.whatsapp.net';

    mockSession.spawnSession.mockImplementation(() => new Promise<void>(() => {}));
    state.durability = {
      getResumableCheckpoints: () => [{ conversation_key: '15550001111', session_id: 'resume-1' }],
      getSessionCheckpoint: () => completedCheckpoint({
        conversationKey: '15550001111',
        deliveryJid: targetKey,
        deliveryNamespace: 's.whatsapp.net',
        scope: 'per_chat',
        sessionId: 'resume-1',
        inboundSeq: 91,
        logicalTurnId: 'turn-resume-91',
        managerId: 'manager-resume',
        generation: 4,
      }),
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

    expect(state.chatSessions.has(targetKey)).toBe(true);
    expect(state.chatQueues.has(targetKey)).toBe(true);
    expect(state.perChatInboundSeqQueue.get(targetKey)).toEqual([1]);
    expect(state.perChatTurnContentType.get(targetKey)).toBe('text');
    expect(state.perChatTurnText.get(targetKey)).toBe('partial');
    expect(state.perChatAssistantItemText.get(targetKey)?.get('item-a')).toBe('value-a');
    expect(state.pendingTurnText.get(targetKey)).toBe('pending');
    expect(state.resumeFailedHandling.has(targetKey)).toBe(true);

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

  it('sandbox per_chat notification preserves the crashed workspace owner and state', async () => {
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

    expect(state.chatSessions.has(targetKey)).toBe(true);
    expect(state.chatQueues.has(targetKey)).toBe(true);
    expect(state.perChatInboundSeqQueue.get(targetKey)).toEqual([10]);
    expect(state.perChatTurnContentType.get(targetKey)).toBe('text');
    expect(state.perChatTurnText.get(targetKey)).toBe('target');
    expect(state.perChatAssistantItemText.get(targetKey)?.get('item-a')).toBe('value-a');
    expect(state.pendingTurnText.get(targetKey)).toBe('pending-target');
    expect(state.resumeFailedHandling.has(targetKey)).toBe(true);

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
        setOwnedPerChatSession: (mapKey: string, session: { getStatus: () => ReturnType<typeof mockSession.getStatus> }) => void;
      };
      const lidKey = '15550004444@lid';
      const sessionRef = {
        getStatus: () => mockSession.getStatus(),
        bindGenerationOwnership: vi.fn((_resolve: () => unknown) => {}),
      };
      const queueRef = makeQueueMock(lidKey);
      const imageTimer = fakeTimerHandle('lid-image-coalesce');
      const pollSoftTimer = fakeTimerHandle('lid-poll-soft-expiry');
      const pollHardTimer = fakeTimerHandle('lid-poll-hard-expiry');

      state.setOwnedPerChatSession(lidKey, sessionRef);
      state.chatQueues.set(lidKey, queueRef);
      state.perChatInboundSeqQueue.set(lidKey, [4, 5]);
      state.perChatTurnContentType.set(lidKey, 'text');
      state.perChatTurnText.set(lidKey, 'reply');
      state.perChatAssistantItemText.set(lidKey, new Map([['item-1', 'chunk']]));
      state.pendingTurnText.set(lidKey, 'pending');
      state.crashes.record(lidKey); state.crashes.record(lidKey);
      state.resumeFailedHandling.add(lidKey);
      // MINOR 4 (final-review): a deferred route recycle (Task G, busy-time
      // /model pin) is keyed by the SAME per-chat mapKey as the rest of this
      // migrated state — if it isn't carried over, the recycle the pin
      // promised silently never applies once the chat's canonical key flips.
      state.pendingRecycle.add(lidKey);
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
      expect(state.pendingRecycle.has(canonicalJid)).toBe(true);
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
      expect(state.pendingRecycle.has(lidKey)).toBe(false);
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

  it('keeps one coherent auto-compact lease and waiter when an in-flight LID scope is rekeyed', async () => {
    const conversationKey = '15550007777';
    const lidKey = `${conversationKey}@lid`;
    const canonicalJid = `${conversationKey}@s.whatsapp.net`;
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', {
      sessionScope: 'per_chat',
      autoCompactInputTokens: 100,
    });
    const state = runtime as unknown as {
      autoCompact: AutoCompactView;
      chatSessions: Map<string, typeof mockSession>;
      chatQueues: Map<string, IOutboundQueue>;
      maybeStartAutoCompact(session: typeof mockSession, mapKey: string): void;
      handleEventPerChat(
        sourceSession: typeof mockSession,
        event: AgentEvent,
        toolScopeKey: string,
      ): void;
    };
    const tracker = pendingSystemResults(runtime);
    mockActiveAgentSession();
    mockTokenSnapshot(250, 100);
    const toolScopeKey = setOwnedTestSession(runtime, lidKey, mockSession);
    state.chatQueues.set(lidKey, makeQueueMock(lidKey));

    try {
      state.maybeStartAutoCompact(mockSession, lidKey);
      expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');

      expect(tracker.peek(lidKey)).toMatchObject({
        purpose: 'auto_compact_silent',
        blocking: true,
      });
      expect(state.autoCompact.waiters.has(lidKey)).toBe(true);

      runtime.handleJidAliasChanged(conversationKey, canonicalJid);

      const keys = [lidKey, canonicalJid];
      const leaseKeys = keys.filter((key) => tracker.count(key) > 0);
      const waiterKeys = keys.filter((key) => state.autoCompact.waiters.has(key));
      expect.soft(leaseKeys).toHaveLength(1);
      expect.soft(waiterKeys).toEqual(leaseKeys);
      expect.soft(tracker.peek(leaseKeys[0] ?? '')).toMatchObject({
        purpose: 'auto_compact_silent',
        blocking: true,
      });

      state.handleEventPerChat(mockSession, { type: 'compact_boundary' }, toolScopeKey);
      state.handleEventPerChat(
        mockSession,
        { type: 'result', text: null, inputTokens: 10, outputTokens: 1 },
        toolScopeKey,
      );
      await Promise.resolve();

      expect.soft(tracker.blockingCount(lidKey)).toBe(0);
      expect.soft(tracker.blockingCount(canonicalJid)).toBe(0);
      expect.soft(tracker.count(lidKey)).toBe(0);
      expect.soft(tracker.count(canonicalJid)).toBe(0);
      expect.soft(state.autoCompact.waiters.has(lidKey)).toBe(false);
      expect.soft(state.autoCompact.waiters.has(canonicalJid)).toBe(false);
      expect.soft(state.chatSessions.has(lidKey)).toBe(false);
      expect.soft(state.chatSessions.get(canonicalJid)).toBe(mockSession);
    } finally {
      await runtime.shutdown();
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
      setOwnedPerChatSession: (mapKey: string, session: typeof mockSession) => void;
      handlePollVoteReceived: (data: {
        pollMessageId: string;
        chatJid: string;
        voterJid: string;
        selectedOptions: string[];
      }) => void;
    };

    await runtime.start();
    mockActiveAgentSession();
    setOwnedTestSession(runtime, lidKey, mockSession);
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
      setOwnedPerChatSession: (mapKey: string, session: typeof mockSession) => void;
    };

    await runtime.start();
    state.setOwnedPerChatSession(lidKey, mockSession);
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
    attachRuntimeFaultMarkerSpies(runtime);
    await sendAndAwaitProviderDispatch(
      runtime,
      makeMsg({
        chatJid: lidKey,
        senderJid: lidKey,
        content: 'hello',
        inboundSeq: 41,
      }),
      lidKey,
    );

    expect(capturedOnEventRef.current).toBeTypeOf('function');

    mockQueue.enqueueResultText.mockClear();
    mockRuntimeLogger.debug.mockClear();

    runtime.handleJidAliasChanged('15550004444', canonicalJid);
    expect(state.chatSessions.has(lidKey)).toBe(true);
    expect(state.chatSessions.has(canonicalJid)).toBe(false);
    capturedOnEventRef.current!({ type: 'result', text: 'remapped result' });

    await vi.waitFor(() => expect(state.chatSessions.has(canonicalJid)).toBe(true));
    expect(state.chatQueues.get(canonicalJid)).toBe(mockQueue);
    expect(mockQueue.enqueueResultText).toHaveBeenCalledWith('remapped result');
    expect(state.perChatInboundSeqQueue.has(canonicalJid)).toBe(false);
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
      chatSessions: Map<string, typeof mockSession>;
      perChatTurnText: Map<string, string>;
    };
    const lidKey = '15550004444@lid';
    const canonicalJid = '15550004444@s.whatsapp.net';

    await runtime.start();
    attachRuntimeFaultMarkerSpies(runtime);
    await sendAndAwaitProviderDispatch(
      runtime,
      makeMsg({
        chatJid: lidKey,
        senderJid: lidKey,
        content: 'hello',
        inboundSeq: 42,
      }),
      lidKey,
    );

    expect(capturedOnEventRef.current).toBeTypeOf('function');

    mockQueue.enqueueStreamingText.mockClear();
    mockQueue.enqueueResultText.mockClear();

    runtime.handleJidAliasChanged('15550004444', canonicalJid);
    expect(state.chatSessions.has(lidKey)).toBe(true);
    expect(state.chatSessions.has(canonicalJid)).toBe(false);
    capturedOnEventRef.current!({ type: 'assistant_text', text: 'Hello ' });
    capturedOnEventRef.current!({ type: 'assistant_text', text: 'world' });

    expect(state.perChatTurnText.get(lidKey)).toBe('Hello world');

    capturedOnEventRef.current!({ type: 'result', text: '!' });

    await vi.waitFor(() => expect(state.chatSessions.has(canonicalJid)).toBe(true));
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
      attachRuntimeFaultMarkerSpies(runtime);
      await sendAndDrain(runtime, makeMsg({ messageId: 'img-1', content: 'image one', contentType: 'image', inboundSeq: 10 }));
      await sendAndDrain(runtime, makeMsg({ messageId: 'txt-1', content: 'after image', contentType: 'text', inboundSeq: 11 }));

      await vi.waitFor(() => expect(mockSession.sendTurn).toHaveBeenCalledTimes(1));
      await waitForProviderDispatch(runtime, 'test@s.whatsapp.net');
      handlePerChatProviderEvent(runtime, mockSession, { type: 'result', text: null });
      await vi.waitFor(() => expect(mockSession.sendTurn).toHaveBeenCalledTimes(2));

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
      attachRuntimeFaultMarkerSpies(runtime);
      await sendAndDrain(runtime, makeMsg({ messageId: 'img-1', content: 'image one', contentType: 'image', inboundSeq: 21 }));
      await sendAndDrain(runtime, makeMsg({ messageId: 'img-2', content: 'image two', contentType: 'image', inboundSeq: 22 }));
      await sendAndDrain(runtime, makeMsg({ messageId: 'img-3', content: 'image three', contentType: 'image', inboundSeq: 23 }));

      await vi.advanceTimersByTimeAsync(3_000);

      await vi.waitFor(() => {
        expect(state.perChatInboundSeqQueue.get('test@s.whatsapp.net')).toEqual([23]);
      });
      await waitForProviderDispatch(runtime, 'test@s.whatsapp.net');
      handlePerChatProviderEvent(runtime, mockSession, { type: 'result', text: null });
      await vi.waitFor(() => {
        expect(state.perChatInboundSeqQueue.has('test@s.whatsapp.net')).toBe(false);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs a structured warn when a per_chat turn records empty-output (QR-226)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    mockSession.getDbRowId.mockReturnValue(77);

    await runtime.start();
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hello' }), 'test@s.whatsapp.net');

    // No assistant_text, no tool_use — pure empty-output terminal result.
    capturedOnEventRef.current!({ type: 'result', text: null });
    await vi.waitFor(() => expect(mockQueue.flush).toHaveBeenCalled());

    expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'empty-output',
        chatJid: 'test@s.whatsapp.net',
        mapKey: 'test@s.whatsapp.net',
        rowId: 77,
        turnHadToolWork: false,
      }),
      expect.stringContaining('empty-output'),
    );
  });

  it('does not record empty-output when suppressed no-op text intentionally satisfies the turn', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const replyGuarantee = { notifyActivity: vi.fn(), disarm: vi.fn() };
    mockSession.getDbRowId.mockReturnValue(78);

    await runtime.start();
    const { durability } = attachRuntimeFaultMarkerSpies(runtime);
    await sendAndAwaitProviderDispatch(
      runtime,
      makeMsg({ content: 'do not reply', inboundSeq: 102 }),
      'test@s.whatsapp.net',
    );
    await vi.waitFor(() => expect(mockSession.sendTurn).toHaveBeenCalledWith('do not reply'));
    (runtime as unknown as { replyGuarantee: typeof replyGuarantee }).replyGuarantee = replyGuarantee;
    mockQueue.enqueueStreamingText.mockClear();
    mockQueue.flush.mockClear();
    mockRuntimeLogger.warn.mockClear();

    handlePerChatProviderEvent(runtime, mockSession, {
      type: 'assistant_text',
      text: 'No outbound warranted — no user ask is pending. Staying silent; sending nothing to WhatsApp.',
    });
    expect(replyGuarantee.disarm).not.toHaveBeenCalled();
    handlePerChatProviderEvent(runtime, mockSession, { type: 'result', text: null });
    await vi.waitFor(() => expect(durability.finalizeTurnTerminal).toHaveBeenCalled());

    expect(mockQueue.enqueueStreamingText).not.toHaveBeenCalled();
    expect(replyGuarantee.notifyActivity).not.toHaveBeenCalled();
    expect(mockRuntimeLogger.error.mock.calls).toEqual([]);
    expect(replyGuarantee.disarm).toHaveBeenCalledWith(102);
    expect(durability.finalizeTurnTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: expect.objectContaining({
          attemptKind: 'suppressed_by_policy',
          inboundDisposition: 'finalized_no_reply_policy',
        }),
      }),
    );
    expect(mockRuntimeLogger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'empty-output' }),
      expect.stringContaining('empty-output'),
    );
  });

  it('image coalescing sends one turn for multiple images in a timer batch', async () => {
    vi.useFakeTimers();
    try {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      mockSession.getStatus.mockReturnValue({ active: true, pid: 1, sessionId: 'sess', startedAt: null, messageCount: 0, lastMessageAt: null });

      await runtime.start();
      (runtime as unknown as { durability: unknown }).durability = makeTerminalDurabilityMock();
      await sendAndDrain(runtime, makeMsg({ messageId: 'img-1', content: 'image one', contentType: 'image', inboundSeq: 31 }));
      await sendAndDrain(runtime, makeMsg({ messageId: 'img-2', content: 'image two', contentType: 'image', inboundSeq: 32 }));
      await sendAndDrain(runtime, makeMsg({ messageId: 'img-3', content: 'image three', contentType: 'image', inboundSeq: 33 }));

      await vi.advanceTimersByTimeAsync(3_000);

      await vi.waitFor(() => expect(mockSession.sendTurn).toHaveBeenCalledTimes(1));
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
      (runtime as unknown as { durability: unknown }).durability = makeTerminalDurabilityMock();
      for (let i = 1; i <= 20; i += 1) {
        await sendAndDrain(runtime, makeMsg({
          messageId: `img-${i}`,
          content: `image ${i}`,
          contentType: 'image',
          inboundSeq: 100 + i,
        }));
      }

      await vi.waitFor(() => expect(mockSession.sendTurn).toHaveBeenCalledTimes(1));
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
          getOutboundDeliverySnapshot: ReturnType<typeof vi.fn>;
          finalizeTurnTerminal: ReturnType<typeof vi.fn>;
        } | null;
      };
      const durability = {
        markInboundSkipped: vi.fn(),
        markInboundFailed: vi.fn(),
        ...makeTerminalDurabilityMock(),
      };
      mockSession.getStatus.mockReturnValue({ active: true, pid: 1, sessionId: 'sess', startedAt: null, messageCount: 0, lastMessageAt: null });
      // ETIMEDOUT-coded rejection: pins that the catch classifies the real error
      // (→ 'timeout') rather than omitting the class (→ bare call) or hardcoding.
      mockSession.sendTurn.mockRejectedValueOnce(
        Object.assign(new Error('send failed: ETIMEDOUT'), { code: 'ETIMEDOUT' }),
      );

      await runtime.start();
      state.durability = durability;
      await sendAndDrain(runtime, makeMsg({ messageId: 'img-fail-1', content: 'image one', contentType: 'image', inboundSeq: 151 }));
      await sendAndDrain(runtime, makeMsg({ messageId: 'img-fail-2', content: 'image two', contentType: 'image', inboundSeq: 152 }));

      await vi.advanceTimersByTimeAsync(3_000);

      await vi.waitFor(() => expect(mockSession.sendTurn).toHaveBeenCalledTimes(1));
      expect(durability.markInboundSkipped).toHaveBeenCalledWith(151, 'coalesced_image');
      await vi.waitFor(() => expect(durability.finalizeTurnTerminal).toHaveBeenCalledOnce());
      expect(durability.finalizeTurnTerminal).toHaveBeenCalledWith(expect.objectContaining({
        terminal: expect.objectContaining({
          inboundSeq: 152,
          attemptKind: 'failed',
          attemptFailureClass: 'processor_throw',
        }),
      }));
      expect(durability.markInboundFailed).not.toHaveBeenCalled();
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
      expect(durability.markInboundFailed, testCase.label).toHaveBeenCalledWith(321, 'session_spawn_failed');
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

  // ── B26 item 3: /status shows the model, token counts, and context budget ──
  // Owner ruling: '/status should show more than provider default — model
  // should be explicit, show the session's current token counts, session
  // limits'. Model follows the same honesty rule as /model status
  // ('(configured)' label; the served weight is unobservable). Token counts
  // come from the agent_sessions denorm columns; the context budget pairs the
  // since-last-compact quantity maybeStartAutoCompact actually compares with
  // the threshold the runtime actually applies (configured, else the 150k
  // default).

  it('B26: /status renders the configured model, token counts, and the auto-compact context budget', async () => {
    const cfg = mockConfig as unknown as Record<string, unknown>;
    cfg.agentProvider = 'claude-cli';
    try {
      const db = makeDb();
      const { messenger } = makeMessenger();
      mockActiveAgentSession(42);
      mockSession.getProviderId.mockReturnValue('claude-cli');
      mockGetSessionTokenSnapshot.mockReturnValue({
        totalInputTokens: 96_200,
        totalOutputTokens: 4_100,
        totalCacheReadTokens: 0,
        lastCompactInputTokens: 0,
        lastCompactOutputTokens: 0,
        lastCompactCacheReadTokens: 0,
      });
      const runtime = new AgentRuntime(db, messenger, 'test', { model: 'claude-opus-4-8' });
      await runtime.start();
      await runtime.handleMessage(makeMsg({ content: '/status' }));
      const text = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string)[0];
      expect(text).toContain('Model: claude-opus-4-8 (configured)');
      expect(text).toContain('Tokens: 96.2k in / 4.1k out');
      // Unconfigured threshold → the default the runtime actually applies (150k).
      expect(text).toContain('Context: 96.2k / 150k before auto-compact');
    } finally {
      delete cfg.agentProvider;
      mockGetSessionTokenSnapshot.mockReturnValue(null);
    }
  });

  it('B26: /status context budget uses the configured threshold and the since-last-compact quantity', async () => {
    const cfg = mockConfig as unknown as Record<string, unknown>;
    cfg.agentProvider = 'claude-cli';
    try {
      const db = makeDb();
      const { messenger } = makeMessenger();
      mockActiveAgentSession(42);
      mockSession.getProviderId.mockReturnValue('claude-cli');
      mockGetSessionTokenSnapshot.mockReturnValue({
        totalInputTokens: 150_000,
        totalOutputTokens: 500,
        totalCacheReadTokens: 50_000,
        lastCompactInputTokens: 40_000,
        lastCompactOutputTokens: 0,
        lastCompactCacheReadTokens: 10_000,
      });
      const runtime = new AgentRuntime(db, messenger, 'test', { model: 'claude-opus-4-8', autoCompactInputTokens: 200_000 });
      await runtime.start();
      await runtime.handleMessage(makeMsg({ content: '/status' }));
      const text = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string)[0];
      // (150k + 50k) − (40k + 10k) = 150k consumed since last compact — the
      // exact quantity the auto-compact trigger compares (runtime.ts:1273-76).
      expect(text).toContain('Context: 150k / 200k before auto-compact');
      expect(text).toContain('Tokens: 150k in / 500 out');
    } finally {
      delete cfg.agentProvider;
      mockGetSessionTokenSnapshot.mockReturnValue(null);
    }
  });

  it('B26: /status renders an honest not-configured model and omits token lines when no counts are recorded', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    mockActiveAgentSession(42);
    mockSession.getProviderId.mockReturnValue('claude-cli');
    mockGetSessionTokenSnapshot.mockReturnValue(null);
    const runtime = new AgentRuntime(db, messenger); // no model configured
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content: '/status' }));
    const text = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string)[0];
    expect(text).toContain('Model: provider default (not configured)');
    expect(text).not.toContain('Tokens:');
    expect(text).not.toContain('Context:');
  });

  it('B26: /status suppresses the context budget for a non-claude session (auto-compact cannot run there) but keeps token counts', async () => {
    const cfg = mockConfig as unknown as Record<string, unknown>;
    cfg.agentProvider = 'claude-cli';
    try {
      const db = makeDb();
      const { messenger } = makeMessenger();
      mockActiveAgentSession(42);
      mockSession.getProviderId.mockReturnValue('codex-cli');
      mockGetSessionTokenSnapshot.mockReturnValue({
        totalInputTokens: 2_000,
        totalOutputTokens: 300,
        totalCacheReadTokens: 0,
        lastCompactInputTokens: 0,
        lastCompactOutputTokens: 0,
        lastCompactCacheReadTokens: 0,
      });
      const runtime = new AgentRuntime(db, messenger, 'test', { model: 'claude-opus-4-8' });
      await runtime.start();
      await runtime.handleMessage(makeMsg({ content: '/status' }));
      const text = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string)[0];
      expect(text).toContain('Tokens: 2k in / 300 out');
      expect(text).not.toContain('before auto-compact');
    } finally {
      delete cfg.agentProvider;
      mockGetSessionTokenSnapshot.mockReturnValue(null);
      mockSession.getProviderId.mockReturnValue('claude-cli');
    }
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

  it.each(['/help', '/'])('handleMessage %s sends local help text', async (content) => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await runtime.handleMessage(makeMsg({ content }));

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
    await sendAndDrain(runtime, makeMsg({ content: 'follow-up' }));

    expect(mockSession.spawnSession).not.toHaveBeenCalled();
    expect(mockSession.sendTurn).toHaveBeenCalledWith('follow-up');
  });

  it('forwarded slash command is sent as a turn', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockSession.getStatus.mockReturnValue({ active: true, pid: 123, sessionId: 'ses_x', startedAt: new Date(Date.now() - 60_000).toISOString(), messageCount: 1, lastMessageAt: new Date(Date.now() - 10_000).toISOString() });

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await sendAndDrain(runtime, makeMsg({ content: '/compact' }));

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
    await (runtime as unknown as {
      perChatTurnQueues: Map<string, { idle: () => Promise<void> }>;
    }).perChatTurnQueues.get(groupJid)?.idle();
    await emitAgentResultWithoutTokens('ready');
    mockSession.sendTurn.mockClear();
    mockQueue.indicateTyping.mockClear();
    mockQueue.enqueueText.mockClear();
    mockQueue.enqueueResultText.mockClear();
    mockQueue.flush.mockResolvedValue(undefined);
    mockQueue.endTurn.mockClear();
    mockSession.completeProviderTurn.mockClear();

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
      expect(mockSession.completeProviderTurn).toHaveBeenCalledOnce();
    });
    expect(mockQueue.endTurn).toHaveBeenCalledOnce();
    expect(mockQueue.enqueueResultText).not.toHaveBeenCalled();

    capturedOnEventRef.current!({ type: 'compact_boundary' });
    expect(mockQueue.enqueueText).not.toHaveBeenCalled();
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
    };
    await perChatRuntime.start();
    setOwnedTestSession(perChatRuntime, groupJid, mockSession);
    mockSession.sendTurn.mockRejectedValueOnce(new Error('per-chat compact send failed'));

    await expect(perChatRuntime.handleAgentCommand({
      command: 'compact',
      chatJid: groupJid,
      silent: true,
    })).rejects.toThrow('per-chat compact send failed');

    expect(pendingSystemResults(perChatRuntime).count(groupJid)).toBe(0);
    expect(perChatState.autoCompact.silentCompactScopes.has(groupJid)).toBe(false);

    mockSession.sendTurn.mockReset();
    mockSession.sendTurn.mockRejectedValueOnce(new Error('single compact send failed'));
    mockSession.getStatus.mockReturnValue(activeStatus);
    const singleRuntime = new AgentRuntime(makeDb(), makeMessenger().messenger, 'test');
    const singleState = singleRuntime as unknown as {
      autoCompact: AutoCompactView;
      currentTurnChatJid: string | null;
      queue: typeof mockQueue | null;
      session: typeof mockSession;
      managerIdFor(session: typeof mockSession): string;
      sessionEventToolScopes: WeakMap<typeof mockSession, string>;
    };
    await singleRuntime.start();
    singleState.session = mockSession;
    singleState.managerIdFor(mockSession);
    singleState.sessionEventToolScopes.set(mockSession, '__global__');
    singleState.queue = mockQueue;

    await expect(singleRuntime.handleAgentCommand({
      command: 'compact',
      chatJid,
      silent: true,
    })).rejects.toThrow('single compact send failed');

    expect(pendingSystemResults(singleRuntime).count('__global__')).toBe(0);
    expect(singleState.autoCompact.silentCompactScopes.has('__global__')).toBe(false);
    expect(singleState.currentTurnChatJid).toBeNull();
    expect(mockSession.sendTurn).toHaveBeenLastCalledWith('/compact');
  });

  it('per_chat manual /compact terminalizes its system owner without arming the user gate', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const groupJid = '120363555555555000@g.us';
    mockSession.getStatus.mockReturnValue({ active: true, pid: 123, sessionId: 'ses_x', startedAt: new Date(Date.now() - 60_000).toISOString(), messageCount: 1, lastMessageAt: new Date(Date.now() - 10_000).toISOString() });

    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const state = runtime as unknown as {
      postTurnGate: Set<string>;
    };
    await runtime.start();
    await sendAndDrain(runtime, makeMsg({ chatJid: groupJid, isGroup: true, content: 'hello' }));
    await (runtime as unknown as {
      perChatTurnQueues: Map<string, { idle: () => Promise<void> }>;
    }).perChatTurnQueues.get(groupJid)?.idle();
    await emitAgentResultWithoutTokens('ready');
    // Isolate the system-result classification below from the completed user
    // turn's duplicate-result gate.
    state.postTurnGate.delete(groupJid);
    mockSession.sendTurn.mockClear();

    // Non-silent so isSilentCompact does not independently suppress the follow-up.
    await runtime.handleAgentCommand({ command: 'compact', chatJid: groupJid, silent: false });
    expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');
    // The manual /compact registered a pending system result for this chat.
    expect(pendingSystemResults(runtime).count(groupJid)).toBe(1);

    // Its result must not arm the user-turn gate. Once terminal, later events
    // from that request have no owner and must not leak into the queue.
    capturedOnEventRef.current!({ type: 'result', text: null });
    expect(state.postTurnGate.has(groupJid)).toBe(false);
    mockQueue.enqueueStreamingText.mockClear();
    capturedOnEventRef.current!({ type: 'assistant_text', text: 'After compact' });
    expect(mockQueue.enqueueStreamingText).not.toHaveBeenCalled();
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
    mockQueue.endTurn.mockClear();
    mockSession.completeProviderTurn.mockClear();

    const result = await runtime.handleAgentCommand({
      command: 'compact',
      silent: true,
    });

    expect(result).toEqual({ ok: true, command: 'compact', chatJid: '15550100001@s.whatsapp.net', silent: true });
    expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');

    capturedOnEventRef.current!({ type: 'compact_boundary' });
    capturedOnEventRef.current!({ type: 'result', text: 'compact complete' });
    await vi.waitFor(() => {
      expect(mockSession.completeProviderTurn).toHaveBeenCalledOnce();
    });

    expect(mockQueue.enqueueText).not.toHaveBeenCalledWith(expect.stringContaining('ompact'));
    expect(mockQueue.enqueueText).not.toHaveBeenCalledWith('_(no response)_');
    expect(mockQueue.enqueueResultText).not.toHaveBeenCalled();
    expect(mockQueue.endTurn).toHaveBeenCalledOnce();
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
    mockQueue.endTurn.mockClear();
    mockSession.completeProviderTurn.mockClear();

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
      expect(mockSession.completeProviderTurn).toHaveBeenCalledOnce();
    });

    expect(mockQueue.enqueueText).not.toHaveBeenCalledWith(expect.stringContaining('ompact'));
    expect(mockQueue.enqueueText).not.toHaveBeenCalledWith('_(no response)_');
    expect(mockQueue.enqueueResultText).not.toHaveBeenCalled();
    expect(mockQueue.endTurn).toHaveBeenCalledOnce();
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

  it('emit_heal_result fixed path notifies loops but retains control ownership until terminal result', async () => {
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
    expect(runtimeState.activeControlReportId).toBe('report-fixed');
    expect(runtimeState.controlSessionTimeout).toBe(timeout);
    expect(sentMessages).toEqual([]);
  });

  it('emit_heal_result escalates to loops and admin but does not dispatch the next report before terminal result', async () => {
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
      assertWritableCompatibility: vi.fn(),
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
    expect(runtimeState.activeControlReportId).toBe('report-escalate');
    expect(runtimeState.handleControlTurn).not.toHaveBeenCalled();
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
    await vi.waitFor(() => expect(durability.finalizeTurnTerminal).toHaveBeenCalled());
    expect(durability.finalizeTurnTerminal).toHaveBeenCalledWith(expect.objectContaining({
      terminal: expect.objectContaining({
        inboundSeq: 89,
        attemptKind: 'failed',
        attemptFailureClass: 'processor_throw',
      }),
    }));
    // Reply-guarantee breach marking: processor_throw with no delivery marks
    // the inbound as a continuity candidate.
    expect(durability.markContinuityCandidateIfNoTerminalOutbound).toHaveBeenCalledWith(
      89,
      'runtime_fault_no_terminal_outbound',
      'runtime_fault_disarm',
    );
    expect(durability.markInboundFailed).not.toHaveBeenCalled();
  });

  // ─── Event routing ─────────────────────────────────────────────────────────

  it('assistant_text event enqueues text', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    // trigger session creation
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hi' }));

    capturedOnEventRef.current!({ type: 'assistant_text', text: 'Hello there!' });

    expect(mockQueue.enqueueStreamingText).toHaveBeenCalledWith('Hello there!');
  });

  it('suppresses internal assistant_text narration before it reaches WhatsApp', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const replyGuarantee = { notifyActivity: vi.fn(), disarm: vi.fn() };

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    (runtime as unknown as { replyGuarantee: typeof replyGuarantee }).replyGuarantee = replyGuarantee;
    mockQueue.enqueueStreamingText.mockClear();

    handleEventDownstreamWithoutAdmission(
      runtime,
      { type: 'assistant_text', text: 'Now rebuild the workbook with the new trace columns.' },
      { inboundSeq: 101, conversationKey: 'test@s.whatsapp.net' },
    );

    expect(mockQueue.enqueueStreamingText).not.toHaveBeenCalled();
    expect(replyGuarantee.notifyActivity).not.toHaveBeenCalled();
    expect(replyGuarantee.disarm).not.toHaveBeenCalled();
  });

  it('suppresses no-op assistant_text without disarming before terminal result evidence', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const replyGuarantee = { notifyActivity: vi.fn(), disarm: vi.fn() };

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    (runtime as unknown as { durability: unknown }).durability = makeTerminalDurabilityMock();
    await sendAndAwaitProviderDispatch(
      runtime,
      makeMsg({ content: 'do not reply', inboundSeq: 102 }),
    );
    (runtime as unknown as { replyGuarantee: typeof replyGuarantee }).replyGuarantee = replyGuarantee;
    mockQueue.enqueueStreamingText.mockClear();

    capturedOnEventRef.current!({ type: 'assistant_text', text: '.' });

    expect(mockQueue.enqueueStreamingText).not.toHaveBeenCalled();
    expect(replyGuarantee.notifyActivity).not.toHaveBeenCalled();
    expect(replyGuarantee.disarm).not.toHaveBeenCalled();

    capturedOnEventRef.current!({ type: 'result', text: null });
    await vi.waitFor(() => expect(replyGuarantee.disarm).toHaveBeenCalledWith(102));
    await (runtime as unknown as { turnChain: Promise<void> }).turnChain;
  });

  it('suppresses provider usage-cap assistant text and logs a preview', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hi' }));

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
    await sendAndAwaitProviderDispatch(
      runtime,
      makeMsg({ content: 'my oauth broke, what do we do?' }),
    );

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
    await waitForProviderDispatch(runtime);

    const reply = 'Right — the OAuth token expired; let us reconnect the provider account and continue.';
    capturedOnEventRef.current!({ type: 'assistant_text', text: reply });

    expect(mockQueue.enqueueStreamingText).toHaveBeenCalledWith(reply);
    expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'auth-required' }),
      'delivered assistant_text despite provider-failure classification',
    );
  });

  it('does not overclaim delivery when the egress gate suppresses an ambient provider-failure chunk (#1758)', async () => {
    // The tripwire must reflect the REAL outcome, not fire before the egress
    // gate has decided. This text is ambient auth-required (delivers past the
    // QR-209 two-tier gate) AND an internal-narration opener (suppressed by
    // gateAssistantTextForOutbound) — the exact double-hit #1758 describes.
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await sendAndAwaitProviderDispatch(
      runtime,
      makeMsg({ content: 'my oauth broke, what do we do?' }),
    );

    const text = 'Let me check on this — the oauth token expired, so let me verify the account status before we proceed.';
    capturedOnEventRef.current!({ type: 'assistant_text', text });

    expect(mockQueue.enqueueStreamingText).not.toHaveBeenCalled();
    expect(mockRuntimeLogger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      'delivered assistant_text despite provider-failure classification',
    );
    expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ chatJid: 'test@s.whatsapp.net', kind: 'auth-required', outcome: 'suppressed' }),
      'suppressed assistant_text despite provider-failure classification (egress gate)',
    );
  });

  it('does not overclaim delivery on the shared handler either (#1758)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const chatJid = '15550100004@s.whatsapp.net';

    const runtime = new AgentRuntime(db, messenger, 'test', { shared: true });
    await runtime.start();
    await sendAndDrainShared(runtime, makeMsg({ chatJid, content: 'my oauth broke, what do we do?' }));
    await waitForProviderDispatch(runtime);

    const text = 'Let me check on this — the oauth token expired, so let me verify the account status before we proceed.';
    capturedOnEventRef.current!({ type: 'assistant_text', text });

    expect(mockQueue.enqueueStreamingText).not.toHaveBeenCalled();
    expect(mockRuntimeLogger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      'delivered assistant_text despite provider-failure classification',
    );
    expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'auth-required', outcome: 'suppressed' }),
      'suppressed assistant_text despite provider-failure classification (egress gate)',
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
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hi' }));

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
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hi' }));
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
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hi' }));

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
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hi' }));

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
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hi' }));

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
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hi' }));

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
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hi' }));

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
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hi' }));

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
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hi' }));

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
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hi' }));

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
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hi' }));

    // No assistant_text event — go straight to result
    capturedOnEventRef.current!({ type: 'result', text: null });
    await vi.waitFor(() => expect(mockQueue.enqueueText).toHaveBeenCalledWith('_(no response)_'));

    const calls = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
    expect(calls).toContain('_(no response)_');
    expect(mockQueue.flush).toHaveBeenCalled();
  });

  it('logs a structured warn when a single/shared turn records empty-output (QR-226)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hi' }));

    // No assistant_text event, no tool_use — pure empty-output terminal result.
    capturedOnEventRef.current!({ type: 'result', text: null });
    await vi.waitFor(() => expect(mockQueue.enqueueText).toHaveBeenCalledWith('_(no response)_'));

    expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'empty-output',
        chatJid: 'test@s.whatsapp.net',
        rowId: null,
        turnHadToolWork: false,
      }),
      expect.stringContaining('empty-output'),
    );
  });

  it('result event with text enqueues the text', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hi' }));

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
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hi' }));

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
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hi' }));

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
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hi' }));

    const raw = 'Unexpected provider explosion exposing internal-detail-xyz';
    capturedOnEventRef.current!({ type: 'result', text: raw, isError: true });

    await vi.waitFor(() =>
      expect(mockQueue.enqueueText).toHaveBeenCalledWith(expect.stringContaining('automatic recovery failed')),
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
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'follow up' }));
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
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hi' }));

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
    expect(allUserText).toContain('automatic recovery failed');
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
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hi' }));

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
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hi' }));

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
    expect(allText).toMatch(/temporary connection problem|resend/i);
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
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hi' }));

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
      await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hi' }));

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
      // QR-211 regression guard: a fallback DID activate here, so the no-fallback
      // re-auth notice (emitNoFallbackReauthNotice) must NOT also fire — only the
      // activation notice above ('will not replay it automatically') is sent.
      expect(mockQueue.enqueueText).not.toHaveBeenCalledWith(expect.stringContaining('re-authentication'));
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
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hi' }));

    const raw = 'API Error 503: Service temporarily unavailable. overloaded_error';
    capturedOnEventRef.current!({ type: 'result', text: raw, isError: true });

    await vi.waitFor(() => expect(mockQueue.enqueueText).toHaveBeenCalledWith(providerServerErrorNoFallbackNotice()));
    expect(runtime.getFallbackState().fallbackReason).toBeNull();
    expect(mockSession.shutdown).toHaveBeenCalled();
    expect(mockQueue.enqueueResultText).not.toHaveBeenCalledWith(raw);
    expect(mockEmitAlert.mock.calls.find((c) => c[1] === 'provider_unknown_terminal')).toBeUndefined();
    const turnCapability = (runtime.getHealthSnapshot().details as Record<string, any>).turnCapability;
    expect(turnCapability.lastTurnErrorClass).toBe('server-error');
  });

  // QR-211: an auth-required result that cannot arm a fallback (no fallback
  // configured, or activation failed) used to end in permanent user-visible
  // silence — the session shuts down with nothing ever forwarded to the chat.
  it('auth-required result without fallback emits a generic re-auth notice and shuts down (single path)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hi' }));

    const raw = 'Authentication required. Sign in to continue.';
    capturedOnEventRef.current!({ type: 'result', text: raw, isError: true });

    await vi.waitFor(() => expect(mockQueue.enqueueText).toHaveBeenCalledWith(expect.stringContaining('re-authentication')));
    expect(runtime.getFallbackState().fallbackReason).toBeNull();
    expect(mockSession.shutdown).toHaveBeenCalled();
    expect(mockQueue.enqueueResultText).not.toHaveBeenCalledWith(raw);
    const turnCapability = (runtime.getHealthSnapshot().details as Record<string, any>).turnCapability;
    expect(turnCapability.lastTurnErrorClass).toBe('auth-required');
  });

  // Gap 2: emitNoFallbackReauthNotice says "An operator has been notified", but
  // no ops alert fired on the no-fallback auth path — the only result-path
  // alerts are provider_transient_network / provider_unknown_terminal, and
  // fallback alerts only fire when a fallback activates. Back the claim with a
  // real alert so the copy is truthful.
  it('auth-required result without fallback fires an ops alert so the "operator notified" claim is backed (single path)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hi' }));

    mockEmitAlert.mockClear();
    const raw = 'Authentication required. Sign in to continue.';
    capturedOnEventRef.current!({ type: 'result', text: raw, isError: true });

    await vi.waitFor(() => expect(mockQueue.enqueueText).toHaveBeenCalledWith(expect.stringContaining('re-authentication')));
    // The notice's "operator has been notified" must be backed by a real alert.
    expect(mockEmitAlert.mock.calls.find((c) => c[1] === 'provider_auth_required_no_fallback')).toBeDefined();
    // Redaction: raw provider text is never forwarded to the user.
    const enqueued = mockQueue.enqueueText.mock.calls.map((a) => a[0] as string);
    expect(enqueued.some((t) => t.includes(raw))).toBe(false);
  });

  // Gap 1: a per-model-tier usage cap is NOT resolved by waiting — the misleading
  // "Please try again after the limit resets" masks the real remedy (an operator
  // must add credits or switch the model). Neither branch fires an alert, so the
  // copy must name the operator remedy as a call to action, not claim an operator
  // was already notified.
  it('usageLimitNotice names the operator remedy (add credits / switch model) instead of passive waiting (single path)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();

    type NoticeHost = { agentFallbacks: unknown[]; usageLimitNotice(): string };
    const host = runtime as unknown as NoticeHost;

    // No-fallback branch: waiting cannot clear a per-tier cap.
    host.agentFallbacks = [];
    const noFallback = host.usageLimitNotice();
    expect(noFallback).not.toMatch(/try again after the limit resets/i);
    expect(noFallback.toLowerCase()).toContain('add credits');
    expect(noFallback.toLowerCase()).toMatch(/switch my model|change my model/);

    // Fallback-configured-but-could-not-continue branch: no alert fires here
    // either, so the copy must not claim an operator was already notified.
    host.agentFallbacks = [{ provider: 'codex-cli', model: 'x' }];
    const withFallback = host.usageLimitNotice();
    expect(withFallback.toLowerCase()).toContain('add credits');
    expect(withFallback).not.toMatch(/operator has been notified/i);

    // Redaction: neither branch leaks a phone/JID or raw provider text.
    for (const msg of [noFallback, withFallback]) {
      expect(msg).not.toMatch(/@s\.whatsapp\.net|@lid|\+?\d{7,}/);
    }
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
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hi' }));

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
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hi' }));

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
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hi' }));

    capturedOnEventRef.current!({ type: 'result', text: 'a genuine terminal reply', isError: false });
    await vi.waitFor(() => expect(mockQueue.enqueueResultText).toHaveBeenCalledWith('a genuine terminal reply'));
  });

  it('model-unavailable assistant_text is suppressed from streaming (single path)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
      await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hi' }));

    capturedOnEventRef.current!({
      type: 'assistant_text',
      text: "There's an issue with the selected model (m). It may not exist or you may not have access to it.",
    });
    expect(mockQueue.enqueueStreamingText).not.toHaveBeenCalled();
  });

  it('downstream singleton post-turn gate suppresses assistant_text after result', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    // Exercise downstream gate behavior after admission has selected the queue.
    const downstreamOptions = { mapKey: '__global__', toolScopeKey: '__global__' };
    handleEventDownstreamWithoutAdmission(
      runtime,
      { type: 'assistant_text', text: 'Hello' },
      downstreamOptions,
    );
    handleEventDownstreamWithoutAdmission(runtime, { type: 'result', text: null }, downstreamOptions);
    await vi.waitFor(() => expect(mockQueue.flush).toHaveBeenCalled());

    // Reset mocks to isolate post-turn behavior
    mockQueue.enqueueStreamingText.mockClear();
    mockQueue.enqueueText.mockClear();
    mockQueue.enqueueResultText.mockClear();

    // SDK injects system-reminder, model reacts with assistant_text
    handleEventDownstreamWithoutAdmission(
      runtime,
      { type: 'assistant_text', text: 'I am still working on this.' },
      downstreamOptions,
    );

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
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hi' }));

    // Complete turn 1
    capturedOnEventRef.current!({ type: 'assistant_text', text: 'Hello' });
    capturedOnEventRef.current!({ type: 'result', text: null });
    await vi.waitFor(() => expect(mockQueue.flush).toHaveBeenCalled());

    // Send a new user message — this should clear the gate
    mockQueue.enqueueStreamingText.mockClear();
    mockQueue.flush.mockClear();
    mockSession.sendTurn.mockClear();
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'follow up' }));

    // Now assistant_text for turn 2 should go through
    capturedOnEventRef.current!({ type: 'assistant_text', text: 'Turn 2 response' });
    expect(mockQueue.enqueueStreamingText).toHaveBeenCalledWith('Turn 2 response');
  });

  it('downstream singleton post-turn gate suppresses tool_use after result', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    (runtime as unknown as { postTurnGate: Set<string> }).postTurnGate.add('__global__');

    // Reset mocks
    mockQueue.enqueueToolUpdate.mockClear();

    // SDK phantom: model tries to use a tool post-turn
    handleEventDownstreamWithoutAdmission(runtime, {
      type: 'tool_use',
      toolId: 'phantom-1',
      toolName: 'TodoWrite',
      toolInput: {},
    }, { mapKey: '__global__', toolScopeKey: '__global__' });

    // Should be suppressed
    expect(mockQueue.enqueueToolUpdate).not.toHaveBeenCalled();
    expect(mockEmitAlert).not.toHaveBeenCalled();
  });

  it('rejects every late effect after singleton terminal cleanup before runtime side effects', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    const state = runtime as unknown as {
      currentRuntimeTurnContext: unknown | null;
      unownedProviderEventRejects: number;
      rejectedTerminalTeardowns: WeakMap<typeof mockSession, Promise<boolean>>;
    };
    await runtime.start();
    await sendAndDrain(runtime, makeMsg({ content: 'hi' }));

    capturedOnEventRef.current!({ type: 'assistant_text', text: 'Hello' });
    capturedOnEventRef.current!({ type: 'result', text: null });
    await vi.waitFor(() => expect(mockQueue.flush).toHaveBeenCalled());
    await vi.waitFor(() => expect(state.currentRuntimeTurnContext).toBeNull());

    mockSession.getDbRowId.mockReturnValue(77);
    mockQueue.enqueueStreamingText.mockClear();
    mockQueue.enqueueText.mockClear();
    mockQueue.enqueueResultText.mockClear();
    mockQueue.enqueueToolUpdate.mockClear();
    mockQueue.indicateTyping.mockClear();
    mockQueue.endTurn.mockClear();
    mockQueue.flush.mockClear();
    mockAccumulateTokensWithEvent.mockClear();
    mockEmitAlert.mockClear();
    mockSession.shutdown.mockClear();

    const lateEvents: AgentEvent[] = [
      { type: 'assistant_text', text: 'late private text' },
      { type: 'tool_result', isError: true, toolId: 'late-tool', content: 'late private error' },
      { type: 'compact_boundary' },
      { type: 'token_usage', inputTokens: 900, outputTokens: 1 },
      { type: 'result', text: 'late terminal text' },
    ];
    for (const event of lateEvents) capturedOnEventRef.current!(event);

    expect(state.unownedProviderEventRejects).toBe(lateEvents.length);
    expect(mockQueue.enqueueStreamingText).not.toHaveBeenCalled();
    expect(mockQueue.enqueueText).not.toHaveBeenCalled();
    expect(mockQueue.enqueueResultText).not.toHaveBeenCalled();
    expect(mockQueue.enqueueToolUpdate).not.toHaveBeenCalled();
    expect(mockQueue.indicateTyping).not.toHaveBeenCalled();
    expect(mockQueue.endTurn).not.toHaveBeenCalled();
    expect(mockQueue.flush).not.toHaveBeenCalled();
    expect(mockAccumulateTokensWithEvent).not.toHaveBeenCalled();
    expect(mockEmitAlert).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(mockSession.shutdown).toHaveBeenCalledOnce());
    expect(mockSession.shutdown).toHaveBeenCalledWith(false);
    await vi.waitFor(() => expect(state.rejectedTerminalTeardowns.has(mockSession)).toBe(false));

    capturedOnEventRef.current!({ type: 'result', text: 'late terminal from a later lifecycle' });
    await vi.waitFor(() => expect(mockSession.shutdown).toHaveBeenCalledTimes(2));
    expect(state.unownedProviderEventRejects).toBe(lateEvents.length + 1);
  });

  it('retains a failed rejected-terminal quarantine and blocks automatic redispatch', async () => {
    const runtime = new AgentRuntime(makeDb(), makeMessenger().messenger);
    const state = runtime as unknown as {
      rejectedTerminalTeardowns: WeakMap<typeof mockSession, Promise<boolean>>;
    };
    await runtime.start();
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'first' }));
    capturedOnEventRef.current?.({ type: 'result', text: 'first complete' });
    await vi.waitFor(() => expect(mockSession.completeProviderTurn).toHaveBeenCalled());

    const teardownError = new Error('process tree still alive');
    mockSession.shutdown.mockRejectedValueOnce(teardownError);
    mockSession.sendTurn.mockClear();
    capturedOnEventRef.current?.({ type: 'result', text: 'late terminal' });
    await vi.waitFor(() => expect(state.rejectedTerminalTeardowns.has(mockSession)).toBe(true));
    await vi.waitFor(() => {
      expect(mockRuntimeLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: teardownError }),
        'rejected terminal source teardown failed — provider lane remains closed',
      );
    });

    await sendAndDrain(runtime, makeMsg({ messageId: 'blocked-after-terminal', content: 'second' }));

    expect(mockSession.sendTurn).not.toHaveBeenCalled();
    expect(state.rejectedTerminalTeardowns.has(mockSession)).toBe(true);
    expect(mockRuntimeLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({
          message: 'REJECTED_TERMINAL_QUARANTINE_FAILED: exact provider source was not proven closed',
        }),
      }),
      'unhandled error in message processing',
    );
  });

  it('keeps /new fail-closed when rejected-terminal teardown was not proven', async () => {
    const runtime = new AgentRuntime(makeDb(), makeMessenger().messenger);
    const state = runtime as unknown as {
      rejectedTerminalTeardowns: WeakMap<typeof mockSession, Promise<boolean>>;
    };
    await runtime.start();
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'first' }));
    capturedOnEventRef.current?.({ type: 'result', text: 'first complete' });
    await vi.waitFor(() => expect(mockSession.completeProviderTurn).toHaveBeenCalled());

    mockSession.shutdown.mockRejectedValueOnce(new Error('process tree still alive'));
    capturedOnEventRef.current?.({ type: 'result', text: 'late terminal' });
    await vi.waitFor(() => expect(state.rejectedTerminalTeardowns.has(mockSession)).toBe(true));

    mockSession.handleNew.mockClear();
    // single mode: /new requires admin (W1-T3 RULING — SHARED session state).
    await sendAndDrain(runtime, makeMsg({ messageId: 'blocked-new', content: '/new', senderJid: '15550100001@s.whatsapp.net' }));

    expect(mockSession.handleNew).not.toHaveBeenCalled();
    expect(state.rejectedTerminalTeardowns.has(mockSession)).toBe(true);
    expect(mockRuntimeLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'new',
        err: expect.objectContaining({
          message: 'REJECTED_TERMINAL_QUARANTINE_FAILED: exact provider source was not proven closed',
        }),
      }),
      'local command handler failed',
    );
  });

  it('keeps per-chat /new fail-closed when rejected-terminal teardown was not proven', async () => {
    const chatJid = '15550100001@s.whatsapp.net';
    const runtime = new AgentRuntime(
      makeDb(),
      makeMessenger().messenger,
      'test',
      { sessionScope: 'per_chat' },
    );
    const state = runtime as unknown as {
      rejectedTerminalTeardowns: WeakMap<typeof mockSession, Promise<boolean>>;
      perChatRuntimeTurnContexts: Map<string, unknown[]>;
    };
    await runtime.start();
    await sendAndAwaitProviderDispatch(
      runtime,
      makeMsg({
        messageId: 'per-chat-before-quarantine',
        chatJid,
        senderJid: chatJid,
        content: 'first',
      }),
      chatJid,
    );
    capturedOnEventRef.current?.({ type: 'result', text: 'first complete' });
    await vi.waitFor(() => expect(state.perChatRuntimeTurnContexts.has(chatJid)).toBe(false));

    mockSession.shutdown.mockRejectedValueOnce(new Error('process tree still alive'));
    capturedOnEventRef.current?.({ type: 'result', text: 'late terminal' });
    await vi.waitFor(() => expect(state.rejectedTerminalTeardowns.has(mockSession)).toBe(true));

    mockSession.shutdown.mockClear();
    mockSession.spawnSession.mockClear();
    await sendAndDrain(runtime, makeMsg({
      messageId: 'blocked-per-chat-new',
      chatJid,
      senderJid: chatJid,
      content: '/new',
    }));

    expect(mockSession.shutdown).not.toHaveBeenCalled();
    expect(mockSession.spawnSession).not.toHaveBeenCalled();
    expect(state.rejectedTerminalTeardowns.has(mockSession)).toBe(true);
  });

  it('rejects the exact logical completion when rejected-terminal finalization escapes', async () => {
    const chatJid = 'rejected-finalization@s.whatsapp.net';
    const runtime = new AgentRuntime(
      makeDb(),
      makeMessenger().messenger,
      'test',
      { sessionScope: 'per_chat' },
    );
    const state = runtime as unknown as {
      perChatRuntimeTurnCompletions: Map<string, { promise: Promise<void> }>;
      sessionEventToolScopes: WeakMap<typeof mockSession, string>;
      rejectedTerminalTeardowns: WeakMap<typeof mockSession, Promise<boolean>>;
    };
    await runtime.start();
    attachRuntimeFaultMarkerSpies(runtime);
    await sendAndAwaitProviderDispatch(
      runtime,
      makeMsg({
        messageId: 'rejected-finalization-source',
        chatJid,
        senderJid: chatJid,
        content: 'source turn',
        inboundSeq: 1811,
      }),
      chatJid,
    );
    const completion = state.perChatRuntimeTurnCompletions.get(chatJid);
    expect(completion).toBeDefined();
    let completionError: unknown;
    void completion!.promise.catch((err: unknown) => {
      completionError = err;
    });
    const finalizationError = new Error('rejected terminal evidence flush failed');
    mockQueue.abortTurn.mockImplementationOnce(() => {
      throw finalizationError;
    });
    state.sessionEventToolScopes.set(mockSession, 'superseded-tool-scope');

    capturedOnEventRef.current!({ type: 'result', text: 'unattributable terminal' });

    await vi.waitFor(() => expect(completionError).toBe(finalizationError));
    expect(state.rejectedTerminalTeardowns.has(mockSession)).toBe(true);
  });

  it('rejects the active logical completion when exact source teardown is unproved', async () => {
    const chatJid = 'active-teardown-failure@s.whatsapp.net';
    const runtime = new AgentRuntime(
      makeDb(),
      makeMessenger().messenger,
      'test',
      { sessionScope: 'per_chat' },
    );
    const state = runtime as unknown as {
      perChatRuntimeTurnCompletions: Map<string, { promise: Promise<void> }>;
      rejectedTerminalTeardowns: WeakMap<typeof mockSession, Promise<boolean>>;
    };
    await runtime.start();
    attachRuntimeFaultMarkerSpies(runtime);
    await sendAndAwaitProviderDispatch(
      runtime,
      makeMsg({
        messageId: 'active-teardown-source',
        chatJid,
        senderJid: chatJid,
        content: 'source turn',
        inboundSeq: 1813,
      }),
      chatJid,
    );
    const completion = state.perChatRuntimeTurnCompletions.get(chatJid);
    expect(completion).toBeDefined();
    const teardownError = new Error('lifecycle persistence failed after reap');
    let completionError: unknown;
    void completion!.promise.catch((err: unknown) => {
      completionError = err;
    });
    mockSession.shutdown.mockRejectedValueOnce(teardownError);

    capturedOnEventRef.current!({ type: 'parse_error', line: 'malformed active record' });

    await vi.waitFor(() => expect(completionError).toBe(teardownError));
    expect(state.rejectedTerminalTeardowns.has(mockSession)).toBe(true);
    mockSession.sendTurn.mockClear();
    await sendAndDrain(runtime, makeMsg({
      messageId: 'blocked-after-active-teardown',
      chatJid,
      senderJid: chatJid,
      content: 'must remain quarantined',
      inboundSeq: 1814,
    }));
    expect(mockSession.sendTurn).not.toHaveBeenCalled();
  });

  it('quarantines an owned malformed provider record without waiting for the watchdog', async () => {
    const chatJid = 'malformed-stream@s.whatsapp.net';
    const runtime = new AgentRuntime(
      makeDb(),
      makeMessenger().messenger,
      'test',
      { sessionScope: 'per_chat' },
    );
    const { durability } = attachRuntimeFaultMarkerSpies(runtime);
    await runtime.start();
    await sendAndAwaitProviderDispatch(
      runtime,
      makeMsg({
        messageId: 'malformed-stream-source',
        chatJid,
        senderJid: chatJid,
        content: 'source turn',
        inboundSeq: 1812,
      }),
      chatJid,
    );
    mockSession.shutdown.mockClear();

    capturedOnEventRef.current!({ type: 'parse_error', line: 'private malformed record' });

    await vi.waitFor(() => expect(mockSession.shutdown).toHaveBeenCalledWith(false));
    await vi.waitFor(() => expect(durability.finalizeTurnTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: expect.objectContaining({
          inboundSeq: 1812,
          attemptKind: 'failed',
          attemptFailureClass: 'provider_stream_corrupt',
        }),
      }),
    ));
    expect(mockQueue.enqueueText).not.toHaveBeenCalledWith('private malformed record');
  });

  it('cancels only the rejected source system lease after exact teardown proof', async () => {
    const chatJid = 'rejected-system@s.whatsapp.net';
    const runtime = new AgentRuntime(
      makeDb(),
      makeMessenger().messenger,
      'test',
      { sessionScope: 'per_chat' },
    );
    const state = runtime as unknown as {
      chatQueues: Map<string, IOutboundQueue>;
      sessionEventToolScopes: WeakMap<typeof mockSession, string>;
      handleEventPerChat(
        sourceSession: typeof mockSession,
        event: AgentEvent,
        toolScopeKey: string,
      ): void;
    };
    await runtime.start();
    const originalToolScope = setOwnedTestSession(runtime, chatJid, mockSession);
    state.chatQueues.set(chatJid, mockQueue);
    const lease = markOwnedSystemTurn(
      runtime,
      mockSession,
      chatJid,
      'fresh_session_context',
      chatJid,
    );
    const siblingLease = markOwnedSystemTurn(
      runtime,
      mockSession,
      chatJid,
      'poll_answer_continuation',
      chatJid,
    );
    let proveTeardown!: () => void;
    mockSession.shutdown.mockImplementationOnce(() => new Promise<void>((resolve) => {
      proveTeardown = resolve;
    }));
    state.sessionEventToolScopes.set(mockSession, 'superseded-tool-scope');

    state.handleEventPerChat(
      mockSession,
      { type: 'result', text: 'unattributable system terminal' },
      originalToolScope,
    );

    expect(pendingSystemResults(runtime).peek(chatJid)?.lease).toEqual(lease);
    proveTeardown();
    await vi.waitFor(() => expect(pendingSystemResults(runtime).count(chatJid)).toBe(1));
    expect(pendingSystemResults(runtime).peek(chatJid)?.lease).toEqual(siblingLease);
    expect(mockSession.completeProviderTurn).not.toHaveBeenCalled();
  });

  it('rejects a replaced per-chat source even when the replacement owns a live context', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const mapKey = 'source-bound@s.whatsapp.net';
    const queue = makeQueueMock(mapKey);
    const makeOwnedSession = () => ({
      ...mockSession,
      getStatus: vi.fn(() => ({
        active: false,
        pid: null,
        sessionId: null,
        startedAt: null,
        messageCount: 0,
        lastMessageAt: null,
      })),
      shutdown: vi.fn(async () => {}),
      bindGenerationOwnership: vi.fn(),
    });
    const sourceA = makeOwnedSession();
    const sourceB = makeOwnedSession();
    const state = runtime as unknown as {
      setOwnedPerChatSession(mapKey: string, session: typeof sourceA): void;
      managerIdFor(session: typeof sourceA): string;
      sessionOwnership: {
        get(mapKey: string): { managerId: string; generation: number } | undefined;
      };
      chatQueues: Map<string, IOutboundQueue>;
      perChatRuntimeTurnContexts: Map<string, ReturnType<typeof createRuntimeTurnContext>[]>;
      sessionEventToolScopes: WeakMap<typeof sourceA, string>;
      handleEventPerChat(
        sourceSession: typeof sourceA,
        event: AgentEvent,
        toolScopeKey: string,
      ): void;
      unownedProviderEventRejects: number;
    };

    state.setOwnedPerChatSession(mapKey, sourceA);
    state.setOwnedPerChatSession(mapKey, sourceB);
    state.chatQueues.set(mapKey, queue);
    const ownerB = state.sessionOwnership.get(mapKey)!;
    const context = createRuntimeTurnContext({
      identity: {
        scope: 'per_chat',
        conversationKey: 'source-bound',
        deliveryJid: mapKey,
        inboundSeq: 1,
        logicalTurnId: 'turn-source-b',
        managerId: state.managerIdFor(sourceB),
        generation: ownerB.generation,
      },
      recoveryOwner: {
        logicalTurnId: 'turn-source-b:recovery',
        managerId: state.managerIdFor(sourceB),
        generation: ownerB.generation,
      },
      replay: {
        sourceMessageId: 'wamid-source-b',
        replaySafe: true,
        senderJid: mapKey,
        senderName: null,
        text: 'current turn',
        isGroup: false,
      },
      contentType: 'text',
      toolScopeKey: 'source-bound#tool',
    });
    state.perChatRuntimeTurnContexts.set(mapKey, [context]);
    state.sessionEventToolScopes.set(sourceA, 'source-bound#tool');
    state.sessionEventToolScopes.set(sourceB, 'source-bound#tool');

    state.handleEventPerChat(
      sourceA,
      { type: 'assistant_text', text: 'stale source output' },
      'source-bound#tool',
    );
    expect(queue.enqueueStreamingText).not.toHaveBeenCalled();
    expect(state.unownedProviderEventRejects).toBe(1);

    state.handleEventPerChat(
      sourceA,
      { type: 'result', text: 'stale source terminal' },
      'source-bound#tool',
    );
    expect(sourceA.shutdown).toHaveBeenCalledOnce();
    expect(sourceA.shutdown).toHaveBeenCalledWith(false);
    expect(sourceB.shutdown).not.toHaveBeenCalled();

    state.handleEventPerChat(
      sourceB,
      { type: 'assistant_text', text: 'current source output' },
      'source-bound#tool',
    );
    expect(queue.enqueueStreamingText).toHaveBeenCalledWith('current source output');
  });

  it('reconstructs a missing per-chat output route before terminalizing its exact owner', async () => {
    const chatJid = 'route-recovery@s.whatsapp.net';
    const runtime = new AgentRuntime(
      makeDb(),
      makeMessenger().messenger,
      'test',
      { sessionScope: 'per_chat' },
    );
    const state = runtime as unknown as {
      chatQueues: Map<string, IOutboundQueue>;
      unownedProviderEventRejects: number;
    };

    await runtime.start();
    await sendAndAwaitProviderDispatch(
      runtime,
      makeMsg({ chatJid, senderJid: chatJid, content: 'recover my terminal route' }),
      chatJid,
    );
    state.chatQueues.delete(chatJid);
    mockSession.completeProviderTurn.mockClear();
    mockSession.shutdown.mockClear();

    capturedOnEventRef.current?.({ type: 'result', text: 'done' });

    await vi.waitFor(() => expect(mockSession.completeProviderTurn).toHaveBeenCalledOnce());
    expect(state.chatQueues.has(chatJid)).toBe(true);
    expect(state.unownedProviderEventRejects).toBe(0);
    expect(mockSession.shutdown).not.toHaveBeenCalled();
  });

  it('reconstructs a missing singleton output route before terminalizing its exact owner', async () => {
    const chatJid = 'singleton-route-recovery@s.whatsapp.net';
    const runtime = new AgentRuntime(makeDb(), makeMessenger().messenger);
    const state = runtime as unknown as {
      queue: IOutboundQueue | null;
      unownedProviderEventRejects: number;
    };

    await runtime.start();
    await sendAndAwaitProviderDispatch(
      runtime,
      makeMsg({ chatJid, senderJid: chatJid, content: 'recover singleton terminal route' }),
    );
    state.queue = null;
    mockSession.completeProviderTurn.mockClear();
    mockSession.shutdown.mockClear();

    capturedOnEventRef.current?.({ type: 'result', text: 'done' });

    await vi.waitFor(() => expect(mockSession.completeProviderTurn).toHaveBeenCalledOnce());
    expect(state.queue).toBe(mockQueue);
    expect(state.unownedProviderEventRejects).toBe(0);
    expect(mockSession.shutdown).not.toHaveBeenCalled();
  });

  it('keeps dispatch closed until a rejected journaled terminal is reaped and finalized', async () => {
    mockSession.getStatus.mockReturnValue({
      active: true,
      pid: 123,
      sessionId: 'rejected-terminal-owner',
      startedAt: new Date().toISOString(),
      messageCount: 1,
      lastMessageAt: null,
    });
    let proveTeardown!: () => void;
    mockSession.shutdown.mockImplementationOnce(() => new Promise<void>((resolve) => {
      proveTeardown = resolve;
    }));

    const runtime = new AgentRuntime(makeDb(), makeMessenger().messenger, 'test', { shared: true });
    const { durability } = attachRuntimeFaultMarkerSpies(runtime);
    const state = runtime as unknown as {
      sessionEventToolScopes: WeakMap<typeof mockSession, string>;
      turnQueue: { idle(): Promise<void> };
    };
    await runtime.start();

    await sendAndAwaitProviderDispatch(runtime, makeMsg({
      messageId: 'rejected-terminal-1',
      inboundSeq: 801,
      chatJid: 'rejected-a@g.us',
      senderJid: '801@s.whatsapp.net',
      content: 'first',
      isGroup: true,
    }));
    await runtime.handleMessage(makeMsg({
      messageId: 'rejected-terminal-2',
      inboundSeq: 802,
      chatJid: 'rejected-b@g.us',
      senderJid: '802@s.whatsapp.net',
      content: 'second',
      isGroup: true,
    }));
    await (runtime as unknown as { turnChain: Promise<void> }).turnChain;
    expect(mockSession.sendTurn).toHaveBeenCalledTimes(1);

    state.sessionEventToolScopes.set(mockSession, 'corrupt-source-scope');
    capturedOnEventRef.current?.({ type: 'result', text: 'unattributable terminal' });
    await Promise.resolve();
    expect(mockSession.shutdown).toHaveBeenCalledOnce();
    expect(mockSession.sendTurn).toHaveBeenCalledTimes(1);

    proveTeardown();
    await vi.waitFor(() => {
      expect(durability.finalizeTurnTerminal).toHaveBeenCalledWith(expect.objectContaining({
        terminal: expect.objectContaining({
          inboundSeq: 801,
          attemptKind: 'failed',
          attemptFailureClass: 'provider_stream_corrupt',
        }),
      }));
    });
    await vi.waitFor(() => expect(mockSession.sendTurn).toHaveBeenCalledTimes(2));

    state.sessionEventToolScopes.set(mockSession, '__global__');
    capturedOnEventRef.current?.({ type: 'result', text: 'second complete' });
    await state.turnQueue.idle();
  });

  it('per_chat: system-turn result does not arm the post-turn gate (real reply still delivered)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const state = runtime as unknown as { postTurnGate: Set<string> };
    const chatJid = '15550001111@s.whatsapp.net';

    await runtime.start();
    await sendAndAwaitProviderDispatch(
      runtime,
      makeMsg({ chatJid, senderJid: chatJid, content: 'hello' }),
      chatJid,
    );
    expect(capturedOnEventRef.current).toBeTypeOf('function');

    // A system turn is in flight (context injection on respawn, resume
    // continuation, or auto-compact /compact). Its result must NOT arm the
    // post-turn gate, otherwise the real user turn that follows is suppressed.
    markOwnedSystemTurn(runtime, mockSession, chatJid, 'manual_compact_silent', chatJid);
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
    await sendAndAwaitProviderDispatch(
      runtime,
      makeMsg({ chatJid, senderJid: chatJid, content: 'hello' }),
      chatJid,
    );
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
    const state = runtime as unknown as { postTurnGate: Set<string> };

    await runtime.start();
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hi' }));

    // A system turn is in flight (single-mode auto-compact /compact is keyed by
    // the global scope). Its result must NOT arm the post-turn gate.
    markOwnedSystemTurn(
      runtime,
      mockSession,
      '__global__',
      'manual_compact_silent',
      'test@s.whatsapp.net',
    );
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
    expect(pendingSystemResults(runtime).count(chatJid)).toBe(0);
  });

  // QR-095 successor (P4): fresh-spawn context is merged into the user turn at
  // the provider boundary — no fresh_session_context system turn exists, so the
  // phantom-reply channel QR-095 guarded (a context result mis-classified as a
  // USER turn) is gone by construction, and the effect-blocked context turn can
  // no longer burn its deadline and quarantine the session under the queued
  // user turn (production drops 2026-07-17, inbound seqs 49207/49219).
  it('single/shared: fresh-spawn context merges into the user turn — no system turn (QR-095 successor)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger); // single/shared (no sessionScope)
    const chatJid = '15550005555@s.whatsapp.net';
    const state = runtime as unknown as {
      pendingSystemResults: PendingSystemResultTrackerView;
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
    await runtime.handleMessage(makeMsg({ chatJid, senderJid: chatJid, content: 'hello' }));
    await vi.waitFor(() => expect(mockSession.sendTurn).toHaveBeenCalled());

    // No fresh_session_context system turn exists on this path anymore.
    expect(markSpy.mock.calls.map((call) => call[0])).not.toContainEqual(
      expect.objectContaining({ purpose: 'fresh_session_context' }),
    );
    // The single provider send carries the context preamble plus the user text.
    expect(mockSession.sendTurn).toHaveBeenCalledTimes(1);
    const sent = (vi.mocked(mockSession.sendTurn).mock.calls[0] as unknown as [string])[0];
    expect(sent).toMatch(/^\[Recent chat context — read before responding\]\n/);
    expect(sent).toContain('earlier message');
    expect(sent).toMatch(/\n\n\[Current message\]\nhello$/);

    // Complete the (single) user turn so the queued test work does not outlive
    // this test.
    capturedOnEventRef.current!({ type: 'result', text: null });
    await (runtime as unknown as { turnChain: Promise<void> }).turnChain;
  });

  it('downstream shared-session post-turn gate suppresses assistant_text after result', () => {
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
    };
    const sourceSession = Object.assign({}, mockSession, {
      getDbRowId: vi.fn(() => null),
      clearTurnWatchdog: vi.fn(),
      completeProviderTurn: vi.fn(),
    });
    state.session = sourceSession;
    state.activeChatJid = '111@s.whatsapp.net';
    state.currentTurnChatJid = '111@s.whatsapp.net';
    state.turnHadVisibleOutput = true;
    state.outboundQueues.set('111@s.whatsapp.net', queue);

    // Simulate a turn with text + result
    handleEventDownstreamWithoutAdmission(runtime, { type: 'assistant_text', text: 'Hello' }, {
      queue,
      session: sourceSession,
      mapKey: '__global__',
      toolScopeKey: '__global__',
    });
    handleEventDownstreamWithoutAdmission(runtime, { type: 'result', text: null }, {
      queue,
      session: sourceSession,
      mapKey: '__global__',
      toolScopeKey: '__global__',
    });

    // Reset mocks to isolate post-turn behavior
    (queue.enqueueStreamingText as ReturnType<typeof vi.fn>).mockClear();
    (queue.enqueueText as ReturnType<typeof vi.fn>).mockClear();

    // Phantom assistant_text after result — should be suppressed by gate
    handleEventDownstreamWithoutAdmission(
      runtime,
      { type: 'assistant_text', text: 'Phantom from SDK reminder' },
      {
        queue,
        session: sourceSession,
        mapKey: '__global__',
        toolScopeKey: '__global__',
      },
    );

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
      handleEvent: (sourceSession: object, event: AgentEvent) => void;
    };
    const sourceSession = Object.assign({}, mockSession, {
      tickWatchdog: vi.fn(),
      trackToolStart: vi.fn(),
      trackToolEnd: vi.fn(),
    });
    state.session = sourceSession;
    state.operationTracker = tracker;
    state.activeChatJid = '111@s.whatsapp.net';
    state.currentTurnChatJid = '111@s.whatsapp.net';
    state.outboundQueues.set('111@s.whatsapp.net', queue);
    publishSingletonTestOwner(runtime, sourceSession, '111@s.whatsapp.net');

    state.handleEvent(sourceSession, { type: 'init', sessionId: 'shared-session-id' });
    expect(mockRuntimeLogger.debug).toHaveBeenCalledWith(
      { chatJid: '111@s.whatsapp.net', sessionId: 'shared-session-id' },
      'session init',
    );

    state.handleEvent(sourceSession, {
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

    state.handleEvent(sourceSession, { type: 'compact_boundary' });
    expect(queue.indicateTyping).toHaveBeenCalledTimes(1);
    expect(queue.enqueueText).toHaveBeenCalledWith(expect.stringContaining('Context compacted'));
    expect(tracker.onAnyActivity).toHaveBeenCalled();

    state.handleEvent(sourceSession, {
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
    state.handleEvent(sourceSession, {
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

  it('singleton crash callback terminalizes the active turn and keeps heal-report failures contained', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    mockConfig.controlPeers.set('q', '15550100004');
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'single' });
    const durability = {
      markInboundFailed: vi.fn(),
      ...makeTerminalDurabilityMock(),
    };
    const replyGuarantee = {
      disarm: vi.fn(),
      isArmed: vi.fn(() => false),
    };
    const state = runtime as unknown as {
      currentInboundSeq: number | undefined;
      currentRuntimeTurnContext: ReturnType<typeof makeRuntimeTurnContext> | null;
      durability: typeof durability;
      replyGuarantee: typeof replyGuarantee;
      ensureSessionAndQueueSync(chatJid: string): void;
    };
    state.durability = durability;
    state.replyGuarantee = replyGuarantee;
    state.currentInboundSeq = 77;
    state.currentRuntimeTurnContext = makeRuntimeTurnContext(
      'singleton', 'crash-single', 'crash-single@s.whatsapp.net', 77, 'turn-single-crash',
    );

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

    await vi.waitFor(() => expect(durability.finalizeTurnTerminal).toHaveBeenCalledOnce());
    expect(replyGuarantee.disarm).toHaveBeenCalledWith(77);
    expect(durability.markInboundFailed).not.toHaveBeenCalled();
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

  it('singleton crash callback still attempts a heal report when no control peer is configured at all (#1754)', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    mockConfig.controlPeers.clear(); // no control peer configured — not a partial map, none at all
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'single' });
    const durability = {
      markInboundFailed: vi.fn(),
      ...makeTerminalDurabilityMock(),
    };
    const replyGuarantee = {
      disarm: vi.fn(),
      isArmed: vi.fn(() => false),
    };
    const state = runtime as unknown as {
      currentInboundSeq: number | undefined;
      currentRuntimeTurnContext: ReturnType<typeof makeRuntimeTurnContext> | null;
      durability: typeof durability;
      replyGuarantee: typeof replyGuarantee;
      ensureSessionAndQueueSync(chatJid: string): void;
    };
    state.durability = durability;
    state.replyGuarantee = replyGuarantee;
    state.currentInboundSeq = 99;
    state.currentRuntimeTurnContext = makeRuntimeTurnContext(
      'singleton', 'crash-no-peer', 'crash-no-peer@s.whatsapp.net', 99, 'turn-no-peer-crash',
    );

    state.ensureSessionAndQueueSync('crash-no-peer@s.whatsapp.net');
    mockRuntimeLogger.warn.mockClear();
    capturedOnCrashRef.current?.({
      exitCode: 1,
      signal: null,
      sessionId: 'session-crash-no-peer',
      dbRowId: 14,
      provider: 'claude-cli',
      crashClass: 'boom',
      stderrPreview: 'stack trace',
    });

    await vi.waitFor(() => expect(durability.finalizeTurnTerminal).toHaveBeenCalledOnce());
    // A crash must ALWAYS attempt to report — telemetry delivery is guaranteed-or-alerted,
    // never silently skipped because zero control peers are configured. (The real heal.ts
    // runs unmocked here and throws against this test's stub DB — that thrown-and-caught
    // error is how we observe the call was actually attempted rather than gated out.)
    expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'failed to emit heal report for session crash',
    );
  });

  it('startup-resumed shared crash callback terminalizes the active turn', async () => {
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
      getLatestCompletedCheckpointForSession: vi.fn(() => completedCheckpoint({
        conversationKey: 'startup-crash',
        deliveryJid: 'startup-crash@s.whatsapp.net',
        deliveryNamespace: 's.whatsapp.net',
        scope: 'shared',
        sessionId: 'startup-shared-crash',
        updatedAt: new Date(Date.now() - 5 * 60_000).toISOString().replace('Z', ''),
      })),
      upsertSessionCheckpoint: vi.fn(),
      markInboundFailed: vi.fn(),
      ...makeTerminalDurabilityMock(),
    };
    const replyGuarantee = {
      disarm: vi.fn(),
      isArmed: vi.fn(() => false),
    };
    const state = runtime as unknown as {
      currentInboundSeq: number | undefined;
      currentRuntimeTurnContext: ReturnType<typeof makeRuntimeTurnContext> | null;
      durability: typeof durability;
      replyGuarantee: typeof replyGuarantee;
    };
    state.durability = durability;
    state.replyGuarantee = replyGuarantee;

    await runtime.start();
    state.currentInboundSeq = 88;
    state.currentRuntimeTurnContext = makeRuntimeTurnContext(
      'shared', 'startup-crash', 'startup-crash@s.whatsapp.net', 88, 'turn-startup-crash',
    );
    capturedOnCrashRef.current?.({
      exitCode: 2,
      signal: 'SIGTERM',
      sessionId: 'startup-shared-crash',
      dbRowId: 8,
      provider: 'claude-cli',
      crashClass: 'boom',
      stderrPreview: 'startup trace',
    });

    await vi.waitFor(() => expect(durability.finalizeTurnTerminal).toHaveBeenCalledOnce());
    expect(replyGuarantee.disarm).toHaveBeenCalledWith(88);
    expect(durability.markInboundFailed).not.toHaveBeenCalled();
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
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hi' }));

    capturedOnEventRef.current!({ type: 'tool_result', isError: true, toolId: 'test', content: 'error msg' });

    // classifyToolError uses content to determine error vs blocked.
    // toolName is 'unknown' here (no prior tool_use event), so detail is just the reason.
    expect(mockQueue.enqueueToolUpdate).toHaveBeenCalledWith({ category: 'error', detail: 'error msg' });
  });

  it('scoped result-only tool events preserve identity and make replay unsafe without a tracker start', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const queue = makeQueueMock('scoped@s.whatsapp.net');
    const tracker = {
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
    };
    const mapKey = 'scoped@s.whatsapp.net';
    const toolScopeKey = `${mapKey}#1`;
    const context = makeRuntimeTurnContext('per_chat', 'scoped', queue.targetChatJid, 41, 'turn-scoped');
    const state = runtime as unknown as {
      operationTrackers: Map<string, typeof tracker>;
      perChatRuntimeTurnContexts: Map<string, Array<typeof context>>;
      turnHadToolActivity: Set<string>;
      activeToolNames: Map<string, Map<string, string>>;
      handleEventWithContext(
        event: AgentEvent,
        queue: IOutboundQueue,
        session: null,
        conversationKey: string,
        inboundSeq: number,
        mapKey: string,
        toolScopeKey: string,
      ): void;
    };
    state.operationTrackers.set(mapKey, tracker);
    state.perChatRuntimeTurnContexts.set(mapKey, [context]);

    state.handleEventWithContext(
      {
        type: 'tool_result',
        toolId: 'call_edit_rejected',
        toolName: 'edit',
        isError: true,
        content: 'permission requested: edit; auto-rejecting',
      },
      queue,
      null,
      'scoped',
      41,
      mapKey,
      toolScopeKey,
    );

    expect(queue.enqueueToolUpdate).toHaveBeenCalledWith(expect.objectContaining({
      category: 'error',
      detail: expect.stringContaining('edit'),
    }));
    expect(state.turnHadToolActivity.has(toolScopeKey)).toBe(true);
    expect(state.perChatRuntimeTurnContexts.get(mapKey)?.[0]?.replay.replaySafe).toBe(false);
    expect(tracker.onToolEnd).toHaveBeenCalledWith('call_edit_rejected');
    expect(tracker.onToolStart).not.toHaveBeenCalled();
    expect(state.activeToolNames.has(toolScopeKey)).toBe(false);
  });

  it('global result-only tool events preserve identity and make replay unsafe without a tracker start', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { shared: true });
    const queue = makeQueueMock('global@s.whatsapp.net');
    const tracker = {
      onAnyActivity: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
      onTurnComplete: vi.fn(),
    };
    const context = makeRuntimeTurnContext('shared', 'global', queue.targetChatJid, 42, 'turn-global');
    const state = runtime as unknown as {
      session: typeof mockSession;
      activeChatJid: string | null;
      currentTurnChatJid: string | null;
      outboundQueues: Map<string, IOutboundQueue>;
      operationTracker: typeof tracker;
      currentRuntimeTurnContext: typeof context;
      singleTurnHadToolActivity: boolean;
      activeToolNames: Map<string, Map<string, string>>;
      handleEvent(sourceSession: object, event: AgentEvent): void;
    };
    state.activeChatJid = queue.targetChatJid;
    state.currentTurnChatJid = queue.targetChatJid;
    state.outboundQueues.set(queue.targetChatJid, queue);
    state.operationTracker = tracker;
    state.currentRuntimeTurnContext = context;
    publishSingletonTestOwner(runtime, mockSession, queue.targetChatJid);

    state.handleEvent(mockSession, {
      type: 'tool_result',
      toolId: 'call_bash_rejected',
      toolName: 'bash',
      isError: true,
      content: 'permission requested: bash; auto-rejecting',
    });

    expect(queue.enqueueToolUpdate).toHaveBeenCalledWith(expect.objectContaining({
      category: 'error',
      detail: expect.stringContaining('bash'),
    }));
    expect(state.singleTurnHadToolActivity).toBe(true);
    expect(state.currentRuntimeTurnContext.replay.replaySafe).toBe(false);
    expect(tracker.onToolEnd).toHaveBeenCalledWith('call_bash_rejected');
    expect(tracker.onToolStart).not.toHaveBeenCalled();
    expect(state.activeToolNames.has('__global__')).toBe(false);
  });

  it.each([
    ['completed with missing name', undefined, false],
    ['error with missing name', undefined, true],
    ['completed with default-ignorable name', '\u034F', false],
    ['error with default-ignorable name', '\u034F', true],
  ] as const)('scoped unmatched OpenCode result %s records activity and makes replay unsafe', (_label, toolName, isError) => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const queue = makeQueueMock('scoped-unnamed@s.whatsapp.net');
    const tracker = {
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
    };
    const mapKey = 'scoped-unnamed@s.whatsapp.net';
    const toolScopeKey = `${mapKey}#1`;
    const context = makeRuntimeTurnContext('per_chat', 'scoped-unnamed', queue.targetChatJid, 43, 'turn-scoped-unnamed');
    const state = runtime as unknown as {
      operationTrackers: Map<string, typeof tracker>;
      perChatRuntimeTurnContexts: Map<string, Array<typeof context>>;
      turnHadToolActivity: Set<string>;
      activeToolNames: Map<string, Map<string, string>>;
      handleEventWithContext(
        event: AgentEvent,
        queue: IOutboundQueue,
        session: null,
        conversationKey: string,
        inboundSeq: number,
        mapKey: string,
        toolScopeKey: string,
      ): void;
    };
    const toolId = `scoped-${isError ? 'error' : 'completed'}-${toolName === undefined ? 'missing' : 'ignorable'}`;
    const event = parseOpenCodeToolResult(toolName, isError, toolId);
    expect(event).not.toHaveProperty('toolName');
    state.operationTrackers.set(mapKey, tracker);
    state.perChatRuntimeTurnContexts.set(mapKey, [context]);

    state.handleEventWithContext(event, queue, null, 'scoped-unnamed', 43, mapKey, toolScopeKey);

    expect(state.turnHadToolActivity.has(toolScopeKey)).toBe(true);
    expect(state.perChatRuntimeTurnContexts.get(mapKey)?.[0]?.replay.replaySafe).toBe(false);
    expect(tracker.onToolEnd).toHaveBeenCalledWith(toolId);
    expect(tracker.onToolStart).not.toHaveBeenCalled();
    expect(state.activeToolNames.has(toolScopeKey)).toBe(false);
  });

  it.each([
    ['completed with missing name', undefined, false],
    ['error with missing name', undefined, true],
    ['completed with default-ignorable name', '\u034F', false],
    ['error with default-ignorable name', '\u034F', true],
  ] as const)('global unmatched OpenCode result %s records activity and makes replay unsafe', (_label, toolName, isError) => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { shared: true });
    const queue = makeQueueMock('global-unnamed@s.whatsapp.net');
    const tracker = {
      onAnyActivity: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
      onTurnComplete: vi.fn(),
    };
    const context = makeRuntimeTurnContext('shared', 'global-unnamed', queue.targetChatJid, 44, 'turn-global-unnamed');
    const state = runtime as unknown as {
      session: typeof mockSession;
      activeChatJid: string | null;
      currentTurnChatJid: string | null;
      outboundQueues: Map<string, IOutboundQueue>;
      operationTracker: typeof tracker;
      currentRuntimeTurnContext: typeof context;
      singleTurnHadToolActivity: boolean;
      activeToolNames: Map<string, Map<string, string>>;
      handleEvent(sourceSession: object, event: AgentEvent): void;
    };
    const toolId = `global-${isError ? 'error' : 'completed'}-${toolName === undefined ? 'missing' : 'ignorable'}`;
    const event = parseOpenCodeToolResult(toolName, isError, toolId);
    expect(event).not.toHaveProperty('toolName');
    state.activeChatJid = queue.targetChatJid;
    state.currentTurnChatJid = queue.targetChatJid;
    state.outboundQueues.set(queue.targetChatJid, queue);
    state.operationTracker = tracker;
    state.currentRuntimeTurnContext = context;
    publishSingletonTestOwner(runtime, mockSession, queue.targetChatJid);

    state.handleEvent(mockSession, event);

    expect(state.singleTurnHadToolActivity).toBe(true);
    expect(state.currentRuntimeTurnContext.replay.replaySafe).toBe(false);
    expect(tracker.onToolEnd).toHaveBeenCalledWith(toolId);
    expect(tracker.onToolStart).not.toHaveBeenCalled();
    expect(state.activeToolNames.has('__global__')).toBe(false);
  });

  it('tool_result with isError emits a provider-wide BOT ERRORS alert', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    const agentConfig = mockConfig as typeof mockConfig & { agentProvider?: string };
    agentConfig.agentProvider = 'claude-cli';
    const runtime = new AgentRuntime(db, messenger, 'ana-bot');
    await runtime.start();
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hi' }));

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
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hi' }));

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
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hi' }));

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
    await sendAndAwaitProviderDispatch(runtime, makeMsg({ content: 'hi' }));

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

  it('cleanupPerChatState removes the conversationKey-keyed route maps (LEAK-15)', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test');
    const state = getPerChatCleanupState(runtime);

    // The slice-4 route bookkeeping maps are keyed by conversationKey, not the
    // raw mapKey: for a canonical JID mapKey ('target@s.whatsapp.net') the
    // conversationKey is the bare local part ('target'). Teardown must reconcile
    // the convention or these maps grow unbounded (the LEAK-15 leak).
    const targetKey = 'target@s.whatsapp.net';
    const targetConv = 'target';
    const otherConv = 'other';
    state.lastSpawnRouteProvider.set(targetConv, 'codex-cli');
    state.lastSpawnRouteProvider.set(otherConv, 'claude-cli');
    state.lastPinBlockNotice.set(targetConv, 'gemini-cli');
    state.lastPinBlockNotice.set(otherConv, 'opencode-cli');

    state.cleanupPerChatState(targetKey);

    expect(state.lastSpawnRouteProvider.has(targetConv)).toBe(false);
    expect(state.lastPinBlockNotice.has(targetConv)).toBe(false);
    // A different conversation's bookkeeping is untouched.
    expect(state.lastSpawnRouteProvider.get(otherConv)).toBe('claude-cli');
    expect(state.lastPinBlockNotice.get(otherConv)).toBe('opencode-cli');
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

  it('aggregates per_chat session shutdown failures and retains only failed owners for retry', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const errorA = new Error('chat-a shutdown failed');
    const errorB = new Error('chat-b shutdown failed');
    const shutdownA = vi.fn()
      .mockRejectedValueOnce(errorA)
      .mockResolvedValue(undefined);
    const shutdownB = vi.fn()
      .mockRejectedValueOnce(errorB)
      .mockResolvedValue(undefined);
    const shutdownC = vi.fn(async () => {});
    const sessionA = { ...mockSession, shutdown: shutdownA };
    const sessionB = { ...mockSession, shutdown: shutdownB };
    const sessionC = { ...mockSession, shutdown: shutdownC };
    const queueA = makeQueueMock('chat-a@s.whatsapp.net');
    const queueB = makeQueueMock('chat-b@s.whatsapp.net');
    const queueC = makeQueueMock('chat-c@s.whatsapp.net');
    const state = runtime as unknown as {
      chatSessions: Map<string, unknown>;
      chatQueues: Map<string, IOutboundQueue>;
      ownedSessionManagers: Map<string, unknown>;
      sessionOwnership: { get(mapKey: string): unknown };
    };

    setOwnedTestSession(runtime, 'chat-a', sessionA);
    setOwnedTestSession(runtime, 'chat-b', sessionB);
    setOwnedTestSession(runtime, 'chat-c', sessionC);
    state.chatQueues.set('chat-a', queueA);
    state.chatQueues.set('chat-b', queueB);
    state.chatQueues.set('chat-c', queueC);

    let shutdownFailure: unknown;
    try {
      await runtime.shutdown();
    } catch (err) {
      shutdownFailure = err;
    }

    expect(shutdownFailure).toBeInstanceOf(AggregateError);
    expect((shutdownFailure as AggregateError).errors).toEqual([errorA, errorB]);
    expect(shutdownA).toHaveBeenCalledTimes(1);
    expect(shutdownB).toHaveBeenCalledTimes(1);
    expect(shutdownC).toHaveBeenCalledTimes(1);
    expect(queueA.shutdown).toHaveBeenCalledTimes(1);
    expect(queueB.shutdown).toHaveBeenCalledTimes(1);
    expect(queueC.shutdown).toHaveBeenCalledTimes(1);
    expect([...state.chatSessions.entries()]).toEqual([
      ['chat-a', sessionA],
      ['chat-b', sessionB],
    ]);
    expect(state.sessionOwnership.get('chat-a')).toBeDefined();
    expect(state.sessionOwnership.get('chat-b')).toBeDefined();
    expect(state.sessionOwnership.get('chat-c')).toBeUndefined();
    expect(state.ownedSessionManagers.size).toBe(2);

    await expect(runtime.shutdown()).resolves.toBeUndefined();

    expect(shutdownA).toHaveBeenCalledTimes(2);
    expect(shutdownB).toHaveBeenCalledTimes(2);
    expect(state.chatSessions.size).toBe(0);
    expect(state.sessionOwnership.get('chat-a')).toBeUndefined();
    expect(state.sessionOwnership.get('chat-b')).toBeUndefined();
    expect(state.ownedSessionManagers.size).toBe(0);
  });

  it('propagates a singleton session shutdown failure after cleanup and retains it for retry', async () => {
    vi.useFakeTimers();
    try {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger);
      const sessionError = new Error('session boom');
      const sessionShutdown = vi.fn()
        .mockRejectedValueOnce(sessionError)
        .mockResolvedValue(undefined);
      const session = { shutdown: sessionShutdown };
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

      runtimeState.session = session;
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

      await expect(runtime.shutdown()).rejects.toBe(sessionError);

      expect(sessionShutdown).toHaveBeenCalledTimes(1);
      expect(queueShutdown).toHaveBeenCalledTimes(1);
      expect(globalSocketStop).toHaveBeenCalledTimes(1);
      expect(workspaceSocketStopA).toHaveBeenCalledTimes(1);
      expect(workspaceMediaStopA).toHaveBeenCalledTimes(1);
      expect(workspaceSocketStopB).toHaveBeenCalledTimes(1);
      expect(workspaceMediaStopB).toHaveBeenCalledTimes(1);
      expect(clearTimeoutSpy).toHaveBeenCalledWith(timeout);
      expect(runtimeState.session).toBe(session);
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

      await expect(runtime.shutdown()).resolves.toBeUndefined();

      expect(sessionShutdown).toHaveBeenCalledTimes(2);
      expect(runtimeState.session).toBeNull();
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

      setOwnedTestSession(runtime, 'chat-a', session);
      runtimeState.chatQueues.set('chat-a', queue);

      runtimeState.handlePerChatCrash('chat-a', 'chat-a@s.whatsapp.net', {
        exitCode: 1,
        signal: null,
        sessionId: 'sess-1',
        dbRowId: 42,
        ...currentCrashIdentity(runtime, 'chat-a'),
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
      // Narrowed to the health-stats message: a respawn/idle timer leaked from
      // an earlier test can legitimately log info during this window (observed
      // flake on quality 24.x: "auto-respawn: attempting resume" — failed on
      // main 2026-07-12 and on PR #1741). The assertion under test is "no
      // health stats before 60s", mirroring the post-shutdown check below.
      expect(
        mockRuntimeLogger.info.mock.calls.some((call) => call[1] === 'agent runtime health stats'),
      ).toBe(false);

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
    expect(MockOutboundQueueCtor).toHaveBeenCalledWith(
      messenger,
      'recreated@s.whatsapp.net',
      // T8-F1+F2: createOutboundQueue also injects the admin-peer + fallback
      // callbacks (peerIsAdmin/fallbackActive) — asserted by identity below.
      {
        conversationKey: 'recreated',
        peerIsAdmin: expect.any(Function),
        fallbackActive: expect.any(Function),
      },
    );
  });

  it('shared queue construction separates mapped-LID delivery from canonical attribution', async () => {
    const { OutboundQueue: MockOutboundQueueCtor } = await import('../../../src/runtimes/agent/outbound-queue.ts');
    const canonicalJid = 'mapped-phone@s.whatsapp.net';
    const lidJid = 'mapped-alias@lid';
    const db = makeDb();
    (db.raw.prepare as ReturnType<typeof vi.fn>).mockImplementation((sql: string) => {
      if (sql.includes('SELECT phone_jid FROM lid_mappings')) {
        return { get: vi.fn(() => ({ phone_jid: canonicalJid })) };
      }
      return { run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) };
    });
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'loops', { shared: true });
    const runtimeState = runtime as unknown as {
      ensureOutboundQueue: (chatJid: string) => void;
    };

    runtimeState.ensureOutboundQueue(lidJid);

    expect(MockOutboundQueueCtor).toHaveBeenLastCalledWith(
      messenger,
      lidJid,
      {
        conversationKey: 'mapped-phone',
        peerIsAdmin: expect.any(Function),
        fallbackActive: expect.any(Function),
      },
    );
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

    expect(MockOutboundQueueCtor).toHaveBeenCalledWith(
      messenger,
      'inherit@s.whatsapp.net',
      {
        conversationKey: 'inherit',
        senderToken: priorToken,
        peerIsAdmin: expect.any(Function),
        fallbackActive: expect.any(Function),
      },
    );
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

      await sendAndAwaitProviderDispatch(
        runtime,
        makeMsg({ chatJid: '15550100001@s.whatsapp.net', content: 'hello' }),
        '15550100001',
      );

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
      await vi.waitFor(() => {
        expect(runtimeState.workspaceResources.get('15550100001')?.lastActivity).toBe(resultAt.getTime());
      });
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
    (runtime as unknown as { durability: unknown }).durability = {
      getLatestCompletedCheckpointForSession: vi.fn(() => completedCheckpoint({
        conversationKey: 'user',
        deliveryJid: 'user@s.whatsapp.net',
        deliveryNamespace: 's.whatsapp.net',
        scope: 'singleton',
        sessionId: 'sess-123',
      })),
      upsertSessionCheckpoint: vi.fn(),
    };
    await runtime.start();

    expect(mockSession.spawnSession).toHaveBeenCalledWith('sess-123', 1);
    // start() defers the message via pendingStartupMessage (main.ts pops it after WA connects)
    expect(sentMessages).toHaveLength(0);
    const pending = runtime.popStartupMessage();
    expect(pending).not.toBeNull();
    expect(pending!.chatJid).toBe('user@s.whatsapp.net');
    expect(pending!.text).toContain('Resuming');
  });

  it('shared resume targets the latest completed turn identity instead of the first session chat', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    mockGetActiveSession.mockReturnValue({
      id: 1,
      session_id: 'shared-session-1',
      chat_jid: '15550003001@s.whatsapp.net',
      claude_pid: 0,
      status: 'active',
      started_at: new Date(Date.now() - 120_000).toISOString(),
      last_message_at: null,
      message_count: 2,
    });

    const runtime = new AgentRuntime(db, messenger, 'test', { shared: true });
    (runtime as unknown as { durability: unknown }).durability = {
      getLatestCompletedCheckpointForSession: vi.fn(() => completedCheckpoint({
        conversationKey: '15550003002',
        deliveryJid: '15550003002:8@s.whatsapp.net',
        deliveryNamespace: 's.whatsapp.net',
        scope: 'shared',
        sessionId: 'shared-session-1',
        inboundSeq: 72,
        logicalTurnId: 'shared-turn-72',
        managerId: 'shared-manager',
        generation: 5,
      })),
      upsertSessionCheckpoint: vi.fn(),
    };

    await runtime.start();

    expect(mockSession.spawnSession).toHaveBeenCalledWith('shared-session-1', 1);
    expect(runtime.popStartupMessage()?.chatJid).toBe('15550003002:8@s.whatsapp.net');
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
    (runtime as unknown as { durability: unknown }).durability = {
      getLatestCompletedCheckpointForSession: vi.fn(() => completedCheckpoint({
        conversationKey: 'user',
        deliveryJid: 'user@s.whatsapp.net',
        deliveryNamespace: 's.whatsapp.net',
        scope: 'singleton',
        sessionId: 'sess-expired',
      })),
      upsertSessionCheckpoint: vi.fn(),
    };
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
    (runtime as unknown as { durability: unknown }).durability = {
      getLatestCompletedCheckpointForSession: vi.fn(() => completedCheckpoint({
        conversationKey: 'user',
        deliveryJid: 'user@s.whatsapp.net',
        deliveryNamespace: 's.whatsapp.net',
        scope: 'singleton',
        sessionId: 'sess-expired',
      })),
      upsertSessionCheckpoint: vi.fn(),
    };
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
    (runtime as unknown as { durability: unknown }).durability = {
      getLatestCompletedCheckpointForSession: vi.fn(() => completedCheckpoint({
        conversationKey: 'user',
        deliveryJid: 'user@s.whatsapp.net',
        deliveryNamespace: 's.whatsapp.net',
        scope: 'singleton',
        sessionId: 'sess-expired',
      })),
      upsertSessionCheckpoint: vi.fn(),
    };
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
    await emitAgentResultWithoutTokens('done');

    const constructorCallsBefore = (MockOutboundQueueCtor as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

    mockSession.getStatus.mockReturnValue({ active: false, pid: null, sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null });
    // single mode: /new requires admin (W1-T3 RULING — SHARED session state).
    await sendAndDrain(runtime, makeMsg({ content: '/new', senderJid: '15550100001@s.whatsapp.net' }));

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
    attachRuntimeFaultMarkerSpies(runtime);
    await runtime.start();

    await sendAndAwaitProviderDispatch(runtime, makeMsg({ messageId: 'shared-a', inboundSeq: 1, chatJid: 'chat-a@g.us', senderJid: '111@s.whatsapp.net', content: 'hello from A', isGroup: true }));
    await runtime.handleMessage(makeMsg({ messageId: 'shared-b', inboundSeq: 2, chatJid: 'chat-b@s.whatsapp.net', senderJid: '222@s.whatsapp.net', content: 'hello from B', isGroup: false }));
    await (runtime as unknown as { turnChain: Promise<void> }).turnChain;

    expect(mockSession.sendTurn).toHaveBeenCalledTimes(1);
    mockSession.completeProviderTurn.mockClear();
    capturedOnEventRef.current?.({ type: 'result', text: 'A complete' });
    await vi.waitFor(() => expect(mockSession.completeProviderTurn).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(mockSession.sendTurn).toHaveBeenCalledTimes(2));
    capturedOnEventRef.current?.({ type: 'result', text: 'B complete' });
    await (runtime as unknown as { turnQueue: { idle(): Promise<void> } }).turnQueue.idle();

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

  it('per_chat: mcpSessionContext stays chat-scoped (unaffected) but #1785 rec-3 ALSO pins the shared global socket to the turn conversation', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();

    mockSession.getStatus.mockReturnValue({ active: true, pid: 123, sessionId: 'ses_x', startedAt: new Date().toISOString(), messageCount: 0, lastMessageAt: null });

    const runtime = new AgentRuntime(db, messenger, 'loops', { sessionScope: 'per_chat' });
    await runtime.start();
    await sendAndDrain(runtime, makeMsg({ chatJid: 'chat-a@g.us', senderJid: 'sender-a@s.whatsapp.net', content: 'per chat', isGroup: true }));

    // The per-chat session's OWN mcpSessionContext (mcpBridge target) is already
    // chat-scoped and confined — unaffected by this fix.
    expect(capturedSessionManagerOptsRef.current?.mcpSessionContext).toMatchObject({
      tier: 'chat-scoped',
      conversationKey: 'chat-a_at_g.us',
      deliveryJid: 'chat-a@g.us',
    });
    // But the instance's shared global socket — used by non-claude fallback
    // subprocesses in per_chat non-sandbox mode (F-STICKY-ACTOR) — is tier:'global'
    // and previously stayed permanently unbound on the false "already isolated"
    // premise (#1785). It now gets pinned per turn exactly like shared/single, so
    // the registry's cross-conversation guard is no longer inert for that socket.
    expect(mockSocketServerInstance.updateConversationKey).toHaveBeenLastCalledWith('chat-a_at_g.us');
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
  it('shared: /new is refused for non-admin senders with a visible denial (B21-A F4a: never silent)', async () => {
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
    // The ONLY reply is the denial notice — no reset ack, no silent drop.
    const enqueuedTexts = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
    expect(enqueuedTexts).toEqual(['_Not authorized._']);
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
    await emitAgentResultWithoutTokens('done');

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

  it('single mode: /new is DENIED for a non-admin sender (WG-5 corrected scope, INVERTS former "backward compat" invariant)', async () => {
    // W1-T3 RULING (W1-PACKET.md :499-501): the old "any sender" invariant this
    // test used to assert WAS the WG-5 bug. In default single/non-shared scope
    // `this.session` is ONE session shared across ALL chats (runtime.ts:760), so
    // a non-admin /new there wipes state others share — affectsShared is true
    // whenever sessionScope !== 'per_chat', regardless of isGroup.
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger); // default: single scope, non-shared
    await runtime.start();
    await sendAndDrain(runtime, makeMsg({ content: 'hello', senderJid: '15559998888@s.whatsapp.net' }));
    await emitAgentResultWithoutTokens('done');

    await sendAndDrain(runtime, makeMsg({
      content: '/new',
      senderJid: '15559998888@s.whatsapp.net', // not admin — single-mode reset now denied
    }));

    expect(mockSession.handleNew).not.toHaveBeenCalled();
    // B21-A F4a: denial is refused-but-visible — the only reply is the notice.
    const denialTexts = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
    expect(denialTexts.some((t) => t.includes('Not authorized'))).toBe(true);
    expect(denialTexts.some((t) => /new session/i.test(t))).toBe(false);
  });

  it('single mode: /new with EMPTY adminPhones is allowed for any sender (no-admin instance keeps its only reset path, B21-A F2)', async () => {
    // The admin-shared-scope denied-predicate would otherwise deny EVERY sender
    // when config.adminPhones is empty — but on the pre-registry base,
    // single-mode /new was ungated ("non-shared: /new is allowed for any
    // sender"), and an instance with no admin configured has NO other reset
    // path: denying everyone is a total /new lockout, not a security posture.
    // Empty adminPhones therefore leaves 'admin-shared-scope' ungated (base
    // parity); plain 'admin'-gated commands stay denied (see sibling test).
    mockConfig.adminPhones = new Set<string>();
    const db = makeDb();
    const { messenger } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger); // default: single scope, non-shared
    await runtime.start();
    await sendAndDrain(runtime, makeMsg({ content: 'hello', senderJid: '15559998888@s.whatsapp.net' }));
    await emitAgentResultWithoutTokens('done');
    mockQueue.enqueueText.mockClear();
    mockSession.handleNew.mockClear();

    await sendAndDrain(runtime, makeMsg({
      content: '/new',
      senderJid: '15559998888@s.whatsapp.net', // any sender — no admin exists to authorize
    }));

    expect(mockSession.handleNew).toHaveBeenCalled();
    const enqueuedTexts = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
    expect(enqueuedTexts.some((t) => /new session/i.test(t))).toBe(true);
  });

  it('single mode: /sessions with EMPTY adminPhones stays DENIED (empty-set relaxation is admin-shared-scope ONLY, B21-A F2)', async () => {
    // The lockout exemption must NOT leak into the plain 'admin' gate: with no
    // admin configured there is legitimately nobody who may run cross-session
    // admin surfaces (/sessions, /kill-session) — they were admin-gated on the
    // pre-registry base too.
    mockConfig.adminPhones = new Set<string>();
    const db = makeDb();
    const { messenger, sentMessages } = makeMessenger();

    const runtime = new AgentRuntime(db, messenger);
    await runtime.start();
    await sendAndDrain(runtime, makeMsg({
      content: '/sessions',
      senderJid: '15559998888@s.whatsapp.net',
    }));

    expect(sentMessages.map((m) => m.text).some((t) => t.includes('Active Sessions'))).toBe(false);
    expect(sentMessages.map((m) => m.text).some((t) => t.includes('No active sessions'))).toBe(false);
  });

  describe('B21-A F4: denial visibility + registry-append fall-through', () => {
    it("replies '_Not authorized._' on a denied 'admin'-gated command (denial is user-visible, never silent)", async () => {
      const db = makeDb();
      const { messenger, sentMessages } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger);
      await runtime.start();
      mockQueue.enqueueText.mockClear();
      await sendAndDrain(runtime, makeMsg({
        content: '/sessions',
        senderJid: '15550001111@s.whatsapp.net', // not admin
      }));
      // The ONLY reply is the denial notice, on the same queue-routed send
      // path other local-command replies use.
      const texts = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
      expect(texts).toEqual(['_Not authorized._']);
      // The gated surface itself stayed refused — no session list on either path.
      expect(sentMessages.map((m) => m.text)).toEqual([]);
    });

    it('a registry command with NO switch case falls through loudly as a forwarded turn (never silently swallowed)', async () => {
      // Simulate a FUTURE COMMAND_REGISTRY entry (Phase-2 '/stats') whose
      // handler was never added to the local-command switch. Pre-registry, an
      // unrecognized command was forwarded to the agent CLI; the switch must
      // preserve that via an explicit default (warn + forward) instead of
      // swallowing the input with a bogus 'local_command_handled' completion.
      classifyInputOverrideRef.current = () => ({ type: 'local', command: 'stats', args: undefined });
      commandSpecOverrideRef.current = () => ({
        name: 'stats',
        summary: 'future command without a handler',
        syntax: '/stats',
        tier: 'transport-local',
        gate: 'none',
        visibility: 'end-user',
        errorClasses: ['internal'],
      });
      try {
        const db = makeDb();
        const { messenger } = makeMessenger();
        const runtime = new AgentRuntime(db, messenger);
        await runtime.start();
        await sendAndDrain(runtime, makeMsg({ content: '/stats' }));
        await vi.waitFor(() => expect(mockSession.sendTurn).toHaveBeenCalledWith('/stats'));
        expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ command: 'stats' }),
          expect.stringContaining('no handler'),
        );
      } finally {
        classifyInputOverrideRef.current = null;
        commandSpecOverrideRef.current = null;
      }
    });
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
    let localOnEvent: ((event: AgentEvent) => void) | null = null;

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
    (MockSessionManagerCtor as unknown as ReturnType<typeof vi.fn>).mockImplementation(function (
      opts: { onEvent: (event: AgentEvent) => void },
    ) {
      localOnEvent = opts.onEvent;
      return localSession;
    });

    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    attachRuntimeFaultMarkerSpies(runtime);
    await runtime.start();

    await runtime.handleMessage(makeMsg({ messageId: 'msg-1', inboundSeq: 1, chatJid: 'same@s.whatsapp.net', content: 'first' }));
    await spawnStarted;
    await runtime.handleMessage(makeMsg({ messageId: 'msg-2', inboundSeq: 2, chatJid: 'same@s.whatsapp.net', content: 'second' }));

    expect(localSession.spawnSession).toHaveBeenCalledTimes(1);
    expect(localSession.sendTurn).not.toHaveBeenCalled();
    expect((MockSessionManagerCtor as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);

    releaseSpawn();
    await (runtime as unknown as { turnChain: Promise<void> }).turnChain;
    await vi.waitFor(() => {
      const sent = (localSession.sendTurn.mock.calls as unknown as Array<[string]>)
        .map(([turnText]) => turnText)
        .filter((turnText) => turnText === 'first' || turnText === 'second');
      expect(sent).toEqual(['first']);
    });
    expect(localOnEvent).toBeTypeOf('function');
    const emitLocalEvent = localOnEvent as unknown as (event: AgentEvent) => void;
    mockSession.completeProviderTurn.mockClear();
    emitLocalEvent({ type: 'result', text: 'first complete' });
    await vi.waitFor(() => expect(mockSession.completeProviderTurn).toHaveBeenCalledOnce());
    await vi.waitFor(() => {
      const sent = (localSession.sendTurn.mock.calls as unknown as Array<[string]>)
        .map(([turnText]) => turnText)
        .filter((turnText) => turnText === 'first' || turnText === 'second');
      expect(sent).toEqual(['first', 'second']);
    });
    emitLocalEvent({ type: 'result', text: 'second complete' });
    await (runtime as unknown as {
      perChatTurnQueues: Map<string, { idle(): Promise<void> }>;
    }).perChatTurnQueues.get('same@s.whatsapp.net')?.idle();

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

    await sendAndAwaitProviderDispatch(
      runtime,
      makeMsg({ messageId: 'msg-1', chatJid: canonicalJid, content: 'hello' }),
      canonicalJid,
    );
    capturedOnEventRef.current?.({ type: 'result', text: 'hello complete' });
    await (runtime as unknown as {
      perChatTurnQueues: Map<string, { idle(): Promise<void> }>;
    }).perChatTurnQueues.get(canonicalJid)?.idle();

    await sendAndAwaitProviderDispatch(
      runtime,
      makeMsg({ messageId: 'msg-2', chatJid: '15550100001@lid', content: 'follow-up' }),
      canonicalJid,
    );
    capturedOnEventRef.current?.({ type: 'result', text: 'follow-up complete' });
    await (runtime as unknown as {
      perChatTurnQueues: Map<string, { idle(): Promise<void> }>;
    }).perChatTurnQueues.get(canonicalJid)?.idle();
    await vi.waitFor(() => {
      const sent = (mockSession.sendTurn.mock.calls as unknown as Array<[string]>)
        .map(([turnText]) => turnText)
        .filter((turnText) => turnText === 'hello' || turnText === 'follow-up');
      expect(sent).toEqual(['hello', 'follow-up']);
    });

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
    await (runtime as unknown as {
      perChatTurnQueues: Map<string, { idle: () => Promise<void> }>;
    }).perChatTurnQueues.get('15550100001')?.idle();
    await emitAgentResultWithoutTokens('done');
    const socketServerCallsAfterFirst = (MockSocketServer as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

    // /new should NOT create a new socket server again (workspace resources survive)
    mockSession.spawnSession.mockClear();
    await sendAndDrain(runtime, makeMsg({ chatJid: '15550100001@s.whatsapp.net', content: '/new' }));
    expect(mockSession.spawnSession).toHaveBeenCalledTimes(1);
    await sendAndDrain(runtime, makeMsg({ chatJid: '15550100001@s.whatsapp.net', content: 'hello again' }));
    const socketServerCallsAfterNew = (MockSocketServer as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

    expect(socketServerCallsAfterNew).toBe(socketServerCallsAfterFirst); // no new socket server started
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

    await runtime.start();
    expect(mockKillSessionTree).toHaveBeenCalledWith(4321, 'SIGTERM', {
      generationMarker: 'stale:43:ses-live-stale:4321',
    });
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
  });

  it('blocks proactive resume and preserves the row when stale tree cleanup is inconclusive', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const { markOrphaned: mockMarkOrphaned } = await import('../../../src/runtimes/agent/session-db.ts');
    const { classifyActiveSessions: mockClassify } = await import('../../../src/runtimes/agent/session-classifier.ts');
    const { SessionManager: MockSessionManager } = await import('../../../src/runtimes/agent/session.ts');
    mockKillSessionTree.mockRejectedValueOnce(new Error('tree census inconclusive'));
    (mockClassify as ReturnType<typeof vi.fn>).mockReturnValue([{
      id: 45,
      sessionId: 'ses-stale-inconclusive',
      claudePid: 4545,
      chatJid: 'stale-inconclusive@s.whatsapp.net',
      conversationKey: 'stale-inconclusive',
      status: 'active',
      classification: 'stale_live',
      reason: 'superseded by checkpoint',
    }]);
    const durability = {
      getResumableCheckpoints: vi.fn(() => [{ conversation_key: 'stale-inconclusive' }]),
      getSessionCheckpoint: vi.fn(() => ({
        session_id: 'ses-current',
        updated_at: new Date().toISOString().replace(/Z$/, ''),
      })),
    };
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    runtime.setDurability(durability as any);

    await runtime.start();

    expect(mockMarkOrphaned).not.toHaveBeenCalledWith(db, 45);
    expect(MockSessionManager).not.toHaveBeenCalled();
    expect(mockRuntimeLogger.info).toHaveBeenCalledWith(
      { conversationKey: 'stale-inconclusive' },
      'skipping proactive resume — live/ambiguous session already present',
    );
  });

  it('does not treat an absent known root PID as proved-empty cleanup', async () => {
    const runtime = new AgentRuntime(makeDb(), makeMessenger().messenger);
    const terminateKnownProcess = (runtime as unknown as {
      terminateKnownProcess(pid: number): Promise<void>;
    }).terminateKnownProcess.bind(runtime);
    mockKillSessionTree.mockRejectedValueOnce(new Error('root row missing or ambiguous'));

    await expect(terminateKnownProcess(98_765)).rejects.toThrow('root row missing or ambiguous');
    expect(mockKillSessionTree).toHaveBeenCalledWith(98_765, 'SIGTERM', {
      generationMarker: expect.stringMatching(/^ownership-loss:98765:/),
    });
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

  it('#1756: marks a zero-message ambiguous session past the age threshold as orphaned', async () => {
    // The exact defect: classifyActiveSessions used to run startup-only and its
    // 'ambiguous' bucket was a permanent no-op, so an init-failure session that
    // never checkpointed stayed 'active' forever. Zero messages + past the age
    // threshold + a PID that is verifiably NOT alive+owned must now resolve to
    // a terminal 'orphaned' row instead of being left running forever.
    const db = makeDb();
    const { messenger } = makeMessenger();
    const { markOrphaned: mockMarkOrphaned } = await import('../../../src/runtimes/agent/session-db.ts');
    const { classifyActiveSessions: mockClassify } = await import('../../../src/runtimes/agent/session-classifier.ts');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH: no such process');
    });

    const staleStartedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    (mockClassify as ReturnType<typeof vi.fn>).mockReturnValue([{
      id: 46,
      sessionId: 'ses-init-failed',
      claudePid: 555555,
      chatJid: 'zombie@s.whatsapp.net',
      conversationKey: 'zombie',
      status: 'active',
      classification: 'ambiguous',
      reason: 'no session_checkpoint for this conversation',
      startedAt: staleStartedAt,
      messageCount: 0,
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
      expect(mockMarkOrphaned).toHaveBeenCalledWith(db, 46);
      expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
        {
          id: 46,
          pid: 555555,
          conversationKey: 'zombie',
          reason: 'no session_checkpoint for this conversation',
        },
        'ambiguous session past age threshold with no activity — marked orphaned (#1756)',
      );
    } finally {
      killSpy.mockRestore();
    }
  });

  it('#1756: does not orphan an ambiguous session that has processed messages, regardless of age', async () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const { markOrphaned: mockMarkOrphaned } = await import('../../../src/runtimes/agent/session-db.ts');
    const { classifyActiveSessions: mockClassify } = await import('../../../src/runtimes/agent/session-classifier.ts');

    const veryOldStartedAt = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    (mockClassify as ReturnType<typeof vi.fn>).mockReturnValue([{
      id: 47,
      sessionId: 'ses-real-work',
      claudePid: 666666,
      chatJid: 'active-conversation@s.whatsapp.net',
      conversationKey: 'active-conversation',
      status: 'active',
      classification: 'ambiguous',
      reason: 'ownership unverified',
      startedAt: veryOldStartedAt,
      messageCount: 12,
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
    expect(mockMarkOrphaned).not.toHaveBeenCalledWith(db, 47);
  });

  it('#1756: runs the zombie-session classifier again on an interval, not just at startup', async () => {
    vi.useFakeTimers();
    try {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const { classifyActiveSessions: mockClassify } = await import('../../../src/runtimes/agent/session-classifier.ts');
      (mockClassify as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const sandbox = { allowedPaths: ['/fake'], allowedTools: [], bash: { enabled: false } };
      const runtime = new AgentRuntime(db, messenger, 'test', {
        sessionScope: 'per_chat',
        sandboxPerChat: true,
        sandbox,
        cwd: tmpdir(),
      });
      runtime.setDurability({} as any);

      await runtime.start();
      const callsAfterStartup = (mockClassify as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(callsAfterStartup).toBeGreaterThan(0);

      // 30 minutes — the interval sweep's default period.
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 1_000);

      expect((mockClassify as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callsAfterStartup);
    } finally {
      vi.useRealTimers();
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
    const sessionEvents = new Map<string, (event: AgentEvent) => void>();
    (MockSessionManagerCtor as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      function (opts: { chatJid: string; onEvent: (event: AgentEvent) => void }) {
        const key = opts.chatJid.replace('@s.whatsapp.net', '');
        sessionEvents.set(key, opts.onEvent);
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
          getDbRowId: vi.fn(() => null),
          getProviderId: vi.fn(() => 'claude-cli'),
          clearTurnWatchdog: vi.fn(() => {}),
          completeProviderTurn: vi.fn(() => {}),
          tickWatchdog: vi.fn(() => {}),
          trackToolStart: vi.fn((_toolId: string) => {}),
          trackToolEnd: vi.fn((_toolId: string) => {}),
          bindGenerationOwnership: vi.fn((_resolve: () => unknown) => {}),
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
    const runtimeState = runtime as unknown as {
      perChatTurnQueues: Map<string, { activeTurn: unknown; idle(): Promise<void> }>;
    };
    const finishTurn = async (key: string): Promise<void> => {
      await vi.waitFor(() => expect(runtimeState.perChatTurnQueues.get(key)?.activeTurn).not.toBeNull());
      sessionEvents.get(key)?.({ type: 'result', text: `${key} complete` });
      await runtimeState.perChatTurnQueues.get(key)?.idle();
    };

    // Chat A sends a message → creates session for chat A
    await sendAndDrain(runtime, makeMsg({
      messageId: 'msg-new-owner-a',
      chatJid: '111@s.whatsapp.net',
      content: 'hello from A',
    }));
    await finishTurn('111');
    // Chat B sends a message → creates session for chat B
    // (OLD BUG: this would set this.session to B's session)
    await sendAndDrain(runtime, makeMsg({
      messageId: 'msg-new-owner-b',
      chatJid: '222@s.whatsapp.net',
      content: 'hello from B',
    }));
    await finishTurn('222');

    // Clear getStatus call tracking on both sessions
    const sessionA = sessionsByKey.get('111');
    const sessionB = sessionsByKey.get('222');
    expect(sessionA).toBeDefined();
    expect(sessionB).toBeDefined();
    sessionA!.getStatus.mockClear();
    sessionB!.getStatus.mockClear();

    // Chat A asks for /status — should query A's session, not B's
    await sendAndDrain(runtime, makeMsg({
      messageId: 'msg-new-owner-reset-a',
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

    // Track which mapped session gets respawned.
    const spawnSessionCalls: string[] = [];
    const sessionEvents = new Map<string, (event: AgentEvent) => void>();
    (MockSessionManagerCtor as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      function (opts: { chatJid: string; onEvent: (event: AgentEvent) => void }) {
        const key = opts.chatJid.replace('@s.whatsapp.net', '');
        sessionEvents.set(key, opts.onEvent);
        return {
          spawnSession: vi.fn(async () => { spawnSessionCalls.push(key); }),
          sendTurn: vi.fn(async () => {}),
          handleNew: vi.fn(async () => {}),
          getStatus: vi.fn(() => ({
            active: true, pid: null, sessionId: `session-${key}`,
            startedAt: new Date().toISOString(), messageCount: 1, lastMessageAt: new Date().toISOString(),
          })),
          getDbRowId: vi.fn(() => null),
          getProviderId: vi.fn(() => 'claude-cli'),
          shutdown: vi.fn(async () => {}),
          clearTurnWatchdog: vi.fn(() => {}),
          completeProviderTurn: vi.fn(() => {}),
          tickWatchdog: vi.fn(() => {}),
          trackToolStart: vi.fn((_toolId: string) => {}),
          trackToolEnd: vi.fn((_toolId: string) => {}),
          bindGenerationOwnership: vi.fn((_resolve: () => unknown) => {}),
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
    const runtimeState = runtime as unknown as {
      perChatTurnQueues: Map<string, { activeTurn: unknown; idle(): Promise<void> }>;
    };
    const finishTurn = async (key: string): Promise<void> => {
      await vi.waitFor(() => expect(runtimeState.perChatTurnQueues.get(key)?.activeTurn).not.toBeNull());
      while (pendingSystemResults(runtime).count(key) > 0) {
        sessionEvents.get(key)?.({ type: 'result', text: null });
        await Promise.resolve();
      }
      sessionEvents.get(key)?.({ type: 'result', text: `${key} complete` });
      await runtimeState.perChatTurnQueues.get(key)?.idle();
    };

    // Chat A and B both establish sessions
    await sendAndDrain(runtime, makeMsg({ chatJid: '111@s.whatsapp.net', content: 'hello from A' }));
    await finishTurn('111');
    await sendAndDrain(runtime, makeMsg({ chatJid: '222@s.whatsapp.net', content: 'hello from B' }));
    await finishTurn('222');

    // Chat A sends /new — should reset A's session, not B's
    spawnSessionCalls.length = 0;
    sentMessages.length = 0;
    await sendAndDrain(runtime, makeMsg({
      chatJid: '111@s.whatsapp.net',
      senderJid: '15550100001@s.whatsapp.net',  // admin phone (required for /new)
      content: '/new',
    }));

    // /new respawns A's mapped session, not B's.
    expect(spawnSessionCalls).toContain('111');
    expect(spawnSessionCalls).not.toContain('222');
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

  it('per_chat transient-network (socket-close) result emits provider_transient_network WARNING, not provider_unknown_terminal CRITICAL', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const queue = makeQueueMock('111@s.whatsapp.net');
    const completeTurn = vi.fn();
    const session = {
      clearTurnWatchdog: vi.fn(),
      completeProviderTurn: vi.fn(),
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
            completeProviderTurn: ReturnType<typeof vi.fn>;
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
    expect(queue.enqueueText).toHaveBeenCalledWith(expect.stringContaining('resend'));
  });

  // QR-211: mirrors the transient-network test above (same handleEventWithContext
  // harness), but for the per_chat auth-required ladder with no fallback armed —
  // today this path shuts the session down with nothing ever forwarded to the chat.
  it('per_chat auth-required result without fallback emits a generic re-auth notice', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const queue = makeQueueMock('111@s.whatsapp.net');
    const session = {
      clearTurnWatchdog: vi.fn(),
      completeProviderTurn: vi.fn(),
      shutdown: vi.fn(),
      getDbRowId: vi.fn(() => 41),
      getStatus: vi.fn(() => ({ active: true })),
    };
    (queue.getLastOpId as ReturnType<typeof vi.fn>).mockReturnValue(77);
    // Unlike the transient-network test above, the auth-required arming branch
    // runs the full cleanupUsageLimitTurn path (it calls session?.shutdown()),
    // which touches upsertSessionCheckpoint/completeInbound too — stub all three.
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
          session: {
            clearTurnWatchdog: ReturnType<typeof vi.fn>;
            completeProviderTurn: ReturnType<typeof vi.fn>;
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

    const raw = 'Authentication required. Sign in to continue.';

    handleEventWithContext(
      { type: 'result', text: raw, isError: true },
      queue,
      session,
      'conv-111',
      17,
      '111',
      '111#session',
    );

    // Raw provider text must not be forwarded
    const forwardedRaw = (queue.enqueueResultText as ReturnType<typeof vi.fn>).mock.calls.map((a: unknown[]) => a[0] as string);
    expect(forwardedRaw).not.toContain(raw);
    // Generic re-auth notice is sent instead of permanent silence
    expect(queue.enqueueText).toHaveBeenCalledWith(expect.stringContaining('re-authentication'));
    expect(session.shutdown).toHaveBeenCalled();
  });

  // QR-211: the notice must be deduped per (chatJid, 'auth-required') within
  // PROVIDER_FALLBACK_NOTICE_DEDUP_MS — a sustained auth-required episode across
  // consecutive turns must not spam the chat with one notice per turn.
  it('per_chat auth-required no-fallback notice is deduped within the window for the same chat', () => {
    const db = makeDb();
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
    const queue = makeQueueMock('111@s.whatsapp.net');
    const session = {
      clearTurnWatchdog: vi.fn(),
      completeProviderTurn: vi.fn(),
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

    const raw = 'Authentication required. Sign in to continue.';

    handleEventWithContext({ type: 'result', text: raw, isError: true }, queue, session, 'conv-111', 17, '111', '111#session');
    handleEventWithContext({ type: 'result', text: raw, isError: true }, queue, session, 'conv-111', 18, '111', '111#session');

    const noticeCalls = (queue.enqueueText as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('re-authentication'),
    );
    expect(noticeCalls).toHaveLength(1);
    expect(session.shutdown).toHaveBeenCalledTimes(2);
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
        completeProviderTurn: vi.fn(),
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
      expect(queue.enqueueText).toHaveBeenCalledWith(expect.stringContaining('resend'));
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

    // QR-211: unlike the two tests above (null-providerKind classes), auth-required
    // has a non-null providerKind and so IS routed into handleProviderFailureResult
    // by dispatchProviderFailureResult. Its comment used to say only usage-limit
    // emits a standalone notice when no fallback armed — this proves auth-required
    // does too, through this same central handler, not just the legacy ladders.
    it('auth-required result with dispatch enabled and no fallback emits the generic re-auth notice', () => {
      process.env['WHATSOUP_RESPONSE_REGISTRY_DISPATCH'] = '1';
      const { queue, session, handleEventWithContext } = makePerChatDispatchHarness();

      const raw = 'Authentication required. Sign in to continue.';
      handleEventWithContext(
        { type: 'result', text: raw, isError: true },
        queue,
        session,
        'conv-111',
        17,
        '111',
        '111#session',
      );

      expect(queue.enqueueText).toHaveBeenCalledWith(expect.stringContaining('re-authentication'));
      expect(session.shutdown).toHaveBeenCalled();
      const forwardedRaw = (queue.enqueueResultText as ReturnType<typeof vi.fn>).mock.calls.map((a: unknown[]) => a[0] as string);
      expect(forwardedRaw).not.toContain(raw);
    });
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
      handleEvent: (sourceSession: object, event: AgentEvent) => void;
    };
    state.durability = { completeTurn: vi.fn(), upsertSessionCheckpoint: vi.fn(), completeInbound: vi.fn() };
    const sourceSession = Object.assign({}, mockSession, {
      shutdown: vi.fn(),
      clearTurnWatchdog: vi.fn(),
      completeProviderTurn: vi.fn(),
    });
    state.session = sourceSession;
    state.activeChatJid = '111@s.whatsapp.net';
    state.currentTurnChatJid = '111@s.whatsapp.net';
    state.currentInboundSeq = 1;
    state.outboundQueues.set('111@s.whatsapp.net', queue);
    publishSingletonTestOwner(runtime, sourceSession, '111@s.whatsapp.net');

    const raw = "There's an issue with the selected model (x). It may not exist or you may not have access to it.";
    state.handleEvent(sourceSession, { type: 'result', text: raw, isError: true });

    const forwarded = (queue.enqueueResultText as ReturnType<typeof vi.fn>).mock.calls.map((a) => a[0] as string);
    expect(forwarded).not.toContain(raw);
    const turnCapability = (runtime.getHealthSnapshot().details as Record<string, any>).turnCapability;
    expect(turnCapability.lastTurnErrorClass).toBe('model-unavailable');
    expect(turnCapability.lastTurnErrorAt).toEqual(expect.any(Number));
    expect(JSON.stringify(turnCapability)).not.toContain(raw);
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
          if (key === '111111100000000001_at_g.us') {
            return completedCheckpoint({
              conversationKey: key,
              deliveryJid: '111111100000000001@g.us',
              deliveryNamespace: 'g.us',
              scope: 'per_chat',
              sessionId: 'group-sess-1',
            });
          }
          if (key === '15551230006') {
            return completedCheckpoint({
              conversationKey: key,
              deliveryJid: '15551230006@lid',
              deliveryNamespace: 'lid',
              scope: 'per_chat',
              sessionId: 'dm-sess-1',
            });
          }
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
        getSessionCheckpoint: vi.fn(() => completedCheckpoint({
          conversationKey: '15551230006',
          deliveryJid: '15551230006@lid',
          deliveryNamespace: 'lid',
          scope: 'per_chat',
          sessionId: 'dm-sess-2',
        })),
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
            { conversation_key: '15551230009' },
          ]),
          getSessionCheckpoint: vi.fn((key: string) => {
            if (key === 'missing-session') return null;
            if (key === 'stale-dm') {
              return completedCheckpoint({
                conversationKey: key,
                deliveryJid: 'stale-dm@lid',
                deliveryNamespace: 'lid',
                scope: 'per_chat',
                sessionId: 'stale-session',
                updatedAt: '2026-06-10T08:00:00',
              });
            }
            if (key === 'already-active') {
              return completedCheckpoint({
                conversationKey: key,
                deliveryJid: 'already-active@lid',
                deliveryNamespace: 'lid',
                scope: 'per_chat',
                sessionId: 'duplicate-session',
                updatedAt: '2026-06-10T09:59:00',
              });
            }
            return completedCheckpoint({
              conversationKey: '15551230009',
              deliveryJid: '15551230009@s.whatsapp.net',
              deliveryNamespace: 's.whatsapp.net',
              scope: 'per_chat',
              sessionId: 'service-session',
              updatedAt: '2026-06-10T09:59:00',
            });
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

    it('proactive resume notification preserves ownership and keeps callbacks routed', async () => {
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
        getSessionCheckpoint: vi.fn(() => completedCheckpoint({
          conversationKey: '15551230007',
          deliveryJid: '15551230007@lid',
          deliveryNamespace: 'lid',
          scope: 'per_chat',
          sessionId: 'dm-sess-callbacks',
        })),
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

      expect(resumedQueue?.abortTurn).not.toHaveBeenCalled();
      expect(resumedQueue?.enqueueText).toHaveBeenCalledWith('resume callback notice');
      expect(resumedQueue?.flush).toHaveBeenCalled();
      expect(state.chatSessions.has(mapKey)).toBe(true);
      expect(state.chatQueues.has(mapKey)).toBe(true);
      expect(sentMessages).toEqual([]);

      capturedOnEventRef.current?.({ type: 'result', text: 'late result' });

      expect(state.handleEventPerChat).toHaveBeenCalledWith(
        state.chatSessions.get(mapKey),
        { type: 'result', text: 'late result' },
        expect.any(String),
      );
    });

    it('proactive resume waits for missed context terminal before quarantining a failed continuation', async () => {
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
          turnInFlight: true,
        } as ReturnType<typeof mockSession.getStatus> & { turnInFlight: boolean });
        mockSession.sendTurn.mockRejectedValueOnce(new Error('stdin closed'));

        const mockDurability = {
          getResumableCheckpoints: vi.fn(() => [
            { conversation_key: '15551230008' },
          ]),
          getSessionCheckpoint: vi.fn(() => completedCheckpoint({
            conversationKey: '15551230008',
            deliveryJid: '15551230008@lid',
            deliveryNamespace: 'lid',
            scope: 'per_chat',
            sessionId: 'dm-sess-continuation',
            updatedAt: '2026-06-10T09:59:00',
          })),
          completeTurn: vi.fn(),
          upsertSessionCheckpoint: vi.fn(),
        };
        (runtime as unknown as { durability: unknown }).durability = mockDurability;

        const state = runtime as unknown as {
          injectMissedMessages: ReturnType<typeof vi.fn>;
        };
        let missedContextMarkedBeforeInjection = false;
        state.injectMissedMessages = vi.fn(async (_session: typeof mockSession, _chatJid: string, _sinceUnixSec: number, onProviderBoundaryReady: () => void) => {
          missedContextMarkedBeforeInjection = pendingSystemResults(runtime).count('15551230008@lid') === 1;
          onProviderBoundaryReady();
          return true;
        });

        await runtime.start();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1_000);

        expect(state.injectMissedMessages).toHaveBeenCalledWith(
          mockSession,
          '15551230008@lid',
          Math.floor(new Date('2026-06-10T09:59:00Z').getTime() / 1000), expect.any(Function),
        );
        expect(missedContextMarkedBeforeInjection).toBe(true);
        expect(mockSession.sendTurn).not.toHaveBeenCalled();
        expect(pendingSystemResults(runtime).count('15551230008@lid')).toBe(1);

        capturedOnEventRef.current?.({ type: 'result', text: 'context received', inputTokens: 25, outputTokens: 0 });
        await vi.waitFor(() => {
          expect(mockSession.sendTurn).toHaveBeenCalledWith(
            '[System: session resumed after service restart — continue where you left off]',
          );
        });
        await vi.waitFor(() => expect(pendingSystemResults(runtime).count('15551230008@lid')).toBe(0));
        expect(mockSession.shutdown).toHaveBeenCalled();
        expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
          expect.objectContaining({
            err: expect.any(Error),
            chatJid: '15551230008@lid',
          }),
          'failed to send continuation turn after resume',
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('proactive resume cancels its context lease when missed-message injection throws', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-10T10:00:00Z'));
      try {
        const db = makeDb();
        const { messenger } = makeMessenger();
        const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
        const chatJid = '15551230018@lid';
        const injectionError = new Error('missed-message lookup failed');

        mockSession.spawnSession.mockResolvedValue(undefined);
        mockSession.getStatus.mockReturnValue({
          active: true,
          pid: 123,
          sessionId: 'dm-sess-inject-error',
          startedAt: new Date().toISOString(),
          messageCount: 1,
          lastMessageAt: null,
        });

        const mockDurability = {
          getResumableCheckpoints: vi.fn(() => [
            { conversation_key: '15551230018' },
          ]),
          getSessionCheckpoint: vi.fn(() => completedCheckpoint({
            conversationKey: '15551230018',
            deliveryJid: chatJid,
            deliveryNamespace: 'lid',
            scope: 'per_chat',
            sessionId: 'dm-sess-inject-error',
            updatedAt: '2026-06-10T09:59:00',
          })),
          upsertSessionCheckpoint: vi.fn(),
        };
        (runtime as unknown as { durability: unknown }).durability = mockDurability;

        const state = runtime as unknown as {
          injectMissedMessages: ReturnType<typeof vi.fn>;
        };
        state.injectMissedMessages = vi.fn(async () => {
          expect(pendingSystemResults(runtime).count(chatJid)).toBe(1);
          throw injectionError;
        });

        await runtime.start();
        await vi.advanceTimersByTimeAsync(1_000);

        expect(state.injectMissedMessages).toHaveBeenCalledOnce();
        expect(mockSession.sendTurn).not.toHaveBeenCalled();
        expect(pendingSystemResults(runtime).count(chatJid)).toBe(0);
        expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ err: injectionError, chatJid }),
          'failed to send continuation turn after resume',
        );
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
          getSessionCheckpoint: vi.fn(() => completedCheckpoint({
            conversationKey: '15551230010',
            deliveryJid: '15551230010@lid',
            deliveryNamespace: 'lid',
            scope: 'per_chat',
            sessionId: 'inactive-session',
            updatedAt: '2026-06-10T09:59:00',
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
          getSessionCheckpoint: vi.fn(() => completedCheckpoint({
            conversationKey: '15551230011',
            deliveryJid: '15551230011@lid',
            deliveryNamespace: 'lid',
            scope: 'per_chat',
            sessionId: 'active-session',
            updatedAt: '2026-06-10T09:59:00',
          })),
          upsertSessionCheckpoint: vi.fn(),
        };
        (activeRuntime as unknown as { durability: unknown }).durability = activeDurability;
        const activeState = activeRuntime as unknown as {
          injectMissedMessages: ReturnType<typeof vi.fn>;
        };
        activeState.injectMissedMessages = vi.fn(async () => false);
        const activeTracker = pendingSystemResults(activeRuntime);
        const markSpy = vi.spyOn(activeTracker, 'mark');
        const cancelSpy = vi.spyOn(activeTracker, 'cancel');
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
          Math.floor(new Date('2026-06-10T09:59:00Z').getTime() / 1000), expect.any(Function),
        );
        expect(markSpy).toHaveBeenCalledTimes(2);
        expect(markSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({
          scopeKey: '15551230011@lid',
          purpose: 'proactive_resume_context',
        }));
        expect(markSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({
          scopeKey: '15551230011@lid',
          purpose: 'proactive_resume_continuation',
        }));
        expect(cancelSpy).toHaveBeenCalledTimes(1);
        expect(cancelSpy).toHaveBeenCalledWith(markSpy.mock.results[0]?.value);
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

    it('legacy active row without completed identity fails closed', async () => {
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
        getLatestCompletedCheckpointForSession: vi.fn(() => undefined),
        upsertSessionCheckpoint: vi.fn(),
      };
      (runtime as unknown as { durability: unknown }).durability = mockDurability;

      await runtime.start();

      expect(mockDurability.getLatestCompletedCheckpointForSession).toHaveBeenCalledWith(
        'sess-legacy-null-chat',
      );
      expect(mockDurability.upsertSessionCheckpoint).not.toHaveBeenCalled();
      expect(mockSession.spawnSession).not.toHaveBeenCalled();
      expect(runtime.popStartupMessage()).toBeNull();
      expect(runtime.getHealthSnapshot().details['proactiveResumeIdentityRejects']).toBe(1);
      expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
        { conversationKey: null, reason: 'legacy_or_ambiguous_identity' },
        'skipping proactive resume — persisted delivery identity is not provable',
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
        getLatestCompletedCheckpointForSession: vi.fn(() => completedCheckpoint({
          id: 1,
          conversationKey: 'user',
          deliveryJid: 'user@s.whatsapp.net',
          deliveryNamespace: 's.whatsapp.net',
          scope: 'singleton',
          sessionId: 'sess-stale',
          updatedAt: new Date(Date.now() - 120 * 60_000).toISOString().replace('Z', ''),
        })),
        retireSessionLifecycle: vi.fn(),
      };
      (runtime as unknown as { durability: unknown }).durability = mockDurability;

      await runtime.start();

      // Session too stale — should NOT spawn
      expect(mockSession.spawnSession).not.toHaveBeenCalled();
      expect(mockDurability.retireSessionLifecycle).toHaveBeenCalledWith({
        agentSessionRowId: 1,
        provider: undefined,
        providerSessionId: 'sess-stale',
      });
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
        getLatestCompletedCheckpointForSession: vi.fn(() => completedCheckpoint({
          id: 2,
          conversationKey: '111111100000000001_at_g.us',
          deliveryJid: '111111100000000001@g.us',
          deliveryNamespace: 'g.us',
          scope: 'shared',
          sessionId: 'sess-shared-group',
          updatedAt: new Date(Date.now() - 5 * 60_000).toISOString().replace('Z', ''),
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
        getLatestCompletedCheckpointForSession: vi.fn(() => completedCheckpoint({
          id: 3,
          conversationKey: '111111100000000001_at_g.us',
          deliveryJid: '111111100000000001@g.us',
          deliveryNamespace: 'g.us',
          scope: 'singleton',
          sessionId: 'sess-single-group',
          updatedAt: new Date(Date.now() - 5 * 60_000).toISOString().replace('Z', ''),
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
        getLatestCompletedCheckpointForSession: vi.fn(() => completedCheckpoint({
          id: 4,
          conversationKey: 'user',
          deliveryJid: 'user@s.whatsapp.net',
          deliveryNamespace: 's.whatsapp.net',
          scope: 'singleton',
          sessionId: 'sess-dm-fresh',
          updatedAt: new Date(Date.now() - 5 * 60_000).toISOString().replace('Z', ''),
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
        getLatestCompletedCheckpointForSession: vi.fn(() => completedCheckpoint({
          id: 5,
          conversationKey: 'user',
          deliveryJid: 'user@s.whatsapp.net',
          deliveryNamespace: 's.whatsapp.net',
          scope: 'singleton',
          sessionId: 'sess-null-ts',
          updatedAt: null,
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
        getLatestCompletedCheckpointForSession: vi.fn(() => completedCheckpoint({
          id: 6,
          conversationKey: 'user',
          deliveryJid: 'user@s.whatsapp.net',
          deliveryNamespace: 's.whatsapp.net',
          scope: 'singleton',
          sessionId: 'sess-spawn-fail-single',
          updatedAt: new Date(Date.now() - 5 * 60_000).toISOString().replace('Z', ''),
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
        getLatestCompletedCheckpointForSession: vi.fn(() => completedCheckpoint({
          id: 7,
          conversationKey: 'user',
          deliveryJid: 'user@s.whatsapp.net',
          deliveryNamespace: 's.whatsapp.net',
          scope: 'shared',
          sessionId: 'sess-spawn-fail-shared',
          updatedAt: new Date(Date.now() - 5 * 60_000).toISOString().replace('Z', ''),
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
      await sendAndAwaitProviderDispatch(
        runtime,
        makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }),
        '5678@s.whatsapp.net',
      );

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
      await sendAndAwaitProviderDispatch(
        runtime,
        makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }),
        '5678@s.whatsapp.net',
      );

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
      await sendAndAwaitProviderDispatch(
        runtime,
        makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }),
        '5678@s.whatsapp.net',
      );

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
      await sendAndAwaitProviderDispatch(
        runtime,
        makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }),
        '5678@s.whatsapp.net',
      );

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
      await sendAndAwaitProviderDispatch(
        runtime,
        makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }),
        '5678@s.whatsapp.net',
      );

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
      await sendAndAwaitProviderDispatch(
        runtime,
        makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }),
        '5678@s.whatsapp.net',
      );

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
      await sendAndAwaitProviderDispatch(
        runtime,
        makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }),
        '5678@s.whatsapp.net',
      );

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
      await sendAndAwaitProviderDispatch(
        runtime,
        makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }),
        '5678@s.whatsapp.net',
      );

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
      await sendAndAwaitProviderDispatch(
        runtime,
        makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }),
        '5678@s.whatsapp.net',
      );

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
      await sendAndAwaitProviderDispatch(
        runtime,
        makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }),
        '5678@s.whatsapp.net',
      );

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
      await sendAndAwaitProviderDispatch(
        runtime,
        makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }),
        '5678@s.whatsapp.net',
      );

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

    it('holds a fast poll answer behind the exact source provider turn', async () => {
      let releaseSourceTurn!: () => void;
      const sourceTurnTerminal = new Promise<void>((resolve) => {
        releaseSourceTurn = resolve;
      });
      mockSession.waitForProviderTurnToTerminalize.mockReturnValueOnce(sourceTurnTerminal);
      const { messenger, pollSends, eventHandlers } = makePollMessenger({
        waMessageId: 'POLL_FAST_ANSWER',
        hasSecret: true,
      });
      const db = makeDb();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });

      await runtime.start();
      await sendAndAwaitProviderDispatch(
        runtime,
        makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }),
        '5678@s.whatsapp.net',
      );

      capturedOnEventRef.current!({
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolId: 'tool-fast-answer',
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
      expect(mockSession.waitForProviderTurnToTerminalize).toHaveBeenCalledOnce();
      mockSession.sendTurn.mockClear();
      eventHandlers.get('pollVoteReceived')!({
        pollMessageId: 'POLL_FAST_ANSWER',
        chatJid: pollSends[0].chatJid,
        voterJid: '5678@s.whatsapp.net',
        selectedOptions: ['Go'],
      });

      await Promise.resolve();
      expect(sendTurnTexts().some((arg) => arg.includes('[User answered poll]'))).toBe(false);
      expect((runtime as unknown as {
        pendingPolls: { questions: Map<string, PendingPollQuestion> };
      }).pendingPolls.questions.has('5678@s.whatsapp.net')).toBe(true);

      releaseSourceTurn();
      await vi.waitFor(() => {
        expect(sendTurnTexts().some((arg) => arg.includes('A: Go'))).toBe(true);
      });
      expect((runtime as unknown as {
        pendingPolls: { questions: Map<string, PendingPollQuestion> };
      }).pendingPolls.questions.has('5678@s.whatsapp.net')).toBe(false);
    });

    it('holds a fast poll answer until the exact journaled source turn is durably finalized', async () => {
      let releaseEvidence!: () => void;
      const evidenceBarrier = new Promise<void>((resolve) => {
        releaseEvidence = resolve;
      });
      mockQueue.flushTurnEvidence.mockImplementationOnce(async (turnId: string) => {
        await evidenceBarrier;
        return { turnId, answerOpIds: [], lifecycleOpIds: [], statusOpIds: [] };
      });
      const { messenger, pollSends, eventHandlers } = makePollMessenger({
        waMessageId: 'POLL_JOURNALED_FAST_ANSWER',
        hasSecret: true,
      });
      const db = makeDb();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });

      await runtime.start();
      const { durability } = attachRuntimeFaultMarkerSpies(runtime);
      await sendAndAwaitProviderDispatch(
        runtime,
        makeMsg({
          content: 'test',
          chatJid: '5678@s.whatsapp.net',
          senderJid: '5678@s.whatsapp.net',
          inboundSeq: 1701,
        }),
        '5678@s.whatsapp.net',
      );

      capturedOnEventRef.current!({
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolId: 'tool-journaled-fast-answer',
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
      expect(mockSession.waitForProviderTurnToTerminalize).not.toHaveBeenCalled();
      mockSession.sendTurn.mockClear();
      eventHandlers.get('pollVoteReceived')!({
        pollMessageId: 'POLL_JOURNALED_FAST_ANSWER',
        chatJid: pollSends[0].chatJid,
        voterJid: '5678@s.whatsapp.net',
        selectedOptions: ['Go'],
      });

      capturedOnEventRef.current!({ type: 'result', text: null });
      await vi.waitFor(() => expect(mockQueue.flushTurnEvidence).toHaveBeenCalledOnce());
      expect(sendTurnTexts().some((arg) => arg.includes('[User answered poll]'))).toBe(false);
      expect(durability.finalizeTurnTerminal).not.toHaveBeenCalled();

      releaseEvidence();
      await vi.waitFor(() => {
        expect(durability.finalizeTurnTerminal).toHaveBeenCalledOnce();
        expect(sendTurnTexts().filter((arg) => arg.includes('A: Go'))).toHaveLength(1);
      });
    });

    it('captures the exact group AskUser source before admin metadata resolves', async () => {
      const groupJid = 'group-barrier@g.us';
      (mockConfig as Record<string, unknown>).pollResolution = {
        defaultStrategy: 'admin-only',
        defaultTimeoutMs: 60_000,
      };
      let releaseMetadata!: (admins: Set<string>) => void;
      const metadata = new Promise<Set<string>>((resolve) => {
        releaseMetadata = resolve;
      });
      let releaseSource!: () => void;
      const sourceBarrier = new Promise<void>((resolve) => {
        releaseSource = resolve;
      });
      mockSession.waitForProviderTurnToTerminalize.mockReturnValueOnce(sourceBarrier);
      const { messenger, pollSends } = makePollMessenger({
        waMessageId: 'POLL_GROUP_BARRIER',
        hasSecret: true,
      });
      const runtime = new AgentRuntime(makeDb(), messenger, 'test', { sessionScope: 'per_chat' });
      const queue = makeQueueMock(groupJid);
      const state = runtime as unknown as {
        chatQueues: Map<string, IOutboundQueue>;
        pendingPolls: { questions: Map<string, PendingPollQuestion> };
        pendingPollSourceTurnBarriers: WeakMap<PendingPollQuestion, Promise<void>>;
        suppressedAskUserToolIds: Set<string>;
        fetchGroupAdminJids(chatJid: string): Promise<Set<string> | null>;
        handleAskUserQuestionAsPoll(
          questions: Array<{
            question: string;
            header: string;
            options: Array<{ label: string; description: string }>;
            multiSelect: boolean;
          }>,
          toolId: string,
          mapKey: string,
          output: IOutboundQueue,
        ): Promise<void>;
      };
      await runtime.start();
      setOwnedTestSession(runtime, groupJid, mockSession);
      state.chatQueues.set(groupJid, queue);
      vi.spyOn(state, 'fetchGroupAdminJids').mockReturnValueOnce(metadata);

      const pollSetup = state.handleAskUserQuestionAsPoll([{
        question: 'Approve?',
        header: 'Approval',
        options: [
          { label: 'Yes', description: 'Approve' },
          { label: 'No', description: 'Reject' },
        ],
        multiSelect: false,
      }], 'tool-group-barrier', groupJid, queue);

      const pending = state.pendingPolls.questions.get(groupJid);
      expect(pending).toBeDefined();
      expect(state.suppressedAskUserToolIds.has('tool-group-barrier')).toBe(true);
      expect(mockSession.waitForProviderTurnToTerminalize).toHaveBeenCalledOnce();
      expect(state.pendingPollSourceTurnBarriers.get(pending!)).toBe(sourceBarrier);
      expect(pollSends).toHaveLength(0);

      releaseMetadata(new Set(['admin@s.whatsapp.net']));
      await pollSetup;
      expect(state.pendingPollSourceTurnBarriers.get(pending!)).toBe(sourceBarrier);
      expect(pollSends).toHaveLength(1);
      releaseSource();
    });

    it('drops an out-of-range poll vote mapping without injecting an answer', async () => {
      const { messenger, pollSends, eventHandlers } = makePollMessenger({ waMessageId: 'POLL_ANSWER', hasSecret: true });
      const db = makeDb();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });

      await runtime.start();
      await sendAndAwaitProviderDispatch(
        runtime,
        makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }),
        '5678@s.whatsapp.net',
      );

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
      await sendAndAwaitProviderDispatch(
        runtime,
        makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }),
        '5678@s.whatsapp.net',
      );

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
      await sendAndAwaitProviderDispatch(
        runtime,
        makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }),
        '5678@s.whatsapp.net',
      );

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
      await sendAndAwaitProviderDispatch(
        runtime,
        makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }),
        '5678@s.whatsapp.net',
      );

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
      await sendAndAwaitProviderDispatch(
        runtime,
        makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }),
        '5678@s.whatsapp.net',
      );

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

    it('terminalizes a fully collected typed poll answer before reinjecting the structured answer', async () => {
      const { messenger, pollSends } = makePollMessenger({ waMessageId: 'POLL_FULL_DURABILITY', hasSecret: true });
      const db = makeDb();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const durability = { completeInbound: vi.fn(), ...makeTerminalDurabilityMock() };
      const replyGuarantee = { arm: vi.fn(), disarm: vi.fn(), shutdown: vi.fn(), isArmed: vi.fn(() => false) };

      await runtime.start();
      (runtime as unknown as { durability: typeof durability }).durability = durability;
      (runtime as unknown as { replyGuarantee: typeof replyGuarantee }).replyGuarantee = replyGuarantee;
      await sendAndAwaitProviderDispatch(
        runtime,
        makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }),
        '5678@s.whatsapp.net',
      );

      capturedOnEventRef.current!({
        type: 'tool_use',
        toolName: 'AskUserQuestion',
        toolId: 'tool-full-durability-1',
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
      replyGuarantee.arm.mockClear();

      await sendAndDrain(runtime, makeMsg({
        content: 'SQLite',
        chatJid: '5678@s.whatsapp.net',
        senderJid: '5678@s.whatsapp.net',
        inboundSeq: 703,
      }));

      await vi.waitFor(() => expect(sendTurnTexts().some((text) => text.includes('A: SQLite'))).toBe(true));
      expect(replyGuarantee.arm).toHaveBeenCalledWith({ inboundSeq: 703, chatJid: '5678@s.whatsapp.net' });
      expect(durability.finalizeTurnTerminal).toHaveBeenCalledWith(expect.objectContaining({
        terminal: expect.objectContaining({
          inboundSeq: 703,
          attemptKind: 'suppressed_by_policy',
          inboundDisposition: 'finalized_no_reply_policy',
        }),
      }));
      expect(durability.completeInbound).not.toHaveBeenCalled();
      expect(replyGuarantee.disarm).toHaveBeenCalledWith(703);
      expect((runtime as unknown as { perChatInboundSeqQueue: Map<string, number[]> }).perChatInboundSeqQueue.has('5678@s.whatsapp.net')).toBe(false);
    });

    it('accepts a typed option label even when the label looks like generic vote status', async () => {
      const { messenger, pollSends } = makePollMessenger({ waMessageId: 'POLL_SUBMITTED_OPTION', hasSecret: true });
      const db = makeDb();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });

      await runtime.start();
      await sendAndAwaitProviderDispatch(
        runtime,
        makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }),
        '5678@s.whatsapp.net',
      );

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
      await sendAndAwaitProviderDispatch(
        runtime,
        makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }),
        '5678@s.whatsapp.net',
      );

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
        await sendAndAwaitProviderDispatch(
          runtime,
          makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }),
          '5678@s.whatsapp.net',
        );

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
        await sendAndAwaitProviderDispatch(
          runtime,
          makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }),
          '5678@s.whatsapp.net',
        );

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
      await sendAndAwaitProviderDispatch(
        runtime,
        makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }),
        '5678@s.whatsapp.net',
      );

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
        await sendAndAwaitProviderDispatch(
          runtime,
          makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }),
          '5678@s.whatsapp.net',
        );

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
      await sendAndAwaitProviderDispatch(
        runtime,
        makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }),
        '5678@s.whatsapp.net',
      );

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
      await sendAndAwaitProviderDispatch(
        runtime,
        makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }),
        '5678@s.whatsapp.net',
      );

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
      await sendAndAwaitProviderDispatch(
        runtime,
        makeMsg({ content: 'test', chatJid: '5678@s.whatsapp.net', senderJid: '5678@s.whatsapp.net' }),
        '5678@s.whatsapp.net',
      );

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
      setOwnedPerChatSession: (mapKey: string, session: typeof mockSession) => void;
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

      mockActiveAgentSession();
      setOwnedTestSession(runtime, groupJid, mockSession);
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

    it('rehydrate removes a resolved AskUser continuation and sends a deterministic retry notice', async () => {
      const db = makeRealDb();
      const { messenger, sentMessages } = makeMessenger();
      const future = Date.now() + 3_600_000;
      insertRow(db, 'resolved-askuser', 'resolved-chat@g.us', future, buildPayload({
        chatJid: 'resolved-chat@g.us',
        answersCollected: { 0: 'A' },
        resolvedAt: Date.now() - 1_000,
      }));

      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      await (runtime as unknown as { rehydratePendingPolls(): Promise<void> }).rehydratePendingPolls();

      expect(sentMessages).toEqual([{
        jid: 'resolved-chat@g.us',
        text: expect.stringMatching(/received your poll answer.*send the answer again/i),
      }]);
      expect((runtime as unknown as {
        pendingPolls: { questions: Map<string, unknown> };
      }).pendingPolls.questions.has('resolved-askuser')).toBe(false);
      const remaining = db.raw.prepare('SELECT COUNT(*) AS cnt FROM pending_polls').get() as { cnt: number };
      expect(remaining.cnt).toBe(0);

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
        assertWritableCompatibility: vi.fn(),
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

    it('/sessions (single scope) renders the resolved chat name via the choke point, not the raw JID (B27)', async () => {
      // Parity lock with the per_chat listing (B23/B25 F2/F3): the
      // single-scope branch must route its chat ref through
      // formatChatRefForOwner too — the live identifier sweep flagged this
      // surface, and the per_chat assertions above never covered it.
      // SQL-dispatching prepare mock (established pattern): the DM has a
      // contacts.display_name row.
      const db = makeDb();
      (db.raw.prepare as ReturnType<typeof vi.fn>).mockImplementation((sql: string) => {
        if (sql.includes('FROM contacts')) {
          return { run: vi.fn(), get: vi.fn(() => ({ display_name: 'Lucas', notify_name: null })), all: vi.fn(() => []) };
        }
        if (sql.includes('FROM agent_sessions')) {
          return { run: vi.fn(), get: vi.fn(() => ({ total_input_tokens: 1500, total_output_tokens: 700 })), all: vi.fn(() => []) };
        }
        return { run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) };
      });
      const { messenger, sentMessages } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger);
      await runtime.start();

      const state = runtime as unknown as {
        session: typeof mockSession;
        activeChatJid: string | null;
      };
      mockSession.getStatus.mockReturnValue({
        active: true,
        pid: 323,
        sessionId: 'sess-single-3',
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        messageCount: 5,
        lastMessageAt: null,
      });
      mockSession.getDbRowId.mockReturnValue(42);
      state.session = mockSession;
      state.activeChatJid = '15550001111@s.whatsapp.net';

      await sendAndDrain(runtime, makeMsg({ content: '/sessions', senderJid: adminSender }));

      const listText = sentMessages.map((m) => m.text).find((t) => t.includes('Active Sessions'));
      // Resolved name + the B25 F3 stable ref suffix, never the raw JID.
      expect(listText).toContain('1. Lucas (…1111)');
      expect(listText).not.toContain('15550001111');
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

    // ── b28 r2c: the requesting chat's own session renders "Current session" ──
    // The row whose conversation key matches the chat that sent /sessions has
    // its number/name identifier replaced by "Current session"; every OTHER row
    // still routes through the sanitize choke point (formatChatRefForOwner).
    // Kill-index semantics are unchanged (positional, not parsed from the name).
    it('b28 r2c: /sessions (per_chat) labels the requesting chat\'s own session "Current session", others by resolved name', async () => {
      const db = makeDb();
      const { messenger, sentMessages } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      await runtime.start();

      const state = runtime as unknown as {
        chatSessions: Map<string, ReturnType<typeof makePerChatSession>>;
        resolvePerChatMapKey(jid: string): string;
      };
      const startedAt = new Date(Date.now() - 5_000).toISOString();
      // makeMsg defaults chatJid to 'test@s.whatsapp.net' — derive its canonical
      // per-chat key the same way the runtime does, so the session keyed by it
      // IS the requesting chat's own session.
      const requestingKey = state.resolvePerChatMapKey('test@s.whatsapp.net');
      state.chatSessions.set(requestingKey, makePerChatSession(true, 11, startedAt));
      state.chatSessions.set('15551112222', makePerChatSession(true, 12, startedAt)); // a DIFFERENT chat

      await sendAndDrain(runtime, makeMsg({ content: '/sessions', senderJid: adminSender }));

      const listText = sentMessages.map((m) => m.text).find((t) => t.includes('Active Sessions'));
      expect(listText).toBeDefined();
      // Exactly the requesting chat's own row is relabelled — never every row.
      expect(listText).toContain('Current session');
      expect((listText!.match(/Current session/g) ?? []).length).toBe(1);
      // Negative control: the OTHER chat still renders via the choke point — its
      // stable ref suffix proves the sanitizer stayed in the path.
      expect(listText).toContain('(…2222)');
    });

    it('b28 r2c: /sessions (single scope) labels the session "Current session" when the request comes from the active chat', async () => {
      const db = makeDbWithTokenRow({ total_input_tokens: 100, total_output_tokens: 50 });
      const { messenger, sentMessages } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger);
      await runtime.start();

      const state = runtime as unknown as { session: typeof mockSession; activeChatJid: string | null };
      mockSession.getStatus.mockReturnValue({
        active: true,
        pid: 900,
        sessionId: 'sess-cur',
        startedAt: new Date(Date.now() - 5_000).toISOString(),
        messageCount: 1,
        lastMessageAt: null,
      });
      mockSession.getDbRowId.mockReturnValue(9);
      state.session = mockSession;
      // The active chat IS the requesting chat (makeMsg default).
      state.activeChatJid = 'test@s.whatsapp.net';

      await sendAndDrain(runtime, makeMsg({ content: '/sessions', senderJid: adminSender }));

      const listText = sentMessages.map((m) => m.text).find((t) => t.includes('Active Sessions'));
      expect(listText).toContain('1. Current session');
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
      // B25 F3: the ack carries the stable ref suffix — the kill evidence.
      expect(text).toBe(`_Session killed: ${groupKey} (…0100) (Group)_`);
    });

    // Regression: /kill-session dropped the SessionManager and the outbound queue
    // but left perChatTurnQueues[mapKey] in place. The orphaned TurnQueue keeps
    // its processor, so the next inbound turn for that chat queues behind a dead
    // session, never reaches spawnSession, and the chat deadlocks — observed live
    // in a per-chat group after /kill-session, with health reporting
    // turnFinalizationDegradedScopes=1 and no replacement session row.
    it('/kill-session (per_chat scope) removes the per-chat runtime TurnQueue', async () => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      await runtime.start();

      const state = runtime as unknown as {
        chatSessions: Map<string, ReturnType<typeof makePerChatSession>>;
        chatQueues: Map<string, IOutboundQueue>;
        perChatTurnQueues: Map<string, TurnQueue>;
      };
      const groupKey = '111111100000000100@g.us';
      state.chatSessions.set(groupKey, makePerChatSession(true, 11, new Date().toISOString()));
      state.chatQueues.set(groupKey, makeQueueMock('group@g.us'));

      // An idle runtime TurnQueue for this chat, exactly as sendTurnToSession leaves it.
      const runtimeQueue = new TurnQueue();
      state.perChatTurnQueues.set(groupKey, runtimeQueue);
      expect(state.perChatTurnQueues.has(groupKey)).toBe(true);

      await sendAndDrain(runtime, makeMsg({ content: '/kill-session 1', senderJid: adminSender }));

      expect(state.perChatTurnQueues.has(groupKey)).toBe(false);
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
      // B23: with no name metadata in the DB, a numeric DM key renders as a
      // formatted phone (ladder step) — not the bare conversation key.
      // B25 F3: plus the stable ref suffix as kill evidence.
      expect(text).toBe(`_Session killed: +${dmKey} (…2222) (DM)_`);
    });

    it('/sessions (per_chat scope) renders chat names from the DB, not raw JIDs (B23)', async () => {
      // Owner ruling: sessions must show contact/group names — raw JID/LID
      // keys only as last resort. SQL-dispatching prepare mock (established
      // pattern, see the @lid admin test below): the group has a groups.subject
      // row, the DM has a contacts.display_name row.
      const db = makeDb();
      (db.raw.prepare as ReturnType<typeof vi.fn>).mockImplementation((sql: string) => {
        if (sql.includes('FROM groups')) {
          return { run: vi.fn(), get: vi.fn(() => ({ subject: 'Ops Crew Test' })), all: vi.fn(() => []) };
        }
        if (sql.includes('FROM contacts')) {
          return { run: vi.fn(), get: vi.fn(() => ({ display_name: 'Lucas', notify_name: null })), all: vi.fn(() => []) };
        }
        if (sql.includes('FROM agent_sessions')) {
          return { run: vi.fn(), get: vi.fn(() => ({ total_input_tokens: 1500, total_output_tokens: 700 })), all: vi.fn(() => []) };
        }
        return { run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) };
      });
      const { messenger, sentMessages } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      await runtime.start();

      const state = runtime as unknown as {
        chatSessions: Map<string, ReturnType<typeof makePerChatSession>>;
      };
      const startedAt = new Date(Date.now() - 90_000).toISOString();
      state.chatSessions.set('15550001111', makePerChatSession(true, 11, startedAt)); // DM
      state.chatSessions.set('111222333444555666@g.us', makePerChatSession(true, 12, startedAt)); // Group

      await sendAndDrain(runtime, makeMsg({ content: '/sessions', senderJid: adminSender }));

      const listText = sentMessages.map((m) => m.text).find((t) => t.includes('Active Sessions'));
      // B25 F3: names carry a short stable ref suffix — deterministic, so
      // identical resolved names stay distinguishable and the later
      // /kill-session ack proves WHICH chat died (TOCTOU evidence). The B23
      // ruling was names-not-RAW-JIDs; a 4-char disambiguator tail is
      // compatible with it and required for safe kills.
      expect(listText).toContain('1. Lucas (…1111) (DM)');
      expect(listText).toContain('2. Ops Crew Test (…5666) (Group)');
      expect(listText).not.toContain('15550001111');
      expect(listText).not.toContain('111222333444555666');
    });

    it('/kill-session ack renders the resolved chat name, not the raw key (B23)', async () => {
      const db = makeDb();
      (db.raw.prepare as ReturnType<typeof vi.fn>).mockImplementation((sql: string) => {
        if (sql.includes('FROM contacts')) {
          return { run: vi.fn(), get: vi.fn(() => ({ display_name: 'Lucas', notify_name: null })), all: vi.fn(() => []) };
        }
        return { run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) };
      });
      const { messenger, sentMessages } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      await runtime.start();

      const state = runtime as unknown as {
        chatSessions: Map<string, ReturnType<typeof makePerChatSession>>;
        chatQueues: Map<string, IOutboundQueue>;
      };
      const dmKey = '15550001111';
      state.chatSessions.set(dmKey, makePerChatSession(true, 11, new Date().toISOString()));
      state.chatQueues.set(dmKey, makeQueueMock('dm@s.whatsapp.net'));

      await sendAndDrain(runtime, makeMsg({ content: '/kill-session 1', senderJid: adminSender }));

      const text = sentMessages.map((m) => m.text).find((t) => t.includes('Session killed:'));
      // B25 F3: same suffix form as the /sessions list — the ack must prove
      // which chat died, not just repeat a (possibly colliding) name.
      expect(text).toBe('_Session killed: Lucas (…1111) (DM)_');
    });

    it('/sessions sanitizes remote-controlled names: newline cannot forge a row, markdown is stripped (B25 F2)', async () => {
      // Push names / group subjects are attacker-controlled. A '\n' in a name
      // previously forged additional /sessions rows (kill-wrong-session
      // vector); '*_`~' broke the WhatsApp markdown the list renders in.
      const db = makeDb();
      (db.raw.prepare as ReturnType<typeof vi.fn>).mockImplementation((sql: string) => {
        if (sql.includes('FROM contacts')) {
          return {
            run: vi.fn(),
            get: vi.fn(() => ({
              display_name: 'Evil\n2. Ghost (DM) — 9m, 9 msgs, 9 tokens *p* `q` ~r~',
              notify_name: null,
            })),
            all: vi.fn(() => []),
          };
        }
        return { run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) };
      });
      const { messenger, sentMessages } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      await runtime.start();

      const state = runtime as unknown as {
        chatSessions: Map<string, ReturnType<typeof makePerChatSession>>;
      };
      state.chatSessions.set('15550001111', makePerChatSession(true, 11, new Date().toISOString()));

      await sendAndDrain(runtime, makeMsg({ content: '/sessions', senderJid: adminSender }));

      const listText = sentMessages.map((m) => m.text).find((t) => t.includes('Active Sessions'));
      expect(listText).toContain('Active Sessions (1)');
      // No newline-forged second row, no markdown metachars, capped length.
      expect(listText).not.toContain('\n2. Ghost');
      expect(listText).not.toContain('*p*');
      expect(listText).not.toContain('`');
      expect(listText).not.toContain('~');
      // The stable ref suffix survives as the identity evidence.
      expect(listText).toContain('(…1111)');
    });

    it('/kill-session ack strips markdown metachars so the italic wrapper stays balanced (B25 F2)', async () => {
      const db = makeDb();
      (db.raw.prepare as ReturnType<typeof vi.fn>).mockImplementation((sql: string) => {
        if (sql.includes('FROM contacts')) {
          return { run: vi.fn(), get: vi.fn(() => ({ display_name: 'x_y_z', notify_name: null })), all: vi.fn(() => []) };
        }
        return { run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) };
      });
      const { messenger, sentMessages } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      await runtime.start();

      const state = runtime as unknown as {
        chatSessions: Map<string, ReturnType<typeof makePerChatSession>>;
        chatQueues: Map<string, IOutboundQueue>;
      };
      state.chatSessions.set('15550001111', makePerChatSession(true, 11, new Date().toISOString()));
      state.chatQueues.set('15550001111', makeQueueMock('dm@s.whatsapp.net'));

      await sendAndDrain(runtime, makeMsg({ content: '/kill-session 1', senderJid: adminSender }));

      const text = sentMessages.map((m) => m.text).find((t) => t.includes('Session killed:'));
      expect(text).toBe('_Session killed: xyz (…1111) (DM)_');
    });

    it('/sessions disambiguates identical resolved names with the stable ref suffix (B25 F3)', async () => {
      const db = makeDb();
      (db.raw.prepare as ReturnType<typeof vi.fn>).mockImplementation((sql: string) => {
        if (sql.includes('FROM contacts')) {
          return { run: vi.fn(), get: vi.fn(() => ({ display_name: 'Lucas', notify_name: null })), all: vi.fn(() => []) };
        }
        return { run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) };
      });
      const { messenger, sentMessages } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      await runtime.start();

      const state = runtime as unknown as {
        chatSessions: Map<string, ReturnType<typeof makePerChatSession>>;
      };
      const startedAt = new Date().toISOString();
      state.chatSessions.set('15550001111', makePerChatSession(true, 11, startedAt));
      state.chatSessions.set('15550002222', makePerChatSession(true, 12, startedAt));

      await sendAndDrain(runtime, makeMsg({ content: '/sessions', senderJid: adminSender }));

      const listText = sentMessages.map((m) => m.text).find((t) => t.includes('Active Sessions'));
      // Same name, distinguishable rows — the suffix is the discriminator.
      expect(listText).toContain('1. Lucas (…1111) (DM)');
      expect(listText).toContain('2. Lucas (…2222) (DM)');
    });

    it('/kill-session (single scope) with a wrong index does NOT kill the lone session (B25 F4)', async () => {
      // The parsed index was IGNORED in the shared branch: any N>=1 killed
      // the only session. Bounds-check must mirror per_chat's reply.
      const db = makeDb();
      const { messenger, sentMessages } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger);
      await runtime.start();

      mockSession.getStatus.mockReturnValue({
        active: true,
        pid: 321,
        sessionId: 'sess-single',
        startedAt: new Date().toISOString(),
        messageCount: 1,
        lastMessageAt: null,
      });
      (runtime as unknown as { session: typeof mockSession }).session = mockSession;

      await sendAndDrain(runtime, makeMsg({ content: '/kill-session 3', senderJid: adminSender }));

      expect(mockSession.shutdown).not.toHaveBeenCalled();
      const text = sentMessages.map((m) => m.text).find((t) => t.includes('Invalid session number'));
      expect(text).toBe('_Invalid session number. 1 active._');
    });

    it('/kill-session rejects trailing-garbage indices like "2x" everywhere (B25 F4)', async () => {
      // parseInt('2x') === 2 silently accepted garbage and killed session 2.
      const db = makeDb();
      const { messenger, sentMessages } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      await runtime.start();

      const state = runtime as unknown as {
        chatSessions: Map<string, ReturnType<typeof makePerChatSession>>;
        chatQueues: Map<string, IOutboundQueue>;
      };
      const s1 = makePerChatSession(true, 11, new Date().toISOString());
      const s2 = makePerChatSession(true, 12, new Date().toISOString());
      state.chatSessions.set('15550001111', s1);
      state.chatSessions.set('15550002222', s2);
      state.chatQueues.set('15550002222', makeQueueMock('dm@s.whatsapp.net'));

      await sendAndDrain(runtime, makeMsg({ content: '/kill-session 2x', senderJid: adminSender }));

      expect(s1.shutdown).not.toHaveBeenCalled();
      expect(s2.shutdown).not.toHaveBeenCalled();
      const text = sentMessages.map((m) => m.text).find((t) => t.includes('Usage: /kill-session'));
      expect(text).toContain('Run /sessions first');
    });

    it('/kill-session (single scope) ack names the killed chat via the choke point (B25 F4)', async () => {
      // '_Session killed._' was identity-less — worthless as kill evidence.
      const db = makeDb();
      const { messenger, sentMessages } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger);
      await runtime.start();

      mockSession.getStatus.mockReturnValue({
        active: true,
        pid: 321,
        sessionId: 'sess-single',
        startedAt: new Date().toISOString(),
        messageCount: 1,
        lastMessageAt: null,
      });
      const state = runtime as unknown as {
        session: typeof mockSession | null;
        activeChatJid: string | null;
      };
      state.session = mockSession;
      state.activeChatJid = '15550001111@s.whatsapp.net';

      await sendAndDrain(runtime, makeMsg({ content: '/kill-session 1', senderJid: adminSender }));

      expect(mockSession.shutdown).toHaveBeenCalledWith(false);
      const text = sentMessages.map((m) => m.text).find((t) => t.includes('Session killed'));
      expect(text).toBe('_Session killed: +15550001111 (…1111)_');
    });

    // W1-T3: gate convergence security proof matrix (isAdminMessage hoisted
    // ahead of the switch, replacing the three duplicated in-switch phone-only
    // gates). QR-143 closes the @sms spoof hole; WG-5 makes /new's gate
    // unconditional (removes the `this.shared &&` prefix that skipped it in
    // per_chat scope).
    it('denies /kill-session to an @sms sender bearing the admin phone digits', async () => {
      const db = makeDb();
      const { messenger, sentMessages } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger);
      await runtime.start();
      // Spoof: admin PHONE digits on a non-WhatsApp-authenticated transport JID.
      await sendAndDrain(runtime, makeMsg({ content: '/kill-session 1', senderJid: '15550100001@sms' }));
      // The gated action is refused: nothing rides the admin bypass path
      // (messenger.sendMessage) — no 'Session killed' receipt, no session list.
      // (B21-A F4a: the denial itself IS user-visible, via the queue path.)
      expect(sentMessages.map((m) => m.text)).toEqual([]);
    });

    it('allows /kill-session for an authenticated admin in a GROUP (base parity — DM-only clause removed, B21-A F3)', async () => {
      // The deleted pre-registry gates were phone-only, so admins could
      // /sessions and /kill-session from groups; isAdminMessage's DM-only
      // clause silently removed that capability. The 'admin' gate must use the
      // authenticated-admin core WITHOUT the DM restriction — the QR-143
      // authenticated-JID check stays FIRST (see the @sms sibling below), but
      // an authenticated admin in a group is authorized.
      const db = makeDb();
      const { messenger, sentMessages } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger);
      await runtime.start();
      mockSession.getStatus.mockReturnValue({
        active: true, pid: 321, sessionId: 'sess-single',
        startedAt: new Date(Date.now() - 60_000).toISOString(), messageCount: 5, lastMessageAt: null,
      });
      (runtime as unknown as { session: typeof mockSession; activeChatJid: string | null }).session = mockSession;
      (runtime as unknown as { activeChatJid: string | null }).activeChatJid = 'owner@s.whatsapp.net';
      await sendAndDrain(runtime, makeMsg({
        content: '/kill-session 1',
        senderJid: adminSender,
        chatJid: 'group-1@g.us',
        isGroup: true,
      }));
      expect(mockSession.shutdown).toHaveBeenCalledWith(false);
      expect(sentMessages.map((m) => m.text).some((t) => t.includes('Session killed'))).toBe(true);
    });

    it('denies /kill-session to an @sms spoof of the admin digits in a GROUP (QR-143 stays closed after the DM-clause removal, B21-A F3)', async () => {
      // Same spoof shape as the DM @sms test above, aimed at the group venue
      // the F3 fix opens: admin PHONE digits on a non-WhatsApp-authenticated
      // transport. The authenticated-JID check runs FIRST, so restoring group
      // capability must NOT re-open the QR-143 hole.
      const db = makeDb();
      const { messenger, sentMessages } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger);
      await runtime.start();
      mockSession.getStatus.mockReturnValue({
        active: true, pid: 321, sessionId: 'sess-single',
        startedAt: new Date(Date.now() - 60_000).toISOString(), messageCount: 5, lastMessageAt: null,
      });
      (runtime as unknown as { session: typeof mockSession; activeChatJid: string | null }).session = mockSession;
      (runtime as unknown as { activeChatJid: string | null }).activeChatJid = 'owner@s.whatsapp.net';
      await sendAndDrain(runtime, makeMsg({
        content: '/kill-session 1',
        senderJid: '15550100001@sms',
        chatJid: 'group-1@g.us',
        isGroup: true,
      }));
      expect(mockSession.shutdown).not.toHaveBeenCalled();
      expect(sentMessages.map((m) => m.text).some((t) => t.includes('Session killed'))).toBe(false);
    });

    it('still allows /sessions for the real admin over an authenticated DM JID (positive regression)', async () => {
      const db = makeDbWithTokenRow({ total_input_tokens: 1500, total_output_tokens: 700 });
      const { messenger, sentMessages } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger);
      await runtime.start();
      mockSession.getStatus.mockReturnValue({
        active: true, pid: 321, sessionId: 'sess-single',
        startedAt: new Date(Date.now() - 60_000).toISOString(), messageCount: 5, lastMessageAt: null,
      });
      mockSession.getDbRowId.mockReturnValue(42);
      (runtime as unknown as { session: typeof mockSession; activeChatJid: string | null }).session = mockSession;
      (runtime as unknown as { activeChatJid: string | null }).activeChatJid = 'owner@s.whatsapp.net';
      await sendAndDrain(runtime, makeMsg({ content: '/sessions', senderJid: adminSender }));
      expect(sentMessages.map((m) => m.text).some((t) => t.includes('Active Sessions'))).toBe(true);
    });

    it('allows /sessions for the admin over an authenticated @lid JID', async () => {
      // @lid IS a WhatsApp-authenticated transport (isWhatsAppAuthenticatedJid =
      // isPnJid || isLidJid), so convergence must NOT lock out lid-resolved admins.
      // Fixture: SQL-dispatching prepare mock resolves the lid to the admin phone,
      // matching the established pattern at :8067/:9057 (lid_mappings lookup).
      const db = makeDb();
      const lidLocal = '77778888';
      (db.raw.prepare as ReturnType<typeof vi.fn>).mockImplementation((sql: string) => {
        if (sql.includes('SELECT phone_jid FROM lid_mappings')) {
          return { get: vi.fn(() => ({ phone_jid: '15550100001@s.whatsapp.net' })) };
        }
        return { run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) };
      });
      const { messenger, sentMessages } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger);
      await runtime.start();
      mockSession.getStatus.mockReturnValue({
        active: true, pid: 321, sessionId: 'sess-lid',
        startedAt: new Date(Date.now() - 60_000).toISOString(), messageCount: 3, lastMessageAt: null,
      });
      (runtime as unknown as { session: typeof mockSession; activeChatJid: string | null }).session = mockSession;
      (runtime as unknown as { activeChatJid: string | null }).activeChatJid = 'owner@s.whatsapp.net';
      await sendAndDrain(runtime, makeMsg({ content: '/sessions', senderJid: `${lidLocal}@lid` }));
      // Real assertion — the lid admin is allowed, the session list renders:
      expect(sentMessages.map((m) => m.text).some((t) => t.includes('Active Sessions'))).toBe(true);
    });

    it('denies /new to a non-admin participant in a per_chat group (WG-5)', async () => {
      // Construct the runtime in per_chat scope; today `this.shared` is false there so
      // the gate is SKIPPED (any participant can wipe the session). RED today, GREEN
      // after the gate becomes unconditional via isAdminMessage.
      // per_chat /new's non-bypass sendDirect routes through the per-chat
      // OutboundQueue.enqueueText mock (not messenger.sendMessage/sentMessages) —
      // observe the shared mockQueue fixture, matching the established idiom used
      // throughout this file for per-chat queue-routed replies.
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      await runtime.start();
      mockQueue.enqueueText.mockClear();
      await sendAndDrain(runtime, makeMsg({
        content: '/new',
        senderJid: nonAdminSender,
        chatJid: 'group-1@g.us',
        isGroup: true,
      }));
      // Assert no "Starting new session" acknowledgement was enqueued (the wipe was refused).
      const enqueuedTexts = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
      expect(enqueuedTexts.some((t) => /new session/i.test(t))).toBe(false);
    });

    it('per_chat 1:1 DM: /new is ALLOWED for a non-admin sender (own conversation, not shared — positive regression)', async () => {
      // Full scope-matrix coverage (W1-PACKET.md :507): affectsShared =
      // sessionScope !== 'per_chat' || isGroup. A per_chat 1:1 DM reset only
      // touches the sender's own conversation, so it stays ungated — this was
      // true both before and after T3 (Bucket B self-resolves); asserted here
      // explicitly as the positive half of the WG-5 scope matrix.
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      await runtime.start();
      mockQueue.enqueueText.mockClear();
      await sendAndDrain(runtime, makeMsg({
        content: '/new',
        senderJid: nonAdminSender,
        chatJid: 'dm-1@s.whatsapp.net',
        isGroup: false,
      }));
      const enqueuedTexts = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
      expect(enqueuedTexts.some((t) => /new session/i.test(t))).toBe(true);
    });

    it('denies /new to a non-admin sender in single mode even in a group-tagged venue (WG-5 full scope matrix)', async () => {
      // NET-NEW proof point (distinct from the per_chat-group WG-5 test above):
      // affectsShared = (sessionScope !== 'per_chat') || isGroup — in default
      // SINGLE scope the left disjunct is already true regardless of isGroup, so
      // this must deny identically whether the inbound venue is a DM or a group.
      // Captured RED against the pre-T3 gate (`this.shared && !isAdminPhone`):
      // single-mode `this.shared` is false, so the old gate was skipped entirely
      // for ANY venue, including a group-tagged one — old code let this through.
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger); // default: single scope
      await runtime.start();
      mockQueue.enqueueText.mockClear();
      await sendAndDrain(runtime, makeMsg({
        content: '/new',
        senderJid: nonAdminSender,
        chatJid: 'group-2@g.us',
        isGroup: true,
      }));
      expect(mockSession.handleNew).not.toHaveBeenCalled();
      const enqueuedTexts = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
      expect(enqueuedTexts.some((t) => /new session/i.test(t))).toBe(false);
    });

    it('denies /new to an @sms sender bearing the admin phone digits (single mode — own @sms-closing clause)', async () => {
      // /new's admin-shared-scope branch has its OWN independently-specified
      // @sms-closing check (isWhatsAppAuthenticatedJid(msg.senderJid) &&
      // isAdminPhone(...)) — distinct from isAdminMessage, which only closes
      // the hole for /sessions and /kill-session (see the sibling @sms test
      // above). Same spoof shape, aimed at /new: admin PHONE digits on a
      // non-WhatsApp-authenticated transport JID, in an affectsShared venue
      // (default single scope — affectsShared regardless of isGroup there).
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger); // default: single scope
      await runtime.start();
      mockQueue.enqueueText.mockClear();
      await sendAndDrain(runtime, makeMsg({ content: '/new', senderJid: '15550100001@sms' }));
      expect(mockSession.handleNew).not.toHaveBeenCalled();
      const enqueuedTexts = mockQueue.enqueueText.mock.calls.map((args) => args[0] as string);
      expect(enqueuedTexts.some((t) => /new session/i.test(t))).toBe(false);
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
      // singletonProviderToolSession is only ever tracked for single/shared spawns
      // (trackSingletonMcpSession: true) — per_chat never sets it in production.
      view.singletonProviderToolSession = sessionScope === 'per_chat' ? null : { tier: 'global' };
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

    it('#1785 rec-3: per_chat ALSO pins its shared global socket to the originating chat at turn dispatch — the false "already isolated" premise let this guard stay permanently unbound for the per_chat fleet\'s non-claude fallback sockets (tier:global)', () => {
      const { view, socketUpdates } = makeBindingRuntime('per_chat');
      expect(view.singletonProviderToolSession).toBeNull(); // per_chat never tracks a singleton MCP session
      view.enforceGlobalConversationBinding(ALICE_JID);
      // singletonProviderToolSession stays null (nothing to bind) but the shared
      // global socket — which non-claude fallback subprocesses actually use in
      // per_chat non-sandbox mode — now gets pinned exactly like shared/single.
      expect(view.singletonProviderToolSession).toBeNull();
      expect(socketUpdates).toEqual([toConversationKey(ALICE_JID)]);
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

    it('per-chat downstream handler calls endTurn() on a usage-limit early-break', () => {
      // Admission is intentionally out of scope: this isolates the downstream
      // handleEventWithContext choke point used after source-bound admission.
      const runtime = new AgentRuntime(makeDb(), makeMessenger().messenger, 'test', { sessionScope: 'per_chat' });
      const MAP_KEY = 'chat-x@s.whatsapp.net';
      const perChatQueue = makeQueueMock(MAP_KEY);

      type PerChatRuntimeView = {
        chatQueues: Map<string, IOutboundQueue>;
        perChatInboundSeqQueue: Map<string, number[]>;
      };
      const view = runtime as unknown as PerChatRuntimeView;

      view.chatQueues.set(MAP_KEY, perChatQueue);
      view.perChatInboundSeqQueue.set(MAP_KEY, [1]);

      // Drive a usage-limit result — early-break branch in handleEventWithContext
      handleEventDownstreamWithoutAdmission(runtime, {
        type: 'result',
        text: 'Claude usage limit reached. Your limit will reset at 3pm.',
        inputTokens: 0,
        outputTokens: 0,
      }, {
        queue: perChatQueue,
        session: mockSession,
        conversationKey: toConversationKey(MAP_KEY),
        inboundSeq: 1,
        mapKey: MAP_KEY,
        toolScopeKey: `${MAP_KEY}#test`,
      });

      expect(perChatQueue.endTurn).toHaveBeenCalledTimes(1);
    });
  });
});

// ─── NL routing handler matrix (slices 1.5 + 2; review gap F14/B4) ───────────
// Integration coverage for the /model //reset handlers (D11: /why removed)
// and the spawn steering wiring, on a REAL sqlite store (in-memory) behind the runtime,
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
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const crypto = await import('node:crypto');
    routingDbPath = path.join(fs.realpathSync(os.tmpdir()), `routing-h-${crypto.randomBytes(6).toString('hex')}.db`);
    const real = new RealDatabase(routingDbPath);
    real.open();
    routingDb = real as unknown as Database;
    const prefMod = await import('../../../src/runtimes/agent/chat-preference-db.ts');
    ensurePrefSchema = prefMod.ensureChatPreferenceSchema;
    eventsDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'route-ev-'));
    cfgAny().nlRouting = true;
    cfgAny().nlRoutingEventsDir = eventsDir;
    // The runtime reads its provider from config (config.agentProvider), which
    // the file-wide mockConfig does not set — routing needs a real primary.
    cfgAny().agentProvider = 'claude-cli';
    // Task H: the per-harness catalogue resolver's opencode/openai caches are
    // MODULE-LEVEL (keyed by binary, 60s TTL) — without a reset here, an
    // earlier test's injected listFn result can leak into a later test via
    // the cache (the injected fn would never be called, and the wrong
    // catalogue would drive the pin-verify outcome).
    __resetModelCatalogueCacheForTest();
    capturedSessionManagerOptsRef.current = null;
    mockQueue.enqueueText.mockClear();
    mockSession.sendTurn.mockClear();
    mockSession.getStatus.mockReturnValue({ active: false, pid: null, sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null });
    // Task G (D14): the shared mock SessionManager is one singleton object
    // reused across every constructor call, so its accessors must track the
    // LATEST construction opts to mean anything for the recycle diff-gate —
    // a real SessionManager's getProviderId/getModelRef report exactly what
    // it was constructed with (session.ts readonly fields); a frozen return
    // value would make every respawn look identical regardless of its actual
    // route, hiding genuine route changes from applyRouteChangeAndRecycle.
    (mockSession as unknown as Record<string, unknown>).getModelRef = vi.fn(
      () => (capturedSessionManagerOptsRef.current as unknown as { model?: string } | null)?.model,
    );
    (mockSession as unknown as Record<string, unknown>).getProviderId = vi.fn(
      () => (capturedSessionManagerOptsRef.current as unknown as { provider?: string } | null)?.provider ?? 'claude-cli',
    );
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
    fs.rmSync(eventsDir, { recursive: true, force: true });
  });

  function makeRoutingRuntime(runtimeOptions: Record<string, unknown> = {}): { runtime: AgentRuntime; sentMessages: Array<{ jid: string; text: string }> } {
    const { messenger, sentMessages } = makeMessenger();
    const runtime = new AgentRuntime(routingDb, messenger, 'test', runtimeOptions);
    // Mirror the flag-gated schema init that runtime.start() performs in
    // production (tests do not call start(); its other side effects are
    // out of scope here).
    if (cfgAny().nlRouting === true) ensurePrefSchema?.(routingDb);
    return { runtime, sentMessages };
  }

  function handleRoutingEvent(runtime: AgentRuntime, event: AgentEvent): void {
    handleEventDownstreamWithoutAdmission(runtime, event, {
      queue: { ...mockQueue, targetChatJid: CHAT },
    });
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
    expect(allReplies(sentMessages).join('\n')).toContain('Pinned my strongest model for 24h');
    const events = await readEvents();
    expect(events.some((e) => e.event === 'model_preference_set' && e.reasonCode === 'intent_strongest_set')).toBe(true);
  });

  it('/model status renders the recorded preference and (b28 r2b) omits the Delegation/Authority lines', async () => {
    const { runtime, sentMessages } = makeRoutingRuntime();
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model strongest' }));
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model status' }));
    const status = allReplies(sentMessages).find((t) => t.includes('*Current route:*'));
    expect(status).toBeDefined();
    // D13a copy fix: chat-scoped, last-writer-wins — "for you" mis-implies
    // per-user ownership, so the line now names the chat, not the sender.
    expect(status).toContain('Saved preference: strongest');
    expect(status).toContain('steers new sessions');
    // b28 r2b: the Delegation/Authority display lines were removed from this
    // surface (the invariant lives in the system prompt). D11: /why is gone —
    // its "no delegation" reassurance is folded into this render instead.
    expect(status).not.toContain('Authority:');
    expect(status).not.toContain('Delegation:');
    expect(status).not.toContain('no live actions authorized');
    expect(status).toContain('routing never changes what I am allowed to do');
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

  // ── EXECPROFILE-CI-FIX Finding 2 (PLAN.md §5b): resolveRoute's pin/tier
  // branches unconditionally discard the target provider's config model
  // (`model: undefined`), even though routablePinTargets/isEntryCredentialed
  // just proved that SAME target eligible using its REAL configured model
  // (fallback-config.ts: resolveProviderCredentialState reads entry.model).
  // For opencode-cli (FALLBACK_MODEL_REQUIRED_PROVIDER_IDS), buildChildEnv
  // hard-throws on a null model (session.ts:261) — so a null-model route to
  // an eligible opencode-cli fallback/tier target is a live production crash,
  // not a hypothetical. These two tests drive the REAL, unmocked
  // resolveRouteForTurn / routablePinTargets / isEntryCredentialed path (only
  // SessionManager itself is file-mocked) and assert the config's own
  // validated model is threaded through instead of discarded.
  it('an eligible pin to a configured opencode-cli fallback threads its validated model into the spawn (Finding 2 — pin branch, production reachability)', async () => {
    // ZAI_API_KEY makes the 'glm' credential PRESENT for real (unmocked)
    // lookupCredential — env-first lookup, no keychain dependency — so the
    // REAL eligibility probe (not a stub) reports opencode-cli routable.
    const savedZaiKey = process.env.ZAI_API_KEY;
    process.env.ZAI_API_KEY = 'test-zai-key';
    try {
      cfgAny().agentFallbacks = [{ provider: 'opencode-cli', model: 'glm/test-model' }];
      const first = makeRoutingRuntime();
      await sendAndDrain(first.runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model opencode-cli' }));
      // The pin must be ACCEPTED (eligible) — a rejected pin would prove
      // nothing about the model-discard bug.
      expect(prefRows()).toHaveLength(1);
      const { runtime } = makeRoutingRuntime();
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: 'hello there', messageId: 'msg-2' }));
      const opts = capturedSessionManagerOptsRef.current as unknown as { provider?: string; model?: string } | null;
      expect(opts).not.toBeNull();
      expect(opts?.provider).toBe('opencode-cli');
      // THE BUG: pre-fix this is `undefined` — the exact null buildChildEnv
      // (session.ts:261) hard-throws on for a real, unmocked SessionManager.
      // THE FIX: the fallback entry's own validated model must be threaded
      // through instead of discarded.
      expect(opts?.model).toBe('glm/test-model');
    } finally {
      if (savedZaiKey === undefined) delete process.env.ZAI_API_KEY;
      else process.env.ZAI_API_KEY = savedZaiKey;
    }
  });

  it('an eligible tier route to a configured opencode-cli target threads its validated model into the spawn (Finding 2 — tier branch)', async () => {
    const savedZaiKey = process.env.ZAI_API_KEY;
    process.env.ZAI_API_KEY = 'test-zai-key';
    try {
      cfgAny().agentFallbacks = [{ provider: 'opencode-cli', model: 'glm/test-model' }];
      cfgAny().nlRoutingTiers = { strongest: 'opencode-cli' };
      const first = makeRoutingRuntime();
      await sendAndDrain(first.runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model strongest' }));
      const { runtime } = makeRoutingRuntime();
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: 'hello there', messageId: 'msg-2' }));
      const opts = capturedSessionManagerOptsRef.current as unknown as { provider?: string; model?: string } | null;
      expect(opts).not.toBeNull();
      expect(opts?.provider).toBe('opencode-cli');
      expect(opts?.model).toBe('glm/test-model');
      const events = await readEvents();
      expect(events.some((e) => e.reasonCode === 'intent_strongest')).toBe(true);
    } finally {
      if (savedZaiKey === undefined) delete process.env.ZAI_API_KEY;
      else process.env.ZAI_API_KEY = savedZaiKey;
    }
  });

  it('group preferences are chat-scoped on READ (D13 read-collapse): A sets, B sees the same active preference', async () => {
    // D13/D13a: the store still WRITES per-sender (the row below is still
    // keyed to SENDER_A — that part of the contract is unchanged), but the
    // runtime READ is now chat-scoped last-writer-wins, so sender B's own
    // /model status reflects A's pin as the chat's active preference rather
    // than "none". (Pre-D13 this test asserted 'Preference: none' for B —
    // that was the old per-sender READ contract; the owner chose
    // last-writer-wins for the read side. C3's copy fix closes the "for you"
    // nuance flagged here — the render now labels the saved chat preference
    // without claiming that it is necessarily the active route.)
    const { runtime, sentMessages } = makeRoutingRuntime();
    await sendAndDrain(runtime, makeMsg({ chatJid: GROUP, senderJid: SENDER_A, isGroup: true, content: '/model strongest' }));
    await sendAndDrain(runtime, makeMsg({ chatJid: GROUP, senderJid: SENDER_B, isGroup: true, content: '/model status', messageId: 'msg-2' }));
    const bStatus = allReplies(sentMessages).find((t) => t.includes('*Current route:*'));
    expect(bStatus).toContain('Saved preference: strongest');
    // WRITE stays per-sender — unchanged (only the read collapsed).
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
    expect(durability.completeInbound).toHaveBeenCalledWith(42, 'local_command_handled');
  });

  it('a BASE local command (/status) also terminally completes the inbound journal (R14)', async () => {
    const { runtime } = makeRoutingRuntime();
    const durability = {
      completeInbound: vi.fn(),
      markContinuityCandidateIfNoTerminalOutbound: vi.fn(() => true),
      markInboundFailed: vi.fn(),
      upsertSessionCheckpoint: vi.fn(),
    };
    (runtime as unknown as { durability: unknown }).durability = durability;
    // Base local commands share the stuck-'processing' gap the aliases had —
    // R14 completes the journal for every locally-handled command, not a name list.
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/status', inboundSeq: 77 }));
    expect(durability.completeInbound).toHaveBeenCalledWith(77, 'local_command_handled');
  });

  it('/why is removed: forwards to the session rather than rendering a route receipt locally (D11)', async () => {
    const { runtime, sentMessages } = makeRoutingRuntime();
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/why' }));
    // No local "Route:" receipt is rendered — /why is no longer a registry
    // entry, so classifyInput forwards it raw (the reassurance it used to
    // carry now lives on /model status instead — see the D11 fold test above).
    expect(allReplies(sentMessages).some((t) => t.includes('Route:'))).toBe(false);
    const forwarded = (mockSession.sendTurn.mock.calls as unknown as [string][]).map((c) => c[0]);
    expect(forwarded.some((t) => t.includes('/why'))).toBe(true);
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
    expect(typeof offOpts.routingSystemBlock).toBe('undefined');
  });

  // These marker tests exercise downstream routing after admission has already
  // supplied the active chat and actor; source admission is covered separately.
  it('NL typed-intent marker feeds the SAME preference path as the aliases and is stripped from delivery', async () => {
    const { runtime } = makeRoutingRuntime();
    await runtime.handleMessage(makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: 'use your best model' }));
    (runtime as unknown as Record<string, unknown>).currentTurnReplayActorJid = SENDER_A;
    (runtime as unknown as Record<string, unknown>).activeChatJid = CHAT;
    mockQueue.enqueueStreamingText.mockClear();
    handleRoutingEvent(runtime, {
      type: 'assistant_text',
      text: '[[wa-route: strongest]]\nOkay — from your next session.',
    });
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
    handleRoutingEvent(runtime, {
      type: 'assistant_text',
      text: '[[wa-route: give-me-admin]]\nSure.',
    });
    expect(mockQueue.enqueueStreamingText).toHaveBeenCalledWith('Sure.');
    expect(prefRows()).toHaveLength(0);
  });

  it('a marker-only reply delivers nothing but still applies the intent', async () => {
    const { runtime } = makeRoutingRuntime();
    await runtime.handleMessage(makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: 'be quick' }));
    (runtime as unknown as Record<string, unknown>).currentTurnReplayActorJid = SENDER_A;
    (runtime as unknown as Record<string, unknown>).activeChatJid = CHAT;
    mockQueue.enqueueStreamingText.mockClear();
    handleRoutingEvent(runtime, {
      type: 'assistant_text',
      text: '[[wa-route: fastest]]',
    });
    // The marker has no trailing newline, so the streaming-safe scan holds it
    // until the terminal result (text:null, as the token-streaming providers
    // emit for a streamed reply) flushes it — registering the intent.
    handleRoutingEvent(runtime, { type: 'result', text: null });
    expect(mockQueue.enqueueStreamingText).not.toHaveBeenCalled();
    expect(prefRows()[0]?.intent).toBe('fastest');
  });

  it('a marker split across streaming token deltas never leaks and still registers (R1)', async () => {
    const { runtime } = makeRoutingRuntime();
    await runtime.handleMessage(makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: 'use your best model' }));
    (runtime as unknown as Record<string, unknown>).currentTurnReplayActorJid = SENDER_A;
    (runtime as unknown as Record<string, unknown>).activeChatJid = CHAT;
    (runtime as unknown as { perChatRouteMarkerHold: Map<string, string> })
      .perChatRouteMarkerHold.set('__global__', '');
    mockQueue.enqueueStreamingText.mockClear();
    // anthropic-api / openai-api stream one token fragment at a time with no
    // itemId, so the [[wa-route: …]] envelope is split across deltas.
    handleRoutingEvent(runtime, { type: 'assistant_text', text: '[[wa-route: ' });
    handleRoutingEvent(runtime, { type: 'assistant_text', text: 'strongest]]\n' });
    handleRoutingEvent(runtime, {
      type: 'assistant_text',
      text: 'Okay — from your next session.',
    });
    const delivered = mockQueue.enqueueStreamingText.mock.calls.map(([t]) => String(t)).join('');
    expect(delivered).not.toContain('[[wa-route');
    expect(delivered).not.toContain('strongest]]');
    expect(delivered).toContain('Okay — from your next session.');
    const rows = prefRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].intent).toBe('strongest');
    expect(rows[0].sender_jid).toBe(SENDER_A);
  });

  it('a whitespace-only streamed reply is delivered under nlRouting, matching flag-off (R12)', async () => {
    const { runtime } = makeRoutingRuntime();
    await runtime.handleMessage(makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: 'hi' }));
    (runtime as unknown as Record<string, unknown>).currentTurnReplayActorJid = SENDER_A;
    (runtime as unknown as Record<string, unknown>).activeChatJid = CHAT;
    mockQueue.enqueueStreamingText.mockClear();
    // No marker, whitespace-only: the flag-off path delivers this, so flag-on
    // must too — it must not be swallowed by the marker-strip suppression.
    handleRoutingEvent(runtime, { type: 'assistant_text', text: '   ' });
    expect(mockQueue.enqueueStreamingText).toHaveBeenCalledWith('   ');
  });

  it('NL reset clears the row silently (the agent carries the acknowledgement)', async () => {
    const { runtime, sentMessages } = makeRoutingRuntime();
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model strongest' }));
    expect(prefRows()).toHaveLength(1);
    await runtime.handleMessage(makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: 'back to normal please', messageId: 'msg-2' }));
    (runtime as unknown as Record<string, unknown>).currentTurnReplayActorJid = SENDER_A;
    (runtime as unknown as Record<string, unknown>).activeChatJid = CHAT;
    handleRoutingEvent(runtime, {
      type: 'assistant_text',
      text: '[[wa-route: reset]]\nBack to normal.',
    });
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
    handleRoutingEvent(runtime, { type: 'assistant_text', text });
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
    handleRoutingEvent(runtime, {
      type: 'assistant_text',
      text: '[[wa-route: strongest]]\nDone.',
    });
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

  it('D12: /model default is no longer a local verb — it forwards raw and does NOT clear the preference locally (/reset is the undo)', async () => {
    const { runtime, sentMessages } = makeRoutingRuntime();
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model strongest' }));
    expect(prefRows()).toHaveLength(1);
    mockSession.sendTurn.mockClear();
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model default', messageId: 'msg-2' }));
    // The standalone verb is gone from the registry's subVerbs, so
    // classifyInput no longer recognizes "/model default" as structured
    // local grammar (F04 fallthrough) — the preference row survives...
    expect(prefRows()).toHaveLength(1);
    expect(allReplies(sentMessages).some((t) => t.includes('Back to the default route'))).toBe(false);
    // ...and the raw command is forwarded untouched so the agent CLI's own
    // /model default still runs.
    const forwarded = (mockSession.sendTurn.mock.calls as unknown as [string][]).map((c) => c[0]);
    expect(forwarded.some((t) => t.includes('/model default'))).toBe(true);
  });

  it('/model status renders on the default route when the preference store read throws (R11)', async () => {
    const { runtime, sentMessages } = makeRoutingRuntime();
    // A store failure on a READ-ONLY status query must degrade, not error.
    routingDb.raw.exec('DROP TABLE chat_model_preference');
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model status' }));
    const replies = allReplies(sentMessages);
    expect(replies.some((t) => t.includes('*Current route:*'))).toBe(true);
    expect(replies.some((t) => t.includes('Saved preference: none'))).toBe(true);
    expect(replies.some((t) => t.includes('Something went wrong'))).toBe(false);
  });

  // D11: /why is removed — its R11 degrade-on-store-throw coverage is now
  // subsumed by the '/model status renders on the default route ...' test
  // above, since the folded reassurance lives on that same render.

  it('spawn fails OPEN to the default route when the pin-eligibility probe throws (R13)', async () => {
    const { runtime } = makeRoutingRuntime();
    // routablePinTargets does keyring I/O and was called OUTSIDE the pref-read
    // guard — a probe throw must degrade to the default route, never drop the turn.
    (runtime as unknown as { routablePinTargets: () => string[] }).routablePinTargets = () => {
      throw new Error('probe boom');
    };
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: 'hello' }));
    expect(capturedSessionManagerOptsRef.current).toBeTruthy();
    expect(mockSession.sendTurn).toHaveBeenCalled();
    expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ instance: 'test' }),
      'route resolution failed - routing on default',
    );
  });

  it('a pinned codex-cli session inherits the primary providerConfig incl. budget cap (R2)', async () => {
    // codex-cli is native-auth (no key service) → routable; it is neither the
    // primary nor an API sibling, so fallbackProviderConfigFor returns
    // undefined and the session must inherit agentProviderConfig (budget cap)
    // rather than spawn with providerConfig=undefined and no cost enforcement.
    cfgAny().agentProviderConfig = { budget: 5, model: 'primary-model' };
    cfgAny().agentFallbacks = [{ provider: 'codex-cli' }];
    const first = makeRoutingRuntime();
    await sendAndDrain(first.runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model codex-cli' }));
    const { runtime } = makeRoutingRuntime();
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: 'hello there', messageId: 'msg-2' }));
    const opts = capturedSessionManagerOptsRef.current as unknown as { provider?: string; providerConfig?: Record<string, unknown> };
    expect(opts.provider).toBe('codex-cli');
    expect(opts.providerConfig).toEqual({ budget: 5, model: 'primary-model' });
  });

  it('the routing prompt contract names the PINNED provider the session spawned on (R6)', async () => {
    cfgAny().agentFallbacks = [{ provider: 'codex-cli' }];
    const first = makeRoutingRuntime();
    await sendAndDrain(first.runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model codex-cli' }));
    const { runtime } = makeRoutingRuntime();
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: 'hello there', messageId: 'msg-2' }));
    const opts = capturedSessionManagerOptsRef.current as unknown as { provider?: string; routingSystemBlock?: () => string | null };
    expect(opts.provider).toBe('codex-cli');
    // The in-prompt route fact must match the provider the session runs on —
    // telling a codex-cli agent it is claude-cli contradicts /model status.
    const block = String(opts.routingSystemBlock?.());
    expect(block).toContain('current provider: codex-cli');
    expect(block).not.toContain('current provider: claude-cli');
  });

  it('/model status disambiguates configured fallback entries that share a provider (B23)', async () => {
    // Live exhibit: two DISTINCT configured fallback entries rendered
    // "opencode-cli → opencode-cli" — indistinguishable. When an entry
    // carries a model, the chain must render "provider (model)"; model-less
    // entries keep the bare provider label.
    cfgAny().agentFallbacks = [
      { provider: 'opencode-cli', model: 'glm-4.7' },
      { provider: 'opencode-cli', model: 'kimi-k3' },
    ];
    const { runtime, sentMessages } = makeRoutingRuntime();
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model status' }));
    const status = allReplies(sentMessages).find((t) => t.includes('*Current route:*'));
    expect(status).toBeDefined();
    // b28 r2a: the chain is now one `• ` bullet per entry, but the B23
    // discriminator holds — two DISTINCT same-provider entries stay
    // distinguishable because each carries its model.
    expect(status).toContain('Fallback chain (configured):');
    expect(status).toContain('• opencode-cli (glm-4.7)');
    expect(status).toContain('• opencode-cli (kimi-k3)');
    expect(status).not.toContain('opencode-cli (glm-4.7) → opencode-cli (kimi-k3)');
  });

  it('/model status shows the model on the active-window and Next lines when the fallback differs only by model (B25 F8)', async () => {
    // A same-provider fallback entry that pins a DIFFERENT model previously
    // suppressed the 'Next session' line entirely (provider-only guard) and
    // rendered the active-window line model-blind — the owner could not see
    // that new sessions route to a different model.
    cfgAny().agentFallbacks = [{ provider: 'claude-cli', model: 'haiku-fast' }];
    const { runtime, sentMessages } = makeRoutingRuntime();
    mockSession.getStatus.mockReturnValue({
      active: true,
      pid: 555,
      sessionId: 'sess-live',
      startedAt: new Date().toISOString(),
      messageCount: 1,
      lastMessageAt: null,
    });
    mockSession.getProviderId.mockReturnValue('claude-cli');
    (mockSession as unknown as Record<string, unknown>).getModelRef = vi.fn(() => 'opus-main');
    const state = runtime as unknown as {
      session: typeof mockSession;
      fallbackWindow: { activeUntil: number | null; activeEntry: unknown };
    };
    state.session = mockSession;
    state.fallbackWindow.activeUntil = Date.now() + 60_000;
    state.fallbackWindow.activeEntry = { provider: 'claude-cli', model: 'haiku-fast' };

    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model status' }));

    const status = allReplies(sentMessages).find((t) => t.includes('*Current route:*'));
    expect(status).toBeDefined();
    expect(status).toContain('Fallback: active — new sessions route via claude-cli (haiku-fast)');
    expect(status).toContain('Next session: claude-cli (haiku-fast)');
  });

  it('/model status suppresses the Next line when the live route matches provider AND model (B25 F8)', async () => {
    const { runtime, sentMessages } = makeRoutingRuntime();
    mockSession.getStatus.mockReturnValue({
      active: true,
      pid: 556,
      sessionId: 'sess-live-2',
      startedAt: new Date().toISOString(),
      messageCount: 1,
      lastMessageAt: null,
    });
    mockSession.getProviderId.mockReturnValue('claude-cli');
    (mockSession as unknown as Record<string, unknown>).getModelRef = vi.fn(() => undefined);
    (runtime as unknown as { session: typeof mockSession }).session = mockSession;

    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model status' }));

    const status = allReplies(sentMessages).find((t) => t.includes('*Current route:*'));
    expect(status).toBeDefined();
    expect(status).not.toContain('Next session:');
  });

  it('/model status keeps the bare provider label for model-less fallback entries (B23)', async () => {
    cfgAny().agentFallbacks = [
      { provider: 'codex-cli' },
      { provider: 'opencode-cli', model: 'kimi-k3' },
    ];
    const { runtime, sentMessages } = makeRoutingRuntime();
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model status' }));
    const status = allReplies(sentMessages).find((t) => t.includes('*Current route:*'));
    // b28 r2a: bulleted chain — a model-less entry keeps the bare provider
    // label, a model-bearing entry renders "provider (model)".
    expect(status).toContain('Fallback chain (configured):');
    expect(status).toContain('• codex-cli');
    expect(status).toContain('• opencode-cli (kimi-k3)');
    expect(status).not.toContain('codex-cli → opencode-cli (kimi-k3)');
  });

  it('/model status reports the PINNED provider as the next-session route, not the default (R7)', async () => {
    cfgAny().agentFallbacks = [{ provider: 'codex-cli' }];
    const { runtime, sentMessages } = makeRoutingRuntime();
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model codex-cli' }));
    // No live session yet — status must show the route the NEXT spawn resolves
    // to (the pin, via resolveRouteForTurn), not the instance default provider.
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model status', messageId: 'msg-2' }));
    const status = allReplies(sentMessages).find((t) => t.includes('*Current route:*'));
    expect(status).toBeDefined();
    expect(status).toContain('*Current route:* codex-cli');
    expect(status).not.toContain('*Current route:* claude-cli');
  });

  it('a configured tier whose provider is NOT credentialed degrades the spawn to the default route (R5 wiring)', async () => {
    // strongest → anthropic-api, but its apiKeyService is absent from every
    // credential source → not routable → the /model strongest spawn must land
    // on the default provider, never a keyless anthropic-api session.
    const absentService = `wa-test-absent-${Math.random().toString(36).slice(2)}`;
    cfgAny().agentProviderConfig = { apiKeyService: absentService };
    cfgAny().agentFallbacks = [{ provider: 'anthropic-api' }];
    cfgAny().nlRoutingTiers = { strongest: 'anthropic-api' };
    const first = makeRoutingRuntime();
    await sendAndDrain(first.runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model strongest' }));
    const { runtime } = makeRoutingRuntime();
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: 'hello there', messageId: 'msg-2' }));
    const opts = capturedSessionManagerOptsRef.current as unknown as { provider?: string };
    expect(opts.provider).toBe('claude-cli');
    expect(opts.provider).not.toBe('anthropic-api');
    const events = await readEvents();
    expect(events.some((e) => e.reasonCode === 'intent_strongest_unreachable')).toBe(true);
  });

  // ── B26 item 1: /model status must render the CONFIGURED primary model ────
  // Live canary exhibit: agentOptions.model='claude-opus-4-8' yet /model
  // status rendered 'Model: provider default' — runtime.ts:8361 read only the
  // live/next route model and never this.model. HONESTY RULE: the served
  // weight is unobservable, so the configured primary renders with an
  // explicit '(configured)' label; a genuinely absent config renders
  // 'provider default (not configured)'; a fallback-entry model stays bare
  // (it comes from a config entry).

  it('B26: /model status renders the configured primary model with the (configured) label when no fallback window is live', async () => {
    const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8' });
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model status' }));
    const status = allReplies(sentMessages).find((t) => t.includes('*Current route:*'));
    expect(status).toBeDefined();
    expect(status).toContain('Model: claude-opus-4-8 (configured)');
    expect(status).not.toContain('Model: provider default');
  });

  it('B26: /model status renders the configured primary even when the LIVE session carries no model ref (canary repro shape)', async () => {
    const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8' });
    mockSession.getStatus.mockReturnValue({
      active: true,
      pid: 771,
      sessionId: 'sess-b26',
      startedAt: new Date().toISOString(),
      messageCount: 1,
      lastMessageAt: null,
    });
    mockSession.getProviderId.mockReturnValue('claude-cli');
    (mockSession as unknown as Record<string, unknown>).getModelRef = vi.fn(() => undefined);
    (runtime as unknown as { session: typeof mockSession }).session = mockSession;
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model status' }));
    const status = allReplies(sentMessages).find((t) => t.includes('*Current route:*'));
    expect(status).toBeDefined();
    expect(status).toContain('Model: claude-opus-4-8 (configured)');
    expect(status).not.toContain('Model: provider default');
  });

  it('B26: /model status renders an honest not-configured label when config.model is genuinely absent', async () => {
    const { runtime, sentMessages } = makeRoutingRuntime(); // no model option
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model status' }));
    const status = allReplies(sentMessages).find((t) => t.includes('*Current route:*'));
    expect(status).toBeDefined();
    expect(status).toContain('Model: provider default (not configured)');
  });

  it('Slice 2: bare /model opens the drill Level-1 brand menu; explicit /model status shows the route readout', async () => {
    const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8' });
    // Bare /model no longer prints status — it opens the drill (owner-ratified);
    // status moved behind the explicit sub-verb, the (current) marker substitutes.
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model' }));
    const bare = allReplies(sentMessages).join('\n');
    expect(bare).toContain('*Pick a provider:*');
    expect(bare).not.toContain('*Current route:*');
    mockQueue.enqueueText.mockClear();
    sentMessages.length = 0;
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model status', messageId: 'msg-2' }));
    const explicit = allReplies(sentMessages).join('\n');
    expect(explicit).toContain('*Current route:*');
    expect(explicit).not.toContain('*Pick a provider:*');
  });

  it('B26: /model status keeps the fallback-entry model bare while a fallback window is live (existing behavior)', async () => {
    cfgAny().agentFallbacks = [{ provider: 'claude-cli', model: 'haiku-fast' }];
    const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8' });
    const state = runtime as unknown as {
      fallbackWindow: { activeUntil: number | null; activeEntry: unknown };
    };
    state.fallbackWindow.activeUntil = Date.now() + 60_000;
    state.fallbackWindow.activeEntry = { provider: 'claude-cli', model: 'haiku-fast' };
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model status' }));
    const status = allReplies(sentMessages).find((t) => t.includes('*Current route:*'));
    expect(status).toBeDefined();
    expect(status).toContain('Model: haiku-fast');
    expect(status).not.toContain('Model: haiku-fast (configured)');
    expect(status).not.toContain('claude-opus-4-8 (configured)');
  });

  it('reports the live route separately from the saved preference and effective fallback route', async () => {
    cfgAny().agentFallbacks = [{ provider: 'claude-cli', model: 'haiku-fast' }];
    const anthropicFn = vi.fn().mockResolvedValue({
      status: 'ok',
      ids: ['claude-opus-4-8', 'haiku-fast'],
    });
    const { runtime, sentMessages } = makeRoutingRuntime({
      model: 'claude-opus-4-8',
      modelCatalogueAnthropicFn: anthropicFn,
    });
    const state = runtime as unknown as {
      session: typeof mockSession;
      fallbackWindow: { activeUntil: number | null; activeEntry: unknown };
    };
    state.fallbackWindow.activeUntil = Date.now() + 60_000;
    state.fallbackWindow.activeEntry = { provider: 'claude-cli', model: 'haiku-fast' };

    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model list' }));
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model 1', messageId: 'pin-primary' }));
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model status', messageId: 'fallback-status' }));
    const fallbackStatus = allReplies(sentMessages).findLast((t) => t.includes('*Current route:*'));
    expect(fallbackStatus).toContain('Model: haiku-fast');
    expect(fallbackStatus).toContain('Saved preference: claude-opus-4-8');
    expect(fallbackStatus).toContain('health fallback currently decides new sessions');
    expect(fallbackStatus).not.toContain('This chat is on claude-opus-4-8');

    mockSession.getStatus.mockReturnValue({
      active: true,
      pid: 42,
      sessionId: 'live-primary',
      startedAt: new Date().toISOString(),
      messageCount: 1,
      lastMessageAt: new Date().toISOString(),
    });
    (mockSession as unknown as Record<string, unknown>).getModelRef = vi.fn(() => 'claude-opus-4-8');
    state.session = mockSession;
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model status', messageId: 'live-status' }));
    const liveStatus = allReplies(sentMessages).findLast((t) => t.includes('*Current route:*'));
    expect(liveStatus).toContain('Model: claude-opus-4-8 (configured)');
    expect(liveStatus).toContain('Next session: claude-cli (haiku-fast)');
  });

  // ── b28 r2b: /model status drops the Delegation + Authority DISPLAY lines ──
  // Owner round-2 ruling: those two lines are not about model/route status.
  // RENDER-ONLY removal — the routing-never-changes-authority invariant stays
  // in the agent system prompt + security layer. D11: the former /why
  // receipt is gone; its reassurance is now folded into this same render
  // (see the trailing "routing never changes" line asserted elsewhere).
  it('b28 r2b: /model status no longer renders the Delegation or Authority lines', async () => {
    const { runtime, sentMessages } = makeRoutingRuntime();
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model status' }));
    const status = allReplies(sentMessages).find((t) => t.includes('*Current route:*'));
    expect(status).toBeDefined();
    expect(status).not.toContain('Delegation:');
    expect(status).not.toContain('Authority:');
  });

  // ── b28 r2a: WhatsApp formatting — the configured fallback chain renders as
  // one `• ` bullet per entry (WhatsApp narrow column), never a long
  // ` → `-joined single line. Same-provider entries stay distinguishable
  // (B23 discriminator preserved through the reformat).
  it('b28 r2a: /model status renders the configured fallback chain as bullets, one per entry', async () => {
    cfgAny().agentFallbacks = [
      { provider: 'opencode-cli', model: 'kimi/kimi-k3' },
      { provider: 'opencode-cli', model: 'glm/glm-5.2' },
    ];
    const { runtime, sentMessages } = makeRoutingRuntime();
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model status' }));
    const status = allReplies(sentMessages).find((t) => t.includes('*Current route:*'));
    expect(status).toBeDefined();
    expect(status).toContain('Fallback chain (configured):');
    expect(status).toContain('• opencode-cli (kimi/kimi-k3)');
    expect(status).toContain('• opencode-cli (glm/glm-5.2)');
    // The pre-b28 defect: the whole chain crammed onto one ` → `-joined line.
    expect(status).not.toContain('opencode-cli (kimi/kimi-k3) → opencode-cli (glm/glm-5.2)');
    const bulletLines = status!.split('\n').filter((l) => l.startsWith('• '));
    expect(bulletLines).toHaveLength(2);
  });

});

// ── B3 / QR-143: inline imperative extractor admin-grant transport gate ───────
// The extractor auto-creates a status:'proposed' task bead for admin-authored
// imperatives. The admin GRANT must gate on authenticated transport BEFORE the
// phone match — resolvePhoneFromJid collapses <admin-digits>@sms to the admin
// phone, but @sms is spoofable, so it must not induce an admin-attributed
// proposal. Both directions proven against a REAL in-memory beads table.
describe('B3 inline imperative extractor — QR-143 transport gate', () => {
  const ADMIN_PN = '15550100001@s.whatsapp.net'; // config mock admin phone
  const ADMIN_SMS = '+15550100001@sms'; // spoofable: same bare digits as admin
  const IMPERATIVE = 'remind me to call Alex Friday';

  function makeRealDb(): RealDatabase {
    const db = new RealDatabase(':memory:');
    db.open();
    return db;
  }
  function proposedCount(db: RealDatabase): number {
    return (db.raw.prepare("SELECT COUNT(*) AS c FROM beads WHERE status = 'proposed'").get() as { c: number }).c;
  }

  it('ALLOWS an authenticated WhatsApp admin: imperative → proposed bead created (preserved)', async () => {
    const restoreMemory = setMockMemoryConfig();
    const db = makeRealDb();
    try {
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger);
      await sendAndDrain(runtime, makeMsg({ senderJid: ADMIN_PN, chatJid: ADMIN_PN, content: IMPERATIVE, messageId: 'b3-admin' }));
      expect(proposedCount(db)).toBe(1);
      await runtime.shutdown();
    } finally {
      db.close();
      restoreMemory();
    }
  });

  it('DENIES a spoofed <admin-digits>@sms: imperative → NO proposed bead (new)', async () => {
    const restoreMemory = setMockMemoryConfig();
    const db = makeRealDb();
    try {
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger);
      await sendAndDrain(runtime, makeMsg({ senderJid: ADMIN_SMS, chatJid: ADMIN_SMS, content: IMPERATIVE, messageId: 'b3-sms' }));
      expect(proposedCount(db)).toBe(0);
      await runtime.shutdown();
    } finally {
      db.close();
      restoreMemory();
    }
  });
});
