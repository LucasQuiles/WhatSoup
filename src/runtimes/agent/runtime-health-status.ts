// src/runtimes/agent/runtime-health-status.ts
//
// Pure health verdicts for AgentRuntime.getHealthSnapshot: which degraded
// reasons apply, in their published order, and the resulting status. Moved out
// of runtime.ts unchanged; the runtime still gathers every input.

import type { RuntimeHealth } from '../../core/types.ts';

/** Inputs both session scopes read; each field is the snapshot the runtime already took. */
export interface RuntimeDegradationInput {
  autoCompactHealth: { activeBackoffScopes: number };
  fallbackState: { fallbackActiveUntil: unknown };
  finalizationDegraded: boolean;
  completedDeliveryIdentityDebt: boolean;
  agentRespawnFailedClearPending: boolean;
  turnQueueHealth: { turnQueueHalted: boolean };
  poisonHealth: { outboundQueuePoisoned: boolean };
  providerExecution: { pressureActive: boolean };
  pollPersistenceHealth: { degraded: boolean };
  offlineDecisionRetry: { exhausted: boolean };
  accountIdentityReasons: readonly string[];
}

/** Activity summary over per-chat session statuses: the most recently started one names the last session. */
export function summarizePerChatSessions(statuses: Iterable<{ active: boolean; startedAt: string | null }>): {
  activeSessions: number;
  lastSessionStatus: string | null;
  lastSessionStartedAt: string | null;
} {
  let activeSessions = 0;
  let lastSessionStatus: string | null = null;
  let lastSessionStartedAt: string | null = null;
  let mostRecentStartMs = -1;
  for (const st of statuses) {
    if (st.active) activeSessions++;
    // Track the most recently started session for lastSession* fields
    if (st.startedAt) {
      const startMs = new Date(st.startedAt).getTime();
      if (startMs > mostRecentStartMs) {
        mostRecentStartMs = startMs;
        lastSessionStatus = st.active ? 'active' : 'idle';
        lastSessionStartedAt = st.startedAt;
      }
    }
  }
  return { activeSessions, lastSessionStatus, lastSessionStartedAt };
}

/** Degraded reasons of a per_chat runtime, in published order. */
export function perChatDegradedReasons(input: RuntimeDegradationInput & {
  recentCrashCount: number;
  perChatSessionsWithoutOwner: number;
  perChatRespawnAbandoned: number;
}): string[] {
  const degradedReasons: string[] = [];
  // Idle per-chat sessions are normal; recent crashes degrade even after map cleanup.
  if (input.recentCrashCount > 0) degradedReasons.push('recent_crashes');
  if (input.autoCompactHealth.activeBackoffScopes > 0) degradedReasons.push('auto_compact_backoff');
  if (input.fallbackState.fallbackActiveUntil !== null) degradedReasons.push('provider_fallback_active');
  if (input.finalizationDegraded) degradedReasons.push('turn_finalization_debt');
  if (input.completedDeliveryIdentityDebt) degradedReasons.push('completed_delivery_identity_debt');
  // This state rejects every inbound turn in the affected chat and, before
  // the eviction path, did so with no operator-visible signal at all.
  if (input.perChatSessionsWithoutOwner > 0) {
    degradedReasons.push('per_chat_session_without_owner');
  }
  // An abandoned respawn stops recovering this chat until the user writes
  // again, and unlike recent_crashes this signal does not decay inside the
  // crash-health window.
  if (input.perChatRespawnAbandoned > 0) {
    degradedReasons.push('per_chat_respawn_abandoned');
  }
  if (input.agentRespawnFailedClearPending) {
    degradedReasons.push('agent_respawn_failed_clear_pending');
  }
  if (input.turnQueueHealth.turnQueueHalted) degradedReasons.push('turn_queue_halted');
  if (input.poisonHealth.outboundQueuePoisoned) degradedReasons.push('outbound_queue_poisoned');
  if (input.providerExecution.pressureActive) degradedReasons.push('provider_execution_pressure');
  if (input.pollPersistenceHealth.degraded) degradedReasons.push('poll_persistence_failure');
  if (input.offlineDecisionRetry.exhausted) degradedReasons.push('offline_decision_retry_exhausted');
  // The spread keeps this name: tests/core/health-cause-reason-twins.test.ts classifies push sites by their text.
  const { accountIdentityReasons } = input;
  degradedReasons.push(...accountIdentityReasons);
  return degradedReasons;
}

/** Degraded reasons of a single or shared runtime, in published order. */
export function singleSessionDegradedReasons(input: RuntimeDegradationInput & { sessionInactive: boolean }): string[] {
  // If a session exists but its child process is not active, it has crashed
  const degradedReasons: string[] = [];
  if (input.sessionInactive) degradedReasons.push('session_inactive');
  if (input.autoCompactHealth.activeBackoffScopes > 0) degradedReasons.push('auto_compact_backoff');
  if (input.fallbackState.fallbackActiveUntil !== null) degradedReasons.push('provider_fallback_active');
  if (input.finalizationDegraded) degradedReasons.push('turn_finalization_debt');
  if (input.completedDeliveryIdentityDebt) degradedReasons.push('completed_delivery_identity_debt');
  if (input.providerExecution.pressureActive) degradedReasons.push('provider_execution_pressure');
  if (input.turnQueueHealth.turnQueueHalted) degradedReasons.push('turn_queue_halted');
  if (input.poisonHealth.outboundQueuePoisoned) degradedReasons.push('outbound_queue_poisoned');
  if (input.pollPersistenceHealth.degraded) degradedReasons.push('poll_persistence_failure');
  if (input.offlineDecisionRetry.exhausted) degradedReasons.push('offline_decision_retry_exhausted');
  if (input.agentRespawnFailedClearPending) {
    degradedReasons.push('agent_respawn_failed_clear_pending');
  }
  const { accountIdentityReasons } = input;
  degradedReasons.push(...accountIdentityReasons);
  return degradedReasons;
}

/**
 * A halted single/shared queue is the active admission path — unhealthy/503,
 * matching the public-surface contract; every other reason degrades only.
 */
export function singleSessionHealthStatus(
  degradedReasons: readonly string[],
  turnQueueHalted: boolean,
  activeAdmissionLaneBlocked: boolean,
): RuntimeHealth['status'] {
  return turnQueueHalted || activeAdmissionLaneBlocked
    ? 'unhealthy'
    : degradedReasons.length > 0
      ? 'degraded'
      : 'healthy';
}
