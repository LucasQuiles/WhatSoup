// tests/runtimes/agent/zombie-sessions.test.ts
// Verifies the zombie-session fix: shutdown() must be called before
// spawnSession() when sendTurnToSession detects an inactive session.
// Without the fix, spawnSession() overwrites this.child, orphaning the old
// process and its watchdog timers.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Database } from '../../../src/core/database.ts';
import type { IncomingMessage, Messenger } from '../../../src/core/types.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import type { IOutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';

// ─── Hoisted mocks ─────────────────────────────────────────────────────────

const { mockSession, mockQueue, callOrder } = vi.hoisted(() => {
  // Shared call-order recorder to verify shutdown precedes spawnSession.
  const callOrder: string[] = [];

  const mockSession = {
    spawnSession: vi.fn(async () => { callOrder.push('spawnSession'); }),
    sendTurn: vi.fn(async () => {}),
    handleNew: vi.fn(async () => {}),
    getStatus: vi.fn(() => ({
      active: false,
      pid: null as number | null,
      sessionId: null as string | null,
      startedAt: null as string | null,
      messageCount: 0,
      lastMessageAt: null as string | null,
    })),
    shutdown: vi.fn(async () => { callOrder.push('shutdown'); }),
    clearTurnWatchdog: vi.fn(() => {}),
    tickWatchdog: vi.fn(() => {}),
    trackToolStart: vi.fn((_toolId: string) => {}),
    trackToolEnd: vi.fn((_toolId: string) => {}),
  };

  const mockQueue = {
    enqueueText: vi.fn(),
    enqueueResultText: vi.fn(),
    enqueueToolUpdate: vi.fn(),
    indicateTyping: vi.fn(),
    flush: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    abortTurn: vi.fn(),
    updateDeliveryJid: vi.fn(),
    setInboundSeq: vi.fn(),
    markLastTerminal: vi.fn(),
    setToolUpdateMode: vi.fn(),
  };

  return { mockSession, mockQueue, callOrder };
});

// ─── Module mocks ──────────────────────────────────────────────────────────

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../src/core/messages.ts', () => ({
  getRecentMessages: vi.fn(() => []),
}));

const { mockGetActiveSession } = vi.hoisted(() => ({
  mockGetActiveSession: vi.fn(() => null as null),
}));

const { mockBackfillWorkspaceKeys, mockSweepOrphanedSessions, mockGetResumableSessionForChat } = vi.hoisted(() => ({
  mockBackfillWorkspaceKeys: vi.fn(),
  mockSweepOrphanedSessions: vi.fn(() => [] as { id: number; claude_pid: number }[]),
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
  sweepOrphanedSessions: mockSweepOrphanedSessions,
  getResumableSessionForChat: mockGetResumableSessionForChat,
}));

vi.mock('../../../src/runtimes/agent/session.ts', () => ({
  // eslint-disable-next-line prefer-arrow-callback
  SessionManager: vi.fn().mockImplementation(function (
    _opts: { onEvent: (event: AgentEvent) => void; onResumeFailed?: () => void },
  ) {
    return mockSession;
  }),
  formatAge: vi.fn(() => '0s ago'),
}));

vi.mock('../../../src/runtimes/agent/outbound-queue.ts', () => ({
  // eslint-disable-next-line prefer-arrow-callback
  OutboundQueue: vi.fn().mockImplementation(function () {
    return mockQueue;
  }),
}));

vi.mock('../../../src/config.ts', () => ({
  config: {
    adminPhones: new Set<string>(),
    controlPeers: new Map<string, string>(),
    toolUpdateMode: 'full',
    pineconeAllowedIndexes: [],
  },
}));

vi.mock('../../../src/core/access-list.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/access-list.ts')>();
  return actual;
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
}));

vi.mock('../../../src/mcp/socket-server.ts', () => ({
  WhatSoupSocketServer: vi.fn().mockImplementation(function () {
    return { start: vi.fn(), stop: vi.fn(), updateDeliveryJid: vi.fn() };
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
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, mkdirSync: vi.fn(), writeFileSync: vi.fn() };
});

// ─── Compile-time interface check ─────────────────────────────────────────

const _mockQueueTypeCheck: IOutboundQueue = mockQueue;
void _mockQueueTypeCheck;

// ─── Import after mocks ───────────────────────────────────────────────────

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeDb(): Database {
  return {
    raw: {
      prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn() })),
      exec: vi.fn(),
    },
  } as unknown as Database;
}

function makeMessenger(): Messenger {
  return { sendMessage: vi.fn(async () => {}) };
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
    isResponseWorthy: true,
    ...overrides,
  };
}

async function sendAndDrain(runtime: AgentRuntime, msg: IncomingMessage): Promise<void> {
  await runtime.handleMessage(msg);
  await (runtime as unknown as { turnChain: Promise<void> }).turnChain;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('zombie session fix — sendTurnToSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callOrder.length = 0;
    // Default: inactive session (triggers the spawn path)
    mockSession.getStatus.mockReturnValue({
      active: false,
      pid: null,
      sessionId: null,
      startedAt: null,
      messageCount: 0,
      lastMessageAt: null,
    });
    mockSession.spawnSession.mockImplementation(async () => { callOrder.push('spawnSession'); });
    mockSession.shutdown.mockImplementation(async () => { callOrder.push('shutdown'); });
    mockGetActiveSession.mockReturnValue(null);
    mockSweepOrphanedSessions.mockReturnValue([]);
    mockGetResumableSessionForChat.mockReturnValue(null);
  });

  it('calls shutdown() before spawnSession() when session is inactive', async () => {
    const runtime = new AgentRuntime(makeDb(), makeMessenger());
    await runtime.start();

    await sendAndDrain(runtime, makeMsg({ content: 'hello' }));

    expect(mockSession.shutdown).toHaveBeenCalledTimes(1);
    expect(mockSession.spawnSession).toHaveBeenCalledTimes(1);
    // Critical: shutdown must precede spawnSession to avoid orphaning the old process.
    expect(callOrder).toEqual(['shutdown', 'spawnSession']);
  });

  it('does not call shutdown() or spawnSession() when session is already active', async () => {
    mockSession.getStatus.mockReturnValue({
      active: true,
      pid: 1234,
      sessionId: 'ses_abc',
      startedAt: new Date().toISOString(),
      messageCount: 1,
      lastMessageAt: new Date().toISOString(),
    });

    const runtime = new AgentRuntime(makeDb(), makeMessenger());
    await runtime.start();

    await sendAndDrain(runtime, makeMsg({ content: 'hello' }));

    expect(mockSession.shutdown).not.toHaveBeenCalled();
    expect(mockSession.spawnSession).not.toHaveBeenCalled();
  });
});
