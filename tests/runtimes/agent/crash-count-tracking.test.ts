/**
 * Characterization tests for AgentRuntime's crash-count tracking cluster
 * (recordCrash / getCrashCount / getRecentCrashCount / decrementCrashCount /
 * getCrashScopeKey + the perChatCrashCount map and lastCrashAt).
 *
 * These LOCK the current observable behavior ahead of the planned extraction of
 * this cluster into a focused CrashTracker collaborator (god-class decomposition,
 * slice 1). The recentCrashes / lastCrashAt assertions go through the PUBLIC
 * getHealthSnapshot() surface so they survive the refactor; the per-scope count
 * and scope-key assertions use the same cast-to-private pattern the existing
 * runtime suite uses, to pin the unit behavior the collaborator must preserve.
 *
 * No behavior change — pure characterization.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const { mockSession, mockQueue, capturedOnEventRef } = vi.hoisted(() => {
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
    })),
    shutdown: vi.fn(async () => {}),
    clearTurnWatchdog: vi.fn(() => {}),
    tickWatchdog: vi.fn(() => {}),
    trackToolStart: vi.fn((_toolId: string) => {}),
    trackToolEnd: vi.fn((_toolId: string) => {}),
  };

  const mockQueue = {
    enqueueText: vi.fn(),
    getSenderToken: () => 'mock-sender-token',
    enqueueStreamingText: vi.fn(),
    enqueueToolUpdate: vi.fn(),
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
  };

  return { mockSession, mockQueue, capturedOnEventRef };
});

// ── Module mocks ────────────────────────────────────────────────────────────

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

vi.mock('../../../src/runtimes/agent/session-db.ts', () => ({
  ensureAgentSchema: vi.fn(),
  createSession: vi.fn(() => 1),
  incrementMessageCount: vi.fn(),
  updateSessionId: vi.fn(),
  updateSessionStatus: vi.fn(),
  getActiveSession: vi.fn(() => null),
  backfillWorkspaceKeys: vi.fn(),
  markOrphaned: vi.fn(),
  getResumableSessionForChat: vi.fn(() => null),
  backfillSessionProvider: vi.fn(),
}));

vi.mock('../../../src/runtimes/agent/session.ts', () => ({
  SessionManager: vi.fn().mockImplementation(function (
    opts: { onEvent: (event: AgentEvent) => void },
  ) {
    capturedOnEventRef.current = opts.onEvent;
    return mockSession;
  }),
  formatAge: vi.fn(() => '0s ago'),
}));

vi.mock('../../../src/runtimes/agent/outbound-queue.ts', () => ({
  OutboundQueue: vi.fn().mockImplementation(function () {
    return mockQueue;
  }),
}));

vi.mock('../../../src/config.ts', () => ({
  config: {
    adminPhones: new Set<string>(),
    controlPeers: new Map<string, string>(),
    toolUpdateMode: 'full',
    toolUpdateRedirectJid: null,
    textAggregateDelayMs: 2_000,
    agentProvider: 'claude-cli',
    agentProviderConfig: undefined,
    agentFallbacks: [],
    agentFallbackProvider: undefined,
    agentFallbackModel: undefined,
  },
}));

vi.mock('../../../src/core/access-list.ts', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../../../src/core/access-list.ts');
  return actual;
});

vi.mock('../../../src/core/workspace.ts', () => ({
  chatJidToWorkspace: vi.fn((_cwd: string, chatJid: string) => {
    const key = chatJid.replace('@s.whatsapp.net', '');
    return { kind: 'dm' as const, workspaceKey: key, workspacePath: `/tmp/${key}` };
  }),
  provisionWorkspace: vi.fn(() => '/tmp/ws/.claude/whatsoup.sock'),
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
  return { ...actual, mkdirSync: vi.fn(), writeFileSync: vi.fn(), copyFileSync: vi.fn() };
});

vi.mock('../../../src/runtimes/agent/media-bridge.ts', () => ({
  startMediaBridge: vi.fn(() => null),
  setMediaBridgeChat: vi.fn(),
}));

vi.mock('../../../src/core/durability.ts', () => ({
  sendTracked: vi.fn(),
}));

vi.mock('../../../src/core/conversation-key.ts', () => ({
  toConversationKey: vi.fn((jid: string) => jid),
}));

vi.mock('../../../src/core/heal-protocol.ts', () => ({
  EmitHealResultSchema: {},
}));

vi.mock('../../../src/core/heal.ts', () => ({
  dequeueNextReport: vi.fn(),
  emitHealReport: vi.fn(),
}));

vi.mock('../../../src/mcp/register-all.ts', () => ({
  registerAllTools: vi.fn(),
}));

vi.mock('../../../src/runtimes/agent/turn-queue.ts', () => {
  class TurnQueue {
    enqueue = vi.fn();
    drain = vi.fn();
    clear = vi.fn();
    setProcessor = vi.fn();
    get pending() { return 0; }
  }
  return { TurnQueue };
});

vi.mock('../../../src/runtimes/agent/control-queue.ts', () => ({
  ControlQueue: vi.fn().mockImplementation(function () {
    return mockQueue;
  }),
}));

vi.mock('../../../src/core/media-mime.ts', () => ({
  extractRawMime: vi.fn(),
}));

// ── Imports ─────────────────────────────────────────────────────────────────

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeDb(): Database {
  return {
    raw: {
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({ run: vi.fn(), get: vi.fn(), all: vi.fn() }),
    },
  } as unknown as Database;
}

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
    sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
  } as unknown as Messenger;
}

/** The private crash-count surface this slice characterizes. */
interface CrashCountSurface {
  recordCrash(mapKey: string): number;
  getCrashCount(mapKey: string): number;
  getRecentCrashCount(): number;
  decrementCrashCount(mapKey: string): void;
  getCrashScopeKey(chatJid: string): string;
}

