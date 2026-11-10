/**
 * #3832: provider canary readiness is reported before a turn fails.
 *
 * Admission (readProviderCanaryAdmission) refuses a gated CLI provider whose
 * receipt is missing or stale only when a turn reaches it, so an unproven
 * fallback or an upgraded binary stayed invisible while /health read healthy.
 * These cases use real receipt files under a private store, a real executable
 * fake provider that prints its version, and a real proxy file. Admission is
 * asserted beside every readiness result: detection must not relax it.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/emit-alert.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/lib/emit-alert.ts')>(),
  emitAlert: vi.fn(),
}));

vi.mock('../../../src/logger.ts', async () => {
  const { loggerMock } = await import('../../helpers/logger-mock.ts');
  const mock = loggerMock();
  const logger = mock.createChildLogger();
  return {
    ...mock,
    default: { ...logger, child: () => logger },
    flushLogger: vi.fn(),
  };
});

import { config } from '../../../src/config.ts';
import { Database } from '../../../src/core/database.ts';
import { providerMcpProxyScriptPath } from '../../../src/core/provider-mcp-config.ts';
import {
  CANARY_CONTRACT_VERSION,
  collectProviderCanaryEvidence,
  inspectProviderCanaryReadiness,
  readProviderCanaryAdmission,
  type ProviderCanaryEvidence,
  type ProviderCanaryReceipt,
} from '../../../src/runtimes/agent/provider-canary-proof.ts';
import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import { makeMessenger } from './lib/session-harness.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** A real executable that answers `--version` like a provider CLI. */
function writeFakeProvider(path: string, version: string): void {
  writeFileSync(path, ['#!/bin/sh', `printf '%s\\n' '${version}'`, ''].join('\n'));
  chmodSync(path, 0o700);
}

function provisionStore(stateRoot: string): void {
  const store = join(stateRoot, 'provider-canaries');
  mkdirSync(store, { recursive: true, mode: 0o700 });
  chmodSync(store, 0o700);
}

function writeReceipt(stateRoot: string, evidence: ProviderCanaryEvidence): void {
  const receipt: ProviderCanaryReceipt = {
    schemaVersion: 1,
    contractVersion: CANARY_CONTRACT_VERSION,
    recordedAt: new Date(Date.now() - 60_000).toISOString(),
    ...evidence,
    dynamicInitialize: true,
    dynamicToolsList: true,
    staticConnections: 0,
    proxyDescendant: true,
    processGroupReaped: true,
  };
  const path = join(stateRoot, 'provider-canaries', `${evidence.providerId}.json`);
  writeFileSync(path, JSON.stringify(receipt), { mode: 0o600 });
  chmodSync(path, 0o600);
}

interface Fixture {
  stateRoot: string;
  proxy: string;
  binaries: Record<string, string>;
}

function fixture(): Fixture {
  const root = tempRoot('provider-canary-readiness-');
  const stateRoot = join(root, 'state');
  const bin = join(root, 'bin');
  mkdirSync(stateRoot, { mode: 0o700 });
  mkdirSync(bin, { mode: 0o700 });
  const proxy = join(root, 'proxy.ts');
  writeFileSync(proxy, 'proxy fixture');
  const binaries = { 'codex-cli': join(bin, 'codex'), 'claude-cli': join(bin, 'claude') };
  writeFakeProvider(binaries['codex-cli'], 'codex 1.19.3');
  writeFakeProvider(binaries['claude-cli'], 'claude 2.1.0');
  return { stateRoot, proxy, binaries };
}

function inspect(f: Fixture, providerIds: readonly string[], versionTimeoutMs?: number) {
  return inspectProviderCanaryReadiness({
    providerIds,
    resolveBinary: (providerId) => f.binaries[providerId] ?? null,
    proxyScriptPath: f.proxy,
    stateRoot: f.stateRoot,
    sessionScope: 'per_chat',
    sandboxPerChat: false,
    ...(versionTimeoutMs === undefined ? {} : { versionTimeoutMs }),
  });
}

