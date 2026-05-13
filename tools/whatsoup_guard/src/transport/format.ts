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
   * Copy-pasteable shell command to emit alongside a `propose_fix` action,
   * per spec §6.5 / §7.4 (docs/specs/2026-05-08-whatsoup-protection-layer-design.md).
   *
   * When the `actionLabel` is `propose_fix` and `fixCommand` is non-empty,
   * the formatter renders an additional `propose_fix: <command>` line.
   * Ignored for any action other than `propose_fix`.
   *
   * Templates that produce this string MUST resolve to real Unix commands,
   * real npm scripts, or one of the six whatsoup-guard subcommands
   * (`ping|cycle|mute|status|simulate|watchdog`). No fabricated subcommands.
   */
  fixCommand?: string;
  /**
   * Free-text follow-up for `propose_fix` rules that have no single
   * deterministic shell fix (token rotation, accepting a new baseline,
   * adding a route guard). Rendered as a `remediation_hint: <text>` line
   * when `actionLabel` is `propose_fix` and `fixCommand` is absent.
   */
  remediationHint?: string;
  fingerprint: string;
}

export function formatAlert(alert: FormatAlertInput): string {
  const severity = alert.severity.toUpperCase();
  const lines = [
    `[whatsoup-guard] ${severity} ${alert.scopeId} - ${alert.probeId}`,
    `when:    ${alert.ts}`,
    `probe:   ${alert.probeId}`,
    `domain:  ${alert.domain}`,
    `diff:    ${JSON.stringify(alert.diff)}`,
    `action:  ${alert.actionLabel}`,
  ];
  const follow = proposeFixFollowUp(alert);
  if (follow !== undefined) {
    lines.push(follow);
  }
  lines.push(
    `fingerprint: ${alert.fingerprint}`,
    `mute: whatsoup-guard mute --state-dir ${shellQuote('<state-dir>')} --host ${shellQuote(alert.scopeId)} --domain ${shellQuote(alert.domain)} --duration 1h --reason ${shellQuote('<why>')}`,
    `event-id: ${alert.eventId}`,
  );
  return lines.join('\n');
}

function proposeFixFollowUp(alert: FormatAlertInput): string | undefined {
  if (alert.actionLabel !== 'propose_fix') return undefined;
  const fix = alert.fixCommand?.trim();
  if (fix !== undefined && fix.length > 0) {
    return `propose_fix: ${fix}`;
  }
  const hint = alert.remediationHint?.trim();
  if (hint !== undefined && hint.length > 0) {
    return `remediation_hint: ${hint}`;
  }
  return undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
