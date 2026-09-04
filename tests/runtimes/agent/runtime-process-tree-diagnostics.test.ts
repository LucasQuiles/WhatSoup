import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../src/core/database.ts';
import type { KillSessionOutcome } from '../../../src/runtimes/agent/process-tree-contract.ts';
import { ProcessTreeTerminationError } from '../../../src/runtimes/agent/process-tree-contract.ts';
import type { ClassifiedSession } from '../../../src/runtimes/agent/session-classifier.ts';
import { hoistedLoggerMock, type SingletonLoggerMock } from '../../helpers/logger-mock.ts';

interface ProcessTarget {
  readonly pid: number;
  readonly exitCode: null;
  readonly signalCode: null;
  readonly kill: ReturnType<typeof vi.fn>;
}

interface RegisteredLease {
  readonly target: ProcessTarget;
  readonly rootAuthority: {
    readonly pid: number;
    readonly parentPid: number;
    readonly birthToken: string;
  };
}

const {
  mockClassifyActiveSessions,
  mockGetRegisteredProcessTreeTerminationLease,
  mockKillSessionTree,
  mockMarkOrphaned,
  mockReconcileResidentSessionStatuses,
  mockRetryKillSessionTree,
  runtimeLog,
} = vi.hoisted(() => ({
  mockClassifyActiveSessions: vi.fn<() => ClassifiedSession[]>(() => []),
  mockGetRegisteredProcessTreeTerminationLease: vi.fn<(
    rowId: number,
    pid: number,
    provider: string | null,
  ) => RegisteredLease | null>(),
  mockKillSessionTree: vi.fn<(...args: unknown[]) => Promise<KillSessionOutcome>>(),
  mockMarkOrphaned: vi.fn(),
  mockReconcileResidentSessionStatuses: vi.fn(() => new Set<number>()),
  mockRetryKillSessionTree: vi.fn<(...args: unknown[]) => Promise<KillSessionOutcome>>(),
  runtimeLog: {} as SingletonLoggerMock,
}));
hoistedLoggerMock(runtimeLog);

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => runtimeLog,
}));

vi.mock('../../../src/runtimes/agent/process-tree.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/runtimes/agent/process-tree.ts')>(),
  getRegisteredProcessTreeTerminationLease: mockGetRegisteredProcessTreeTerminationLease,
  killSessionTree: mockKillSessionTree,
  retryKillSessionTree: mockRetryKillSessionTree,
}));

vi.mock('../../../src/runtimes/agent/session-db.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/runtimes/agent/session-db.ts')>(),
  backfillSessionProvider: vi.fn(),
  ensureAgentSchema: vi.fn(),
  getActiveSession: vi.fn(() => null),
  markOrphaned: mockMarkOrphaned,
}));

vi.mock('../../../src/runtimes/agent/session-classifier.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/runtimes/agent/session-classifier.ts')>(),
  classifyActiveSessions: mockClassifyActiveSessions,
}));

vi.mock('../../../src/runtimes/agent/resident-session-reconciler.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/runtimes/agent/resident-session-reconciler.ts')>(),
  reconcileResidentSessionStatuses: mockReconcileResidentSessionStatuses,
}));

vi.mock('../../../src/config.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/config.ts')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      nlRouting: false,
      proactiveResumeOnStartup: true,
      restartLoopGuard: { ...actual.config.restartLoopGuard, enabled: false },
    },
  };
});

vi.mock('../../../src/core/workspace.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/core/workspace.ts')>(),
  ensurePermissionsSettings: vi.fn(),
}));

vi.mock('../../../src/runtimes/agent/standby-notice.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/runtimes/agent/standby-notice.ts')>(),
  ensureStandbyNoticeSchema: vi.fn(),
}));

vi.mock('../../../src/runtimes/agent/handoff-artifact.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/runtimes/agent/handoff-artifact.ts')>(),
  ensureHandoffArtifactSchema: vi.fn(),
}));

vi.mock('../../../src/runtimes/agent/runtime-tool-registrations.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/runtimes/agent/runtime-tool-registrations.ts')>(),
  registerRuntimeInlineTools: vi.fn(),
}));

vi.mock('../../../src/runtimes/agent/providers/mcp-bridge.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/runtimes/agent/providers/mcp-bridge.ts')>(),
  providerMcpProxyScriptPath: vi.fn(() => '/test/provider-mcp-proxy.mjs'),
  writeProviderMcpConfig: vi.fn(() => null),
  writeProviderMcpConfigTarget: vi.fn(() => null),
}));

