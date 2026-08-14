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

const RECOVERY_DEBT_REASON_ORDER = [
  'continuity_gap_unreadable',
  'continuity_gap_open',
  'recovery_evidence_unreadable',
  'delivery_evidence_unreadable',
  'turn_finalization_active',
  'turn_recovery_actionable',
  'turn_recovery_integrity',
  'turn_recovery_unclassified',
  'completed_delivery_identity_unclassified',
  'uncorroborated_delivery_ambiguity',
  'turn_recovery_terminal',
  'turn_recovery_quarantined',
  'historical_turn_catchup',
  'corroborated_delivery_retained',
  'completed_delivery_identity_fresh_inbound',
  'completed_delivery_identity_operator',
] as const;
const RECOVERY_DEBT_REASON_INDEX = new Map<string, number>(
  RECOVERY_DEBT_REASON_ORDER.map((reason, index) => [reason, index]),
);
const RECOVERY_DEBT_BLOCKING_REASONS = new Set([
  'continuity_gap_unreadable',
  'recovery_evidence_unreadable',
  'delivery_evidence_unreadable',
  'turn_finalization_active',
  'turn_recovery_actionable',
  'turn_recovery_integrity',
  'turn_recovery_unclassified',
  'completed_delivery_identity_unclassified',
]);

function recoveryCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

export function recoveryDebtIssue(health: Record<string, unknown>): string | null {
  if (!Object.hasOwn(health, 'recovery_debt')) return null;
  const debt = health.recovery_debt;
  if (!isRecord(debt)) return 'recovery_debt_invalid';
  const open = debt.open;
  const serviceBlocking = debt.service_blocking;
  const attention = debt.attention;
  if (
    typeof open !== 'boolean'
    || typeof serviceBlocking !== 'boolean'
    || (attention !== 'none' && attention !== 'routine' && attention !== 'urgent')
  ) return 'recovery_debt_invalid';
  const reasons = debt.reasons;
  if (
    !Array.isArray(reasons)
    || reasons.length > 32
    || reasons.some((reason) => typeof reason !== 'string' || !RECOVERY_DEBT_REASON_INDEX.has(reason))
    || new Set(reasons).size !== reasons.length
    || reasons.some((reason, index) => (
      index > 0
      && RECOVERY_DEBT_REASON_INDEX.get(reason as string)! <= RECOVERY_DEBT_REASON_INDEX.get(reasons[index - 1] as string)!
    ))
  ) return 'recovery_debt_invalid';
  const continuity = debt.continuity;
  const turnRecovery = debt.turn_recovery;
  const identity = debt.completed_delivery_identity;
  const delivery = debt.delivery;
  if (![continuity, turnRecovery, identity, delivery].every(isRecord)) {
    return 'recovery_debt_invalid';
  }
  const sections = [continuity, turnRecovery, identity, delivery] as Record<string, unknown>[];
  if (sections.some((section) => typeof section.readable !== 'boolean')) {
    return 'recovery_debt_invalid';
  }
  const countFields: Array<readonly [Record<string, unknown>, string]> = [
    [continuity as Record<string, unknown>, 'open'],
    [continuity as Record<string, unknown>, 'unresolved'],
    [continuity as Record<string, unknown>, 'ambiguous'],
    [turnRecovery as Record<string, unknown>, 'blocking_outstanding'],
    [turnRecovery as Record<string, unknown>, 'retained_terminal'],
    [turnRecovery as Record<string, unknown>, 'open_catchups'],
    [turnRecovery as Record<string, unknown>, 'corroborated_retained'],
    [identity as Record<string, unknown>, 'blocking'],
    [identity as Record<string, unknown>, 'retained'],
    [delivery as Record<string, unknown>, 'blocking_ambiguous'],
    [delivery as Record<string, unknown>, 'uncorroborated_ambiguous'],
    [delivery as Record<string, unknown>, 'corroborated_retained'],
  ];
  const counts = countFields.map(([section, field]) => recoveryCount(section[field]));
  if (counts.some((value) => value === null)) return 'recovery_debt_invalid';
  const numericCounts = counts as number[];
  const nextAction = (identity as Record<string, unknown>).next_action;
  if (nextAction !== null && nextAction !== 'fresh_inbound' && nextAction !== 'operator') {
    return 'recovery_debt_invalid';
  }
  const oldest = (delivery as Record<string, unknown>).oldest_uncorroborated_at;
  const oldestValid = typeof oldest === 'string' && Number.isFinite(Date.parse(
    oldest.includes('T') ? oldest : `${oldest.replace(' ', 'T')}Z`,
  ));
  if (
    (numericCounts[10]! > 0 && !oldestValid)
    || (numericCounts[10] === 0 && oldest !== null)
    || numericCounts[9]! > numericCounts[10]!
  ) return 'recovery_debt_invalid';
  const expectedReason = (continuity as Record<string, unknown>).readable !== true
    ? 'continuity_gap_unreadable'
    : numericCounts[0]! > 0
      ? 'continuity_gap_open'
      : null;
  if (debt.reason !== expectedReason) return 'recovery_debt_invalid';
  const blockingEvidence = sections.some((section) => section.readable !== true)
    || numericCounts[3]! > 0
    || numericCounts[7]! > 0
    || numericCounts[9]! > 0
    || (reasons as string[]).some((reason) => RECOVERY_DEBT_BLOCKING_REASONS.has(reason));
  const gaugeTotal = numericCounts.reduce((sum, value, index) => index === 9 ? sum : sum + value, 0);
  const expectedOpen = gaugeTotal > 0 || reasons.length > 0 || serviceBlocking;
  const expectedAttention = serviceBlocking ? 'urgent' : open ? 'routine' : 'none';
  if (attention !== expectedAttention || open !== expectedOpen || serviceBlocking !== blockingEvidence) {
    return 'recovery_debt_invalid';
  }
  if (health.status === 'healthy' && serviceBlocking) {
    return 'recovery_debt_status_contradiction';
  }
  return null;
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
  const debtIssue = recoveryDebtIssue(input.health);
  if (debtIssue) issues.push(debtIssue);
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
