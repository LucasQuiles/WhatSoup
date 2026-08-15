import { describe, expect, it } from 'vitest';

import {
  evaluateRecoveryProof,
  normalizeRecoveryDebt,
  type RecoveryDebtEvidence,
} from '../../src/core/recovery-debt.ts';

function evidence(overrides: Partial<RecoveryDebtEvidence> = {}): RecoveryDebtEvidence {
  return {
    continuity: { readable: true, open: 0, unresolved: 0, ambiguous: 0 },
    runtime: {
      readable: true,
      details: {
        degradedReasons: [],
        recoveryDebtReasons: [],
        turnRecoveryBlockingOutstanding: 0,
        turnRecoveryRetainedTerminal: 0,
        turnRecoveryOpenRecoveries: 0,
        turnRecoveryCorroboratedRetained: 0,
        completedDeliveryIdentityBlocking: 0,
        completedDeliveryIdentityRetained: 0,
        completedDeliveryIdentityAdmissions: { nextAction: null },
      },
    },
    durability: {
      readable: true,
      deliveryBlocking: false,
      deliveryAmbiguity: {
        readable: true,
        uncorroboratedAmbiguous: 0,
        corroboratedRetained: 0,
        oldestUncorroboratedAt: null,
      },
    },
    ...overrides,
  };
}

