// tests/runtimes/agent/provider-reauth-alert.test.ts
// TDD coverage for the `provider_reauth_required` CRITICAL rail (Task 7 /
// ALERT-03/04/04A/05): a credential-unavailable primary-model-usability probe
// result must emit a distinct CRITICAL source (never ALSO the generic
// primary_model_unusable WARNING), transition-gated so a repeat probe does not
// re-emit, and cleared alongside the warning source at the single `usable`
// clear-site with the recovery clear-code.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';

// ─── Hoisted mocks ─────────────────────────────────────────────────────────

const alertFns = vi.hoisted(() => ({
  emitAlert: vi.fn(() => true),
  clearAlertSource: vi.fn(() => true),
}));

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
    tickWatchdog: vi.fn(() => {}),
    trackToolStart: vi.fn((_toolId: string) => {}),
    trackToolEnd: vi.fn((_toolId: string) => {}),
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

const { mockDequeueNextReport } = vi.hoisted(() => ({
  mockDequeueNextReport: vi.fn((): unknown => null),
}));

// ─── Module mocks ──────────────────────────────────────────────────────────
// Construction-only harness lifted verbatim from
// tests/runtimes/agent/control-timeout.test.ts (its prologue is the SSOT for
// what `new AgentRuntime(makeDb(), makeMessenger())` needs to construct
// without throwing). The alert mock swaps in the vi.hoisted idiom from
// tests/fleet/health-poller.test.ts so emitAlertChecked/clearAlertSourceChecked
// calls are observable as alertFns.emitAlert / alertFns.clearAlertSource.

vi.mock('../../../src/lib/emit-alert.ts', () => ({
  ...alertFns,
  emitAlertChecked: alertFns.emitAlert,
  clearAlertSourceChecked: alertFns.clearAlertSource,
}));

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
  return { sendMessage: vi.fn(async () => ({ waMessageId: null })), sendMedia: vi.fn(async () => ({ waMessageId: null })) };
}

// Access the private recordPrimaryModelUsability seam — the established idiom
// this test suite uses throughout runtime.test.ts is `(runtime as unknown as
// {...}).method(...)`; this helper just packages that cast once.
type UsabilityResult = { status: string; provider: string; model: string | null; reason?: string };
const seam = (runtime: unknown) => runtime as unknown as {
  recordPrimaryModelUsability(result: UsabilityResult, trigger: 'startup' | 'manual'): void;
};

// ─── Tests ────────────────────────────────────────────────────────────────

describe('provider_reauth_required critical rail (ALERT-03/04/04A/05)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDequeueNextReport.mockReturnValue(null);
  });

  it('credential-unavailable → ONE provider_reauth_required critical (no warning double-emit)', () => {
    const runtime = new AgentRuntime(makeDb(), makeMessenger());
    seam(runtime).recordPrimaryModelUsability({ status: 'credential-unavailable', provider: 'claude-cli', model: null }, 'startup');
    seam(runtime).recordPrimaryModelUsability({ status: 'credential-unavailable', provider: 'claude-cli', model: null }, 'manual'); // repeat: guard-gated
    const emits = alertFns.emitAlert.mock.calls;
    const reauth = emits.filter(([, source]) => source === 'provider_reauth_required');
    expect(reauth).toHaveLength(1);
    expect(reauth[0][4]).toBe('critical');
    expect(emits.some(([, source]) => source === 'primary_model_unusable')).toBe(false);
  });

  it('non-auth unusable (model-unavailable) keeps the primary_model_unusable warning path (IMPACT-08)', () => {
    const runtime = new AgentRuntime(makeDb(), makeMessenger());
    seam(runtime).recordPrimaryModelUsability({ status: 'model-unavailable', provider: 'claude-cli', model: 'x' }, 'startup');
    const emits = alertFns.emitAlert.mock.calls;
    expect(emits.some(([, source]) => source === 'primary_model_unusable')).toBe(true);
    expect(emits.some(([, source]) => source === 'provider_reauth_required')).toBe(false);
  });

  it('usable clears BOTH sources at the one clear-site with the recovery clear-code', () => {
    const runtime = new AgentRuntime(makeDb(), makeMessenger());
    seam(runtime).recordPrimaryModelUsability({ status: 'credential-unavailable', provider: 'claude-cli', model: null }, 'startup');
    seam(runtime).recordPrimaryModelUsability({ status: 'usable', provider: 'claude-cli', model: null }, 'manual');
    const clears = alertFns.clearAlertSource.mock.calls;
    const reauthClear = clears.filter(([, source]) => source === 'provider_reauth_required');
    expect(reauthClear).toHaveLength(1);
    expect(String(reauthClear[0][2])).toContain('clear_code=AGENT_PROVIDER_AUTH_RECOVERED');
    expect(String(reauthClear[0][2])).toContain('proof=primary_model_probe_ok');
    // and a later usable does not re-clear (guard reset)
    seam(runtime).recordPrimaryModelUsability({ status: 'usable', provider: 'claude-cli', model: null }, 'manual');
    expect(alertFns.clearAlertSource.mock.calls.filter(([, s]) => s === 'provider_reauth_required')).toHaveLength(1);
  });

  it('evidence carries the full field contract (ALERT-04A) and a criticalAsset with the shared code', () => {
    const runtime = new AgentRuntime(makeDb(), makeMessenger());
    seam(runtime).recordPrimaryModelUsability({ status: 'credential-unavailable', provider: 'claude-cli', model: null }, 'startup');
    const [call] = alertFns.emitAlert.mock.calls.filter(([, source]) => source === 'provider_reauth_required');
    const evidence = String(call[3]);
    for (const key of ['instance=', 'bot=', 'host=', 'provider=', 'model=', 'trigger=startup_probe',
      'model_usability_status=', 'last_turn_error_class=', 'model_usable_checked_at=', 'model_usable_stale=',
      'fallback_active=', 'fallback_provider=', 'fallback_model=', 'cred_source=', 'ccd_pin=',
      'evidence_schema_version=1']) {
      expect(evidence).toContain(key);
    }
    const asset = call[5] as { asset: { kind: string }; failure: { code: string; domain: string } };
    expect(asset.asset.kind).toBe('agent_provider');
    expect(asset.failure.code).toBe('AGENT_PROVIDER_AUTH_REQUIRED');
    expect(asset.failure.domain).toBe('provider_access');
  });
});
