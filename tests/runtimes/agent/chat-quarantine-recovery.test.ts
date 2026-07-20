// tests/runtimes/agent/chat-quarantine-recovery.test.ts
//
// Regression cover for the 2026-07-19 ar-bot wedge: one chat went silent for 14h
// while the process stayed healthy.
//
// Chain: an unattributable provider terminal drove rejectProviderEvent ->
// invalidateRejectedTerminalSource -> SessionManager.shutdown(false). shutdown
// re-threw because the process-tree guard refused to signal an ambiguous
// identity. The runtime retained the failed teardown to block automatic
// respawn (correct — the old tree may still be alive), but left the dead
// SessionManager bound in chatSessions. Every later message for that chat
// routed to the corpse. No telemetry, no operator affordance, no recovery
// short of a process restart.
//
// The invariant is per-mapKey: NO new session may spawn on a mapKey until the
// previous process tree is proven empty. It is NOT "the corpse must stay bound"
// — that was an implicit, invisible way of enforcing it. These tests pin the
// explicit form:
//   1. teardown failure quarantines the mapKey AND unbinds the corpse
//   2. while quarantined, no new session may bind to that mapKey
//   3. once the tree is provably empty, quarantine releases and a fresh session binds
//   4. while it stays unprovable, quarantine holds and the chat is reported stalled
//
// Tests 1/2/4 are the "never-provable" spec and must agree with the existing
// runtime.test.ts assertions ('retains a failed rejected-terminal quarantine...'
// and 'keeps /new fail-closed...'). Test 3 is the "eventually-provable" case
// those tests do not cover — it is what turns a 14h outage into a 10m one.
//
// Mock scaffolding mirrors idle-session-eviction.test.ts.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Database } from '../../../src/core/database.ts';
import type { IncomingMessage, Messenger } from '../../../src/core/types.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import type { IOutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';

const { mockSession, mockQueue, mockRuntimeLogger, capturedOnEventRef } = vi.hoisted(() => {
  const capturedOnEventRef: { current: ((event: AgentEvent) => void) | null } = { current: null };
  const mockSession = {
    spawnSession: vi.fn(async () => {}),
    sendTurn: vi.fn(async () => {}),
    handleNew: vi.fn(async () => {}),
    getStatus: vi.fn(() => ({
      active: false,
      pid: null as number | null,
      sessionId: null as string | null,
      startedAt: null as string | null,
      messageCount: 0,
      lastMessageAt: null as string | null,
      turnInFlight: false,
    })),
    shutdown: vi.fn(async () => {}),
    clearTurnWatchdog: vi.fn(() => {}),
    completeProviderTurn: vi.fn(() => {}),
    tickWatchdog: vi.fn(() => {}),
    trackToolStart: vi.fn((_toolId: string) => {}),
    trackToolEnd: vi.fn((_toolId: string) => {}),
    getDbRowId: vi.fn(() => 1 as number | null),
    bindGenerationOwnership: vi.fn(),
    getProviderId: vi.fn(() => 'claude-cli'),
    getModelRef: vi.fn(() => undefined),
  };

  const mockQueue = {
    enqueueText: vi.fn(),
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
    targetChatJid: 'test@s.whatsapp.net',
    getLastOpId: vi.fn(() => undefined),
    setDurability: vi.fn(),
    enqueuePoll: vi.fn(async (sendFn: () => Promise<void>) => sendFn()),
    setPollPending: vi.fn(),
    endTurn: vi.fn(),
    getSenderToken: () => 'mock-sender-token',
  };

  const mockRuntimeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  return { mockSession, mockQueue, mockRuntimeLogger, capturedOnEventRef };
});

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => mockRuntimeLogger,
}));

vi.mock('../../../src/core/messages.ts', () => ({ getRecentMessages: vi.fn(() => []) }));

const { mockGetActiveSession } = vi.hoisted(() => ({ mockGetActiveSession: vi.fn(() => null as null) }));
const { mockBackfillWorkspaceKeys, mockGetResumableSessionForChat } = vi.hoisted(() => ({
  mockBackfillWorkspaceKeys: vi.fn(),
  mockGetResumableSessionForChat: vi.fn(() => null as null),
}));

