import { describe, expect, it } from 'vitest';

import {
  validateStartupNotificationRelease,
} from '../../scripts/validate-startup-notification-release.ts';

function completeHealth(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'healthy',
    startupNotification: {
      state: 'sent',
      policy: 'generic',
      stabilitySeconds: 600,
      bootCountSinceNotification: 0,
      lastBootAt: 2_000,
      lastNotifiedAt: 3_000,
      nextEligibleAt: null,
      lastSendAt: 3_100,
      ...overrides,
    },
  };
}

function validJournal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    boots: [1_000, 2_000],
    lastNotifiedAt: 3_000,
    ...overrides,
  };
}

describe('startup notification release validator', () => {
  it('returns 0 only for a complete sent generic submission with matching v1 watermark evidence', () => {
    expect(validateStartupNotificationRelease({
      health: completeHealth(),
      journal: validJournal(),
      probe: { outcome: 'passed' },
    })).toMatchObject({ exitCode: 0, outcome: 'accepted', issues: [] });
  });

  it.each([
    ['missing startup state', completeHealth({ state: undefined }), validJournal()],
    ['unknown state', completeHealth({ state: 'delivered' }), validJournal()],
    ['unknown policy', completeHealth({ policy: 'delivery_failed' }), validJournal()],
    ['journal unreadable', completeHealth({ state: 'journal_unreadable' }), validJournal()],
    ['send failure', completeHealth({ state: 'send_failed' }), validJournal()],
    ['waiting for stability', completeHealth({ state: 'waiting_stability' }), validJournal()],
    ['bad v1 fields', completeHealth(), validJournal({ boots: ['not-a-timestamp'] })],
    ['missing boot evidence', completeHealth({ lastBootAt: null }), validJournal({ boots: [] })],
    ['watermark mismatch', completeHealth({ lastNotifiedAt: 2_999 }), validJournal()],
    ['last-send precedes watermark', completeHealth({ lastSendAt: 2_999 }), validJournal()],
    ['probe failure', completeHealth(), validJournal(), { outcome: 'failed' }],
  ] as const)('returns actionable exit 1 for %s', (_name, health, journal, probe = { outcome: 'passed' }) => {
    expect(validateStartupNotificationRelease({ health, journal, probe })).toMatchObject({
      exitCode: 1,
      outcome: 'rejected',
    });
  });

  it.each([
    ['missing health input', undefined, validJournal(), { outcome: 'passed' }],
    ['missing journal input', completeHealth(), undefined, { outcome: 'passed' }],
    ['malformed journal input', completeHealth(), '{not-json', { outcome: 'passed' }],
    ['unavailable probe', completeHealth(), validJournal(), { outcome: 'unavailable' }],
    ['unknown probe outcome', completeHealth(), validJournal(), { outcome: 'indeterminate' }],
  ] as const)('returns infrastructure exit 2 for %s', (_name, health, journal, probe) => {
    expect(validateStartupNotificationRelease({ health, journal, probe: probe as never })).toMatchObject({
      exitCode: 2,
      outcome: 'infrastructure_error',
    });
  });
});
