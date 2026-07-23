/**
 * FallbackRecoveryTransaction wiring into AgentRuntime (DUR-02).
 *
 * The decisive falsifier this file exists for: a stall state — a probe has
 * succeeded (recovered=true), `fallbackProbeAttempts > 0`, and the instance
 * had previously raised a `fallback_recovery_stalled` alert — must, in ONE
 * transaction, (1) revert the route, (2) clear BOTH the activation incident
 * AND the stall incident (the live CATEGORY-C defect: the stall incident was
 * never cleared anywhere in the codebase before this change), (3) persist an
 * immutable receipt carrying the reused usability evidence, and (4) reset
 * `fallbackProbeAttempts` only AFTER that receipt is durably emitted. A
 * manual/window-elapsed deactivation (no probe-confirmed receipt) must NOT
 * clear the stall incident — that would be a false "recovery confirmed"
 * claim. A strictly-pinned chat must remain on its own pin after an
 * instance-default revert.
 *
 * Harness mirrors fallback-probe-stall.test.ts (fake timers, mocked
 * emitAlert, mocked credential/binary preflights, instance-level probe spy).
 * This file additionally uses a REAL temp-file Database for the strict-pin
 * test — chat_model_preference reads must exercise real SQL, not a stub.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

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
    nlRouting: true,
    nlRoutingTiers: null,
  };
  (globalThis as Record<string, unknown>)['__transactionTestConfig__'] = config;
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

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';
import { emitAlert, clearAlertSource } from '../../../src/lib/emit-alert.ts';
import { ensureChatPreferenceSchema, setPreference } from '../../../src/runtimes/agent/chat-preference-db.ts';
import { ensureFallbackStateSchema } from '../../../src/runtimes/agent/fallback-state-db.ts';
import type { FallbackRecoveryEvidence } from '../../../src/runtimes/agent/fallback-recovery-transaction.ts';

function mockConfigRef(): Record<string, unknown> {
  return (globalThis as Record<string, unknown>)['__transactionTestConfig__'] as Record<string, unknown>;
}

const RECHECK_MS = 5 * 60 * 1000;
const STALL_THRESHOLD = 12;

function usableEvidence(): FallbackRecoveryEvidence {
  return { status: 'usable', provider: 'claude-cli', model: null, checkedAt: Date.now() };
}
function unusableEvidence(): FallbackRecoveryEvidence {
  return { status: 'model-unavailable', provider: 'claude-cli', model: null, checkedAt: Date.now() };
}

/**
 * probePrimaryProviderRecovered's real contract: an optional onEvidence
 * callback receiving the FULL result, resolving to the collapsed boolean.
 * Wrapping a factory this way lets tests swap behavior via
 * `probe.mockImplementation(probeImpl(otherFactory))`, mirroring the
 * `probe.mockReturnValue`/`mockImplementation` swap idiom used elsewhere in
 * this suite.
 */
function probeImpl(factory: () => FallbackRecoveryEvidence) {
  return (onEvidence?: (e: FallbackRecoveryEvidence) => void): Promise<boolean> => {
    const e = factory();
    onEvidence?.(e);
    return Promise.resolve(e.status === 'usable');
  };
}

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  } as unknown as Messenger;
}

let dbPath: string;
let realDb: Database;

function makeRuntime(db: Database): AgentRuntime {
  const config = mockConfigRef();
  config['agentProvider'] = 'claude-cli';
  config['agentProviderConfig'] = undefined;
  config['agentFallbackProvider'] = 'opencode-cli';
  config['agentFallbackModel'] = 'minimax/MiniMax-M2.7';
  return new AgentRuntime(db, makeMessenger(), 'test', {
    model: 'claude-opus-4-8[1m]',
  });
}

type FallbackView = {
  fallbackWindow: { activeUntil: number | null };
  fallbackProbeAttempts: number;
  effectiveProvider: string;
  probePrimaryProviderRecovered(onEvidence?: (e: FallbackRecoveryEvidence) => void): boolean | Promise<boolean>;
  activateProviderFallback(
    resetAt: Date | null,
    reason?: 'usage-limit' | 'rate-limit' | 'auth-required' | 'server-error',
  ): unknown;
  deactivateProviderFallback(reason: string): void;
  resolveRouteForTurn(chatJid: string, actorJid?: string): { provider: string; model: string | undefined; source: string };
};

