// B22: command-surface behavior-contract matrix.
//
// Four table-driven groups that pin the RULED semantics of the local command
// surface so every future change is forced through an explicit table row:
//
//   1. AUTHORIZATION MATRIX — gate × sessionScope × venue × adminPhones ×
//      sender, over the gate hoist in runtime.ts (~:3718-3775). Pins:
//      gate 'none' always allowed; gate 'admin' = authenticated admin only,
//      ANY venue (B21-A F3), denied for EVERYONE when adminPhones is empty;
//      gate 'admin-shared-scope' = ungated in a per_chat 1:1 DM, gated in any
//      group venue or single/shared scope, EXCEPT ungated everywhere when
//      adminPhones is EMPTY (B21-A F2); an @sms sender NEVER passes an applied
//      gate regardless of digits (QR-143).
//   2. REGISTRY-HANDLER COVERAGE — derived from COMMAND_REGISTRY: every entry
//      must be handled locally without hitting the default-case
//      'local command has no handler — forwarding to agent' warn path; plus a
//      simulated FUTURE entry that must warn + forward (B21-A F4b contract).
//   3. DENY-DURABILITY — derived from COMMAND_REGISTRY (gate !== 'none'): a
//      denied invocation finalizes its inbound row as terminal
//      'not_authorized' (never strands 'processing', B21-A F1) and enqueues
//      exactly one '_Not authorized._' reply (B21-A F4a).
//   4. HEALTH DEGRADE TABLE — iterates HEALTH_TURN_ERROR_CLASSES (SSOT):
//      transient self-clearing classes degrade ONLY inside the
//      [debounce, stale] window; every OTHER class degrades immediately. A
//      class newly added to HEALTH_TURN_ERROR_CLASSES automatically gets the
//      immediate-degrade assertion unless declared transient in the table here.
//
// Harness: the established runtime.test.ts mock idiom (mocked SessionManager /
// OutboundQueue / config seams, real DurabilityEngine on an in-memory DB,
// sendAndDrain over the private turnChain). Fixture identities use fictional
// 1555-prefixed numbers, matching the sibling suites.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, request } from 'node:http';
import type { Database } from '../../../src/core/database.ts';
import type { IncomingMessage, Messenger } from '../../../src/core/types.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';

// ─── Hoisted mocks (runtime.test.ts idiom) ───────────────────────────────────

const { mockSession, mockQueue, capturedOnEventRef } = vi.hoisted(() => {
  const capturedOnEventRef: { current: ((event: unknown) => void) | null } = { current: null };
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
    // Task G (D14): applyRouteChangeAndRecycle's diff-gate reads this on
    // every live session, same as getProviderId — a real SessionManager
    // always has it (session.ts), so the mock must too.
    getModelRef: vi.fn((): string | undefined => undefined),
    // Slice 3: the diff-gate also reads the effective spawned effort (null =
    // no static effort) — same "a real SessionManager always has it" reason.
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
  return { mockSession, mockQueue, capturedOnEventRef };
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

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => mockRuntimeLogger,
}));

vi.mock('../../../src/runtimes/agent/process-tree.ts', () => ({
  killSessionTree: vi.fn(async () => {}),
}));

vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlert: vi.fn(() => true),
  emitAlertChecked: vi.fn(() => true),
  clearAlertSource: vi.fn(() => true),
  clearAlertSourceChecked: vi.fn(() => true),
}));

