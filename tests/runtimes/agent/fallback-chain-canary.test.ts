/**
 * Fallback chain canary — real-completion probes + evidence-consulted selection.
 *
 * Fleet incident 2026-08-15: the chain's first entry was account-dead (billing
 * suspension) for 24 days with zero signal — the provider's models endpoint
 * returned 200 and the key was present, so every metadata preflight passed;
 * only real completions failed. These tests pin the prevention contract:
 *
 *   - probeChainEntryCompletion classifies ok / failed(+evidence) / timeout
 *     through an injected spawn, sanitizing key material out of evidence
 *   - selection SKIPS an entry with fresh canary-failure evidence and picks
 *     the next candidate
 *   - FAIL-OPEN: when every candidate has failure evidence, the canary is
 *     disregarded (the pre-canary selection floor is preserved)
 *   - stale evidence (older than the trust TTL) does not affect selection
 *   - /health chain view carries per-entry canary records
 *
 * Runtime harness mirrors fallback-process-failure-advance.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

type SweepProbeResult = { status: string; evidence: string | null; failureClass: string | null; durationMs: number };

const { emitAlertMock, clearAlertMock, sweepProbe } = vi.hoisted(() => ({
  emitAlertMock: vi.fn((..._args: unknown[]) => true),
  clearAlertMock: vi.fn((..._args: unknown[]) => true),
  // Runtime sweeps route through `impl` when set; the unit tests below keep
  // the real probe (impl null) so their injected-spawn coverage is unchanged.
  sweepProbe: { impl: null as null | ((args: string[]) => Promise<SweepProbeResult>) },
}));

vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlert: emitAlertMock,
  emitAlertChecked: emitAlertMock,
  emitObservationChecked: vi.fn(() => true),
  clearAlertSource: clearAlertMock,
  clearAlertSourceChecked: clearAlertMock,
}));

vi.mock('../../../src/runtimes/agent/providers/chain-entry-canary.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/runtimes/agent/providers/chain-entry-canary.ts')>();
  return {
    ...actual,
    probeChainEntryCompletion: (...args: Parameters<typeof actual.probeChainEntryCompletion>) => (
      sweepProbe.impl ? sweepProbe.impl(args[1]) as never : actual.probeChainEntryCompletion(...args)
    ),
  };
});

vi.mock('../../../src/config.ts', () => {
  const config: Record<string, unknown> = {
    fallbackTunables: { noticeDedupMs: 1_800_000, primaryRecheckMs: 300_000, probeStallThreshold: 12, probeStallCeilingMultiple: 10 },
    adminPhones: new Set<string>(),
    controlPeers: new Map<string, string>(),
    toolUpdateMode: 'full',
    toolUpdateRedirectJid: null,
    textAggregateDelayMs: 2_000,
    mediaDir: '/tmp/whatsoup-test-media-fallback-chain-canary/tmp',
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
  (globalThis as Record<string, unknown>)['__chainCanaryTestConfig__'] = config;
  return { config };
});

function mockConfigRef(): Record<string, unknown> {
  return (globalThis as Record<string, unknown>)['__chainCanaryTestConfig__'] as Record<string, unknown>;
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
vi.mock('../../../src/runtimes/agent/providers/binary-preflight.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/runtimes/agent/providers/binary-preflight.ts')>();
  return {
    ...actual,
    probeFallbackBinary: vi.fn(() => Promise.resolve({ status: 'unknown', version: null })),
    probeModelCatalog: vi.fn(() => Promise.resolve({ status: 'unknown', suggestion: null })),
    listModelCatalog: vi.fn(() => Promise.resolve({ status: 'unavailable', reason: 'spawn-error' })),
  };
});

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';
import { classifyCanaryFailure, probeChainEntryCompletion } from '../../../src/runtimes/agent/providers/chain-entry-canary.ts';
import { resolveFallbackCanaryConfig } from '../../../src/runtimes/agent/fallback-canary-config.ts';

// ─── probeChainEntryCompletion unit coverage (injected spawn) ────────────────

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end: (s?: string) => void };
  kill: (sig?: string) => void;
};

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: vi.fn() };
  child.kill = vi.fn();
  return child;
}

describe('probeChainEntryCompletion', () => {
  it('classifies a clean exit with output as ok', async () => {
    const child = makeFakeChild();
    const spawnImpl = vi.fn(() => child) as never;
    const p = probeChainEntryCompletion('opencode', ['run'], 'Reply OK', {}, 5_000, spawnImpl);
    child.stdout.emit('data', Buffer.from('OK'));
    child.emit('close', 0, null);
    const result = await p;
    expect(result.evidence).toBeNull();
    expect(result.failureClass).toBeNull();
    expect(result.status).toBe('ok');
  });

  it('classifies a non-zero exit as failed with sanitized stderr evidence', async () => {
    const child = makeFakeChild();
    const spawnImpl = vi.fn(() => child) as never;
    const p = probeChainEntryCompletion('opencode', ['run'], 'Reply OK', {}, 5_000, spawnImpl);
    child.stderr.emit('data', Buffer.from('account org-123 <ak-testtok99> is suspended; Bearer tok.value.here used'));
    child.emit('close', 1, null);
    const result = await p;
    expect(result.status).toBe('failed');
    expect(result.evidence).toContain('suspended');
    expect(result.evidence).toContain('exit=1');
    expect(result.evidence).not.toContain('ak-testtok99');
    expect(result.evidence).not.toContain('tok.value.here');
    expect(result.failureClass).toBe('auth');
  });

  it('classifies a hung child as timeout and kills it', async () => {
    vi.useFakeTimers();
    try {
      const child = makeFakeChild();
      const spawnImpl = vi.fn(() => child) as never;
      const p = probeChainEntryCompletion('opencode', ['run'], 'Reply OK', {}, 5_000, spawnImpl);
      await vi.advanceTimersByTimeAsync(5_001);
      const result = await p;
      expect(result.status).toBe('timeout');
      expect(child.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a clean exit with EMPTY output is a failure, not a pass', async () => {
    const child = makeFakeChild();
    const spawnImpl = vi.fn(() => child) as never;
    const p = probeChainEntryCompletion('opencode', ['run'], 'Reply OK', {}, 5_000, spawnImpl);
    child.emit('close', 0, null);
    const result = await p;
    expect(result.status).toBe('failed');
  });
});

// ─── config resolution ───────────────────────────────────────────────────────

describe('resolveFallbackCanaryConfig', () => {
  it('defaults to disabled with sane trust/timeout', () => {
    const cfg = resolveFallbackCanaryConfig({});
    expect(cfg.intervalMs).toBe(0);
    expect(cfg.timeoutMs).toBe(90_000);
    expect(cfg.trustMs).toBeGreaterThan(0);
  });

  it('clamps interval into [1min, 24h] and derives trust as 2x interval', () => {
    const cfg = resolveFallbackCanaryConfig({ WHATSOUP_FALLBACK_CANARY_MS: '21600000' });
    expect(cfg.intervalMs).toBe(21_600_000);
    expect(cfg.trustMs).toBe(43_200_000);
    const floor = resolveFallbackCanaryConfig({ WHATSOUP_FALLBACK_CANARY_MS: '5' });
    expect(floor.intervalMs).toBe(60_000);
  });
});

// ─── selection consult (runtime level) ───────────────────────────────────────

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

const CHAIN = [
  { provider: 'opencode-cli', model: 'kimi/kimi-k3' },
  { provider: 'opencode-cli', model: 'glm/glm-5.2' },
];

function makeRuntime(chain: FallbackEntry[]): AgentRuntime {
  const config = mockConfigRef();
  config['agentProvider'] = 'claude-cli';
  config['agentFallbacks'] = chain;
  config['agentFallbackDiscovery'] = null;
  return new AgentRuntime(makeDb(), makeMessenger(), 'test', {
    model: 'claude-opus-4-8[1m]',
    sessionScope: 'per_chat',
  });
}

type CanaryRecord = { status: string; evidence: string | null; failureClass: string | null; durationMs: number; checkedAt: number };

type RuntimeView = {
  activateProviderFallback(
    resetAt: Date | null,
    reason?: 'usage-limit' | 'rate-limit' | 'auth-required' | 'model-unavailable' | 'server-error',
  ): unknown;
  fallbackWindow: { activeEntry: FallbackEntry | null };
  fallback: {
    chainCanary: Map<string, CanaryRecord>;
    chainCanaryConfig: { trustMs: number };
  };
  fallbackChain: { entryKey(entry: FallbackEntry): string };
  getFallbackState(): { fallbackChain: Array<FallbackEntry & { canary?: { status: string; failureClass?: string | null } | null }> };
};

function v(runtime: AgentRuntime): RuntimeView {
  return runtime as unknown as RuntimeView;
}

function seedCanary(rv: RuntimeView, entry: FallbackEntry, status: string, ageMs = 0): void {
  rv.fallback.chainCanary.set(rv.fallbackChain.entryKey(entry), {
    status,
    evidence: status === 'ok' ? null : 'exit=1 account suspended',
    failureClass: status === 'ok' ? null : 'auth',
    durationMs: 100,
    checkedAt: Date.now() - ageMs,
  });
}

describe('canary-consulted window selection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T20:00:00Z'));
    lookupCredentialMock.mockReturnValue('present-key');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips an entry with fresh canary-failure evidence and arms the next candidate', () => {
    const rv = v(makeRuntime(CHAIN));
    seedCanary(rv, CHAIN[0]!, 'failed');
    seedCanary(rv, CHAIN[1]!, 'ok');

    rv.activateProviderFallback(null, 'usage-limit');

    expect(rv.fallbackWindow.activeEntry?.model).toBe('glm/glm-5.2');
  });

  it('FAIL-OPEN: when every candidate has failure evidence, canary is disregarded', () => {
    const rv = v(makeRuntime(CHAIN));
    seedCanary(rv, CHAIN[0]!, 'failed');
    seedCanary(rv, CHAIN[1]!, 'timeout');

    rv.activateProviderFallback(null, 'usage-limit');

    // Pre-canary floor preserved: first configured entry armed.
    expect(rv.fallbackWindow.activeEntry?.model).toBe('kimi/kimi-k3');
  });

  it('stale failure evidence (older than trustMs) does not affect selection', () => {
    const rv = v(makeRuntime(CHAIN));
    seedCanary(rv, CHAIN[0]!, 'failed', rv.fallback.chainCanaryConfig.trustMs + 60_000);
    seedCanary(rv, CHAIN[1]!, 'ok');

    rv.activateProviderFallback(null, 'usage-limit');

    expect(rv.fallbackWindow.activeEntry?.model).toBe('kimi/kimi-k3');
  });

  it('exposes per-entry canary records in the fallback state chain view', () => {
    const rv = v(makeRuntime(CHAIN));
    seedCanary(rv, CHAIN[0]!, 'failed');

    const state = rv.getFallbackState();
    // Entry without evidence keeps its exact pre-canary shape (additive-only).
    expect(Object.keys(state.fallbackChain[1] ?? {})).not.toContain('canary');
    expect(state.fallbackChain[0]?.canary?.status).toBe('failed');
    expect(state.fallbackChain[0]?.canary?.failureClass).toBe('auth');
  });

  // The canary's raw tail is unbounded third-party prose (the 2026-08-16 live
  // sweep captured a z.ai request id + JSON responseBody). /health must carry
  // the bounded class ONLY.
  it('never renders the raw provider tail on the /health chain view', () => {
    const rv = v(makeRuntime(CHAIN));
    rv.fallback.chainCanary.set(rv.fallbackChain.entryKey(CHAIN[0]!), {
      status: 'failed',
      evidence: 'exit=1 {"error":{"code":"1310"}} requestId=8570bca1f4d34f94cf1',
      failureClass: 'quota',
      durationMs: 100,
      checkedAt: Date.now(),
    });

    // Assert STRUCTURALLY, not by substring: the rendered chain carries a
    // 13-digit `checkedAt`, so matching a short numeric like '1310' against
    // the whole JSON would spuriously fail whenever the timestamp happens to
    // contain those digits.
    const canary = rv.getFallbackState().fallbackChain[0]?.canary;
    expect(canary).toBeDefined();
    expect(Object.keys(canary ?? {}).sort()).toEqual(['checkedAt', 'failureClass', 'status']);
    expect(canary?.failureClass).toBe('quota');
    // Belt and braces: the raw tail's distinctive request id must not appear
    // anywhere in the rendered view (long enough that collision is impossible).
    expect(JSON.stringify(rv.getFallbackState().fallbackChain))
      .not.toContain('8570bca1f4d34f94cf1');
  });
});

// ─── fallback_chain_entry_unhealthy incident lifecycle (runtime sweeps) ─────
//
// The incident is keyed per instance+source, not per entry. Live defect
// (2026-09-25): a discovery candidate timed out, the alert opened, the
// re-derivation replaced the candidate with a sibling, the candidate was never
// swept again, and the incident stayed open although the chain was healthy.
// Contract: after each sweep (discovery refresh included) the alert clears
// when no entry in the CURRENT sweep set has fresh failure evidence.

const ENTRY_SOURCE = 'fallback_chain_entry_unhealthy';

type SweepView = {
  agentFallbacks: FallbackEntry[];
  fallbackChain: { entryKey(entry: FallbackEntry): string; failedKeys: Set<string> };
  fallback: {
    runChainCanarySweep(trigger: string): Promise<void>;
    refreshDiscoveredFallbackChain(trigger: 'boot' | 'window-arm' | 'canary-sweep'): Promise<void>;
  };
  getFallbackState(): { fallbackDiscovery: { candidates: Array<{ model: string }> } | null };
};

function sv(runtime: AgentRuntime): SweepView {
  return runtime as unknown as SweepView;
}

/** Probe outcome per model; unlisted models pass. Swap `failing` between sweeps. */
function probeOutcomes(failing: Record<string, 'failed' | 'timeout'>): void {
  sweepProbe.impl = (args) => {
    const hit = Object.keys(failing).find((model) => args.some((arg) => arg.includes(model)));
    const status = hit === undefined ? 'ok' : failing[hit]!;
    return Promise.resolve(status === 'ok'
      ? { status: 'ok', evidence: null, failureClass: null, durationMs: 40 }
      : { status, evidence: 'no completion within 90000ms', failureClass: 'timeout', durationMs: 90_000 });
  };
}

