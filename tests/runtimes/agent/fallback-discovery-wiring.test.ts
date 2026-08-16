/**
 * Discovery-mode fallback wiring (R6, owner directive 2026-08-15: chains are
 * DISCOVERED per host/user/deployment from the gateway's credential-aware
 * model catalogue — never hardcoded).
 *
 * Pins the runtime lifecycle around the pure derivation core
 * (fallback-discovery.ts):
 *   - boot derivation populates host.agentFallbacks IN PLACE (ports hold the
 *     array by reference) with keyed picks + the reserved free-tier tail
 *   - static mode (no fallbackDiscovery config) never touches the catalogue
 *   - honest degrade: an unavailable catalogue NEVER wipes a derived chain;
 *     fallback_discovery_empty fires only when no ladder exists, and clears
 *     on the next successful derivation
 *   - canary evidence steers the derivation (dead excluded, ok ranked first)
 *   - mid-window a re-derivation preserves the ACTIVE entry and every entry
 *     already tried this window; only the untried remainder is re-ranked
 *   - arming a window with a stale/absent snapshot kicks a refresh
 *   - the canary sweep probes the discovered candidate BASIS and re-derives
 *     from the fresh evidence
 *   - /health carries the derivation basis under fallbackDiscovery
 *
 * Runtime harness mirrors fallback-chain-canary.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { emitAlertMock, clearAlertSourceMock, canaryProbeMock } = vi.hoisted(() => ({
  emitAlertMock: vi.fn(() => true),
  clearAlertSourceMock: vi.fn(() => true),
  canaryProbeMock: vi.fn<(binary: string, args: string[], prompt: string, env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<{ status: string; evidence: string | null; durationMs: number }>>(
    () => Promise.resolve({ status: 'ok', evidence: null, durationMs: 50 }),
  ),
}));
vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlert: emitAlertMock,
  emitAlertChecked: emitAlertMock,
  clearAlertSource: clearAlertSourceMock,
  clearAlertSourceChecked: clearAlertSourceMock,
}));

vi.mock('../../../src/config.ts', () => {
  const config: Record<string, unknown> = {
    fallbackTunables: { noticeDedupMs: 1_800_000, primaryRecheckMs: 300_000, probeStallThreshold: 12, probeStallCeilingMultiple: 10 },
    adminPhones: new Set<string>(),
    controlPeers: new Map<string, string>(),
    toolUpdateMode: 'full',
    toolUpdateRedirectJid: null,
    textAggregateDelayMs: 2_000,
    mediaDir: '/tmp/whatsoup-test-media-fallback-discovery-wiring/tmp',
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
    agentFallbackDiscovery: null,
  };
  (globalThis as Record<string, unknown>)['__discoveryWiringTestConfig__'] = config;
  return { config };
});

function mockConfigRef(): Record<string, unknown> {
  return (globalThis as Record<string, unknown>)['__discoveryWiringTestConfig__'] as Record<string, unknown>;
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
  listModelCatalog: vi.fn(() => Promise.resolve({ status: 'unavailable', reason: 'spawn-error' })),
}));

vi.mock('../../../src/runtimes/agent/providers/chain-entry-canary.ts', () => ({
  probeChainEntryCompletion: canaryProbeMock,
}));

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';
import type { AgentFallbackDiscoveryConfig } from '../../../src/core/fallback-chain.ts';

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

interface FallbackEntry { provider: string; model?: string }

/** The live 2026-08-15 fleet-host catalogue, abbreviated. */
const CATALOGUE = [
  'deepseek/deepseek-chat',
  'deepseek/deepseek-v4-pro',
  'glm/glm-4.5',
  'glm/glm-5.2',
  'minimax/MiniMax-M3',
  'kimi/kimi-k3',
  'opencode/small-brain',
  'opencode/big-pickle',
];

type CatalogueListing =
  | { status: 'ok'; ids: string[] }
  | { status: 'unavailable'; reason: 'spawn-error' | 'timeout' | 'empty' };

function makeRuntime(
  discovery: AgentFallbackDiscoveryConfig | null,
  catalogue: () => Promise<CatalogueListing>,
): { runtime: AgentRuntime; catalogueMock: ReturnType<typeof vi.fn> } {
  const config = mockConfigRef();
  config['agentProvider'] = 'claude-cli';
  config['agentFallbacks'] = undefined;
  config['agentFallbackDiscovery'] = discovery;
  const catalogueMock = vi.fn(catalogue);
  const runtime = new AgentRuntime(makeDb(), makeMessenger(), 'test', {
    model: 'claude-opus-4-8[1m]',
    sessionScope: 'per_chat',
    modelCatalogueListFn: catalogueMock as never,
  });
  return { runtime, catalogueMock };
}

