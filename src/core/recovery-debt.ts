export type RecoveryDebtAttention = 'none' | 'routine' | 'urgent';

export interface RecoveryDebtEvidence {
  continuity: unknown;
  runtime: {
    readable: boolean;
    details: unknown;
  };
  durability: {
    readable: boolean;
    deliveryBlocking: boolean;
    deliveryAmbiguity: unknown;
  };
}

export interface RecoveryDebtSnapshot {
  open: boolean;
  service_blocking: boolean;
  attention: RecoveryDebtAttention;
  reason: 'continuity_gap_open' | 'continuity_gap_unreadable' | null;
  reasons: string[];
  continuity: {
    readable: boolean;
    open: number;
    unresolved: number;
    ambiguous: number;
  };
  turn_recovery: {
    readable: boolean;
    blocking_outstanding: number;
    retained_terminal: number;
    open_catchups: number;
    corroborated_retained: number;
  };
  completed_delivery_identity: {
    readable: boolean;
    blocking: number;
    retained: number;
    next_action: 'fresh_inbound' | 'operator' | null;
  };
  delivery: {
    readable: boolean;
    uncorroborated_ambiguous: number;
    corroborated_retained: number;
    oldest_uncorroborated_at: string | null;
  };
}

export type RecoveryProof = 'clear' | 'retain' | 'degrade';

export interface RecoveryProofEvidence {
  transportConnected: boolean | null;
  modelEvidenceCurrent: boolean | null;
  runtimeReadable: boolean | null;
  schemaReadable: boolean | null;
  pendingPollsReadable: boolean | null;
  recoveryDebt: RecoveryDebtSnapshot;
}

const BLOCKING_RUNTIME_REASONS = [
  'turn_finalization_active',
  'turn_recovery_actionable',
  'turn_recovery_integrity',
  'turn_recovery_unclassified',
  'completed_delivery_identity_unclassified',
] as const;

const RETAINED_RUNTIME_REASONS = [
  'turn_recovery_terminal',
  'turn_recovery_quarantined',
  'historical_turn_catchup',
  'corroborated_delivery_retained',
  'completed_delivery_identity_fresh_inbound',
  'completed_delivery_identity_operator',
] as const;

