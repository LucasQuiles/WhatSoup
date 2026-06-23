import { describe, it, expect } from 'vitest';
import { classifyFault } from '../../src/lib/fault-classifier.ts';

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
});
