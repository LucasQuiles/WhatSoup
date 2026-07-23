/**
 * WHATSOUP_PROVIDER_FALLBACK_PROBE_STALL_CEILING_MULTIPLE env tunability
 * (DUR-02 bounded escalation).
 *
 * Beyond T * ceilingMultiple consecutive failed extension probes, the alert
 * AT the ceiling carries `ceiling=true` and no FURTHER re-alerts fire for the
 * rest of the episode — repeating an indistinguishable alert forever is
 * exactly what the ceiling exists to stop. Threshold '3' is the SMALLEST
 * value the clamp accepts as-is (WHATSOUP_PROVIDER_FALLBACK_PROBE_STALL_THRESHOLD
 * floors at 3 — see fallback-probe-stall-env.test.ts); ceiling multiple 2
 * keeps this cheap: ceiling attempts = 6.
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

  it('re-alerts at T(3) and 2T(6, the ceiling — marked ceiling=true), then stops repeating past the ceiling', async () => {
    const runtime = makeRuntime();
    const v = runtime as unknown as FallbackView;
    v.probePrimaryProviderRecovered = vi.fn(() => false);
    v.activateProviderFallback(new Date(Date.now() + 1000), 'auth-required'); // clamps to +1 min

    await vi.advanceTimersByTimeAsync(60 * 1000 + 1); // attempt 1
    expect(stallAlerts()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(RECHECK_MS); // attempt 2
    expect(stallAlerts()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(RECHECK_MS); // attempt 3 = T
    expect(v.fallbackProbeAttempts).toBe(3);
    const atT = stallAlerts();
    expect(atT).toHaveLength(1);
    const [, , , evidenceAtT] = atT[0] as [string, string, string, string];
    expect(evidenceAtT).toContain('attempts=3');
    expect(evidenceAtT).not.toContain('ceiling=true');

    await vi.advanceTimersByTimeAsync(RECHECK_MS); // attempt 4 — not a multiple of T
    await vi.advanceTimersByTimeAsync(RECHECK_MS); // attempt 5 — not a multiple of T
    expect(stallAlerts()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(RECHECK_MS); // attempt 6 = 2T = ceiling
    expect(v.fallbackProbeAttempts).toBe(6);
    const atCeiling = stallAlerts();
    expect(atCeiling).toHaveLength(2);
    const [, , , evidenceAtCeiling] = atCeiling[1] as [string, string, string, string];
    expect(evidenceAtCeiling).toContain('ceiling=true');
    expect(evidenceAtCeiling).toContain('attempts=6');

    // Attempts 7, 8, 9 (=3T, still a threshold multiple but past the
    // ceiling): no further re-alerts — the ceiling alert already marked the
    // state change, repeating it forever would be exactly the noise DUR-02
    // forbids.
    await vi.advanceTimersByTimeAsync(RECHECK_MS); // attempt 7
    await vi.advanceTimersByTimeAsync(RECHECK_MS); // attempt 8
    await vi.advanceTimersByTimeAsync(RECHECK_MS); // attempt 9 = 3T
    expect(v.fallbackProbeAttempts).toBe(9);
    expect(stallAlerts()).toHaveLength(2);

    // The window still extends — the ceiling surfaces the state change, it
    // never strands the instance on a dead primary.
    expect((v as unknown as { fallbackWindow: { activeUntil: number | null } }).fallbackWindow.activeUntil).not.toBeNull();
  });
});
