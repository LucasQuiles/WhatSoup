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

// The scheduler tests capture the deps the production scheduler hands to the
// probe adapters and stop the real probe there; every other test calls the real factory.
const adapterSeam = vi.hoisted(() => ({
  capture: false,
  calls: [] as Array<{ deps: Record<string, unknown> }>,
  /** What a captured scheduler probe runs instead of the real adapters. */
  adapters: {} as Record<string, unknown>,
}));
vi.mock('../../../src/runtimes/agent/providers/primary-model-usability-adapters.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/runtimes/agent/providers/primary-model-usability-adapters.ts')>();
  return {
    ...actual,
    createPrimaryModelProbeAdapters: (...args: Parameters<typeof actual.createPrimaryModelProbeAdapters>) => {
      if (!adapterSeam.capture) return actual.createPrimaryModelProbeAdapters(...args);
      adapterSeam.calls.push({ deps: (args[1] ?? {}) as Record<string, unknown> });
      return adapterSeam.adapters;
    },
  };
});

import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../../../src/config.ts';
import { Database } from '../../../src/core/database.ts';
import { clearAlertSourceChecked, emitAlertChecked } from '../../../src/lib/emit-alert.ts';
import { createChildLogger } from '../../../src/logger.ts';
import { deferred } from '../../helpers/deferred.ts';
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
  DEFERRED_REFRESH_IN_FLIGHT,
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
// A provider failure after a child ran, not a service-context refusal.
const OVERFLOW: PrimaryModelUsabilityResult = {
  status: 'unknown', provider: 'claude-cli', model: MODEL, reason: 'context-overflow',
};
// A non-alerting probe result: refresh-ahead held the probe.
const DEFERRED: PrimaryModelUsabilityResult = {
  status: 'unknown', provider: 'claude-cli', model: MODEL, reason: DEFERRED_REFRESH_IN_FLIGHT,
};
const STALE_LINE = 'primary model usability refreshed by turn success after going stale';
const HEX8 = /^[0-9a-f]{8}$/;

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
    schedulePrimaryModelUsabilityProbe(trigger: 'startup' | 'manual' | 'periodic'): void;
  };
  recordTurnCapabilitySuccess(isUserTurnResult: boolean): void;
};
/** Private runtime fields the scheduler tests set directly. */
type SchedulerState = UsabilityState & {
  agentProvider: string;
  model: string | undefined;
  sessionScope: string;
  sandboxPerChat: boolean;
};

interface Install {
  root: string;
  binDir: string;
  /** Real path of one installed version. */
  version(label: string): string;
  /** Point the launcher symlink at one installed version; PATH stays the same. */
  point(label: string): void;
  /** Replace the target file's bytes in place: the resolved path stays the same. */
  rewrite(label: string, body: string): void;
}

const roots: string[] = [];
let db: Database;
// The config object is typed read-only; the scheduler tests point its state root at a temporary folder.
const mutableConfig = config as unknown as { stateRoot: string };
const savedStateRoot = mutableConfig.stateRoot;
// The logger mock hands every module the same logger, so this is the runtime's logger.
const runtimeLog = createChildLogger('test') as unknown as { info: ReturnType<typeof vi.fn> };

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
  const rewrite = (label: string, body: string): void => {
    const file = join(versions, label);
    writeFileSync(file, `#!/bin/sh\nprintf '${body}\\n'\n`);
    chmodSync(file, 0o755);
  };
  point(labels[0]!);
  return { root, binDir, version: (label) => realpathSync(join(versions, label)), point, rewrite };
}

/** Same bytes, different resolved path: the launcher moves to a copy of the current target. */
function pointAtCopy(cli: Install, from: string, to: string): void {
  copyFileSync(cli.version(from), join(cli.root, 'versions', to));
  chmodSync(join(cli.root, 'versions', to), 0o755);
  cli.point(to);
}

/**
 * A real runtime set up as a per-chat claude instance. With `canaryStore`, its
 * state root is a fresh folder, holding an empty canary store when true.
 */