describe('normalizeRecoveryDebt', () => {
  it('reports no debt for complete zero evidence', () => {
    expect(normalizeRecoveryDebt(evidence())).toEqual({
      open: false,
      service_blocking: false,
      attention: 'none',
      reason: null,
      reasons: [],
      continuity: { readable: true, open: 0, unresolved: 0, ambiguous: 0 },
      turn_recovery: {
        readable: true,
        blocking_outstanding: 0,
        retained_terminal: 0,
        open_catchups: 0,
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
    });
  });

  it('keeps retained debt open and nonblocking with stable reason ordering', () => {
    const value = evidence({
      continuity: { readable: true, open: 1, unresolved: 1, ambiguous: 0 },
      runtime: {
        readable: true,
        details: {
          degradedReasons: [],
          recoveryDebtReasons: [
            'corroborated_delivery_retained',
            'completed_delivery_identity_operator',
            'historical_turn_catchup',
            'turn_recovery_terminal',
          ],
          turnRecoveryBlockingOutstanding: 0,
          turnRecoveryRetainedTerminal: 11,
          turnRecoveryOpenRecoveries: 9,
          turnRecoveryCorroboratedRetained: 1,
          completedDeliveryIdentityBlocking: 0,
          completedDeliveryIdentityRetained: 38,
          completedDeliveryIdentityAdmissions: { nextAction: 'operator' },
        },
      },
      durability: {
        readable: true,
        deliveryBlocking: false,
        deliveryAmbiguity: {
          readable: true,
          uncorroboratedAmbiguous: 0,
          corroboratedRetained: 11,
          oldestUncorroboratedAt: null,
        },
      },
    });

    expect(normalizeRecoveryDebt(value)).toMatchObject({
      open: true,
      service_blocking: false,
      attention: 'routine',
      reason: 'continuity_gap_open',
      reasons: [
        'continuity_gap_open',
        'turn_recovery_terminal',
        'historical_turn_catchup',
        'corroborated_delivery_retained',
        'completed_delivery_identity_operator',
      ],
    });
  });

  it('marks actionable recovery and stale delivery ambiguity as blocking', () => {
    const value = evidence({
      runtime: {
        readable: true,
        details: {
          degradedReasons: ['turn_recovery_actionable'],
          recoveryDebtReasons: [],
          turnRecoveryBlockingOutstanding: 2,
          turnRecoveryRetainedTerminal: 0,
          turnRecoveryOpenRecoveries: 0,
          turnRecoveryCorroboratedRetained: 0,
          completedDeliveryIdentityBlocking: 0,
          completedDeliveryIdentityRetained: 0,
          completedDeliveryIdentityAdmissions: { nextAction: null },
        },
      },
      durability: {
        readable: true,
        deliveryBlocking: true,
        deliveryAmbiguity: {
          readable: true,
          uncorroboratedAmbiguous: 1,
          corroboratedRetained: 0,
          oldestUncorroboratedAt: '2026-08-14 04:00:00',
        },
      },
    });

    expect(normalizeRecoveryDebt(value)).toMatchObject({
      open: true,
      service_blocking: true,
      attention: 'urgent',
      reasons: ['turn_recovery_actionable', 'uncorroborated_delivery_ambiguity'],
      delivery: { blocking_ambiguous: 1 },
    });
  });

  it('keeps fresh uncorroborated delivery ambiguity nonblocking with an explicit blocking gauge', () => {
    const value = evidence({
      durability: {
        readable: true,
        deliveryBlocking: false,
        deliveryAmbiguity: {
          readable: true,
          uncorroboratedAmbiguous: 2,
          corroboratedRetained: 0,
          oldestUncorroboratedAt: '2026-08-14 06:00:00',
        },
      },
    });

    expect(normalizeRecoveryDebt(value)).toMatchObject({
      open: true,
      service_blocking: false,
      attention: 'routine',
      reasons: ['uncorroborated_delivery_ambiguity'],
      delivery: {
        blocking_ambiguous: 0,
        uncorroborated_ambiguous: 2,
      },
    });
  });

  it.each([
    ['unreadable continuity', evidence({ continuity: { readable: false, open: 0, unresolved: 0, ambiguous: 0 } })],
    ['unreadable runtime', evidence({ runtime: { readable: false, details: null } })],
    ['unknown retained reason', evidence({
      runtime: {
        readable: true,
        details: {
          ...(evidence().runtime.details as Record<string, unknown>),
          recoveryDebtReasons: ['future_recovery_class'],
        },
      },
    })],
    ['negative count', evidence({
      runtime: {
        readable: true,
        details: {
          ...(evidence().runtime.details as Record<string, unknown>),
          turnRecoveryRetainedTerminal: -1,
        },
      },
    })],
    ['noninteger count', evidence({
      runtime: {
        readable: true,
        details: {
          ...(evidence().runtime.details as Record<string, unknown>),
          completedDeliveryIdentityRetained: 0.5,
        },
      },
    })],
    ['blocking delivery contradiction', evidence({
      durability: {
        readable: true,
        deliveryBlocking: true,
        deliveryAmbiguity: {
          readable: true,
          uncorroboratedAmbiguous: 0,
          corroboratedRetained: 0,
          oldestUncorroboratedAt: null,
        },
      },
    })],
    ['uncorroborated delivery without an oldest timestamp', evidence({
      durability: {
        readable: true,
        deliveryBlocking: false,
        deliveryAmbiguity: {
          readable: true,
          uncorroboratedAmbiguous: 1,
          corroboratedRetained: 0,
          oldestUncorroboratedAt: null,
        },
      },
    })],
  ])('fails closed for %s', (_label, value) => {
    expect(normalizeRecoveryDebt(value)).toMatchObject({
      open: true,
      service_blocking: true,
      attention: 'urgent',
    });
  });
});

describe('evaluateRecoveryProof', () => {
  const clearEvidence = {
    transportConnected: true,
    modelEvidenceCurrent: true,
    runtimeReadable: true,
    schemaReadable: true,
    pendingPollsReadable: true,
    recoveryDebt: normalizeRecoveryDebt(evidence()),
  } as const;

  it('clears with complete readable nonblocking evidence, including retained debt', () => {
    const retained = normalizeRecoveryDebt(evidence({
      continuity: { readable: true, open: 1, unresolved: 1, ambiguous: 0 },
    }));
    expect(evaluateRecoveryProof({ ...clearEvidence, recoveryDebt: retained })).toBe('clear');
  });

  it('degrades for an explicit blocker', () => {
    expect(evaluateRecoveryProof({ ...clearEvidence, transportConnected: false })).toBe('degrade');
  });

  it('retains the latch when required evidence is unknown', () => {
    expect(evaluateRecoveryProof({ ...clearEvidence, modelEvidenceCurrent: null })).toBe('retain');
  });
});