vi.mock('../../../src/core/messages.ts', () => ({
  getRecentMessages: vi.fn(() => []),
  getMessageCount: vi.fn(() => 0), // health.ts message-count probe
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

vi.mock('../../../src/runtimes/agent/session-classifier.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/runtimes/agent/session-classifier.ts')>();
  return {
    ...actual,
    classifyActiveSessions: vi.fn(() => []),
  };
});

vi.mock('../../../src/runtimes/agent/session.ts', () => ({
  // eslint-disable-next-line prefer-arrow-callback -- vi.fn().mockImplementation requires function keyword for constructor mocks; expires 2026-12-31
  SessionManager: vi.fn().mockImplementation(function (opts: { onEvent: (event: AgentEvent) => void }) {
    capturedOnEventRef.current = opts.onEvent as (event: unknown) => void;
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

// Mutable mock config: adminPhones is swapped per matrix row; healthPort 0
// binds the group-4 health server on an ephemeral port (no fixed-port clash
// with sibling suites).
const { mockConfig } = vi.hoisted(() => {
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
    dbPath: ':memory:',
    botName: 'WhatSoup',
    accessMode: 'allowlist',
    healthPort: 0,
    // restart-loop guard disabled: this suite starts a runtime per test (36+
    // boots), so boot-marking is left off to avoid both filesystem writes and
    // any cross-test trip; the full object + stateRoot still satisfy the
    // health-snapshot reads that access it unconditionally.
    stateRoot: '/tmp/whatsoup-test-state-contract',
    restartLoopGuard: { enabled: false, maxRestarts: 3, windowMs: 300_000 },
    models: {
      conversation: 'claude-opus-4-5',
      extraction: 'claude-haiku-4-5',
      validation: 'claude-haiku-4-5',
      fallback: 'claude-sonnet-4-5',
    },
  };
  return { mockConfig };
});

vi.mock('../../../src/config.ts', () => ({ config: mockConfig }));

vi.mock('../../../src/runtimes/chat/providers/elevenlabs.ts', () => ({
  synthesizeSpeech: vi.fn(),
}));

vi.mock('../../../src/core/media-download.ts', () => ({
  writeTempFile: vi.fn().mockReturnValue('/tmp/voice-reply.mp3'),
  downloadMedia: vi.fn(),
}));

// B21-A F4b seams: overridable classifier/registry so the group-2 future-entry
// test can simulate a COMMAND_REGISTRY append with no switch case. Default
// (current == null) delegates to the real implementations.
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

vi.mock('../../../src/core/workspace.ts', () => ({
  chatJidToWorkspace: vi.fn((_instanceCwd: string, chatJid: string) => {
    const key = chatJid.replace('@s.whatsapp.net', '').replace('@lid', '');
    return { kind: 'dm' as const, workspaceKey: key, workspacePath: `/tmp/${key}` };
  }),
  provisionWorkspace: vi.fn(() => '/tmp/workspace/.claude/whatsoup.sock'),
  writeSandboxArtifacts: vi.fn(),
  ensurePermissionsSettings: vi.fn(),
  writePrivateFileSync: vi.fn(),
}));

vi.mock('../../../src/core/user-claude-settings.ts', () => ({
  inspectUserClaudeSettings: vi.fn(),
}));

vi.mock('../../../src/mcp/socket-server.ts', () => ({
  // eslint-disable-next-line prefer-arrow-callback -- vi.fn().mockImplementation requires function keyword for constructor mocks; expires 2026-12-31
  WhatSoupSocketServer: vi.fn().mockImplementation(function () {
    return {
      start: vi.fn(),
      stop: vi.fn(),
      updateDeliveryJid: vi.fn(),
      updateActorJid: vi.fn(),
      updateConversationKey: vi.fn(),
    };
  }),
}));

vi.mock('../../../src/runtimes/agent/media-bridge.ts', () => ({
  startMediaBridge: vi.fn(() => ({ _server: null, _currentChatJid: null })),
  setMediaBridgeChat: vi.fn(),
}));

vi.mock('../../../src/runtimes/agent/providers/primary-model-usability.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/runtimes/agent/providers/primary-model-usability.ts')>();
  return {
    ...actual,
    probePrimaryModelUsability: vi.fn(async (target: { provider: string; model?: string | null }) => ({
      status: 'unknown' as const,
      provider: target.provider,
      model: target.model ?? null,
      reason: 'model-not-configured',
    })),
  };
});

vi.mock('../../../src/runtimes/agent/providers/primary-model-usability-adapters.ts', () => ({
  createPrimaryModelProbeAdapters: vi.fn(() => ({})),
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

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readdirSync: mockReaddirSync,
  };
});

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import { COMMAND_REGISTRY } from '../../../src/runtimes/agent/command-registry.ts';
import { Database as RealDatabase } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import { startHealthServer, HEALTH_TURN_ERROR_CLASSES, type HealthDeps } from '../../../src/core/health.ts';
import type { ConnectionManager } from '../../../src/transport/connection.ts';

// ─── Fixtures (fictional 1555-prefixed identities, sibling-suite idiom) ──────

const ADMIN_PHONE = '15550100001';
const ADMIN_WA = `${ADMIN_PHONE}@s.whatsapp.net`; // authenticated admin
const NON_ADMIN_WA = '15550002222@s.whatsapp.net'; // authenticated non-admin
const SMS_ADMIN_DIGITS = `${ADMIN_PHONE}@sms`; // QR-143 spoof: admin digits, unauthenticated transport
const DM_CHAT = '15550009000@s.whatsapp.net';
const GROUP_CHAT = '155500090001234@g.us';

const DENIAL_TEXT = '_Not authorized._';
const NO_HANDLER_WARN = 'local command has no handler — forwarding to agent';

type Scope = 'single' | 'shared' | 'per_chat';

// ─── Helpers (runtime.test.ts idiom) ─────────────────────────────────────────

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
    chatJid: DM_CHAT,
    senderJid: NON_ADMIN_WA,
    senderName: 'Contract Fixture',
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

async function sendAndDrain(runtime: AgentRuntime, msg: IncomingMessage): Promise<void> {
  await runtime.handleMessage(msg);
  await (runtime as unknown as { turnChain: Promise<void> }).turnChain;
}

function makeRuntime(scope: Scope, db: Database, messenger: Messenger): AgentRuntime {
  if (scope === 'shared') return new AgentRuntime(db, messenger, 'contract', { shared: true });
  if (scope === 'per_chat') return new AgentRuntime(db, messenger, 'contract', { sessionScope: 'per_chat' });
  return new AgentRuntime(db, messenger); // default: single scope
}

function enqueuedTexts(): string[] {
  return mockQueue.enqueueText.mock.calls.map((args) => String(args[0]));
}

function cfgAny(): Record<string, unknown> {
  return mockConfig as unknown as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedOnEventRef.current = null;
  classifyInputOverrideRef.current = null;
  commandSpecOverrideRef.current = null;
  mockSession.spawnSession.mockReset().mockResolvedValue(undefined);
  mockSession.shutdown.mockReset().mockResolvedValue(undefined);
  mockSession.waitForProviderTurnToTerminalize.mockReset().mockResolvedValue(undefined);
  mockSession.getStatus.mockReset().mockReturnValue({ active: false, pid: null, sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null });
  mockSession.sendTurn.mockReset().mockResolvedValue(undefined);
  mockSession.getDbRowId.mockReset().mockReturnValue(null);
  mockSession.handleNew.mockReset().mockResolvedValue(undefined);
  mockQueue.flushTurnEvidence.mockReset().mockImplementation(async (turnId: string) => ({
    turnId,
    answerOpIds: [],
    lifecycleOpIds: [],
    statusOpIds: [],
  }));
  mockReaddirSync.mockReturnValue(['0', '1', '2']);
  mockConfig.adminPhones = new Set<string>([ADMIN_PHONE]);
  mockConfig.voiceReply = 'never';
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 1 — Authorization matrix (gate × scope × venue × adminPhones × sender)
// ─────────────────────────────────────────────────────────────────────────────

describe('B22 group 1: authorization matrix', () => {
  // Allow-evidence markers: a stable substring of each command's successful
  // local reply. Deny-evidence is uniform: exactly one '_Not authorized._'.
  //   /help     → gate 'none' probe (queue-routed render)
  //   /sessions → gate 'admin' probe (admin-bypass messenger path)
  //   /new      → gate 'admin-shared-scope' probe (queue-routed ack)
  type Row = {
    title: string;
    command: '/help' | '/sessions' | '/new';
    scope: Scope;
    isGroup: boolean;
    adminPhones: 'configured' | 'empty';
    senderJid: string;
    expected: 'allow' | 'deny';
  };

  const rows: Row[] = [
    // gate 'none' (/help): always allowed — any venue, any sender, any scope.
    { title: "none: single DM, configured admins, non-admin → ALLOW", command: '/help', scope: 'single', isGroup: false, adminPhones: 'configured', senderJid: NON_ADMIN_WA, expected: 'allow' },
    { title: "none: single GROUP, configured admins, @sms admin digits → ALLOW (no gate applied)", command: '/help', scope: 'single', isGroup: true, adminPhones: 'configured', senderJid: SMS_ADMIN_DIGITS, expected: 'allow' },
    { title: "none: per_chat DM, EMPTY admins, non-admin → ALLOW", command: '/help', scope: 'per_chat', isGroup: false, adminPhones: 'empty', senderJid: NON_ADMIN_WA, expected: 'allow' },

    // gate 'admin' (/sessions): authenticated admin only, ANY venue (B21-A F3);
    // denied for everyone when adminPhones is empty; @sms never passes (QR-143).
    { title: "admin: single DM, configured, authenticated admin → ALLOW", command: '/sessions', scope: 'single', isGroup: false, adminPhones: 'configured', senderJid: ADMIN_WA, expected: 'allow' },
    { title: "admin: single DM, configured, authenticated non-admin → DENY", command: '/sessions', scope: 'single', isGroup: false, adminPhones: 'configured', senderJid: NON_ADMIN_WA, expected: 'deny' },
    { title: "admin: single GROUP, configured, authenticated admin → ALLOW (group-permitting, B21-A F3)", command: '/sessions', scope: 'single', isGroup: true, adminPhones: 'configured', senderJid: ADMIN_WA, expected: 'allow' },
    { title: "admin: single DM, configured, @sms bearing admin digits → DENY (QR-143)", command: '/sessions', scope: 'single', isGroup: false, adminPhones: 'configured', senderJid: SMS_ADMIN_DIGITS, expected: 'deny' },
    { title: "admin: single GROUP, configured, @sms bearing admin digits → DENY (QR-143 stays closed in groups)", command: '/sessions', scope: 'single', isGroup: true, adminPhones: 'configured', senderJid: SMS_ADMIN_DIGITS, expected: 'deny' },
    { title: "admin: single DM, EMPTY admins, sender bearing former-admin digits → DENY (no empty-set relaxation for 'admin')", command: '/sessions', scope: 'single', isGroup: false, adminPhones: 'empty', senderJid: ADMIN_WA, expected: 'deny' },
    { title: "admin: per_chat DM, configured, authenticated admin → ALLOW (any scope)", command: '/sessions', scope: 'per_chat', isGroup: false, adminPhones: 'configured', senderJid: ADMIN_WA, expected: 'allow' },
    { title: "admin: shared GROUP, configured, authenticated non-admin → DENY", command: '/sessions', scope: 'shared', isGroup: true, adminPhones: 'configured', senderJid: NON_ADMIN_WA, expected: 'deny' },

    // gate 'admin-shared-scope' (/new): ungated in a per_chat 1:1 DM; gated in
    // any group venue or single/shared scope; ungated EVERYWHERE when
    // adminPhones is empty (B21-A F2); @sms never passes an applied gate.
    { title: "a-s-s: per_chat 1:1 DM, configured, non-admin → ALLOW (own conversation, ungated)", command: '/new', scope: 'per_chat', isGroup: false, adminPhones: 'configured', senderJid: NON_ADMIN_WA, expected: 'allow' },
    { title: "a-s-s: per_chat GROUP, configured, non-admin → DENY (WG-5 shared state)", command: '/new', scope: 'per_chat', isGroup: true, adminPhones: 'configured', senderJid: NON_ADMIN_WA, expected: 'deny' },
    { title: "a-s-s: per_chat GROUP, configured, authenticated admin → ALLOW (group-permitting)", command: '/new', scope: 'per_chat', isGroup: true, adminPhones: 'configured', senderJid: ADMIN_WA, expected: 'allow' },
    { title: "a-s-s: per_chat GROUP, configured, @sms bearing admin digits → DENY (QR-143 in an applied-gate venue)", command: '/new', scope: 'per_chat', isGroup: true, adminPhones: 'configured', senderJid: SMS_ADMIN_DIGITS, expected: 'deny' },
    { title: "a-s-s: single DM, configured, non-admin → DENY (single scope is shared state)", command: '/new', scope: 'single', isGroup: false, adminPhones: 'configured', senderJid: NON_ADMIN_WA, expected: 'deny' },
    { title: "a-s-s: single DM, configured, authenticated admin → ALLOW", command: '/new', scope: 'single', isGroup: false, adminPhones: 'configured', senderJid: ADMIN_WA, expected: 'allow' },
    { title: "a-s-s: single DM, configured, @sms bearing admin digits → DENY (QR-143)", command: '/new', scope: 'single', isGroup: false, adminPhones: 'configured', senderJid: SMS_ADMIN_DIGITS, expected: 'deny' },
    { title: "a-s-s: shared DM, configured, non-admin → DENY (shared scope is shared state)", command: '/new', scope: 'shared', isGroup: false, adminPhones: 'configured', senderJid: NON_ADMIN_WA, expected: 'deny' },
    { title: "a-s-s: shared DM, configured, authenticated admin → ALLOW", command: '/new', scope: 'shared', isGroup: false, adminPhones: 'configured', senderJid: ADMIN_WA, expected: 'allow' },
    { title: "a-s-s: single DM, EMPTY admins, non-admin → ALLOW (B21-A F2: no-admin instance keeps its reset path)", command: '/new', scope: 'single', isGroup: false, adminPhones: 'empty', senderJid: NON_ADMIN_WA, expected: 'allow' },
    { title: "a-s-s: shared GROUP, EMPTY admins, non-admin → ALLOW (empty set ungates everywhere)", command: '/new', scope: 'shared', isGroup: true, adminPhones: 'empty', senderJid: NON_ADMIN_WA, expected: 'allow' },
    { title: "a-s-s: per_chat DM, EMPTY admins, non-admin → ALLOW", command: '/new', scope: 'per_chat', isGroup: false, adminPhones: 'empty', senderJid: NON_ADMIN_WA, expected: 'allow' },
  ];

  const ALLOW_MARKERS: Record<Row['command'], { queue: RegExp | null; direct: RegExp | null }> = {
    // /help renders through the queue path; its trailer is registry-stable.
    '/help': { queue: /Any other message is forwarded/, direct: null },
    // /sessions replies over the admin-bypass messenger path.
    '/sessions': { queue: null, direct: /Active Sessions|No active sessions/ },
    // /new acks through the queue path.
    '/new': { queue: /new session/i, direct: null },
  };

  it.each(rows.map((row) => [row.title, row] as const))('%s', async (_title, row) => {
    if (row.adminPhones === 'empty') mockConfig.adminPhones = new Set<string>();
    const db = makeDb();
    const { messenger, sentMessages } = makeMessenger();
    const runtime = makeRuntime(row.scope, db, messenger);
    await runtime.start();
    mockQueue.enqueueText.mockClear();

    await sendAndDrain(runtime, makeMsg({
      content: row.command,
      senderJid: row.senderJid,
      chatJid: row.isGroup ? GROUP_CHAT : DM_CHAT,
      isGroup: row.isGroup,
    }));

    const queueTexts = enqueuedTexts();
    const directTexts = sentMessages.map((m) => m.text);
    const marker = ALLOW_MARKERS[row.command];
    const denials = queueTexts.filter((t) => t === DENIAL_TEXT);

    if (row.expected === 'deny') {
      // Denial is user-visible (B21-A F4a) and exclusive: exactly one denial
      // reply, no allow-evidence on either send path.
      expect(denials).toHaveLength(1);
      if (marker.queue) expect(queueTexts.some((t) => marker.queue!.test(t))).toBe(false);
      if (marker.direct) expect(directTexts.some((t) => marker.direct!.test(t))).toBe(false);
    } else {
      expect(denials).toHaveLength(0);
      if (marker.queue) expect(queueTexts.some((t) => marker.queue!.test(t))).toBe(true);
      if (marker.direct) expect(directTexts.some((t) => marker.direct!.test(t))).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 2 — Registry-handler coverage (derived from COMMAND_REGISTRY)
// ─────────────────────────────────────────────────────────────────────────────

describe('B22 group 2: every COMMAND_REGISTRY entry has a local handler', () => {
  beforeEach(() => {
    // Routing aliases (/model /reset — D11 dropped /why) classify local only
    // under the nlRouting flag; the coverage sweep must reach their handlers too.
    cfgAny().nlRouting = true;
    cfgAny().agentProvider = 'claude-cli';
  });

  afterEach(() => {
    delete cfgAny().nlRouting;
    delete cfgAny().agentProvider;
  });

  it('the registry seed matches the known Phase-1 surface (table forces future appends through this suite)', () => {
    // Not a hand-list of handlers — a tripwire: a NEW registry entry changes
    // this set, forcing its author into this file where groups 2 and 3 pick
    // the entry up automatically and the matrix in group 1 must be reviewed.
    expect([...COMMAND_REGISTRY].map((c) => c.name).sort()).toEqual(
      ['help', 'kill-session', 'model', 'new', 'reset', 'sessions', 'status'].sort(),
    );
  });

  it.each([...COMMAND_REGISTRY].map((spec) => [spec.name, spec] as const))(
    '/%s is handled locally without the default-case forward-warn',
    async (name, _spec) => {
      const db = makeDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger); // single scope
      const duraDb = new RealDatabase(':memory:');
      duraDb.open();
      const durability = new DurabilityEngine(duraDb);
      runtime.setDurability(durability);
      await runtime.start();
      mockQueue.enqueueText.mockClear();
      mockSession.sendTurn.mockClear();
      mockRuntimeLogger.warn.mockClear();

      try {
        const seq = durability.journalInbound(`m-cover-${name}`, `k-cover-${name}`, DM_CHAT, 'agent');
        const readRow = (): { processing_status: string; terminal_reason: string | null } =>
          duraDb.raw.prepare(
            'SELECT processing_status, terminal_reason FROM inbound_events WHERE seq = ?',
          ).get(seq) as { processing_status: string; terminal_reason: string | null };
        // Admin sender passes every gate class in single scope, so the drive
        // reaches the switch for gated and ungated entries alike. Bounded wait
        // on the OBSERVABLE outcome rather than the full turn chain: a
        // registry entry that (wrongly) falls through to the default case
        // becomes a forwarded agent turn whose provider result never arrives
        // under this harness — the sendTurn disjunct converts that hang into
        // an immediate, correctly-named assertion failure below.
        await runtime.handleMessage(makeMsg({ content: `/${name}`, senderJid: ADMIN_WA, inboundSeq: seq }));
        await vi.waitFor(() => {
          expect(
            readRow().processing_status === 'complete' || mockSession.sendTurn.mock.calls.length > 0,
          ).toBe(true);
        });

        // (a) Local terminal durability: the R14 completion stamped the row.
        const row = readRow();
        expect(row.processing_status).toBe('complete');
        expect(row.terminal_reason).toBe('local_command_handled');

        // (b) The default case never fired — no forward-warn, no agent turn.
        const warns = mockRuntimeLogger.warn.mock.calls.map((c) => String(c[1] ?? ''));
        expect(warns.some((w) => w.includes('no handler'))).toBe(false);
        expect(mockSession.sendTurn).not.toHaveBeenCalled();

        // (c) The handler executed cleanly — a throwing handler would still
        // finalize (a) truthfully, so pin the no-fault reply separately.
        expect(enqueuedTexts().some((t) => t.includes('Something went wrong processing that command'))).toBe(false);
      } finally {
        duraDb.close();
      }
    },
  );

  it('a FUTURE registry entry with no switch case warns and forwards to the agent (B21-A F4b)', async () => {
    // Simulated Phase-2 append (delegating override seams): classifier admits
    // '/stats', registry serves a spec, but the switch has no case — the
    // default must warn loudly and forward, never silently swallow.
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
      await sendAndDrain(runtime, makeMsg({ content: '/stats', senderJid: ADMIN_WA }));
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

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 3 — Deny-durability for every gated registry entry (registry-derived)
// ─────────────────────────────────────────────────────────────────────────────

describe('B22 group 3: denied gated commands finalize terminally and reply once', () => {
  // Derived, never hand-listed: a future gated entry lands in this table
  // automatically. Single scope + configured adminPhones + authenticated
  // non-admin sender is a denied venue for BOTH gate classes by the ruled
  // semantics ('admin' denies non-admins everywhere; 'admin-shared-scope'
  // applies in single scope and denies non-admins while admins exist).
  const gatedSpecs = [...COMMAND_REGISTRY].filter((spec) => spec.gate !== 'none');

  it('derives at least one gated entry from the registry (derivation tripwire)', () => {
    expect(gatedSpecs.map((s) => s.name).sort()).toEqual(['kill-session', 'new', 'sessions']);
    for (const spec of gatedSpecs) expect(spec.gate === 'admin' || spec.gate === 'admin-shared-scope').toBe(true);
  });

  it.each(gatedSpecs.map((spec) => [spec.name, spec] as const))(
    'denied /%s: inbound row is terminal not_authorized and exactly one denial reply is enqueued (B21-A F1/F4a)',
    async (name, _spec) => {
      const db = makeDb();
      const { messenger, sentMessages } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger); // single scope
      const duraDb = new RealDatabase(':memory:');
      duraDb.open();
      const durability = new DurabilityEngine(duraDb);
      runtime.setDurability(durability);
      await runtime.start();
      mockQueue.enqueueText.mockClear();

      try {
        const seq = durability.journalInbound(`m-deny-${name}`, `k-deny-${name}`, DM_CHAT, 'agent');
        await sendAndDrain(runtime, makeMsg({ content: `/${name}`, senderJid: NON_ADMIN_WA, inboundSeq: seq }));

        // (a) Terminal, truthful durability: never stranded in 'processing'
        // (which the stuck-inbound sweep would falsely reclaim as a FAILURE).
        const row = duraDb.raw.prepare(
          'SELECT processing_status, terminal_reason FROM inbound_events WHERE seq = ?',
        ).get(seq) as { processing_status: string; terminal_reason: string | null };
        expect(row.processing_status).not.toBe('processing');
        expect(row.processing_status).toBe('complete');
        expect(row.terminal_reason).toBe('not_authorized');

        // (b) Exactly one user-visible denial on the queue path; nothing rode
        // the admin-bypass messenger path.
        expect(enqueuedTexts().filter((t) => t === DENIAL_TEXT)).toHaveLength(1);
        expect(sentMessages).toHaveLength(0);
      } finally {
        duraDb.close();
      }
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 4 — Health degrade table (driven from HEALTH_TURN_ERROR_CLASSES SSOT)
// ─────────────────────────────────────────────────────────────────────────────

describe('B22 group 4: turn-error class degrade contract', () => {
  // DECLARATION TABLE — the classes ruled transient/self-clearing (#1433 /
  // B21-D / W1-T6). health.ts's TRANSIENT_SELF_CLEARING_TURN_ERROR_CLASSES is
  // deliberately module-private, so this table pins the CONTRACT behaviorally:
  //  - a class added to HEALTH_TURN_ERROR_CLASSES but NOT declared here is
  //    automatically asserted to degrade IMMEDIATELY (the safe default);
  //  - moving a class in/out of the source transient set without updating this
  //    declaration flips the matching assertion red.
  const DECLARED_TRANSIENT = new Set(['empty-output', 'transient-network', 'server-error']);

  const ALL_CLASSES = [...HEALTH_TURN_ERROR_CLASSES].sort();
  const transientClasses = ALL_CLASSES.filter((c) => DECLARED_TRANSIENT.has(c));
  const immediateClasses = ALL_CLASSES.filter((c) => !DECLARED_TRANSIENT.has(c));

  const DEBOUNCE_MS = 60 * 1000; // TRANSIENT_TURN_ERROR_DEGRADE_DEBOUNCE_MS
  const STALE_MS = 15 * 60 * 1000; // TRANSIENT_TURN_ERROR_STALE_MS

  function httpGet(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  /** Spin the real health server (ephemeral port), read /health, tear down. */
  async function healthStatusFor(turnCapability: Record<string, unknown>): Promise<string> {
    // #2515: the diagnostic projection is bearer-gated; set a test token and
    // pass it in the Authorization header so healthStatusFor reads the full
    // diagnostic status (including turn-capability degrade), not just the
    // public liveness envelope.
    const HEALTH_TOKEN = 'contract-test-health-token-2515';
    process.env.WHATSOUP_HEALTH_TOKEN = HEALTH_TOKEN;
    const hdb = new RealDatabase(':memory:');
    hdb.open();
    const deps: HealthDeps = {
      db: hdb,
      connectionManager: {
        botJid: '15551230004@s.whatsapp.net',
        botLid: null,
        sendMessage: vi.fn(async () => ({ waMessageId: null })),
        sendMedia: vi.fn(async () => ({ waMessageId: null })),
        connect: vi.fn(async () => {}),
        disconnect: vi.fn(async () => {}),
      } as unknown as ConnectionManager,
      startedAt: Date.now() - 1000,
      getEnrichmentStats: vi.fn().mockReturnValue({ lastRun: null, unprocessed: 0 }),
      instanceName: 'contract-health',
      instanceType: 'agent',
      accessMode: 'allowlist',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({ status: 'healthy', details: { turnCapability } }),
      } as unknown as HealthDeps['runtime'],
    };
    const server = startHealthServer(deps);
    try {
      const port = await new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.once('listening', () => {
          const addr = server.address();
          if (typeof addr === 'object' && addr) resolve(addr.port);
          else reject(new Error('health server bound without a port'));
        });
      });
      const { status, body } = await httpGet(port, '/health', {
        Authorization: `Bearer ${HEALTH_TOKEN}`,
      });
      expect(status).toBe(200);
      return (JSON.parse(body) as { status: string }).status;
    } finally {
      delete process.env.WHATSOUP_HEALTH_TOKEN;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      hdb.close();
    }
  }

  function capability(errorClass: string, errorAgeMs: number, successAgeMs: number): Record<string, unknown> {
    const now = Date.now();
    return {
      modelUsable: null, // keep the independent usability-probe degrade out of the frame
      modelUsabilityStatus: 'usable',
      lastSuccessfulTurnAt: now - successAgeMs,
      lastTurnErrorClass: errorClass,
      lastTurnErrorAt: now - errorAgeMs,
    };
  }

  it('every declared-transient class is a member of HEALTH_TURN_ERROR_CLASSES (declaration cannot drift silently)', () => {
    for (const cls of DECLARED_TRANSIENT) expect(HEALTH_TURN_ERROR_CLASSES.has(cls)).toBe(true);
    expect(transientClasses).toHaveLength(DECLARED_TRANSIENT.size);
    expect(immediateClasses.length + transientClasses.length).toBe(HEALTH_TURN_ERROR_CLASSES.size);
  });

  it.each(transientClasses)(
    "transient class '%s' degrades ONLY inside the [debounce, stale] window",
    async (errorClass) => {
      // Fresh (inside the debounce): a single blip must not flap the body.
      await expect(healthStatusFor(capability(errorClass, 10 * 1000, 5 * 60 * 1000))).resolves.toBe('healthy');
      // Current + sustained (past debounce, under stale): a real stall degrades.
      await expect(healthStatusFor(capability(errorClass, 3 * 60 * 1000, 5 * 60 * 1000))).resolves.toBe('degraded');
      // Past the staleness bound with no recovery: benign idle artifact, self-clears.
      await expect(healthStatusFor(capability(errorClass, STALE_MS + 75 * 60 * 1000, STALE_MS + 77 * 60 * 1000))).resolves.toBe('healthy');
      // Window sanity: the in-window probe really sits inside [debounce, stale].
      expect(3 * 60 * 1000).toBeGreaterThanOrEqual(DEBOUNCE_MS);
      expect(3 * 60 * 1000).toBeLessThanOrEqual(STALE_MS);
    },
  );

  it.each(immediateClasses)(
    "non-transient class '%s' degrades immediately — no debounce grace",
    async (errorClass) => {
      // Same fresh 10s shape that is BENIGN for a transient class: any class
      // not declared transient must degrade at once (fail-unhealthy default,
      // which also auto-covers future additions to HEALTH_TURN_ERROR_CLASSES).
      await expect(healthStatusFor(capability(errorClass, 10 * 1000, 5 * 60 * 1000))).resolves.toBe('degraded');
    },
  );
});
