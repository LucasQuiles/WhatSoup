/**
 * Primary recovery probe must reflect credential VALIDITY, not mere presence.
 *
 * Root cause: an expired-but-present claude-cli OAuth token makes
 * `claude auth status --json` report {loggedIn:true} while live
 * inference returns 401 Invalid authentication credentials. The recovery probe
 * trusted `auth status`, so it reported "recovered" and reverted the fallback
 * window onto a dead primary — producing a revert→401→fallback flap.
 *
 * These tests pin the contract: probePrimaryProviderRecovered reports recovery
 * for a binary primary IFF a real model-usability probe returns 'usable'. Every
 * non-usable status (credential-unavailable / timeout / model-unavailable /
 * provider-unavailable / unknown) is NOT recovered. Keyed primaries keep their
 * key-presence semantics; a missing binary is not recovered.
 *
 * Harness mirrors fallback-probe-stall.test.ts (mocked alerts/config/mcp; real
 * runtime; module-level seams for keyring, session binary resolver, the
 * usability probe, and the legacy auth-status path).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrimaryModelUsabilityResult, PrimaryModelUsabilityStatus } from '../../../src/runtimes/agent/providers/primary-model-usability.ts';

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
    elevenlabs: { defaultVoiceId: 'v', defaultModel: 'eleven_multilingual_v2', stability: 0.5, similarityBoost: 0.75 },
    agentMaxQueueDepth: 25,
    agentProvider: 'claude-cli',
    agentProviderConfig: undefined,
    agentFallbackProvider: 'opencode-cli',
    agentFallbackModel: 'minimax/MiniMax-M2.7',
  };
  (globalThis as Record<string, unknown>)['__recoveryProbeTestConfig__'] = config;
  return { config };
});

function mockConfigRef(): Record<string, unknown> {
  return (globalThis as Record<string, unknown>)['__recoveryProbeTestConfig__'] as Record<string, unknown>;
}

vi.mock('../../../src/mcp/register-all.ts', () => ({ registerAllTools: vi.fn() }));
vi.mock('../../../src/mcp/registry.ts', () => ({
  ToolRegistry: class {
    register = vi.fn();
    listTools = vi.fn(() => []);
    call = vi.fn();
    getChatScopedToolNames = vi.fn(() => []);
    setDurability = vi.fn();
  },
}));

// keyring: keep the real resolveProviderKeyService (driven via agentProvider),
// override only the credential lookup so keyed-provider recovery is deterministic.
const lookupCredentialMock = vi.fn<(service: string) => string | null>(() => 'present-key');
vi.mock('../../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/keyring.ts')>();
  return { ...actual, lookupCredential: (service: string) => lookupCredentialMock(service) };
});

// session: override only the binary resolver.
const getProviderBinaryMock = vi.fn<(provider: string) => string | null>(() => 'claude');
vi.mock('../../../src/runtimes/agent/session.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/runtimes/agent/session.ts')>();
  return { ...actual, getProviderBinary: (provider: string) => getProviderBinaryMock(provider) };
});

// binary-preflight: the legacy auth-status path must report a present, "logged in"
// credential — proving the fixed probe does NOT consult it for binary primaries.
const probeBinaryAuthStatusMock = vi.fn(async () => ({ status: 'ok' as const, output: '{"loggedIn":true,"subscriptionType":"max"}' }));
vi.mock('../../../src/runtimes/agent/providers/binary-preflight.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/runtimes/agent/providers/binary-preflight.ts')>();
  return {
    ...actual,
    probeFallbackBinary: vi.fn(async () => ({ status: 'unknown', version: null })),
    probeModelCatalog: vi.fn(async () => ({ status: 'unknown', suggestion: null })),
    probeBinaryAuthStatus: (...args: unknown[]) => probeBinaryAuthStatusMock(...(args as [])),
  };
});

vi.mock('../../../src/runtimes/agent/providers/credential-verify.ts', () => ({
  verifyFallbackCredential: vi.fn(async () => 'unknown'),
}));

// the usability probe — the validity signal recovery must follow. Mocks forward
// their call arguments so tests can assert the runtime passes the intended
// target/config (behavior), not merely that a branch executed.
const probePrimaryModelUsabilityMock = vi.fn<(...args: unknown[]) => Promise<PrimaryModelUsabilityResult>>();
vi.mock('../../../src/runtimes/agent/providers/primary-model-usability.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/runtimes/agent/providers/primary-model-usability.ts')>();
  return { ...actual, probePrimaryModelUsability: (...args: unknown[]) => probePrimaryModelUsabilityMock(...args) };
});
const createAdaptersMock = vi.fn<(...args: unknown[]) => Record<string, unknown>>(() => ({}));
vi.mock('../../../src/runtimes/agent/providers/primary-model-usability-adapters.ts', () => ({
  createPrimaryModelProbeAdapters: (...args: unknown[]) => createAdaptersMock(...args),
}));

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';

function makeDb(): Database {
  return {
    assertWritableCompatibility: vi.fn(),
    raw: { prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn() })), exec: vi.fn() },
  } as unknown as Database;
}
function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  } as unknown as Messenger;
}

type RecoveryView = {
  probePrimaryProviderRecovered(): Promise<boolean>;
  activateProviderFallback(
    resetAt: Date | null,
    reason?: 'usage-limit' | 'rate-limit' | 'auth-required' | 'model-unavailable' | 'server-error' | 'empty-output' | 'probe-unusable',
  ): unknown;
};

function makeRuntime(provider: string): AgentRuntime {
  const config = mockConfigRef();
  config['agentProvider'] = provider;
  config['agentProviderConfig'] = undefined;
  return new AgentRuntime(makeDb(), makeMessenger(), 'test', { model: 'claude-opus-4-8[1m]' }) as AgentRuntime;
}
function view(runtime: AgentRuntime): RecoveryView {
  return runtime as unknown as RecoveryView;
}
function usability(status: PrimaryModelUsabilityStatus): PrimaryModelUsabilityResult {
  return { status, provider: 'claude-cli', model: 'claude-opus-4-8[1m]' };
}

describe('AgentRuntime.probePrimaryProviderRecovered — validity, not presence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lookupCredentialMock.mockReturnValue('present-key');
    getProviderBinaryMock.mockReturnValue('claude');
    probeBinaryAuthStatusMock.mockResolvedValue({ status: 'ok', output: '{"loggedIn":true,"subscriptionType":"max"}' });
  });

  it('binary primary: recovered when the model-usability probe is usable', async () => {
    probePrimaryModelUsabilityMock.mockResolvedValue(usability('usable'));
    const v = view(makeRuntime('claude-cli'));
    await expect(v.probePrimaryProviderRecovered()).resolves.toBe(true);
  });

  it('binary primary: NOT recovered on credential-unavailable (the expired-token flap)', async () => {
    probePrimaryModelUsabilityMock.mockResolvedValue(usability('credential-unavailable'));
    const v = view(makeRuntime('claude-cli'));
    await expect(v.probePrimaryProviderRecovered()).resolves.toBe(false);
  });

  // Non-happy paths: every non-usable status is NOT recovery.
  for (const status of ['timeout', 'model-unavailable', 'provider-unavailable', 'unknown'] as PrimaryModelUsabilityStatus[]) {
    it(`binary primary: NOT recovered on '${status}'`, async () => {
      probePrimaryModelUsabilityMock.mockResolvedValue(usability(status));
      const v = view(makeRuntime('claude-cli'));
      await expect(v.probePrimaryProviderRecovered()).resolves.toBe(false);
    });
  }

  it('binary primary: does NOT consult `auth status` (presence) — routes through the usability probe', async () => {
    probePrimaryModelUsabilityMock.mockResolvedValue(usability('credential-unavailable'));
    const v = view(makeRuntime('claude-cli'));
    await v.probePrimaryProviderRecovered();
    expect(probePrimaryModelUsabilityMock).toHaveBeenCalledTimes(1);
    expect(probeBinaryAuthStatusMock).not.toHaveBeenCalled();
  });

  it('binary primary: uses the runtime cwd for the probe when set', async () => {
    probePrimaryModelUsabilityMock.mockResolvedValue(usability('usable'));
    const config = mockConfigRef();
    config['agentProvider'] = 'claude-cli';
    config['agentProviderConfig'] = undefined;
    const runtime = new AgentRuntime(makeDb(), makeMessenger(), 'test', { model: 'claude-opus-4-8[1m]', cwd: '/tmp/whatsoup-recovery-cwd' }) as AgentRuntime;
    const v = view(runtime);
    await expect(v.probePrimaryProviderRecovered()).resolves.toBe(true);
    expect(createAdaptersMock).toHaveBeenCalledWith(undefined, expect.objectContaining({
      cwd: '/tmp/whatsoup-recovery-cwd',
      egressProxyPort: undefined,
      providerExecutionGate: expect.anything(),
    }));
  });

  it('binary primary: tolerates an unset model (coalesces to null) and follows usability', async () => {
    probePrimaryModelUsabilityMock.mockResolvedValue(usability('usable'));
    const config = mockConfigRef();
    config['agentProvider'] = 'claude-cli';
    config['agentProviderConfig'] = undefined;
    const runtime = new AgentRuntime(makeDb(), makeMessenger(), 'test', {}) as AgentRuntime;
    const v = view(runtime);
    await expect(v.probePrimaryProviderRecovered()).resolves.toBe(true);
    expect(probePrimaryModelUsabilityMock).toHaveBeenCalledWith({ provider: 'claude-cli', model: null }, expect.anything());
  });

  it('binary primary: does NOT consult the binary resolver — recovery follows the usability probe', async () => {
    // QR-048: binary presence is never a recovery signal. The resolver is not
    // consulted; a non-usable probe is NOT recovered even if a binary resolves.
    getProviderBinaryMock.mockReturnValue(null);
    probePrimaryModelUsabilityMock.mockResolvedValue(usability('credential-unavailable'));
    const v = view(makeRuntime('claude-cli'));
    await expect(v.probePrimaryProviderRecovered()).resolves.toBe(false);
    expect(getProviderBinaryMock).not.toHaveBeenCalled();
    expect(probePrimaryModelUsabilityMock).toHaveBeenCalledTimes(1);
  });

  it('binary primary: never rejects — the never-throws contract rests on the probe, not the binary resolver', async () => {
    // QR-048: the resolver is no longer on the recovery path, so a throwing
    // resolver can not break the never-rejects contract; recovery follows the probe.
    getProviderBinaryMock.mockImplementation(() => { throw new Error('unknown provider'); });
    probePrimaryModelUsabilityMock.mockResolvedValue(usability('usable'));
    const v = view(makeRuntime('claude-cli'));
    await expect(v.probePrimaryProviderRecovered()).resolves.toBe(true);
    expect(getProviderBinaryMock).not.toHaveBeenCalled();
    expect(probePrimaryModelUsabilityMock).toHaveBeenCalledTimes(1);
  });

  it('keyed primary: recovered ONLY when the usability probe is usable, not from credential presence', async () => {
    // QR-048: a present key is never sufficient — the probe always runs and its
    // result is the recovery signal.
    lookupCredentialMock.mockReturnValue('sk-present');
    probePrimaryModelUsabilityMock.mockResolvedValue({
      status: 'usable',
      provider: 'anthropic-api',
      model: 'claude-opus-4-8[1m]',
    });
    const v = view(makeRuntime('anthropic-api'));
    await expect(v.probePrimaryProviderRecovered()).resolves.toBe(true);
    expect(probePrimaryModelUsabilityMock).toHaveBeenCalledTimes(1);
  });

  it('keyed primary: present key but non-usable probe is NOT recovered (presence never shortcuts)', async () => {
    // QR-048: guards the expired-key flap — key present, probe says credential
    // unavailable, recovery must be false.
    lookupCredentialMock.mockReturnValue('sk-present');
    probePrimaryModelUsabilityMock.mockResolvedValue({
      status: 'credential-unavailable',
      provider: 'anthropic-api',
      model: 'claude-opus-4-8[1m]',
    });
    const v = view(makeRuntime('anthropic-api'));
    await expect(v.probePrimaryProviderRecovered()).resolves.toBe(false);
    expect(probePrimaryModelUsabilityMock).toHaveBeenCalledTimes(1);
  });

  it.each(['usage-limit', 'rate-limit'] as const)(
    'keyed primary: %s fallback requires model usability, not credential presence',
    async (reason) => {
      lookupCredentialMock.mockReturnValue('sk-present');
      probePrimaryModelUsabilityMock.mockResolvedValue({
        status: 'credential-unavailable',
        provider: 'anthropic-api',
        model: 'claude-opus-4-8[1m]',
      });
      const v = view(makeRuntime('anthropic-api'));

      v.activateProviderFallback(null, reason);
      lookupCredentialMock.mockClear();
      probePrimaryModelUsabilityMock.mockClear();

      await expect(v.probePrimaryProviderRecovered()).resolves.toBe(false);
      expect(lookupCredentialMock).not.toHaveBeenCalled();
      expect(probePrimaryModelUsabilityMock).toHaveBeenCalledWith(
        { provider: 'anthropic-api', model: 'claude-opus-4-8[1m]' },
        expect.anything(),
      );
    },
  );

  it('keyed primary: quota fallback recovers when model usability is confirmed', async () => {
    lookupCredentialMock.mockReturnValue('sk-present');
    probePrimaryModelUsabilityMock.mockResolvedValue({
      status: 'usable',
      provider: 'anthropic-api',
      model: 'claude-opus-4-8[1m]',
    });
    const v = view(makeRuntime('anthropic-api'));

    v.activateProviderFallback(null, 'usage-limit');
    lookupCredentialMock.mockClear();
    probePrimaryModelUsabilityMock.mockClear();

    await expect(v.probePrimaryProviderRecovered()).resolves.toBe(true);
    expect(lookupCredentialMock).not.toHaveBeenCalled();
    expect(probePrimaryModelUsabilityMock).toHaveBeenCalledTimes(1);
  });

  it('keyed primary: NOT recovered when the usability probe is non-usable (even absent credential runs the probe)', async () => {
    // QR-048: credential absence no longer short-circuits — the probe always
    // runs and its non-usable result is what makes recovery false.
    lookupCredentialMock.mockReturnValue(null);
    probePrimaryModelUsabilityMock.mockResolvedValue({
      status: 'credential-unavailable',
      provider: 'anthropic-api',
      model: 'claude-opus-4-8[1m]',
    });
    const v = view(makeRuntime('anthropic-api'));
    await expect(v.probePrimaryProviderRecovered()).resolves.toBe(false);
    expect(probePrimaryModelUsabilityMock).toHaveBeenCalledTimes(1);
  });
});
