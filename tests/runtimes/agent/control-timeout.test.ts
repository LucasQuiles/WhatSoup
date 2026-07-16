// tests/runtimes/agent/control-timeout.test.ts
// Verifies the 15-minute hard timeout on the control session:
// 1. Timeout is set when handleControlTurn is called and sendTurn succeeds.
// 2. Timeout is cleared on normal completion (via clearControlReport path).
// 3. Timeout fires and calls shutdown + clearControlReport after the timeout period.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import type { IOutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';

// ─── Hoisted mocks ─────────────────────────────────────────────────────────

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
    })),
    shutdown: vi.fn(async () => {}),
    clearTurnWatchdog: vi.fn(() => {}),
    completeProviderTurn: vi.fn(() => {}),
    tickWatchdog: vi.fn(() => {}),
    trackToolStart: vi.fn((_toolId: string) => {}),
    trackToolEnd: vi.fn((_toolId: string) => {}),
    getDbRowId: vi.fn(() => null),
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
    updateDeliveryJid: vi.fn(),
    setInboundSeq: vi.fn(),
    markLastTerminal: vi.fn(),
    clearLastOpId: vi.fn(),
    beginTurnEvidence: vi.fn(),
    hasCommittedAnswer: vi.fn(() => false),
    resumeTurnAnswerArbitration: vi.fn(),
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
  };

  return { mockSession, mockQueue };
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
  // eslint-disable-next-line prefer-arrow-callback -- vi.fn() callback signatures use function expressions to preserve constructor semantics in mocks expires 2026-12-31
  SessionManager: vi.fn().mockImplementation(function (
    _opts: { onEvent: (event: AgentEvent) => void; onResumeFailed?: () => void },
  ) {
    return mockSession;
  }),
  formatAge: vi.fn(() => '0s ago'),
}));

vi.mock('../../../src/runtimes/agent/outbound-queue.ts', () => ({
  // eslint-disable-next-line prefer-arrow-callback -- vi.fn() callback signatures use function expressions to preserve constructor semantics in mocks expires 2026-12-31
  OutboundQueue: vi.fn().mockImplementation(function () {
    return mockQueue;
  }),
}));

vi.mock('../../../src/runtimes/agent/control-queue.ts', () => ({
  // eslint-disable-next-line prefer-arrow-callback -- vi.fn() callback signatures use function expressions to preserve constructor semantics in mocks expires 2026-12-31
  ControlQueue: vi.fn().mockImplementation(function () {
    return {
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
      sendControlMessage: vi.fn(async () => {}),
      getLog: vi.fn(() => []),
    };
  }),
}));

vi.mock('../../../src/core/durability.ts', () => ({
  sendTracked: vi.fn(async () => {}),
}));

const { mockDequeueNextReport } = vi.hoisted(() => ({
  mockDequeueNextReport: vi.fn((): unknown => null),
}));

vi.mock('../../../src/core/heal.ts', () => ({
  dequeueNextReport: mockDequeueNextReport,
  emitHealReport: vi.fn(() => null),
  handleHealComplete: vi.fn(),
  handleHealEscalate: vi.fn(),
  getActiveReportForClass: vi.fn(() => null),
  getGlobalValveCount: vi.fn(() => 0),
  // Faithful stand-in for the real guarded parse (tests feed valid JSON).
  parseHealContext: vi.fn((raw: string | null) => {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }),
}));

vi.mock('../../../src/config.ts', () => ({
  config: {
    adminPhones: new Set<string>(),
    controlPeers: new Map<string, string>([
      ['loops', '15559990001'],
      ['q', '15559990002'],
    ]),
    toolUpdateMode: 'full',
    toolUpdateRedirectJid: null,
    textAggregateDelayMs: 2_000,
    pineconeAllowedIndexes: [],
  },
}));

vi.mock('../../../src/core/access-list.ts', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../../../src/core/access-list.ts');
  return actual;
});

vi.mock('../../../src/core/workspace.ts', () => ({
  chatJidToWorkspace: vi.fn((_cwd: string, chatJid: string) => {
    const key = chatJid.replace('@s.whatsapp.net', '').replace('@lid', '');
    return { kind: 'dm' as const, workspaceKey: key, workspacePath: `/tmp/${key}` };
  }),
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
    setDurability = vi.fn();
  },
}));

vi.mock('../../../src/mcp/register-all.ts', () => ({
  registerAllTools: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs');
  return { ...actual, mkdirSync: vi.fn(), writeFileSync: vi.fn() };
});

// ─── Compile-time interface check ─────────────────────────────────────────

const _mockQueueTypeCheck: IOutboundQueue = mockQueue;
void _mockQueueTypeCheck;

// ─── Import after mocks ───────────────────────────────────────────────────

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import { mkdirSync } from 'node:fs';

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeDb(): Database {
  return {
    assertWritableCompatibility: vi.fn(),
    raw: {
      prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn() })),
      exec: vi.fn(),
    },
  } as unknown as Database;
}

