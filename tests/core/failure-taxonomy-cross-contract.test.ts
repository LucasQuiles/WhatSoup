import { describe, expect, it, vi } from 'vitest';
import registry from '../../src/lib/fault-taxonomy-registry.json' with { type: 'json' };
import { Database } from '../../src/core/database.ts';
import { AgentRuntime } from '../../src/runtimes/agent/runtime.ts';
import { makeMessenger } from '../runtimes/agent/lib/session-harness.ts';
import {
  ADMISSION_REJECT_CLASSES,
  INBOUND_FAILURE_CLASSES,
} from '../../src/core/inbound-failure-class.ts';
import {
  HEALTH_DEGRADATION_CAUSES,
  HEALTH_TURN_ERROR_CLASSES,
} from '../../src/core/health.ts';
import { normalizeFinalizeTurnTerminalParams } from '../../src/core/turn-finalization-contract.ts';
import {
  AGENT_FAILURE_CLASSES,
  PROVIDER_FAILURE_KINDS,
} from '../../src/runtimes/agent/failure-taxonomy.ts';
import {
  TURN_CAPABILITY_ERROR_CLASSES,
} from '../../src/runtimes/agent/turn-capability-tracker.ts';
import {
  TERMINAL_ATTEMPT_FAILURE_CLASSES,
  toTurnFinalizationPersistence,
  type AttemptOutcome,
  type TurnTerminalResult,
} from '../../src/runtimes/agent/turn-terminal.ts';
import {
  MEMORY_OPERATION_FAILURE_CODES,
} from '../../src/lib/memory-operation-telemetry.ts';
import {
  CONSOLIDATION_FAILURE_CODES,
} from '../../src/core/memory-consolidation-contract.ts';
import {
  OUTBOUND_FAILURE_CODES,
  TOOL_FAILURE_CODES,
} from '../../src/core/durability-evidence-contract.ts';
import {
  OUTBOUND_FAILURE_STAGES,
  OUTBOUND_MUTATION_STATES,
  OUTBOUND_EVIDENCE_COVERAGE,
  OUTBOUND_QUARANTINE_DISPOSITIONS,
  OUTBOUND_QUARANTINE_DISPOSITION_POLICIES,
  type InternalOutboundFailureCode,
} from '../../src/core/outbound-failure-disposition.ts';
import {
  RUNTIME_AGENT_HEALTH_SIGNALS,
  RUNTIME_AGENT_HEALTH_SIGNAL_FIELDS,
} from '../../src/lib/fault-classifier.ts';
import { getTurnRecoveryHealthDetails } from '../../src/runtimes/agent/turn-recovery-dispatch.ts';

vi.mock('../../src/lib/emit-alert.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/lib/emit-alert.ts')>(),
  emitAlert: vi.fn(),
}));

vi.mock('../../src/logger.ts', async () => {
  const { loggerMock } = await import('../helpers/logger-mock.ts');
  const mock = loggerMock();
  const logger = mock.createChildLogger();
  return {
    ...mock,
    default: { ...logger, child: () => logger },
    flushLogger: vi.fn(),
  };
});

// Top-level numeric agent health fields that are deliberately NOT in
// runtimeAgentHealthSignals. Every other numeric key the runtime projects must
// be registered, or the bot-errors health check drops it from its evidence.
const UNREGISTERED_NUMERIC_AGENT_HEALTH_FIELDS = new Set([
  // A USD float; the checker's read_int drops non-integral values.
  'fallbackWindowCostUsd',
]);

function projectedNumericAgentHealthFields(sessionScope: 'single' | 'per_chat'): string[] {
  const db = new Database(':memory:');
  db.open();
  try {
    const runtime = new AgentRuntime(db, makeMessenger().messenger, `registry-${sessionScope}`, {
      sessionScope,
    });
    const { details } = runtime.getHealthSnapshot();
    return Object.entries(details)
      .filter(([, value]) => typeof value === 'number')
      .map(([field]) => field);
  } finally {
    db.close();
  }
}

// if an extra key is present (excess-property checking on the literal),
// so this map's keys are exhaustively bound to the union at compile time.
const INTERNAL_OUTBOUND_FAILURE_CODE_MAP: Record<InternalOutboundFailureCode, true> = {
  'outbound.unknown_failure': true,
  'outbound.shutdown_before_send': true,
  'outbound.shutdown_deadline': true,
  'outbound.crash_in_flight': true,
  'outbound.echo_timeout': true,
  'outbound.superseded': true,
  'outbound.pending_replay_unreconstructable': true,
  'outbound.status_ping_expired': true,
  'outbound.unsafe_delivery_unconfirmed': true,
  'outbound.governor_shed': true,
  'outbound.identity_blocked': true,
  'outbound.replay_failed': true,
  'outbound.deferral_limit_exceeded': true,
  'outbound.replay_attempt_limit_exceeded': true,
};