function view(runtime: AgentRuntime): FallbackView {
  return runtime as unknown as FallbackView;
}

function alertsFor(source: string): unknown[][] {
  return vi.mocked(emitAlert).mock.calls.filter((c) => c[1] === source);
}
function clearsFor(source: string): unknown[][] {
  return vi.mocked(clearAlertSource).mock.calls.filter((c) => c[1] === source);
}

async function enterExtensionPhase(v: FallbackView, probe: ReturnType<typeof vi.fn>): Promise<void> {
  v.probePrimaryProviderRecovered = probe as unknown as () => boolean;
  v.activateProviderFallback(new Date(Date.now() + 1000), 'auth-required'); // clamps to +1 min
  await vi.advanceTimersByTimeAsync(60 * 1000 + 1);
}

describe('AgentRuntime — FallbackRecoveryTransaction wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T10:00:00Z'));
    vi.mocked(emitAlert).mockClear();
    vi.mocked(clearAlertSource).mockClear();
    lookupCredentialMock.mockReturnValue('present-key');
    dbPath = join(tmpdir(), `dur02-transaction-test-${randomBytes(6).toString('hex')}.db`);
    realDb = new Database(dbPath);
    ensureFallbackStateSchema(realDb);
  });
  afterEach(() => {
    vi.useRealTimers();
    realDb.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const fp = dbPath + suffix;
      if (existsSync(fp)) unlinkSync(fp);
    }
  });

  it('dual-clears BOTH fallback_recovery_stalled and provider_fallback_activated on a probe-confirmed revert past the stall threshold', async () => {
    const runtime = makeRuntime(realDb);
    const v = view(runtime);
    const probe = vi.fn(probeImpl(unusableEvidence));
    await enterExtensionPhase(v, probe);
    for (let attempt = 2; attempt <= STALL_THRESHOLD; attempt++) {
      await vi.advanceTimersByTimeAsync(RECHECK_MS);
    }
    expect(alertsFor('fallback_recovery_stalled')).toHaveLength(1);
    expect(clearsFor('fallback_recovery_stalled')).toHaveLength(0);

    probe.mockImplementation(probeImpl(usableEvidence));
    await vi.advanceTimersByTimeAsync(RECHECK_MS);

    expect(v.effectiveProvider).toBe('claude-cli');
    expect(clearsFor('fallback_recovery_stalled')).toHaveLength(1);
    expect(clearsFor('provider_fallback_activated')).toHaveLength(1);
  });

  it('probe-only (recovered=true but no confirmed canary) never reaches the clear — commit requires the full evaluated decision', async () => {
    // Regression guard for "never on the probe alone": a mismatched-target
    // evidence sample must NOT revert or clear anything, even though a naive
    // boolean read of a legacy probe would have been truthy.
    const runtime = makeRuntime(realDb);
    const v = view(runtime);
    const mismatched = vi.fn(probeImpl(() => ({
      status: 'usable',
      provider: 'opencode-cli', // wrong target — does not match agentProvider
      model: null,
      checkedAt: Date.now(),
    })));
    await enterExtensionPhase(v, mismatched);

    expect(v.effectiveProvider).toBe('opencode-cli'); // still on fallback
    expect(alertsFor('provider_fallback_reverted')).toHaveLength(0);
    expect(clearsFor('fallback_recovery_stalled')).toHaveLength(0);
    expect(clearsFor('provider_fallback_activated')).toHaveLength(0);
  });

  it('persists the receipt (enriched provider_fallback_reverted evidence) BEFORE fallbackProbeAttempts resets to 0', async () => {
    const runtime = makeRuntime(realDb);
    const v = view(runtime);
    const probe = vi.fn(probeImpl(unusableEvidence));
    await enterExtensionPhase(v, probe);
    await vi.advanceTimersByTimeAsync(RECHECK_MS); // attempt 2
    expect(v.fallbackProbeAttempts).toBe(2);

    probe.mockImplementation(probeImpl(usableEvidence));
    await vi.advanceTimersByTimeAsync(RECHECK_MS);

    const reverted = alertsFor('provider_fallback_reverted');
    expect(reverted).toHaveLength(1);
    const [, , , evidence] = reverted[0] as [string, string, string, string];
    // The receipt carries probe_attempts=<the count BEFORE reset — the 2
    // failed probes at attempts 1 and 2, read at evaluation time before the
    // successful 3rd attempt's commit path touches the counter at all>,
    // proving the reset (fallbackProbeAttempts is 0 by the time this
    // assertion runs) did not lose the count — it was captured into the
    // receipt first.
    expect(evidence).toContain('probe_attempts=2');
    expect(evidence).toContain('canary=passed');
    expect(evidence).toContain('from_provider=opencode-cli');
    expect(evidence).toContain('to_provider=claude-cli');
    expect(evidence).toContain('evidence_status=usable');
    expect(v.fallbackProbeAttempts).toBe(0);
  });

  it('crash-safe ordering: durable receipt + both clears fire even when the persisted-window DB clear throws', async () => {
    const runtime = makeRuntime(realDb);
    const v = view(runtime);
    const probe = vi.fn(probeImpl(unusableEvidence));
    await enterExtensionPhase(v, probe);
    for (let attempt = 2; attempt <= STALL_THRESHOLD; attempt++) {
      await vi.advanceTimersByTimeAsync(RECHECK_MS);
    }
    expect(alertsFor('fallback_recovery_stalled')).toHaveLength(1);

    // Simulate a crash-adjacent failure in the LAST step of
    // deactivateProviderFallback (the persisted-window DB clear) — a broken
    // sqlite handle, disk full, etc. If durable emission ordering is correct,
    // every alert/clear above this call already fired and is unaffected.
    realDb.close();

    probe.mockImplementation(probeImpl(usableEvidence));
    await vi.advanceTimersByTimeAsync(RECHECK_MS);

    expect(clearsFor('fallback_recovery_stalled')).toHaveLength(1);
    expect(clearsFor('provider_fallback_activated')).toHaveLength(1);
    expect(alertsFor('provider_fallback_reverted')).toHaveLength(1);
  });

  it('a manual deactivation never clears fallback_recovery_stalled — no receipt means no "recovery confirmed" claim', async () => {
    const runtime = makeRuntime(realDb);
    const v = view(runtime);
    const probe = vi.fn(probeImpl(unusableEvidence));
    await enterExtensionPhase(v, probe);
    await vi.advanceTimersByTimeAsync(RECHECK_MS);

    v.deactivateProviderFallback('admin-disabled');

    expect(clearsFor('fallback_recovery_stalled')).toHaveLength(0);
    expect(clearsFor('provider_fallback_activated')).toHaveLength(1);
    const reverted = alertsFor('provider_fallback_reverted');
    expect(reverted).toHaveLength(1);
    const [, , , evidence] = reverted[0] as [string, string, string, string];
    expect(evidence).not.toContain('canary=passed');
  });

  it('a strictly-pinned chat is unaffected by an instance-default revert — resolveRouteForTurn still honors the pin', async () => {
    ensureChatPreferenceSchema(realDb);
    const chatJid = '15550001111@s.whatsapp.net';
    const senderJid = '15550002222@s.whatsapp.net';
    setPreference(realDb, {
      chatJid,
      senderJid,
      intent: 'provider_specific',
      requestedProvider: 'opencode-cli',
      scope: 'sticky',
      pinStrict: true,
      fallbackPermitted: false,
      updatedAt: Date.now(),
      expiresAt: null,
      requestedModel: null,
      validatedProvider: null,
      modelPinVerified: null,
      requestedEffort: null,
    });

    const runtime = makeRuntime(realDb);
    const v = view(runtime);

    // Before any instance-level fallback activity, the pin already routes
    // this chat to opencode-cli regardless of the instance default.
    expect(v.resolveRouteForTurn(chatJid, senderJid).provider).toBe('opencode-cli');

    // Drive an instance-default fallback episode through to a probe-confirmed
    // revert (the transaction under test).
    const probe = vi.fn(probeImpl(unusableEvidence));
    await enterExtensionPhase(v, probe);
    for (let attempt = 2; attempt <= STALL_THRESHOLD; attempt++) {
      await vi.advanceTimersByTimeAsync(RECHECK_MS);
    }
    probe.mockImplementation(probeImpl(usableEvidence));
    await vi.advanceTimersByTimeAsync(RECHECK_MS);
    expect(v.effectiveProvider).toBe('claude-cli'); // instance-default reverted

    // The strictly-pinned chat is untouched — the transaction never read or
    // wrote chat_model_preference, so its route resolution is identical to
    // before the instance-level episode.
    expect(v.resolveRouteForTurn(chatJid, senderJid).provider).toBe('opencode-cli');
  });
});