vi.mock('../../../src/mcp/socket-server.ts', () => ({
  WhatSoupSocketServer: class {
    start(): void {}
    stop(): void {}
  },
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  mkdirSync: vi.fn(),
}));

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';

interface RuntimeProcessTreeView {
  readonly db: Database;
  sweepStaleAgentSessions(): Promise<Set<string>>;
  terminateOwnedSessionProcessTree(session: unknown): Promise<void>;
}

interface StartupRuntimeView extends RuntimeProcessTreeView {
  start(): Promise<void>;
}

const terminatedOutcome: KillSessionOutcome = {
  outcome: 'terminated',
  durationMs: 0,
  ownedProcessCount: 1,
  signaledProcessCount: 1,
  ambiguousProcessCount: 0,
  diagnosticState: 'complete',
  diagnosticCodes: [],
};

const unresolvedOutcome: KillSessionOutcome = {
  outcome: 'unresolved_ambiguous',
  durationMs: 1,
  ownedProcessCount: 2,
  signaledProcessCount: 1,
  ambiguousProcessCount: 1,
  diagnosticState: 'complete',
  diagnosticCodes: [],
};

function registeredLease(pid: number): RegisteredLease {
  return {
    target: {
      pid,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    },
    rootAuthority: { pid, parentPid: process.pid, birthToken: `birth:${pid}` },
  };
}

function staleSession(overrides: Partial<ClassifiedSession> = {}): ClassifiedSession {
  return {
    id: 43,
    sessionId: 'ses-live-stale',
    claudePid: 4321,
    chatJid: 'stale-live@s.whatsapp.net',
    conversationKey: 'stale-live',
    provider: 'claude-cli',
    status: 'active',
    classification: 'stale_live',
    reason: 'superseded by checkpoint',
    startedAt: null,
    messageCount: 0,
    ...overrides,
  };
}

function makeRuntime(): RuntimeProcessTreeView {
  const runtime = Object.create(AgentRuntime.prototype) as Record<string, unknown>;
  Object.assign(runtime, {
    chatSessions: new Map(),
    db: {} as Database,
    durability: {},
    instanceName: 'test',
    sandboxPerChat: false,
    sessionScope: 'per_chat',
    shutdownRequested: false,
    staleProcessTreePermissionBlocks: new Map(),
    staleProcessTreeRetries: new Map(),
    staleProcessTreeRetryTimers: new Map(),
  });
  return runtime as unknown as RuntimeProcessTreeView;
}

function makeStartupRuntime(blockedConversationKey: string): {
  readonly runtime: StartupRuntimeView;
  readonly createSessionManager: ReturnType<typeof vi.fn>;
} {
  const runtime = Object.create(AgentRuntime.prototype) as Record<string, unknown>;
  const createSessionManager = vi.fn(() => {
    throw new Error('blocked-key bypass sentinel');
  });
  Object.assign(runtime, {
    activeChatJid: null,
    activeControlReportId: null,
    agentFallbacks: [],
    agentProvider: 'codex-cli',
    agentProviderConfig: undefined,
    chatQueues: new Map(),
    chatSessions: new Map(),
    consumeQueuedPollDecisions: vi.fn(async () => {}),
    createSessionManager,
    currentTurnChatJid: null,
    cwd: '/tmp/whatsoup-process-tree-start-test',
    db: { assertWritableCompatibility: vi.fn() },
    durability: {
      getResumableCheckpoints: vi.fn(() => [{ conversation_key: blockedConversationKey }]),
      getSessionCheckpoint: vi.fn(() => ({
        completed_delivery_jid: `${blockedConversationKey}@s.whatsapp.net`,
        completed_delivery_namespace: 's.whatsapp.net',
        completed_generation: 1,
        completed_inbound_seq: 1,
        completed_logical_turn_id: 'turn-1',
        completed_manager_id: 'manager-1',
        completed_scope: 'per_chat',
        conversation_key: blockedConversationKey,
        session_id: 'ses-current',
        updated_at: new Date().toISOString().replace(/Z$/, ''),
      })),
    },
    enabledPlugins: undefined,
    fallback: {
      primaryOpencodeProviderConfig: vi.fn(() => undefined),
      refreshDiscoveredFallbackChain: vi.fn(async () => {}),
      restorePersistedFallbackWindow: vi.fn(),
      scheduleNextPeriodicUsabilityProbe: vi.fn(),
      schedulePrimaryModelUsabilityProbe: vi.fn(),
      startChainCanary: vi.fn(),
    },
    handoffDistill: { start: vi.fn() },
    instanceName: 'test',
    messenger: {},
    registry: {},
    rehydratePendingPolls: vi.fn(async () => {}),
    resolvePerChatMapKey: vi.fn(() => blockedConversationKey),
    createToolScopeKey: vi.fn(() => 'tool-scope-1'),
    sandbox: undefined,
    sandboxPerChat: false,
    serviceRestarter: undefined,
    sessionScope: 'per_chat',
    shared: false,
    shouldSuppressProactiveResume: vi.fn(() => false),
    startHealthStatsTimer: vi.fn(),
    startQueueSweepTimer: vi.fn(),
    startSessionSweepTimer: vi.fn(),
    startZombieSessionSweepTimer: vi.fn(),
    sweepStaleAgentSessions: vi.fn(async () => new Set([blockedConversationKey])),
    workspaceSweeper: { start: vi.fn() },
  });
  return { runtime: runtime as unknown as StartupRuntimeView, createSessionManager };
}

