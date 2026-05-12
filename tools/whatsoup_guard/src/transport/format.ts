import type { Domain, Severity } from '../types.ts';

export interface FormatAlertInput {
  eventId: number;
  severity: Severity;
  scopeId: string;
  probeId: string;
  domain: Domain;
  ts: string;
  diff: {
    added: unknown;
    removed: unknown;
    changed: unknown;
  };
  actionLabel: string;
  /**
   * Copy-pasteable fix command to append to a `propose_fix` action.
   * Per spec §7.4 the action line renders as `propose_fix:<command>` when
   * a command is available; without one, the bare `propose_fix` label is
   * preserved. Ignored for any action other than `propose_fix`.
   */
  fixCommand?: string;
  fingerprint: string;
}

export function formatAlert(alert: FormatAlertInput): string {
  const severity = alert.severity.toUpperCase();
  return [
    `[whatsoup-guard] ${severity} ${alert.scopeId} - ${alert.probeId}`,
    `when:    ${alert.ts}`,
    `probe:   ${alert.probeId}`,
    `domain:  ${alert.domain}`,
    `diff:    ${JSON.stringify(alert.diff)}`,
    `action:  ${renderActionLabel(alert.actionLabel, alert.fixCommand)}`,
    `fingerprint: ${alert.fingerprint}`,
    `mute: whatsoup-guard mute --state-dir ${shellQuote('<state-dir>')} --host ${shellQuote(alert.scopeId)} --domain ${shellQuote(alert.domain)} --duration 1h --reason ${shellQuote('<why>')}`,
    `event-id: ${alert.eventId}`,
  ].join('\n');
}

function renderActionLabel(actionLabel: string, fixCommand: string | undefined): string {
  if (actionLabel === 'propose_fix' && fixCommand && fixCommand.length > 0) {
    return `propose_fix:${fixCommand}`;
  }
  return actionLabel;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
