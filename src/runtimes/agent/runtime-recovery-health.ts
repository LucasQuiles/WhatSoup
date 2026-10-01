import type { RuntimeTurnSupervisorHealth } from './runtime-turn-supervisor.ts';
import type { TurnRecoveryHealthDetails } from './turn-recovery-dispatch.ts';

export type RuntimeRecoveryBlockingReason =
  | 'turn_finalization_active'
  | 'turn_recovery_actionable'
  | 'turn_recovery_integrity'
  | 'turn_recovery_unclassified'
  | 'completed_delivery_identity_unclassified';

export type RuntimeRecoveryRetainedReason =
  | 'turn_recovery_terminal'
  | 'turn_recovery_quarantined'
  | 'historical_turn_catchup'
  | 'corroborated_delivery_retained'
  | 'completed_delivery_identity_fresh_inbound'
  | 'completed_delivery_identity_operator';

export interface RuntimeRecoveryHealthInput {
  finalization: RuntimeTurnSupervisorHealth;
  recovery: TurnRecoveryHealthDetails & {
    readonly turnRecoveryBlockingOutstanding?: number;
    readonly turnRecoveryRetainedTerminal?: number;
    readonly turnRecoveryCorroboratedRetained?: number;
  };
  completedDeliveryIdentity: {
    unresolvedCount: number;
    nextAction: 'fresh_inbound' | 'operator' | null;
  };
}

export interface RuntimeRecoveryHealthClassification {
  blocking: boolean;
  blockingReasons: RuntimeRecoveryBlockingReason[];
  retainedReasons: RuntimeRecoveryRetainedReason[];
  blockingOutstanding: number;
  retainedTerminal: number;
  corroboratedRetained: number;
  completedDeliveryIdentityBlocking: number;
  completedDeliveryIdentityRetained: number;
}

/**
 * Projects the blocking classification onto the two runtime degradedReasons
 * that reach `status_reasons` as `runtime.turn_finalization_debt` and
 * `runtime.completed_delivery_identity_debt`. Those literals are the registered
 * twins of the turn_finalization_degraded, turn_recovery_degraded and
 * delivery_identity_debt causes, so they are kept verbatim; the granular
 * blocking reasons travel separately in `recoveryBlockingReasons` for the
 * versioned `recovery_debt` contract. Retained debt sets neither flag.
 */
export function runtimeRecoveryDegradation(
  classification: Pick<RuntimeRecoveryHealthClassification, 'blockingReasons'>,
): { finalizationDegraded: boolean; completedDeliveryIdentityDebt: boolean } {
  return {
    finalizationDegraded: classification.blockingReasons.some(
      (reason) => reason !== 'completed_delivery_identity_unclassified',
    ),
    completedDeliveryIdentityDebt: classification.blockingReasons.includes(
      'completed_delivery_identity_unclassified',
    ),
  };
}

function pushUnique<T extends string>(values: T[], value: T): void {
  if (!values.includes(value)) values.push(value);
}

export function classifyRuntimeRecoveryHealth(
  input: RuntimeRecoveryHealthInput,
): RuntimeRecoveryHealthClassification {
  const { finalization, recovery, completedDeliveryIdentity } = input;
  const blockingReasons: RuntimeRecoveryBlockingReason[] = [];
  const retainedReasons: RuntimeRecoveryRetainedReason[] = [];

  if (finalization.retainedRetries > 0 || finalization.degradedScopes > 0) {
    pushUnique(blockingReasons, 'turn_finalization_active');
  }

  // Fallback when the store's blocking_outstanding gauge is absent:
  // pending/claimed work plus orphan transfers. These counters carry no
  // corroboration, so none is assumed and the fallback fails closed.
  const derivedBlockingOutstanding = recovery.turnRecoveryPending
    + recovery.turnRecoveryLiveClaimed
    + recovery.turnRecoveryExpiredClaimed
    + recovery.turnRecoveryOrphanTransfers;
  const blockingOutstanding = recovery.turnRecoveryBlockingOutstanding
    ?? derivedBlockingOutstanding;
  if (blockingOutstanding > 0) {
    pushUnique(blockingReasons, 'turn_recovery_actionable');
  }

  if (
    recovery.turnRecoveryCorruptLinks > 0
    || recovery.turnRecoveryOrphanTransfers > 0
    || recovery.turnRecoveryEchoConflicts > 0
  ) {
    pushUnique(blockingReasons, 'turn_recovery_integrity');
  }

  // The store computes outstanding as blocking_outstanding plus
  // corroborated_retained (each orphan transfer lands in exactly one of
  // them, by corroboration), so any
  // imbalance in EITHER direction means the gauges disagree about the same
  // rows. That is unexplained recovery evidence and fails closed.
  const corroboratedRetained = recovery.turnRecoveryCorroboratedRetained ?? 0;
  const unexplainedOutstanding =
    recovery.turnRecoveryOutstanding - blockingOutstanding - corroboratedRetained;
  if (unexplainedOutstanding !== 0) {
    pushUnique(blockingReasons, 'turn_recovery_unclassified');
  }

  const retainedTerminal = recovery.turnRecoveryRetainedTerminal
    ?? recovery.turnRecoveryBlockedUnsafe + recovery.turnRecoveryExhausted;
  if (retainedTerminal > 0) {
    pushUnique(retainedReasons, 'turn_recovery_terminal');
  }
  if (
    recovery.turnRecoveryQuarantinedDelivery > 0
    && blockingOutstanding === 0
  ) {
    pushUnique(retainedReasons, 'turn_recovery_quarantined');
  }
  if (recovery.turnRecoveryOpenRecoveries > 0) {
    pushUnique(retainedReasons, 'historical_turn_catchup');
  }
  if (corroboratedRetained > 0) {
    pushUnique(retainedReasons, 'corroborated_delivery_retained');
  }

  let completedDeliveryIdentityBlocking = 0;
  let completedDeliveryIdentityRetained = 0;
  if (completedDeliveryIdentity.unresolvedCount > 0) {
    if (completedDeliveryIdentity.nextAction === 'fresh_inbound') {
      completedDeliveryIdentityRetained = completedDeliveryIdentity.unresolvedCount;
      pushUnique(retainedReasons, 'completed_delivery_identity_fresh_inbound');
    } else if (completedDeliveryIdentity.nextAction === 'operator') {
      completedDeliveryIdentityRetained = completedDeliveryIdentity.unresolvedCount;
      pushUnique(retainedReasons, 'completed_delivery_identity_operator');
    } else {
      completedDeliveryIdentityBlocking = completedDeliveryIdentity.unresolvedCount;
      pushUnique(blockingReasons, 'completed_delivery_identity_unclassified');
    }
  }

  return {
    blocking: blockingReasons.length > 0,
    blockingReasons,
    retainedReasons,
    blockingOutstanding,
    retainedTerminal,
    corroboratedRetained,
    completedDeliveryIdentityBlocking,
    completedDeliveryIdentityRetained,
  };
}
