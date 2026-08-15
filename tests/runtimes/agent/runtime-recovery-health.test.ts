import { describe, expect, it } from 'vitest';
import {
  classifyRuntimeRecoveryHealth,
  type RuntimeRecoveryHealthInput,
} from '../../../src/runtimes/agent/runtime-recovery-health.ts';

function input(
  recovery: Partial<RuntimeRecoveryHealthInput['recovery']> = {},
  completedDeliveryIdentity: Partial<RuntimeRecoveryHealthInput['completedDeliveryIdentity']> = {},
  finalization: Partial<RuntimeRecoveryHealthInput['finalization']> = {},
): RuntimeRecoveryHealthInput {
  const blockingOutstanding = recovery.turnRecoveryBlockingOutstanding
    ?? (recovery.turnRecoveryPending ?? 0)
      + (recovery.turnRecoveryLiveClaimed ?? 0)
      + (recovery.turnRecoveryExpiredClaimed ?? 0);
  const retainedTerminal = recovery.turnRecoveryRetainedTerminal
    ?? (recovery.turnRecoveryBlockedUnsafe ?? 0)
      + (recovery.turnRecoveryExhausted ?? 0);
  return {
    finalization: {
      retainedRetries: 0,
      degradedScopes: 0,
      retryAttempts: 0,
      retryRecoveries: 0,
      retryExhaustions: 0,
      ...finalization,
    },
    recovery: {
      turnRecoveryOutstanding: 0,
      turnRecoveryPending: 0,
      turnRecoveryLiveClaimed: 0,
      turnRecoveryExpiredClaimed: 0,
      turnRecoveryBlockedUnsafe: 0,
      turnRecoveryExhausted: 0,
      turnRecoveryOpenRecoveries: 0,
      turnRecoveryQuarantinedDelivery: 0,
      turnRecoveryCorruptLinks: 0,
      turnRecoveryOrphanTransfers: 0,
      turnRecoveryEchoConflicts: 0,
      turnRecoveryCorroboratedRetained: 0,
      ...recovery,
      turnRecoveryBlockingOutstanding: blockingOutstanding,
      turnRecoveryRetainedTerminal: retainedTerminal,
    },
    completedDeliveryIdentity: {
      unresolvedCount: 0,
      nextAction: null,
      ...completedDeliveryIdentity,
    },
  };
}

describe('classifyRuntimeRecoveryHealth', () => {
  it.each([
    {
      label: 'no recovery debt',
      value: input(),
      blocking: false,
      blockingReasons: [],
      retainedReasons: [],
    },
    {
      label: 'retained finalization retry',
      value: input({}, {}, { retainedRetries: 1 }),
      blocking: true,
      blockingReasons: ['turn_finalization_active'],
      retainedReasons: [],
    },
    {
      label: 'pending actionable recovery',
      value: input({ turnRecoveryOutstanding: 1, turnRecoveryPending: 1 }),
      blocking: true,
      blockingReasons: ['turn_recovery_actionable'],
      retainedReasons: [],
    },
    {
      label: 'live claimed recovery',
      value: input({ turnRecoveryOutstanding: 1, turnRecoveryLiveClaimed: 1 }),
      blocking: true,
      blockingReasons: ['turn_recovery_actionable'],
      retainedReasons: [],
    },
    {
      label: 'blocked unsafe terminal record',
      value: input({ turnRecoveryBlockedUnsafe: 1 }),
      blocking: false,
      blockingReasons: [],
      retainedReasons: ['turn_recovery_terminal'],
    },
    {
      label: 'exhausted terminal record',
      value: input({ turnRecoveryExhausted: 1 }),
      blocking: false,
      blockingReasons: [],
      retainedReasons: ['turn_recovery_terminal'],
    },
    {
      label: 'historical operator catch-up',
      value: input({ turnRecoveryOpenRecoveries: 1 }),
      blocking: false,
      blockingReasons: [],
      retainedReasons: ['historical_turn_catchup'],
    },
    {
      label: 'corrupt recovery link',
      value: input({ turnRecoveryCorruptLinks: 1 }),
      blocking: true,
      blockingReasons: ['turn_recovery_integrity'],
      retainedReasons: [],
    },
    {
      label: 'echo conflict',
      value: input({ turnRecoveryEchoConflicts: 1 }),
      blocking: true,
      blockingReasons: ['turn_recovery_integrity'],
      retainedReasons: [],
    },
    {
      label: 'corroborated selected delivery',
      value: input({ turnRecoveryCorroboratedRetained: 1 }),
      blocking: false,
      blockingReasons: [],
      retainedReasons: ['corroborated_delivery_retained'],
    },
    {
      label: 'unclassified outstanding recovery',
      value: input({ turnRecoveryOutstanding: 1 }),
      blocking: true,
      blockingReasons: ['turn_recovery_unclassified'],
      retainedReasons: [],
    },
    {
      label: 'inactive quarantined delivery',
      value: input({ turnRecoveryQuarantinedDelivery: 1 }),
      blocking: false,
      blockingReasons: [],
      retainedReasons: ['turn_recovery_quarantined'],
    },
    {
      label: 'fresh-inbound identity quarantine',
      value: input({}, { unresolvedCount: 3, nextAction: 'fresh_inbound' }),
      blocking: false,
      blockingReasons: [],
      retainedReasons: ['completed_delivery_identity_fresh_inbound'],
    },
    {
      label: 'operator identity quarantine',
      value: input({}, { unresolvedCount: 2, nextAction: 'operator' }),
      blocking: false,
      blockingReasons: [],
      retainedReasons: ['completed_delivery_identity_operator'],
    },
    {
      label: 'unclassified identity quarantine',
      value: input({}, { unresolvedCount: 2, nextAction: null }),
      blocking: true,
      blockingReasons: ['completed_delivery_identity_unclassified'],
      retainedReasons: [],
    },
  ])('$label', ({ value, blocking, blockingReasons, retainedReasons }) => {
    expect(classifyRuntimeRecoveryHealth(value)).toMatchObject({
      blocking,
      blockingReasons,
      retainedReasons,
    });
  });

  it('deduplicates reasons and returns aggregate blocking and retained gauges', () => {
    expect(classifyRuntimeRecoveryHealth(input(
      {
        turnRecoveryOutstanding: 3,
        turnRecoveryPending: 1,
        turnRecoveryLiveClaimed: 1,
        turnRecoveryExpiredClaimed: 1,
        turnRecoveryBlockedUnsafe: 4,
        turnRecoveryExhausted: 2,
        turnRecoveryOpenRecoveries: 5,
        turnRecoveryCorroboratedRetained: 6,
      },
      { unresolvedCount: 7, nextAction: 'fresh_inbound' },
      { retainedRetries: 1, degradedScopes: 1 },
    ))).toEqual({
      blocking: true,
      blockingReasons: ['turn_finalization_active', 'turn_recovery_actionable'],
      retainedReasons: [
        'turn_recovery_terminal',
        'historical_turn_catchup',
        'corroborated_delivery_retained',
        'completed_delivery_identity_fresh_inbound',
      ],
      blockingOutstanding: 3,
      retainedTerminal: 6,
      corroboratedRetained: 6,
      completedDeliveryIdentityBlocking: 0,
      completedDeliveryIdentityRetained: 7,
    });
  });
});