function crashSurface(runtime: AgentRuntime): CrashCountSurface {
  return runtime as unknown as CrashCountSurface;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('AgentRuntime crash-count tracking (characterization)', () => {
  let runtime: AgentRuntime;
  let crash: CrashCountSurface;

  beforeEach(() => {
    runtime = new AgentRuntime(makeDb(), makeMessenger(), 'test', {
      sessionScope: 'per_chat',
    });
    crash = crashSurface(runtime);
  });

  it('recordCrash increments per-scope count and returns the new value', () => {
    expect(crash.recordCrash('a')).toBe(1);
    expect(crash.recordCrash('a')).toBe(2);
    expect(crash.recordCrash('b')).toBe(1);
    expect(crash.getCrashCount('a')).toBe(2);
    expect(crash.getCrashCount('b')).toBe(1);
  });

  it('getCrashCount returns 0 for an unrecorded scope', () => {
    expect(crash.getCrashCount('never-seen')).toBe(0);
  });

  it('getRecentCrashCount sums counts across every scope', () => {
    crash.recordCrash('a');
    crash.recordCrash('a');
    crash.recordCrash('b');
    expect(crash.getRecentCrashCount()).toBe(3);
  });

  it('getHealthSnapshot reflects the recent crash total and stamps lastCrashAt', () => {
    let snap = runtime.getHealthSnapshot();
    expect(snap.details['recentCrashes']).toBe(0);
    expect(snap.details['lastCrashAt']).toBeNull();

    crash.recordCrash('a');
    crash.recordCrash('a');
    crash.recordCrash('b');

    snap = runtime.getHealthSnapshot();
    expect(snap.details['recentCrashes']).toBe(3);
    expect(typeof snap.details['lastCrashAt']).toBe('string');
    expect(snap.details['lastCrashAt']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('decrementCrashCount decrements above 1 and deletes the scope at 1', () => {
    crash.recordCrash('a');
    crash.recordCrash('a');
    crash.recordCrash('a'); // count = 3

    crash.decrementCrashCount('a');
    expect(crash.getCrashCount('a')).toBe(2);

    crash.decrementCrashCount('a');
    expect(crash.getCrashCount('a')).toBe(1);

    // At 1, the scope is removed entirely (count returns to 0).
    crash.decrementCrashCount('a');
    expect(crash.getCrashCount('a')).toBe(0);
    expect(crash.getRecentCrashCount()).toBe(0);
  });

  it('decrementCrashCount on an unknown scope is a no-op (stays 0)', () => {
    crash.decrementCrashCount('absent');
    expect(crash.getCrashCount('absent')).toBe(0);
    expect(crash.getRecentCrashCount()).toBe(0);
  });
});

describe('AgentRuntime getCrashScopeKey (characterization)', () => {
  const CHAT = 'alice@s.whatsapp.net';

  it('returns the global scope key when sessionScope is not per_chat', () => {
    const runtime = new AgentRuntime(makeDb(), makeMessenger(), 'test'); // sessionScope defaults to 'single'
    expect(crashSurface(runtime).getCrashScopeKey(CHAT)).toBe('__global__');
  });

  it('returns the raw chatJid for per_chat without sandboxing', () => {
    const runtime = new AgentRuntime(makeDb(), makeMessenger(), 'test', {
      sessionScope: 'per_chat',
    });
    expect(crashSurface(runtime).getCrashScopeKey(CHAT)).toBe(CHAT);
  });

  it('returns the workspace key for per_chat with sandboxPerChat', () => {
    const runtime = new AgentRuntime(makeDb(), makeMessenger(), 'test', {
      sessionScope: 'per_chat',
      sandboxPerChat: true,
    });
    // chatJidToWorkspace is mocked to strip the @s.whatsapp.net suffix.
    expect(crashSurface(runtime).getCrashScopeKey(CHAT)).toBe('alice');
  });
});