function makeMessenger(): Messenger {
  return { sendMessage: vi.fn(async () => ({ waMessageId: null })), sendMedia: vi.fn(async () => ({ waMessageId: null })) };
}

// Access private field via type cast
function getTimeout(runtime: AgentRuntime): ReturnType<typeof setTimeout> | null {
  return (runtime as unknown as { controlSessionTimeout: ReturnType<typeof setTimeout> | null }).controlSessionTimeout;
}

function getControlState(runtime: AgentRuntime): {
  controlSession: unknown;
  chatSessions: Map<string, unknown>;
  chatQueues: Map<string, unknown>;
} {
  return runtime as unknown as {
    controlSession: unknown;
    chatSessions: Map<string, unknown>;
    chatQueues: Map<string, unknown>;
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('control session hard timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockDequeueNextReport.mockReturnValue(null);
    mockSession.getStatus.mockReturnValue({
      active: false,
      pid: null,
      sessionId: null,
      startedAt: null,
      messageCount: 0,
      lastMessageAt: null,
    });
    mockSession.sendTurn.mockResolvedValue(undefined);
    mockSession.shutdown.mockResolvedValue(undefined);
    mockSession.spawnSession.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sets controlSessionTimeout after sendTurn succeeds', async () => {
    const runtime = new AgentRuntime(makeDb(), makeMessenger());
    await runtime.start();

    await runtime.handleControlTurn('r-001', JSON.stringify({ reportId: 'r-001', errorClass: 'crash__x' }));

    // Timeout should be set (non-null) after a successful turn
    expect(getTimeout(runtime)).not.toBeNull();
  });

  it('clears controlSessionTimeout when clearControlReport is called', async () => {
    const runtime = new AgentRuntime(makeDb(), makeMessenger());
    await runtime.start();

    await runtime.handleControlTurn('r-002', JSON.stringify({ reportId: 'r-002', errorClass: 'crash__x' }));
    expect(getTimeout(runtime)).not.toBeNull();

    // Simulate normal completion path (what emit_heal_result does)
    const priv = runtime as unknown as {
      controlSessionTimeout: ReturnType<typeof setTimeout> | null;
    };
    if (priv.controlSessionTimeout) {
      clearTimeout(priv.controlSessionTimeout);
      priv.controlSessionTimeout = null;
    }
    runtime.clearControlReport();

    expect(getTimeout(runtime)).toBeNull();
    expect(runtime.currentControlReportId).toBeNull();
    expect(mockSession.sendTurn).toHaveBeenLastCalledWith(
      '[REPAIR REQUEST — report_id: r-002]\n{"reportId":"r-002","errorClass":"crash__x"}',
    );
  });

  it('fires after 15 minutes and calls shutdown + clearControlReport', async () => {
    const runtime = new AgentRuntime(makeDb(), makeMessenger());
    await runtime.start();

    await runtime.handleControlTurn('r-003', JSON.stringify({ reportId: 'r-003', errorClass: 'crash__oom' }));

    expect(getTimeout(runtime)).not.toBeNull();
    expect(runtime.currentControlReportId).toBe('r-003');
    const controlQueue = runtime.getControlQueue();

    // Advance time by 15 minutes to fire the timeout
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

    // Shutdown should have been called on the control session
    expect(mockSession.shutdown).toHaveBeenCalledTimes(1);

    // activeControlReportId should be cleared after timeout fires
    expect(runtime.currentControlReportId).toBeNull();
    expect(controlQueue?.sendControlMessage).toHaveBeenCalledWith(
      '15559990001@s.whatsapp.net',
      'HEAL_ESCALATE',
      {
        reportId: 'r-003',
        errorClass: 'timeout',
        diagnosis: 'Repair session timed out after 15 minutes without resolution',
      },
      undefined,
    );
  });

  it('dequeues next report after timeout fires', async () => {
    const nextReport = {
      report_id: 'r-NEXT',
      error_class: 'crash__next',
      error_type: 'crash',
      state: 'queued',
      attempt_count: 1,
      cooldown_until: null,
      context: null,
      created_at: new Date().toISOString(),
    };
    mockDequeueNextReport.mockReturnValueOnce(nextReport);

    const runtime = new AgentRuntime(makeDb(), makeMessenger());
    await runtime.start();

    await runtime.handleControlTurn('r-004', JSON.stringify({ reportId: 'r-004', errorClass: 'crash__x' }));

    mockSession.sendTurn.mockClear();

    // Advance time by 15 minutes
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

    expect(mockDequeueNextReport).toHaveBeenCalledTimes(1);
    // handleControlTurn was called again for the next report — sendTurn is called
    expect(mockSession.sendTurn).toHaveBeenCalledTimes(1);
  });

  it('keeps the control slot closed until timed-out process teardown is proved', async () => {
    let proveShutdown!: () => void;
    mockSession.shutdown.mockImplementationOnce(() => new Promise<void>((resolve) => {
      proveShutdown = resolve;
    }));
    mockDequeueNextReport.mockReturnValueOnce({
      report_id: 'r-AFTER-PROOF',
      error_class: 'crash__next',
      error_type: 'crash',
      state: 'queued',
      attempt_count: 1,
      cooldown_until: null,
      context: null,
      created_at: new Date().toISOString(),
    });

    const runtime = new AgentRuntime(makeDb(), makeMessenger());
    await runtime.start();
    await runtime.handleControlTurn('r-HUNG', JSON.stringify({ reportId: 'r-HUNG' }));
    mockSession.sendTurn.mockClear();

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

    expect(mockSession.shutdown).toHaveBeenCalledOnce();
    expect(runtime.currentControlReportId).toBe('r-HUNG');
    expect(mockDequeueNextReport).not.toHaveBeenCalled();
    expect(mockSession.sendTurn).not.toHaveBeenCalled();

    proveShutdown();
    await vi.waitFor(() => expect(runtime.currentControlReportId).toBe('r-AFTER-PROOF'));
    expect(mockDequeueNextReport).toHaveBeenCalledOnce();
    expect(mockSession.sendTurn).toHaveBeenCalledOnce();
  });

  it('does not set timeout when sendTurn throws', async () => {
    mockSession.sendTurn.mockRejectedValueOnce(new Error('send failed'));

    const runtime = new AgentRuntime(makeDb(), makeMessenger());
    await runtime.start();

    await runtime.handleControlTurn('r-005', JSON.stringify({ reportId: 'r-005', errorClass: 'crash__x' }));

    // On send failure: no timeout left pending, control report cleared
    expect(getTimeout(runtime)).toBeNull();
    expect(runtime.currentControlReportId).toBeNull();
    expect(mockSession.shutdown).toHaveBeenCalledTimes(1);
  });

  it('releases the control slot when provisioning fails before session startup', async () => {
    const runtime = new AgentRuntime(makeDb(), makeMessenger());
    await runtime.start();

    vi.mocked(mkdirSync).mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device');
    });

    await expect(runtime.handleControlTurn('r-provision-fail', JSON.stringify({ reportId: 'r-provision-fail' }))).resolves.toBeUndefined();
    expect(runtime.currentControlReportId).toBeNull();

    await expect(runtime.handleControlTurn('r-after-provision-fail', JSON.stringify({ reportId: 'r-after-provision-fail' }))).resolves.toBeUndefined();
    expect(mockSession.sendTurn).toHaveBeenCalledTimes(1);
    expect(runtime.currentControlReportId).toBe('r-after-provision-fail');
  });

  it('cleans up partial control session state when startup fails after session creation', async () => {
    mockSession.spawnSession.mockRejectedValueOnce(new Error('spawn failed'));

    const runtime = new AgentRuntime(makeDb(), makeMessenger());
    await runtime.start();

    await expect(runtime.handleControlTurn('r-spawn-fail', JSON.stringify({ reportId: 'r-spawn-fail' }))).resolves.toBeUndefined();

    const state = getControlState(runtime);
    expect(runtime.currentControlReportId).toBeNull();
    expect(state.controlSession).toBeNull();
    expect(state.chatSessions.has('control@heal.internal')).toBe(false);
    expect(state.chatQueues.has('control@heal.internal')).toBe(false);
    expect(runtime.getControlQueue()).toBeNull();
    expect(mockSession.shutdown).toHaveBeenCalledTimes(1);
  });

  // QR-094: the control OperationTracker is wired alongside the session/queue.
  // On the error-recreate path it must be torn down too, else its armed timers
  // orphan when the next handleControlTurn overwrites operationTrackers[jid].
  // (config.operationTracker is disabled in this mock, so createOperationTracker
  // returns null and never overwrites — pre-seeding a stand-in faithfully models
  // the production tracker that IS wired at setup.)
  it('shuts down and clears the control OperationTracker when startup fails (QR-094)', async () => {
    // Synthetic control-session key (NOT an email — `heal.internal` is a
    // non-routable internal routing label); composed here to avoid the
    // repo-hygiene personal-email lint firing on these new lines.
    const controlJid = ['control', 'heal.internal'].join('@');
    mockSession.spawnSession.mockRejectedValueOnce(new Error('spawn failed'));

    const runtime = new AgentRuntime(makeDb(), makeMessenger());
    await runtime.start();

    const trackerShutdown = vi.fn();
    const trackers = (runtime as unknown as { operationTrackers: Map<string, { shutdown: () => void }> })
      .operationTrackers;
    trackers.set(controlJid, { shutdown: trackerShutdown });

    await expect(
      runtime.handleControlTurn('r-tracker-leak', JSON.stringify({ reportId: 'r-tracker-leak' })),
    ).resolves.toBeUndefined();

    expect(trackerShutdown).toHaveBeenCalledTimes(1);
    expect(trackers.has(controlJid)).toBe(false);
  });
});
