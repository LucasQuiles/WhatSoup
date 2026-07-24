/**
 * `/model` selection increment-1 characterization suite — the configured-model
 * catalogue render, the numbered pickable menu and its snapshot seam, the
 * chat-scoped model pin (`/model N`) with its pin-time catalogue verify, and
 * the live-session recycle that makes a pin or a /reset take effect.
 *
 * Split out of tests/runtimes/agent/runtime.test.ts alongside the
 * src/runtimes/agent/model-pin.ts + model-catalogue-render.ts extraction. The
 * tests themselves are unchanged; the mock preamble and the small helpers
 * below are copied from the parent suite because vi.mock factories are
 * file-scoped and cannot be shared across test files.
 */
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

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import { __resetModelCatalogueCacheForTest } from '../../../src/runtimes/agent/model-catalogue-resolver.ts';
import { Database as RealDatabase } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';

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
    // IncomingMessage.timestamp is Unix epoch SECONDS (core/types.ts;
    // production sets it via normalizeUnixTimestampSeconds) — not
    // Date.now()'s milliseconds. Bare-keep eligibility now does real
    // arithmetic on this field, so the unit must match the real contract.
    timestamp: Math.floor(Date.now() / 1000),
    quotedMessageId: null,
    contentText: null,
    isResponseWorthy: true,
    ...overrides,
  };
}

async function sendAndDrain(runtime: AgentRuntime, msg: IncomingMessage): Promise<void> {
  await runtime.handleMessage(msg);
  // Access the private turnChain field to wait for the queued inner work.
  await (runtime as unknown as { turnChain: Promise<void> }).turnChain;
}

