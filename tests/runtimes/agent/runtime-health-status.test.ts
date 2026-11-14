import { describe, expect, it } from 'vitest';
import {
  perChatDegradedReasons,
  singleSessionDegradedReasons,
  singleSessionHealthStatus,
  summarizePerChatSessions,
  type RuntimeDegradationInput,
} from '../../../src/runtimes/agent/runtime-health-status.ts';

const HEALTHY: RuntimeDegradationInput = {
  autoCompactHealth: { activeBackoffScopes: 0 },
  fallbackState: { fallbackActiveUntil: null },
  finalizationDegraded: false,
  completedDeliveryIdentityDebt: false,
  agentRespawnFailedClearPending: false,
  turnQueueHealth: { turnQueueHalted: false },
  poisonHealth: { outboundQueuePoisoned: false },
  providerExecution: { pressureActive: false },
  pollPersistenceHealth: { degraded: false },
  offlineDecisionRetry: { exhausted: false },
  accountIdentityReasons: [],
};

const EVERYTHING: RuntimeDegradationInput = {
  autoCompactHealth: { activeBackoffScopes: 2 },
  fallbackState: { fallbackActiveUntil: 1_800_000_000_000 },
  finalizationDegraded: true,
  completedDeliveryIdentityDebt: true,
  agentRespawnFailedClearPending: true,
  turnQueueHealth: { turnQueueHalted: true },
  poisonHealth: { outboundQueuePoisoned: true },
  providerExecution: { pressureActive: true },
  pollPersistenceHealth: { degraded: true },
  offlineDecisionRetry: { exhausted: true },
  accountIdentityReasons: ['credential_identity_mismatch'],
};

describe('summarizePerChatSessions', () => {
  it('counts active sessions and names the most recently started one', () => {
    expect(summarizePerChatSessions([
      { active: true, startedAt: '2026-11-13T10:00:00.000Z' },
      { active: false, startedAt: '2026-11-13T12:00:00.000Z' },
      { active: true, startedAt: null },
    ])).toEqual({ activeSessions: 2, lastSessionStatus: 'idle', lastSessionStartedAt: '2026-11-13T12:00:00.000Z' });
  });

  it('reports no last session when none has started', () => {
    expect(summarizePerChatSessions([])).toEqual({ activeSessions: 0, lastSessionStatus: null, lastSessionStartedAt: null });
  });
});

describe('perChatDegradedReasons', () => {
  const perChat = { recentCrashCount: 0, perChatSessionsWithoutOwner: 0, perChatRespawnAbandoned: 0 };

  it('reports nothing for a healthy per_chat runtime', () => {
    expect(perChatDegradedReasons({ ...HEALTHY, ...perChat })).toEqual([]);
  });

  it('lists every reason in the published per_chat order', () => {
    expect(perChatDegradedReasons({
      ...EVERYTHING, recentCrashCount: 1, perChatSessionsWithoutOwner: 3, perChatRespawnAbandoned: 1,
    })).toEqual([
      'recent_crashes', 'auto_compact_backoff', 'provider_fallback_active', 'turn_finalization_debt',
      'completed_delivery_identity_debt', 'per_chat_session_without_owner', 'per_chat_respawn_abandoned',
      'agent_respawn_failed_clear_pending', 'turn_queue_halted', 'outbound_queue_poisoned',
      'provider_execution_pressure', 'poll_persistence_failure', 'offline_decision_retry_exhausted',
      'credential_identity_mismatch',
    ]);
  });
});

describe('singleSessionDegradedReasons', () => {
  it('reports nothing for a healthy single runtime', () => {
    expect(singleSessionDegradedReasons({ ...HEALTHY, sessionInactive: false })).toEqual([]);
  });

  it('lists every reason in the published single-session order', () => {
    expect(singleSessionDegradedReasons({ ...EVERYTHING, sessionInactive: true })).toEqual([
      'session_inactive', 'auto_compact_backoff', 'provider_fallback_active', 'turn_finalization_debt',
      'completed_delivery_identity_debt', 'provider_execution_pressure', 'turn_queue_halted',
      'outbound_queue_poisoned', 'poll_persistence_failure', 'offline_decision_retry_exhausted',
      'agent_respawn_failed_clear_pending', 'credential_identity_mismatch',
    ]);
  });
});

describe('singleSessionHealthStatus', () => {
  it('is unhealthy when the active admission path is halted or blocked, else degraded by any reason', () => {
    expect(singleSessionHealthStatus([], true, false)).toBe('unhealthy');
    expect(singleSessionHealthStatus([], false, true)).toBe('unhealthy');
    expect(singleSessionHealthStatus(['auto_compact_backoff'], false, false)).toBe('degraded');
    expect(singleSessionHealthStatus([], false, false)).toBe('healthy');
  });
});
