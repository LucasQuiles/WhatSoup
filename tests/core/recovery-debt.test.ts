import { describe, expect, it } from 'vitest';

import {
  normalizeRecoveryDebt,
  type RecoveryDebtEvidence,
} from '../../src/core/recovery-debt.ts';

function evidence(overrides: Partial<RecoveryDebtEvidence> = {}): RecoveryDebtEvidence {
  return {
    continuity: { readable: true, open: 0, unresolved: 0, ambiguous: 0 },
    runtime: {
      readable: true,
      details: {
        recoveryBlockingReasons: [],
        recoveryDebtReasons: [],
        turnRecoveryBlockingOutstanding: 0,
        turnRecoveryRetainedTerminal: 0,
        turnRecoveryOpenRecoveries: 0,
        turnRecoveryCorroboratedRetained: 0,
        turnRecoveryScheduledTurnsLost: 0,
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

function withRuntimeDetails(details: Record<string, unknown>): RecoveryDebtEvidence {
  const base = evidence();
  return evidence({
    runtime: { readable: true, details: { ...(base.runtime.details as Record<string, unknown>), ...details } },
  });
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
        scheduled_turns_lost: 0,
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

  it('reports lost scheduled turns without opening debt (#3754)', () => {
    const snapshot = normalizeRecoveryDebt(withRuntimeDetails({ turnRecoveryScheduledTurnsLost: 3 }));

    expect(snapshot.turn_recovery.scheduled_turns_lost).toBe(3);
    expect(snapshot.turn_recovery.readable).toBe(true);
    expect(snapshot.open).toBe(false);
    expect(snapshot.service_blocking).toBe(false);
    expect(snapshot.attention).toBe('none');
    expect(snapshot.reasons).toEqual([]);
  });

  it.each([
    ['absent', undefined],
    ['negative', -1],
    ['fractional', 1.5],
    ['string', '3'],
  ])('reports an %s lost-turn count as null without failing the section closed', (_label, value) => {
    const snapshot = normalizeRecoveryDebt(withRuntimeDetails({ turnRecoveryScheduledTurnsLost: value }));

    expect(snapshot.turn_recovery.scheduled_turns_lost).toBeNull();
    expect(snapshot.turn_recovery.readable).toBe(true);
    expect(snapshot.service_blocking).toBe(false);
    expect(snapshot.attention).toBe('none');
  });

  it('reports a null lost-turn count when the runtime evidence is unreadable', () => {
    const snapshot = normalizeRecoveryDebt(evidence({ runtime: { readable: false, details: null } }));

    expect(snapshot.turn_recovery).toMatchObject({ readable: false, scheduled_turns_lost: null });
    expect(snapshot.reasons).toContain('recovery_evidence_unreadable');
  });

  it('keeps retained debt open and nonblocking with stable reason ordering', () => {
    const value = evidence({
      continuity: { readable: true, open: 1, unresolved: 1, ambiguous: 0 },
      runtime: {
        readable: true,
        details: {
          recoveryBlockingReasons: [],
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
          recoveryBlockingReasons: ['turn_recovery_actionable'],
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
