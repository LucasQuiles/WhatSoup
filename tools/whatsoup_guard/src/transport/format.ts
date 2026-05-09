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
    `action:  ${alert.actionLabel}`,
    `fingerprint: ${alert.fingerprint}`,
    `mute: whatsoup-guard mute --state-dir ${shellQuote('<state-dir>')} --host ${shellQuote(alert.scopeId)} --domain ${shellQuote(alert.domain)} --duration 1h --reason ${shellQuote('<why>')}`,
    `event-id: ${alert.eventId}`,
  ].join('\n');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
