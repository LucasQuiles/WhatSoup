/**
 * System-provider-request timeout retry (P3).
 *
 * A production fresh_session_context request hit the 240s deadline because the
 * claude-cli subprocess was merely slow to start under host I/O pressure (zero
 * stderr). The old handler quarantined the source generation on the FIRST
 * expiry, killing the session under the queued user turn ('No active session').
 *
 * Contract under test (markSystemTurn onTimeout):
 *   1. First expiry: warn log, one more full deadline window, NO teardown; a
 *      result landing inside the retry window completes the request normally.
 *   2. Second consecutive expiry: quarantine exactly as before (error log,
 *      session.shutdown(false), lease cancelled only on proven teardown).
 *   3. Exactly one retry window per lease — never a third.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks (declared before importing the runtime, hoisted by vitest) ──────────

const { mockRuntimeLogger } = vi.hoisted(() => ({
  mockRuntimeLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => mockRuntimeLogger,
}));

vi.mock('../../../src/lib/emit-alert.ts', () => {
  const emitAlert = vi.fn(() => true);
  const clearAlertSource = vi.fn(() => true);
  return {
    emitAlert,
    emitAlertChecked: emitAlert,
    clearAlertSource,
    clearAlertSourceChecked: clearAlertSource,
  };
});

vi.mock('../../../src/config.ts', () => ({
  config: {
    adminPhones: new Set<string>(),
    controlPeers: new Map<string, string>(),
    toolUpdateMode: 'full',
    toolUpdateRedirectJid: null,
    textAggregateDelayMs: 2_000,
    mediaDir: '/tmp/whatsoup-test-media/tmp',
    voiceReply: 'never',
    elevenlabs: {
      defaultVoiceId: 'v',
      defaultModel: 'eleven_multilingual_v2',
      stability: 0.5,
      similarityBoost: 0.75,
    },
    agentMaxQueueDepth: 25,
    agentProvider: 'claude-cli',
    agentProviderConfig: undefined,
    agentFallbackProvider: undefined,
    agentFallbackModel: undefined,
  },
}));

vi.mock('../../../src/mcp/register-all.ts', () => ({
  registerAllTools: vi.fn(),
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

vi.mock('../../../src/lib/keyring.ts', () => ({
  lookupCredential: vi.fn(() => 'present-key'),
  resolveProviderKeyService: vi.fn(() => null),
}));

vi.mock('../../../src/runtimes/agent/providers/credential-verify.ts', () => ({
  verifyFallbackCredential: vi.fn(() => Promise.resolve('unknown')),
}));

vi.mock('../../../src/runtimes/agent/providers/binary-preflight.ts', () => ({
  probeFallbackBinary: vi.fn(() => Promise.resolve({ status: 'unknown', version: null })),
  probeModelCatalog: vi.fn(() => Promise.resolve({ status: 'unknown', suggestion: null })),
  probeBinaryAuthStatus: vi.fn(() => Promise.resolve({ status: 'ok', output: '' })),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';
import type {
  SystemTurnLeaseToken,
  SystemTurnPurpose,
} from '../../../src/runtimes/agent/pending-system-result-tracker.ts';

// Mirrors SYSTEM_TURN_TIMEOUT_MS (= AUTO_COMPACT_TIMEOUT_MS) in runtime.ts.
const TIMEOUT_MS = 240_000;
const RETRY_LOG = 'system provider request timed out — retrying once before quarantine';
const QUARANTINE_LOG = 'system provider request timed out — quarantining source generation';

function makeDb(): Database {
  return {
    assertWritableCompatibility: vi.fn(),
    raw: {
      prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) })),
      exec: vi.fn(),
    },
  } as unknown as Database;
}

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  } as unknown as Messenger;
}

function makeFakeQueue(chatJid: string) {
  return {
    targetChatJid: chatJid,
    enqueueText: vi.fn(),
    getSenderToken: () => 'mock-sender-token',
    enqueueResultText: vi.fn(),
    enqueueStreamingText: vi.fn(),
    enqueueToolUpdate: vi.fn(),
    markLastTerminal: vi.fn(),
    flush: vi.fn(async () => {}),
    getLastOpId: vi.fn(() => undefined),
    clearLastOpId: vi.fn(),
    indicateTyping: vi.fn(),
    endTurn: vi.fn(),
  };
}

function makeEventSession() {
  return {
    clearTurnWatchdog: vi.fn(),
    completeProviderTurn: vi.fn(),
    getDbRowId: vi.fn(() => null),
    getProviderId: vi.fn(() => 'claude-cli'),
    getStatus: vi.fn(() => ({ active: true })),
    bindGenerationOwnership: vi.fn(),
    sendTurn: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    tickWatchdog: vi.fn(),
    trackToolStart: vi.fn(),
    trackToolEnd: vi.fn(),
  };
}

/** Bracket-access view of private runtime state. */
type RuntimeView = {
  chatQueues: Map<string, unknown>;
  sessionEventToolScopes: WeakMap<object, string>;
  pendingSystemResults: {
    count(scopeKey: string): number;
    blockingCount(scopeKey: string): number;
    peek(scopeKey: string): { lease: SystemTurnLeaseToken } | null;
  };
  setOwnedPerChatSession(mapKey: string, session: object): void;
  markSystemTurn(
    session: object,
    scopeKey: string,
    purpose: SystemTurnPurpose,
    routeChatJid?: string,
  ): SystemTurnLeaseToken;
  handleEventPerChat(sourceSession: object, event: unknown, toolScopeKey: string): void;
};