const sorted = (values: Iterable<string>): string[] => [...values].sort();


function failedTerminal(failureClass: AttemptOutcome & { kind: 'failed' }): TurnTerminalResult {
  return {
    identity: {
      scope: 'per_chat',
      conversationKey: '15550100001',
      deliveryJid: '15550100001:7@s.whatsapp.net',
      inboundSeq: 41,
      logicalTurnId: 'turn-41',
      managerId: 'manager-a',
      generation: 3,
    },
    attemptOutcome: failureClass,
    inboundDisposition: 'failed_terminal',
    deliveryEvidence: { kind: 'none' },
  };
}

describe('failure taxonomy cross-contract', () => {
  it('registers the bounded silence-registry outage source and its lifecycle owner', () => {
    expect(registry.sourceDispositions['silence_registry_unavailable']).toEqual({
      disposition: 'operator_control_plane_unavailable_requires_fresh_read',
      owner: 'src/fleet/health-poller.ts',
      test: 'tests/fleet/health-poller-suppression-episodes.test.ts',
    });
  });

  it('registers the complete runtime-agent numeric health projection with typed dispositions', () => {
    const expectedFields = [
      'activeSessions',
      'sessionCount',
      'outboundQueuePoisonedScopes',
      'recentCrashes',
      'pollPersistenceErrors',
      'autoCompactIneffective',
      'autoCompactConsecutiveRapidRearmsMax',
      'autoCompactNextTurnOverThreshold',
      'autoCompactActiveBackoffScopes',
      'autoCompactWorstCurrentBackoffTier',
      'turnFinalizationDegradedScopes',
      'turnRecoveryOutstanding',
      'turnRecoveryBlockingOutstanding',
      'turnRecoveryRetainedTerminal',
      'turnRecoveryCorroboratedRetained',
      'completedDeliveryIdentityBlocking',
      'completedDeliveryIdentityRetained',
      'turnRecoveryPending',
      'turnRecoveryExpiredClaimed',
      'turnRecoveryBlockedUnsafe',
      'turnRecoveryBlockedUnsafeSynthetic',
      'turnRecoveryBlockedUnsafeSuperseded',
      'turnRecoveryBlockedUnsafeStranded',
      'turnRecoveryExhausted',
      'turnRecoveryOpenRecoveries',
      'turnRecoveryQuarantinedDelivery',
      'turnRecoveryCorruptLinks',
      'turnRecoveryOrphanTransfers',
      'turnRecoveryEchoConflicts',
      'turnFinalizationRetainedRetries',
      'turnFinalizationRetryAttempts',
      'turnFinalizationRetryRecoveries',
      'turnFinalizationRetryExhaustions',
      'turnRecoveryLiveClaimed',
      'perChatSessionsWithoutOwner',
      'perChatRespawnAbandoned',
      'turnQueueHaltedScopes',
      'proactiveResumeIdentityRejects',
      'unownedProviderEventRejects',
      'suppressedSystemTurnEffectRejects',
      'chronologyDelayedDispatches',
      'chronologyRecoveryReplayDispatches',
      'chronologyMaxQueueAgeSeconds',
      'fallbackTurnsServed',
      'fallbackTurnsEmpty',
      'fallbackActivations',
      'fallbackReverts',
      'fallbackReplays',
      'probeAttempts',
      'failedEntryCount',
    ] as const;

    expect(registry.schema).toBe('whatsoup-fault-taxonomy-registry-v3');
    expect(RUNTIME_AGENT_HEALTH_SIGNAL_FIELDS).toEqual(expectedFields);
    expect(registry.runtimeAgentHealthSignals).toEqual(RUNTIME_AGENT_HEALTH_SIGNALS);
    expect(new Set(RUNTIME_AGENT_HEALTH_SIGNAL_FIELDS).size)
      .toBe(RUNTIME_AGENT_HEALTH_SIGNAL_FIELDS.length);
    expect(new Set(RUNTIME_AGENT_HEALTH_SIGNALS.map((entry) => entry.label)).size)
      .toBe(RUNTIME_AGENT_HEALTH_SIGNALS.length);
    expect(new Set(RUNTIME_AGENT_HEALTH_SIGNALS.map((entry) => entry.kind)))
      .toEqual(new Set([
        'current_gauge',
        'active_episode_count',
        'terminal_audit_count',
        'cumulative_total',
        'historical_maximum',
      ]));
    expect(new Set(RUNTIME_AGENT_HEALTH_SIGNALS.map((entry) => entry.currentHealthEffect)))
      .toEqual(new Set(['positive_is_risk', 'diagnostic_only']));
    const effects = Object.fromEntries(RUNTIME_AGENT_HEALTH_SIGNALS.map((entry) => [
      entry.field,
      entry.currentHealthEffect,
    ]));
    expect(effects).toMatchObject({
      turnRecoveryOutstanding: 'diagnostic_only',
      turnRecoveryBlockingOutstanding: 'positive_is_risk',
      turnRecoveryRetainedTerminal: 'diagnostic_only',
      turnRecoveryCorroboratedRetained: 'diagnostic_only',
      completedDeliveryIdentityBlocking: 'positive_is_risk',
      completedDeliveryIdentityRetained: 'diagnostic_only',
      turnRecoveryExhausted: 'diagnostic_only',
      turnRecoveryOpenRecoveries: 'diagnostic_only',
    });
  });

  it('registers recovery debt attention as a non-paging fleet-owned source', () => {
    expect(registry.sourceDispositions['recovery_debt_attention']).toEqual({
      disposition: 'non_paging_operator_recovery_debt',
      owner: 'src/fleet/health-poller.ts',
      test: 'tests/fleet/health-poller.test.ts',
    });
  });

  it('registers every numeric turn-recovery health field the runtime projects', () => {
    // The bot-errors health check only labels registered fields, so a
    // projected gauge missing here is silently dropped from its evidence (#3572).
    const projected = Object.keys(getTurnRecoveryHealthDetails(null));
    const unregistered = projected.filter(
      (field) => !RUNTIME_AGENT_HEALTH_SIGNAL_FIELDS.includes(field),
    );
    expect(projected.length).toBeGreaterThan(0);
    expect(unregistered).toEqual([]);
  });

  it.each(['per_chat', 'single'] as const)(
    'registers every numeric field the %s agent health snapshot projects',
    (sessionScope) => {
      // Reads an idle runtime's real getHealthSnapshot() output, not a
      // sub-projection, so a counter spread from any source (runtime state,
      // turn queue, chronology) fails here until it is registered or explicitly
      // excluded (#3572 follow-up). Fields null while idle are not visible here.
      const projected = projectedNumericAgentHealthFields(sessionScope);
      const unregistered = projected.filter(
        (field) => !RUNTIME_AGENT_HEALTH_SIGNAL_FIELDS.includes(field)
          && !UNREGISTERED_NUMERIC_AGENT_HEALTH_FIELDS.has(field),
      );
      expect(projected.length).toBeGreaterThan(0);
      expect(unregistered).toEqual([]);
    },
  );

  it('keeps the unregistered numeric exclusions disjoint from the registry and still projected', () => {
    const overlap = RUNTIME_AGENT_HEALTH_SIGNAL_FIELDS.filter(
      (field) => UNREGISTERED_NUMERIC_AGENT_HEALTH_FIELDS.has(field),
    );
    expect(overlap).toEqual([]);
    // A stale exclusion would silently widen the allowance for a future field.
    const projected = new Set(projectedNumericAgentHealthFields('per_chat'));
    const stale = [...UNREGISTERED_NUMERIC_AGENT_HEALTH_FIELDS].filter(
      (field) => !projected.has(field),
    );
    expect(stale).toEqual([]);
  });

  it('matches every registered failure domain to its runtime owner', () => {
    expect(sorted(registry.failureDomains.agentFailureClasses.values))
      .toEqual(sorted(AGENT_FAILURE_CLASSES));
    expect(sorted(registry.failureDomains.providerFailureKinds.values))
      .toEqual(sorted(PROVIDER_FAILURE_KINDS));
    expect(sorted(registry.failureDomains.turnCapabilityErrorClasses.values))
      .toEqual(sorted(TURN_CAPABILITY_ERROR_CLASSES));
    expect(sorted(registry.failureDomains.healthTurnErrorClasses.values))
      .toEqual(sorted(HEALTH_TURN_ERROR_CLASSES));
    expect(sorted(registry.failureDomains.healthDegradationCauses.values))
      .toEqual(sorted(HEALTH_DEGRADATION_CAUSES));
    expect(sorted(registry.failureDomains.terminalAttemptFailureClasses.values))
      .toEqual(sorted(TERMINAL_ATTEMPT_FAILURE_CLASSES));
    expect(sorted(registry.failureDomains.durableInboundFailureClasses.values))
      .toEqual(sorted(INBOUND_FAILURE_CLASSES));
    expect(sorted(registry.failureDomains.admissionRejectClasses.values))
      .toEqual(sorted(ADMISSION_REJECT_CLASSES));
    expect(sorted(registry.failureDomains.memoryOperationFailureCodes.values))
      .toEqual(sorted(MEMORY_OPERATION_FAILURE_CODES));
    expect(sorted(registry.failureDomains.consolidationFailureCodes.values))
      .toEqual(sorted(CONSOLIDATION_FAILURE_CODES));
    expect(sorted(registry.failureDomains.toolCallFailureCodes.values))
      .toEqual(sorted(TOOL_FAILURE_CODES));
    expect(sorted(registry.failureDomains.outboundAuditFailureCodes.values))
      .toEqual(sorted(OUTBOUND_FAILURE_CODES));
    expect(sorted(registry.failureDomains.outboundFailureCodes.values))
      .toEqual(sorted(Object.keys(INTERNAL_OUTBOUND_FAILURE_CODE_MAP)));
    expect(sorted(registry.failureDomains.outboundFailureStages.values))
      .toEqual(sorted(OUTBOUND_FAILURE_STAGES));
    expect(sorted(registry.failureDomains.outboundMutationStates.values))
      .toEqual(sorted(OUTBOUND_MUTATION_STATES));
    expect(sorted(registry.failureDomains.outboundEvidenceCoverage.values))
      .toEqual(sorted(OUTBOUND_EVIDENCE_COVERAGE));
    expect(sorted(registry.failureDomains.outboundQuarantineDispositions.values))
      .toEqual(sorted(OUTBOUND_QUARANTINE_DISPOSITIONS));
  });

  it('registers every outbound quarantine alert source in the fault taxonomy', () => {
    const registeredSources = new Set(Object.keys(registry.sourceDispositions));
    for (const policy of Object.values(OUTBOUND_QUARANTINE_DISPOSITION_POLICIES)) {
      expect(registeredSources).toContain(policy.alertSource);
    }
  });

  it('covers and validates every terminal-attempt to inbound projection', () => {
    const projection = registry.terminalAttemptToInboundFailureClass;
    expect(sorted(Object.keys(projection))).toEqual(sorted(TERMINAL_ATTEMPT_FAILURE_CLASSES));

    for (const failureClass of TERMINAL_ATTEMPT_FAILURE_CLASSES) {
      const persistence = toTurnFinalizationPersistence(failedTerminal({
        kind: 'failed',
        class: failureClass,
      }));
      expect(persistence.inbound).toEqual({
        kind: 'failed',
        seq: 41,
        failureClass: projection[failureClass],
      });
      expect(() => normalizeFinalizeTurnTerminalParams(persistence)).not.toThrow();
    }
  });

  it('binds a closed disposition policy to every health degradation cause (#2409)', () => {
    const policy = (registry as Record<string, any>).degradationCauseDispositions;
    expect(policy).toBeDefined();
    expect(policy.unknownCauseFallback).toBe('outage_visible');
    const dispositions = policy.dispositions as Record<string, {
      family?: string;
      impactTier?: string;
      notification?: string;
      rootOwner?: string;
      clearPredicate?: string;
      requiresCorroborationBeforePaging?: boolean;
    }>;
    expect(sorted(Object.keys(dispositions))).toEqual(sorted(HEALTH_DEGRADATION_CAUSES));
    const families = new Set<string>();
    for (const [cause, entry] of Object.entries(dispositions)) {
      expect(['page', 'hold'], `${cause} impactTier`).toContain(entry.impactTier);
      expect(['critical', 'warning'], `${cause} notification`).toContain(entry.notification);
      expect(entry.impactTier === 'page' ? 'critical' : 'warning', `${cause} tier/notification coherence`)
        .toBe(entry.notification);
      expect(typeof entry.family, `${cause} family`).toBe('string');
      expect((entry.family ?? '').length, `${cause} family nonempty`).toBeGreaterThan(0);
      families.add(entry.family!);
      expect(typeof entry.rootOwner, `${cause} rootOwner`).toBe('string');
      expect((entry.rootOwner ?? '').length, `${cause} rootOwner nonempty`).toBeGreaterThan(0);
      expect(typeof entry.clearPredicate, `${cause} clearPredicate`).toBe('string');
      expect((entry.clearPredicate ?? '').length, `${cause} clearPredicate nonempty`).toBeGreaterThan(0);
      expect(typeof entry.requiresCorroborationBeforePaging, `${cause} corroboration flag`).toBe('boolean');
      if (entry.impactTier === 'page') {
        expect(entry.requiresCorroborationBeforePaging, `${cause}: a page-tier cause must already be trustworthy`)
          .toBe(false);
      }
    }
    expect(dispositions.event_loop_starved?.requiresCorroborationBeforePaging).toBe(true);
    expect(dispositions.event_loop_starved?.impactTier).toBe('hold');
    expect(dispositions.transport_disconnected?.impactTier).toBe('page');
    expect(dispositions.unclassified?.impactTier).toBe('page');
    expect(dispositions.provider_fallback_active?.impactTier).toBe('hold');
    expect(families.size).toBeGreaterThanOrEqual(10);
  });
});
