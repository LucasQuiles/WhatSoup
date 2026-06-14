import type { Status } from '../types';

export type StatusSeverity = 'ok' | 'warn' | 'crit';
type StatusInput = Status | string | null | undefined;

const STATUS_TEXT_CLASS: Readonly<Record<StatusSeverity, string>> = {
  ok: 'text-s-ok',
  warn: 'text-s-warn',
  crit: 'text-s-crit',
} as const;

const STATUS_COLOR_TOKEN: Readonly<Record<StatusSeverity, string>> = {
  ok: 'var(--status-ok-solid)',
  warn: 'var(--status-warn-solid)',
  crit: 'var(--status-crit-solid)',
} as const;

const STATUS_WASH_TOKEN: Readonly<Record<StatusSeverity, string>> = {
  ok: 'var(--status-ok-wash)',
  warn: 'var(--status-warn-wash)',
  crit: 'var(--status-crit-wash)',
} as const;

export function statusSeverity(status: StatusInput): StatusSeverity {
  if (status === 'online') return 'ok';
  if (status === 'degraded' || status === 'unknown') return 'warn';
  if (status === 'unreachable' || status === 'logged_out' || status === 'config_error') return 'crit';
  if (status === null || status === undefined || status === '') return 'warn';
  return 'warn';
}

export function statusNeedsAttention(status: StatusInput): boolean {
  return status !== 'online';
}

export function statusTextClassForSeverity(severity: StatusSeverity): string {
  return STATUS_TEXT_CLASS[severity];
}

export function statusColorToken(severity: StatusSeverity): string {
  return STATUS_COLOR_TOKEN[severity];
}

export function statusWashToken(severity: StatusSeverity): string {
  return STATUS_WASH_TOKEN[severity];
}

export function statusBadgeStyle(severity: StatusSeverity): { bg: string; color: string } {
  return {
    bg: statusWashToken(severity),
    color: statusColorToken(severity),
  };
}

export function statusTextClass(status: StatusInput): string {
  return statusTextClassForSeverity(statusSeverity(status));
}

export function statusWashClass(status: StatusInput): string {
  const severity = statusSeverity(status);
  if (severity === 'warn') return 'bg-[var(--s-warn-wash)]';
  if (severity === 'crit') return 'bg-[var(--s-crit-wash)]';
  return '';
}

export function statusAlertMessage(status: StatusInput, lastSessionStatus?: string | null): string {
  if (status === 'online') return 'online';
  if (status === 'unreachable') {
    return lastSessionStatus === 'auth_expired' ? 'auth expired' : 'connection lost';
  }
  if (status === 'logged_out') return 'logged out';
  if (status === 'config_error') return 'configuration error';
  if (status === 'unknown') return 'awaiting health signal';
  return 'degraded';
}