type RuntimeView = {
  activateProviderFallback(
    resetAt: Date | null,
    reason?: 'usage-limit' | 'rate-limit' | 'auth-required' | 'model-unavailable' | 'server-error',
  ): unknown;
  agentFallbacks: FallbackEntry[];
  fallbackWindow: { activeEntry: FallbackEntry | null; activeUntil: number | null };
  fallbackChain: { entryKey(entry: FallbackEntry): string; failedKeys: Set<string> };
  fallback: {
    refreshDiscoveredFallbackChain(trigger: 'boot' | 'window-arm' | 'canary-sweep'): Promise<void>;
    runChainCanarySweep(trigger: string): Promise<void>;
    chainCanary: Map<string, { status: string; evidence: string | null; durationMs: number; checkedAt: number }>;
    chainCanaryConfig: { trustMs: number };
    lastDiscovery: { at: number; catalogueSize: number } | null;
  };
  getFallbackState(): {
    fallbackDiscovery: {
      mode: 'auto';
      lastDerivedAt: number | null;
      catalogueSize: number | null;
      candidates: Array<{ model: string; evidence: string; freeTier: boolean; selected: boolean }>;
    } | null;
  };
};

function v(runtime: AgentRuntime): RuntimeView {
  return runtime as unknown as RuntimeView;
}

function models(entries: FallbackEntry[]): (string | undefined)[] {
  return entries.map((entry) => entry.model);
}

function seedCanary(rv: RuntimeView, model: string, status: string, ageMs = 0): void {
  rv.fallback.chainCanary.set(rv.fallbackChain.entryKey({ provider: 'opencode-cli', model }), {
    status,
    evidence: status === 'ok' ? null : 'exit=1 account suspended',
    durationMs: 100,
    checkedAt: Date.now() - ageMs,
  });
}

