import { describe, expect, it, vi } from 'vitest';

import {
  runStartupNotificationReleaseCli,
  type StartupNotificationProbe,
  validateStartupNotificationRelease,
} from '../../scripts/validate-startup-notification-release.ts';

function completeHealth(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'healthy',
    transport: {
      connected: true,
      connection: { state: 'connected' },
    },
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

function healthWithoutTransport(): Record<string, unknown> {
  const health = completeHealth();
  delete health.transport;
  return health;
}

function runCli(args: readonly string[], files: Record<string, unknown> = {}) {
  return runStartupNotificationReleaseCli(args, (path) => files[path]);
}

function cliArgs(probeOutcome: string): string[] {
  return [
    '--health-file', 'health.json',
    '--journal-file', 'journal.json',
    '--probe-outcome', probeOutcome,
  ];
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
    ['missing transport', healthWithoutTransport()],
    ['disconnected transport', { ...completeHealth(), transport: { connected: false, connection: { state: 'connected' } } }],
    ['reconnecting transport', { ...completeHealth(), transport: { connected: true, connection: { state: 'reconnecting' } } }],
    ['missing connection state', { ...completeHealth(), transport: { connected: true } }],
  ])('rejects %s as fail-closed release evidence', (_name, health) => {
    expect(validateStartupNotificationRelease({
      health,
      journal: validJournal(),
      probe: { outcome: 'passed' },
    })).toMatchObject({
      exitCode: 1,
      outcome: 'rejected',
      issues: expect.arrayContaining(['transport_not_ready']),
    });
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
  ] as const)('returns actionable exit 1 for %s', (_name, health, journal, probe: StartupNotificationProbe = { outcome: 'passed' }) => {
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

  it('accepts supplied passed probe evidence through the executable-free CLI runner', () => {
    expect(runCli(cliArgs('passed'), {
      'health.json': completeHealth(),
      'journal.json': validJournal(),
    })).toMatchObject({ exitCode: 0, outcome: 'accepted', issues: [] });
  });

  it('rejects supplied failed probe evidence through the CLI runner', () => {
    expect(runCli(cliArgs('failed'), {
      'health.json': completeHealth(),
      'journal.json': validJournal(),
    })).toMatchObject({ exitCode: 1, outcome: 'rejected', issues: ['probe_failed'] });
  });

  it.each([
    ['unavailable outcome', cliArgs('unavailable')],
    ['unknown outcome', cliArgs('indeterminate')],
    ['missing arguments', []],
    ['arbitrary command option', ['--probe-command', '/usr/bin/true']],
  ] as const)('returns infrastructure exit 2 for CLI %s', (_name, args) => {
    expect(runCli(args, {
      'health.json': completeHealth(),
      'journal.json': validJournal(),
    })).toMatchObject({ exitCode: 2, outcome: 'infrastructure_error' });
  });

  it('fails closed before reading when a flag would otherwise be consumed as a file path', () => {
    const readJsonFile = vi.fn((path: string) => ({ path }));

    expect(runStartupNotificationReleaseCli([
      '--health-file',
      '--journal-file',
      'journal.json',
      '--probe-outcome',
      'passed',
    ], readJsonFile)).toEqual({
      exitCode: 2,
      outcome: 'infrastructure_error',
      issues: ['invalid_arguments'],
    });
    expect(readJsonFile).not.toHaveBeenCalled();
  });

  it.each([
    ['health file', cliArgs('passed'), { 'journal.json': validJournal() }],
    ['journal file', cliArgs('passed'), { 'health.json': completeHealth() }],
  ] as const)('returns infrastructure exit 2 for an unreadable CLI %s', (_name, args, files) => {
    expect(runCli(args, files)).toMatchObject({
      exitCode: 2,
      outcome: 'infrastructure_error',
    });
  });

  it('rejects an oversized v1 journal without throwing', () => {
    const oversizedJournal = validJournal({
      boots: Array.from({ length: 300_000 }, (_, index) => index),
    });

    expect(() => validateStartupNotificationRelease({
      health: completeHealth(),
      journal: oversizedJournal,
      probe: { outcome: 'passed' },
    })).not.toThrow();
    expect(validateStartupNotificationRelease({
      health: completeHealth(),
      journal: oversizedJournal,
      probe: { outcome: 'passed' },
    })).toMatchObject({
      exitCode: 1,
      outcome: 'rejected',
      issues: expect.arrayContaining(['journal_boot_count_exceeds_protocol_cap']),
    });
  });
});
