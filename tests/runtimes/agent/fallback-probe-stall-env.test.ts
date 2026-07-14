/**
 * WHATSOUP_PROVIDER_FALLBACK_PROBE_STALL_THRESHOLD env tunability + clamping.
 *
 * The threshold is a module-level constant read at import time, so this file
 * sets the env var via vi.hoisted (before runtime.ts evaluates) and runs in
 * its own forked worker. Value '1' is below the [3, 100] clamp floor → the
 * effective threshold must be 3.
 *
 * Harness mirrors fallback-probe-stall.test.ts (see that file for rationale).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.hoisted(() => {
  process.env['WHATSOUP_PROVIDER_FALLBACK_PROBE_STALL_THRESHOLD'] = '1';
});

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
    agentFallbackProvider: 'opencode-cli',
    agentFallbackModel: 'minimax/MiniMax-M2.7',
  };
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

vi.mock('../../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/keyring.ts')>();
  return {
    ...actual,
    lookupCredential: () => 'present-key',
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
import { emitAlert } from '../../../src/lib/emit-alert.ts';

const RECHECK_MS = 5 * 60 * 1000;

type FallbackView = {
  fallbackProbeAttempts: number;
  probePrimaryProviderRecovered(): boolean | Promise<boolean>;
  activateProviderFallback(
    resetAt: Date | null,
    reason?: 'usage-limit' | 'rate-limit' | 'auth-required',
  ): unknown;
};

function makeRuntime(): AgentRuntime {
  const db = {
    assertWritableCompatibility: vi.fn(),
    raw: { prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn() })), exec: vi.fn() },
  } as unknown as Database;
  const messenger = {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  } as unknown as Messenger;
  return new AgentRuntime(db, messenger, 'test', { model: 'claude-opus-4-8[1m]' });
}

function stallAlerts(): unknown[][] {
  return vi.mocked(emitAlert).mock.calls.filter((c) => c[1] === 'fallback_recovery_stalled');
}

describe('AgentRuntime — probe stall threshold env clamping', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T10:00:00Z'));
    vi.mocked(emitAlert).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('clamps a sub-floor env value (1) up to 3: alert at attempt 3, not at 1 or 2', async () => {
    const runtime = makeRuntime();
    const v = runtime as unknown as FallbackView;
    v.probePrimaryProviderRecovered = vi.fn(() => false);
    v.activateProviderFallback(new Date(Date.now() + 1000), 'auth-required'); // clamps to +1 min

    await vi.advanceTimersByTimeAsync(60 * 1000 + 1); // attempt 1
    expect(v.fallbackProbeAttempts).toBe(1);
    expect(stallAlerts()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(RECHECK_MS); // attempt 2
    expect(stallAlerts()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(RECHECK_MS); // attempt 3 → clamped threshold reached
    expect(v.fallbackProbeAttempts).toBe(3);
    expect(stallAlerts()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(RECHECK_MS); // attempt 4 → no re-alert
    expect(stallAlerts()).toHaveLength(1);
  });
});