vi.mock('../../../src/runtimes/agent/session-db.ts', () => ({
  ensureAgentSchema: vi.fn(),
  createSession: vi.fn(() => 1),
  incrementMessageCount: vi.fn(),
  updateSessionId: vi.fn(),
  updateSessionStatus: vi.fn(),
  getActiveSession: mockGetActiveSession,
  backfillWorkspaceKeys: mockBackfillWorkspaceKeys,
  markOrphaned: vi.fn(),
  getResumableSessionForChat: mockGetResumableSessionForChat,
  backfillSessionProvider: vi.fn(),
}));

vi.mock('../../../src/runtimes/agent/session.ts', () => ({
  // eslint-disable-next-line prefer-arrow-callback -- vi.fn().mockImplementation requires the function keyword for constructor mocks; expires 2026-12-31
  SessionManager: vi.fn().mockImplementation(function (
    opts: { onEvent: (event: AgentEvent) => void; onResumeFailed?: () => void },
  ) {
    capturedOnEventRef.current = opts.onEvent;
    return mockSession;
  }),
  formatAge: vi.fn(() => '0s ago'),
}));

vi.mock('../../../src/runtimes/agent/outbound-queue.ts', () => ({
  // eslint-disable-next-line prefer-arrow-callback -- vi.fn().mockImplementation requires the function keyword for constructor mocks; expires 2026-12-31
  OutboundQueue: vi.fn().mockImplementation(function () { return mockQueue; }),
}));

vi.mock('../../../src/config.ts', () => ({
  config: {
    adminPhones: new Set<string>(),
    controlPeers: new Map<string, string>(),
    toolUpdateMode: 'full',
    toolUpdateRedirectJid: null,
    textAggregateDelayMs: 2_000,
    stateRoot: '/tmp/whatsoup-test-state-quarantine',
    restartLoopGuard: { enabled: true, maxRestarts: 3, windowMs: 300_000 },
    mediaDir: '/tmp/whatsoup-test-media/tmp',
    pineconeAllowedIndexes: [],
  },
}));

vi.mock('../../../src/core/access-list.ts', async (importOriginal) => {
  return (await importOriginal()) as typeof import('../../../src/core/access-list.ts');
});

const { mockChatJidToWorkspace } = vi.hoisted(() => ({
  mockChatJidToWorkspace: vi.fn((_instanceCwd: string, chatJid: string) => {
    const key = chatJid.replace('@s.whatsapp.net', '').replace('@lid', '');
    return { kind: 'dm' as const, workspaceKey: key, workspacePath: `/tmp/${key}` };
  }),
}));

vi.mock('../../../src/core/workspace.ts', () => ({
  chatJidToWorkspace: mockChatJidToWorkspace,
  provisionWorkspace: vi.fn(() => '/tmp/workspace/.claude/whatsoup.sock'),
  writeSandboxArtifacts: vi.fn(),
  ensurePermissionsSettings: vi.fn(),
  writePrivateFileSync: vi.fn(),
}));

vi.mock('../../../src/mcp/socket-server.ts', () => ({
  WhatSoupSocketServer: vi.fn().mockImplementation(function () {
    return { start: vi.fn(), stop: vi.fn(), updateDeliveryJid: vi.fn(), updateActorJid: vi.fn(), updateConversationKey: vi.fn() };
  }),
}));