function schedulerRuntime(options: { canaryStore?: boolean } = {}): { state: SchedulerState; recordSpy: unknown } {
  const { state } = makeRuntimeState<SchedulerState>(db);
  state.agentProvider = 'claude-cli';
  state.sessionScope = 'per_chat';
  state.sandboxPerChat = false;
  if (options.canaryStore !== undefined) {
    const root = mkdtempSync(join(tmpdir(), 'primary-probe-state-'));
    roots.push(root);
    if (options.canaryStore) mkdirSync(join(root, 'provider-canaries'));
    mutableConfig.stateRoot = root;
  }
  return { state, recordSpy: vi.spyOn(state.fallback, 'recordPrimaryModelUsability') };
}

/** Run the production scheduler once, take the deps it hands the probe adapters, and let its inert probe settle. */
async function scheduledProbeDeps(state: SchedulerState, recordSpy: unknown): Promise<RebindDeps & Record<string, unknown>> {
  adapterSeam.capture = true;
  state.fallback.schedulePrimaryModelUsabilityProbe('manual');
  adapterSeam.capture = false;
  await vi.waitFor(() => expect(recordSpy).toHaveBeenCalledWith(expect.anything(), 'manual'));
  const deps = (adapterSeam.calls.at(-1)?.deps ?? {}) as RebindDeps & Record<string, unknown>;
  expect(typeof deps.rebindServiceContext).toBe('function');
  expect(typeof deps.providerCanaryAdmission).toBe('function');
  expect(deps.serviceContext).toBe(state.primaryProbeServiceContext);
  return deps;
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
  refresh?: (binary: string, env: NodeJS.ProcessEnv) => Promise<unknown>;
}) {
  const warn = vi.fn();
  const info = vi.fn();
  const help = vi.fn(async () => {
    input.onHelp?.();
    return { status: 'ok' as const, output: STRICT_HELP };
  });
  const modelProbe = vi.fn(async () => ({ status: 'ok' as const, output: 'OK' }));
  const rebind = vi.fn(input.rebind ?? (() => true));
  const refresh = vi.fn(input.refresh ?? (async () => undefined));
  const log = { info, warn };
  const rebindDeps: RebindDeps = {
    rebindServiceContext: rebind,
    ...(input.canary ? { providerCanaryAdmission: input.canary } : {}),
  };
  const deps = {
    getProviderBinary: () => LAUNCHER,
    resolveProviderBinaryIdentity: (binary: string, pathValue: string) => resolveProviderBinaryIdentity(binary, pathValue),
    ensureClaudeFileStoreCredential: () => ({ outcome: 'skipped-cli-reads-own-item' as const }),
    refreshClaudeLoginAhead: refresh,
    probeClaudeCliHelp: help,
    probeBinaryCommand: modelProbe,
    serviceContext: input.expected,
    requireServiceContext: true,
    probeTrigger: 'periodic' as const,
    log,
    ...rebindDeps,
  } as PrimaryModelProbeAdapterDeps;
  return { deps, help, modelProbe, rebind, refresh, warn, info };
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
    adapterSeam.capture = false;
    adapterSeam.calls.length = 0;
    adapterSeam.adapters = {};
    mutableConfig.stateRoot = savedStateRoot;
    db.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('a: a launcher retarget that changes path and SHA logs one refusal, rebinds once, probes the new binary and records usable without an alert', async () => {
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

  it('a: the runtime adopts a rebind only over the context it still holds', async () => {
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
    // A single-session runtime needs no canary: the gate grants a not-required admission.
    await expect(deps.providerCanaryAdmission?.()).resolves.toMatchObject({ allowed: true, required: false });
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

    // Through preparation, as production runs it: a claude rebind needs the identity preparation admitted.
    await expect(
      probePrimaryModelUsability(TARGET, createPrimaryModelProbeAdapters(undefined, probe.deps)),
    ).resolves.toMatchObject({ status: 'unknown', reason: 'context-mismatch-binary-path' });

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
    // One warn line, decided first: the final reason, plus the mismatch that started it.
    expect(refusals(probe.warn)).toEqual([expect.objectContaining({
      reason: RESTART_REQUIRED,
      mismatchReason: 'context-mismatch-binary-path',
      field: 'resolvedBinaryPathHash',
      expectedPrefix: expect.stringMatching(HEX8),
      currentPrefix: expect.stringMatching(HEX8),
    })]);

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

  it('path-only: a resolved path change with the same bytes rebinds on the path reason alone', async () => {
    const cli = install(['1.0.0']);
    vi.stubEnv('PATH', cli.binDir);
    const expected = capture(cli.binDir);
    pointAtCopy(cli, '1.0.0', '2.0.0');
    const probe = harness({ expected });

    const result = await probePrimaryModelUsability(TARGET, createPrimaryModelProbeAdapters(undefined, probe.deps));

    expect(result).toMatchObject({ status: 'usable' });
    expect(refusals(probe.warn)).toEqual([expect.objectContaining({
      reason: 'context-mismatch-binary-path', field: 'resolvedBinaryPathHash',
    })]);
    expect(probe.rebind).toHaveBeenCalledTimes(1);
    const [, next] = probe.rebind.mock.calls[0] as [PrimaryProbeServiceContext, PrimaryProbeServiceContext];
    expect(next.binarySha256).toBe(expected.binarySha256);
    expect(next.resolvedBinaryPathHash).not.toBe(expected.resolvedBinaryPathHash);
    expect(probe.modelProbe).toHaveBeenCalledExactlyOnceWith(
      cli.version('2.0.0'), expect.any(Array), expect.any(Object), expect.any(Object),
    );
  });

  it('sha-only: an in-place rewrite at the same path rebinds on the SHA reason alone', async () => {
    const cli = install(['1.0.0']);
    vi.stubEnv('PATH', cli.binDir);
    const expected = capture(cli.binDir);
    cli.rewrite('1.0.0', 'patched');
    const probe = harness({ expected });

    const result = await probePrimaryModelUsability(TARGET, createPrimaryModelProbeAdapters(undefined, probe.deps));

    expect(result).toMatchObject({ status: 'usable' });
    expect(refusals(probe.warn)).toEqual([expect.objectContaining({
      reason: 'context-mismatch-binary-sha', field: 'binarySha256',
    })]);
    expect(probe.rebind).toHaveBeenCalledTimes(1);
    const [, next] = probe.rebind.mock.calls[0] as [PrimaryProbeServiceContext, PrimaryProbeServiceContext];
    expect(next.resolvedBinaryPathHash).toBe(expected.resolvedBinaryPathHash);
    expect(next.binarySha256).toBe(sha256Of(cli.version('1.0.0')));
    expect(next.binarySha256).not.toBe(expected.binarySha256);
    expect(probe.modelProbe).toHaveBeenCalledExactlyOnceWith(
      cli.version('1.0.0'), expect.any(Array), expect.any(Object), expect.any(Object),
    );
  });

  it('p1-1: a rebind runs refresh-ahead for the admitted binary before the model child', async () => {
    const cli = install(['1.0.0', '1.0.1']);
    vi.stubEnv('PATH', cli.binDir);
    const expected = capture(cli.binDir);
    cli.point('1.0.1');
    const order: string[] = [];
    const probe = harness({ expected, refresh: async () => { order.push('refresh'); return undefined; } });
    probe.modelProbe.mockImplementation(async () => {
      order.push('model');
      return { status: 'ok' as const, output: 'OK' };
    });

    const result = await probePrimaryModelUsability(TARGET, createPrimaryModelProbeAdapters(undefined, probe.deps));

    expect(result).toMatchObject({ status: 'usable' });
    expect(probe.refresh).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['refresh', 'model']);
    expect(probe.rebind).toHaveBeenCalledTimes(1);
  });

  it('p1-1: refresh-ahead still defers a rebind probe while a refresh is running', async () => {
    const cli = install(['1.0.0', '1.0.1']);
    vi.stubEnv('PATH', cli.binDir);
    const expected = capture(cli.binDir);
    cli.point('1.0.1');
    const probe = harness({ expected, refresh: async () => ({ outcome: 'still-running' }) });

    const result = await probePrimaryModelUsability(TARGET, createPrimaryModelProbeAdapters(undefined, probe.deps));

    expect(result).toMatchObject({ status: 'unknown', reason: DEFERRED_REFRESH_IN_FLIGHT });
    expect(probe.refresh).toHaveBeenCalledTimes(1);
    expect(probe.rebind).not.toHaveBeenCalled();
    expect(probe.modelProbe).not.toHaveBeenCalled();
  });

  it('p1-1: a binary change after preparation admitted another binary refuses without a rebind', async () => {
    const cli = install(['1.0.0', '1.0.1', '1.0.2']);
    vi.stubEnv('PATH', cli.binDir);
    const expected = capture(cli.binDir);
    cli.point('1.0.1');
    // The CLI updates again while refresh-ahead runs for the binary preparation admitted.
    const probe = harness({ expected, refresh: async () => { cli.point('1.0.2'); return undefined; } });

    const result = await probePrimaryModelUsability(TARGET, createPrimaryModelProbeAdapters(undefined, probe.deps));

    expect(result).toMatchObject({ status: 'unknown', reason: 'context-mismatch-binary-path' });
    expect(probe.refresh).toHaveBeenCalledTimes(1);
    expect(probe.rebind).not.toHaveBeenCalled();
    expect(probe.modelProbe).not.toHaveBeenCalled();
  });

  it('p1-2: a provider context overflow, then a turn success, clears the alert', () => {
    const { state, record } = recorder();

    record(OVERFLOW);
    expect(raises(UNUSABLE)).toBe(1);
    record(TURN_SUCCESS, 'turn-success');

    expect(clears(UNUSABLE)).toBe(1);
    expect(state.primaryModelUsability).toMatchObject({ status: 'usable', reason: 'turn-success' });
  });

  it.each([
    ['a pre-release suffix', '1.0.1-build.label7'],
    ['an oversized component', '1.0.1234567'],
  ])('p1-4: the version label is null for %s', async (_label, version) => {
    const cli = install(['1.0.0', version]);
    vi.stubEnv('PATH', cli.binDir);
    const expected = capture(cli.binDir);
    cli.point(version);
    const probe = harness({ expected });

    const result = await probePrimaryModelUsability(TARGET, createPrimaryModelProbeAdapters(undefined, probe.deps));

    expect(result).toMatchObject({ status: 'usable' });
    expect(refusals(probe.warn)).toEqual([expect.objectContaining({ currentBinaryLabel: null })]);
    expect(probe.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'primary_model_probe_context_rebound', currentBinaryLabel: null }),
      expect.any(String),
    );
  });

  it('p2-a: a non-alerting deferral after a service-context refusal keeps the hold until a passing probe', () => {
    const { record } = recorder();

    record(REFUSED);
    record(DEFERRED);
    record(TURN_SUCCESS, 'turn-success');
    expect(raises(UNUSABLE)).toBe(1);
    expect(clears(UNUSABLE)).toBe(0);

    record(USABLE);
    expect(clears(UNUSABLE)).toBe(1);
  });

  it('p2-a: after a restart, a turn success before the startup probe settles cannot clear the alert', async () => {
    const pending = deferred<{ status: 'ok' }>();
    adapterSeam.adapters = { probeBinaryModel: () => pending.promise };
    const { state, recordSpy } = schedulerRuntime();
    const record = (result: PrimaryModelUsabilityResult, source: UsabilitySource = 'probe'): void =>
      state.fallback.recordPrimaryModelUsability(result, 'manual', source);
    // A fresh process: the last one may have left primary_model_unusable open for a cause this one never saw.
    adapterSeam.capture = true;
    state.fallback.schedulePrimaryModelUsabilityProbe('startup');
    adapterSeam.capture = false;
    try {
      record(TURN_SUCCESS, 'turn-success');
      expect(clears(UNUSABLE)).toBe(0);
      expect(state.primaryModelUsability).toMatchObject({ probeInFlight: true });
    } finally {
      pending.resolve({ status: 'ok' });
      await vi.waitFor(() => expect(recordSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'usable' }), 'startup'));
    }
    // The passing startup probe clears it.
    expect(clears(UNUSABLE)).toBe(1);

    // Once the startup probe has settled, ordinary failures keep turn recovery.
    record(TIMEOUT);
    record(TURN_SUCCESS, 'turn-success');
    expect(clears(UNUSABLE)).toBe(2);
  });

  it('wiring: the production scheduler hands the probe a rebind that adopts into the runtime when no canary is required', async () => {
    const cli = install(['1.0.0', '1.0.1']);
    vi.stubEnv('PATH', cli.binDir);
    const expected = capture(cli.binDir);
    const { state, recordSpy } = schedulerRuntime({ canaryStore: false });
    state.primaryProbeServiceContext = expected;
    const deps = await scheduledProbeDeps(state, recordSpy);
    cli.point('1.0.1');
    const probe = harness({ expected });

    const result = await probePrimaryModelUsability(TARGET, createPrimaryModelProbeAdapters(undefined, {
      ...probe.deps,
      serviceContext: deps.serviceContext as PrimaryProbeServiceContext,
      rebindServiceContext: deps.rebindServiceContext,
      providerCanaryAdmission: deps.providerCanaryAdmission,
    } as PrimaryModelProbeAdapterDeps));

    expect(result).toMatchObject({ status: 'usable' });
    expect(state.primaryProbeServiceContext).not.toBe(expected);
    expect(state.primaryProbeServiceContext).toMatchObject({ binarySha256: sha256Of(cli.version('1.0.1')) });
  });

  it('wiring: the production scheduler declines the rebind when a required canary does not admit the new binary', async () => {
    const cli = install(['1.0.0', '1.0.1']);
    vi.stubEnv('PATH', cli.binDir);
    const expected = capture(cli.binDir);
    // An empty canary store in a per-chat runtime: the canary is required and holds no receipt.
    const { state, recordSpy } = schedulerRuntime({ canaryStore: true });
    state.primaryProbeServiceContext = expected;
    const deps = await scheduledProbeDeps(state, recordSpy);
    cli.point('1.0.1');
    const probe = harness({ expected });

    const result = await probePrimaryModelUsability(TARGET, createPrimaryModelProbeAdapters(undefined, {
      ...probe.deps,
      serviceContext: deps.serviceContext as PrimaryProbeServiceContext,
      rebindServiceContext: deps.rebindServiceContext,
      providerCanaryAdmission: deps.providerCanaryAdmission,
    } as PrimaryModelProbeAdapterDeps));

    expect(result).toMatchObject({ status: 'unknown', reason: RESTART_REQUIRED });
    expect(state.primaryProbeServiceContext).toBe(expected);
    expect(probe.modelProbe).not.toHaveBeenCalled();
  });

  it('p3: a held turn success does not log that it refreshed stale usability', () => {
    const { state, record } = recorder();
    const age = (): void => {
      (state.primaryModelUsability as unknown as { checkedAt: number }).checkedAt = Date.now() - 6 * 60 * 60_000;
    };

    record(REFUSED);
    age();
    runtimeLog.info.mockClear();
    state.recordTurnCapabilitySuccess(true);
    expect(runtimeLog.info).not.toHaveBeenCalledWith(expect.anything(), STALE_LINE);

    // Control: an accepted turn success after a stale ordinary failure still logs it.
    record(USABLE);
    record(TIMEOUT);
    age();
    state.recordTurnCapabilitySuccess(true);
    expect(runtimeLog.info).toHaveBeenCalledWith(expect.anything(), STALE_LINE);
  });
});
