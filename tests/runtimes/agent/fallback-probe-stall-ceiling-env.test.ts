/**
 * WHATSOUP_PROVIDER_FALLBACK_PROBE_STALL_CEILING_MULTIPLE env tunability
 * (DUR-02 bounded escalation).
 *
 * S5 (QUALITY-PASS-2120-transaction.md): the cadence table (T, 2T, ceiling,
 * post-ceiling silence) is now covered by pure `stallAlertPlan` unit tests in
 * fallback-recovery-transaction.test.ts, since threshold/ceilingMultiple are
 * ordinary parameters, not module-hidden env globals. This file is now ONLY
 * the thin env-clamp check: does runtime.ts actually read the env var and
 * pass the resulting value through to a real ceiling alert end-to-end.
 *
 * Harness mirrors fallback-probe-stall-env.test.ts (module-level constants
 * read at import time via vi.hoisted, own forked worker).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.hoisted(() => {
  process.env['WHATSOUP_PROVIDER_FALLBACK_PROBE_STALL_THRESHOLD'] = '3';
  process.env['WHATSOUP_PROVIDER_FALLBACK_PROBE_STALL_CEILING_MULTIPLE'] = '2';
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

describe('AgentRuntime — probe stall escalation ceiling env clamping', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T10:00:00Z'));
    vi.mocked(emitAlert).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('WHATSOUP_PROVIDER_FALLBACK_PROBE_STALL_CEILING_MULTIPLE=2 with threshold=3 reaches ceiling=true at attempt 6, end to end through real timers', async () => {
    const runtime = makeRuntime();
    const v = runtime as unknown as FallbackView;
    v.probePrimaryProviderRecovered = vi.fn(() => false);
    v.activateProviderFallback(new Date(Date.now() + 1000), 'auth-required'); // clamps to +1 min

    for (let attempt = 1; attempt < 6; attempt++) {
      await vi.advanceTimersByTimeAsync(attempt === 1 ? 60 * 1000 + 1 : RECHECK_MS);
    }
    expect(v.fallbackProbeAttempts).toBe(5);
    expect(stallAlerts().some((c) => (c[3] as string).includes('ceiling=true'))).toBe(false);

    await vi.advanceTimersByTimeAsync(RECHECK_MS); // attempt 6 = 2 * 3 = the configured ceiling
    expect(v.fallbackProbeAttempts).toBe(6);
    const atCeiling = stallAlerts().at(-1) as [string, string, string, string];
    expect(atCeiling[3]).toContain('ceiling=true');
    expect(atCeiling[3]).toContain('attempts=6');
  });
});
