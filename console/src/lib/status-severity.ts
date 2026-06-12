import type { Status } from '../types';

export type StatusSeverity = 'ok' | 'warn' | 'crit';
type StatusInput = Status | string | null | undefined;

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

export function statusTextClass(status: StatusInput): string {
  const severity = statusSeverity(status);
  if (severity === 'ok') return 'text-s-ok';
  if (severity === 'warn') return 'text-s-warn';
  return 'text-s-crit';
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