const AUTO: AgentFallbackDiscoveryConfig = { mode: 'auto' };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-16T12:00:00Z'));
  lookupCredentialMock.mockReturnValue('present-key');
  emitAlertMock.mockClear();
  clearAlertSourceMock.mockClear();
  canaryProbeMock.mockClear();
  canaryProbeMock.mockResolvedValue({ status: 'ok', evidence: null, durationMs: 50 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('boot derivation', () => {
  it('derives keyed picks (newest per provider) + the reserved free-tier tail into agentFallbacks in place', async () => {
    const { runtime } = makeRuntime(AUTO, async () => ({ status: 'ok', ids: CATALOGUE }));
    const rv = v(runtime);
    const arrayRef = rv.agentFallbacks;
    expect(arrayRef).toEqual([]);

    await rv.fallback.refreshDiscoveredFallbackChain('boot');

    // maxEntries default 3, one slot reserved for free tier: 2 keyed picks in
    // catalogue order (all evidence unknown), newest model per provider.
    expect(models(rv.agentFallbacks)).toEqual([
      'deepseek/deepseek-v4-pro',
      'glm/glm-5.2',
      'opencode/big-pickle',
    ]);
    expect(rv.agentFallbacks.every((entry) => entry.provider === 'opencode-cli')).toBe(true);
    // In-place mutation: the SAME array object the ports captured.
    expect(rv.agentFallbacks).toBe(arrayRef);
    expect(rv.fallback.lastDiscovery?.catalogueSize).toBe(CATALOGUE.length);
  });

  it('honors preferModels pins and excludeProviders', async () => {
    const { runtime } = makeRuntime(
      { mode: 'auto', preferModels: { deepseek: 'deepseek/deepseek-chat' }, excludeProviders: ['glm'] },
      async () => ({ status: 'ok', ids: CATALOGUE }),
    );
    const rv = v(runtime);

    await rv.fallback.refreshDiscoveredFallbackChain('boot');

    expect(models(rv.agentFallbacks)).toEqual([
      'deepseek/deepseek-chat',
      'minimax/MiniMax-M3',
      'opencode/big-pickle',
    ]);
  });

  it('static mode: refresh is a no-op and the catalogue is never read', async () => {
    const { runtime, catalogueMock } = makeRuntime(null, async () => ({ status: 'ok', ids: CATALOGUE }));
    const rv = v(runtime);

    await rv.fallback.refreshDiscoveredFallbackChain('boot');

    expect(catalogueMock).not.toHaveBeenCalled();
    expect(rv.agentFallbacks).toEqual([]);
    expect(rv.getFallbackState().fallbackDiscovery).toBeNull();
  });
});

describe('honest degrade + fallback_discovery_empty', () => {
  it('an unavailable catalogue NEVER wipes a previously derived chain', async () => {
    let listing: CatalogueListing = { status: 'ok', ids: CATALOGUE };
    const { runtime } = makeRuntime(AUTO, async () => listing);
    const rv = v(runtime);
    await rv.fallback.refreshDiscoveredFallbackChain('boot');
    const derived = [...models(rv.agentFallbacks)];
    expect(derived.length).toBeGreaterThan(0);

    listing = { status: 'unavailable', reason: 'timeout' };
    await rv.fallback.refreshDiscoveredFallbackChain('canary-sweep');

    expect(models(rv.agentFallbacks)).toEqual(derived);
    expect(emitAlertMock).not.toHaveBeenCalledWith(
      'test', 'fallback_discovery_empty', expect.any(String), expect.any(String),
    );
  });

  it('alerts fallback_discovery_empty when the instance is left without a ladder, and clears on recovery', async () => {
    let listing: CatalogueListing = { status: 'unavailable', reason: 'spawn-error' };
    const { runtime } = makeRuntime(AUTO, async () => listing);
    const rv = v(runtime);

    await rv.fallback.refreshDiscoveredFallbackChain('boot');
    expect(rv.agentFallbacks).toEqual([]);
    expect(emitAlertMock).toHaveBeenCalledWith(
      'test', 'fallback_discovery_empty', expect.any(String), expect.stringContaining('catalogue=spawn-error'),
    );

    listing = { status: 'ok', ids: CATALOGUE };
    await rv.fallback.refreshDiscoveredFallbackChain('window-arm');
    expect(rv.agentFallbacks.length).toBeGreaterThan(0);
    expect(clearAlertSourceMock).toHaveBeenCalledWith(
      'test', 'fallback_discovery_empty', expect.stringContaining('recoveryProof=chain_derived'),
    );
  });

  it('alerts when an OK catalogue derives zero candidates (everything excluded)', async () => {
    const { runtime } = makeRuntime(
      { mode: 'auto', excludeProviders: ['deepseek', 'glm', 'minimax', 'kimi', 'opencode'] },
      async () => ({ status: 'ok', ids: CATALOGUE }),
    );
    const rv = v(runtime);

    await rv.fallback.refreshDiscoveredFallbackChain('boot');

    expect(rv.agentFallbacks).toEqual([]);
    expect(emitAlertMock).toHaveBeenCalledWith(
      'test', 'fallback_discovery_empty', expect.any(String), expect.stringContaining('candidates=0'),
    );
  });
});

describe('evidence-consulted derivation', () => {
  it('excludes canary-dead candidates and ranks canary-ok ahead of unknown', async () => {
    const { runtime } = makeRuntime(AUTO, async () => ({ status: 'ok', ids: CATALOGUE }));
    const rv = v(runtime);
    seedCanary(rv, 'deepseek/deepseek-v4-pro', 'failed');
    seedCanary(rv, 'minimax/MiniMax-M3', 'ok');

    await rv.fallback.refreshDiscoveredFallbackChain('boot');

    // deepseek dead → excluded; minimax ok → ranked ahead of unknown glm.
    expect(models(rv.agentFallbacks)).toEqual([
      'minimax/MiniMax-M3',
      'glm/glm-5.2',
      'opencode/big-pickle',
    ]);
  });

  it('stale canary failure (older than trustMs) decays to unknown and no longer excludes', async () => {
    const { runtime } = makeRuntime(AUTO, async () => ({ status: 'ok', ids: CATALOGUE }));
    const rv = v(runtime);
    seedCanary(rv, 'deepseek/deepseek-v4-pro', 'failed', rv.fallback.chainCanaryConfig.trustMs + 60_000);

    await rv.fallback.refreshDiscoveredFallbackChain('boot');

    expect(models(rv.agentFallbacks)).toContain('deepseek/deepseek-v4-pro');
  });
});

describe('mid-window re-derivation', () => {
  it('preserves the ACTIVE entry and window-failed entries; re-ranks only the untried remainder', async () => {
    let ids = CATALOGUE;
    const { runtime } = makeRuntime(AUTO, async () => ({ status: 'ok', ids }));
    const rv = v(runtime);
    await rv.fallback.refreshDiscoveredFallbackChain('boot');
    expect(models(rv.agentFallbacks)).toEqual([
      'deepseek/deepseek-v4-pro', 'glm/glm-5.2', 'opencode/big-pickle',
    ]);

    rv.activateProviderFallback(null, 'usage-limit');
    expect(rv.fallbackWindow.activeEntry?.model).toBe('deepseek/deepseek-v4-pro');
    // Simulate glm tried-and-failed during this window.
    rv.fallbackChain.failedKeys.add(
      rv.fallbackChain.entryKey({ provider: 'opencode-cli', model: 'glm/glm-5.2' }),
    );

    // Catalogue now surfaces minimax only (glm/deepseek gone upstream).
    ids = ['minimax/MiniMax-M3', 'kimi/kimi-k3', 'opencode/big-pickle'];
    await rv.fallback.refreshDiscoveredFallbackChain('canary-sweep');

    const chainModels = models(rv.agentFallbacks);
    // Active + failed entries survive, in chain order, ahead of the re-ranked remainder.
    expect(chainModels[0]).toBe('deepseek/deepseek-v4-pro');
    expect(chainModels[1]).toBe('glm/glm-5.2');
    expect(chainModels.slice(2)).toEqual(['minimax/MiniMax-M3', 'kimi/kimi-k3', 'opencode/big-pickle']);
    // No duplicates.
    expect(new Set(chainModels).size).toBe(chainModels.length);
  });

  it('an activation attempt on an empty never-derived chain kicks a refresh so the NEXT attempt has a ladder', async () => {
    const { runtime, catalogueMock } = makeRuntime(AUTO, async () => ({ status: 'ok', ids: CATALOGUE }));
    const rv = v(runtime);
    expect(catalogueMock).not.toHaveBeenCalled();

    // Boot derivation never completed → chain empty → activation honestly
    // fails, but the attempt itself is the signal a ladder is needed NOW.
    const first = rv.activateProviderFallback(null, 'usage-limit');
    expect(first).toBeNull();
    expect(catalogueMock).toHaveBeenCalledTimes(1);

    await vi.runAllTimersAsync();
    expect(models(rv.agentFallbacks).length).toBeGreaterThan(0);
    const second = rv.activateProviderFallback(null, 'usage-limit');
    expect(second).not.toBeNull();
    expect(rv.fallbackWindow.activeEntry?.model).toBe('deepseek/deepseek-v4-pro');
  });
});

describe('canary sweep over the discovered basis', () => {
  it('probes the full candidate basis (not just selected entries) and re-derives from fresh evidence', async () => {
    const { runtime, catalogueMock } = makeRuntime(AUTO, async () => ({ status: 'ok', ids: CATALOGUE }));
    const rv = v(runtime);
    await rv.fallback.refreshDiscoveredFallbackChain('boot');
    catalogueMock.mockClear();

    // deepseek (currently entry 0) fails its probe; everything else passes.
    canaryProbeMock.mockImplementation((_binary, args) => {
      const failed = args.some((arg) => arg.includes('deepseek'));
      return Promise.resolve(
        failed
          ? { status: 'failed', evidence: 'exit=1 account suspended', durationMs: 80 }
          : { status: 'ok', evidence: null, durationMs: 50 },
      );
    });

    await rv.fallback.runChainCanarySweep('scheduled');

    // Basis has 5 candidates (deepseek, glm, minimax, kimi, opencode) — ALL
    // probed, including the two the selected chain excluded.
    expect(canaryProbeMock).toHaveBeenCalledTimes(5);
    // Sweep completion re-derived: deepseek now dead → out of the chain.
    expect(catalogueMock).toHaveBeenCalledTimes(1);
    expect(models(rv.agentFallbacks)).not.toContain('deepseek/deepseek-v4-pro');
    expect(models(rv.agentFallbacks)).toContain('glm/glm-5.2');
  });
});

describe('/health surface', () => {
  it('reports the derivation basis with per-candidate evidence and selection', async () => {
    const { runtime } = makeRuntime(AUTO, async () => ({ status: 'ok', ids: CATALOGUE }));
    const rv = v(runtime);
    await rv.fallback.refreshDiscoveredFallbackChain('boot');

    const state = rv.getFallbackState().fallbackDiscovery;
    expect(state?.mode).toBe('auto');
    expect(state?.lastDerivedAt).not.toBeNull();
    expect(state?.catalogueSize).toBe(CATALOGUE.length);
    const selected = state?.candidates.filter((c) => c.selected).map((c) => c.model);
    expect(selected).toEqual(['deepseek/deepseek-v4-pro', 'glm/glm-5.2', 'opencode/big-pickle']);
    const freeTier = state?.candidates.find((c) => c.freeTier);
    expect(freeTier?.model).toBe('opencode/big-pickle');
  });
});
