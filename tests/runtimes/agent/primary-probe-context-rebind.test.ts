// A primary-model probe after an in-place CLI update. Agent children resolve the
// CLI again on every spawn, so a probe whose only change is the resolved binary
// adopts it once (a rebind) instead of refusing on every run. Every other
// context change still refuses, alerts and logs. When a provider canary is
// required, it must admit the new binary first. Only a probe result resolves a
// context refusal: a turn success says nothing about the probe's binding.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/logger.ts', async () => {
  const { singletonLoggerMock } = await import('../../helpers/logger-mock.ts');
  const runtimeLogger = singletonLoggerMock();
  return {
    default: { ...runtimeLogger, child: () => runtimeLogger },
    createChildLogger: () => runtimeLogger,
    flushLogger: () => Promise.resolve(),
  };
});

vi.mock('../../../src/lib/emit-alert.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/lib/emit-alert.ts')>(),
  emitAlert: vi.fn(() => ({ ok: true, channel: 'outbox', status: 'durably_queued' })),
  emitAlertChecked: vi.fn(() => true),
  clearAlertSourceChecked: vi.fn(() => true),
}));

import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../../src/core/database.ts';
import { clearAlertSourceChecked, emitAlertChecked } from '../../../src/lib/emit-alert.ts';
import {
  resolveProviderBinaryIdentity,
  type ProviderAdmission,
} from '../../../src/runtimes/agent/provider-canary-proof.ts';
import {
  buildPrimaryProbeEnv,
  buildPrimaryProbeServiceContext,
  createPrimaryModelProbeAdapters,
  type PrimaryModelProbeAdapterDeps,
} from '../../../src/runtimes/agent/providers/primary-model-usability-adapters.ts';
import {
  probePrimaryModelUsability,
  type PrimaryModelUsabilityResult,
  type PrimaryProbeServiceContext,
} from '../../../src/runtimes/agent/providers/primary-model-usability.ts';
import { makeRuntimeState, type RuntimeState } from './lib/runtime-terminal-coordinator-harness.ts';

const MODEL = 'configured-primary';
const TARGET = { provider: 'claude-cli', model: MODEL };
const LAUNCHER = 'provider-cli';
const STRICT_HELP = '  --strict-mcp-config  Only use MCP servers from --mcp-config';
const UNUSABLE = 'primary_model_unusable';
const REFUSED_EVENT = 'primary_model_probe_context_refused';
const RESTART_REQUIRED = 'context-binary-changed-restart-required';

const REFUSED: PrimaryModelUsabilityResult = {
  status: 'unknown', provider: 'claude-cli', model: MODEL, reason: 'context-mismatch-binary-path',
};
const USABLE: PrimaryModelUsabilityResult = { status: 'usable', provider: 'claude-cli', model: MODEL };
// The shape runtime.ts records after a successful turn (source 'turn-success').
const TURN_SUCCESS: PrimaryModelUsabilityResult = {
  status: 'usable', provider: 'claude-cli', model: MODEL, reason: 'turn-success',
};
const TIMEOUT: PrimaryModelUsabilityResult = {
  status: 'timeout', provider: 'claude-cli', model: MODEL, reason: 'probe-timeout',
};

type UsabilitySource = 'probe' | 'turn-success';
interface RebindDeps {
  rebindServiceContext?: (previous: PrimaryProbeServiceContext, next: PrimaryProbeServiceContext) => boolean;
  providerCanaryAdmission?: () => ProviderAdmission | Promise<ProviderAdmission>;
}
type UsabilityState = RuntimeState & {
  primaryModelUsability: PrimaryModelUsabilityResult | null;
  primaryProbeServiceContext: PrimaryProbeServiceContext | null;
  fallback: {
    recordPrimaryModelUsability(
      result: PrimaryModelUsabilityResult,
      trigger: 'startup' | 'manual' | 'periodic',
      source?: UsabilitySource,
    ): void;
  };
};

interface Install {
  root: string;
  binDir: string;
  /** Real path of one installed version. */
  version(label: string): string;
  /** Point the launcher symlink at one installed version; PATH stays the same. */
  point(label: string): void;
}

const roots: string[] = [];
let db: Database;

/** A CLI install shaped like a versioned native install: bin/<launcher> -> versions/<label>. */
function install(labels: string[]): Install {
  const root = mkdtempSync(join(tmpdir(), 'primary-probe-rebind-'));
  roots.push(root);
  const binDir = join(root, 'bin');
  const versions = join(root, 'versions');
  mkdirSync(binDir);
  mkdirSync(versions);
  for (const label of labels) {
    const file = join(versions, label);
    writeFileSync(file, `#!/bin/sh\nprintf '${label}\\n'\n`);
    chmodSync(file, 0o755);
  }
  const launcher = join(binDir, LAUNCHER);
  const point = (label: string): void => {
    rmSync(launcher, { force: true });
    symlinkSync(join(versions, label), launcher);
  };
  point(labels[0]!);
  return { root, binDir, version: (label) => realpathSync(join(versions, label)), point };
}

