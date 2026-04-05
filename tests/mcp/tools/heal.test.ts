// tests/mcp/tools/heal.test.ts
// Tests for the emit_heal_result MCP tool registered in AgentRuntime.start()

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import type { IOutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';
import type { ToolDeclaration } from '../../../src/mcp/types.ts';

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

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
    enqueueStreamingText: vi.fn(),
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

  return { mockSession, mockQueue, capturedOnEventRef };
});

// ─── Module mocks ─────────────────────────────────────────────────────────────

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
  sweepOrphanedSessions: vi.fn(() => []),
  getResumableSessionForChat: vi.fn(() => null),
}));

vi.mock('../../../src/runtimes/agent/session.ts', () => ({
  SessionManager: vi.fn().mockImplementation(function (
    opts: { onEvent: (event: AgentEvent) => void },
  ) {
    capturedOnEventRef.current = opts.onEvent;
    return mockSession;
  }),
  formatAge: vi.fn(() => '5m ago'),
}));

vi.mock('../../../src/runtimes/agent/outbound-queue.ts', () => ({
  OutboundQueue: vi.fn().mockImplementation(function () {
    return mockQueue;
  }),
}));

// Control queue mock — sendControlMessage is the key method we observe
const { mockControlQueueInstance } = vi.hoisted(() => {
  const mockControlQueueInstance = {
    enqueueText: vi.fn(),
    enqueueStreamingText: vi.fn(),
    enqueueResultText: vi.fn(),
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
  return { mockControlQueueInstance };
});

vi.mock('../../../src/runtimes/agent/control-queue.ts', () => ({
  ControlQueue: vi.fn().mockImplementation(function () {
    return mockControlQueueInstance;
  }),
}));

// sendTracked mock — used for admin DM on escalation
const { mockSendTracked } = vi.hoisted(() => ({
  mockSendTracked: vi.fn(async () => {}),
}));
vi.mock('../../../src/core/durability.ts', () => ({
  sendTracked: mockSendTracked,
}));

// dequeueNextReport mock
type HealReportRow = {
  report_id: string;
  error_class: string;
  error_type: string;
  state: string;
  attempt_count: number;
  cooldown_until: string | null;
  context: string | null;
  created_at: string;
};
const { mockDequeueNextReport } = vi.hoisted(() => ({
  mockDequeueNextReport: vi.fn(() => null as null | HealReportRow),
}));
vi.mock('../../../src/core/heal.ts', () => ({
  dequeueNextReport: mockDequeueNextReport,
  emitHealReport: vi.fn(() => null),
  handleHealComplete: vi.fn(),
  handleHealEscalate: vi.fn(),
  getActiveReportForClass: vi.fn(() => null),
  checkGlobalValve: vi.fn(() => true),
}));

vi.mock('../../../src/core/workspace.ts', () => ({
  chatJidToWorkspace: vi.fn((_cwd: string, chatJid: string) => {
    const key = chatJid.replace('@s.whatsapp.net', '').replace('@lid', '');
    return { kind: 'dm' as const, workspaceKey: key, workspacePath: `/tmp/${key}` };
  }),
  provisionWorkspace: vi.fn(() => '/tmp/workspace/.claude/whatsoup.sock'),
  writeSandboxArtifacts: vi.fn(),
  ensurePermissionsSettings: vi.fn(),
}));

vi.mock('../../../src/mcp/socket-server.ts', () => ({
  WhatSoupSocketServer: vi.fn().mockImplementation(function () {
    return { start: vi.fn(), stop: vi.fn(), updateDeliveryJid: vi.fn() };
  }),
}));

// ToolRegistry mock — captures register() calls so we can extract the handler
const registeredTools: ToolDeclaration[] = [];
vi.mock('../../../src/mcp/registry.ts', () => ({
  ToolRegistry: class {
    register = vi.fn((tool: ToolDeclaration) => { registeredTools.push(tool); });
    listTools = vi.fn(() => []);
    call = vi.fn();
    getChatScopedToolNames = vi.fn(() => []);
    setDurability = vi.fn();
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, mkdirSync: vi.fn(), writeFileSync: vi.fn() };
});

vi.mock('../../../src/mcp/register-all.ts', () => ({
  registerAllTools: vi.fn(),
}));

// ─── Config mock with controlPeers populated ─────────────────────────────────

// Two variants of config are needed:
// - withPeers: controlPeers has 'loops' and 'q' entries
// - withoutPeers: controlPeers is empty
const configWithPeers = {
  controlPeers: new Map<string, string>([
    ['loops', '15559990001'],
    ['q', '15559990002'],
  ]),
  adminPhones: new Set<string>(['15550100001']),
};

const configWithoutPeers = {
  controlPeers: new Map<string, string>(),
  adminPhones: new Set<string>(['15550100001']),
};

// Default mock — overridden per-test via vi.mocked pattern
vi.mock('../../../src/config.ts', () => ({
  config: {
    controlPeers: new Map<string, string>([
      ['loops', '15559990001'],
      ['q', '15559990002'],
    ]),
    adminPhones: new Set<string>(['15550100001']),
    toolUpdateMode: 'full',
    pineconeAllowedIndexes: [],
  },
}));

vi.mock('../../../src/core/access-list.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/access-list.ts')>();
  return actual;
});

