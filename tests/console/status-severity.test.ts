import { describe, expect, it } from 'vitest';

import {
  statusAlertMessage,
  statusBadgeStyle,
  statusColorToken,
  statusNeedsAttention,
  statusSeverity,
  statusTextClass,
  statusTextClassForSeverity,
  statusWashClass,
  statusWashToken,
} from '../../console/src/lib/status-severity';

describe('status severity helpers', () => {
  it('maps known and missing statuses into the shared severity scale', () => {
    expect(statusSeverity('online')).toBe('ok');
    expect(statusSeverity('degraded')).toBe('warn');
    expect(statusSeverity('unknown')).toBe('warn');
    expect(statusSeverity('unreachable')).toBe('crit');
    expect(statusSeverity('logged_out')).toBe('crit');
    expect(statusSeverity('config_error')).toBe('crit');
    expect(statusSeverity('')).toBe('warn');
    expect(statusSeverity('new-status')).toBe('warn');
  });

  it('returns text, wash, and inline badge tokens for each severity', () => {
    expect(statusTextClassForSeverity('ok')).toBe('text-s-ok');
    expect(statusTextClass('unreachable')).toBe('text-s-crit');
    expect(statusColorToken('warn')).toBe('var(--status-warn-solid)');
    expect(statusWashToken('crit')).toBe('var(--status-crit-wash)');
    expect(statusBadgeStyle('ok')).toEqual({
      bg: 'var(--status-ok-wash)',
      color: 'var(--status-ok-solid)',
    });
  });

  it('keeps wash utility classes and attention booleans aligned with severity', () => {
    expect(statusWashClass('online')).toBe('');
    expect(statusWashClass('degraded')).toBe('bg-[var(--s-warn-wash)]');
    expect(statusWashClass('logged_out')).toBe('bg-[var(--s-crit-wash)]');
    expect(statusNeedsAttention('online')).toBe(false);
    expect(statusNeedsAttention('unknown')).toBe(true);
  });

  it('renders operator-facing alert messages for every status branch', () => {
    expect(statusAlertMessage('online')).toBe('online');
    expect(statusAlertMessage('unreachable', 'auth_expired')).toBe('auth expired');
    expect(statusAlertMessage('unreachable', 'other')).toBe('connection lost');
    expect(statusAlertMessage('logged_out')).toBe('logged out');
    expect(statusAlertMessage('config_error')).toBe('configuration error');
    expect(statusAlertMessage('unknown')).toBe('awaiting health signal');
    expect(statusAlertMessage('degraded')).toBe('degraded');
  });
});
