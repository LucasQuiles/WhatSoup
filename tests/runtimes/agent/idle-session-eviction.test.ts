// tests/runtimes/agent/idle-session-eviction.test.ts
// TDD for the idle-session eviction fix: a resident per-chat agent session that
// has been idle (no message) beyond SESSION_IDLE_MS must be gracefully suspended
// via shutdown(true) and removed from chatSessions, so resident sessions stay
// bounded instead of accumulating until the host runs out of memory.
//
// Guards (must NOT evict): a turn in flight, a recently-active session within the
// TTL, or a session younger than the minimum-residency floor.
//
// Mock scaffolding mirrors zombie-sessions.test.ts.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Database } from '../../../src/core/database.ts';
import type { IncomingMessage, Messenger } from '../../../src/core/types.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import type { IOutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';

const { mockSession, mockQueue } = vi.hoisted(() => {
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
    tickWatchdog: vi.fn(() => {}),
    trackToolStart: vi.fn((_toolId: string) => {}),
    trackToolEnd: vi.fn((_toolId: string) => {}),
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
    setToolUpdateMode: vi.fn(),
    setToolUpdateRedirectJid: vi.fn(),
    setTextAggregateDelayMs: vi.fn(),
    targetChatJid: 'test@s.whatsapp.net',
    getLastOpId: vi.fn(() => undefined),
    setDurability: vi.fn(),
    enqueuePoll: vi.fn(async (sendFn: () => Promise<void>) => sendFn()),
    setPollPending: vi.fn(),
  };

  return { mockSession, mockQueue };
});

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
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
    _opts: { onEvent: (event: AgentEvent) => void; onResumeFailed?: () => void },
  ) {
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
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs');
  return { ...actual, mkdirSync: vi.fn(), writeFileSync: vi.fn() };
});

const _mockQueueTypeCheck: IOutboundQueue = mockQueue;
void _mockQueueTypeCheck;

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';

function makeDb(): Database {
  return { raw: { prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn() })), exec: vi.fn() } } as unknown as Database;
}
function makeMessenger(): Messenger {
  return { sendMessage: vi.fn(async () => ({ waMessageId: null })), sendMedia: vi.fn(async () => ({ waMessageId: null })) };
}
function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: 'msg-1', chatJid: 'test@s.whatsapp.net', senderJid: 'sender@s.whatsapp.net',
    senderName: 'Test User', content: 'hello', contentType: 'text', isFromMe: false, isGroup: false,
    mentionedJids: [], timestamp: Date.now(), quotedMessageId: null, contentText: null,
    isResponseWorthy: true, ...overrides,
  };
}
async function sendAndDrain(runtime: AgentRuntime, msg: IncomingMessage): Promise<void> {
  await runtime.handleMessage(msg);
  await (runtime as unknown as { turnChain: Promise<void> }).turnChain;
}

function isoAgo(ms: number): string { return new Date(Date.now() - ms).toISOString(); }
const HOUR = 60 * 60 * 1000;

/** Make a resident session, then return the runtime's chatSessions map. */
async function residentRuntime(): Promise<{ runtime: AgentRuntime; sessions: Map<string, unknown> }> {
  // per_chat is the scope where each chat gets its own resident session (the leak surface).
  const runtime = new AgentRuntime(makeDb(), makeMessenger(), 'test', { sessionScope: 'per_chat' });
  await runtime.start();
  await sendAndDrain(runtime, makeMsg({ content: 'hi' }));
  mockSession.shutdown.mockClear(); // setup's inactive-path shutdown is noise for these assertions
  // The mock turn never fires the result handler that clears pendingTurnText, so
  // clear it to simulate turn completion — otherwise the mid-dispatch guard
  // (correctly) blocks eviction. These tests isolate the idle-TTL behavior.
  (runtime as unknown as { pendingTurnText: Map<string, string> }).pendingTurnText.clear();
  const sessions = (runtime as unknown as { chatSessions: Map<string, unknown> }).chatSessions;
  return { runtime, sessions };
}

function callSweep(runtime: AgentRuntime): void {
  const sweep = (runtime as unknown as { sweepIdleSessions?: () => void }).sweepIdleSessions;
  expect(sweep, 'sweepIdleSessions() must be implemented on AgentRuntime').toBeTypeOf('function');
  sweep!.call(runtime);
}

