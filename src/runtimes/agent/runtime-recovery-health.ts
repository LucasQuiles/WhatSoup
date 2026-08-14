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

  const derivedBlockingOutstanding = recovery.turnRecoveryPending
    + recovery.turnRecoveryLiveClaimed
    + recovery.turnRecoveryExpiredClaimed;
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

  const corroboratedRetained = recovery.turnRecoveryCorroboratedRetained ?? 0;
  const unexplainedOutstanding = Math.max(
    0,
    recovery.turnRecoveryOutstanding - blockingOutstanding - corroboratedRetained,
  );
  if (unexplainedOutstanding > 0) {
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
