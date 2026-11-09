/**
 * AgentRuntime wiring for the ratified-row identity verification (task-21).
 *
 * The verification rides the existing primary-usability probe seam
 * (schedulePrimaryModelUsabilityProbe: startup / periodic / manual) — no new
 * poller. After each probe settles, the runtime asks the verifier once; the
 * result lands in the health snapshot as `accountIdentity` plus the
 * degradedReasons literal, and the operator alert fires on mismatch.
 *
 * The probe dispatch is the real scheduler; only probePrimaryModelUsability
 * (a controllable promise) and the identity verify function are faked. The
 * credential heal seam is mocked so the req-03 assertion — zero credential
 * writes on the identity path — is a direct call-count check.
 */
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

const healSeam = vi.hoisted(() => ({ ensureClaudeFileStoreCredential: vi.fn(() => ({ outcome: 'skipped-not-darwin' })) }));
vi.mock('../../../src/runtimes/agent/providers/claude-filestore-heal.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/runtimes/agent/providers/claude-filestore-heal.ts')>(),
  ensureClaudeFileStoreCredential: healSeam.ensureClaudeFileStoreCredential,
}));

const probeControl = vi.hoisted(() => ({ resolvers: [] as Array<(result: unknown) => void> }));
vi.mock('../../../src/runtimes/agent/providers/primary-model-usability.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/runtimes/agent/providers/primary-model-usability.ts')>(),
  probePrimaryModelUsability: vi.fn(() => new Promise((resolve) => { probeControl.resolvers.push(resolve); })),
}));

const adapterFactoryCalls = vi.hoisted(() => ({ calls: [] as Array<{ deps: unknown }> }));
vi.mock('../../../src/runtimes/agent/providers/primary-model-usability-adapters.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/runtimes/agent/providers/primary-model-usability-adapters.ts')>();
  return {
    ...actual,
    createPrimaryModelProbeAdapters: vi.fn((...args: Parameters<typeof actual.createPrimaryModelProbeAdapters>) => {
      adapterFactoryCalls.calls.push({ deps: args[1] });
      return actual.createPrimaryModelProbeAdapters(...args);
    }),
  };
});

import { Database } from '../../../src/core/database.ts';
import { clearAlertSourceChecked, emitAlertChecked } from '../../../src/lib/emit-alert.ts';
import type {
  PrimaryModelUsabilityResult,
  PrimaryProbeServiceContext,
} from '../../../src/runtimes/agent/providers/primary-model-usability.ts';
import type { AccountIdentityVerification } from '../../../src/runtimes/agent/providers/claude-account-identity.ts';
import {
  buildPrimaryProbeServiceContext,
  type PrimaryModelProbeAdapterDeps,
} from '../../../src/runtimes/agent/providers/primary-model-usability-adapters.ts';
import type { AgentRuntimeOptions } from '../../../src/runtimes/agent/runtime.ts';
import { makeRuntimeState, type RuntimeState } from './lib/runtime-terminal-coordinator-harness.ts';

const MINUTE = 60_000;
const START = 1_790_000_000_000;
const EXPECTED = `sha256:${'a'.repeat(64)}`;
const USABLE: PrimaryModelUsabilityResult = { status: 'usable', provider: 'claude-cli', model: null };

type ProbeTrigger = 'startup' | 'manual' | 'periodic';
type IdentityState = RuntimeState & {
  recordTurnCapabilitySuccess(isUserTurnResult: boolean): void;
  periodicUsabilityProbeTimer: ReturnType<typeof setTimeout> | null;
  periodicUsabilityProbeBackoff: number;
  periodicUsabilityProbeDueAt: number | null;
  fallback: {
    schedulePrimaryModelUsabilityProbe(trigger: ProbeTrigger): void;
    scheduleNextPeriodicUsabilityProbe(): void;
  };
};

type ContextBoundState = IdentityState & {
  primaryProbeServiceContext: PrimaryProbeServiceContext | null;
  currentPrimaryProbeServiceContext(): PrimaryProbeServiceContext | null;
};

