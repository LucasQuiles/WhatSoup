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

// the usability probe — the validity signal recovery must follow.
const probePrimaryModelUsabilityMock = vi.fn<() => Promise<PrimaryModelUsabilityResult>>();
vi.mock('../../../src/runtimes/agent/providers/primary-model-usability.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/runtimes/agent/providers/primary-model-usability.ts')>();
  return { ...actual, probePrimaryModelUsability: () => probePrimaryModelUsabilityMock() };
});
vi.mock('../../../src/runtimes/agent/providers/primary-model-usability-adapters.ts', () => ({
  createPrimaryModelProbeAdapters: vi.fn(() => ({})),
}));

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';

function makeDb(): Database {
  return { raw: { prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn() })), exec: vi.fn() } } as unknown as Database;
}
function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  } as unknown as Messenger;
}

type RecoveryView = { probePrimaryProviderRecovered(): Promise<boolean> };

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
  });

  it('binary primary: tolerates an unset model (coalesces to null) and follows usability', async () => {
    probePrimaryModelUsabilityMock.mockResolvedValue(usability('usable'));
    const config = mockConfigRef();
    config['agentProvider'] = 'claude-cli';
    config['agentProviderConfig'] = undefined;
    const runtime = new AgentRuntime(makeDb(), makeMessenger(), 'test', {}) as AgentRuntime;
    const v = view(runtime);
    await expect(v.probePrimaryProviderRecovered()).resolves.toBe(true);
  });

  it('binary primary: NOT recovered when no binary resolves', async () => {
    getProviderBinaryMock.mockReturnValue(null);
    probePrimaryModelUsabilityMock.mockResolvedValue(usability('usable'));
    const v = view(makeRuntime('claude-cli'));
    await expect(v.probePrimaryProviderRecovered()).resolves.toBe(false);
    expect(probePrimaryModelUsabilityMock).not.toHaveBeenCalled();
  });

  it('keyed primary: recovered when the credential is present', async () => {
    lookupCredentialMock.mockReturnValue('sk-present');
    const v = view(makeRuntime('anthropic-api'));
    await expect(v.probePrimaryProviderRecovered()).resolves.toBe(true);
    expect(probePrimaryModelUsabilityMock).not.toHaveBeenCalled();
  });

  it('keyed primary: NOT recovered when the credential is absent', async () => {
    lookupCredentialMock.mockReturnValue(null);
    const v = view(makeRuntime('anthropic-api'));
    await expect(v.probePrimaryProviderRecovered()).resolves.toBe(false);
  });
});