vi.mock('../../../src/mcp/registry.ts', () => ({
  ToolRegistry: class {
    register = vi.fn();
    listTools = vi.fn(() => []);
    call = vi.fn();
    getChatScopedToolNames = vi.fn(() => []);
    setSensitiveToolAuthorizer = vi.fn();
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs');
  return { ...actual, mkdirSync: vi.fn(), writeFileSync: vi.fn() };
});

const _mockQueueTypeCheck: IOutboundQueue = mockQueue;
void _mockQueueTypeCheck;

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';

const CHAT_JID = 'test@s.whatsapp.net';
const MAP_KEY = CHAT_JID;

function makeDb(): Database {
  return {
    assertWritableCompatibility: vi.fn(),
    raw: {
      prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) })),
      exec: vi.fn(),
    },
  } as unknown as Database;
}
function makeMessenger(): Messenger {
  return { sendMessage: vi.fn(async () => ({ waMessageId: null })), sendMedia: vi.fn(async () => ({ waMessageId: null })) };
}
function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: 'msg-1', chatJid: CHAT_JID, senderJid: 'sender@s.whatsapp.net',
    senderName: 'Test User', content: 'hello', contentType: 'text', isFromMe: false, isGroup: false,
    mentionedJids: [], timestamp: Date.now(), quotedMessageId: null, contentText: null,
    isResponseWorthy: true, ...overrides,
  };
}
async function sendAndDrain(runtime: AgentRuntime, msg: IncomingMessage): Promise<void> {
  await runtime.handleMessage(msg);
  await (runtime as unknown as { turnChain: Promise<void> }).turnChain;
}

interface QuarantineRecord {
  mapKey: string;
  reason: string;
  since: number;
}

type RuntimeInternals = {
  chatSessions: Map<string, unknown>;
  chatQueues: Map<string, unknown>;
  chatQuarantine: Map<string, QuarantineRecord>;
  sweepQuarantinedChats?: () => Promise<void>;
  stalledChats?: (now: number) => { mapKey: string; reason: string; ageMs: number; attempts: number }[];
};

function internals(runtime: AgentRuntime): RuntimeInternals {
  return runtime as unknown as RuntimeInternals;
}

/**
 * Drive a per_chat runtime to a live session, then fail its terminal teardown.
 *
 * The unattributable-terminal plumbing (rejectProviderEvent deciding to
 * invalidate) is already pinned by runtime.test.ts. The subject here is what
 * happens once teardown is refused, so this drives that exact production entry
 * point — `invalidateRejectedTerminalSource(session, 'per_chat', reason)` —
 * rather than re-deriving the full provider-dispatch harness.
 */
async function wedgedRuntime(
  opts: { everProvable: boolean },
): Promise<{ runtime: AgentRuntime; state: RuntimeInternals }> {
  const runtime = new AgentRuntime(makeDb(), makeMessenger(), 'test', { sessionScope: 'per_chat' });
  await runtime.start();
  await sendAndDrain(runtime, makeMsg({ content: 'first' }));

  const state = internals(runtime);
  expect(
    state.chatSessions.has(MAP_KEY),
    'precondition: the chat must hold a bound per-chat session before the wedge',
  ).toBe(true);
  const session = state.chatSessions.get(MAP_KEY);

  // The teardown that the process-tree guard refuses. `mockRejectedValueOnce`
  // would let a retry succeed immediately; `everProvable: false` uses a
  // persistent rejection so the never-provable spec cannot silently pass.
  const teardownError = new Error(
    'Refusing to signal session process tree gen-1: pre-signal recensus unavailable',
  );
  if (opts.everProvable) {
    mockSession.shutdown.mockRejectedValueOnce(teardownError);
  } else {
    mockSession.shutdown.mockRejectedValue(teardownError);
  }

  const invalidate = (runtime as unknown as {
    invalidateRejectedTerminalSource: (s: unknown, scope: string, reason: string) => void;
  }).invalidateRejectedTerminalSource;
  invalidate.call(runtime, session, 'per_chat', 'unattributable terminal');

  return { runtime, state };
}