function entryAlerts(): unknown[][] {
  return emitAlertMock.mock.calls.filter((call) => call[1] === ENTRY_SOURCE);
}

function entryClears(): unknown[][] {
  return clearAlertMock.mock.calls.filter((call) => call[1] === ENTRY_SOURCE);
}

// Neutral model ids under provider prefixes that map to a credential service
// (buildChildEnv refuses unmapped prefixes). Provider A has two models (the
// later-entry tie break picks model-a2, and a dead model-a2 is replaced by its
// live sibling model-a1); provider B has one.
const SIBLING_CATALOGUE = ['minimax/model-a1', 'minimax/model-a2', 'xai/model-b1', 'deepseek/model-c1'];

async function makeDiscoveryRuntime(catalogue: string[] = SIBLING_CATALOGUE): Promise<SweepView> {
  const config = mockConfigRef();
  config['agentProvider'] = 'claude-cli';
  config['agentFallbacks'] = undefined;
  config['agentFallbackDiscovery'] = { mode: 'auto' };
  const runtime = new AgentRuntime(makeDb(), makeMessenger(), 'test', {
    model: 'primary-model',
    sessionScope: 'per_chat',
    modelCatalogueListFn: (async () => ({ status: 'ok', ids: [...catalogue] })) as never,
  });
  const view = sv(runtime);
  await view.fallback.refreshDiscoveredFallbackChain('boot');
  return view;
}

