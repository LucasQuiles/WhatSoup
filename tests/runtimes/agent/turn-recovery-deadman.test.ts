import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TurnRecoveryDeadman,
  type TurnRecoveryDeadmanDeps,
} from '../../../src/runtimes/agent/turn-recovery-deadman.ts';
import type { TurnRecoverySupervisorHealth } from '../../../src/runtimes/agent/turn-recovery-supervisor.ts';

function health(
  overrides: Partial<TurnRecoverySupervisorHealth> = {},
): TurnRecoverySupervisorHealth {
  return {
    lastScanAt: null,
    lastScanAttemptAt: null,
    lastSuccessfulScanAt: null,
    consecutiveScanFailures: 0,
    lastScanFailureReason: null,
    scans: 0,
    claims: 0,
    completions: 0,
    requeues: 0,
    exhaustions: 0,
    reassignments: 0,
    dispatchFailures: 0,
    processingErrors: 0,
    leaseRenewals: 0,
    leaseRenewalFailures: 0,
    renewalRetryableFailures: 0,
    renewalOwnershipLosses: 0,
    renewalFailClosedAborts: 0,
    renewalAbortFailures: 0,
    storeCounts: null,
    ...overrides,
  };
}

describe('TurnRecoveryDeadman', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function createDeps(
    overrides: Partial<TurnRecoveryDeadmanDeps> = {},
  ): TurnRecoveryDeadmanDeps {
    return {
      instanceName: 'test-instance',
      enabled: () => true,
      health: () => health(),
      emitAlert: vi.fn(() => true),
      clearAlert: vi.fn(() => true),
      now: () => Date.now(),
      intervalMs: 1_000,
      startupGraceMs: 3_000,
      staleAfterMs: 2_000,
      maxConsecutiveFailures: 3,
      ...overrides,
    };
  }

  it('uses its own cadence to alert once after startup grace and clear once after a fresh success', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    let snapshot = health();
    const emitAlert = vi.fn(() => true);
    const clearAlert = vi.fn(() => true);
    const deadman = new TurnRecoveryDeadman(createDeps({
      health: () => snapshot,
      emitAlert,
      clearAlert,
    }));

    deadman.start();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(emitAlert).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(emitAlert).toHaveBeenCalledTimes(1);
    expect(emitAlert).toHaveBeenCalledWith(
      'test-instance',
      'turn_recovery_supervisor_unavailable',
      'Turn-recovery supervisor unavailable',
      expect.stringMatching(
        /^reason=never_succeeded success_age_ms=missing attempts=0 consecutive_failures=0 last_failure=none$/,
      ),
      'critical',
    );

    await vi.advanceTimersByTimeAsync(5_000);
    expect(emitAlert).toHaveBeenCalledTimes(1);
    expect(clearAlert).not.toHaveBeenCalled();

    snapshot = health({
      lastScanAt: Date.now(),
      lastScanAttemptAt: Date.now(),
      lastSuccessfulScanAt: Date.now(),
      scans: 1,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(clearAlert).toHaveBeenCalledTimes(1);
    expect(clearAlert).toHaveBeenCalledWith(
      'test-instance',
      'turn_recovery_supervisor_unavailable',
      expect.stringMatching(/^reason=successful_scan success_age_ms=\d+ attempts=1$/),
    );

    await vi.advanceTimersByTimeAsync(2_000);
    expect(clearAlert).toHaveBeenCalledTimes(1);
    deadman.stop();
  });

  it('records a bounded repeated-failure reason without emitting duplicate incidents', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    let snapshot = health({
      lastScanAt: Date.now(),
      lastScanAttemptAt: Date.now(),
      consecutiveScanFailures: 3,
      lastScanFailureReason: 'enumeration_failed',
      scans: 3,
    });
    const emitAlert = vi.fn(() => true);
    const deadman = new TurnRecoveryDeadman(createDeps({
      startupGraceMs: 0,
      health: () => snapshot,
      emitAlert,
    }));

    deadman.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(emitAlert).toHaveBeenCalledTimes(1);
    expect(emitAlert).toHaveBeenCalledWith(
      'test-instance',
      'turn_recovery_supervisor_unavailable',
      'Turn-recovery supervisor unavailable',
      'reason=repeated_failures success_age_ms=missing attempts=3 consecutive_failures=3 last_failure=enumeration_failed',
      'critical',
    );

    snapshot = health({
      lastScanAt: Date.now(),
      lastScanAttemptAt: Date.now(),
      lastSuccessfulScanAt: Date.now() - 20_000,
      consecutiveScanFailures: 4,
      lastScanFailureReason: 'stale_claim_recovery_failed',
      scans: 4,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(emitAlert).toHaveBeenCalledTimes(1);
    expect(deadman.health().lastVerdictReason).toBe('repeated_failures');
    expect(deadman.health().lastScanFailureReason).toBe('stale_claim_recovery_failed');
    deadman.stop();
  });

  it('emits stale-success evidence from the independent timer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_500_000);
    const emitAlert = vi.fn(() => true);
    const deadman = new TurnRecoveryDeadman(createDeps({
      startupGraceMs: 0,
      health: () => health({
        lastScanAt: Date.now(),
        lastScanAttemptAt: Date.now(),
        lastSuccessfulScanAt: Date.now() - 2_001,
        scans: 4,
      }),
      emitAlert,
    }));

    deadman.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(emitAlert).toHaveBeenCalledWith(
      'test-instance',
      'turn_recovery_supervisor_unavailable',
      'Turn-recovery supervisor unavailable',
      'reason=stale_success success_age_ms=2001 attempts=4 consecutive_failures=0 last_failure=none',
      'critical',
    );
    deadman.stop();
  });

  it('stays quiet when recovery supervision is disabled', async () => {
    vi.useFakeTimers();
    const emitAlert = vi.fn(() => true);
    const clearAlert = vi.fn(() => true);
    const deadman = new TurnRecoveryDeadman(createDeps({
      enabled: () => false,
      startupGraceMs: 0,
      emitAlert,
      clearAlert,
    }));

    deadman.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(emitAlert).not.toHaveBeenCalled();
    expect(clearAlert).not.toHaveBeenCalled();
    deadman.stop();
  });

  it('retries failed alert and clear writes without losing the incident transition', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000_000);
    let enabled = true;
    let snapshot = health();
    const emitAlert = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    const clearAlert = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    const deadman = new TurnRecoveryDeadman(createDeps({
      enabled: () => enabled,
      startupGraceMs: 0,
      staleAfterMs: 10_000,
      health: () => snapshot,
      emitAlert,
      clearAlert,
    }));

    deadman.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(emitAlert).toHaveBeenCalledTimes(1);
    expect(deadman.health().incidentActive).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(emitAlert).toHaveBeenCalledTimes(2);
    expect(deadman.health().incidentActive).toBe(true);

    enabled = false;
    snapshot = health({
      lastScanAt: Date.now(),
      lastScanAttemptAt: Date.now(),
      lastSuccessfulScanAt: Date.now(),
      scans: 1,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(clearAlert).not.toHaveBeenCalled();

    enabled = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(clearAlert).toHaveBeenCalledTimes(1);
    expect(deadman.health().incidentActive).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(clearAlert).toHaveBeenCalledTimes(2);
    expect(deadman.health().incidentActive).toBe(false);
    deadman.stop();
  });

  it('fails closed when the supervisor health snapshot throws and clears after recovery', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(4_000_000);
    let healthAvailable = false;
    const emitAlert = vi.fn(() => true);
    const clearAlert = vi.fn(() => true);
    const deadman = new TurnRecoveryDeadman(createDeps({
      startupGraceMs: 0,
      health: () => {
        if (!healthAvailable) throw new Error('store implementation detail');
        return health({
          lastScanAt: Date.now(),
          lastScanAttemptAt: Date.now(),
          lastSuccessfulScanAt: Date.now(),
          scans: 1,
        });
      },
      emitAlert,
      clearAlert,
    }));

    deadman.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(emitAlert).toHaveBeenCalledWith(
      'test-instance',
      'turn_recovery_supervisor_unavailable',
      'Turn-recovery supervisor unavailable',
      'reason=health_unavailable',
      'critical',
    );
    expect(deadman.health().lastVerdictReason).toBe('health_unavailable');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(emitAlert).toHaveBeenCalledTimes(1);

    healthAvailable = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(clearAlert).toHaveBeenCalledTimes(1);
    expect(deadman.health().incidentActive).toBe(false);
    deadman.stop();
  });
});