describe('per-chat quarantine — wedge containment and recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession.shutdown.mockReset();
    mockSession.shutdown.mockResolvedValue(undefined);
    mockSession.getStatus.mockReturnValue({
      active: false, pid: null, sessionId: null, startedAt: null,
      messageCount: 0, lastMessageAt: null, turnInFlight: false,
    });
    mockGetActiveSession.mockReturnValue(null);
    mockGetResumableSessionForChat.mockReturnValue(null);
  });

  it('exposes a chatQuarantine registry on the runtime', async () => {
    const runtime = new AgentRuntime(makeDb(), makeMessenger(), 'test', { sessionScope: 'per_chat' });
    await runtime.start();
    expect(
      internals(runtime).chatQuarantine,
      'AgentRuntime must own an explicit per-mapKey quarantine registry',
    ).toBeInstanceOf(Map);
  });

  it('quarantines the mapKey and unbinds the corpse when terminal teardown is refused', async () => {
    const { state } = await wedgedRuntime({ everProvable: false });

    await vi.waitFor(() => {
      expect(
        state.chatQuarantine.has(MAP_KEY),
        'a refused teardown must quarantine the mapKey, not silently strand it',
      ).toBe(true);
    });
    expect(
      state.chatSessions.has(MAP_KEY),
      'the dead SessionManager must not stay bound in chatSessions — that is the wedge',
    ).toBe(false);
    expect(
      state.chatQuarantine.get(MAP_KEY)?.reason,
      'the quarantine record must carry the refusal reason for operator triage',
    ).toMatch(/recensus unavailable|ambiguous/i);
  });

  it('blocks a new session from binding to a quarantined mapKey', async () => {
    const { runtime, state } = await wedgedRuntime({ everProvable: false });
    await vi.waitFor(() => expect(state.chatQuarantine.has(MAP_KEY)).toBe(true));

    mockSession.spawnSession.mockClear();
    mockSession.sendTurn.mockClear();

    await sendAndDrain(runtime, makeMsg({ messageId: 'msg-3', content: 'third' }));

    expect(
      mockSession.sendTurn,
      'no turn may dispatch while the old process tree is unproven — double-agent risk',
    ).not.toHaveBeenCalled();
    expect(state.chatQuarantine.has(MAP_KEY)).toBe(true);
    expect(state.chatSessions.has(MAP_KEY)).toBe(false);
  });

  it('releases the quarantine once the process tree is provably empty', async () => {
    const { runtime, state } = await wedgedRuntime({ everProvable: true });
    await vi.waitFor(() => expect(state.chatQuarantine.has(MAP_KEY)).toBe(true));

    // Proof of death: the retry shutdown now resolves.
    mockSession.shutdown.mockResolvedValue(undefined);

    const sweep = state.sweepQuarantinedChats;
    expect(sweep, 'sweepQuarantinedChats() must be implemented on AgentRuntime').toBeTypeOf('function');
    await sweep!.call(runtime);

    expect(
      state.chatQuarantine.has(MAP_KEY),
      'a provably-empty tree must release the quarantine automatically — no restart, no human',
    ).toBe(false);

    // And the mapKey accepts a session again — the gate is the thing under test,
    // so assert on the gate rather than on provider dispatch (which this mock
    // harness never reaches).
    const bind = (runtime as unknown as {
      setOwnedPerChatSession: (k: string, s: unknown) => void;
    }).setOwnedPerChatSession;
    expect(
      () => bind.call(runtime, MAP_KEY, mockSession),
      'after release the mapKey must accept a fresh session',
    ).not.toThrow();
    expect(state.chatSessions.has(MAP_KEY)).toBe(true);
  });

  it('holds the quarantine and reports the chat stalled while the tree stays unprovable', async () => {
    const { runtime, state } = await wedgedRuntime({ everProvable: false });
    await vi.waitFor(() => expect(state.chatQuarantine.has(MAP_KEY)).toBe(true));

    const sweep = state.sweepQuarantinedChats;
    expect(sweep).toBeTypeOf('function');
    await sweep!.call(runtime);
    await sweep!.call(runtime);

    expect(
      state.chatQuarantine.has(MAP_KEY),
      'an unprovable tree must stay quarantined — releasing it risks two live agents on one chat',
    ).toBe(true);

    const stalled = state.stalledChats;
    expect(stalled, 'stalledChats() must be implemented for chat-level telemetry').toBeTypeOf('function');
    const rows = stalled!.call(runtime, Date.now() + 10 * 60 * 1000);
    expect(
      rows.map((r) => r.mapKey),
      'a quarantined chat must surface as stalled — silence is what made this a 14h outage',
    ).toContain(MAP_KEY);
    expect(
      rows.find((r) => r.mapKey === MAP_KEY)?.attempts,
      'release attempts must be counted so escalation can be bounded',
    ).toBeGreaterThanOrEqual(2);
  });
});