function sweepSetModels(view: SweepView): string[] {
  return (view.getFallbackState().fallbackDiscovery?.candidates ?? []).map((candidate) => candidate.model);
}

const STATIC_CHAIN = [
  { provider: 'opencode-cli', model: 'minimax/model-a1' },
  { provider: 'opencode-cli', model: 'xai/model-b1' },
];

describe('fallback_chain_entry_unhealthy incident lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T12:00:00Z'));
    lookupCredentialMock.mockReturnValue('present-key');
    emitAlertMock.mockClear();
    clearAlertMock.mockClear();
  });
  afterEach(() => {
    sweepProbe.impl = null;
    mockConfigRef()['agentFallbackDiscovery'] = null;
    vi.useRealTimers();
  });

  it('(a) clears when the failing entry leaves the discovery sweep set', async () => {
    const view = await makeDiscoveryRuntime();
    expect(sweepSetModels(view)).toContain('minimax/model-a2');

    probeOutcomes({ 'minimax/model-a2': 'timeout' });
    await view.fallback.runChainCanarySweep('scheduled');

    expect(entryAlerts()).toHaveLength(1);
    expect(String(entryAlerts()[0]?.[3])).toContain('model=minimax/model-a2');
    // Re-derivation replaced the dead model with its sibling: never swept again.
    expect(sweepSetModels(view)).not.toContain('minimax/model-a2');
    expect(sweepSetModels(view)).toContain('minimax/model-a1');
    expect(entryClears()).toHaveLength(1);
    expect(String(entryClears()[0]?.[2])).toContain('recoveryProof=failing_entry_left_sweep_set');

    await view.fallback.runChainCanarySweep('scheduled');
    expect(entryClears()).toHaveLength(1);
    expect(entryAlerts()).toHaveLength(1);
  });

  it('(b) keeps the alert open while the failing entry is still swept', async () => {
    const view = sv(makeRuntime(STATIC_CHAIN));
    probeOutcomes({ 'minimax/model-a1': 'failed' });

    await view.fallback.runChainCanarySweep('scheduled');
    await view.fallback.runChainCanarySweep('scheduled');

    expect(entryAlerts()).toHaveLength(1);
    expect(entryClears()).toHaveLength(0);
  });

  it('(c) clears exactly once when the failing entry recovers', async () => {
    const view = sv(makeRuntime(STATIC_CHAIN));
    probeOutcomes({ 'minimax/model-a1': 'failed' });
    await view.fallback.runChainCanarySweep('scheduled');
    expect(entryClears()).toHaveLength(0);

    probeOutcomes({});
    await view.fallback.runChainCanarySweep('scheduled');
    await view.fallback.runChainCanarySweep('scheduled');

    expect(entryClears()).toHaveLength(1);
    expect(String(entryClears()[0]?.[2])).toContain('recoveryProof=canary_completion');
    expect(String(entryClears()[0]?.[2])).toContain('model=minimax/model-a1');
  });

  it('(d) stays open when one failing entry is dropped and another still fails', async () => {
    const view = await makeDiscoveryRuntime();
    probeOutcomes({ 'minimax/model-a2': 'timeout', 'xai/model-b1': 'failed' });

    await view.fallback.runChainCanarySweep('scheduled');

    expect(sweepSetModels(view)).not.toContain('minimax/model-a2');
    // Provider B has no sibling: its dead representative stays in the set.
    expect(sweepSetModels(view)).toContain('xai/model-b1');
    expect(entryAlerts()).toHaveLength(2);
    expect(entryClears()).toHaveLength(0);
  });

  it('(d2) stays open when one of two failing entries recovers and the other still fails', async () => {
    const view = sv(makeRuntime(STATIC_CHAIN));
    probeOutcomes({ 'minimax/model-a1': 'failed', 'xai/model-b1': 'failed' });
    await view.fallback.runChainCanarySweep('scheduled');

    probeOutcomes({ 'xai/model-b1': 'failed' });
    await view.fallback.runChainCanarySweep('scheduled');
    expect(entryClears()).toHaveLength(0);

    probeOutcomes({});
    await view.fallback.runChainCanarySweep('scheduled');
    expect(entryClears()).toHaveLength(1);
  });

  it('(e) emits warning when another chain entry is canary-ok and the chain is not exhausted', async () => {
    const view = sv(makeRuntime(STATIC_CHAIN));
    // The failing entry is probed FIRST: severity must see the whole sweep.
    probeOutcomes({ 'minimax/model-a1': 'failed' });

    await view.fallback.runChainCanarySweep('scheduled');

    expect(entryAlerts()).toHaveLength(1);
    expect(entryAlerts()[0]?.[4]).toBe('warning');
  });

  it('(e) emits critical when no other chain entry is canary-ok', async () => {
    const view = sv(makeRuntime(STATIC_CHAIN));
    probeOutcomes({ 'minimax/model-a1': 'failed', 'xai/model-b1': 'timeout' });

    await view.fallback.runChainCanarySweep('scheduled');

    expect(entryAlerts()).toHaveLength(2);
    expect(entryAlerts().map((call) => call[4])).toEqual(['critical', 'critical']);
  });

  it('(e) emits critical when the chain is exhausted even if another entry is canary-ok', async () => {
    const view = sv(makeRuntime(STATIC_CHAIN));
    for (const entry of STATIC_CHAIN) view.fallbackChain.failedKeys.add(view.fallbackChain.entryKey(entry));
    probeOutcomes({ 'minimax/model-a1': 'failed' });

    await view.fallback.runChainCanarySweep('scheduled');

    expect(entryAlerts()[0]?.[4]).toBe('critical');
  });

  it('(e) emits critical when the only canary-ok peer already failed a turn this window', async () => {
    // A peer in failedKeys cannot be selected again this window, so it is not a
    // healthy fallback even though its canary passes.
    const view = sv(makeRuntime(STATIC_CHAIN));
    view.fallbackChain.failedKeys.add(view.fallbackChain.entryKey(STATIC_CHAIN[1]!));
    probeOutcomes({ 'minimax/model-a1': 'failed' });

    await view.fallback.runChainCanarySweep('scheduled');

    expect(entryAlerts()).toHaveLength(1);
    expect(entryAlerts()[0]?.[4]).toBe('critical');
  });

  it('(f) stays open while the ACTIVE window entry is canary-dead even after it left the sweep set', async () => {
    const view = await makeDiscoveryRuntime();
    v(view as unknown as AgentRuntime).activateProviderFallback(null, 'usage-limit');
    const active = v(view as unknown as AgentRuntime).fallbackWindow.activeEntry;
    expect(active?.model).toBe('minimax/model-a2');

    probeOutcomes({ 'minimax/model-a2': 'timeout' });
    await view.fallback.runChainCanarySweep('scheduled');

    // Discovery replaced it in the basis, but the window still serves on it.
    expect(sweepSetModels(view)).not.toContain('minimax/model-a2');
    expect(view.agentFallbacks.map((entry) => entry.model)).toContain('minimax/model-a2');
    expect(entryAlerts()).toHaveLength(1);
    expect(entryClears()).toHaveLength(0);
  });

  it('(g) re-opens when a still-dead entry re-enters the sweep set after a clear', async () => {
    const catalogue = [...SIBLING_CATALOGUE];
    const view = await makeDiscoveryRuntime(catalogue);
    probeOutcomes({ 'minimax/model-a2': 'timeout' });
    await view.fallback.runChainCanarySweep('scheduled');
    expect(entryClears()).toHaveLength(1);

    // The sibling disappears from the catalogue: the dead model is the only
    // representative of its provider again and returns to the sweep set.
    catalogue.splice(catalogue.indexOf('minimax/model-a1'), 1);
    await view.fallback.runChainCanarySweep('scheduled');
    expect(sweepSetModels(view)).toContain('minimax/model-a2');
    await view.fallback.runChainCanarySweep('scheduled');

    expect(entryAlerts()).toHaveLength(2);
    expect(entryClears()).toHaveLength(1);
  });

  it('re-alerts when a failure record older than trustMs is followed by a fresh failure', async () => {
    // Reconcile treats an expired failure record as not failing, so the open
    // decision must use the same freshness rule or a still-dead entry would
    // never alert again after its record lapsed and the incident cleared.
    const runtime = makeRuntime(STATIC_CHAIN);
    const rv = v(runtime);
    seedCanary(rv, STATIC_CHAIN[0]!, 'failed', rv.fallback.chainCanaryConfig.trustMs + 60_000);
    probeOutcomes({ 'minimax/model-a1': 'failed' });

    await sv(runtime).fallback.runChainCanarySweep('scheduled');

    expect(entryAlerts()).toHaveLength(1);
    expect(entryClears()).toHaveLength(0);
  });

  it('restart: the first healthy sweep emits one reconciliation clear for an incident a previous process left open', async () => {
    const view = sv(makeRuntime(STATIC_CHAIN));
    probeOutcomes({});

    await view.fallback.runChainCanarySweep('startup');
    await view.fallback.runChainCanarySweep('scheduled');

    expect(entryAlerts()).toHaveLength(0);
    expect(entryClears()).toHaveLength(1);
    expect(String(entryClears()[0]?.[2])).toContain('recoveryProof=boot_reconcile');
  });
});

// Bounded classification over the REAL provider strings observed on the fleet.
describe('classifyCanaryFailure', () => {
  it.each([
    ['exit=1 {"error":{"code":"1310","message":"Weekly Limit Exhausted"}}', 'quota'],
    ['exit=1 HTTP 429 too many requests', 'quota'],
    ['exit=1 account <org-a7ef048d> is suspended due to insufficient balance, please recharge', 'auth'],
    ['exit=1 401 unauthorized: invalid api key', 'auth'],
    ['no completion within 90000ms', 'timeout'],
    ['Error: spawn opencode ENOENT', 'spawn'],
    ['exit=0 signal=none (no output)', 'empty'],
    ['exit=2 signal=none something nobody has seen before', 'unknown'],
  ])('classifies %j as %s', (raw, expected) => {
    expect(classifyCanaryFailure(raw)).toBe(expected);
  });

  it('prefers quota over auth when a quota message also carries a 4xx', () => {
    expect(classifyCanaryFailure('exit=1 403 forbidden: monthly quota exceeded')).toBe('quota');
  });
});
