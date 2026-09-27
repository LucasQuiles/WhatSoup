/**
 * The release validator must read the recovery_debt reason vocabulary from the
 * producer (src/core/recovery-debt.ts), not from a private copy. The producer
 * module is mocked to carry one extra retained reason: a validator that keeps
 * its own list rejects every body carrying that reason as recovery_debt_invalid
 * even though the producer emits it, which is the drift this file pins.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/recovery-debt.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/core/recovery-debt.ts')>();
  return {
    ...original,
    RECOVERY_REASON_ORDER: [...original.RECOVERY_REASON_ORDER, 'future_retained_reason'],
  };
});

const { recoveryDebtIssue } = await import('../../scripts/validate-startup-notification-release.ts');

function retainedDebt(reasons: string[]): Record<string, unknown> {
  return {
    open: true,
    service_blocking: false,
    attention: 'routine',
    reason: null,
    reasons,
    continuity: { readable: true, open: 0, unresolved: 0, ambiguous: 0 },
    turn_recovery: {
      readable: true,
      blocking_outstanding: 0,
      retained_terminal: 0,
      open_catchups: 1,
      corroborated_retained: 0,
    },
    completed_delivery_identity: {
      readable: true,
      blocking: 0,
      retained: 0,
      next_action: null,
    },
    delivery: {
      readable: true,
      blocking_ambiguous: 0,
      uncorroborated_ambiguous: 0,
      corroborated_retained: 0,
      oldest_uncorroborated_at: null,
    },
  };
}

describe('startup notification release validator recovery-debt vocabulary', () => {
  it('accepts a reason the producer vocabulary carries', () => {
    expect(recoveryDebtIssue({
      status: 'healthy',
      recovery_debt: retainedDebt(['historical_turn_catchup', 'future_retained_reason']),
    })).toBeNull();
  });

  it('still rejects a reason outside the producer vocabulary', () => {
    expect(recoveryDebtIssue({
      status: 'healthy',
      recovery_debt: retainedDebt(['historical_turn_catchup', 'unknown_reason']),
    })).toBe('recovery_debt_invalid');
  });
});
