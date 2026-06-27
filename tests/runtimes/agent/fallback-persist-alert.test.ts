/**
 * Commit 4 coverage:
 *
 * (a) armFallbackWindow: when saveFallbackState throws, emitAlert fires
 *     with source='fallback_persist_failed'; window is still armed in-memory
 *     (effectiveProvider flipped).
 *
 * (b) recordFallbackTurnOutcome: the fallback_empty_turn evidence string
 *     contains the queue's targetChatJid.
 *
 * Harness mirrors fallback-credential-preflight.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fallbackStateDb from '../../../src/runtimes/agent/fallback-state-db.ts';

// ─── Mocks ───────────────────────────────────────────────────────────────────

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
  };
  (globalThis as Record<string, unknown>)['__fallbackPersistAlertTestConfig__'] = config;
  return { config };
});

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
  resolveProviderKeyService: vi.fn((provider: unknown, model: unknown) => {
    if (provider === 'opencode-cli' && typeof model === 'string') return model.split('/')[0]?.trim().toLowerCase() || null;
    if (provider === 'openai-api') return 'openai';
    if (provider === 'anthropic-api') return 'anthropic';
    return null;
  }),
}));

vi.mock('../../../src/runtimes/agent/providers/credential-verify.ts', () => ({
  verifyFallbackCredential: vi.fn(() => Promise.resolve('unknown')),
}));

// Keep arm-time pre-flight probes from spawning real child processes; both
// fail open so no binary/model alerts interfere with the alerts under test.
vi.mock('../../../src/runtimes/agent/providers/binary-preflight.ts', () => ({
  probeFallbackBinary: vi.fn(() => Promise.resolve({ status: 'unknown', version: null })),
  probeModelCatalog: vi.fn(() => Promise.resolve({ status: 'unknown', suggestion: null })),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';
import { emitAlert } from '../../../src/lib/emit-alert.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockConfigRef(): Record<string, unknown> {
  return (globalThis as Record<string, unknown>)[
    '__fallbackPersistAlertTestConfig__'
  ] as Record<string, unknown>;
}

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
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  } as unknown as Messenger;
}

function makeRuntime(): AgentRuntime {
  const config = mockConfigRef();
  config['agentProvider'] = 'claude-cli';
  config['agentFallbackProvider'] = 'opencode-cli';
  config['agentFallbackModel'] = 'minimax/minimax-m2';
  return new AgentRuntime(makeDb(), makeMessenger(), 'test', {
    model: 'claude-opus-4-8[1m]',
  });
}

type RuntimeView = {
  effectiveProvider: string;
  fallbackWindow: { activeUntil: number | null };
  activateProviderFallback(resetAt: Date | null): void;
  handleEventWithContext(
    event: unknown,
    queue: unknown,
    session: unknown,
    conversationKey?: string,
    inboundSeq?: number,
    mapKey?: string,
  ): void;
};

function rv(runtime: AgentRuntime): RuntimeView {
  return runtime as unknown as RuntimeView;
}

function makeFakeQueue(targetChatJid = 'user@s.whatsapp.net') {
  return {
    targetChatJid,
    enqueueText: vi.fn(),
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('armFallbackWindow — persist-failure alert', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T10:00:00Z'));
    vi.mocked(emitAlert).mockClear();
    vi.spyOn(fallbackStateDb, 'clearFallbackState').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('emits fallback_persist_failed alert when saveFallbackState throws', () => {
    vi.spyOn(fallbackStateDb, 'saveFallbackState').mockImplementation(() => {
      throw new Error('disk full');
    });

    const runtime = makeRuntime();
    rv(runtime).activateProviderFallback(null);

    const sources = vi.mocked(emitAlert).mock.calls.map((c) => c[1]);
    expect(sources).toContain('fallback_persist_failed');
  });

  it('persist-failed evidence includes until timestamp and reason', () => {
    vi.spyOn(fallbackStateDb, 'saveFallbackState').mockImplementation(() => {
      throw new Error('disk full');
    });

    const runtime = makeRuntime();
    rv(runtime).activateProviderFallback(null);

    const persistCall = vi.mocked(emitAlert).mock.calls.find((c) => c[1] === 'fallback_persist_failed');
    expect(persistCall).toBeDefined();
    if (!persistCall) throw new Error('no persist-failed alert');
    // Evidence must include the until= and reason= fragments.
    expect(persistCall[3]).toMatch(/until=/);
    expect(persistCall[3]).toMatch(/reason=/);
  });

  it('window remains armed in-memory despite persist failure (effectiveProvider flipped)', () => {
    vi.spyOn(fallbackStateDb, 'saveFallbackState').mockImplementation(() => {
      throw new Error('disk full');
    });

    const runtime = makeRuntime();
    rv(runtime).activateProviderFallback(null);

    // Window is still set.
    expect(rv(runtime).fallbackWindow.activeUntil).not.toBeNull();
    // Provider has flipped to the fallback provider.
    expect(rv(runtime).effectiveProvider).toBe('opencode-cli');
  });

  it('both persist-failed alert and window-armed are true even when saveFallbackState throws', () => {
    vi.spyOn(fallbackStateDb, 'saveFallbackState').mockImplementation(() => {
      throw new Error('disk full');
    });

    const runtime = makeRuntime();
    rv(runtime).activateProviderFallback(null);

    const sources = vi.mocked(emitAlert).mock.calls.map((c) => c[1]);
    expect(sources).toContain('fallback_persist_failed');
    expect(rv(runtime).effectiveProvider).toBe('opencode-cli');
  });
});

describe('recordFallbackTurnOutcome — chat in empty-turn evidence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T10:00:00Z'));
    vi.mocked(emitAlert).mockClear();
    vi.spyOn(fallbackStateDb, 'saveFallbackState').mockImplementation(() => {});
    vi.spyOn(fallbackStateDb, 'clearFallbackState').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('fallback_empty_turn evidence contains chat= fragment with queue.targetChatJid', () => {
    const chatJid = 'alice@s.whatsapp.net';
    const runtime = makeRuntime();
    rv(runtime).activateProviderFallback(null);

    const queue = makeFakeQueue(chatJid);
    // Drive a genuinely empty turn (no tool use, no text).
    rv(runtime).handleEventWithContext(
      { type: 'result', text: null },
      queue,
      null,
      'conv-key',
      1,
      'mapkey-chat-evidence',
    );

    const emptyTurnCall = vi.mocked(emitAlert).mock.calls.find(
      (c) => c[1] === 'fallback_empty_turn',
    );
    expect(emptyTurnCall).toBeDefined();
    if (!emptyTurnCall) throw new Error('no fallback_empty_turn alert');
    // The evidence string (4th arg) must include chat=<jid>.
    expect(emptyTurnCall[3]).toContain(`chat=${chatJid}`);
  });

  it('fallback_empty_turn evidence still contains provider, model, served, empty fragments', () => {
    const runtime = makeRuntime();
    rv(runtime).activateProviderFallback(null);

    const queue = makeFakeQueue('bob@s.whatsapp.net');
    rv(runtime).handleEventWithContext(
      { type: 'result', text: null },
      queue,
      null,
      'conv-key',
      1,
      'mapkey-existing-evidence',
    );

    const emptyTurnCall = vi.mocked(emitAlert).mock.calls.find(
      (c) => c[1] === 'fallback_empty_turn',
    );
    expect(emptyTurnCall).toBeDefined();
    if (!emptyTurnCall) throw new Error('no fallback_empty_turn alert');
    const evidence = emptyTurnCall[3] as string;
    expect(evidence).toMatch(/provider=/);
    expect(evidence).toMatch(/model=/);
    expect(evidence).toMatch(/served=/);
    expect(evidence).toMatch(/empty=/);
    expect(evidence).toMatch(/chat=/);
  });
});
