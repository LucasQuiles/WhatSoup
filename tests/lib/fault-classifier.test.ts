import { describe, it, expect } from 'vitest';
import {
  FAULT_CLASSES,
  FAULT_TAXONOMY_REGISTRY,
  classifyFault,
} from '../../src/lib/fault-classifier.ts';

describe('classifyFault', () => {
  it('classifies a level-50 provider_unknown_terminal source as auth_terminal', () => {
    expect(classifyFault({ level: 50, source: 'provider_unknown_terminal' })).toBe('auth_terminal');
  });

  it('classifies the suppressed-terminal-provider message signature as auth_terminal', () => {
    expect(
      classifyFault({
        level: 50,
        message: 'suppressed unclassified terminal provider error from result — not forwarded to user',
      }),
    ).toBe('auth_terminal');
  });

  it('does NOT classify a non-error heartbeat whose pid contains the digits 401', () => {
    // Metric-integrity: substring "401" must never trigger a classification.
    expect(
      classifyFault({ level: 30, message: 'agent runtime health stats pid=64013 bytes=401' }),
    ).toBeNull();
  });

  it('returns null for an unrelated level-50 error', () => {
    expect(classifyFault({ level: 50, message: 'stream errored out' })).toBeNull();
  });

  it('pins the fault class registry to the public FaultClass union', () => {
    expect(FAULT_CLASSES).toEqual(['auth_terminal']);
    expect(FAULT_TAXONOMY_REGISTRY.faultClasses.map((entry) => entry.id)).toEqual(FAULT_CLASSES);
  });

  it('loads auth_terminal source and message classifiers from the registry', () => {
    const auth = FAULT_TAXONOMY_REGISTRY.faultClasses.find((entry) => entry.id === 'auth_terminal');
    expect(auth?.sources).toEqual(['provider_unknown_terminal']);
    expect(auth?.messagePrefixes).toEqual([
      'suppressed unclassified terminal provider error from result',
    ]);
  });

  it('freezes registry data so classifiers cannot mutate the contract at runtime', () => {
    const auth = FAULT_TAXONOMY_REGISTRY.faultClasses[0]!;
    expect(Object.isFrozen(FAULT_TAXONOMY_REGISTRY)).toBe(true);
    expect(Object.isFrozen(FAULT_TAXONOMY_REGISTRY.faultClasses)).toBe(true);
    expect(Object.isFrozen(auth)).toBe(true);
    expect(Object.isFrozen(auth.sources)).toBe(true);
    expect(Object.isFrozen(auth.messagePrefixes)).toBe(true);
  });
});
