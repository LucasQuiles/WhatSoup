import { closeSync, constants, openSync, readSync } from 'node:fs';

const MAX_JOURNAL_BOOTS = 100;
const MAX_JSON_INPUT_BYTES = 64 * 1_024;

const STATES = new Set([
  'not_applicable',
  'disabled',
  'waiting_stability',
  'waiting_transport',
  'dispatching',
  'sent',
  'send_failed',
  'journal_unreadable',
]);
const POLICIES = new Set([
  'generic',
  'resume',
  'restart_loop_guard_alert',
  'expired_session_notice',
  'intentional_restart',
  'disabled',
  'none',
]);
const HEALTH_KEYS = new Set([
  'state',
  'policy',
  'stabilitySeconds',
  'bootCountSinceNotification',
  'lastBootAt',
  'lastNotifiedAt',
  'nextEligibleAt',
  'lastSendAt',
]);

export type StartupNotificationProbe =
  | { outcome: 'passed' }
  | { outcome: 'failed' }
  | { outcome: 'unavailable' };

export interface StartupNotificationReleaseValidationInput {
  health: unknown;
  journal: unknown;
  probe: StartupNotificationProbe;
}

export interface StartupNotificationReleaseValidationResult {
  exitCode: 0 | 1 | 2;
  outcome: 'accepted' | 'rejected' | 'infrastructure_error';
  issues: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNullableTimestamp(value: unknown): value is number | null {
  return value === null || isFiniteTimestamp(value);
}

function reject(issues: string[]): StartupNotificationReleaseValidationResult {
  return { exitCode: 1, outcome: 'rejected', issues };
}

/**
 * Pure, one-shot acceptance check for a supplied /health response and the
 * startup-notify v1 journal. It deliberately does not contact a service,
 * inspect bot.db, or change any local state.
 */
export function validateStartupNotificationRelease(
  input: StartupNotificationReleaseValidationInput,
): StartupNotificationReleaseValidationResult {
  const probe = input.probe as unknown;
  if (
    !isRecord(probe)
    || (probe.outcome !== 'passed' && probe.outcome !== 'failed' && probe.outcome !== 'unavailable')
  ) {
    return { exitCode: 2, outcome: 'infrastructure_error', issues: ['probe_invalid'] };
  }
  if (probe.outcome === 'unavailable') {
    return { exitCode: 2, outcome: 'infrastructure_error', issues: ['probe_unavailable'] };
  }
  if (!isRecord(input.health)) {
    return { exitCode: 2, outcome: 'infrastructure_error', issues: ['health_unreadable'] };
  }
  if (!isRecord(input.journal)) {
    return { exitCode: 2, outcome: 'infrastructure_error', issues: ['journal_unreadable'] };
  }

  const issues: string[] = [];
  if (probe.outcome === 'failed') issues.push('probe_failed');
  if (input.health.status !== 'healthy') issues.push('service_not_healthy');

  const startupNotification = input.health.startupNotification;
  if (!isRecord(startupNotification)) return reject([...issues, 'startup_notification_missing']);
  if (
    Object.keys(startupNotification).length !== HEALTH_KEYS.size
    || Object.keys(startupNotification).some((key) => !HEALTH_KEYS.has(key))
  ) {
    issues.push('startup_notification_shape_invalid');
  }

  const state = startupNotification.state;
  const policy = startupNotification.policy;
  if (typeof state !== 'string' || !STATES.has(state)) issues.push('startup_notification_state_invalid');
  if (typeof policy !== 'string' || !POLICIES.has(policy)) issues.push('startup_notification_policy_invalid');
  if (state === 'journal_unreadable') issues.push('startup_notification_journal_unreadable');
  if (state === 'send_failed') issues.push('startup_notification_send_failed');
  if (state !== 'sent') issues.push('startup_notification_not_sent');
  if (policy !== 'generic') issues.push('startup_notification_policy_not_generic');

  if (
    (startupNotification.stabilitySeconds !== null
      && (!isFiniteTimestamp(startupNotification.stabilitySeconds)))
    || (startupNotification.bootCountSinceNotification !== null
      && (!Number.isSafeInteger(startupNotification.bootCountSinceNotification)
        || (startupNotification.bootCountSinceNotification as number) < 0))
    || !isNullableTimestamp(startupNotification.lastBootAt)
    || !isNullableTimestamp(startupNotification.lastNotifiedAt)
    || !isNullableTimestamp(startupNotification.nextEligibleAt)
    || !isNullableTimestamp(startupNotification.lastSendAt)
  ) {
    issues.push('startup_notification_fields_invalid');
  }
  if (startupNotification.nextEligibleAt !== null) issues.push('startup_notification_still_waiting');

  if (input.journal.v !== 1 || !Array.isArray(input.journal.boots)) {
    return reject([...issues, 'journal_v1_invalid']);
  }
  const boots = input.journal.boots;
  if (boots.length > MAX_JOURNAL_BOOTS) {
    return reject([...issues, 'journal_boot_count_exceeds_protocol_cap']);
  }
  const journalLastNotifiedAt = input.journal.lastNotifiedAt;
  if (!boots.every(isFiniteTimestamp) || !isNullableTimestamp(journalLastNotifiedAt)) {
    return reject([...issues, 'journal_v1_invalid']);
  }
  if (boots.length === 0) issues.push('journal_boot_evidence_missing');

  if (journalLastNotifiedAt === null) {
    issues.push('journal_watermark_missing');
  } else {
    let lastBootAt: number | null = null;
    let unnotifiedBoots = 0;
    for (const boot of boots) {
      if (lastBootAt === null || boot > lastBootAt) lastBootAt = boot;
      if (boot > journalLastNotifiedAt) unnotifiedBoots += 1;
    }
    if (lastBootAt !== null && journalLastNotifiedAt < lastBootAt) {
      issues.push('journal_watermark_precedes_boot');
    }
    if (startupNotification.lastBootAt !== lastBootAt) {
      issues.push('health_last_boot_mismatch');
    }
    if (startupNotification.bootCountSinceNotification !== unnotifiedBoots) {
      issues.push('health_boot_count_mismatch');
    }
    if (startupNotification.lastNotifiedAt !== journalLastNotifiedAt) {
      issues.push('health_watermark_mismatch');
    }
    if (
      !isFiniteTimestamp(startupNotification.lastSendAt)
      || startupNotification.lastSendAt < journalLastNotifiedAt
    ) {
      issues.push('health_last_send_invalid');
    }
  }

  return issues.length === 0
    ? { exitCode: 0, outcome: 'accepted', issues: [] }
    : reject(issues);
}

type CliOptions = {
  healthPath: string | null;
  journalPath: string | null;
  probeOutcome: StartupNotificationProbe['outcome'] | null;
};

type ParsedCliOptions = {
  healthPath: string;
  journalPath: string;
  probeOutcome: StartupNotificationProbe['outcome'];
};

function parseArgs(args: string[]): ParsedCliOptions | null {
  const options: CliOptions = { healthPath: null, journalPath: null, probeOutcome: null };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if ((arg === '--health-file' || arg === '--journal-file' || arg === '--probe-outcome') && !value) return null;
    if (arg === '--health-file') {
      if (options.healthPath !== null) return null;
      options.healthPath = value;
      index += 1;
    } else if (arg === '--journal-file') {
      if (options.journalPath !== null) return null;
      options.journalPath = value;
      index += 1;
    } else if (arg === '--probe-outcome') {
      if (
        options.probeOutcome !== null
        || (value !== 'passed' && value !== 'failed' && value !== 'unavailable')
      ) return null;
      options.probeOutcome = value;
      index += 1;
    } else {
      return null;
    }
  }
  if (!options.healthPath || !options.journalPath || options.probeOutcome === null) return null;
  return {
    healthPath: options.healthPath,
    journalPath: options.journalPath,
    probeOutcome: options.probeOutcome,
  };
}

function readJson(path: string): unknown | undefined {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const contents = Buffer.alloc(MAX_JSON_INPUT_BYTES + 1);
    const bytesRead = readSync(descriptor, contents, 0, contents.length, 0);
    if (bytesRead > MAX_JSON_INPUT_BYTES) return undefined;
    return JSON.parse(contents.toString('utf8', 0, bytesRead)) as unknown;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

export function runStartupNotificationReleaseCli(
  args: string[],
  readJsonFile: (path: string) => unknown | undefined = readJson,
): StartupNotificationReleaseValidationResult {
  const options = parseArgs(args);
  if (options === null) {
    return { exitCode: 2, outcome: 'infrastructure_error', issues: ['invalid_arguments'] };
  }
  const health = readJsonFile(options.healthPath);
  const journal = readJsonFile(options.journalPath);
  return validateStartupNotificationRelease({
    health,
    journal,
    probe: { outcome: options.probeOutcome },
  });
}

if (process.argv[1]?.endsWith('/validate-startup-notification-release.ts')) {
  const result = runStartupNotificationReleaseCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.exitCode;
}
