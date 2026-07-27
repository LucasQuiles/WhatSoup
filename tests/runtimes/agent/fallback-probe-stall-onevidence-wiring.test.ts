/**
 * H4 regression pin (QUALITY-PASS-2120-transaction.md): every wiring test for
 * FallbackRecoveryTransaction stubs `probePrimaryProviderRecovered` at the
 * instance level, so a future refactor that silently drops the real method's
 * `onEvidence?.(...)` call (runtime.ts) would revert production to pre-DUR-02
 * bare-boolean trust while every other suite stays green — nothing pins that
 * the REAL implementation invokes the callback.
 *
 * This file does NOT stub `probePrimaryProviderRecovered` — it mocks the
 * probe's own dependencies (`probePrimaryModelUsability`,
 * `createPrimaryModelProbeAdapters`), exactly as the out-of-write-set
 * `recovery-probe-validity.test.ts` does, and calls the real method directly
 * with an `onEvidence` callback, asserting it fires with the real result.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrimaryModelUsabilityResult } from '../../../src/runtimes/agent/providers/primary-model-usability.ts';

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
  (globalThis as Record<string, unknown>)['__onEvidenceWiringTestConfig__'] = config;
  return { config };
});

function mockConfigRef(): Record<string, unknown> {
  return (globalThis as Record<string, unknown>)['__onEvidenceWiringTestConfig__'] as Record<string, unknown>;
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

const lookupCredentialMock = vi.fn<(service: string) => string | null>(() => 'present-key');
vi.mock('../../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/keyring.ts')>();
  return { ...actual, lookupCredential: (service: string) => lookupCredentialMock(service) };
});

vi.mock('../../../src/runtimes/agent/providers/credential-verify.ts', () => ({
  verifyFallbackCredential: vi.fn(async () => 'unknown'),
}));
vi.mock('../../../src/runtimes/agent/providers/binary-preflight.ts', () => ({
  probeFallbackBinary: vi.fn(async () => ({ status: 'unknown', version: null })),
  probeModelCatalog: vi.fn(async () => ({ status: 'unknown', suggestion: null })),
}));

// The probe's own dependency — mocked, NOT the method under test.
const probePrimaryModelUsabilityMock = vi.fn<(...args: unknown[]) => Promise<PrimaryModelUsabilityResult>>();
vi.mock('../../../src/runtimes/agent/providers/primary-model-usability.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/runtimes/agent/providers/primary-model-usability.ts')>();
  return { ...actual, probePrimaryModelUsability: (...args: unknown[]) => probePrimaryModelUsabilityMock(...args) };
});
vi.mock('../../../src/runtimes/agent/providers/primary-model-usability-adapters.ts', () => ({
  createPrimaryModelProbeAdapters: vi.fn(() => ({})),
}));

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';
import type { FallbackRecoveryEvidence } from '../../../src/runtimes/agent/fallback-recovery-transaction.ts';

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
  probePrimaryProviderRecovered(onEvidence?: (e: FallbackRecoveryEvidence) => void): Promise<boolean>;
};
function view(runtime: AgentRuntime): RecoveryView {
  return runtime as unknown as RecoveryView;
}
function makeRuntime(): AgentRuntime {
  const config = mockConfigRef();
  config['agentProvider'] = 'claude-cli';
  config['agentProviderConfig'] = undefined;
  return new AgentRuntime(makeDb(), makeMessenger(), 'test', { model: 'claude-opus-4-8[1m]' });
}

describe('AgentRuntime.probePrimaryProviderRecovered — onEvidence wiring (H4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lookupCredentialMock.mockReturnValue('present-key');
  });

  it('invokes onEvidence with the real probe result on a usable outcome', async () => {
    probePrimaryModelUsabilityMock.mockResolvedValue({ status: 'usable', provider: 'claude-cli', model: 'claude-opus-4-8[1m]' });
    const v = view(makeRuntime());
    const onEvidence = vi.fn();
    await expect(v.probePrimaryProviderRecovered(onEvidence)).resolves.toBe(true);
    expect(onEvidence).toHaveBeenCalledTimes(1);
    const evidence = onEvidence.mock.calls[0]![0] as FallbackRecoveryEvidence;
    expect(evidence.status).toBe('usable');
    expect(evidence.provider).toBe('claude-cli');
    expect(evidence.model).toBe('claude-opus-4-8[1m]');
    expect(typeof evidence.checkedAt).toBe('number');
  });

  it('invokes onEvidence with the real probe result on a non-usable outcome too', async () => {
    probePrimaryModelUsabilityMock.mockResolvedValue({ status: 'credential-unavailable', provider: 'claude-cli', model: 'claude-opus-4-8[1m]' });
    const v = view(makeRuntime());
    const onEvidence = vi.fn();
    await expect(v.probePrimaryProviderRecovered(onEvidence)).resolves.toBe(false);
    expect(onEvidence).toHaveBeenCalledTimes(1);
    expect((onEvidence.mock.calls[0]![0] as FallbackRecoveryEvidence).status).toBe('credential-unavailable');
  });

  it('resolves the boolean correctly when no onEvidence callback is supplied (diagnostic-bundle shape)', async () => {
    probePrimaryModelUsabilityMock.mockResolvedValue({ status: 'usable', provider: 'claude-cli', model: 'claude-opus-4-8[1m]' });
    const v = view(makeRuntime());
    await expect(v.probePrimaryProviderRecovered()).resolves.toBe(true);
  });
});