function invokeOutcomeObserver(
  args: unknown[],
  outcome: KillSessionOutcome,
): KillSessionOutcome {
  const options = args[2] as {
    onOutcome?: (value: KillSessionOutcome) => void;
  };
  options.onOutcome?.(outcome);
  return outcome;
}

describe('AgentRuntime process-tree caller transitions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockClassifyActiveSessions.mockReset().mockReturnValue([]);
    mockGetRegisteredProcessTreeTerminationLease.mockReset().mockImplementation(
      (_rowId, pid) => registeredLease(pid),
    );
    mockKillSessionTree.mockReset().mockResolvedValue(terminatedOutcome);
    mockMarkOrphaned.mockReset();
    mockReconcileResidentSessionStatuses.mockReset().mockReturnValue(new Set());
    mockRetryKillSessionTree.mockReset().mockResolvedValue(terminatedOutcome);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('refuses the destructive reset outside the test-runner boundary without clearing authority', async () => {
    const processTree = await vi.importActual<
      typeof import('../../../src/runtimes/agent/process-tree.ts')
    >('../../../src/runtimes/agent/process-tree.ts');
    const target = {
      pid: process.pid,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(() => true),
    };
    const authority = processTree.captureProcessTreeRootAuthority(target)!;
    expect(processTree.bindProcessTreeRootAuthority(authority, 901, 'claude-cli')).toBe(true);
    const before = processTree.getRegisteredProcessTreeTerminationLease(
      901,
      process.pid,
      'claude-cli',
    );
    const original = {
      pool: process.env['VITEST_POOL_ID'],
      vitest: process.env['VITEST'],
      worker: process.env['VITEST_WORKER_ID'],
    };
    const restoreTestSignals = (): void => {
      if (original.pool === undefined) delete process.env['VITEST_POOL_ID'];
      else process.env['VITEST_POOL_ID'] = original.pool;
      if (original.vitest === undefined) delete process.env['VITEST'];
      else process.env['VITEST'] = original.vitest;
      if (original.worker === undefined) delete process.env['VITEST_WORKER_ID'];
      else process.env['VITEST_WORKER_ID'] = original.worker;
    };
    const attempts: Array<{ name: string; error: unknown; after: unknown }> = [];

    try {
      for (const [name, configure] of [
        ['runner identity', () => { delete process.env['VITEST']; }],
        ['worker provenance', () => {
          process.env['VITEST'] = 'true';
          delete process.env['VITEST_POOL_ID'];
          delete process.env['VITEST_WORKER_ID'];
        }],
      ] as const) {
        restoreTestSignals();
        configure();
        let error: unknown;
        try {
          processTree.resetProcessTreeTerminationLeasesForTesting();
        } catch (caught) {
          error = caught;
        }
        attempts.push({
          name,
          error,
          after: processTree.getRegisteredProcessTreeTerminationLease(901, process.pid, 'claude-cli'),
        });
      }
    } finally {
      restoreTestSignals();
      processTree.resetProcessTreeTerminationLeasesForTesting();
    }

    for (const attempt of attempts) {
      expect.soft(attempt.error, attempt.name).toMatchObject({
        message: 'Process-tree lease reset is test-only',
      });
      expect.soft(attempt.after, `${attempt.name} state preservation`).toEqual(before);
    }
  });

  it('terminates a stale live session only through its registered spawn authority', async () => {
    const runtime = makeRuntime();
    mockClassifyActiveSessions.mockReturnValue([staleSession()]);

    await expect(runtime.sweepStaleAgentSessions()).resolves.toEqual(new Set());

    expect(mockGetRegisteredProcessTreeTerminationLease).toHaveBeenCalledWith(
      43,
      4321,
      'claude-cli',
    );
    expect(mockKillSessionTree).toHaveBeenCalledWith(
      expect.objectContaining({ pid: 4321 }),
      'SIGTERM',
      {
        generationMarker: 'stale:43:ses-live-stale:4321',
        diagnosticSource: 'stale_session_sweep',
        diagnosticSessionRowId: 43,
        rootAuthority: { pid: 4321, parentPid: process.pid, birthToken: 'birth:4321' },
        onOutcome: expect.any(Function),
        onCgroupDivergence: expect.any(Function),
      },
    );
    expect(mockMarkOrphaned).toHaveBeenCalledWith(runtime.db, 43);
  });

  it('never upgrades a persisted stale PID into signal authority', async () => {
    const runtime = makeRuntime();
    mockClassifyActiveSessions.mockReturnValue([
      staleSession({
        id: 143,
        sessionId: 'ses-live-without-capability',
        claudePid: 5432,
        conversationKey: 'stale-unbound',
        provider: 'codex-cli',
      }),
    ]);
    mockGetRegisteredProcessTreeTerminationLease.mockReturnValueOnce(null);

    await expect(runtime.sweepStaleAgentSessions()).resolves.toEqual(
      new Set(['stale-unbound']),
    );

    expect(mockKillSessionTree).not.toHaveBeenCalled();
    expect(mockRetryKillSessionTree).not.toHaveBeenCalled();
    expect(mockMarkOrphaned).not.toHaveBeenCalled();
    expect(runtimeLog.error).toHaveBeenCalledWith(
      { id: 143, pid: 5432, conversationKey: 'stale-unbound' },
      'stale session spawn authority unavailable — blocking proactive resume',
    );
  });

  it('blocks resume and redacts private text when cleanup fails unexpectedly', async () => {
    const runtime = makeRuntime();
    const privateCanary = 'PRIVATE_TREE_CENSUS_DETAIL';
    mockClassifyActiveSessions.mockReturnValue([
      staleSession({ id: 45, claudePid: 4545, conversationKey: 'stale-inconclusive' }),
    ]);
    mockKillSessionTree.mockRejectedValueOnce(new Error(privateCanary));

    await expect(runtime.sweepStaleAgentSessions()).resolves.toEqual(
      new Set(['stale-inconclusive']),
    );

    expect(mockMarkOrphaned).not.toHaveBeenCalled();
    expect(runtimeLog.error).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: 'PROCESS_TREE_UNEXPECTED_FAILURE',
        retryClass: 'unknown',
      }),
      'stale session tree cleanup inconclusive — blocking proactive resume',
    );
    expect(JSON.stringify(runtimeLog.error.mock.calls)).not.toContain(privateCanary);
  });

  it('carries an inconclusive sweep block through start without creating a second session', async () => {
    const conversationKey = '15550100001';
    const { runtime, createSessionManager } = makeStartupRuntime(conversationKey);

    await expect(runtime.start()).resolves.toBeUndefined();

    expect(createSessionManager).not.toHaveBeenCalled();
    expect(runtimeLog.info).toHaveBeenCalledWith(
      { conversationKey },
      'skipping proactive resume — live/ambiguous session already present',
    );
  });

  it('does not treat a missing known root as proved-empty ownership cleanup', async () => {
    const runtime = makeRuntime();
    const target = registeredLease(98_765).target;
    const session = {
      getProcessTreeTerminationLease: () => ({
        target,
        generationMarker: 'ownership-loss-existing-98765',
        rootAuthority: { pid: 98_765, parentPid: process.pid, birthToken: 'birth:98765' },
      }),
      getStatus: () => ({ pid: 98_765 }),
    };
    mockKillSessionTree.mockRejectedValueOnce(new Error('root row missing or ambiguous'));

    await expect(runtime.terminateOwnedSessionProcessTree(session)).rejects.toThrow(
      'root row missing or ambiguous',
    );
    expect(mockKillSessionTree).toHaveBeenCalledWith(target, 'SIGTERM', {
      generationMarker: 'ownership-loss-existing-98765',
      rootAuthority: { pid: 98_765, parentPid: process.pid, birthToken: 'birth:98765' },
      diagnosticSource: 'ownership_loss_cleanup',
      onOutcome: expect.any(Function),
      onCgroupDivergence: expect.any(Function),
    });
  });

  it('preserves an active row while stale cleanup remains ambiguous', async () => {
    const runtime = makeRuntime();
    mockClassifyActiveSessions.mockReturnValue([
      staleSession({ id: 46, claudePid: 4646, conversationKey: 'stale-ambiguous' }),
    ]);
    mockKillSessionTree.mockImplementationOnce(async (...args) =>
      invokeOutcomeObserver(args, unresolvedOutcome));

    await expect(runtime.sweepStaleAgentSessions()).resolves.toEqual(
      new Set(['stale-ambiguous']),
    );

    expect(mockMarkOrphaned).not.toHaveBeenCalled();
  });

  it('retries a retained stale-session lease before the zombie-sweep interval', async () => {
    const runtime = makeRuntime();
    mockClassifyActiveSessions.mockReturnValue([
      staleSession({ id: 47, claudePid: 4747, conversationKey: 'stale-retry' }),
    ]);
    mockKillSessionTree.mockResolvedValueOnce(unresolvedOutcome);

    await runtime.sweepStaleAgentSessions();
    expect(mockMarkOrphaned).not.toHaveBeenCalled();
    expect(mockRetryKillSessionTree).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(mockKillSessionTree).toHaveBeenCalledTimes(1);
    expect(mockRetryKillSessionTree).toHaveBeenCalledWith(
      4747,
      'stale:47:ses-live-stale:4747',
    );
    expect(mockMarkOrphaned).toHaveBeenCalledWith(runtime.db, 47);
  });

  it('stops the bounded retry timer after its retained lease is exhausted', async () => {
    const runtime = makeRuntime();
    mockClassifyActiveSessions.mockReturnValue([
      staleSession({ id: 147, claudePid: 4787, conversationKey: 'stale-exhausted' }),
    ]);
    mockKillSessionTree.mockResolvedValueOnce(unresolvedOutcome);
    mockRetryKillSessionTree.mockRejectedValue(
      new ProcessTreeTerminationError(
        'PROCESS_TREE_RETRY_ATTEMPTS_EXHAUSTED',
        'bounded retry exhausted',
      ),
    );

    await runtime.sweepStaleAgentSessions();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mockRetryKillSessionTree).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(mockRetryKillSessionTree).toHaveBeenCalledTimes(1);
  });

  it('suppresses repeated stale-session signals after permission denial', async () => {
    const runtime = makeRuntime();
    mockClassifyActiveSessions.mockReturnValue([
      staleSession({ id: 48, claudePid: 4848, conversationKey: 'stale-permission' }),
    ]);
    mockKillSessionTree.mockRejectedValueOnce(
      new ProcessTreeTerminationError(
        'PROCESS_TREE_SIGNAL_PERMISSION_DENIED',
        'permission denied',
      ),
    );

    await runtime.sweepStaleAgentSessions();
    await runtime.sweepStaleAgentSessions();

    expect(mockKillSessionTree).toHaveBeenCalledTimes(1);
    expect(mockRetryKillSessionTree).not.toHaveBeenCalled();
    expect(mockMarkOrphaned).not.toHaveBeenCalled();
  });

  it('rejects ownership-loss cleanup while an identity remains ambiguous', async () => {
    const runtime = makeRuntime();
    const target = registeredLease(98_766).target;
    const session = {
      getProcessTreeTerminationLease: () => ({
        target,
        generationMarker: 'ownership-loss-existing-98766',
        rootAuthority: { pid: 98_766, parentPid: process.pid, birthToken: 'birth:98766' },
      }),
      getStatus: () => ({ pid: 98_766 }),
    };
    mockKillSessionTree.mockImplementationOnce(async (...args) =>
      invokeOutcomeObserver(args, unresolvedOutcome));

    await expect(runtime.terminateOwnedSessionProcessTree(session)).rejects.toMatchObject({
      code: 'PROCESS_TREE_AMBIGUOUS_IDENTITY_UNRESOLVED',
      retryClass: 'census_retryable',
    });
  });
});
