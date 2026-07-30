import { closeSync, constants, openSync, readSync } from 'node:fs';

import { isRecord } from '../src/lib/type-guards.ts';
import { isFullyConnected } from '../src/transport/runtime-connection.ts';
import { parseClosedOptions } from './lib/cli-args.ts';

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

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNullableTimestamp(value: unknown): value is number | null {
  return value === null || isFiniteTimestamp(value);
}

function hasStrictTransportReadiness(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.connection)) return false;
  return isFullyConnected({
    connected: value.connected,
    state: value.connection.state,
  });
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
  if (!hasStrictTransportReadiness(input.health.transport)) issues.push('transport_not_ready');

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
  args: readonly string[],
  readJsonFile: (path: string) => unknown | undefined = readJson,
): StartupNotificationReleaseValidationResult {
  const parsed = parseClosedOptions(args, {
    booleanOptions: [],
    valueOptions: ['--health-file', '--journal-file', '--probe-outcome'],
  });
  const healthPath = parsed.values.get('--health-file');
  const journalPath = parsed.values.get('--journal-file');
  const probeOutcome = parsed.values.get('--probe-outcome');
  if (
    parsed.error !== null
    || !healthPath
    || !journalPath
    || (probeOutcome !== 'passed' && probeOutcome !== 'failed' && probeOutcome !== 'unavailable')
  ) {
    return { exitCode: 2, outcome: 'infrastructure_error', issues: ['invalid_arguments'] };
  }
  const health = readJsonFile(healthPath);
  const journal = readJsonFile(journalPath);
  return validateStartupNotificationRelease({
    health,
    journal,
    probe: { outcome: probeOutcome },
  });
}

if (process.argv[1]?.endsWith('/validate-startup-notification-release.ts')) {
  const result = runStartupNotificationReleaseCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.exitCode;
}