function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** The runtime's start-time context, built from the same probe environment. Stub PATH first. */
function capture(
  binDir: string,
  over: Partial<Parameters<typeof buildPrimaryProbeServiceContext>[0]> = {},
): PrimaryProbeServiceContext {
  return buildPrimaryProbeServiceContext({
    provider: 'claude-cli',
    model: MODEL,
    serviceGeneration: 'generation-a',
    cwd: '',
    selectorEnv: buildPrimaryProbeEnv('claude-cli', MODEL, undefined, {}),
    binaryState: 'resolved',
    binaryIdentity: resolveProviderBinaryIdentity(LAUNCHER, binDir),
    ...over,
  });
}

function harness(input: {
  expected: PrimaryProbeServiceContext;
  onHelp?: () => void;
  rebind?: (previous: PrimaryProbeServiceContext, next: PrimaryProbeServiceContext) => boolean;
  canary?: () => Promise<ProviderAdmission>;
}) {
  const warn = vi.fn();
  const info = vi.fn();
  const help = vi.fn(async () => {
    input.onHelp?.();
    return { status: 'ok' as const, output: STRICT_HELP };
  });
  const modelProbe = vi.fn(async () => ({ status: 'ok' as const, output: 'OK' }));
  const rebind = vi.fn(input.rebind ?? (() => true));
  const log = { info, warn };
  const rebindDeps: RebindDeps = {
    rebindServiceContext: rebind,
    ...(input.canary ? { providerCanaryAdmission: input.canary } : {}),
  };
  const deps = {
    getProviderBinary: () => LAUNCHER,
    resolveProviderBinaryIdentity: (binary: string, pathValue: string) => resolveProviderBinaryIdentity(binary, pathValue),
    ensureClaudeFileStoreCredential: () => ({ outcome: 'skipped-cli-reads-own-item' as const }),
    refreshClaudeLoginAhead: vi.fn(async () => undefined),
    probeClaudeCliHelp: help,
    probeBinaryCommand: modelProbe,
    serviceContext: input.expected,
    requireServiceContext: true,
    probeTrigger: 'periodic' as const,
    log,
    ...rebindDeps,
  } as PrimaryModelProbeAdapterDeps;
  return { deps, help, modelProbe, rebind, warn, info };
}

function refusals(warn: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return (warn.mock.calls as Array<[Record<string, unknown>, string]>)
    .map(([fields]) => fields)
    .filter((fields) => fields.event === REFUSED_EVENT);
}

function recorder(): { state: UsabilityState; record: (result: PrimaryModelUsabilityResult, source?: UsabilitySource) => void } {
  const { state } = makeRuntimeState<UsabilityState>(db);
  return { state, record: (result, source = 'probe') => state.fallback.recordPrimaryModelUsability(result, 'manual', source) };
}

const raises = (source: string): number =>
  vi.mocked(emitAlertChecked).mock.calls.filter(([, alertSource]) => alertSource === source).length;
const clears = (source: string): number =>
  vi.mocked(clearAlertSourceChecked).mock.calls.filter(([, alertSource]) => alertSource === source).length;

