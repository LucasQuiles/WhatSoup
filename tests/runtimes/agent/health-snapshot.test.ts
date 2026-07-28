/**
 * Shape tests for AgentRuntime.getHealthSnapshot().
 *
 * Verifies that the per_chat branch details object contains
 * activeSessions (number), lastSessionStatus (string | null),
 * lastSessionStartedAt (string | null), and fallback-state fields.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import type { ProviderExecutionGate } from '../../../src/runtimes/agent/provider-execution-gate.ts';
import type { AutoCompactController } from '../../../src/runtimes/agent/auto-compact-controller.ts';

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const { mockSession, mockQueue, capturedOnEventRef, capturedTurnQueues } = vi.hoisted(() => {
  const capturedOnEventRef: { current: ((event: AgentEvent) => void) | null } = { current: null };
  const capturedTurnQueues: Array<{
    enqueue: ReturnType<typeof vi.fn>;
    halt: () => void;
    isHalted: boolean;
  }> = [];

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
    completeProviderTurn: vi.fn(() => {}),
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

  return { mockSession, mockQueue, capturedOnEventRef, capturedTurnQueues };
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

vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlertChecked: vi.fn(),
  clearAlertSourceChecked: vi.fn(),
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
    stateRoot: '/tmp/whatsoup-test-state-health',
    restartLoopGuard: { enabled: true, maxRestarts: 3, windowMs: 300_000 },
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
    private halted = false;
    private readonly onHalt?: () => void;
    activeTurn = null;
    enqueue = vi.fn(() => true);
    drain = vi.fn();
    clear = vi.fn();
    setProcessor = vi.fn();
    closeAndTakePendingTurns = vi.fn(() => []);
    get pending() { return 0; }
    get isHalted() { return this.halted; }

    constructor(opts?: { onHalt?: () => void }) {
      this.onHalt = opts?.onHalt;
      capturedTurnQueues.push(this);
    }

    halt(): void {
      if (this.halted) return;
      this.halted = true;
      this.onHalt?.();
    }

    private closeEpoch = 0;
    private accepting = true;
    beginTeardown(): { pending: readonly never[]; closeEpoch: number; wasAccepting: boolean } {
      const receipt = Object.freeze({
        pending: Object.freeze([]) as readonly never[],
        closeEpoch: ++this.closeEpoch,
        wasAccepting: this.accepting,
      });
      this.accepting = false;
      return receipt;
    }
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

function expectedProviderExecutionDetails(): Record<string, unknown> {
  return {
    providerExecution: {
      active: false,
      activeWorkKind: null,
      activeScopeHash: null,
      pending: 0,
      oldestPendingWorkKind: null,
      oldestPendingScopeHash: null,
      oldestWaitMs: 0,
      totalWaits: 0,
      maxPending: 0,
      lastWaitMs: 0,
      abortedWaits: 0,
      pressureActive: false,
    },
  };
}

function expectedTurnQueueDetails(): Record<string, unknown> {
  return {
    turnQueueHalted: false,
    turnQueueHaltedScopes: 0,
  };
}

function makeQueuedTurn(text: string) {
  return {
    sourceMessageId: `wamid-${text}`,
    conversationKey: 'private-conversation',
    chatJid: '15550190099@s.whatsapp.net',
    senderJid: '15550190099@s.whatsapp.net',
    senderName: null,
    text,
    isGroup: false,
    contentType: 'text' as const,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('AgentRuntime.getHealthSnapshot — per_chat shape', () => {
  let runtime: AgentRuntime;

  beforeEach(() => {
    capturedTurnQueues.length = 0;
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
        autoCompactState: 'idle',
        autoCompactActiveBackoffScopes: 0,
        autoCompactWorstCurrentBackoffTier: 0,
        proactiveResumeIdentityRejects: 0,
        restartLoopGuard: { enabled: true, bootsInWindow: 0, tripped: false, lastTripAt: null, windowMs: 300_000, bootsTotal: 0, checksPerformed: 0, lastCheckAt: null },
        unownedProviderEventRejects: 0,
        chronologyDelayedDispatches: 0,
        chronologyRecoveryReplayDispatches: 0,
        degradedReasons: [],
        chronologyMaxQueueAgeSeconds: 0,
        turnFinalizationRetainedRetries: 0,
        turnFinalizationDegradedScopes: 0,
        turnFinalizationRetryAttempts: 0,
        turnFinalizationRetryRecoveries: 0,
        turnFinalizationRetryExhaustions: 0,
        ...expectedTurnQueueDetails(),
        ...expectedProviderExecutionDetails(),
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
        autoCompactState: 'idle',
        autoCompactActiveBackoffScopes: 0,
        autoCompactWorstCurrentBackoffTier: 0,
        proactiveResumeIdentityRejects: 0,
        restartLoopGuard: { enabled: true, bootsInWindow: 0, tripped: false, lastTripAt: null, windowMs: 300_000, bootsTotal: 0, checksPerformed: 0, lastCheckAt: null },
        unownedProviderEventRejects: 0,
        chronologyDelayedDispatches: 0,
        chronologyRecoveryReplayDispatches: 0,
        degradedReasons: [],
        chronologyMaxQueueAgeSeconds: 0,
        turnFinalizationRetainedRetries: 0,
        turnFinalizationDegradedScopes: 0,
        turnFinalizationRetryAttempts: 0,
        turnFinalizationRetryRecoveries: 0,
        turnFinalizationRetryExhaustions: 0,
        ...expectedTurnQueueDetails(),
        ...expectedProviderExecutionDetails(),
        ...expectedTurnRecoveryDetails(),
        ...expectedFallbackDetails(),
      },
    });
  });

  it('activeSessions is 0 when no sessions exist', () => {
    const snapshot = runtime.getHealthSnapshot();
    expect(snapshot.details['activeSessions']).toBe(0);
  });

  it('degrades only while provider execution pressure is active', async () => {
    vi.useFakeTimers();
    try {
      runtime = new AgentRuntime(makeDb(), makeMessenger(), 'test', {
        sessionScope: 'per_chat',
      });
      const gate = (runtime as unknown as { providerExecutionGate: ProviderExecutionGate }).providerExecutionGate;
      const first = await gate.acquire();
      const secondPromise = gate.acquire();
      await vi.advanceTimersByTimeAsync(29_999);
      expect(runtime.getHealthSnapshot().status).toBe('healthy');
      await vi.advanceTimersByTimeAsync(1);
      expect(runtime.getHealthSnapshot().status).toBe('degraded');
      first.release();
      const second = await secondPromise;
      second.release();
      expect(runtime.getHealthSnapshot().status).toBe('healthy');
    } finally {
      vi.useRealTimers();
    }
  });

  it('degrades only while aggregate auto-compact backoff is active', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(1_000));
      const autoCompact = (runtime as unknown as {
        autoCompact: AutoCompactController;
      }).autoCompact;
      autoCompact.recordAutoCompactRapidRearm('private-scope', 100, Date.now());

      expect(runtime.getHealthSnapshot()).toMatchObject({
        status: 'degraded',
        details: {
          degradedReasons: ['auto_compact_backoff'],
          autoCompactState: 'backoff',
          autoCompactActiveBackoffScopes: 1,
          autoCompactWorstCurrentBackoffTier: 1,
          autoCompactIneffective: 1,
          autoCompactConsecutiveRapidRearmsMax: 1,
        },
      });
      expect(JSON.stringify(runtime.getHealthSnapshot().details)).not.toContain('private-scope');

      vi.setSystemTime(new Date(1_000 + 15 * 60_000));

      expect(runtime.getHealthSnapshot()).toMatchObject({
        status: 'healthy',
        details: {
          degradedReasons: [],
          autoCompactState: 'idle',
          autoCompactActiveBackoffScopes: 0,
          autoCompactWorstCurrentBackoffTier: 0,
          autoCompactIneffective: 1,
          autoCompactConsecutiveRapidRearmsMax: 1,
        },
      });
    } finally {
      vi.useRealTimers();
    }
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

  it('latches a delayed per-chat halt across queue deletion, rekey, and replacement admission', async () => {
    const coordinator = (runtime as unknown as {
      runtimeTurnCoordinator: {
        enqueuePerChatRuntimeTurn: (scopeKey: string, turn: ReturnType<typeof makeQueuedTurn>) => boolean;
        terminalizePerChatTurnQueueForKill: (scopeKey: string) => Promise<void>;
        rekeyPerChatTurnQueueHaltScope: (fromScopeKey: string, toScopeKey: string) => void;
      };
    }).runtimeTurnCoordinator;
    const lidScope = 'private-conversation@lid';
    const canonicalScope = '15550190099@s.whatsapp.net';

    expect(coordinator.enqueuePerChatRuntimeTurn(lidScope, makeQueuedTurn('first'))).toBe(true);
    const queue = capturedTurnQueues.at(-1)!;
    await coordinator.terminalizePerChatTurnQueueForKill(lidScope);
    queue.halt();

    coordinator.rekeyPerChatTurnQueueHaltScope(lidScope, canonicalScope);
    const queueCountBeforeReplacement = capturedTurnQueues.length;
    expect(coordinator.enqueuePerChatRuntimeTurn(canonicalScope, makeQueuedTurn('replacement'))).toBe(false);
    expect(capturedTurnQueues).toHaveLength(queueCountBeforeReplacement);

    const snapshot = runtime.getHealthSnapshot();
    expect(snapshot.status).toBe('degraded');
    expect(snapshot.details['turnQueueHalted']).toBe(true);
    expect(snapshot.details['turnQueueHaltedScopes']).toBe(1);
    expect(JSON.stringify(snapshot.details)).not.toContain('private-conversation');
    expect(JSON.stringify(snapshot.details)).not.toContain('terminal failure');
  });

  it('counts every halted per-chat scope and stays degraded when all materialized scopes halt', () => {
    const coordinator = (runtime as unknown as {
      runtimeTurnCoordinator: {
        enqueuePerChatRuntimeTurn: (scopeKey: string, turn: ReturnType<typeof makeQueuedTurn>) => boolean;
      };
    }).runtimeTurnCoordinator;

    expect(coordinator.enqueuePerChatRuntimeTurn('scope-a', makeQueuedTurn('a'))).toBe(true);
    capturedTurnQueues.at(-1)!.halt();
    expect(coordinator.enqueuePerChatRuntimeTurn('scope-b', makeQueuedTurn('b'))).toBe(true);
    capturedTurnQueues.at(-1)!.halt();

    expect(runtime.getHealthSnapshot()).toMatchObject({
      status: 'degraded',
      details: {
        turnQueueHalted: true,
        turnQueueHaltedScopes: 2,
      },
    });
  });

  it('recordTurnCapabilitySuccess refreshes primaryModelUsability, clearing staleness (#1884 follow-up)', () => {
    const staleCheckedAt = Date.now() - 31 * 60_000;
    (runtime as unknown as { primaryModelUsability: unknown }).primaryModelUsability =
      { status: 'usable', provider: 'claude-cli', model: null, checkedAt: staleCheckedAt, probeInFlight: false };
    (runtime as unknown as { recordTurnCapabilitySuccess: (b: boolean) => void }).recordTurnCapabilitySuccess(true);
    const refreshed = runtime.getFallbackState();
    expect(refreshed.primaryModelUsability?.checkedAt).toBeGreaterThan(staleCheckedAt);
    expect(refreshed.turnCapability.modelUsableStale).toBe(false);
  });

  it('recordTurnCapabilitySuccess does NOT refresh primary usability while a fallback window is active', () => {
    const staleCheckedAt = Date.now() - 31 * 60_000;
    const state = runtime as unknown as {
      primaryModelUsability: unknown;
      fallbackWindow: { activeUntil: number | null; activeEntry: { provider: string; model?: string } | null };
      recordTurnCapabilitySuccess: (b: boolean) => void;
    };
    state.primaryModelUsability = { status: 'usable', provider: 'claude-cli', model: null, checkedAt: staleCheckedAt, probeInFlight: false };
    state.fallbackWindow.activeUntil = Date.now() + 60_000;
    state.fallbackWindow.activeEntry = { provider: 'opencode-cli', model: 'vendor/model' };
    state.recordTurnCapabilitySuccess(true);
    expect(runtime.getFallbackState().primaryModelUsability?.checkedAt).toBe(staleCheckedAt);
  });
});

describe('AgentRuntime.getHealthSnapshot — single-session shape', () => {
  it('degrades only while aggregate auto-compact backoff is active', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(1_000));
      const runtime = new AgentRuntime(makeDb(), makeMessenger(), 'test');
      const autoCompact = (runtime as unknown as {
        autoCompact: AutoCompactController;
      }).autoCompact;
      autoCompact.recordAutoCompactRapidRearm('private-scope', 100, Date.now());

      expect(runtime.getHealthSnapshot()).toMatchObject({
        status: 'degraded',
        details: {
          degradedReasons: ['auto_compact_backoff'],
          autoCompactState: 'backoff',
          autoCompactActiveBackoffScopes: 1,
        },
      });

      vi.setSystemTime(new Date(1_000 + 15 * 60_000));

      expect(runtime.getHealthSnapshot()).toMatchObject({
        status: 'healthy',
        details: {
          degradedReasons: [],
          autoCompactState: 'idle',
          autoCompactActiveBackoffScopes: 0,
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

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
        autoCompactState: 'idle',
        autoCompactActiveBackoffScopes: 0,
        autoCompactWorstCurrentBackoffTier: 0,
        proactiveResumeIdentityRejects: 0,
        restartLoopGuard: { enabled: true, bootsInWindow: 0, tripped: false, lastTripAt: null, windowMs: 300_000, bootsTotal: 0, checksPerformed: 0, lastCheckAt: null },
        unownedProviderEventRejects: 0,
        chronologyDelayedDispatches: 0,
        chronologyRecoveryReplayDispatches: 0,
        degradedReasons: [],
        chronologyMaxQueueAgeSeconds: 0,
        turnFinalizationRetainedRetries: 0,
        turnFinalizationDegradedScopes: 0,
        turnFinalizationRetryAttempts: 0,
        turnFinalizationRetryRecoveries: 0,
        turnFinalizationRetryExhaustions: 0,
        ...expectedTurnQueueDetails(),
        ...expectedProviderExecutionDetails(),
        ...expectedTurnRecoveryDetails(),
        ...expectedFallbackDetails(),
      },
    });
  });

  it('ignores the inactive TurnQueue in single mode', () => {
    const runtime = new AgentRuntime(makeDb(), makeMessenger(), 'test');
    capturedTurnQueues.at(-1)!.halt();

    expect(runtime.getHealthSnapshot()).toMatchObject({
      status: 'healthy',
      details: {
        turnQueueHalted: false,
        turnQueueHaltedScopes: 0,
      },
    });
  });

  it('reports a shared admission halt as unhealthy and restart clears it', () => {
    const runtime = new AgentRuntime(makeDb(), makeMessenger(), 'test', {
      sessionScope: 'shared',
    });
    capturedTurnQueues.at(-1)!.halt();

    expect(runtime.getHealthSnapshot()).toMatchObject({
      status: 'unhealthy',
      details: {
        turnQueueHalted: true,
        turnQueueHaltedScopes: 1,
      },
    });

    const restarted = new AgentRuntime(makeDb(), makeMessenger(), 'test', {
      sessionScope: 'shared',
    });
    expect(restarted.getHealthSnapshot()).toMatchObject({
      status: 'healthy',
      details: {
        turnQueueHalted: false,
        turnQueueHaltedScopes: 0,
      },
    });
  });
});
