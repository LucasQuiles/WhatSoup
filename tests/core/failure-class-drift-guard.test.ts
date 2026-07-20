import { describe, it, expect } from 'vitest';
import { PROVIDER_FAILURE_KINDS } from '../../src/runtimes/agent/failure-taxonomy.ts';
import { TURN_CAPABILITY_ERROR_CLASSES } from '../../src/runtimes/agent/turn-capability-tracker.ts';
import { HEALTH_TURN_ERROR_CLASSES } from '../../src/core/health.ts';
import { TERMINAL_PROVIDER_FAILURE_CLASSES } from '../../src/core/turn-finalization-contract.ts';

const sorted = (s: Iterable<string>) => [...s].sort();

describe('failure-class taxonomy drift guard (W1-T6)', () => {
  it('TERMINAL_PROVIDER_FAILURE_CLASSES mirrors ProviderFailureKind exactly', () => {
    expect(sorted(TERMINAL_PROVIDER_FAILURE_CLASSES)).toEqual(sorted(PROVIDER_FAILURE_KINDS));
  });
  it('HEALTH_TURN_ERROR_CLASSES mirrors TurnCapabilityErrorClass exactly', () => {
    // RED today: HEALTH is missing 'server-error' + 'transient-network'.
    expect(sorted(HEALTH_TURN_ERROR_CLASSES)).toEqual(sorted(TURN_CAPABILITY_ERROR_CLASSES));
  });
});