function verification(over: Partial<AccountIdentityVerification>): AccountIdentityVerification {
  return {
    status: 'match',
    reason: null,
    expectedDigestPrefix: 'aaaaaaaaaaaa',
    observedDigestPrefix: 'aaaaaaaaaaaa',
    checkedAt: Date.now(),
    ...over,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await Promise.resolve();
}

describe('AgentRuntime — account identity rides the usability probe seam', () => {
  let db: Database;

  beforeEach(() => {
    vi.useFakeTimers({ now: START });
    vi.spyOn(Math, 'random').mockReturnValue(1);
    probeControl.resolvers.length = 0;
    adapterFactoryCalls.calls.length = 0;
    vi.mocked(emitAlertChecked).mockClear();
    vi.mocked(clearAlertSourceChecked).mockClear();
    healSeam.ensureClaudeFileStoreCredential.mockClear();
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function build(options: AgentRuntimeOptions) {
    const { runtime, state } = makeRuntimeState<IdentityState>(db, options);
    const snapshot = () => runtime.getHealthSnapshot();
    const identity = () => (snapshot().details as Record<string, unknown>).accountIdentity as Record<string, unknown>;
    const reasons = () => (snapshot().details as Record<string, unknown>).degradedReasons as string[];
    return { runtime, state, snapshot, identity, reasons };
  }

  async function runProbe(state: IdentityState, trigger: ProbeTrigger): Promise<void> {
    state.fallback.schedulePrimaryModelUsabilityProbe(trigger);
    await settle();
    expect(probeControl.resolvers).toHaveLength(1);
    probeControl.resolvers.pop()!(USABLE);
    await settle();
  }

  it('no expectation configured: verification disabled, never invoked, health quiet', async () => {
    const verify = vi.fn(async (_expected: string | null) => verification({}));
    const { state, identity, reasons } = build({ accountIdentityVerify: verify });
    await runProbe(state, 'startup');
    expect(verify).not.toHaveBeenCalled();
    expect(identity()).toMatchObject({ status: 'disabled', reason: null });
    expect(reasons()).not.toContain('credential_identity_unverifiable');
    expect(reasons()).not.toContain('credential_identity_mismatch');
  });

  it('pending before the first verification; a startup probe triggers exactly one verification with the ratified digest', async () => {
    const verify = vi.fn(async (_expected: string | null) => verification({}));
    const { state, identity, reasons, snapshot } = build({ expectedAccountDigest: EXPECTED, accountIdentityVerify: verify });
    expect(identity()).toMatchObject({ status: 'pending' });
    expect(reasons()).toEqual([]);
    await runProbe(state, 'startup');
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0]![0]).toBe(EXPECTED);
    expect(identity()).toMatchObject({ status: 'match', stale: false });
    expect(reasons()).toEqual([]);
    expect(snapshot().status).toBe('healthy');
    expect(vi.mocked(emitAlertChecked)).not.toHaveBeenCalled();
  });

  it('passes one required immutable context through the real coordinator for startup, manual, and periodic probes', async () => {
    const { state } = makeRuntimeState<ContextBoundState>(db);
    const context = buildPrimaryProbeServiceContext({
      provider: 'claude-cli',
      model: null,
      serviceGeneration: 'test-generation',
      cwd: '/runtime-cwd',
      selectorEnv: { PATH: '/runtime-bin' },
      binaryState: 'missing',
    });
    state.primaryProbeServiceContext = context;
    state.currentPrimaryProbeServiceContext = vi.fn(() => context);

    for (const trigger of ['startup', 'manual', 'periodic'] as const) {
      state.fallback.schedulePrimaryModelUsabilityProbe(trigger);
      await settle();
      const call = adapterFactoryCalls.calls.at(-1);
      expect(call).toBeDefined();
      const deps = call!.deps as PrimaryModelProbeAdapterDeps;
      expect(deps).toMatchObject({
        serviceContext: context,
        requireServiceContext: true,
        probeTrigger: trigger,
      });
      expect(deps.currentServiceContext?.()).toEqual(context);

      const resolve = probeControl.resolvers.shift();
      expect(resolve).toBeDefined();
      resolve!(USABLE);
      await settle();
    }
  });

  it('mismatch: degradedReasons + accountIdentity + critical alert; a later match clears', async () => {
    const results = [
      verification({ status: 'mismatch', observedDigestPrefix: 'bbbbbbbbbbbb' }),
      verification({}),
    ];
    const verify = vi.fn(async (_expected: string | null) => results.shift()!);
    const { state, identity, reasons, snapshot } = build({ expectedAccountDigest: EXPECTED, accountIdentityVerify: verify });
    await runProbe(state, 'startup');
    expect(identity()).toMatchObject({ status: 'mismatch', observedDigestPrefix: 'bbbbbbbbbbbb' });
    expect(reasons()).toContain('credential_identity_mismatch');
    expect(snapshot().status).toBe('degraded');
    const alerts = vi.mocked(emitAlertChecked).mock.calls.map((call) => call[1]);
    expect(alerts).toContain('credential_identity_mismatch');

    await runProbe(state, 'periodic');
    expect(verify).toHaveBeenCalledTimes(2);
    expect(identity()).toMatchObject({ status: 'match' });
    expect(reasons()).not.toContain('credential_identity_mismatch');
    expect(vi.mocked(clearAlertSourceChecked).mock.calls.map((call) => call[1])).toContain('credential_identity_mismatch');
  });

  it('unverifiable: its own degradedReason and warning alert', async () => {
    const verify = vi.fn(async (_expected: string | null) => verification({ status: 'unverifiable', reason: 'not-logged-in', observedDigestPrefix: null }));
    const { state, identity, reasons } = build({ expectedAccountDigest: EXPECTED, accountIdentityVerify: verify });
    await runProbe(state, 'manual');
    expect(identity()).toMatchObject({ status: 'unverifiable', reason: 'not-logged-in' });
    expect(reasons()).toContain('credential_identity_unverifiable');
    expect(reasons()).not.toContain('credential_identity_mismatch');
    const alert = vi.mocked(emitAlertChecked).mock.calls.find((call) => call[1] === 'credential_identity_unverifiable');
    expect(alert?.[4]).toBe('warning');
  });

  it('never verified inside the freshness window: pending flips to unverifiable/never-verified (fail closed, but not at boot)', async () => {
    const verify = vi.fn(async (_expected: string | null) => verification({}));
    const { identity, reasons } = build({ expectedAccountDigest: EXPECTED, accountIdentityVerify: verify });
    vi.advanceTimersByTime(29 * MINUTE);
    expect(identity()).toMatchObject({ status: 'pending' });
    expect(reasons()).toEqual([]);
    vi.advanceTimersByTime(2 * MINUTE);
    expect(identity()).toMatchObject({ status: 'unverifiable', reason: 'never-verified', stale: true });
    expect(reasons()).toContain('credential_identity_unverifiable');
  });

  it('a match older than the freshness window is a stale receipt, not a match', async () => {
    const verify = vi.fn(async (_expected: string | null) => verification({ checkedAt: Date.now() }));
    const { state, identity, reasons } = build({ expectedAccountDigest: EXPECTED, accountIdentityVerify: verify });
    await runProbe(state, 'startup');
    expect(identity()).toMatchObject({ status: 'match' });
    state.periodicUsabilityProbeBackoff = 2;
    expect(state.periodicUsabilityProbeTimer).toBeNull();
    vi.advanceTimersByTime(31 * MINUTE);
    expect(identity()).toMatchObject({ status: 'unverifiable', reason: 'stale-receipt', stale: true });
    expect(reasons()).toContain('credential_identity_unverifiable');
  });

  it('a turn success before the scheduled next probe does not age the identity receipt early', async () => {
    const verify = vi.fn(async (_expected: string | null) => verification({ checkedAt: Date.now() }));
    const { state, identity, reasons } = build({ expectedAccountDigest: EXPECTED, accountIdentityVerify: verify });
    await runProbe(state, 'startup');
    expect(identity()).toMatchObject({ status: 'match', stale: false });
    state.fallback.scheduleNextPeriodicUsabilityProbe();
    expect(state.periodicUsabilityProbeDueAt).toBe(START + 33 * MINUTE);
    vi.advanceTimersByTime(20 * MINUTE);
    state.recordTurnCapabilitySuccess(true);
    expect(identity()).toMatchObject({ status: 'match', stale: false });
    expect(reasons()).not.toContain('credential_identity_unverifiable');
  });

  it('a late turn cannot clear an identity receipt after the scheduled deadline', async () => {
    const verify = vi.fn(async (_expected: string | null) => verification({ checkedAt: Date.now() }));
    const { state, identity, reasons } = build({ expectedAccountDigest: EXPECTED, accountIdentityVerify: verify });
    await runProbe(state, 'startup');
    state.periodicUsabilityProbeTimer = {} as ReturnType<typeof setTimeout>;
    state.periodicUsabilityProbeDueAt = START + 33 * MINUTE;
    vi.advanceTimersByTime(35 * MINUTE + 1);
    expect(identity()).toMatchObject({ status: 'unverifiable', reason: 'stale-receipt', stale: true });
    state.recordTurnCapabilitySuccess(true);
    expect(identity()).toMatchObject({ status: 'unverifiable', reason: 'stale-receipt', stale: true });
    expect(reasons()).toContain('credential_identity_unverifiable');
  });

  it('keeps the scheduled identity grace while a periodic probe is pending, then expires', async () => {
    const verify = vi.fn(async (_expected: string | null) => verification({ checkedAt: Date.now() }));
    const { state, identity, reasons, snapshot } = build({ expectedAccountDigest: EXPECTED, accountIdentityVerify: verify });
    await runProbe(state, 'startup');
    state.fallback.scheduleNextPeriodicUsabilityProbe();
    await vi.advanceTimersByTimeAsync(33 * MINUTE);
    expect(probeControl.resolvers).toHaveLength(1);
    expect(state.periodicUsabilityProbeTimer).toBeNull();
    expect((snapshot().details as Record<string, unknown>).turnCapability).toMatchObject({ periodicProbeExpected: true });
    expect(identity()).toMatchObject({ status: 'match', stale: false });
    expect(reasons()).not.toContain('credential_identity_unverifiable');

    await vi.advanceTimersByTimeAsync(2 * MINUTE + 1);
    expect(identity()).toMatchObject({ status: 'unverifiable', reason: 'stale-receipt', stale: true });
    expect(reasons()).toContain('credential_identity_unverifiable');
  });

  it('keeps cached identity only until the scheduled in-flight periodic probe publishes its mismatch', async () => {
    const results = [
      verification({}),
      verification({ status: 'mismatch', observedDigestPrefix: 'bbbbbbbbbbbb' }),
    ];
    const verify = vi.fn(async (_expected: string | null) => results.shift()!);
    const { state, identity, reasons } = build({ expectedAccountDigest: EXPECTED, accountIdentityVerify: verify });
    await runProbe(state, 'startup');
    state.fallback.scheduleNextPeriodicUsabilityProbe();
    await vi.advanceTimersByTimeAsync(33 * MINUTE);
    expect(identity()).toMatchObject({ status: 'match', stale: false });
    expect(reasons()).not.toContain('credential_identity_mismatch');
    expect(probeControl.resolvers).toHaveLength(1);
    probeControl.resolvers.pop()!(USABLE);
    await settle();
    expect(identity()).toMatchObject({ status: 'mismatch', stale: false });
    expect(reasons()).toContain('credential_identity_mismatch');
  });

  it('req-03: the identity path never reaches the credential heal seam, on any outcome', async () => {
    const results = [
      verification({}),
      verification({ status: 'mismatch', observedDigestPrefix: 'bbbbbbbbbbbb' }),
      verification({ status: 'unverifiable', reason: 'unparseable', observedDigestPrefix: null }),
    ];
    const verify = vi.fn(async (_expected: string | null) => results.shift()!);
    const { state } = build({ expectedAccountDigest: EXPECTED, accountIdentityVerify: verify });
    await runProbe(state, 'startup');
    await runProbe(state, 'periodic');
    await runProbe(state, 'manual');
    expect(verify).toHaveBeenCalledTimes(3);
    expect(healSeam.ensureClaudeFileStoreCredential).not.toHaveBeenCalled();
  });

  it('the health snapshot publishes digest prefixes and status classes only', async () => {
    const verify = vi.fn(async (_expected: string | null) => verification({ status: 'mismatch', observedDigestPrefix: 'bbbbbbbbbbbb' }));
    const { state, snapshot } = build({ expectedAccountDigest: EXPECTED, accountIdentityVerify: verify });
    await runProbe(state, 'startup');
    const serialized = JSON.stringify(snapshot());
    expect(serialized).not.toContain(EXPECTED);
    expect(serialized).not.toMatch(/[0-9a-f]{64}/);
    expect(serialized).not.toContain('@');
  });
});
