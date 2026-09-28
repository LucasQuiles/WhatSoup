/**
 * #3560 — read-only, content-free ownership snapshot for inbounds stuck in
 * `processing`.
 *
 * RED STUB: exports the real API shape and returns wrong data (no rows,
 * everything healthy). The implementation lands in the follow-up commit.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { ProviderExecutionGateSnapshot } from './provider-execution-gate.ts';

export const INBOUND_OWNERSHIP_SCHEMA_VERSION = 1;

/** Same 15 minutes the reply-guarantee observer uses to call an open inbound stale. */
export const DEFAULT_OWNERSHIP_MIN_AGE_MINUTES = 15;

export type InboundOwnershipClass = 'queued' | 'deferred' | 'executing' | 'no_owner';

export type InboundOwnershipReason =
  | 'deferred_obligation_open'
  | 'deferred_obligation_exhausted'
  | 'recovery_job_pending'
  | 'recovery_job_claimed'
  | 'recovery_claim_expired'
  | 'recovery_job_blocked_unsafe'
  | 'recovery_job_exhausted'
  | 'recovery_job_completed_inbound_open'
  | 'recovery_delivery_corroborated_inbound_open'
  | 'terminal_record_inbound_open'
  | 'transferred_without_recovery_job'
  | 'queued_behind_fifo_head'
  | 'queued_behind_scope_recovery'
  | 'provider_execution_active'
  | 'provider_execution_waiting'
  | 'no_attributable_owner'
  | 'no_persisted_owner_provider_not_observed';

export type InboundOwnerKind =
  | 'deferred_obligation'
  | 'recovery_job'
  | 'scope_recovery_job'
  | 'fifo_head_inbound'
  | 'provider_execution'
  | 'provider_execution_waiter'
  | 'none';

export type InboundOwnershipQueueScope = 'per_chat' | 'global';

/** The content-free provider-execution fields the snapshot joins (#2340/#3547 read only). */
export type ProviderExecutionObservation = Pick<
  ProviderExecutionGateSnapshot,
  | 'active'
  | 'activeWorkKind'
  | 'activeScopeHash'
  | 'activeAgeMs'
  | 'activePhase'
  | 'progressAgeMs'
  | 'pending'
  | 'oldestPendingWorkKind'
  | 'oldestPendingScopeHash'
  | 'oldestWaitMs'
>;

export type ProviderExecutionEvidence =
  | 'not_supplied'
  | 'idle'
  | 'active_this_scope'
  | 'active_other_scope'
  | 'active_probe';

export interface InboundOwner {
  readonly kind: InboundOwnerKind;
  readonly inboundSeq: number | null;
  readonly logicalTurnId: string | null;
  readonly generation: number | null;
  readonly recoveryJobId: number | null;
  readonly deferredObligationId: number | null;
}

export interface InboundOwnershipRow {
  readonly inboundSeq: number;
  /** shortHash(chat JID) — the same content-free scope hash the provider gate publishes. */
  readonly chatScopeHash: string;
  readonly ageSeconds: number | null;
  readonly ageEvidence: 'valid' | 'invalid_timestamp';
  readonly classification: InboundOwnershipClass;
  readonly healthy: boolean;
  readonly reason: InboundOwnershipReason;
  readonly owner: InboundOwner;
  readonly queue: {
    readonly basis: 'persisted_open_inbounds';
    readonly scope: InboundOwnershipQueueScope;
    readonly depth: number;
    readonly position: number;
    readonly headInboundSeq: number;
  };
  readonly providerExecution: {
    readonly evidence: ProviderExecutionEvidence;
    readonly activePhase: string | null;
    readonly activeAgeMs: number | null;
    readonly progressAgeMs: number | null;
    readonly pending: number | null;
    readonly oldestPendingIsThisScope: boolean | null;
  };
  readonly deferredObligation: {
    readonly id: number;
    readonly status: string;
    readonly attemptCount: number;
    readonly claimEpoch: number;
  } | null;
  readonly recoveryJob: {
    readonly id: number;
    readonly state: string;
    readonly attemptCount: number;
    readonly claimEpoch: number;
    readonly assignedOwnerLogicalTurnId: string;
    readonly assignedOwnerGeneration: number;
    readonly nextAttemptInSeconds: number | null;
    readonly claimExpiresInSeconds: number | null;
    readonly deliveryCorroborated: boolean;
  } | null;
  readonly terminalRecord: {
    readonly id: number;
    readonly inboundDisposition: string;
    readonly deliveryKind: string;
    readonly logicalTurnId: string;
    readonly generation: number;
    readonly ageSeconds: number | null;
    readonly closeVerdict: string;
  } | null;
  readonly lastOutbound: {
    readonly id: number;
    readonly status: string;
    readonly isTerminal: boolean;
    readonly ageSeconds: number | null;
  } | null;
  readonly lastChatTerminal: {
    readonly inboundSeq: number | null;
    readonly inboundDisposition: string;
    readonly deliveryKind: string;
    readonly ageSeconds: number | null;
  } | null;
  readonly checkpoint: {
    readonly sessionStatus: string;
    readonly activeTurnId: string | null;
    readonly completedInboundSeq: number | null;
    readonly completedLogicalTurnId: string | null;
    readonly completedGeneration: number | null;
    readonly updatedAgeSeconds: number | null;
  } | null;
}

export interface InboundOwnershipSnapshot {
  readonly schemaVersion: typeof INBOUND_OWNERSHIP_SCHEMA_VERSION;
  readonly minAgeMinutes: number;
  readonly queueScope: InboundOwnershipQueueScope;
  readonly providerExecutionEvidence: 'supplied' | 'not_supplied';
  readonly healthy: boolean;
  readonly counts: {
    readonly processing: number;
    readonly reported: number;
    readonly queued: number;
    readonly deferred: number;
    readonly executing: number;
    readonly no_owner: number;
  };
  readonly rows: readonly InboundOwnershipRow[];
}

export interface InboundOwnershipSnapshotOptions {
  readonly minAgeMinutes: number;
  readonly queueScope?: InboundOwnershipQueueScope;
  readonly providerExecution?: ProviderExecutionObservation | null;
  readonly nowMs?: number;
}

export function parseProviderExecutionObservation(_value: unknown): ProviderExecutionObservation | null {
  return null;
}

export function readInboundOwnershipSnapshot(
  _raw: DatabaseSync,
  options: InboundOwnershipSnapshotOptions,
): InboundOwnershipSnapshot {
  return {
    schemaVersion: INBOUND_OWNERSHIP_SCHEMA_VERSION,
    minAgeMinutes: options.minAgeMinutes,
    queueScope: options.queueScope ?? 'per_chat',
    providerExecutionEvidence: 'not_supplied',
    healthy: true,
    counts: { processing: 0, reported: 0, queued: 0, deferred: 0, executing: 0, no_owner: 0 },
    rows: [],
  };
}