/**
 * A real executable whose `--version` waits `seconds` before printing. The wait runs in a
 * child `sleep` that inherits stdout, so killing the shell alone leaves the pipe open.
 */
function writeSlowProvider(path: string, version: string, seconds: number): void {
  writeFileSync(path, ['#!/bin/sh', `sleep ${seconds}`, `printf '%s\\n' '${version}'`, ''].join('\n'));
  chmodSync(path, 0o700);
}

/** Counts a 10 ms interval's ticks: a blocked event loop leaves the count near zero. */
function tickCounter(): { ticks: () => number; stop: () => void } {
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 10);
  return { ticks: () => ticks, stop: () => clearInterval(timer) };
}

function admit(f: Fixture, providerId: string) {
  return readProviderCanaryAdmission({
    providerId,
    binary: f.binaries[providerId] ?? '',
    proxyScriptPath: f.proxy,
    stateRoot: f.stateRoot,
    sessionScope: 'per_chat',
    sandboxPerChat: false,
  });
}

function prove(f: Fixture, providerId: string): void {
  writeReceipt(
    f.stateRoot,
    collectProviderCanaryEvidence(providerId, f.binaries[providerId] ?? '', f.proxy),
  );
}

describe('inspectProviderCanaryReadiness', () => {
  it('reports a missing primary receipt beside a proven fallback while admission still refuses the primary', async () => {
    const f = fixture();
    provisionStore(f.stateRoot);
    prove(f, 'claude-cli');

    expect(await inspect(f, ['codex-cli', 'claude-cli'])).toEqual([
      { providerId: 'codex-cli', reason: 'missing' },
      { providerId: 'claude-cli', reason: 'proven' },
    ]);
    expect(admit(f, 'codex-cli')).toMatchObject({ allowed: false, required: true });
    // Positive control: the fallback's receipt is honored by admission.
    expect(admit(f, 'claude-cli')).toMatchObject({ allowed: true, required: true });
  });

  it('reports stale after the provider binary reports a new version, and admission refuses it', async () => {
    const f = fixture();
    provisionStore(f.stateRoot);
    prove(f, 'codex-cli');
    expect(await inspect(f, ['codex-cli'])).toEqual([{ providerId: 'codex-cli', reason: 'proven' }]);
    expect(admit(f, 'codex-cli')).toMatchObject({ allowed: true, required: true });

    // An upgrade in place. The new version string has a different length, so
    // the binary's size changes and the stat-keyed evidence cache misses.
    writeFakeProvider(f.binaries['codex-cli'], 'codex 1.19.15');

    expect(await inspect(f, ['codex-cli'])).toEqual([{ providerId: 'codex-cli', reason: 'stale' }]);
    expect(admit(f, 'codex-cli')).toMatchObject({ allowed: false, required: true });
  });

  it('reports nothing when the receipt store is not provisioned, matching not-required admission', async () => {
    const f = fixture();

    expect(await inspect(f, ['codex-cli', 'claude-cli'])).toEqual([]);
    expect(admit(f, 'codex-cli')).toMatchObject({ allowed: true, required: false });
  });

  it('reports every gated provider proven when all receipts match, once each, skipping ungated providers', async () => {
    const f = fixture();
    provisionStore(f.stateRoot);
    prove(f, 'codex-cli');
    prove(f, 'claude-cli');

    const entries = await inspect(f, ['codex-cli', 'openai-api', 'claude-cli', 'codex-cli']);
    expect(entries).toEqual([
      { providerId: 'codex-cli', reason: 'proven' },
      { providerId: 'claude-cli', reason: 'proven' },
    ]);
    expect(entries.filter((entry) => entry.reason !== 'proven')).toEqual([]);
  });

  it('classifies an unresolvable binary as unavailable and an unparsable receipt as malformed', async () => {
    const f = fixture();
    provisionStore(f.stateRoot);
    prove(f, 'codex-cli');
    const receiptPath = join(f.stateRoot, 'provider-canaries', 'claude-cli.json');
    writeFileSync(receiptPath, '{not json', { mode: 0o600 });
    chmodSync(receiptPath, 0o600);
    rmSync(f.binaries['codex-cli']);

    expect(await inspect(f, ['codex-cli', 'claude-cli'])).toEqual([
      { providerId: 'codex-cli', reason: 'unavailable' },
      { providerId: 'claude-cli', reason: 'malformed' },
    ]);
    expect(admit(f, 'codex-cli')).toMatchObject({ allowed: false, required: true });
    expect(admit(f, 'claude-cli')).toMatchObject({ allowed: false, required: true });
  });

  it('keeps timers running while a provider --version hangs, then reports unavailable at the deadline', async () => {
    const f = fixture();
    provisionStore(f.stateRoot);
    // A receipt is present, so the version child must run; nothing has cached this binary.
    writeReceipt(f.stateRoot, {
      providerId: 'codex-cli',
      platform: process.platform,
      architecture: process.arch,
      binaryVersion: 'codex 1.19.3',
      entrypointDigest: 'a'.repeat(64),
      proxyDigest: 'b'.repeat(64),
    });
    writeSlowProvider(f.binaries['codex-cli'], 'codex 1.19.3', 30);
    const counter = tickCounter();
    const started = Date.now();
    try {
      const entries = await inspect(f, ['codex-cli'], 400);
      const elapsed = Date.now() - started;
      expect(entries).toEqual([{ providerId: 'codex-cli', reason: 'unavailable' }]);
      // Bounded by the deadline even though the sleeping descendant still holds stdout.
      expect(elapsed).toBeGreaterThanOrEqual(350);
      expect(elapsed).toBeLessThan(3_000);
      // About 40 ticks fit in 400 ms; a synchronous wait would allow none.
      expect(counter.ticks()).toBeGreaterThanOrEqual(15);
    } finally {
      counter.stop();
    }
    // Detection never relaxes admission.
    expect(admit(f, 'codex-cli')).toMatchObject({ allowed: false, required: true });
  });

  it('proves a slow but answering provider within the deadline without blocking timers', async () => {
    const f = fixture();
    provisionStore(f.stateRoot);
    writeSlowProvider(f.binaries['codex-cli'], 'codex 1.19.3', 0.5);
    // The override fills a different cache key, so readiness must run the slow child itself.
    writeReceipt(
      f.stateRoot,
      collectProviderCanaryEvidence('codex-cli', f.binaries['codex-cli'] ?? '', f.proxy, 'codex 1.19.3'),
    );
    const counter = tickCounter();
    try {
      expect(await inspect(f, ['codex-cli'], 5_000)).toEqual([{ providerId: 'codex-cli', reason: 'proven' }]);
      expect(counter.ticks()).toBeGreaterThanOrEqual(20);
    } finally {
      counter.stop();
    }
    expect(admit(f, 'codex-cli')).toMatchObject({ allowed: true, required: true });
  });
});

