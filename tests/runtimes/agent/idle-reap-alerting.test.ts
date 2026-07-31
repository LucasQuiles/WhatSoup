/**
 * The supervisor's own idle reap must not page an operator.
 *
 * The 30-min inactivity watchdog SIGKILLs a healthy, idle provider on purpose and tells the
 * user why. Before this fix no intent reached the exit handler, so the reap was classified as
 * `crash__signal_SIGKILL_exit_none` and emitted a critical BOT ERRORS page asking Q to
 * "investigate and remediate" — every 30 minutes, forever, on every idle chat.
 *
 * These fixtures pin both halves of the fix:
 *   - SessionManager tags the reap (`terminationReason`) and suppresses the duplicate
 *     "Agent session ended" notice, while a kill it did NOT issue is still a crash.
 *   - AgentRuntime withholds the heal report for an idle reap, but still reports one that
 *     interrupted an in-flight turn (that is a genuine provider stall).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const { mockQueue } = vi.hoisted(() => ({
  mockQueue: {
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
  },
}));

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/core/messages.ts', () => ({ getRecentMessages: vi.fn(() => []) }));

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

vi.mock('../../../src/runtimes/agent/outbound-queue.ts', () => ({
  OutboundQueue: vi.fn().mockImplementation(function () { return mockQueue; }),
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

vi.mock('../../../src/core/durability.ts', () => ({ sendTracked: vi.fn() }));

vi.mock('../../../src/core/conversation-key.ts', () => ({
  toConversationKey: vi.fn((jid: string) => jid),
  GLOBAL_CONVERSATION_KEY: '__global__',
}));

vi.mock('../../../src/core/heal-protocol.ts', () => ({ EmitHealResultSchema: {} }));

vi.mock('../../../src/core/heal.ts', () => ({
  dequeueNextReport: vi.fn(),
  emitHealReport: vi.fn(),
}));

vi.mock('../../../src/mcp/register-all.ts', () => ({ registerAllTools: vi.fn() }));

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
  ControlQueue: vi.fn().mockImplementation(function () { return mockQueue; }),
}));

vi.mock('../../../src/core/media-mime.ts', () => ({ extractRawMime: vi.fn() }));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import { emitHealReport } from '../../../src/core/heal.ts';
import type { SessionCrashInfo } from '../../../src/runtimes/agent/session.ts';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';

// ── Helpers ─────────────────────────────────────────────────────────────────

const CHAT_JID = 'test@s.whatsapp.net';

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

/** The crash-reporting seam under test. */
interface CrashReportSurface {
  emitCrashHealReport(chatJid: string, info: SessionCrashInfo, turnWasInFlight: boolean): void;
}

function crashInfo(overrides: Partial<SessionCrashInfo> = {}): SessionCrashInfo {
  return {
    exitCode: null,
    signal: 'SIGKILL',
    sessionId: 'session-1',
    dbRowId: 1,
    provider: 'claude-cli',
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('AgentRuntime crash reporting — supervisor reaps vs provider faults', () => {
  let runtime: AgentRuntime;
  let surface: CrashReportSurface;

  beforeEach(() => {
    vi.mocked(emitHealReport).mockClear();
    runtime = new AgentRuntime(makeDb(), makeMessenger(), 'test', { sessionScope: 'per_chat' });
    surface = runtime as unknown as CrashReportSurface;
  });

  it('does not page for an idle-watchdog reap of an idle session', () => {
    surface.emitCrashHealReport(CHAT_JID, crashInfo({ terminationReason: 'idle_watchdog' }), false);
    expect(emitHealReport).not.toHaveBeenCalled();
  });

  it('pages when the idle watchdog reaps a session with a turn in flight (a real stall)', () => {
    surface.emitCrashHealReport(CHAT_JID, crashInfo({ terminationReason: 'idle_watchdog' }), true);
    expect(emitHealReport).toHaveBeenCalledTimes(1);
  });

  it('pages for a stalled-operation kill — the supervisor issued it, but a tool really hung', () => {
    surface.emitCrashHealReport(CHAT_JID, crashInfo({ terminationReason: 'stalled_operation' }), false);
    expect(emitHealReport).toHaveBeenCalledTimes(1);
  });

  it('preserves a bounded SessionManager fallback class without forwarding diagnostics', () => {
    surface.emitCrashHealReport(CHAT_JID, crashInfo({
      exitCode: null,
      signal: null,
      crashClass: 'spawn_error',
    }), false);

    expect(emitHealReport).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      null,
      { type: 'crash', crashClass: 'spawn_error' },
      null,
    );
  });

  it('projects an untagged crash into bounded reporter input without identity or diagnostics', () => {
    const canary = 'RUNTIME_CRASH_CANARY_DO_NOT_LEAK';
    surface.emitCrashHealReport(CHAT_JID, crashInfo({
      provider: canary,
      crashClass: canary,
      stderrPreview: canary,
    }), false);
    expect(emitHealReport).toHaveBeenCalledTimes(1);
    const input = vi.mocked(emitHealReport).mock.calls[0][3];
    expect(input).toMatchObject({
      type: 'crash',
      termination: 'exit_or_signal',
    });
    expect(JSON.stringify(input)).not.toContain(CHAT_JID);
    expect(JSON.stringify(input)).not.toContain(canary);
    expect(JSON.stringify(input)).not.toContain('SIGKILL');
  });
});
