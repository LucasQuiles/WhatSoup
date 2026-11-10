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

function inspect(f: Fixture, providerIds: readonly string[]) {
  return inspectProviderCanaryReadiness({
    providerIds,
    resolveBinary: (providerId) => f.binaries[providerId] ?? null,
    proxyScriptPath: f.proxy,
    stateRoot: f.stateRoot,
    sessionScope: 'per_chat',
    sandboxPerChat: false,
  });
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
  it('reports a missing primary receipt beside a proven fallback while admission still refuses the primary', () => {
    const f = fixture();
    provisionStore(f.stateRoot);
    prove(f, 'claude-cli');

    expect(inspect(f, ['codex-cli', 'claude-cli'])).toEqual([
      { providerId: 'codex-cli', reason: 'missing' },
      { providerId: 'claude-cli', reason: 'proven' },
    ]);
    expect(admit(f, 'codex-cli')).toMatchObject({ allowed: false, required: true });
    // Positive control: the fallback's receipt is honored by admission.
    expect(admit(f, 'claude-cli')).toMatchObject({ allowed: true, required: true });
  });

  it('reports stale after the provider binary reports a new version, and admission refuses it', () => {
    const f = fixture();
    provisionStore(f.stateRoot);
    prove(f, 'codex-cli');
    expect(inspect(f, ['codex-cli'])).toEqual([{ providerId: 'codex-cli', reason: 'proven' }]);
    expect(admit(f, 'codex-cli')).toMatchObject({ allowed: true, required: true });

    // An upgrade in place. The new version string has a different length, so
    // the binary's size changes and the stat-keyed evidence cache misses.
    writeFakeProvider(f.binaries['codex-cli'], 'codex 1.19.15');

    expect(inspect(f, ['codex-cli'])).toEqual([{ providerId: 'codex-cli', reason: 'stale' }]);
    expect(admit(f, 'codex-cli')).toMatchObject({ allowed: false, required: true });
  });

  it('reports nothing when the receipt store is not provisioned, matching not-required admission', () => {
    const f = fixture();

    expect(inspect(f, ['codex-cli', 'claude-cli'])).toEqual([]);
    expect(admit(f, 'codex-cli')).toMatchObject({ allowed: true, required: false });
  });

  it('reports every gated provider proven when all receipts match, once each, skipping ungated providers', () => {
    const f = fixture();
    provisionStore(f.stateRoot);
    prove(f, 'codex-cli');
    prove(f, 'claude-cli');

    const entries = inspect(f, ['codex-cli', 'openai-api', 'claude-cli', 'codex-cli']);
    expect(entries).toEqual([
      { providerId: 'codex-cli', reason: 'proven' },
      { providerId: 'claude-cli', reason: 'proven' },
    ]);
    expect(entries.filter((entry) => entry.reason !== 'proven')).toEqual([]);
  });

  it('classifies an unresolvable binary as unavailable and an unparsable receipt as malformed', () => {
    const f = fixture();
    provisionStore(f.stateRoot);
    prove(f, 'codex-cli');
    const receiptPath = join(f.stateRoot, 'provider-canaries', 'claude-cli.json');
    writeFileSync(receiptPath, '{not json', { mode: 0o600 });
    chmodSync(receiptPath, 0o600);
    rmSync(f.binaries['codex-cli']);

    expect(inspect(f, ['codex-cli', 'claude-cli'])).toEqual([
      { providerId: 'codex-cli', reason: 'unavailable' },
      { providerId: 'claude-cli', reason: 'malformed' },
    ]);
    expect(admit(f, 'codex-cli')).toMatchObject({ allowed: false, required: true });
    expect(admit(f, 'claude-cli')).toMatchObject({ allowed: false, required: true });
  });
});

interface CanaryRuntimeState {
  agentProvider: string;
  agentFallbacks: Array<{ provider: string; model?: string }>;
  refreshProviderCanaryReadiness(): void;
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

  it('names the unproven fallback by id and class only, and clears once its receipt is proven', () => {
    const runtime = new AgentRuntime(db, makeMessenger().messenger, 'canary-readiness', {
      sessionScope: 'per_chat',
    });
    const state = runtime as unknown as CanaryRuntimeState;
    state.agentProvider = 'claude-cli';
    state.agentFallbacks = [{ provider: 'codex-cli', model: 'gpt-5.1-codex' }];
    const proxy = providerMcpProxyScriptPath();
    writeReceipt(config.stateRoot, collectProviderCanaryEvidence('claude-cli', 'claude', proxy));

    state.refreshProviderCanaryReadiness();
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
    state.refreshProviderCanaryReadiness();
    const repairedDetails = runtime.getHealthSnapshot().details as Record<string, unknown>;
    expect(repairedDetails['degradedReasons']).not.toContain('provider_canary_unproven');
    expect(repairedDetails['providerCanaryUnproven']).toEqual([]);
  });
});