const BLOCKING_REASON_SET = new Set<string>(BLOCKING_RUNTIME_REASONS);
const RETAINED_REASON_SET = new Set<string>(RETAINED_RUNTIME_REASONS);
const RECOVERY_REASON_ORDER = [
  'continuity_gap_unreadable',
  'continuity_gap_open',
  'recovery_evidence_unreadable',
  'delivery_evidence_unreadable',
  ...BLOCKING_RUNTIME_REASONS,
  'uncorroborated_delivery_ambiguity',
  ...RETAINED_RUNTIME_REASONS,
] as const;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function count(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return null;
  return value as string[];
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function unreadableContinuity(): RecoveryDebtSnapshot['continuity'] {
  return { readable: false, open: 0, unresolved: 0, ambiguous: 0 };
}

function normalizeContinuity(value: unknown): RecoveryDebtSnapshot['continuity'] {
  const source = record(value);
  if (!source || typeof source['readable'] !== 'boolean') return unreadableContinuity();
  const open = count(source['open']);
  const unresolved = count(source['unresolved']);
  const ambiguous = count(source['ambiguous']);
  if (open === null || unresolved === null || ambiguous === null) return unreadableContinuity();
  return { readable: source['readable'], open, unresolved, ambiguous };
}

function normalizeRuntime(value: RecoveryDebtEvidence['runtime']): {
  turnRecovery: RecoveryDebtSnapshot['turn_recovery'];
  completedIdentity: RecoveryDebtSnapshot['completed_delivery_identity'];
  blockingReasons: string[];
  retainedReasons: string[];
} {
  const unreadable = {
    turnRecovery: {
      readable: false,
      blocking_outstanding: 0,
      retained_terminal: 0,
      open_catchups: 0,
      corroborated_retained: 0,
    },
    completedIdentity: {
      readable: false,
      blocking: 0,
      retained: 0,
      next_action: null,
    },
    blockingReasons: ['recovery_evidence_unreadable'],
    retainedReasons: [],
  } satisfies {
    turnRecovery: RecoveryDebtSnapshot['turn_recovery'];
    completedIdentity: RecoveryDebtSnapshot['completed_delivery_identity'];
    blockingReasons: string[];
    retainedReasons: string[];
  };
  const details = record(value.details);
  if (!value.readable || !details) return unreadable;

  const blockingOutstanding = count(details['turnRecoveryBlockingOutstanding']);
  const retainedTerminal = count(details['turnRecoveryRetainedTerminal']);
  const openCatchups = count(details['turnRecoveryOpenRecoveries']);
  const corroboratedRetained = count(details['turnRecoveryCorroboratedRetained']);
  const identityBlocking = count(details['completedDeliveryIdentityBlocking']);
  const identityRetained = count(details['completedDeliveryIdentityRetained']);
  const degradedReasons = stringArray(details['degradedReasons']);
  const retainedReasons = stringArray(details['recoveryDebtReasons']);
  const admissions = record(details['completedDeliveryIdentityAdmissions']);
  const nextAction = admissions?.['nextAction'];
  const nextActionValid = nextAction === null || nextAction === 'fresh_inbound' || nextAction === 'operator';
  if (
    blockingOutstanding === null
    || retainedTerminal === null
    || openCatchups === null
    || corroboratedRetained === null
    || identityBlocking === null
    || identityRetained === null
    || degradedReasons === null
    || retainedReasons === null
    || !admissions
    || !nextActionValid
    || retainedReasons.some((reason) => !RETAINED_REASON_SET.has(reason))
  ) return unreadable;

  const unknownBlockingReason = degradedReasons.find((reason) => (
    (reason.startsWith('turn_recovery_')
      || reason.startsWith('turn_finalization_')
      || reason.startsWith('completed_delivery_identity_'))
    && !BLOCKING_REASON_SET.has(reason)
  ));
  if (unknownBlockingReason) return unreadable;

  const normalizedBlockingReasons = BLOCKING_RUNTIME_REASONS.filter((reason) => (
    degradedReasons.includes(reason)
  ));
  if (blockingOutstanding > 0) pushUnique(normalizedBlockingReasons, 'turn_recovery_actionable');
  if (identityBlocking > 0) {
    pushUnique(normalizedBlockingReasons, 'completed_delivery_identity_unclassified');
  }

  const normalizedRetainedReasons = RETAINED_RUNTIME_REASONS.filter((reason) => (
    retainedReasons.includes(reason)
  ));
  if (retainedTerminal > 0) pushUnique(normalizedRetainedReasons, 'turn_recovery_terminal');
  if (openCatchups > 0) pushUnique(normalizedRetainedReasons, 'historical_turn_catchup');
  if (corroboratedRetained > 0) {
    pushUnique(normalizedRetainedReasons, 'corroborated_delivery_retained');
  }
  if (identityRetained > 0 && nextAction === 'fresh_inbound') {
    pushUnique(normalizedRetainedReasons, 'completed_delivery_identity_fresh_inbound');
  }
  if (identityRetained > 0 && nextAction === 'operator') {
    pushUnique(normalizedRetainedReasons, 'completed_delivery_identity_operator');
  }

  return {
    turnRecovery: {
      readable: true,
      blocking_outstanding: blockingOutstanding,
      retained_terminal: retainedTerminal,
      open_catchups: openCatchups,
      corroborated_retained: corroboratedRetained,
    },
    completedIdentity: {
      readable: true,
      blocking: identityBlocking,
      retained: identityRetained,
      next_action: nextAction,
    },
    blockingReasons: normalizedBlockingReasons,
    retainedReasons: normalizedRetainedReasons,
  };
}

function normalizeDelivery(value: RecoveryDebtEvidence['durability']): {
  delivery: RecoveryDebtSnapshot['delivery'];
  blocking: boolean;
  reasons: string[];
} {
  const source = record(value.deliveryAmbiguity);
  const unreadable = {
    delivery: {
      readable: false,
      uncorroborated_ambiguous: 0,
      corroborated_retained: 0,
      oldest_uncorroborated_at: null,
    },
    blocking: true,
    reasons: ['delivery_evidence_unreadable'],
  } satisfies {
    delivery: RecoveryDebtSnapshot['delivery'];
    blocking: boolean;
    reasons: string[];
  };
  if (!value.readable || !source || source['readable'] !== true) return unreadable;
  const uncorroborated = count(source['uncorroboratedAmbiguous']);
  const corroborated = count(source['corroboratedRetained']);
  const oldest = source['oldestUncorroboratedAt'];
  if (
    uncorroborated === null
    || corroborated === null
    || (oldest !== null && typeof oldest !== 'string')
    || typeof value.deliveryBlocking !== 'boolean'
    || (value.deliveryBlocking && uncorroborated === 0)
  ) return unreadable;
  const reasons: string[] = [];
  if (uncorroborated > 0) reasons.push('uncorroborated_delivery_ambiguity');
  if (corroborated > 0) reasons.push('corroborated_delivery_retained');
  return {
    delivery: {
      readable: true,
      uncorroborated_ambiguous: uncorroborated,
      corroborated_retained: corroborated,
      oldest_uncorroborated_at: oldest,
    },
    blocking: value.deliveryBlocking,
    reasons,
  };
}

export function normalizeRecoveryDebt(evidence: RecoveryDebtEvidence): RecoveryDebtSnapshot {
  const continuity = normalizeContinuity(evidence.continuity);
  const runtime = normalizeRuntime(evidence.runtime);
  const delivery = normalizeDelivery(evidence.durability);
  const reasons: string[] = [];
  const continuityReason = !continuity.readable
    ? 'continuity_gap_unreadable'
    : continuity.open > 0
      ? 'continuity_gap_open'
      : null;
  if (continuityReason) reasons.push(continuityReason);
  for (const reason of runtime.blockingReasons) pushUnique(reasons, reason);
  for (const reason of delivery.reasons) pushUnique(reasons, reason);
  for (const reason of runtime.retainedReasons) pushUnique(reasons, reason);
  const orderedReasons = RECOVERY_REASON_ORDER.filter((reason) => reasons.includes(reason));

  const serviceBlocking = !continuity.readable
    || !runtime.turnRecovery.readable
    || !runtime.completedIdentity.readable
    || delivery.blocking
    || runtime.blockingReasons.length > 0;
  const open = serviceBlocking
    || continuity.open > 0
    || runtime.retainedReasons.length > 0
    || runtime.turnRecovery.retained_terminal > 0
    || runtime.turnRecovery.open_catchups > 0
    || runtime.turnRecovery.corroborated_retained > 0
    || runtime.completedIdentity.retained > 0
    || delivery.delivery.uncorroborated_ambiguous > 0
    || delivery.delivery.corroborated_retained > 0;

  return {
    open,
    service_blocking: serviceBlocking,
    attention: serviceBlocking ? 'urgent' : open ? 'routine' : 'none',
    reason: continuityReason,
    reasons: orderedReasons,
    continuity,
    turn_recovery: runtime.turnRecovery,
    completed_delivery_identity: runtime.completedIdentity,
    delivery: delivery.delivery,
  };
}

export function evaluateRecoveryProof(evidence: RecoveryProofEvidence): RecoveryProof {
  if (
    evidence.transportConnected === false
    || evidence.modelEvidenceCurrent === false
    || evidence.runtimeReadable === false
    || evidence.schemaReadable === false
    || evidence.pendingPollsReadable === false
    || evidence.recoveryDebt.service_blocking
  ) return 'degrade';
  if (
    evidence.transportConnected !== true
    || evidence.modelEvidenceCurrent !== true
    || evidence.runtimeReadable !== true
    || evidence.schemaReadable !== true
    || evidence.pendingPollsReadable !== true
  ) return 'retain';
  return 'clear';
}

export function applyRecoveryProof(
  statusReasons: string[],
  recentlyDegraded: Set<string>,
  instanceName: string,
  proof: RecoveryProof,
): void {
  if (statusReasons.length > 0 || proof === 'degrade') {
    recentlyDegraded.add(instanceName);
    if (statusReasons.length === 0) statusReasons.push('degradation_silence_unproven');
    return;
  }
  if (proof === 'clear') {
    recentlyDegraded.delete(instanceName);
    return;
  }
  if (recentlyDegraded.has(instanceName)) {
    statusReasons.push('degradation_silence_unproven');
  }
}