describe('idle session eviction — sweepIdleSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession.getStatus.mockReturnValue({
      active: false, pid: null, sessionId: null, startedAt: null,
      messageCount: 0, lastMessageAt: null, turnInFlight: false,
    });
    mockGetActiveSession.mockReturnValue(null);
    mockGetResumableSessionForChat.mockReturnValue(null);
  });

  it('suspends an active session idle beyond the TTL via shutdown(true) and drops it', async () => {
    const { runtime, sessions } = await residentRuntime();
    expect(sessions.size).toBe(1);
    // active, started long ago, no message for 3h, no turn in flight → evictable
    mockSession.getStatus.mockReturnValue({
      active: true, pid: 1234, sessionId: 'ses', startedAt: isoAgo(4 * HOUR),
      messageCount: 1, lastMessageAt: isoAgo(3 * HOUR), turnInFlight: false,
    });

    callSweep(runtime);

    expect(mockSession.shutdown).toHaveBeenCalledWith(true);
    expect(sessions.size).toBe(0);
  });

  it('does NOT suspend a session with a turn in flight', async () => {
    const { runtime, sessions } = await residentRuntime();
    mockSession.getStatus.mockReturnValue({
      active: true, pid: 1234, sessionId: 'ses', startedAt: isoAgo(4 * HOUR),
      messageCount: 1, lastMessageAt: isoAgo(3 * HOUR), turnInFlight: true, // busy
    });

    callSweep(runtime);

    expect(mockSession.shutdown).not.toHaveBeenCalled();
    expect(sessions.size).toBe(1);
  });

  it('does NOT suspend a session active within the idle TTL', async () => {
    const { runtime, sessions } = await residentRuntime();
    mockSession.getStatus.mockReturnValue({
      active: true, pid: 1234, sessionId: 'ses', startedAt: isoAgo(4 * HOUR),
      messageCount: 1, lastMessageAt: isoAgo(60 * 1000), turnInFlight: false, // 1 min ago
    });

    callSweep(runtime);

    expect(mockSession.shutdown).not.toHaveBeenCalled();
    expect(sessions.size).toBe(1);
  });
});

// A standalone fake session whose getStatus is independently controllable, so the
// LRU ceiling (which must distinguish longest-idle across many sessions) can be
// tested — the shared mockSession is a singleton and cannot model distinct chats.
interface FakeSession { shutdown: ReturnType<typeof vi.fn>; getStatus: () => unknown }
function fakeSession(opts: { lastAgoMs: number; startedAgoMs?: number; turnInFlight?: boolean; active?: boolean }): FakeSession {
  return {
    shutdown: vi.fn(async () => {}),
    getStatus: () => ({
      active: opts.active ?? true, pid: 1, sessionId: 's', startedAt: isoAgo(opts.startedAgoMs ?? 4 * HOUR),
      messageCount: 1, lastMessageAt: isoAgo(opts.lastAgoMs), turnInFlight: opts.turnInFlight ?? false,
    }),
  };
}
async function seededRuntime(seed: Record<string, FakeSession>): Promise<{ runtime: AgentRuntime; sessions: Map<string, FakeSession> }> {
  const runtime = new AgentRuntime(makeDb(), makeMessenger(), 'test', { sessionScope: 'per_chat' });
  await runtime.start();
  const sessions = (runtime as unknown as { chatSessions: Map<string, FakeSession> }).chatSessions;
  sessions.clear();
  for (const [k, v] of Object.entries(seed)) sessions.set(k, v);
  return { runtime, sessions };
}

