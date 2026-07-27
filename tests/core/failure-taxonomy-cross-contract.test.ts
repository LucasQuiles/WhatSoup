import { describe, expect, it } from 'vitest';
import registry from '../../src/lib/fault-taxonomy-registry.json' with { type: 'json' };
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
});
