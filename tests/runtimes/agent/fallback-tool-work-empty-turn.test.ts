/**
 * Empty-turn notice suppression when the fallback turn did tool work.
 *
 * A fallback turn whose entire reply was MCP tool sends (send_message,
 * send_media, etc.) is NOT silent — the user received the result through
 * the outbound channel. Firing the "backup model returned no reply" notice
 * after such a turn is wrong.
 *
 * This file adds the tool-work gating cases on top of the existing
 * zero-text signal coverage in fallback-empty-turn.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fallbackStateDb from '../../../src/runtimes/agent/fallback-state-db.ts';

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
  (globalThis as Record<string, unknown>)['__toolWorkEmptyTurnTestConfig__'] = config;
  return { config };
});

function mockConfigRef(): Record<string, unknown> {
  return (globalThis as Record<string, unknown>)['__toolWorkEmptyTurnTestConfig__'] as Record<string, unknown>;
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

vi.mock('../../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/keyring.ts')>();
  return {
    ...actual,
    lookupCredential: vi.fn(() => 'present-key'),
    resolveProviderKeyService: vi.fn((provider: unknown, model: unknown) => {
      if (provider === 'opencode-cli' && typeof model === 'string') return model.split('/')[0]?.trim().toLowerCase() || null;
      if (provider === 'openai-api') return 'openai';
      if (provider === 'anthropic-api') return 'anthropic';
      return null;
    }),
  };
});

vi.mock('../../../src/runtimes/agent/providers/credential-verify.ts', () => ({
  verifyFallbackCredential: vi.fn(() => Promise.resolve('unknown')),
}));

// Keep arm-time pre-flight probes from spawning real child processes; both
// fail open so no binary/model alerts interfere with the alerts under test.
vi.mock('../../../src/runtimes/agent/providers/binary-preflight.ts', () => ({
  probeFallbackBinary: vi.fn(() => Promise.resolve({ status: 'unknown', version: null })),
  probeModelCatalog: vi.fn(() => Promise.resolve({ status: 'unknown', suggestion: null })),
}));

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';
import { emitAlert } from '../../../src/lib/emit-alert.ts';

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

function makeRuntime(): AgentRuntime {
  const config = mockConfigRef();
  config['agentProvider'] = 'claude-cli';
  config['agentFallbackProvider'] = 'opencode-cli';
  config['agentFallbackModel'] = 'minimax/minimax-m2';
  return new AgentRuntime(makeDb(), makeMessenger(), 'test', {
    model: 'claude-opus-4-8[1m]',
  });
}

function makeFakeQueue() {
  return {
    targetChatJid: 'fake@s.whatsapp.net',
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

type RuntimeView = {
  activateProviderFallback(resetAt: Date | null): void;
  handleEventWithContext(
    event: unknown,
    queue: unknown,
    session: unknown,
    conversationKey?: string,
    inboundSeq?: number,
    mapKey?: string,
    toolScopeKey?: string,
    isSystemResult?: boolean,
  ): void;
};

function v(runtime: AgentRuntime): RuntimeView {
  return runtime as unknown as RuntimeView;
}

describe('fallback empty-turn suppression when turn had tool work', () => {
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

  it('tool_use then empty result during active fallback: no notice, no counter', () => {
    // RED: before the fix this test fails because the notice is fired and the
    // counter is incremented regardless of tool activity.
    const runtime = makeRuntime();
    v(runtime).activateProviderFallback(null);

    const queue = makeFakeQueue();
    const mapKey = 'mapkey-tool';
    // Drive a tool_use event — this is what send_message/send_media would produce.
    v(runtime).handleEventWithContext(
      { type: 'tool_use', toolId: 'tid1', toolName: 'send_message', toolInput: {} },
      queue,
      null,
      'conv',
      1,
      mapKey,
    );
    // Result with no text — the entire reply was the tool send.
    v(runtime).handleEventWithContext(
      { type: 'result', text: null },
      queue,
      null,
      'conv',
      1,
      mapKey,
    );

    // Turn was served but NOT counted as empty — tool activity was the reply.
    expect(runtime.getFallbackState().fallbackTurnsServed).toBe(1);
    expect(runtime.getFallbackState().fallbackTurnsEmpty).toBe(0);
    // Arming fallback emits exactly the activation alert — no fallback_empty_turn.
    expect(vi.mocked(emitAlert).mock.calls.map((c) => c[1])).toEqual(['provider_fallback_activated']);
    expect(queue.enqueueText).not.toHaveBeenCalledWith(
      expect.stringContaining('no reply'),
    );
  });

  it('no tool_use and no text during active fallback: notice fired, counter incremented', () => {
    // Genuinely empty fallback turn — must still trigger the signal.
    const runtime = makeRuntime();
    v(runtime).activateProviderFallback(null);

    const queue = makeFakeQueue();
    v(runtime).handleEventWithContext(
      { type: 'result', text: null },
      queue,
      null,
      'conv',
      1,
      'mapkey-empty',
    );

    expect(runtime.getFallbackState().fallbackTurnsServed).toBe(1);
    expect(runtime.getFallbackState().fallbackTurnsEmpty).toBe(1);
    expect(vi.mocked(emitAlert)).toHaveBeenCalledWith(
      'test',
      'fallback_empty_turn',
      expect.any(String),
      expect.stringContaining('chat=fake@s.whatsapp.net'),
    );
    expect(queue.enqueueText).toHaveBeenCalledWith(
      expect.stringContaining('no reply'),
    );
  });

  it('tool activity flag is reset between turns (second turn without tool still triggers notice)', () => {
    // Verify the tool-activity flag is scoped per turn, not cumulative.
    const runtime = makeRuntime();
    v(runtime).activateProviderFallback(null);

    const queue = makeFakeQueue();

    // First turn: tool work → no notice.
    v(runtime).handleEventWithContext(
      { type: 'tool_use', toolId: 'tid2', toolName: 'send_message', toolInput: {} },
      queue,
      null,
      'conv',
      1,
      'mapkey-t1',
    );
    v(runtime).handleEventWithContext(
      { type: 'result', text: null },
      queue,
      null,
      'conv',
      1,
      'mapkey-t1',
    );
    expect(runtime.getFallbackState().fallbackTurnsEmpty).toBe(0);

    // Second turn on different mapKey: genuinely empty → notice must fire.
    // (Each per_chat scope has its own tool-activity tracking.)
    v(runtime).handleEventWithContext(
      { type: 'result', text: null },
      queue,
      null,
      'conv',
      2,
      'mapkey-t2',
    );
    expect(runtime.getFallbackState().fallbackTurnsEmpty).toBe(1);
    expect(queue.enqueueText).toHaveBeenCalledWith(
      expect.stringContaining('no reply'),
    );
  });

  it('tool activity flag is reset on result so SAME mapKey second turn without tool fires notice', () => {
    // Mutation survivor pin: the delete at runtime.ts line ~4482 clears the Set
    // entry for toolScopeKey on result. Without that delete the flag persists
    // across turns for the same mapKey, permanently suppressing future notices.
    // This test uses the SAME mapKey for both turns to catch the mutation.
    const runtime = makeRuntime();
    v(runtime).activateProviderFallback(null);

    const queue = makeFakeQueue();
    const SHARED_MAP_KEY = 'mapkey-same-scope';

    // Turn 1: tool work on SHARED_MAP_KEY → suppressed (no notice, no counter).
    v(runtime).handleEventWithContext(
      { type: 'tool_use', toolId: 'tid-reset-1', toolName: 'send_message', toolInput: {} },
      queue,
      null,
      'conv',
      1,
      SHARED_MAP_KEY,
    );
    v(runtime).handleEventWithContext(
      { type: 'result', text: null },
      queue,
      null,
      'conv',
      1,
      SHARED_MAP_KEY,
    );
    expect(runtime.getFallbackState().fallbackTurnsServed).toBe(1);
    expect(runtime.getFallbackState().fallbackTurnsEmpty).toBe(0);

    // Turn 2: NO tool_use on the SAME mapKey → the reset must have cleared the
    // flag; this genuinely-empty turn MUST fire the notice.
    v(runtime).handleEventWithContext(
      { type: 'result', text: null },
      queue,
      null,
      'conv',
      2,
      SHARED_MAP_KEY,
    );
    expect(runtime.getFallbackState().fallbackTurnsServed).toBe(2);
    expect(runtime.getFallbackState().fallbackTurnsEmpty).toBe(1);
    expect(vi.mocked(emitAlert)).toHaveBeenCalledWith(
      'test',
      'fallback_empty_turn',
      expect.any(String),
      expect.stringContaining('chat=fake@s.whatsapp.net'),
    );
    expect(queue.enqueueText).toHaveBeenCalledWith(
      expect.stringContaining('no reply'),
    );
  });
});
