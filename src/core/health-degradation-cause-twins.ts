// src/core/health-degradation-cause-twins.ts
//
// One condition, one cross-reference. /health reports degradation under two
// vocabularies: `status_reasons` (ordered, human-facing, supports the aggregate
// status) and `degradation_causes` (typed, what alerts and flap detection key
// on). Several conditions reach the wire under DIFFERENT names in the two
// vectors — the clearest being runtimeTurnRecoveryIsDegraded, which is
// `runtime.turn_finalization_debt` as a reason and `turn_recovery_degraded`
// as a cause — with nothing tying the names together. #3316's
// ensureStatusReasonFloor only guarantees a reason EXISTS; it does not say
// which reason a cause corresponds to.
//
// This table is that cross-reference. It is deliberately a TS Record over the
// HealthDegradationCause union so totality is a compile-time fact (a new cause
// without an entry fails typecheck) and tests/core/health-cause-reason-twins
// keeps every named reason honest against the emitting source.
//
// Live strings are NEVER renamed here — the soak baseline depends on
// `runtime.turn_finalization_debt`, `runtime.completed_delivery_identity_debt`,
// `turn_recovery_degraded`, `turn_capability_degraded`, and
// `turn_capability_evidence_stale` verbatim. Add, never rename.

import type { HealthDegradationCause } from './health.ts';

/**
 * Annotation for a cause whose condition the status_reasons vector genuinely
 * never names (it only ever reaches the wire as a cause). Using it is a
 * reviewed choice: the twins test pins the exact set of annotated causes.
 */
export const NO_REASON_TWIN = 'no_reason_twin';

/**
 * Reason twins are exact `status_reasons` literals, `runtime.<reason>` for the
 * agent-runtime degradedReasons passthrough, or a `prefix*` family where the
 * reason carries a classifier suffix (`auth_failure.<class>`,
 * `memory_readiness_<state>`).
 */
export type HealthDegradationCauseReasonTwins = readonly string[] | typeof NO_REASON_TWIN;

export const HEALTH_DEGRADATION_CAUSE_REASON_TWINS: Readonly<
  Record<HealthDegradationCause, HealthDegradationCauseReasonTwins>
> = {
  // provider fallback — the fallback window surfaces as an agent-runtime
  // degradedReason; chain exhaustion and entry failures only widen the cause
  // vector (they feed turn_capability_degraded indirectly via
  // healthyProviderFallbackCapacity but push no reason of their own).
  provider_fallback_active: ['runtime.provider_fallback_active'],
  fallback_chain_exhausted: NO_REASON_TWIN,
  fallback_entry_failures: NO_REASON_TWIN,
  // turn capability — every model/evidence/error condition folds into the one
  // turn_capability_degraded reason (turnCapabilityIsDegraded).
  primary_model_unusable: ['turn_capability_degraded'],
  model_unusable: ['turn_capability_degraded'],
  turn_capability_error: ['turn_capability_degraded'],
  primary_model_evidence_stale: ['turn_capability_degraded'],
  turn_capability_evidence_stale: ['turn_capability_degraded'],
  // transport / auth
  auth_bond_degraded: ['auth_failure.*'],
  transport_disconnected: ['connection_disconnected', 'connection_recovering'],
  connection_churn: ['connection_churn'],
  outbound_flood: ['outbound_flood'],
  // enrichment / memory
  enrichment_stale: ['enrichment_stale'],
  enrichment_runtime_degraded: ['enrichment_runtime_degraded'],
  memory_readiness_degraded: ['memory_readiness_*'],
  memory_context_degraded: ['memory_context_*'],
  memory_consolidation_degraded: ['memory_consolidation_*'],
  // process / durability / storage
  event_loop_starved: ['event_loop_starvation'],
  durability_debt: ['durability_delivery_debt'],
  durability_evidence_unreadable: ['durability_evidence_unreadable'],
  database_retention_failed: ['database_retention_failed'],
  // continuity gaps are exposed in the body and the cause vector only; the
  // reason vector has never carried them.
  continuity_gap_unreadable: NO_REASON_TWIN,
  continuity_gap_open: NO_REASON_TWIN,
  schema_future: ['schema_future'],
  schema_not_ready: ['schema_not_ready'],
  pending_polls_unreadable: ['pending_polls_unreadable'],
  // agent runtime — each cause is keyed from a runtime detail counter whose
  // companion degradedReason reaches the reason vector as `runtime.<reason>`.
  agent_recent_crashes: ['runtime.recent_crashes'],
  agent_auto_compact_backoff: ['runtime.auto_compact_backoff'],
  agent_session_inactive: ['runtime.session_inactive'],
  // runtimeTurnRecoveryIsDegraded pushes ONE reason for finalization debt AND
  // recovery debt; the cause vector splits the same predicate into two names.
  turn_finalization_degraded: ['runtime.turn_finalization_debt'],
  turn_recovery_degraded: ['runtime.turn_finalization_debt'],
  delivery_identity_debt: ['runtime.completed_delivery_identity_debt'],
  provider_execution_pressure: ['runtime.provider_execution_pressure'],
  // the fall-through when the agent runtime is degraded for a reason no named
  // cause covers — these are the degradedReasons without a cause of their own,
  // plus the bare marker used when the runtime reported no reasons at all.
  agent_runtime_degraded_unclassified: [
    'runtime.turn_queue_halted',
    'runtime.poll_persistence_failure',
    'runtime.offline_decision_retry_exhausted',
    'agent_runtime_degraded',
  ],
  agent_runtime_unhealthy: ['agent_runtime_unhealthy'],
  chat_runtime_degraded: ['runtime_degraded', 'runtime_unhealthy'],
  passive_runtime_degraded: ['runtime_degraded', 'runtime_unhealthy'],
  // the two symmetric floors
  degradation_silence_unproven: ['degradation_silence_unproven'],
  unclassified: ['unclassified'],
};
