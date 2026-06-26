import { statusBadgeStyle } from '../../lib/status-severity.js';
import { avatarHueIndex } from '../../lib/text-utils.js';

export function roleLabel(admin?: 'admin' | 'superadmin'): string {
  if (admin === 'superadmin') return 'Owner';
  if (admin === 'admin') return 'Admin';
  return 'Member';
}

export function roleBadgeStyle(admin?: 'admin' | 'superadmin'): { bg: string; color: string } | null {
  if (admin === 'superadmin') return statusBadgeStyle('warn');
  if (admin === 'admin') return statusBadgeStyle('ok');
  return null;
}

export const EPHEMERAL_OPTIONS = [
  { label: 'Off', seconds: 0 },
  { label: '24 hours', seconds: 86400 },
  { label: '7 days', seconds: 604800 },
  { label: '90 days', seconds: 7776000 },
] as const;

export function ephemeralLabel(seconds?: number): string {
  if (!seconds) return 'Off';
  const opt = EPHEMERAL_OPTIONS.find(o => o.seconds === seconds);
  return opt?.label ?? `${seconds}s`;
}

export function settingLabel(key: string): string {
  switch (key) {
    case 'announcement': return 'Only admins can send';
    case 'not_announcement': return 'All participants can send';
    case 'locked': return 'Only admins can edit info';
    case 'unlocked': return 'All participants can edit info';
    default: return key;
  }
}

/** Generate a deterministic color from JID */
export function avatarColor(jid: string): string {
  return `var(--avatar-hue-${avatarHueIndex(jid)})`
}
