/**
 * Route currency across fallback window transitions (incident 2026-08-15).
 *
 * A SessionManager's provider/model are frozen at construction, the session-map
 * hit never re-resolves the route, /new resets the session INSIDE the same
 * manager, and auto-respawn re-spawns the same object. Live consequence: for
 * 7+ minutes after "reverting to primary provider", every turn — including a
 * fresh /new — kept arming the DEAD fallback provider.
 *
 * Fix contract pinned here: every fallback window transition (arm, advance,
 * revert) marks the scopes of live managers whose frozen route no longer
 * matches the route a NEW session would resolve, using the existing deferred
 * route-recycle lifecycle (Task G) consumed at the next turn-idle boundary —
 * so stale managers are detached safely (never mid-turn) and the next message
 * builds a fresh manager on the current route. The auto-respawn guard
 * (sessionMatchesCurrentRoute) is pinned at the helper level.
 *
 * Harness mirrors fallback-process-failure-advance.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

vi.mock('../../../src/config.ts', () => {
  const config: Record<string, unknown> = {
    fallbackTunables: { noticeDedupMs: 1_800_000, primaryRecheckMs: 300_000, probeStallThreshold: 12, probeStallCeilingMultiple: 10 },
    adminPhones: new Set<string>(),
    controlPeers: new Map<string, string>(),
    toolUpdateMode: 'full',
    toolUpdateRedirectJid: null,
    textAggregateDelayMs: 2_000,
    mediaDir: '/tmp/whatsoup-test-media-fallback-route-currency/tmp',
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
    agentFallbacks: undefined,
  };
  (globalThis as Record<string, unknown>)['__routeCurrencyTestConfig__'] = config;
  return { config };
});

function mockConfigRef(): Record<string, unknown> {
  return (globalThis as Record<string, unknown>)['__routeCurrencyTestConfig__'] as Record<string, unknown>;
}

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

const lookupCredentialMock = vi.fn<(service: string) => string | null>(() => 'present-key');
vi.mock('../../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/keyring.ts')>();
  return {
    ...actual,
    lookupCredential: (service: string) => lookupCredentialMock(service),
  };
});

vi.mock('../../../src/runtimes/agent/providers/credential-verify.ts', () => ({
  verifyFallbackCredential: vi.fn(() => Promise.resolve('unknown')),
}));
vi.mock('../../../src/runtimes/agent/providers/binary-preflight.ts', () => ({
  probeFallbackBinary: vi.fn(() => Promise.resolve({ status: 'unknown', version: null })),
  probeModelCatalog: vi.fn(() => Promise.resolve({ status: 'unknown', suggestion: null })),
}));

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';

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
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  } as unknown as Messenger;
}

interface FallbackEntry {
  provider: string;
  model?: string;
}

function makeRuntime(chain: FallbackEntry[]): AgentRuntime {
  const config = mockConfigRef();
  config['agentProvider'] = 'claude-cli';
  config['agentFallbacks'] = chain;
  return new AgentRuntime(makeDb(), makeMessenger(), 'test', {
    model: 'claude-opus-4-8[1m]',
    sessionScope: 'per_chat',
  });
}

function makeSession(provider: string, model: string) {
  return {
    bindGenerationOwnership: vi.fn(),
    getStatus: vi.fn(() => ({ active: true, sessionId: null, pid: null })),
    getDbRowId: vi.fn(() => null),
    getProviderId: vi.fn(() => provider),
    getModelRef: vi.fn(() => model),
    shutdown: vi.fn(async () => {}),
  };
}

type RuntimeView = {
  activateProviderFallback(
    resetAt: Date | null,
    reason?: 'usage-limit' | 'rate-limit' | 'auth-required' | 'model-unavailable' | 'server-error',
  ): unknown;
  deactivateProviderFallback(reason: string): void;
  setOwnedPerChatSession(key: string, session: unknown): void;
  sessionOwnership: {
    get: (key: string) => { managerId: string; generation: number; state: string } | undefined;
  };
  chatQueues: Map<string, unknown>;
  pendingRecycle: Set<string>;
  fallbackWindow: { activeEntry: FallbackEntry | null };
  fallbackChain: { failedKeys: Set<string> };
  handlePerChatCrash(mapKey: string, chatJid?: string, info?: unknown): void;
  sessionMatchesCurrentRoute(session: unknown): boolean;
};

function v(runtime: AgentRuntime): RuntimeView {
  return runtime as unknown as RuntimeView;
}

const CHAT_A = 'alpha@s.whatsapp.net';
const CHAT_B = 'beta@s.whatsapp.net';

const CHAIN = [
  { provider: 'opencode-cli', model: 'kimi/kimi-k3' },
  { provider: 'opencode-cli', model: 'glm/glm-5.2' },
];

describe('route recycles on fallback window transitions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T20:00:00Z'));
    lookupCredentialMock.mockReturnValue('present-key');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('activation marks primary-provider managers for recycle', () => {
    const runtime = makeRuntime(CHAIN);
    const rv = v(runtime);
    rv.setOwnedPerChatSession(CHAT_A, makeSession('claude-cli', 'claude-opus-4-8'));

    rv.activateProviderFallback(null, 'usage-limit');

    expect(rv.pendingRecycle.has(CHAT_A)).toBe(true);
  });

  it('activation leaves managers already matching the armed entry alone', () => {
    const runtime = makeRuntime(CHAIN);
    const rv = v(runtime);
    rv.setOwnedPerChatSession(CHAT_A, makeSession('opencode-cli', 'kimi/kimi-k3'));

    rv.activateProviderFallback(null, 'usage-limit');

    expect(rv.pendingRecycle.has(CHAT_A)).toBe(false);
  });

  it('revert marks fallback-provider managers for recycle and leaves primary managers alone', () => {
    const runtime = makeRuntime(CHAIN);
    const rv = v(runtime);
    rv.activateProviderFallback(null, 'usage-limit');
    rv.setOwnedPerChatSession(CHAT_A, makeSession('opencode-cli', 'kimi/kimi-k3'));
    rv.setOwnedPerChatSession(CHAT_B, makeSession('claude-cli', 'claude-opus-4-8'));
    rv.pendingRecycle.clear();

    rv.deactivateProviderFallback('primary-probe-ok');

    expect(rv.pendingRecycle.has(CHAT_A)).toBe(true);
    expect(rv.pendingRecycle.has(CHAT_B)).toBe(false);
  });

  it('chain advance marks other chats\' managers still on the dead entry (same provider, different model)', () => {
    const runtime = makeRuntime(CHAIN);
    const rv = v(runtime);
    rv.activateProviderFallback(null, 'usage-limit');
    // Crashing manager in chat A (drives the advance), stale sibling in chat B.
    const crashing = makeSession('opencode-cli', 'kimi/kimi-k3');
    rv.setOwnedPerChatSession(CHAT_A, crashing);
    const ownerA = rv.sessionOwnership.get(CHAT_A)!;
    rv.setOwnedPerChatSession(CHAT_B, makeSession('opencode-cli', 'kimi/kimi-k3'));
    rv.pendingRecycle.clear();

    rv.handlePerChatCrash(CHAT_A, CHAT_A, {
      exitCode: 1,
      signal: null,
      provider: 'opencode-cli',
      crashClass: 'unknown_terminal',
      sessionId: null,
      dbRowId: null,
      generationIdentity: { managerId: ownerA.managerId, generation: ownerA.generation },
    });

    expect(rv.fallbackWindow.activeEntry?.model).toBe('glm/glm-5.2');
    expect(rv.pendingRecycle.has(CHAT_B)).toBe(true);
  });
});

describe('sessionMatchesCurrentRoute (auto-respawn currency guard)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T20:00:00Z'));
    lookupCredentialMock.mockReturnValue('present-key');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('primary manager matches when no window is active', () => {
    const rv = v(makeRuntime(CHAIN));
    expect(rv.sessionMatchesCurrentRoute(makeSession('claude-cli', 'claude-opus-4-8'))).toBe(true);
  });

  it('primary manager is stale during an active window', () => {
    const rv = v(makeRuntime(CHAIN));
    rv.activateProviderFallback(null, 'usage-limit');
    expect(rv.sessionMatchesCurrentRoute(makeSession('claude-cli', 'claude-opus-4-8'))).toBe(false);
  });

  it('active-entry manager matches during its window and is stale after revert', () => {
    const rv = v(makeRuntime(CHAIN));
    rv.activateProviderFallback(null, 'usage-limit');
    const fallbackSession = makeSession('opencode-cli', 'kimi/kimi-k3');
    expect(rv.sessionMatchesCurrentRoute(fallbackSession)).toBe(true);
    rv.deactivateProviderFallback('primary-probe-ok');
    expect(rv.sessionMatchesCurrentRoute(fallbackSession)).toBe(false);
  });

  it('dead-entry manager is stale after the chain advanced to a different model', () => {
    const runtime = makeRuntime(CHAIN);
    const rv = v(runtime);
    rv.activateProviderFallback(null, 'usage-limit');
    const kimiSession = makeSession('opencode-cli', 'kimi/kimi-k3');
    rv.setOwnedPerChatSession(CHAT_A, kimiSession);
    const ownerA = rv.sessionOwnership.get(CHAT_A)!;
    rv.handlePerChatCrash(CHAT_A, CHAT_A, {
      exitCode: 1,
      signal: null,
      provider: 'opencode-cli',
      crashClass: 'unknown_terminal',
      sessionId: null,
      dbRowId: null,
      generationIdentity: { managerId: ownerA.managerId, generation: ownerA.generation },
    });
    expect(rv.fallbackWindow.activeEntry?.model).toBe('glm/glm-5.2');
    expect(rv.sessionMatchesCurrentRoute(kimiSession)).toBe(false);
    expect(rv.sessionMatchesCurrentRoute(makeSession('opencode-cli', 'glm/glm-5.2'))).toBe(true);
  });
});