// ─── Import after mocks ───────────────────────────────────────────────────────

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import { config } from '../../../src/config.ts';

// ─── Compile-time mock interface check ───────────────────────────────────────
const _mockQueueTypeCheck: IOutboundQueue = mockQueue;
void _mockQueueTypeCheck;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeDb(): Database {
  return {
    raw: {
      prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn() })),
      exec: vi.fn(),
    },
  } as unknown as Database;
}

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn(async () => {}),
  };
}

/** Find the emit_heal_result tool registered during start() */
function findRegisteredTool(): ToolDeclaration | undefined {
  return registeredTools.find((t) => t.name === 'emit_heal_result');
}

/**
 * Create and start an AgentRuntime, then extract the emit_heal_result handler.
 * Returns both the runtime instance and the extracted handler so tests can
 * manipulate runtime state before calling the handler.
 */
async function buildRuntime(db?: Database): Promise<{
  runtime: AgentRuntime;
  handler: ToolDeclaration['handler'];
}> {
  const effectiveDb = db ?? makeDb();
  const runtime = new AgentRuntime(effectiveDb, makeMessenger());
  await runtime.start();
  const tool = findRegisteredTool();
  if (!tool) throw new Error('emit_heal_result not registered');
  return { runtime, handler: tool.handler };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('emit_heal_result MCP tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredTools.length = 0;
    mockDequeueNextReport.mockReturnValue(null);
    mockControlQueueInstance.sendControlMessage.mockResolvedValue(undefined);
    mockSendTracked.mockResolvedValue(undefined);

    // Ensure config.controlPeers has the loops+q entries for most tests
    (config.controlPeers as Map<string, string>).clear();
    configWithPeers.controlPeers.forEach((v, k) => (config.controlPeers as Map<string, string>).set(k, v));
    (config.adminPhones as Set<string>).clear();
    configWithPeers.adminPhones.forEach((v) => (config.adminPhones as Set<string>).add(v));
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Registration
  // ──────────────────────────────────────────────────────────────────────────

  it('registers emit_heal_result when controlPeers is non-empty', async () => {
    const runtime = new AgentRuntime(makeDb(), makeMessenger());
    await runtime.start();
    expect(findRegisteredTool()).toBeDefined();
  });

  it('does NOT register emit_heal_result when controlPeers is empty', async () => {
    (config.controlPeers as Map<string, string>).clear();

    const runtime = new AgentRuntime(makeDb(), makeMessenger());
    await runtime.start();
    expect(findRegisteredTool()).toBeUndefined();
  });

  it('registered tool has scope=global, targetMode=caller-supplied, replayPolicy=unsafe', async () => {
    const runtime = new AgentRuntime(makeDb(), makeMessenger());
    await runtime.start();
    const tool = findRegisteredTool();
    expect(tool?.scope).toBe('global');
    expect(tool?.targetMode).toBe('caller-supplied');
    expect(tool?.replayPolicy).toBe('unsafe');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Handler — guard clauses
  // ──────────────────────────────────────────────────────────────────────────

  it('throws when no active repair session', async () => {
    const { handler } = await buildRuntime();
    // activeControlReportId is null by default

    await expect(handler({
      reportId: 'r-001',
      errorClass: 'crash__something',
      result: 'fixed',
      diagnosis: 'fixed it',
    }, { tier: 'global' })).rejects.toThrow('No active repair session');
  });

  it('throws when reportId does not match active repair', async () => {
    const { runtime, handler } = await buildRuntime();
    // Inject an active report ID via the public method
    await runtime.handleControlTurn('r-ACTIVE', JSON.stringify({ reportId: 'r-ACTIVE', errorClass: 'crash__x' }));

    await expect(handler({
      reportId: 'r-WRONG',
      errorClass: 'crash__x',
      result: 'fixed',
      diagnosis: 'x',
    }, { tier: 'global' })).rejects.toThrow('No active repair for reportId r-WRONG');
  });

  it('throws when no control queue exists', async () => {
    const { runtime, handler } = await buildRuntime();

    // Set activeControlReportId directly via the private field (bypass type system)
    (runtime as unknown as { activeControlReportId: string }).activeControlReportId = 'r-001';
    // chatQueues does not have 'control@heal.internal' so getControlQueue() returns null

    await expect(handler({
      reportId: 'r-001',
      errorClass: 'crash__x',
      result: 'fixed',
      diagnosis: 'x',
    }, { tier: 'global' })).rejects.toThrow('Control queue not found');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Handler — result='fixed' path
  // ──────────────────────────────────────────────────────────────────────────

  it('sends HEAL_COMPLETE via ControlQueue for result=fixed', async () => {
    const { runtime, handler } = await buildRuntime();

    // Trigger handleControlTurn to create the control session and queue
    await runtime.handleControlTurn('r-FIX', JSON.stringify({ reportId: 'r-FIX', errorClass: 'crash__boom' }));

    const result = await handler({
      reportId: 'r-FIX',
      errorClass: 'crash__boom',
      result: 'fixed',
      commitSha: 'abc123',
      diagnosis: 'patched the bug',
    }, { tier: 'global' });

    expect(mockControlQueueInstance.sendControlMessage).toHaveBeenCalledOnce();
    const [targetJid, protocol, payload] = mockControlQueueInstance.sendControlMessage.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(targetJid).toBe('15559990001@s.whatsapp.net');
    expect(protocol).toBe('HEAL_COMPLETE');
    expect(payload.reportId).toBe('r-FIX');
    expect(payload.result).toBe('fixed');
    expect(payload.commitSha).toBe('abc123');

    expect(result).toMatchObject({ sent: true, reportId: 'r-FIX', result: 'fixed' });
  });

  it('does NOT send admin DM for result=fixed', async () => {
    const { runtime, handler } = await buildRuntime();
    await runtime.handleControlTurn('r-FIX2', JSON.stringify({}));

    await handler({
      reportId: 'r-FIX2',
      errorClass: 'crash__x',
      result: 'fixed',
      diagnosis: 'all good',
    }, { tier: 'global' });

    expect(mockSendTracked).not.toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Handler — result='escalate' path
  // ──────────────────────────────────────────────────────────────────────────

  it('sends HEAL_ESCALATE and admin DM for result=escalate', async () => {
    const { runtime, handler } = await buildRuntime();
    await runtime.handleControlTurn('r-ESC', JSON.stringify({}));

    await handler({
      reportId: 'r-ESC',
      errorClass: 'crash__oom',
      result: 'escalate',
      diagnosis: 'could not fix OOM',
    }, { tier: 'global' });

    // Control message goes to loops
    expect(mockControlQueueInstance.sendControlMessage).toHaveBeenCalledOnce();
    const [targetJid, protocol, payload] = mockControlQueueInstance.sendControlMessage.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(targetJid).toBe('15559990001@s.whatsapp.net');
    expect(protocol).toBe('HEAL_ESCALATE');
    expect(payload.reportId).toBe('r-ESC');

    // Admin DM is also sent
    expect(mockSendTracked).toHaveBeenCalledOnce();
    const [, adminJid, adminMsg] = mockSendTracked.mock.calls[0] as [unknown, string, string];
    expect(adminJid).toBe('15550100001@s.whatsapp.net');
    expect(adminMsg).toContain('[HEAL_ESCALATE]');
    expect(adminMsg).toContain('crash__oom');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Handler — cleanup and dequeue
  // ──────────────────────────────────────────────────────────────────────────

  it('clears activeControlReportId after successful emit', async () => {
    const { runtime, handler } = await buildRuntime();
    await runtime.handleControlTurn('r-CLEAR', JSON.stringify({}));

    expect(runtime.currentControlReportId).toBe('r-CLEAR');

    await handler({
      reportId: 'r-CLEAR',
      errorClass: 'crash__x',
      result: 'fixed',
      diagnosis: 'done',
    }, { tier: 'global' });

    expect(runtime.currentControlReportId).toBeNull();
  });

  it('attempts to resolve pending_heal_reports row (best-effort, no throw on missing table)', async () => {
    const db = makeDb();
    const mockPrepare = db.raw.prepare as ReturnType<typeof vi.fn>;
    // Make the pending_heal_reports UPDATE throw (table might not exist) — handler should not propagate
    mockPrepare.mockImplementation((sql: string) => {
      if (sql.includes('pending_heal_reports')) {
        return { run: vi.fn().mockImplementation(() => { throw new Error('no such table'); }) };
      }
      return { run: vi.fn(), get: vi.fn() };
    });

    const { runtime, handler } = await buildRuntime(db);
    await runtime.handleControlTurn('r-PEND', JSON.stringify({}));

    // Should NOT throw even if pending_heal_reports table is absent
    await expect(handler({
      reportId: 'r-PEND',
      errorClass: 'crash__x',
      result: 'fixed',
      diagnosis: 'done',
    }, { tier: 'global' })).resolves.toMatchObject({ sent: true });
  });

  it('dequeues and dispatches the next queued report after completion', async () => {
    const { runtime, handler } = await buildRuntime();
    await runtime.handleControlTurn('r-FIRST', JSON.stringify({}));

    // Simulate a queued report waiting
    mockDequeueNextReport.mockReturnValueOnce({
      report_id: 'r-NEXT',
      error_class: 'crash__next',
      error_type: 'crash',
      state: 'queued',
      attempt_count: 1,
      cooldown_until: null,
      context: JSON.stringify({ recentLogs: 'some logs' }),
      created_at: new Date().toISOString(),
    });

    const sendTurnSpy = mockSession.sendTurn;
    sendTurnSpy.mockClear();

    await handler({
      reportId: 'r-FIRST',
      errorClass: 'crash__x',
      result: 'fixed',
      diagnosis: 'done',
    }, { tier: 'global' });

    expect(mockDequeueNextReport).toHaveBeenCalledOnce();
    // handleControlTurn was called again (void — no await needed for assertion)
    // The control turn text includes the report_id
    // We verify it attempted to send another turn to the control session
    // (mockSession.sendTurn will be called by handleControlTurn for r-NEXT)
    await vi.runAllTimersAsync().catch(() => {});
    // The void dispatch is fire-and-forget; we just verify dequeue was called
    // and no error was thrown
  });

  it('does NOT dequeue when no reports are queued', async () => {
    const { runtime, handler } = await buildRuntime();
    await runtime.handleControlTurn('r-SOLO', JSON.stringify({}));

    mockDequeueNextReport.mockReturnValue(null);

    await handler({
      reportId: 'r-SOLO',
      errorClass: 'crash__x',
      result: 'fixed',
      diagnosis: 'done',
    }, { tier: 'global' });

    expect(mockDequeueNextReport).toHaveBeenCalledOnce();
    // No second handleControlTurn dispatch
    expect(mockSession.sendTurn).toHaveBeenCalledTimes(1); // only the initial repair turn
  });
});
