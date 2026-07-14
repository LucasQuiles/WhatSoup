/**
 * Shape tests for AgentRuntime.getHealthSnapshot().
 *
 * Verifies that the per_chat branch details object contains
 * activeSessions (number), lastSessionStatus (string | null),
 * lastSessionStartedAt (string | null), and fallback-state fields.
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
  // runtime.ts derives its global scope-key constants from this at import time.
  GLOBAL_CONVERSATION_KEY: '__global__',
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
    assertWritableCompatibility: vi.fn(),
    raw: {
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({ run: vi.fn(), get: vi.fn(), all: vi.fn() }),
    },
  } as unknown as Database;
}

function makeMessenger(): Messenger {
  return { sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }), sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }) };
}

function expectedFallbackDetails(): Record<string, unknown> {
  return {
    effectiveProvider: 'claude-cli',
    fallbackActiveUntil: null,
    fallbackReason: null,
    fallbackModel: null,
    fallbackResetAt: null,
    fallbackRecoveryProbeRequired: false,
    fallbackTurnsServed: 0,
    fallbackTurnsEmpty: 0,
    lastFallbackTurnAt: null,
    probeAttempts: 0,
    lastProbeAt: null,
    fallbackActivations: 0,
    fallbackReverts: 0,
    fallbackReplays: 0,
    fallbackWindowCostUsd: 0,
    primaryModelUsability: null,
    turnCapability: {
      modelUsable: null,
      modelUsableStale: false,
      modelUsableCheckedAt: null,
      modelUsabilityStatus: null,
      lastSuccessfulTurnAt: null,
      lastTurnErrorClass: null,
      lastTurnErrorAt: null,
    },
    activeFallbackEntry: null,
    fallbackChain: [],
    fallbackChainExhausted: false,
    failedEntryCount: 0,
    turnErrorCounts: {},
    handoffDistiller: {
      enabled: false,
      contextInjection: false,
      model: null,
    },
  };
}

function expectedTurnRecoveryDetails(): Record<string, number> {
  return {
    turnRecoveryOutstanding: 0,
    turnRecoveryPending: 0,
    turnRecoveryLiveClaimed: 0,
    turnRecoveryExpiredClaimed: 0,
    turnRecoveryBlockedUnsafe: 0,
    turnRecoveryExhausted: 0,
    turnRecoveryOpenRecoveries: 0,
    turnRecoveryQuarantinedDelivery: 0,
    turnRecoveryCorruptLinks: 0,
    turnRecoveryOrphanTransfers: 0,
    turnRecoveryEchoConflicts: 0,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('AgentRuntime.getHealthSnapshot — per_chat shape', () => {
  let runtime: AgentRuntime;

  beforeEach(() => {
    mockSession.getStatus.mockReturnValue({
      active: false,
      pid: null,
      sessionId: null,
      startedAt: null,
      messageCount: 0,
      lastMessageAt: null,
    });

    runtime = new AgentRuntime(makeDb(), makeMessenger(), 'test', {
      sessionScope: 'per_chat',
    });
  });

  it('details contains activeSessions as a number', () => {
    const snapshot = runtime.getHealthSnapshot();
    expect(typeof snapshot.details['activeSessions']).toBe('number');
  });

  it('details contains lastSessionStatus as string or null', () => {
    const snapshot = runtime.getHealthSnapshot();
    const val = snapshot.details['lastSessionStatus'];
    expect(val === null || typeof val === 'string').toBe(true);
  });

  it('details contains lastSessionStartedAt as string or null', () => {
    const snapshot = runtime.getHealthSnapshot();
    const val = snapshot.details['lastSessionStartedAt'];
    expect(val === null || typeof val === 'string').toBe(true);
  });

  it('lastSessionStatus is null when no sessions exist', () => {
    const snapshot = runtime.getHealthSnapshot();
    expect(snapshot).toStrictEqual({
      status: 'healthy',
      details: {
        activeSessions: 0,
        lastSessionStatus: null,
        lastSessionStartedAt: null,
        sessionCount: 0,
        recentCrashes: 0,
        lastCrashAt: null,
        pollPersistenceErrors: 0,
        autoCompactIneffective: 0,
        autoCompactConsecutiveRapidRearmsMax: 0,
        autoCompactNextTurnOverThreshold: 0,
        proactiveResumeIdentityRejects: 0,
        turnFinalizationRetainedRetries: 0,
        turnFinalizationDegradedScopes: 0,
        turnFinalizationRetryAttempts: 0,
        turnFinalizationRetryRecoveries: 0,
        turnFinalizationRetryExhaustions: 0,
        ...expectedTurnRecoveryDetails(),
        ...expectedFallbackDetails(),
      },
    });
  });

  it('lastSessionStartedAt is null when no sessions exist', () => {
    const snapshot = runtime.getHealthSnapshot();
    expect(snapshot).toStrictEqual({
      status: 'healthy',
      details: {
        activeSessions: 0,
        lastSessionStatus: null,
        lastSessionStartedAt: null,
        sessionCount: 0,
        recentCrashes: 0,
        lastCrashAt: null,
        pollPersistenceErrors: 0,
        autoCompactIneffective: 0,
        autoCompactConsecutiveRapidRearmsMax: 0,
        autoCompactNextTurnOverThreshold: 0,
        proactiveResumeIdentityRejects: 0,
        turnFinalizationRetainedRetries: 0,
        turnFinalizationDegradedScopes: 0,
        turnFinalizationRetryAttempts: 0,
        turnFinalizationRetryRecoveries: 0,
        turnFinalizationRetryExhaustions: 0,
        ...expectedTurnRecoveryDetails(),
        ...expectedFallbackDetails(),
      },
    });
  });

  it('activeSessions is 0 when no sessions exist', () => {
    const snapshot = runtime.getHealthSnapshot();
    expect(snapshot.details['activeSessions']).toBe(0);
  });

  it('reports degraded while a provider fallback window is active', () => {
    const state = runtime as unknown as {
      fallbackWindow: {
        activeUntil: number | null;
        activeEntry: { provider: string; model?: string } | null;
      };
    };
    state.fallbackWindow.activeUntil = Date.now() + 60_000;
    state.fallbackWindow.activeEntry = { provider: 'openai-api', model: 'gpt-5.5' };

    const snapshot = runtime.getHealthSnapshot();
    expect(snapshot.status).toBe('degraded');
  });

  it('snapshot has a valid status string', () => {
    const snapshot = runtime.getHealthSnapshot();
    expect(['healthy', 'degraded', 'unhealthy']).toContain(snapshot.status);
  });
});

describe('AgentRuntime.getHealthSnapshot — single-session shape', () => {
  it('includes auto-compact counters in the non-per-chat branch', () => {
    mockSession.getStatus.mockReturnValue({
      active: false,
      pid: null,
      sessionId: null,
      startedAt: null,
      messageCount: 0,
      lastMessageAt: null,
    });

    const runtime = new AgentRuntime(makeDb(), makeMessenger(), 'test');

    expect(runtime.getHealthSnapshot()).toStrictEqual({
      status: 'healthy',
      details: {
        active: false,
        pid: null,
        sessionId: null,
        pollPersistenceErrors: 0,
        autoCompactIneffective: 0,
        autoCompactConsecutiveRapidRearmsMax: 0,
        autoCompactNextTurnOverThreshold: 0,
        proactiveResumeIdentityRejects: 0,
        turnFinalizationRetainedRetries: 0,
        turnFinalizationDegradedScopes: 0,
        turnFinalizationRetryAttempts: 0,
        turnFinalizationRetryRecoveries: 0,
        turnFinalizationRetryExhaustions: 0,
        ...expectedTurnRecoveryDetails(),
        ...expectedFallbackDetails(),
      },
    });
  });
});
