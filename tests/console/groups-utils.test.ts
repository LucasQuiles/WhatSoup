import { describe, expect, it } from 'vitest';
import {
  EPHEMERAL_OPTIONS,
  avatarColor,
  ephemeralLabel,
  roleBadgeStyle,
  roleLabel,
  settingLabel,
} from '../../console/src/components/line-detail/groups-utils';

describe('roleLabel', () => {
  it('maps each role to its human label', () => {
    expect(roleLabel('superadmin')).toBe('Owner');
    expect(roleLabel('admin')).toBe('Admin');
    expect(roleLabel(undefined)).toBe('Member');
  });
});

describe('roleBadgeStyle', () => {
  it('returns warn tokens for superadmin and ok tokens for admin', () => {
    expect(roleBadgeStyle('superadmin')).toEqual({
      bg: 'var(--status-warn-wash)',
      color: 'var(--status-warn-solid)',
    });
    expect(roleBadgeStyle('admin')).toEqual({
      bg: 'var(--status-ok-wash)',
      color: 'var(--status-ok-solid)',
    });
  });

  it('returns null for plain members', () => {
    expect(roleBadgeStyle(undefined)).toBeNull();
  });
});

describe('EPHEMERAL_OPTIONS', () => {
  it('exposes the canonical ephemeral durations in order', () => {
    expect(EPHEMERAL_OPTIONS).toEqual([
      { label: 'Off', seconds: 0 },
      { label: '24 hours', seconds: 86400 },
      { label: '7 days', seconds: 604800 },
      { label: '90 days', seconds: 7776000 },
    ]);
    expect(EPHEMERAL_OPTIONS).toHaveLength(4);
  });
});

describe('ephemeralLabel', () => {
  it('returns the known option label for each canonical duration', () => {
    expect(ephemeralLabel(0)).toBe('Off');
    expect(ephemeralLabel(86400)).toBe('24 hours');
    expect(ephemeralLabel(604800)).toBe('7 days');
    expect(ephemeralLabel(7776000)).toBe('90 days');
  });

  it('treats missing or zero seconds as Off', () => {
    expect(ephemeralLabel()).toBe('Off');
    expect(ephemeralLabel(undefined)).toBe('Off');
    expect(ephemeralLabel(0)).toBe('Off');
  });

  it('falls back to a raw seconds label for unknown positive values', () => {
    expect(ephemeralLabel(1)).toBe('1s');
    expect(ephemeralLabel(60)).toBe('60s');
    expect(ephemeralLabel(123456)).toBe('123456s');
  });
});

describe('settingLabel', () => {
  it('maps each known group setting to its label', () => {
    expect(settingLabel('announcement')).toBe('Only admins can send');
    expect(settingLabel('not_announcement')).toBe('All participants can send');
    expect(settingLabel('locked')).toBe('Only admins can edit info');
    expect(settingLabel('unlocked')).toBe('All participants can edit info');
  });

  it('echoes the raw key for unknown settings', () => {
    expect(settingLabel('mystery')).toBe('mystery');
    expect(settingLabel('')).toBe('');
  });
});

describe('avatarColor', () => {
  it('returns a CSS variable in the 0..7 hue bucket range', () => {
    for (const jid of ['1@s.whatsapp.net', 'abc', 'zzz@lid', '']) {
      const value = avatarColor(jid);
      expect(value).toMatch(/^var\(--avatar-hue-[0-7]\)$/);
    }
  });

  it('is deterministic for the same input', () => {
    expect(avatarColor('alice@s.whatsapp.net')).toBe(avatarColor('alice@s.whatsapp.net'));
    expect(avatarColor('')).toBe(avatarColor(''));
  });

  it('spreads varied inputs across more than one bucket', () => {
    const samples = [
      'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h',
      '1@s.whatsapp.net', '2@s.whatsapp.net', '3@s.whatsapp.net', '4@s.whatsapp.net',
      'group-1@g.us', 'group-2@g.us', 'lid-1@lid', 'lid-2@lid',
    ];
    const buckets = new Set(samples.map(avatarColor));
    expect(buckets.size).toBeGreaterThan(1);
    for (const value of buckets) {
      expect(value).toMatch(/^var\(--avatar-hue-[0-7]\)$/);
    }
  });
});