describe('idle session eviction — LRU ceiling and poll guard', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('LRU ceiling: when over MAX_RESIDENT_SESSIONS, suspends the longest-idle even within TTL', async () => {
    // 14 sessions, all active and within the 1h TTL (1..14 min idle) — pass 1 evicts none.
    // Default cap is 12, so the LRU pass must evict the 2 longest-idle (chat14, chat13).
    const seed: Record<string, FakeSession> = {};
    for (let i = 1; i <= 14; i++) seed[`chat${i}`] = fakeSession({ lastAgoMs: i * 60 * 1000 });
    const { runtime, sessions } = await seededRuntime(seed);
    expect(sessions.size).toBe(14);

    (runtime as unknown as { sweepIdleSessions: () => void }).sweepIdleSessions();

    expect(sessions.size).toBe(12);
    expect(seed['chat14'].shutdown).toHaveBeenCalledWith(true); // longest idle
    expect(seed['chat13'].shutdown).toHaveBeenCalledWith(true);
    expect(seed['chat1'].shutdown).not.toHaveBeenCalled();      // most recent kept
  });

  it('does NOT suspend an idle-beyond-TTL session that is awaiting a poll vote', async () => {
    const s = fakeSession({ lastAgoMs: 3 * 60 * 60 * 1000 }); // 3h idle
    const { runtime, sessions } = await seededRuntime({ pollchat: s });
    (runtime as unknown as { pendingPolls: { questions: Map<string, unknown> } })
      .pendingPolls.questions.set('pollchat', { chatJid: 'pollchat' });

    (runtime as unknown as { sweepIdleSessions: () => void }).sweepIdleSessions();

    expect(s.shutdown).not.toHaveBeenCalled();
    expect(sessions.size).toBe(1);
  });

  it('cleans co-keyed per-chat state (cleanupPerChatState) when it suspends a session', async () => {
    const s = fakeSession({ lastAgoMs: 3 * 60 * 60 * 1000 }); // 3h idle → evictable
    const { runtime, sessions } = await seededRuntime({ auxchat: s });
    const rt = runtime as unknown as {
      sweepIdleSessions: () => void;
      perChatTurnText: Map<string, string>;
      perChatInboundSeqQueue: Map<string, number[]>;
    };
    rt.perChatTurnText.set('auxchat', 'leftover');
    rt.perChatInboundSeqQueue.set('auxchat', [1, 2]);

    rt.sweepIdleSessions();

    expect(s.shutdown).toHaveBeenCalledWith(true);
    expect(sessions.has('auxchat')).toBe(false);
    // The canonical teardown must run — otherwise eviction leaks auxiliary state.
    expect(rt.perChatTurnText.has('auxchat')).toBe(false);
    expect(rt.perChatInboundSeqQueue.has('auxchat')).toBe(false);
  });

  it('does NOT suspend an idle session with images buffered mid-coalesce (would drop the images)', async () => {
    // Regression: image receipt opens a 3s coalesce buffer without setting
    // pendingTurnText or refreshing lastMessageAt, so an idle/LRU-selected session
    // could be evicted mid-buffer — cleanupPerChatState aborts the buffer, dropping
    // the user's images and disarming the reply guarantee.
    const s = fakeSession({ lastAgoMs: 3 * 60 * 60 * 1000 }); // 3h idle
    const { runtime, sessions } = await seededRuntime({ imgchat: s });
    (runtime as unknown as { imageCoalesce: { buffers: Map<string, unknown> } })
      .imageCoalesce.buffers.set('imgchat', { inboundSeqs: [1], timer: null });

    (runtime as unknown as { sweepIdleSessions: () => void }).sweepIdleSessions();

    expect(s.shutdown).not.toHaveBeenCalled();
    expect(sessions.size).toBe(1);
  });

  it('does NOT suspend a session younger than the residency floor (anti-thrash)', async () => {
    // started 1 min ago (< 5 min floor) but idle 3h — must be kept.
    const s = fakeSession({ lastAgoMs: 3 * 60 * 60 * 1000, startedAgoMs: 60 * 1000 });
    const { runtime, sessions } = await seededRuntime({ freshborn: s });
    (runtime as unknown as { sweepIdleSessions: () => void }).sweepIdleSessions();
    expect(s.shutdown).not.toHaveBeenCalled();
    expect(sessions.size).toBe(1);
  });

  it('does NOT suspend the synthetic control session', async () => {
    // The control-session guard is identity-based (session === this.controlSession),
    // independent of the map key, so a benign key suffices.
    const s = fakeSession({ lastAgoMs: 3 * 60 * 60 * 1000 });
    const { runtime, sessions } = await seededRuntime({ ctrlchat: s });
    (runtime as unknown as { controlSession: unknown }).controlSession = s;
    (runtime as unknown as { sweepIdleSessions: () => void }).sweepIdleSessions();
    expect(s.shutdown).not.toHaveBeenCalled();
    expect(sessions.size).toBe(1);
  });

  it('does NOT suspend an inactive session (active=false)', async () => {
    const s = fakeSession({ lastAgoMs: 3 * 60 * 60 * 1000, active: false });
    const { runtime, sessions } = await seededRuntime({ deadchat: s });
    (runtime as unknown as { sweepIdleSessions: () => void }).sweepIdleSessions();
    expect(s.shutdown).not.toHaveBeenCalled();
    expect(sessions.size).toBe(1);
  });

  it('tears down the chat outbound queue (abortTurn + delete) when it suspends a session', async () => {
    const s = fakeSession({ lastAgoMs: 3 * 60 * 60 * 1000 });
    const { runtime, sessions } = await seededRuntime({ qchat: s });
    const queue = { abortTurn: vi.fn(), shutdown: vi.fn(async () => {}) };
    (runtime as unknown as { chatQueues: Map<string, unknown> }).chatQueues.set('qchat', queue);

    (runtime as unknown as { sweepIdleSessions: () => void }).sweepIdleSessions();

    expect(s.shutdown).toHaveBeenCalledWith(true);
    expect(sessions.has('qchat')).toBe(false);
    expect(queue.abortTurn).toHaveBeenCalled();
    expect((runtime as unknown as { chatQueues: Map<string, unknown> }).chatQueues.has('qchat')).toBe(false);
  });

  it('does NOT suspend an idle-beyond-TTL session with a turn mid-dispatch (pendingTurnText)', async () => {
    // Guards the dispatch race: pendingTurnText is set before the session ref is
    // captured for dispatch, so a sweep firing during that window must not evict.
    const s = fakeSession({ lastAgoMs: 3 * 60 * 60 * 1000 }); // 3h idle
    const { runtime, sessions } = await seededRuntime({ dispatchchat: s });
    (runtime as unknown as { pendingTurnText: Map<string, string> })
      .pendingTurnText.set('dispatchchat', 'hello');

    (runtime as unknown as { sweepIdleSessions: () => void }).sweepIdleSessions();

    expect(s.shutdown).not.toHaveBeenCalled();
    expect(sessions.size).toBe(1);
  });
});