async function emitAgentResult(inputTokens: number, text: string | null = null): Promise<void> {
  capturedOnEventRef.current?.({ type: 'result', text, inputTokens, outputTokens: 0 });
  await Promise.resolve();
}

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
    delete cfgAny().agentProviderDataPolicy;
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

  it('passes a frozen route policy from production turn resolution into SessionManager', async () => {
    cfgAny().agentProviderDataPolicy = 'trusted';
    const { runtime } = makeRoutingRuntime();

    await sendAndDrain(runtime, makeMsg({
      chatJid: CHAT,
      senderJid: SENDER_A,
      content: 'hello',
    }));

    const opts = capturedSessionManagerOptsRef.current as unknown as {
      routePolicy?: Record<string, unknown>;
    } | null;
    expect(opts?.routePolicy).toMatchObject({
      provider: 'claude-cli',
      dataPolicy: 'trusted',
      pinnedProvider: null,
    });
    expect(Object.isFrozen(opts?.routePolicy)).toBe(true);
  });

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

  it('D13: a chat-scoped pin steers a DIFFERENT sender turn to the same route (read-collapse at spawn)', async () => {
    // Mirrors 'a routable pin steers the NEXT session spawn' above, but the
    // pin is set by SENDER_A and the spawning turn is SENDER_B's — proving
    // resolveRouteForTurn (via loadSenderPreference) is now chat-scoped, not
    // just the /model status render.
    cfgAny().agentFallbacks = [{ provider: 'codex-cli' }];
    const first = makeRoutingRuntime();
    await sendAndDrain(first.runtime, makeMsg({ chatJid: GROUP, senderJid: SENDER_A, isGroup: true, content: '/model codex-cli' }));
    const { runtime } = makeRoutingRuntime();
    await sendAndDrain(runtime, makeMsg({ chatJid: GROUP, senderJid: SENDER_B, isGroup: true, content: 'hello there', messageId: 'msg-2' }));
    const opts = capturedSessionManagerOptsRef.current as unknown as { provider?: string; model?: string };
    expect(opts).not.toBeNull();
    expect(opts?.provider).toBe('codex-cli');
  });

  it('carry-forward-e: sender A pins in a group, sender B /resets — the chat pin is gone for everyone (D13 chat-scoped clear)', async () => {
    // Proves the SEMANTIC reversal on the clear command, not just the row
    // count: A pins (chat-scoped write, still keyed to A per D13a), B — who
    // never set anything — /resets, and the pin is gone for BOTH the read
    // (/model status) and the next spawn, for either sender.
    cfgAny().agentFallbacks = [{ provider: 'codex-cli' }];
    const { runtime, sentMessages } = makeRoutingRuntime();
    await sendAndDrain(runtime, makeMsg({ chatJid: GROUP, senderJid: SENDER_A, isGroup: true, content: '/model codex-cli' }));
    expect(prefRows()).toHaveLength(1);
    await sendAndDrain(runtime, makeMsg({ chatJid: GROUP, senderJid: SENDER_B, isGroup: true, content: '/reset', messageId: 'msg-2' }));
    // D13: /reset is chat-scoped — clears EVERY sender's row for the chat,
    // not just B's own (B never had one).
    expect(prefRows()).toHaveLength(0);
    await sendAndDrain(runtime, makeMsg({ chatJid: GROUP, senderJid: SENDER_A, isGroup: true, content: '/model status', messageId: 'msg-3' }));
    const status = allReplies(sentMessages).find((t) => t.includes('*Current route:*'));
    expect(status).toContain('Saved preference: none');
    await sendAndDrain(runtime, makeMsg({ chatJid: GROUP, senderJid: SENDER_B, isGroup: true, content: 'hello there', messageId: 'msg-4' }));
    const opts = capturedSessionManagerOptsRef.current as unknown as { provider?: string };
    expect(opts?.provider).toBe('claude-cli');
  });

  // ── B26 item 2 / C3: /model list — the config-derived model catalogue ─────
  // Rendered ENTIRELY from config (the primary, the fallback chain) — the
  // served model is unobservable, so nothing here claims to be it. D15: the
  // strongest/fastest verb mapping is hidden entirely (not just "unconfigured
  // — default routing") when nlRoutingTiers is absent — advertising a no-op
  // verb is worse than omitting it.

  it('C3: /model list renders the configured primary and every fallback entry, plain language', async () => {
    cfgAny().agentFallbacks = [
      { provider: 'opencode-cli', model: 'kimi/kimi-k3' },
      { provider: 'opencode-cli', model: 'glm/glm-5.2' },
    ];
    const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8' });
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model list' }));
    const catalogue = allReplies(sentMessages).find((t) => t.includes('*Configured models*'));
    expect(catalogue).toBeDefined();
    // b28 r2d: one bullet per MODEL (primary + each fallback), never a joined chain.
    expect(catalogue).toContain('• Primary: claude-cli (claude-opus-4-8 — configured)');
    expect(catalogue).toContain('• Fallback: opencode-cli (kimi/kimi-k3)');
    expect(catalogue).toContain('• Fallback: opencode-cli (glm/glm-5.2)');
    expect(catalogue).not.toContain('opencode-cli (kimi/kimi-k3) → opencode-cli (glm/glm-5.2)');
    // D6: the jargon pin hint is gone from this synchronous block — the
    // pickable menu (with its own "reply /model N" affordance) is the
    // dynamic follow-up section, asserted separately below.
    expect(catalogue).not.toContain('/model provider-id');
  });

  it('b28 r2d: /model list renders one bullet per model (primary + each fallback), no invented lifecycle tag for unrecognized ids', async () => {
    cfgAny().agentFallbacks = [
      { provider: 'opencode-cli', model: 'kimi/kimi-k3' },
      { provider: 'opencode-cli', model: 'glm/glm-5.2' },
    ];
    const { runtime, sentMessages } = makeRoutingRuntime(); // canary: no primary model
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model list' }));
    const catalogue = allReplies(sentMessages).find((t) => t.includes('*Configured models*'));
    expect(catalogue).toBeDefined();
    expect(catalogue).toContain('• Primary: claude-cli (provider default — no model configured)');
    expect(catalogue).toContain('• Fallback: opencode-cli (kimi/kimi-k3)');
    expect(catalogue).toContain('• Fallback: opencode-cli (glm/glm-5.2)');
    expect(catalogue).not.toContain('opencode-cli (kimi/kimi-k3) → opencode-cli (glm/glm-5.2)');
    // D6: the deleted D7 caveat line is gone — no replacement string either.
    expect(catalogue).not.toContain('is not observable here');
    // Unrecognized third-party IDs → NO invented lifecycle modifier (D7 honesty).
    expect(catalogue).not.toContain('[newer:');
    expect(catalogue).not.toContain('[deprecated');
  });

  it('b28 r2d: /model list tags config-derived modifiers — a legacy primary model and a configured strongest target', async () => {
    cfgAny().agentFallbacks = [{ provider: 'anthropic-api' }];
    cfgAny().nlRoutingTiers = { strongest: 'anthropic-api' };
    const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-5' });
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model list' }));
    const catalogue = allReplies(sentMessages).find((t) => t.includes('*Configured models*'));
    expect(catalogue).toBeDefined();
    // Legacy primary → catalog advisory modifier, derived from the configured ID.
    expect(catalogue).toContain(
      '• Primary: claude-cli (claude-opus-4-5 — configured) [newer: claude-opus-4-8]',
    );
    // Fallback provider IS the configured strongest target → tag (from config).
    expect(catalogue).toContain('• Fallback: anthropic-api [strongest]');
  });

  it('D15: /model list hides the strongest/fastest mapping entirely when no tiers are configured (no-op must not be advertised)', async () => {
    // Canary shape: nlRoutingTiers ABSENT — strongest/fastest fall to the
    // default route. D15: the whole line is omitted, not "unconfigured".
    const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8' });
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model list' }));
    const catalogue = allReplies(sentMessages).find((t) => t.includes('*Configured models*'));
    expect(catalogue).toBeDefined();
    expect(catalogue).not.toContain('strongest →');
    expect(catalogue).not.toContain('fastest →');
    expect(catalogue).not.toMatch(/\btier\b/i);
  });

  it('B26: /model list renders the nlRoutingTiers mappings when configured', async () => {
    cfgAny().nlRoutingTiers = { strongest: 'anthropic-api' };
    const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8' });
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model list' }));
    const catalogue = allReplies(sentMessages).find((t) => t.includes('*Configured models*'));
    expect(catalogue).toBeDefined();
    expect(catalogue).toContain('strongest → anthropic-api');
    expect(catalogue).toContain('fastest → not configured (default route)');
  });

  it('B26: /model list stays honest when no primary model and no fallbacks are configured', async () => {
    const { runtime, sentMessages } = makeRoutingRuntime();
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model list' }));
    const catalogue = allReplies(sentMessages).find((t) => t.includes('*Configured models*'));
    expect(catalogue).toBeDefined();
    expect(catalogue).toContain('Primary: claude-cli (provider default — no model configured)');
    expect(catalogue).toContain('Fallbacks: none configured');
  });

  // ── C3: plain-language guard — the banned-jargon words must never appear
  // anywhere in a /model list reply (the D6 beta-test failure #2 fix).
  it('C3: /model list never renders the banned jargon words (line/tier/weight)', async () => {
    cfgAny().agentFallbacks = [
      { provider: 'opencode-cli', model: 'kimi/kimi-k3' },
      { provider: 'opencode-cli', model: 'glm/glm-5.2' },
    ];
    cfgAny().nlRoutingTiers = { strongest: 'opencode-cli' };
    const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8' });
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model list' }));
    const combined = allReplies(sentMessages).join('\n');
    expect(combined).not.toMatch(/\bline\b/i);
    expect(combined).not.toMatch(/\btier\b/i);
    expect(combined).not.toMatch(/\bweight\b/i);
  });

  // ── C3/D6/D16/D17: the numbered pickable menu — the dynamic follow-up
  // section must become a genuine menu (numbers + a reply affordance), not a
  // status readout (the beta-test's #1 failure).
  describe('C3: pickable /model list menu + snapshot seam', () => {
    it('renders a dense, flat, 1-based numbered menu across primary + every named fallback, with a reply affordance', async () => {
      cfgAny().agentFallbacks = [
        { provider: 'opencode-cli', model: 'kimi/kimi-k3' },
        { provider: 'opencode-cli', model: 'glm/glm-5.2' },
      ];
      const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8' });
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model list' }));
      const menu = allReplies(sentMessages).find((t) => t.includes('*Pick a model:*'));
      expect(menu).toBeDefined();
      expect(menu).toContain('1. claude-cli (claude-opus-4-8) (active route)');
      expect(menu).toContain('2. opencode-cli (kimi/kimi-k3)');
      expect(menu).toContain('3. opencode-cli (glm/glm-5.2)');
      expect(menu).toContain('Reply `/model N` to switch to that one.');
    });

    it('acknowledges a verified exact model pin honored within the active fallback provider', async () => {
      cfgAny().agentFallbacks = [
        { provider: 'claude-cli', model: 'haiku-fast' },
        { provider: 'claude-cli', model: 'claude-opus-4-8' },
      ];
      const anthropicFn = vi.fn().mockResolvedValue({
        status: 'ok',
        ids: ['claude-opus-4-8', 'haiku-fast'],
      });
      const { runtime, sentMessages } = makeRoutingRuntime({
        model: 'claude-opus-4-8',
        modelCatalogueAnthropicFn: anthropicFn,
      });
      const state = runtime as unknown as {
        fallbackWindow: { activeUntil: number | null; activeEntry: unknown };
      };
      state.fallbackWindow.activeUntil = Date.now() + 60_000;
      state.fallbackWindow.activeEntry = { provider: 'claude-cli', model: 'haiku-fast' };

      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model list' }));
      const menu = allReplies(sentMessages).find((t) => t.includes('*Pick a model:*'));
      expect(menu).toContain('1. claude-cli (claude-opus-4-8)');
      expect(menu).not.toContain('claude-opus-4-8) (active route)');
      expect(menu).toContain('2. claude-cli (haiku-fast) (active route)');

      await sendAndDrain(runtime, makeMsg({
        chatJid: CHAT,
        senderJid: SENDER_A,
        content: '/model 1',
        messageId: 'model-primary-during-fallback',
      }));
      const reply = allReplies(sentMessages).join('\n');
      expect(reply).toContain('Now answering with claude-opus-4-8');
      expect(reply).not.toContain('new sessions still use claude-cli (haiku-fast)');
    });

    it('reconfirms a verified exact model pin without falsely claiming fallback overrides it', async () => {
      cfgAny().agentFallbacks = [
        { provider: 'claude-cli', model: 'haiku-fast' },
        { provider: 'claude-cli', model: 'claude-opus-4-8' },
      ];
      const anthropicFn = vi.fn().mockResolvedValue({
        status: 'ok',
        ids: ['claude-opus-4-8', 'haiku-fast'],
      });
      const { runtime, sentMessages } = makeRoutingRuntime({
        model: 'claude-opus-4-8',
        modelCatalogueAnthropicFn: anthropicFn,
      });
      const state = runtime as unknown as {
        fallbackWindow: { activeUntil: number | null; activeEntry: unknown };
      };
      state.fallbackWindow.activeUntil = Date.now() + 60_000;
      state.fallbackWindow.activeEntry = { provider: 'claude-cli', model: 'haiku-fast' };

      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model list' }));
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model 1', messageId: 'pin-primary' }));
      mockQueue.enqueueText.mockClear();
      sentMessages.length = 0;
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model 1', messageId: 'reconfirm-primary' }));

      const reply = allReplies(sentMessages).join('\n');
      expect(reply).toContain('Already set — extended for another 24h');
      expect(reply).not.toContain('new sessions still use claude-cli (haiku-fast)');
    });

    it('keeps the live session marked active when fallback only controls the next session', async () => {
      cfgAny().agentFallbacks = [{ provider: 'claude-cli', model: 'haiku-fast' }];
      mockSession.getStatus.mockReturnValue({
        active: true,
        pid: 42,
        sessionId: 'live-primary',
        startedAt: new Date().toISOString(),
        messageCount: 1,
        lastMessageAt: new Date().toISOString(),
      });
      (mockSession as unknown as Record<string, unknown>).getModelRef = vi.fn(() => 'claude-opus-4-8');
      const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8' });
      const state = runtime as unknown as {
        session: typeof mockSession;
        fallbackWindow: { activeUntil: number | null; activeEntry: unknown };
      };
      state.session = mockSession;
      state.fallbackWindow.activeUntil = Date.now() + 60_000;
      state.fallbackWindow.activeEntry = { provider: 'claude-cli', model: 'haiku-fast' };

      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model list' }));
      const menu = allReplies(sentMessages).find((t) => t.includes('*Pick a model:*'));
      expect(menu).toContain('1. claude-cli (claude-opus-4-8) (active route)');
      expect(menu).not.toContain('haiku-fast) (active route)');
    });

    it('snapshots the SAME ordered (providerId, id) entries the numbers were rendered from (shared-entries invariant)', async () => {
      cfgAny().agentFallbacks = [{ provider: 'opencode-cli', model: 'kimi/kimi-k3' }];
      const { runtime } = makeRoutingRuntime({ model: 'claude-opus-4-8' });
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model list' }));
      const snapshot = (runtime as unknown as {
        catalogueSnapshot: { resolveCataloguePick: (jid: string, senderJid: string, n: number) => { providerId: string; id: string } | null };
      }).catalogueSnapshot;
      expect(snapshot.resolveCataloguePick(CHAT, SENDER_A, 1)).toEqual({ providerId: 'claude-cli', id: 'claude-opus-4-8' });
      expect(snapshot.resolveCataloguePick(CHAT, SENDER_A, 2)).toEqual({ providerId: 'opencode-cli', id: 'kimi/kimi-k3' });
      // Out of range → miss, never a wraparound or a stale guess.
      expect(snapshot.resolveCataloguePick(CHAT, SENDER_A, 3)).toBeNull();
    });

    // IMPORTANT 2 (final-review): the numbered snapshot must be captured
    // per-(chat, sender) — a second/filtered render by a DIFFERENT group
    // member must never repoint an earlier sender's still-pending pick.
    // Before this fix, the snapshot was keyed `latestByChat` with a
    // per-chat CONSTANT synthetic msgId, so B's render silently overwrote
    // A's — A's later `/model N` would then resolve against B's list.
    it("a filtered render by A then a full render by B does not repoint A's pending /model N pick", async () => {
      cfgAny().agentFallbacks = [
        { provider: 'opencode-cli', model: 'kimi/kimi-k3' },
        { provider: 'opencode-cli', model: 'glm/glm-5.2' },
      ];
      const listFn = vi.fn().mockResolvedValue({ status: 'ok', ids: ['kimi/kimi-k3', 'glm/glm-5.2'] });
      const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8', modelCatalogueListFn: listFn });

      // A renders a FILTERED menu — kimi only.
      await sendAndDrain(runtime, makeMsg({ chatJid: GROUP, senderJid: SENDER_A, isGroup: true, content: '/model list kimi' }));
      const aMenu = allReplies(sentMessages).find((t) => t.includes('*Pick a model:*'));
      expect(aMenu).toBeDefined();
      expect(aMenu).toContain('1. opencode-cli (kimi/kimi-k3)');
      expect(aMenu).not.toContain('glm');

      mockQueue.enqueueText.mockClear();
      sentMessages.length = 0;

      // B renders the FULL menu in the SAME chat — same synthetic per-chat
      // msgId a pre-fix cache would have overwritten A's slot with.
      await sendAndDrain(runtime, makeMsg({ chatJid: GROUP, senderJid: SENDER_B, isGroup: true, content: '/model list', messageId: 'msg-2' }));
      const bMenu = allReplies(sentMessages).find((t) => t.includes('*Pick a model:*'));
      expect(bMenu).toBeDefined();
      expect(bMenu).toContain('1. claude-cli (claude-opus-4-8) (active route)');
      expect(bMenu).toContain('2. opencode-cli (kimi/kimi-k3)');
      expect(bMenu).toContain('3. opencode-cli (glm/glm-5.2)');

      mockQueue.enqueueText.mockClear();
      sentMessages.length = 0;

      // A picks N=1 — must still resolve against what A SAW (kimi), never
      // silently pin whatever landed at B's slot 1 (the current primary).
      await sendAndDrain(runtime, makeMsg({ chatJid: GROUP, senderJid: SENDER_A, isGroup: true, content: '/model 1', messageId: 'msg-3' }));
      const rows = prefRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].requested_provider).toBe('opencode-cli');
      expect(rows[0].requested_model).toBe('kimi/kimi-k3');
      expect(rows[0].requested_model).not.toBe('claude-opus-4-8');
    });

    it('a fallback with no configured model does not get a number, but IS still shown as a bullet in the config block', async () => {
      cfgAny().agentFallbacks = [{ provider: 'codex-cli' }]; // no model set
      const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8' });
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model list' }));
      const config = allReplies(sentMessages).find((t) => t.includes('*Configured models*'));
      expect(config).toContain('• Fallback: codex-cli');
      const menu = allReplies(sentMessages).find((t) => t.includes('*Pick a model:*'));
      expect(menu).toBeDefined();
      expect(menu).toContain('1. claude-cli (claude-opus-4-8) (active route)');
      expect(menu).not.toContain('codex-cli');
    });
  });

  // ── C3/D6/D10/D16: the deterministic 1-step apply — /model N resolves the
  // snapshot and writes a MODEL-level pin in one step; /model N default pins
  // the provider only; a miss is a DISCLOSED re-render, never a silent pick.
  describe('C3: /model N apply — hit/miss/N-default', () => {
    it('HIT: /model N writes a model-level pin, verifies it at pin time against the catalogue, and echoes the D10 affordance (Task H)', async () => {
      cfgAny().agentFallbacks = [{ provider: 'opencode-cli', model: 'kimi/kimi-k3' }];
      // Injected — a real (un-injected) listFn would spawn the opencode
      // binary from a test path; this fake is the ONLY catalogue source a
      // test in this suite may ever touch (Task H guardrail).
      const listFn = vi.fn().mockResolvedValue({ status: 'ok', ids: ['kimi/kimi-k3'] });
      const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8', modelCatalogueListFn: listFn });
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model list' }));
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model 2', messageId: 'msg-2' }));
      const rows = prefRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].intent).toBe('provider_specific');
      expect(rows[0].requested_provider).toBe('opencode-cli');
      // F12 model-pin shape: requestedModel + validatedProvider populated.
      expect(rows[0].requested_model).toBe('kimi/kimi-k3');
      expect(rows[0].validated_provider).toBe('opencode-cli');
      // Task H: the pin-time verify (awaited before the echo) found the
      // model in the catalogue, so the row now persists VERIFIED — no
      // longer the pre-H unconditional `false` write.
      expect(rows[0].model_pin_verified).toBe(1);
      expect(listFn).toHaveBeenCalledTimes(1);
      const reply = allReplies(sentMessages).join('\n');
      expect(reply).toContain('Pinned kimi/kimi-k3 for 24h');
      expect(reply).toContain('reply keep to make it permanent, /reset to undo');
      // D10: the old deferral copy must never appear anywhere in this flow.
      expect(reply).not.toContain('applies from your next session');
      expect(reply).not.toContain('Applies from your next session');
    });

    it('HIT round-trip: a VERIFIED model-level pin survives read-back and drives both the preference line and the Model: line (Task H sync consumption)', async () => {
      // Proves the write survives chat-preference-db's strict cross-field
      // validation on READ (not just the raw row asserted above), AND that
      // resolveRouteForTurn's sync hot path (Task H) now actually consumes
      // the verified pin — the "Model:" line used to lag the pin (a
      // documented deferral pre-H); it now matches what /model N asked for.
      //
      // Same-provider (claude-cli) fallback entry, deliberately — a
      // cross-provider (e.g. opencode-cli) pin is credential-gated at ROUTE
      // time (routablePinTargets → a real per-model keyring lookup), which
      // is a separate concern from what this test targets (sync
      // consumption); claude-cli-on-claude-cli is unconditionally routable
      // (isEntryCredentialed's same-provider shortcut), isolating the thing
      // under test. This also exercises the anthropicFn injection seam
      // (claude-cli routes through resolveClaude, not resolveOpencode).
      cfgAny().agentFallbacks = [{ provider: 'claude-cli', model: 'claude-sonnet-5' }];
      const anthropicFn = vi.fn().mockResolvedValue({ status: 'ok', ids: ['claude-opus-4-8', 'claude-sonnet-5'] });
      const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8', modelCatalogueAnthropicFn: anthropicFn });
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model list' }));
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model 2', messageId: 'msg-2' }));
      expect(prefRows()[0].model_pin_verified).toBe(1);
      expect(anthropicFn).toHaveBeenCalledTimes(1);
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model status', messageId: 'msg-3' }));
      const status = allReplies(sentMessages).find((t) => t.includes('*Current route:*'));
      expect(status).toBeDefined();
      expect(status).toContain('Saved preference: claude-sonnet-5');
      // Task H: the Model: line is now pin-aware — the sync hot path in
      // resolveRouteForTurn set route.model to the verified pin, distinct
      // from the configured primary (claude-opus-4-8).
      expect(status).toContain('Model: claude-sonnet-5');
      expect(status).not.toContain('Model: claude-opus-4-8 (configured)');
    });

    it('DROP: a HIT model pin verified against a catalogue that no longer has it is cleared and disclosed, never left as a silent unverified orphan (Task H)', async () => {
      cfgAny().agentFallbacks = [{ provider: 'opencode-cli', model: 'kimi/kimi-k3' }];
      // The catalogue IS reachable but no longer lists the picked model —
      // decideModelPinResolution's `drop` branch.
      const listFn = vi.fn().mockResolvedValue({ status: 'ok', ids: ['some-other-model'] });
      const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8', modelCatalogueListFn: listFn });
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model list' }));
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model 2', messageId: 'msg-2' }));
      // Only a real fake-catalogue drop reaches this outcome — a real failed
      // spawn in CI would `defer` (row survives, unverified), never `drop`.
      expect(prefRows()).toHaveLength(0);
      expect(listFn).toHaveBeenCalledTimes(1);
      const reply = allReplies(sentMessages).join('\n');
      expect(reply).toContain("Couldn't pin kimi/kimi-k3");
      expect(reply).toContain('not in opencode-cli catalogue');
      expect(reply).toContain('Still on the default route');
      // The normal D10 echo must NOT also fire on a drop.
      expect(reply).not.toContain('Pinned kimi/kimi-k3 for 24h');
    });

    it("DEFER: a catalogue outage at pin time leaves the pin UNVERIFIED (fail-open), and the echo says so honestly instead of claiming the model is pinned/serving (Task H, MINOR 3 final-review)", async () => {
      cfgAny().agentFallbacks = [{ provider: 'opencode-cli', model: 'kimi/kimi-k3' }];
      const listFn = vi.fn().mockResolvedValue({ status: 'unavailable', reason: 'spawn-error' });
      const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8', modelCatalogueListFn: listFn });
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model list' }));
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model 2', messageId: 'msg-2' }));
      const rows = prefRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].requested_model).toBe('kimi/kimi-k3');
      expect(rows[0].validated_provider).toBe('opencode-cli');
      // Deferred, not verified — the write-time `false` stands unchanged.
      expect(rows[0].model_pin_verified).toBe(0);
      expect(listFn).toHaveBeenCalledTimes(1);
      const reply = allReplies(sentMessages).join('\n');
      // MINOR 3: the old unconditional "Pinned kimi/kimi-k3 for 24h" claimed
      // the model was pinned/serving even though decideModelPinResolution's
      // needs-catalogue fail-open means it demonstrably will NOT serve until
      // re-verified — the fix distinguishes this branch with honest copy.
      expect(reply).not.toContain('Pinned kimi/kimi-k3 for 24h');
      expect(reply).toContain("Pinned opencode-cli — kimi/kimi-k3 pending a catalogue check; using opencode-cli's default until then.");
      expect(reply).toContain('/reset to undo');
      expect(reply).not.toContain("Couldn't pin");
      // Plain-language hold: no line/tier/weight in the new copy either.
      expect(reply).not.toMatch(/\b(line|tier|weight)\b/i);
    });

    it('PROVIDER-CHANGED FAIL-OPEN: a verified pin against a DIFFERENT provider than the one resolving now never bleeds its model into the route (Task H)', async () => {
      // Direct DB seed via the runtime's own canonical-key derivation
      // (preferenceKeys) rather than the /model N flow — this constructs
      // the "verified against provider A, routing on provider B now" edge
      // deterministically, with zero catalogue-fn calls required (the sync
      // hot path returns `needs-catalogue` before ever touching a catalogue).
      const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8' });
      const prefMod = await import('../../../src/runtimes/agent/chat-preference-db.ts');
      const keysMod = await import('../../../src/runtimes/agent/preference-keys.ts');
      const { chatKey, senderKey } = keysMod.preferenceKeys(routingDb, CHAT, SENDER_A);
      const now = Date.now();
      prefMod.setPreference(routingDb, {
        chatJid: chatKey,
        senderJid: senderKey,
        intent: 'provider_specific',
        // agentProvider ('claude-cli') is unconditionally routable, so this
        // pin resolves without any credential probe — decision.provider
        // will be 'claude-cli'.
        requestedProvider: 'claude-cli',
        scope: 'this_thread',
        pinStrict: true,
        fallbackPermitted: false,
        updatedAt: now,
        expiresAt: now + 24 * 60 * 60 * 1000,
        requestedModel: 'exotic/model-x',
        // Verified against a DIFFERENT provider than the one that will
        // actually resolve — the provider-changed edge.
        validatedProvider: 'opencode-cli',
        modelPinVerified: true,
      });
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model status' }));
      const status = allReplies(sentMessages).find((t) => t.includes('*Current route:*'));
      expect(status).toBeDefined();
      // Fail-open: route.model stays the configured primary — the stale
      // cross-provider pin never bleeds into the resolved route.
      expect(status).toContain('Model: claude-opus-4-8 (configured)');
      expect(status).not.toContain('Model: exotic/model-x');
      // The preference DECLARATION line is a separate honesty axis (verified
      // bit only, same as the existing provider-pin behavior) — it still
      // names the pin even though it isn't the one actually serving.
      expect(status).toContain('Saved preference: exotic/model-x');
    });

    it('a verified exact model pin refines an active health failover only within its selected provider', async () => {
      cfgAny().agentFallbacks = [
        { provider: 'claude-cli', model: 'claude-haiku-4-5' },
        { provider: 'claude-cli', model: 'claude-sonnet-5' },
      ];
      const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8' });
      const prefMod = await import('../../../src/runtimes/agent/chat-preference-db.ts');
      const keysMod = await import('../../../src/runtimes/agent/preference-keys.ts');
      const { chatKey, senderKey } = keysMod.preferenceKeys(routingDb, CHAT, SENDER_A);
      const now = Date.now();
      prefMod.setPreference(routingDb, {
        chatJid: chatKey,
        senderJid: senderKey,
        intent: 'provider_specific',
        requestedProvider: 'claude-cli',
        scope: 'this_thread',
        pinStrict: true,
        fallbackPermitted: false,
        updatedAt: now,
        expiresAt: now + 24 * 60 * 60 * 1000,
        requestedModel: 'claude-sonnet-5',
        validatedProvider: 'claude-cli', // SAME provider the fallback window below will also select
        modelPinVerified: true,
      });
      const r = runtime as unknown as { armFallbackWindow: (until: number, reason: string) => boolean };
      // 'usage-limit' does not require an independent provider (fallback-config.ts
      // fallbackRequiresIndependentProbe) — a same-provider entry is a legal
      // selection, and same-provider is unconditionally credentialed
      // (isEntryCredentialed's shortcut), so this needs no keyring/catalogue mocking.
      expect(r.armFallbackWindow.call(runtime, Date.now() + 60_000, 'usage-limit')).toBe(true);
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model status' }));
      const status = allReplies(sentMessages).find((t) => t.includes('*Current route:*'));
      expect(status).toBeDefined();
      expect(status).toContain('Fallback: active');
      expect(status).toContain('Model: claude-sonnet-5');
      expect(status).not.toContain('Model: claude-haiku-4-5');
      expect(status).toContain('Saved preference: claude-sonnet-5');
      expect(status).toContain('active within the health fallback provider');
    });

    it('a verified model pin does NOT leak onto a pin_blocked_default route, even when validatedProvider coincidentally matches the default provider', async () => {
      // The pin's REQUESTED provider ('opencode-cli') is not routable, so
      // resolveRoute falls to pin_blocked_default and decision.provider
      // becomes the instance default (agentProvider, 'claude-cli') — never
      // the blocked provider. decision.source is 'pin_blocked_default', not
      // 'preference'. This is the case the looser `!== 'fallback'` gate
      // would get wrong: validatedProvider here is deliberately set to
      // 'claude-cli' (coincidentally equal to decision.provider), which
      // would make decideModelPinResolution say "use" if only a provider
      // match were checked — the explicit source==='preference' gate is
      // what actually stops the leak.
      const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8' });
      const prefMod = await import('../../../src/runtimes/agent/chat-preference-db.ts');
      const keysMod = await import('../../../src/runtimes/agent/preference-keys.ts');
      const { chatKey, senderKey } = keysMod.preferenceKeys(routingDb, CHAT, SENDER_A);
      const now = Date.now();
      prefMod.setPreference(routingDb, {
        chatJid: chatKey,
        senderJid: senderKey,
        intent: 'provider_specific',
        // Not the unconditionally-routable agentProvider, and not made
        // eligible via routablePinTargets — resolves to pin_blocked_default.
        requestedProvider: 'opencode-cli',
        scope: 'this_thread',
        pinStrict: true,
        fallbackPermitted: false,
        updatedAt: now,
        expiresAt: now + 24 * 60 * 60 * 1000,
        requestedModel: 'kimi/kimi-k3',
        // Deliberately the DEFAULT provider, not the requested one — the
        // edge case a provider-equality-only check would miss.
        validatedProvider: 'claude-cli',
        modelPinVerified: true,
      });
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model status' }));
      const status = allReplies(sentMessages).find((t) => t.includes('*Current route:*'));
      expect(status).toBeDefined();
      expect(status).toContain('Model: claude-opus-4-8 (configured)');
      expect(status).not.toContain('Model: kimi/kimi-k3');
    });

    it('MISS: /model N against an expired/absent snapshot is a DISCLOSED re-render, never a silent pick', async () => {
      cfgAny().agentFallbacks = [{ provider: 'opencode-cli', model: 'kimi/kimi-k3' }];
      const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8' });
      // No prior menu in this chat — no snapshot exists yet.
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model 2' }));
      expect(prefRows()).toHaveLength(0);
      const replies = allReplies(sentMessages);
      expect(replies.some((t) => t.includes("That list moved — here's the current one."))).toBe(true);
      // Slice 2: a true snapshot-miss (no live menu) re-renders the drill
      // Level-1 brand menu — the ratified entry point (bare /model opens it) —
      // not the flat catalogue. Disclosure is followed by a fresh, pickable
      // menu, never silence.
      expect(replies.some((t) => t.includes('*Pick a provider:*'))).toBe(true);
    });

    it('MISS: an out-of-range N against a live snapshot is also a disclosed re-render, no row written', async () => {
      const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8' }); // no fallbacks — 1 pickable entry
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model list' }));
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model 9', messageId: 'msg-2' }));
      expect(prefRows()).toHaveLength(0);
      const replies = allReplies(sentMessages);
      expect(replies.some((t) => t.includes("That list moved — here's the current one."))).toBe(true);
      // Slice 2 ANTI-BOUNCE: the sender is on the FLAT list, so the re-render
      // is the flat catalogue — an out-of-range typo must not yank them into
      // the drill (only a TRUE snapshot-miss opens Level-1).
      expect(replies.some((t) => t.includes('*Configured models*'))).toBe(true);
      expect(replies.some((t) => t.includes('*Pick a provider:*'))).toBe(false);
    });

    it('N-DEFAULT HIT: /model N default resolves the snapshot and pins the PROVIDER only (no model)', async () => {
      cfgAny().agentFallbacks = [{ provider: 'opencode-cli', model: 'kimi/kimi-k3' }];
      const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8' });
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model list' }));
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model 2 default', messageId: 'msg-2' }));
      const rows = prefRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].intent).toBe('provider_specific');
      expect(rows[0].requested_provider).toBe('opencode-cli');
      // Provider default — no model dimension at all (contrast with the HIT case above).
      expect(rows[0].requested_model).toBeNull();
      expect(rows[0].validated_provider).toBeNull();
      expect(rows[0].model_pin_verified).toBeNull();
      const reply = allReplies(sentMessages).join('\n');
      expect(reply).toContain('Pinned `opencode-cli` for 24h');
      expect(reply).not.toContain('applies from your next session');
    });

    it('N-DEFAULT MISS: an unresolvable N default is a disclosed re-render, no row written', async () => {
      const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8' });
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model 9 default' }));
      expect(prefRows()).toHaveLength(0);
      expect(allReplies(sentMessages).some((t) => t.includes("That list moved — here's the current one."))).toBe(true);
    });

    it('the trailing letter suffix (C1 grammar) is tolerated and ignored on a HIT', async () => {
      cfgAny().agentFallbacks = [{ provider: 'opencode-cli', model: 'kimi/kimi-k3' }];
      // Injected (Task H guardrail) — the HIT path now awaits a pin-time
      // verify; a real listFn would spawn from a test path.
      const listFn = vi.fn().mockResolvedValue({ status: 'ok', ids: ['kimi/kimi-k3'] });
      const { runtime } = makeRoutingRuntime({ model: 'claude-opus-4-8', modelCatalogueListFn: listFn });
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model list' }));
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model 2b', messageId: 'msg-2' }));
      const rows = prefRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].requested_model).toBe('kimi/kimi-k3');
    });

    it('TRANSITION: /model N then /model N default on the SAME provider clears the model dimension, not a stale "already set"', async () => {
      // Regression guard: recordRoutePreference's dedup used to match on
      // intent+provider alone, so a prior model-level pin (same provider)
      // would hit the "refreshed" branch and its `{ ...existing, ... }`
      // spread silently PRESERVED requestedModel/validatedProvider/
      // modelPinVerified instead of clearing them to the provider default.
      cfgAny().agentFallbacks = [{ provider: 'opencode-cli', model: 'kimi/kimi-k3' }];
      // Injected (Task H guardrail) — the first /model 2 HIT below awaits a
      // pin-time verify; a real listFn would spawn from a test path.
      const listFn = vi.fn().mockResolvedValue({ status: 'ok', ids: ['kimi/kimi-k3'] });
      const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8', modelCatalogueListFn: listFn });
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model list' }));
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model 2', messageId: 'msg-2' }));
      expect(prefRows()[0].requested_model).toBe('kimi/kimi-k3');
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model 2 default', messageId: 'msg-3' }));
      const rows = prefRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].requested_provider).toBe('opencode-cli');
      // The model dimension must be CLEARED, not carried over from the prior pin.
      expect(rows[0].requested_model).toBeNull();
      expect(rows[0].validated_provider).toBeNull();
      expect(rows[0].model_pin_verified).toBeNull();
      // The reply must be the fresh pin echo, not the misleading "already set".
      const reply = allReplies(sentMessages).join('\n');
      expect(reply).toContain('Pinned `opencode-cli` for 24h');
      expect(reply).not.toContain('Already set');
    });
  });

  // ── G (D14): a successful pin/reset now applies to the LIVE session, not
  // just the next /new — SessionManager.model/provider are readonly (set
  // once at construction), so the switch takes effect by tearing the
  // session down (idle) or deferring the teardown to the next turn-idle
  // boundary (busy), never mid-turn. Same-provider claude-cli fallback
  // entries throughout (mirrors the C3/H "HIT round-trip" pattern) — those
  // are unconditionally routable (no credential probe), isolating the
  // recycle behavior under test from the separate credential-gating concern
  // the C3/H suite above already covers.
  describe('G: apply a route switch immediately via session recycle (D14)', () => {
    it('an idle route switch tears down the live session — the NEXT spawn uses the new model', async () => {
      cfgAny().agentFallbacks = [{ provider: 'claude-cli', model: 'claude-sonnet-5' }];
      const anthropicFn = vi.fn().mockResolvedValue({ status: 'ok', ids: ['claude-opus-4-8', 'claude-sonnet-5'] });
      const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8', modelCatalogueAnthropicFn: anthropicFn });
      // /model list spawns the live session on the default route (claude-cli/claude-opus-4-8).
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model list' }));
      mockSession.shutdown.mockClear();
      // /model 2 pins claude-sonnet-5 — a DIFFERENT route than the live session.
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model 2', messageId: 'msg-2' }));
      // Idle (no turn in flight): the live session is torn down NOW, mirroring
      // /kill-session's teardown (shutdown(false) — not the resumable suspend).
      expect(mockSession.shutdown).toHaveBeenCalledWith(false);
      const reply = allReplies(sentMessages).join('\n');
      expect(reply).toContain('Now answering with claude-sonnet-5.');
      expect(reply).toContain('reply keep to make it permanent, /reset to undo.');
      expect(reply).not.toContain('Pinned claude-sonnet-5 for 24h');
      // No proactive respawn — createSessionManager only runs on the NEXT
      // inbound, and it reads the now-live pin.
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: 'hello', messageId: 'msg-3' }));
      const opts = capturedSessionManagerOptsRef.current as unknown as { provider?: string; model?: string };
      expect(opts?.provider).toBe('claude-cli');
      expect(opts?.model).toBe('claude-sonnet-5');
    });

    it('pinning the SAME route the live session is already on does not recycle (diff-gate no-op)', async () => {
      // Entry 1 in the numbered snapshot IS the live session's own route
      // (claude-cli/claude-opus-4-8, the configured primary) — a genuine
      // re-pin of the status quo, not merely a repeat (which would hit the
      // 'refreshed'/'sticky_kept' short-circuit before the diff-gate ever runs).
      const anthropicFn = vi.fn().mockResolvedValue({ status: 'ok', ids: ['claude-opus-4-8'] });
      const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8', modelCatalogueAnthropicFn: anthropicFn });
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model list' }));
      mockSession.shutdown.mockClear();
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model 1', messageId: 'msg-2' }));
      expect(mockSession.shutdown).not.toHaveBeenCalled();
      const reply = allReplies(sentMessages).join('\n');
      expect(reply).toContain('Pinned claude-opus-4-8 for 24h — reply keep to make it permanent, /reset to undo.');
      expect(reply).not.toContain('Now answering with');
      expect(reply).not.toContain("it'll answer from your next message");
    });

    it('a busy pin defers the recycle — never tears down mid-turn, applies at the next turn-idle boundary', async () => {
      cfgAny().agentFallbacks = [{ provider: 'claude-cli', model: 'claude-sonnet-5' }];
      const anthropicFn = vi.fn().mockResolvedValue({ status: 'ok', ids: ['claude-opus-4-8', 'claude-sonnet-5'] });
      const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8', modelCatalogueAnthropicFn: anthropicFn });
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model list' }));
      mockSession.shutdown.mockClear();
      // Simulate an in-flight turn for the single/shared scope — the same
      // idiom the existing turn_in_progress coverage above uses directly on
      // the runtime's currentInboundSeq field (isTurnInFlight's single-scope
      // predicate reads exactly this field).
      (runtime as unknown as { currentInboundSeq: number | undefined }).currentInboundSeq = 999;
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model 2', messageId: 'msg-2' }));
      // Deferred: the pin is recorded and disclosed, but the live session
      // must survive completely untouched while busy.
      expect(mockSession.shutdown).not.toHaveBeenCalled();
      const reply = allReplies(sentMessages).join('\n');
      expect(reply).toContain("claude-sonnet-5 is pinned — it'll answer from your next message.");
      expect(reply).not.toContain('Now answering with');
      // Still busy: a message arriving now must NOT recycle mid-turn — the
      // deferred flag stays set rather than firing early.
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model status', messageId: 'msg-3' }));
      expect(mockSession.shutdown).not.toHaveBeenCalled();
      // Turn completes — clear the busy signal exactly as the real
      // finalization path does (applyRuntimeTurnPostEffects), reaching the
      // turn-idle boundary the deferral promised to apply at.
      (runtime as unknown as { currentInboundSeq: number | undefined }).currentInboundSeq = undefined;
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: 'hello', messageId: 'msg-4' }));
      expect(mockSession.shutdown).toHaveBeenCalledWith(false);
      const opts = capturedSessionManagerOptsRef.current as unknown as { provider?: string; model?: string };
      expect(opts?.model).toBe('claude-sonnet-5');
    });

    // HIGHEST-VALUE TEST (final-review Observation, not a known bug — proving
    // the property, not fixing a defect): the test above manually pokes
    // currentInboundSeq to SIMULATE a busy turn. This one constructs a
    // GENUINE mid-turn interleaving: a real provider turn is dispatched via
    // the turnQueue (shared-mode fire-and-forget dispatch, same idiom as the
    // existing '/new'-while-busy coverage) and deliberately held open between
    // dispatch and finalization (session.sendTurn blocked on a manually-
    // released promise) while a /model switch arrives for the SAME chat. The
    // recycle must defer (pendingRecycle set, live session NOT torn down
    // mid-turn) and apply exactly once, only at the next turn-idle boundary.
    it('DYNAMIC INTERLEAVE: a /model switch arriving between provider-turn dispatch and finalization defers the recycle for real, never mid-turn', async () => {
      cfgAny().agentFallbacks = [{ provider: 'claude-cli', model: 'claude-sonnet-5' }];
      const anthropicFn = vi.fn().mockResolvedValue({ status: 'ok', ids: ['claude-opus-4-8', 'claude-sonnet-5'] });
      // shared: true — non-per_chat dispatch still goes through this.session/
      // this.queue (the SAME singleton mechanics the G-block tests exercise),
      // but turn dispatch is fire-and-forget via this.turnQueue (unlike plain
      // 'single' scope, which awaits sendTurnNonShared — and therefore the
      // WHOLE turn — directly inside _handleMessageInner, serializing every
      // inbound behind it and making a genuine SECOND, concurrent inbound
      // impossible to construct at all). Shared mode is what the existing
      // busy-rejection tests (e.g. "rejects /new while the shared runtime
      // queue still owns a turn") use for exactly this reason.
      const { runtime, sentMessages } = makeRoutingRuntime({ shared: true, model: 'claude-opus-4-8', modelCatalogueAnthropicFn: anthropicFn });
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model list' }));
      mockSession.shutdown.mockClear();

      let markSendStarted!: () => void;
      let releaseSend!: () => void;
      const sendStarted = new Promise<void>((resolve) => { markSendStarted = resolve; });
      const sendBlocked = new Promise<void>((resolve) => { releaseSend = resolve; });
      mockSession.sendTurn.mockImplementationOnce(async () => {
        markSendStarted();
        await sendBlocked;
      });

      // A genuine provider turn for 'hello'. _handleMessageInner's shared-mode
      // branch enqueues onto turnQueue and returns WITHOUT awaiting the send —
      // so `await turnChain` below resolves once the turn is QUEUED, not once
      // it's DONE; session.sendTurn is still hanging on sendBlocked.
      const state = runtime as unknown as { turnQueue: { isProcessing: boolean; idle: () => Promise<void> } };
      await runtime.handleMessage(makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: 'hello', messageId: 'msg-2' }));
      await (runtime as unknown as { turnChain: Promise<void> }).turnChain;
      await sendStarted;
      expect(state.turnQueue.isProcessing).toBe(true); // genuinely in flight, not simulated

      // A /model switch arrives WHILE that turn is dispatched but not yet
      // finalized — this is a NEW inbound, processed independently of the
      // stuck turnQueue processor (local commands are handled synchronously
      // in _handleMessageInner, which is not what's blocked).
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model 2', messageId: 'msg-3' }));
      expect(mockSession.shutdown).not.toHaveBeenCalled(); // never mid-turn
      const deferReply = allReplies(sentMessages).join('\n');
      expect(deferReply).toContain("claude-sonnet-5 is pinned — it'll answer from your next message.");
      mockQueue.enqueueText.mockClear();
      sentMessages.length = 0;

      // Let the in-flight turn finish: release the blocked send AND emit the
      // 'result' event a real provider run ends with — turn completion
      // clears currentTurnChatJid/currentInboundSeq via handleEvent('result'),
      // which is what isTurnInFlight's single/shared predicate actually reads
      // (turnQueue.isProcessing alone going false is not sufficient). This is
      // itself NOT the turn-idle boundary the deferral promised — nothing
      // auto-fires the recycle just because the provider call returned.
      releaseSend();
      await state.turnQueue.idle();
      await emitAgentResult(0, null);
      expect(mockSession.shutdown).not.toHaveBeenCalled();

      // The NEXT inbound reaches ensureSessionAndQueueSync BEFORE any new
      // dispatch — consumePendingRecycleIfIdle fires there, exactly once.
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: 'next turn', messageId: 'msg-4' }));
      expect(mockSession.shutdown).toHaveBeenCalledTimes(1);
      expect(mockSession.shutdown).toHaveBeenCalledWith(false);
      const opts = capturedSessionManagerOptsRef.current as unknown as { provider?: string; model?: string };
      expect(opts?.provider).toBe('claude-cli');
      expect(opts?.model).toBe('claude-sonnet-5');
    });

    it('/reset recycles the live session back to the default route — undo is equally immediate', async () => {
      cfgAny().agentFallbacks = [{ provider: 'claude-cli', model: 'claude-sonnet-5' }];
      const anthropicFn = vi.fn().mockResolvedValue({ status: 'ok', ids: ['claude-opus-4-8', 'claude-sonnet-5'] });
      const { runtime } = makeRoutingRuntime({ model: 'claude-opus-4-8', modelCatalogueAnthropicFn: anthropicFn });
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model list' }));
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model 2', messageId: 'msg-2' }));
      // The pin already recycled the session onto claude-sonnet-5 (idle).
      expect(mockSession.shutdown).toHaveBeenCalledWith(false);
      mockSession.shutdown.mockClear();
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/reset', messageId: 'msg-3' }));
      // /reset clears the pin AND recycles the (respawned-as-claude-sonnet-5)
      // session back toward the default — undo is immediate, not "/new"-gated.
      expect(mockSession.shutdown).toHaveBeenCalledWith(false);
      const { runtime: second } = makeRoutingRuntime({ model: 'claude-opus-4-8', modelCatalogueAnthropicFn: anthropicFn });
      await sendAndDrain(second, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: 'hello', messageId: 'msg-4' }));
      const opts = capturedSessionManagerOptsRef.current as unknown as { provider?: string; model?: string };
      expect(opts?.provider).toBe('claude-cli');
      expect(opts?.model).toBe('claude-opus-4-8');
    });

    it('no live session at pin time is a no-op — nothing to recycle, the next spawn reads the pin regardless', () => {
      const runtime = new AgentRuntime(routingDb, makeMessenger().messenger, 'test');
      const outcome = (runtime as unknown as {
        applyRouteChangeAndRecycle: (chatJid: string, senderJid: string, mapKey: string | undefined) => string;
      }).applyRouteChangeAndRecycle(CHAT, SENDER_A, undefined);
      expect(outcome).toBe('noop');
    });

    // IMPORTANT 1 (final-review): a group re-confirm's 'refreshed'/
    // 'sticky_kept' outcome bumps ONLY the re-confirming sender's row, but
    // under chat-scoped last-writer-wins that alone can flip which row wins
    // the chat. Before this fix, the three pin handlers `break`d on that
    // outcome WITHOUT ever calling applyRouteChangeAndRecycle — so the live
    // session kept serving whatever the LAST 'set' pin picked, while the
    // re-confirm's own echo lied and said "Already set" for a route that
    // wasn't actually live. This proves the exact interleaving from the
    // review: A pins, B pins (session now on B's model), A re-confirms — the
    // re-confirm must recycle the session back to A's model and disclose it
    // honestly, not print a bare "Already set".
    it('IMPORTANT-1: a group re-confirm that flips the chat-scoped winner recycles the LIVE session too, not just a bare "Already set"', async () => {
      // Chat-scoped last-writer-wins breaks ties on updated_at — fake+advance
      // the clock between writes so two back-to-back pins in the same
      // millisecond (a real risk on a fast machine) can never tie and make
      // the winner ambiguous/flaky. Real timers are restored by this describe
      // block's own afterEach (vi.useRealTimers(), unconditional).
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(1_800_000_000_000);
      cfgAny().agentFallbacks = [
        { provider: 'claude-cli', model: 'claude-sonnet-5' },
        { provider: 'claude-cli', model: 'claude-haiku-4-5' },
      ];
      const anthropicFn = vi.fn().mockResolvedValue({
        status: 'ok',
        ids: ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'],
      });
      const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8', modelCatalogueAnthropicFn: anthropicFn });

      // Both senders render their OWN menu (Important-2 per-sender snapshot)
      // so this test doesn't depend on render ORDER between them.
      await sendAndDrain(runtime, makeMsg({ chatJid: GROUP, senderJid: SENDER_A, isGroup: true, content: '/model list' }));
      vi.setSystemTime(1_800_000_001_000);
      await sendAndDrain(runtime, makeMsg({ chatJid: GROUP, senderJid: SENDER_B, isGroup: true, content: '/model list', messageId: 'msg-2' }));

      // A pins claude-sonnet-5 — 'set', idle recycle.
      vi.setSystemTime(1_800_000_002_000);
      await sendAndDrain(runtime, makeMsg({ chatJid: GROUP, senderJid: SENDER_A, isGroup: true, content: '/model 2', messageId: 'msg-3' }));
      expect(mockSession.shutdown).toHaveBeenCalledWith(false);
      expect(allReplies(sentMessages).join('\n')).toContain('Now answering with claude-sonnet-5.');
      mockSession.shutdown.mockClear();
      mockQueue.enqueueText.mockClear();
      sentMessages.length = 0;

      // B pins claude-haiku-4-5 — 'set', idle recycle. Chat is now on haiku.
      vi.setSystemTime(1_800_000_003_000);
      await sendAndDrain(runtime, makeMsg({ chatJid: GROUP, senderJid: SENDER_B, isGroup: true, content: '/model 3', messageId: 'msg-4' }));
      expect(mockSession.shutdown).toHaveBeenCalledWith(false);
      expect(allReplies(sentMessages).join('\n')).toContain('Now answering with claude-haiku-4-5.');
      mockSession.shutdown.mockClear();
      mockQueue.enqueueText.mockClear();
      sentMessages.length = 0;

      // A re-confirms claude-sonnet-5 — A's OWN row matches, so this hits
      // 'refreshed' (bumps A's updated_at). Chat-scoped last-writer-wins now
      // resolves the chat back to A's sonnet row — but the LIVE session is
      // still on B's haiku. The fix must recycle here, idle (no turn in
      // flight), and disclose the switch honestly rather than "Already set".
      vi.setSystemTime(1_800_000_004_000);
      await sendAndDrain(runtime, makeMsg({ chatJid: GROUP, senderJid: SENDER_A, isGroup: true, content: '/model 2', messageId: 'msg-5' }));
      expect(mockSession.shutdown).toHaveBeenCalledWith(false);
      const reply = allReplies(sentMessages).join('\n');
      expect(reply).toContain('Now answering with claude-sonnet-5.');
      expect(reply).not.toContain('Already set');

      // The NEXT spawn must actually land on sonnet — proving the live
      // session really moved, not just the echo.
      vi.setSystemTime(1_800_000_005_000);
      await sendAndDrain(runtime, makeMsg({ chatJid: GROUP, senderJid: SENDER_A, isGroup: true, content: 'hello', messageId: 'msg-6' }));
      const opts = capturedSessionManagerOptsRef.current as unknown as { provider?: string; model?: string };
      expect(opts?.provider).toBe('claude-cli');
      expect(opts?.model).toBe('claude-sonnet-5');
    });

    // Companion DM/single-sender safety check (review's explicit claim): a
    // genuine re-confirm by the SAME (only) sender against a LIVE session
    // already on that route is a true no-op — the diff-gate must not recycle
    // a session that already matches, and the echo stays the plain
    // "Already set" shape.
    it("IMPORTANT-1 (DM safety): a same-sender re-confirm against an ALREADY-live matching route is a genuine no-op, not a spurious recycle", async () => {
      cfgAny().agentFallbacks = [{ provider: 'claude-cli', model: 'claude-sonnet-5' }];
      const anthropicFn = vi.fn().mockResolvedValue({ status: 'ok', ids: ['claude-opus-4-8', 'claude-sonnet-5'] });
      const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8', modelCatalogueAnthropicFn: anthropicFn });
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model list' }));
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model 2', messageId: 'msg-2' }));
      expect(mockSession.shutdown).toHaveBeenCalledWith(false); // idle recycle onto sonnet
      mockSession.shutdown.mockClear();
      mockQueue.enqueueText.mockClear();
      sentMessages.length = 0;
      // Re-confirm the SAME pin — 'refreshed', and the live session already
      // matches (diff-gate no-op) — must NOT recycle again.
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model 2', messageId: 'msg-3' }));
      expect(mockSession.shutdown).not.toHaveBeenCalled();
      const reply = allReplies(sentMessages).join('\n');
      expect(reply).toContain('Already set — extended for another 24h');
      expect(reply).not.toContain('Now answering with');
    });
  });

  it('C3/D15: /help hides strongest|fastest when no tiers are configured, and shows them when they are', async () => {
    const { runtime: withoutTiers, sentMessages: repliesA } = makeRoutingRuntime();
    await sendAndDrain(withoutTiers, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/help model' }));
    const detailWithout = allReplies(repliesA).find((t) => t.includes('/model'));
    expect(detailWithout).toBeDefined();
    expect(detailWithout).not.toContain('strongest');
    expect(detailWithout).not.toContain('fastest');

    // mockQueue.enqueueText is a SHARED mock across runtime instances — clear
    // it (matching the existing pattern elsewhere in this file) so the second
    // allReplies() below doesn't pick up the first runtime's reply.
    mockQueue.enqueueText.mockClear();
    repliesA.length = 0;
    cfgAny().nlRoutingTiers = { strongest: 'anthropic-api' };
    const { runtime: withTiers, sentMessages: repliesB } = makeRoutingRuntime();
    await sendAndDrain(withTiers, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/help model' }));
    const detailWith = allReplies(repliesB).find((t) => t.includes('/model'));
    expect(detailWith).toContain('strongest|fastest|provider-id');
  });

  it('C3: the verb/provider-id pin echo uses the same plain D10 affordance shape, no "for you"/deferral copy', async () => {
    const { runtime, sentMessages } = makeRoutingRuntime();
    await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model strongest' }));
    const reply = allReplies(sentMessages).join('\n');
    expect(reply).toContain('Pinned my strongest model for 24h — reply keep to make it permanent, /reset to undo.');
    expect(reply).not.toContain('for you in this chat');
    expect(reply).not.toContain('applies from your next session');
    expect(reply).not.toContain('Applies from your next session');
  });

  // Q-CANARY model-pin `keep` contract (2026-07-23): the bare-reply promise
  // every successful pin receipt advertises ("reply keep to make it
  // permanent") now has a local handler. tryHandleBareKeep/handleBareKeep
  // live in model-pin.ts (src/runtimes/agent/model-pin.ts) — see that
  // module for the compare-and-set + actor-policy implementation detail;
  // this suite proves the observable behavior through the same real-runtime
  // harness as the rest of this file.
  describe('bare keep promotes a temporary route pin to permanent', () => {
    async function seedTemporaryVerifiedPin(chatJid: string, senderJid: string, now = Date.now()): Promise<void> {
      const prefMod = await import('../../../src/runtimes/agent/chat-preference-db.ts');
      const keysMod = await import('../../../src/runtimes/agent/preference-keys.ts');
      const { chatKey, senderKey } = keysMod.preferenceKeys(routingDb, chatJid, senderJid);
      prefMod.setPreference(routingDb, {
        chatJid: chatKey,
        senderJid: senderKey,
        intent: 'provider_specific',
        requestedProvider: 'opencode-cli',
        scope: 'this_thread',
        pinStrict: true,
        fallbackPermitted: false,
        updatedAt: now,
        expiresAt: now + 24 * 60 * 60 * 1000,
        requestedModel: 'kimi/kimi-k3',
        validatedProvider: 'opencode-cli',
        modelPinVerified: true,
      });
    }

    it('survives read-back, pruning, and the original TTL horizon', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const base = 1_800_000_000_000;
      vi.setSystemTime(base);
      const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8' });
      await seedTemporaryVerifiedPin(CHAT, SENDER_A, base);
      expect(prefRows()[0].expires_at).toBe(base + 24 * 60 * 60 * 1000);

      await sendAndDrain(runtime, makeMsg({
        chatJid: CHAT,
        senderJid: SENDER_A,
        content: 'keep',
        messageId: 'msg-2',
      }));
      expect(allReplies(sentMessages).join('\n')).toContain(
        '_Keeping kimi/kimi-k3 for this chat until you /reset._',
      );
      expect(prefRows()[0]).toMatchObject({
        expires_at: null,
        requested_model: 'kimi/kimi-k3',
        requested_provider: 'opencode-cli',
        model_pin_verified: 1,
      });

      const prefMod = await import('../../../src/runtimes/agent/chat-preference-db.ts');
      prefMod.pruneExpired(routingDb, base + 1_000 * 365 * 24 * 60 * 60 * 1000);
      expect(prefRows()).toHaveLength(1);
      expect(prefRows()[0].expires_at).toBeNull();
      vi.setSystemTime(base + 25 * 60 * 60 * 1000);
      await sendAndDrain(runtime, makeMsg({
        chatJid: CHAT,
        senderJid: SENDER_A,
        content: '/model status',
        messageId: 'msg-3',
      }));
      expect(allReplies(sentMessages).filter((text) => text.includes('*Current route:*')).pop())
        .toContain('Saved preference: kimi/kimi-k3');
    });

    it('forwards bare keep unchanged when no live pin exists', async () => {
      const { runtime, sentMessages } = makeRoutingRuntime();
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: 'keep' }));
      expect(prefRows()).toHaveLength(0);
      expect(mockSession.sendTurn).toHaveBeenCalled();
      expect(allReplies(sentMessages).join('\n')).not.toMatch(/Keeping|already kept/i);
    });

    it('is idempotent for an already-permanent pin', async () => {
      const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8' });
      await seedTemporaryVerifiedPin(CHAT, SENDER_A);
      await sendAndDrain(runtime, makeMsg({
        chatJid: CHAT,
        senderJid: SENDER_A,
        content: 'keep',
        messageId: 'msg-2',
      }));
      const updatedAt = prefRows()[0].updated_at;
      mockSession.sendTurn.mockClear();
      await sendAndDrain(runtime, makeMsg({
        chatJid: CHAT,
        senderJid: SENDER_A,
        content: 'Keep!',
        messageId: 'msg-3',
      }));
      expect(allReplies(sentMessages).join('\n')).toContain(
        '_kimi/kimi-k3 is already kept for this chat. /reset to undo._',
      );
      expect(prefRows()[0].updated_at).toBe(updatedAt);
      expect(mockSession.sendTurn).not.toHaveBeenCalled();
    });

    it('does not intercept keep embedded in a sentence', async () => {
      const { runtime } = makeRoutingRuntime({ model: 'claude-opus-4-8' });
      await seedTemporaryVerifiedPin(CHAT, SENDER_A);
      mockSession.sendTurn.mockClear();
      await sendAndDrain(runtime, makeMsg({
        chatJid: CHAT,
        senderJid: SENDER_A,
        content: 'please keep it',
        messageId: 'msg-2',
      }));
      expect(prefRows()[0].expires_at).not.toBeNull();
      expect(mockSession.sendTurn).toHaveBeenCalled();
    });

    // Q-CANARY actor policy: only the sender who set the chat's current
    // winning preference may confirm it — NOT any group member. This test
    // used to assert the opposite (the defect GAP-CHECK flagged: "any group
    // member may promote"); it now proves the refusal instead of the
    // resurrection.
    it('refuses to promote another group member\'s pin (receipt-creator-only actor policy)', async () => {
      const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8' });
      await seedTemporaryVerifiedPin(GROUP, SENDER_A);
      const before = prefRows()[0];
      mockSession.sendTurn.mockClear();
      await sendAndDrain(runtime, makeMsg({
        chatJid: GROUP,
        senderJid: SENDER_B,
        isGroup: true,
        content: 'keep',
        messageId: 'msg-2',
      }));
      // No resurrection, no mutation: A's row is untouched byte-for-byte.
      expect(prefRows()).toHaveLength(1);
      expect(prefRows()[0]).toEqual(before);
      expect(allReplies(sentMessages).join('\n')).toContain(
        "_Only whoever set this chat's pin can keep it. /model to set your own._",
      );
      // Visible refusal, never a provider turn.
      expect(mockSession.sendTurn).not.toHaveBeenCalled();
    });

    it('refuses a keep that arrives after the pin has already expired (no pressure involved)', async () => {
      const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8' });
      const base = Date.now();
      await seedTemporaryVerifiedPin(CHAT, SENDER_A, base);
      mockSession.sendTurn.mockClear();
      await sendAndDrain(runtime, makeMsg({
        chatJid: CHAT,
        senderJid: SENDER_A,
        content: 'keep',
        messageId: 'msg-2',
        // Receive time itself is already past the 24h TTL — a genuinely
        // late reply, not processing-time pressure.
        timestamp: Math.floor((base + 25 * 60 * 60 * 1000) / 1000),
      }));
      expect(prefRows()[0]).toMatchObject({ scope: 'this_thread' });
      expect(prefRows()[0].expires_at).not.toBeNull();
      expect(allReplies(sentMessages).join('\n')).toContain(
        '_That pin already expired. /model to set a new one._',
      );
      expect(mockSession.sendTurn).not.toHaveBeenCalled();
    });

    it('honors an on-time keep even when processing is delayed past the TTL (receive-time eligibility, not processing-time)', async () => {
      const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8' });
      const base = Date.now();
      await seedTemporaryVerifiedPin(CHAT, SENDER_A, base);
      // Processing happens (wall-clock Date.now()) long after the 24h TTL —
      // provider-queue pressure, exactly the Q canary scenario — but the
      // inbound's OWN receive timestamp (msg.timestamp) is on-time.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(base + 26 * 60 * 60 * 1000);
      await sendAndDrain(runtime, makeMsg({
        chatJid: CHAT,
        senderJid: SENDER_A,
        content: 'keep',
        messageId: 'msg-2',
        timestamp: Math.floor((base + 60_000) / 1000), // received 1 minute after the pin, well inside the TTL
      }));
      expect(allReplies(sentMessages).join('\n')).toContain(
        '_Keeping kimi/kimi-k3 for this chat until you /reset._',
      );
      expect(prefRows()[0]).toMatchObject({ scope: 'sticky', expires_at: null });
    });

    it('affordance round trip: the real receipt promise, confirmed by keep, closes the loop durably with zero provider turns', async () => {
      const { runtime, sentMessages } = makeRoutingRuntime();
      const duraDb = new RealDatabase(':memory:');
      duraDb.open();
      const durability = new DurabilityEngine(duraDb);
      runtime.setDurability(durability);

      // Step 1 — render the REAL receipt (drive the actual /model handler,
      // not a seeded fixture) and confirm it promises what the contract says.
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model strongest', messageId: 'msg-1' }));
      const receipt = allReplies(sentMessages).join('\n');
      expect(receipt).toContain('reply keep to make it permanent');
      expect(prefRows()[0]).toMatchObject({ scope: 'this_thread' });
      expect(prefRows()[0].expires_at).not.toBeNull();

      sentMessages.length = 0;
      mockQueue.enqueueText.mockClear();
      mockSession.sendTurn.mockClear();

      // Step 2 — submit the EXACT advertised action as a new inbound.
      const seq = durability.journalInbound('m-keep-rt', 'k-keep-rt', SENDER_A, 'agent');
      await sendAndDrain(runtime, makeMsg({
        chatJid: CHAT, senderJid: SENDER_A, content: 'keep', messageId: 'msg-2', inboundSeq: seq,
      }));

      // Promised durable state transition: scope=sticky + expires_at=NULL together.
      expect(prefRows()).toHaveLength(1);
      expect(prefRows()[0]).toMatchObject({ scope: 'sticky', expires_at: null });

      // ONE local receipt.
      const replies = allReplies(sentMessages);
      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain('Keeping strongest for this chat until you /reset.');

      // Terminal journal completion — never stranded in 'processing'.
      const row = duraDb.raw.prepare(
        'SELECT processing_status, terminal_reason FROM inbound_events WHERE seq = ?',
      ).get(seq) as { processing_status: string; terminal_reason: string | null };
      expect(row.processing_status).toBe('complete');
      expect(row.terminal_reason).toBe('local_command_handled');

      // ZERO provider sendTurn calls for the keep turn.
      expect(mockSession.sendTurn).not.toHaveBeenCalled();

      // Distinct typed event — never the generic model_preference_set.
      const events = await readEvents();
      expect(events.filter((e) => e.event === 'model_preference_made_sticky')).toHaveLength(1);
      expect(events.filter((e) => e.event === 'model_preference_set' && e.reasonCode === 'user_pin_kept')).toHaveLength(0);

      duraDb.close();
    });
  });

  // ── Slice 1: /model <vendor/model> direct selector ─────────────────────────
  // The power-user one-step path — pin an EXACT configured model id without
  // first walking the numbered menu. Resolves against the same configured
  // (provider, model) set /model list enumerates and reuses the same
  // record→verify→recycle→echo sink as /model N (pinConfiguredModelEntry), so
  // pins are byte-identical to the numbered pick. The F07 routability gate is
  // this path's own responsibility (the numbered snapshot only holds routable
  // entries) — a configured-but-non-routable id must be rejected at SET time.
  describe('configured model-id direct selection (Slice 1)', () => {
    it('pins an exact configured model id in one step, verified, without a prior menu snapshot', async () => {
      // opencode-cli as the PRIMARY (agentProvider) makes it unconditionally
      // routable (isEntryCredentialed's same-provider shortcut) AND honored by
      // resolveRouteForTurn, so the pin + recycle are deterministic with no
      // keyring dependency; the cross-provider F07 gate is exercised below.
      // A slash-bearing id is required — MODEL_ID_RE mandates the vendor/model
      // shape (a slash-less claude model is not an explicit id).
      cfgAny().agentProvider = 'opencode-cli';
      cfgAny().agentFallbacks = [{ provider: 'opencode-cli', model: 'glm/glm-5.2' }];
      const listFn = vi.fn().mockResolvedValue({ status: 'ok', ids: ['kimi/kimi-k3', 'glm/glm-5.2'] });
      const { runtime, sentMessages } = makeRoutingRuntime({ model: 'kimi/kimi-k3', modelCatalogueListFn: listFn });
      // A live session on the default route (opencode-cli/kimi-k3) so the new
      // pin (opencode-cli/glm-5.2) is a genuine switch → recycled echo.
      (mockSession as unknown as { getProviderId: ReturnType<typeof vi.fn> }).getProviderId.mockReturnValue('opencode-cli');
      (mockSession as unknown as { getModelRef: ReturnType<typeof vi.fn> }).getModelRef.mockReturnValue('kimi/kimi-k3');
      (runtime as unknown as { session: typeof mockSession; activeChatJid: string | null }).session = mockSession;
      (runtime as unknown as { activeChatJid: string | null }).activeChatJid = CHAT;

      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model glm/glm-5.2' }));

      // Row shape is byte-identical to the C3 '/model N' HIT test — the shared
      // pinConfiguredModelEntry sink means the selector and the numbered pick
      // produce the same durable pin (convergence, proven by construction).
      const rows = prefRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].intent).toBe('provider_specific');
      expect(rows[0].requested_provider).toBe('opencode-cli');
      expect(rows[0].requested_model).toBe('glm/glm-5.2');
      expect(rows[0].validated_provider).toBe('opencode-cli');
      expect(rows[0].model_pin_verified).toBe(1);
      expect(listFn).toHaveBeenCalledTimes(1);
      const reply = allReplies(sentMessages).join('\n');
      expect(reply).toContain('Now answering with glm/glm-5.2');
      expect(reply).toContain('reply keep to make it permanent, /reset to undo');
      // Not a reject, not a stale-defer.
      expect(reply).not.toContain("isn't configured");
      expect(reply).not.toContain("isn't available");
      expect(reply).not.toContain('pending a catalogue check');
    });

    it('pins a credentialed NON-PRIMARY fallback model id — the F07 gate ACCEPT path (verified row written)', async () => {
      // The realistic selector use the reject cases below and the happy-path
      // above don't cover: the primary is claude-cli and the id names a
      // CREDENTIALED non-primary FALLBACK (opencode-cli). The F07 gate must
      // ADMIT it via routablePinTargets' credential resolution — NOT the
      // same-provider shortcut the opencode-as-primary happy-path exercised.
      // routablePinTargets does real per-model keyring I/O, so mock it to
      // include opencode-cli (routable in prod; the test env lacks its
      // per-model creds), mirroring the hybrid selector test. The row +
      // verified bit are the deterministic gap-closer; the exact echo (recycle
      // vs noop) depends on live-session state this test doesn't fix, so it's
      // asserted only as "a success naming the model, never a reject".
      cfgAny().agentFallbacks = [{ provider: 'opencode-cli', model: 'glm/glm-5.2' }];
      const listFn = vi.fn().mockResolvedValue({ status: 'ok', ids: ['glm/glm-5.2'] });
      const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8', modelCatalogueListFn: listFn });
      (runtime as unknown as { routablePinTargets: () => string[] }).routablePinTargets = () => ['claude-cli', 'opencode-cli'];

      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model glm/glm-5.2' }));

      const rows = prefRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].requested_provider).toBe('opencode-cli');
      expect(rows[0].requested_model).toBe('glm/glm-5.2');
      expect(rows[0].validated_provider).toBe('opencode-cli');
      expect(rows[0].model_pin_verified).toBe(1);
      expect(listFn).toHaveBeenCalledTimes(1);
      const reply = allReplies(sentMessages).join('\n');
      expect(reply).toContain('glm/glm-5.2');
      expect(reply).not.toContain("isn't available");
      expect(reply).not.toContain("isn't configured");
      expect(reply).not.toContain('matches more than one');
    });

    it('rejects an unconfigured model id locally without writing a row or dispatching an agent turn', async () => {
      cfgAny().agentFallbacks = [{ provider: 'opencode-cli', model: 'glm/glm-5.2' }];
      const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8' });

      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model vendor/not-configured' }));

      expect(prefRows()).toHaveLength(0);
      const reply = allReplies(sentMessages).join('\n');
      expect(reply).toContain("vendor/not-configured isn't configured on this instance");
      expect(reply).toContain('/model list');
    });

    it('rejects an ambiguous configured model id instead of choosing a provider by array order', async () => {
      cfgAny().agentFallbacks = [
        { provider: 'opencode-cli', model: 'shared/model-x' },
        { provider: 'codex-cli', model: 'shared/model-x' },
      ];
      const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8' });

      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model shared/model-x' }));

      expect(prefRows()).toHaveLength(0);
      const reply = allReplies(sentMessages).join('\n');
      expect(reply).toContain('matches more than one configured route');
      expect(reply).toContain('/model list');
    });

    it('rejects a configured-but-NON-ROUTABLE model id at SET time — F07 parity with /model <provider>, no row written', async () => {
      // A model configured under a provider the instance can't honor (no
      // credential): `/model <provider>` already rejects it at SET time (F07,
      // see the uncredentialed-fallback test above); `/model <id>` MUST too, or
      // the direct selector could pin a route that hard-fails or silently falls
      // back. `absentService` mirrors the provider-id F07 test — no keychain
      // dependency (the service is absent from every store → credential null).
      const absentService = `wa-test-absent-${Math.random().toString(36).slice(2)}`;
      cfgAny().agentProviderConfig = { apiKeyService: absentService };
      cfgAny().agentFallbacks = [{ provider: 'anthropic-api', model: 'anthropic/claude-test-x' }];
      const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8' });

      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model anthropic/claude-test-x' }));

      // The F07 invariant: no un-honorable pin is written at SET time.
      expect(prefRows()).toHaveLength(0);
      const reply = allReplies(sentMessages).join('\n');
      expect(reply).toContain("isn't available on this instance");
      expect(reply).toContain('/model list');
      // Must NOT have reached the pin/defer tail (that echo would leak here).
      expect(reply).not.toContain('pending a catalogue check');
      expect(reply).not.toContain('Now answering with');
    });
  });

  // ── Slice 2: /model two-level drill-down (brand -> model) ───────────────────
  // Bare /model opens the Level-1 brand menu; /model N on a brand drills to
  // Level-2 (the provider's live catalogue); /model N on a model pins the leaf
  // through the SAME pinConfiguredModelEntry sink as the flat /model N. The
  // flat and drill menus share ONE latest slot (last-write-wins) so /model N
  // resolves against whichever the user saw most recently.
  describe('two-level drill-down (Slice 2)', () => {
    // opencode-cli routable via a mocked routablePinTargets (real per-model
    // keyring I/O is env-dependent; claude-cli is the always-routable primary).
    function makeDrillRuntime(listIds: string[] = ['kimi/kimi-k3', 'glm/glm-5.2']) {
      // opencode-cli Level-2 fetches via listFn; claude-cli (brand 1) via
      // anthropicFn — inject BOTH so either brand's Level-2 renders (a real
      // binary/keychain is never touched, Task H guardrail).
      const listFn = vi.fn().mockResolvedValue({ status: 'ok', ids: listIds });
      const anthropicFn = vi.fn().mockResolvedValue({ status: 'ok', ids: ['claude-opus-4-8', 'claude-sonnet-5'] });
      const rt = makeRoutingRuntime({ model: 'claude-opus-4-8', modelCatalogueListFn: listFn, modelCatalogueAnthropicFn: anthropicFn });
      cfgAny().agentFallbacks = [
        { provider: 'opencode-cli', model: 'kimi/kimi-k3' },
        { provider: 'opencode-cli', model: 'glm/glm-5.2' },
      ];
      (rt.runtime as unknown as { routablePinTargets: () => string[] }).routablePinTargets = () => ['claude-cli', 'opencode-cli'];
      return { ...rt, listFn, anthropicFn };
    }

    it('bare /model opens the Level-1 brand menu built from routablePinTargets, and snapshots it', async () => {
      const { runtime, sentMessages } = makeDrillRuntime();
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model' }));
      const reply = allReplies(sentMessages).join('\n');
      expect(reply).toContain('*Pick a provider:*');
      expect(reply).toContain('Claude');
      expect(reply).toContain('OpenCode');
      expect(reply).toContain('_Reply /model N_');
      expect(prefRows()).toHaveLength(0);
    });

    it('/model N on a BRAND entry drills to Level-2 (the provider catalogue), not a pin', async () => {
      const { runtime, sentMessages, listFn } = makeDrillRuntime();
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model' }));
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model 2', messageId: 'm2' }));
      const reply = allReplies(sentMessages).join('\n');
      expect(reply).toContain('*OpenCode — pick a model:*');
      expect(reply).toContain('kimi/kimi-k3');
      expect(reply).toContain('glm/glm-5.2');
      expect(listFn).toHaveBeenCalled();
      expect(prefRows()).toHaveLength(0);
    });

    it('/model N on a MODEL leaf pins through the shared sink (verified row written)', async () => {
      const { runtime, sentMessages } = makeDrillRuntime();
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model' }));
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model 2', messageId: 'm2' }));
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model 1', messageId: 'm3' }));
      const rows = prefRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].requested_provider).toBe('opencode-cli');
      expect(rows[0].requested_model).toBe('kimi/kimi-k3');
      expect(rows[0].model_pin_verified).toBe(1);
      expect(allReplies(sentMessages).join('\n')).toContain('kimi/kimi-k3');
    });

    it('RECENCY (drill wins): /model list → bare /model → /model 1 drills the DRILL brand, never a flat pin', async () => {
      const { runtime, sentMessages } = makeDrillRuntime();
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model list' }));
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model', messageId: 'm2' }));
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model 1', messageId: 'm3' }));
      const reply = allReplies(sentMessages).join('\n');
      expect(reply).toContain('— pick a model:*');
      expect(prefRows()).toHaveLength(0);
    });

    it('RECENCY (flat wins): bare /model → /model list → /model 1 pins the FLAT entry, never drills', async () => {
      const { runtime } = makeDrillRuntime();
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model' }));
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model list', messageId: 'm2' }));
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model 1', messageId: 'm3' }));
      const rows = prefRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].requested_provider).toBe('claude-cli');
    });

    it('RECENCY (/model N default): a drill supersedes the flat list → /model 1 default MISSES, never pins a stale provider (advisor bug guard)', async () => {
      const { runtime, sentMessages } = makeDrillRuntime();
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model list' }));
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model', messageId: 'm2' }));
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model 1 default', messageId: 'm3' }));
      expect(prefRows()).toHaveLength(0);
      expect(allReplies(sentMessages).join('\n')).toContain("That list moved — here's the current one.");
    });

    it('DEGRADE (Level-1): routablePinTargets throwing yields honest copy + a clean-miss snapshot (no stale flat resolve)', async () => {
      const { runtime, sentMessages } = makeDrillRuntime();
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model list' }));
      (runtime as unknown as { routablePinTargets: () => string[] }).routablePinTargets = () => { throw new Error('keychain blip'); };
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model', messageId: 'm2' }));
      expect(allReplies(sentMessages).join('\n')).toContain("Couldn't read your configured providers right now");
      sentMessages.length = 0;
      mockQueue.enqueueText.mockClear();
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model 1', messageId: 'm3' }));
      expect(allReplies(sentMessages).join('\n')).toContain("That list moved");
      expect(prefRows()).toHaveLength(0);
    });

    it('DEGRADE (Level-2): a provider catalogue fetch that is not ok degrades honestly, no pin', async () => {
      const listFn = vi.fn().mockResolvedValue({ status: 'unavailable', reason: 'spawn-error' });
      const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8', modelCatalogueListFn: listFn });
      cfgAny().agentFallbacks = [{ provider: 'opencode-cli', model: 'kimi/kimi-k3' }];
      (runtime as unknown as { routablePinTargets: () => string[] }).routablePinTargets = () => ['claude-cli', 'opencode-cli'];
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model' }));
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model 2', messageId: 'm2' }));
      expect(allReplies(sentMessages).join('\n')).toContain("Couldn't load OpenCode models right now");
      expect(prefRows()).toHaveLength(0);
    });

    it('/model status still shows the route readout (status moved off bare /model, not removed)', async () => {
      const { runtime, sentMessages } = makeDrillRuntime();
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model status' }));
      const reply = allReplies(sentMessages).join('\n');
      expect(reply).toContain('*Current route:*');
      expect(reply).not.toContain('*Pick a provider:*');
    });

    it('DEGRADE (L1, review M-1): a throw from resolveRouteForTurn (not just routablePinTargets) still writes the empty snapshot — a following /model N misses cleanly, never resolves the stale flat list', async () => {
      const { runtime, sentMessages } = makeDrillRuntime();
      // Live flat slot first, so a stale entry exists to (wrongly) resolve.
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model list' }));
      // routablePinTargets SUCCEEDS but resolveRouteForTurn throws — the narrow
      // window the original guard (wrapping only routablePinTargets) missed.
      (runtime as unknown as { resolveRouteForTurn: () => never }).resolveRouteForTurn = () => { throw new Error('store blip'); };
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model', messageId: 'm2' }));
      expect(allReplies(sentMessages).join('\n')).toContain("Couldn't read your configured providers right now");
      sentMessages.length = 0;
      mockQueue.enqueueText.mockClear();
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model 1', messageId: 'm3' }));
      // The empty drill snapshot overwrote the flat slot → clean miss, no pin.
      expect(prefRows()).toHaveLength(0);
      expect(allReplies(sentMessages).join('\n')).toContain('That list moved');
    });

    it('L2 DISCOVERY (review I-1, owner-ratified): a drill leaf pins a catalogue model that is NOT in the configured set — the direct selector would reject the same id', async () => {
      // The drill is a discovery surface: Level-2 shows the provider's FULL
      // live catalogue, a superset of configuredModelEntries. Picking an
      // otherwise-unconfigured model PINS it (owner decision "full catalogue +
      // reconcile"), even though `/model opencode/discovered` is rejected by the
      // direct selector as "not configured". This asymmetry is deliberate.
      const listFn = vi.fn().mockResolvedValue({ status: 'ok', ids: ['opencode/discovered-only'] });
      const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8', modelCatalogueListFn: listFn });
      // opencode-cli is configured with a DIFFERENT model; the catalogue lists
      // one that is not configured at all.
      cfgAny().agentFallbacks = [{ provider: 'opencode-cli', model: 'kimi/kimi-k3' }];
      (runtime as unknown as { routablePinTargets: () => string[] }).routablePinTargets = () => ['claude-cli', 'opencode-cli'];
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model' }));
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model 2', messageId: 'm2' })); // OpenCode L2
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model 1', messageId: 'm3' })); // the discovered-only leaf
      const rows = prefRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].requested_provider).toBe('opencode-cli');
      expect(rows[0].requested_model).toBe('opencode/discovered-only'); // NOT in configuredModelEntries
      expect(rows[0].model_pin_verified).toBe(1);
      // Cross-check the deliberate asymmetry: the direct selector rejects it.
      sentMessages.length = 0;
      mockQueue.enqueueText.mockClear();
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model opencode/discovered-only', messageId: 'm4' }));
      expect(allReplies(sentMessages).join('\n')).toContain("isn't configured on this instance");
    });

    it('L2 render is capped (review M-2): a chatty provider catalogue is bounded, with an honest "showing 1–N of M" disclosure', async () => {
      const many = Array.from({ length: 20 }, (_, i) => `opencode/model-${i}`);
      const listFn = vi.fn().mockResolvedValue({ status: 'ok', ids: many });
      const { runtime, sentMessages } = makeRoutingRuntime({ model: 'claude-opus-4-8', modelCatalogueListFn: listFn });
      cfgAny().agentFallbacks = [{ provider: 'opencode-cli', model: 'opencode/model-0' }];
      (runtime as unknown as { routablePinTargets: () => string[] }).routablePinTargets = () => ['claude-cli', 'opencode-cli'];
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model' }));
      await sendAndDrain(runtime, makeMsg({ chatJid: CHAT, senderJid: SENDER_A, content: '/model 2', messageId: 'm2' })); // → OpenCode L2
      const reply = allReplies(sentMessages).join('\n');
      // Capped at MODEL_CATALOGUE_CAP (12) — the 13th id is not numbered.
      expect(reply).toContain('12. opencode/model-11');
      expect(reply).not.toContain('13. opencode/model-12');
      expect(reply).toContain('showing 1–12 of 20');
    });
  });
});