interface CanaryRuntimeState {
  agentProvider: string;
  agentFallbacks: Array<{ provider: string; model?: string }>;
  refreshProviderCanaryReadiness(): Promise<void>;
}

describe('AgentRuntime health — provider canary readiness', () => {
  const originalPath = process.env.PATH;
  const store = join(config.stateRoot, 'provider-canaries');
  let db: Database;
  let bin: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    bin = tempRoot('provider-canary-runtime-bin-');
    writeFakeProvider(join(bin, 'claude'), 'claude 2.1.0');
    writeFakeProvider(join(bin, 'codex'), 'codex 1.19.3');
    // The runtime resolves provider binaries by name from PATH, as admission does.
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`;
    provisionStore(config.stateRoot);
  });

  afterEach(() => {
    db.close();
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(store, { recursive: true, force: true });
  });

  it('names the unproven fallback by id and class only, and clears once its receipt is proven', async () => {
    const runtime = new AgentRuntime(db, makeMessenger().messenger, 'canary-readiness', {
      sessionScope: 'per_chat',
    });
    const state = runtime as unknown as CanaryRuntimeState;
    state.agentProvider = 'claude-cli';
    state.agentFallbacks = [{ provider: 'codex-cli', model: 'gpt-5.1-codex' }];
    const proxy = providerMcpProxyScriptPath();
    writeReceipt(config.stateRoot, collectProviderCanaryEvidence('claude-cli', 'claude', proxy));

    await state.refreshProviderCanaryReadiness();
    const degraded = runtime.getHealthSnapshot();
    const degradedDetails = degraded.details as Record<string, unknown>;
    expect(degraded.status).toBe('degraded');
    expect(degradedDetails['degradedReasons']).toContain('provider_canary_unproven');
    expect(degradedDetails['providerCanaryUnproven']).toEqual([
      { providerId: 'codex-cli', reason: 'missing' },
    ]);
    // Bounded classes only: no path, digest or version reaches health.
    const surfaced = JSON.stringify(degradedDetails['providerCanaryUnproven']);
    expect(surfaced).not.toContain(bin);
    expect(surfaced).not.toContain(config.stateRoot);
    expect(surfaced).not.toMatch(/[a-f0-9]{64}/);
    expect(surfaced).not.toContain('1.19.3');

    writeReceipt(config.stateRoot, collectProviderCanaryEvidence('codex-cli', 'codex', proxy));
    await state.refreshProviderCanaryReadiness();
    const repairedDetails = runtime.getHealthSnapshot().details as Record<string, unknown>;
    expect(repairedDetails['degradedReasons']).not.toContain('provider_canary_unproven');
    expect(repairedDetails['providerCanaryUnproven']).toEqual([]);
  });

  it('answers health and runs timers while a slow fallback --version is probed, with one probe in flight', async () => {
    const runtime = new AgentRuntime(db, makeMessenger().messenger, 'canary-readiness-slow', {
      sessionScope: 'per_chat',
    });
    const state = runtime as unknown as CanaryRuntimeState;
    state.agentProvider = 'claude-cli';
    state.agentFallbacks = [{ provider: 'codex-cli', model: 'gpt-5.1-codex' }];
    const proxy = providerMcpProxyScriptPath();
    writeReceipt(config.stateRoot, collectProviderCanaryEvidence('claude-cli', 'claude', proxy));
    writeReceipt(config.stateRoot, collectProviderCanaryEvidence('codex-cli', 'codex', proxy));
    // Upgrade in place to a binary that takes 1 s to answer with a new version.
    writeSlowProvider(join(bin, 'codex'), 'codex 1.19.15', 1);

    const counter = tickCounter();
    const called = Date.now();
    const first = state.refreshProviderCanaryReadiness();
    try {
      // A synchronous version read would hold this call for the full second.
      expect(Date.now() - called).toBeLessThan(200);
      // Single flight: another tick while the probe runs joins it instead of spawning again.
      expect(state.refreshProviderCanaryReadiness()).toBe(first);
      // Health answers during the probe from the last completed result.
      const during = runtime.getHealthSnapshot().details as Record<string, unknown>;
      expect(during['providerCanaryUnproven']).toEqual([]);
      await first;
      expect(counter.ticks()).toBeGreaterThanOrEqual(40);
    } finally {
      counter.stop();
    }
    const details = runtime.getHealthSnapshot().details as Record<string, unknown>;
    expect(details['degradedReasons']).toContain('provider_canary_unproven');
    expect(details['providerCanaryUnproven']).toEqual([{ providerId: 'codex-cli', reason: 'stale' }]);
    // The flight is released: the next tick starts a fresh probe.
    const next = state.refreshProviderCanaryReadiness();
    expect(next).not.toBe(first);
    await next;
  }, 15_000);
});