function v(runtime: AgentRuntime): RuntimeView {
  return runtime as unknown as RuntimeView;
}

function retryWarnCalls(): unknown[][] {
  return mockRuntimeLogger.warn.mock.calls.filter((call) => call[1] === RETRY_LOG);
}

function quarantineErrorCalls(): unknown[][] {
  return mockRuntimeLogger.error.mock.calls.filter((call) => call[1] === QUARANTINE_LOG);
}

function seedOwnedSystemTurn(purpose: SystemTurnPurpose = 'fresh_session_context') {
  const runtime = new AgentRuntime(makeDb(), makeMessenger(), 'test', { sessionScope: 'per_chat' });
  const rv = v(runtime);
  const mapKey = 'chat-retry@s.whatsapp.net';
  const session = makeEventSession();
  const toolScopeKey = `${mapKey}#test`;
  rv.setOwnedPerChatSession(mapKey, session);
  rv.sessionEventToolScopes.set(session, toolScopeKey);
  rv.chatQueues.set(mapKey, makeFakeQueue(mapKey));
  const lease = rv.markSystemTurn(session, mapKey, purpose, mapKey);
  return { rv, mapKey, session, toolScopeKey, lease };
}

describe('system provider request timeout retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('grants one retry window on the first timeout and completes without quarantine when the result lands in it', async () => {
    const { rv, mapKey, session, toolScopeKey, lease } = seedOwnedSystemTurn();
    expect(rv.pendingSystemResults.blockingCount(mapKey)).toBe(1);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
      { scopeKey: mapKey, leaseId: lease.id, purpose: 'fresh_session_context', timeoutMs: TIMEOUT_MS },
      RETRY_LOG,
    );
    expect(session.shutdown).not.toHaveBeenCalled();
    expect(quarantineErrorCalls()).toHaveLength(0);
    // The lease keeps gating dispatch while the slow request gets its window.
    expect(rv.pendingSystemResults.blockingCount(mapKey)).toBe(1);
    expect(rv.pendingSystemResults.peek(mapKey)?.lease.id).toBe(lease.id);

    // The slow claude-cli result lands inside the retry window.
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS / 2);
    rv.handleEventPerChat(session, { type: 'result', text: 'context absorbed' }, toolScopeKey);
    await vi.advanceTimersByTimeAsync(0);

    expect(rv.pendingSystemResults.count(mapKey)).toBe(0);

    // Long after: the consumed lease never quarantines and never re-fires.
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 4);
    expect(session.shutdown).not.toHaveBeenCalled();
    expect(quarantineErrorCalls()).toHaveLength(0);
    expect(retryWarnCalls()).toHaveLength(1);
  });

  it('quarantines on the second consecutive timeout exactly as before', async () => {
    const { rv, mapKey, session, lease } = seedOwnedSystemTurn();

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(retryWarnCalls()).toHaveLength(1);
    expect(session.shutdown).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    expect(mockRuntimeLogger.error).toHaveBeenCalledWith(
      { scopeKey: mapKey, leaseId: lease.id, purpose: 'fresh_session_context', timeoutMs: TIMEOUT_MS },
      QUARANTINE_LOG,
    );
    expect(session.shutdown).toHaveBeenCalledExactlyOnceWith(false);
    // Proven teardown cancels the exact lease and reopens the lane.
    expect(rv.pendingSystemResults.count(mapKey)).toBe(0);
    expect(rv.pendingSystemResults.blockingCount(mapKey)).toBe(0);
  });

  it('never grants a second retry window for the same lease', async () => {
    const { rv, mapKey, session } = seedOwnedSystemTurn('respawn_continuation');

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 4);

    expect(retryWarnCalls()).toHaveLength(1);
    expect(quarantineErrorCalls()).toHaveLength(1);
    expect(session.shutdown).toHaveBeenCalledExactlyOnceWith(false);
    expect(rv.pendingSystemResults.count(mapKey)).toBe(0);
  });
});