describe('primary probe service context after an in-place CLI update', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    vi.mocked(emitAlertChecked).mockReset().mockReturnValue(true);
    vi.mocked(clearAlertSourceChecked).mockReset().mockReturnValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    db.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('a: a path-only change logs one refusal, rebinds once, probes the new binary and records usable without an alert', async () => {
    const { state, record } = recorder();
    const cli = install(['1.0.0', '1.0.1']);
    vi.stubEnv('PATH', cli.binDir);
    const expected = capture(cli.binDir);
    cli.point('1.0.1');
    const probe = harness({ expected });

    const result = await probePrimaryModelUsability(TARGET, createPrimaryModelProbeAdapters(undefined, probe.deps));

    expect(result).toMatchObject({ status: 'usable', provider: 'claude-cli', model: MODEL });
    expect(refusals(probe.warn)).toEqual([expect.objectContaining({
      trigger: 'periodic',
      provider: 'claude-cli',
      reason: 'context-mismatch-binary-path',
      field: 'resolvedBinaryPathHash',
      currentBinaryLabel: '1.0.1',
    })]);
    expect(JSON.stringify([probe.warn.mock.calls, probe.info.mock.calls])).not.toMatch(/primary-probe-rebind-|\/versions\//);
    expect(probe.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'primary_model_probe_context_rebound', provider: 'claude-cli', currentBinaryLabel: '1.0.1' }),
      expect.any(String),
    );
    expect(probe.rebind).toHaveBeenCalledTimes(1);
    const [previous, next] = probe.rebind.mock.calls[0] as [PrimaryProbeServiceContext, PrimaryProbeServiceContext];
    expect(previous).toBe(expected);
    expect(next).toMatchObject({
      provider: expected.provider,
      model: expected.model,
      serviceGeneration: expected.serviceGeneration,
      launchContextHash: expected.launchContextHash,
      binaryState: 'resolved',
      binarySha256: sha256Of(cli.version('1.0.1')),
    });
    expect(next.resolvedBinaryPathHash).not.toBe(expected.resolvedBinaryPathHash);
    expect(probe.help).toHaveBeenCalledTimes(1);
    expect(probe.modelProbe).toHaveBeenCalledExactlyOnceWith(
      cli.version('1.0.1'),
      expect.any(Array),
      expect.any(Object),
      expect.any(Object),
    );

    record(result);
    expect(raises(UNUSABLE)).toBe(0);
    expect(state.primaryModelUsability).toMatchObject({ status: 'usable' });
  });

  it('a: the runtime adopts a rebind only over the context it still holds', () => {
    const { state } = recorder();
    const host = (state.fallback as unknown as { host: Record<string, unknown> }).host;
    expect(typeof host.primaryProbeRebindDeps).toBe('function');
    const deps = (host.primaryProbeRebindDeps as () => RebindDeps)();
    const previous: PrimaryProbeServiceContext = {
      provider: 'claude-cli',
      model: MODEL,
      serviceGeneration: 'generation-a',
      launchContextHash: 'launch-a',
      binaryState: 'resolved',
      resolvedBinaryPathHash: 'path-a',
      binarySha256: 'a'.repeat(64),
    };
    const next = { ...previous, resolvedBinaryPathHash: 'path-b', binarySha256: 'b'.repeat(64) };
    state.primaryProbeServiceContext = previous;

    expect(deps.rebindServiceContext?.(previous, next)).toBe(true);
    expect(state.primaryProbeServiceContext).toBe(next);
    // A second adoption from the same stale previous context loses to the first.
    expect(deps.rebindServiceContext?.(previous, { ...next, binarySha256: 'c'.repeat(64) })).toBe(false);
    expect(state.primaryProbeServiceContext).toBe(next);
  });

  it.each([
    ['provider', { provider: 'opencode-cli' }, 'context-mismatch-provider', 'provider'],
    ['model', { model: 'previous-model' }, 'context-mismatch-model', 'model'],
    ['launch selector', { cwd: 'previous-cwd' }, 'context-mismatch-launch', 'launchContextHash'],
    ['binary state', { binaryState: 'missing' as const, binaryIdentity: null }, 'context-mismatch-binary-state', 'binaryState'],
  ])('b: a %s mismatch with a path change still refuses, alerts and logs, without a rebind', async (_label, over, reason, field) => {
    const { record } = recorder();
    const cli = install(['1.0.0', '1.0.1']);
    vi.stubEnv('PATH', cli.binDir);
    const expected = capture(cli.binDir, over);
    cli.point('1.0.1');
    const probe = harness({ expected });

    const result = await probePrimaryModelUsability(TARGET, createPrimaryModelProbeAdapters(undefined, probe.deps));

    expect(result).toMatchObject({ status: 'unknown', reason });
    expect(refusals(probe.warn)).toEqual([expect.objectContaining({ reason, field, provider: 'claude-cli' })]);
    expect(probe.rebind).not.toHaveBeenCalled();
    expect(probe.help).not.toHaveBeenCalled();
    expect(probe.modelProbe).not.toHaveBeenCalled();
    record(result);
    expect(raises(UNUSABLE)).toBe(1);
  });

  it('b: a service generation change under the probe, where the runtime declines the rebind, keeps the refusal', async () => {
    const { record } = recorder();
    const cli = install(['1.0.0', '1.0.1']);
    vi.stubEnv('PATH', cli.binDir);
    const expected = capture(cli.binDir);
    cli.point('1.0.1');
    // The runtime's compare-and-set fails: a new generation replaced the context the probe started from.
    const probe = harness({ expected, rebind: () => false });

    const result = await probePrimaryModelUsability(TARGET, createPrimaryModelProbeAdapters(undefined, probe.deps));

    expect(result).toMatchObject({ status: 'unknown', reason: 'context-mismatch-binary-path' });
    expect(probe.rebind).toHaveBeenCalledTimes(1);
    expect(refusals(probe.warn)).toHaveLength(1);
    expect(probe.modelProbe).not.toHaveBeenCalled();
    record(result);
    expect(raises(UNUSABLE)).toBe(1);
  });

  it('c: a second binary change inside one probe refuses without a second rebind', async () => {
    const cli = install(['1.0.0', '1.0.1', '1.0.2']);
    vi.stubEnv('PATH', cli.binDir);
    const expected = capture(cli.binDir);
    cli.point('1.0.1');
    // The CLI updates again while its help output is being read.
    const probe = harness({ expected, onHelp: () => cli.point('1.0.2') });

    await expect(
      createPrimaryModelProbeAdapters(undefined, probe.deps).probeBinaryModel?.(TARGET),
    ).resolves.toEqual({ status: 'unknown', reason: 'context-mismatch-binary-path' });

    expect(probe.rebind).toHaveBeenCalledTimes(1);
    expect(probe.help).toHaveBeenCalledTimes(1);
    expect(probe.modelProbe).not.toHaveBeenCalled();
    expect(refusals(probe.warn).map((fields) => fields.reason)).toEqual([
      'context-mismatch-binary-path',
      'context-mismatch-binary-path',
    ]);
  });

  it('d: a turn success does not clear a context refusal or its alert; only a probe result does', () => {
    const { state, record } = recorder();

    record(REFUSED);
    record(TURN_SUCCESS, 'turn-success');
    expect(raises(UNUSABLE)).toBe(1);
    expect(clears(UNUSABLE)).toBe(0);
    expect(state.primaryModelUsability).toMatchObject({ status: 'unknown', reason: 'context-mismatch-binary-path' });

    record(USABLE);
    expect(clears(UNUSABLE)).toBe(1);

    // With no context refusal active, a turn success still clears a probe failure.
    record(TIMEOUT);
    record(TURN_SUCCESS, 'turn-success');
    expect(raises(UNUSABLE)).toBe(2);
    expect(clears(UNUSABLE)).toBe(2);
  });

  it.each([
    ['its receipt is stale', (): (() => Promise<ProviderAdmission>) => async () => {
      throw new Error('provider MCP canary proof unavailable');
    }],
    ['its admission names another binary', (cli: Install): (() => Promise<ProviderAdmission>) => async () => ({
      allowed: true,
      required: true,
      resolvedPath: cli.version('1.0.0'),
      binarySha256: sha256Of(cli.version('1.0.0')),
      proxyScriptSha256: 'b'.repeat(64),
    })],
  ])('e: a required canary keeps the refusal and its alert after a path-only change when %s', async (_label, admission) => {
    const { state, record } = recorder();
    const cli = install(['1.0.0', '1.0.1']);
    vi.stubEnv('PATH', cli.binDir);
    const expected = capture(cli.binDir);
    cli.point('1.0.1');
    const canary = vi.fn(admission(cli));
    const probe = harness({ expected, canary });

    const result = await probePrimaryModelUsability(TARGET, createPrimaryModelProbeAdapters(undefined, probe.deps));

    expect(result).toMatchObject({ status: 'unknown', reason: RESTART_REQUIRED });
    expect(canary).toHaveBeenCalledTimes(1);
    expect(probe.rebind).not.toHaveBeenCalled();
    expect(probe.modelProbe).not.toHaveBeenCalled();
    expect(refusals(probe.warn)).toEqual([expect.objectContaining({ reason: 'context-mismatch-binary-path' })]);

    record(result);
    record(TURN_SUCCESS, 'turn-success');
    expect(raises(UNUSABLE)).toBe(1);
    expect(clears(UNUSABLE)).toBe(0);
    expect(state.primaryModelUsability).toMatchObject({ status: 'unknown', reason: RESTART_REQUIRED });
  });

  it('e: a required canary that admits the new binary allows the rebind', async () => {
    const cli = install(['1.0.0', '1.0.1']);
    vi.stubEnv('PATH', cli.binDir);
    const expected = capture(cli.binDir);
    cli.point('1.0.1');
    const canary = vi.fn(async (): Promise<ProviderAdmission> => ({
      allowed: true,
      required: true,
      resolvedPath: cli.version('1.0.1'),
      binarySha256: sha256Of(cli.version('1.0.1')),
      proxyScriptSha256: 'b'.repeat(64),
    }));
    const probe = harness({ expected, canary });

    const result = await probePrimaryModelUsability(TARGET, createPrimaryModelProbeAdapters(undefined, probe.deps));

    expect(result).toMatchObject({ status: 'usable' });
    expect(canary).toHaveBeenCalledTimes(1);
    expect(probe.rebind).toHaveBeenCalledTimes(1);
    expect(probe.modelProbe).toHaveBeenCalledExactlyOnceWith(
      cli.version('1.0.1'),
      expect.any(Array),
      expect.any(Object),
      expect.any(Object),
    );
  });
});
