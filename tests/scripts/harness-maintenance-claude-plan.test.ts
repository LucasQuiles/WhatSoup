import { describe, expect, it } from 'vitest';

import {
  PUBLISH_TIME_SKEW_MINUTES,
  claudeUpdatePlan,
  compareSemver,
  parseSemver,
} from '../../scripts/harness-maintenance-guard.ts';

// Planner semantics for the agent CLI update (task d01). Decision order under test:
// missing -> unknown -> held -> unmanaged-layout -> current -> install.
const now = new Date('2026-09-26T08:30:00Z');
const times = {
  created: '2025-02-24T00:00:00.000Z',
  modified: '2026-09-25T20:00:00.000Z',
  '2.1.280': '2026-09-10T00:00:00Z',
  '2.1.282': '2026-09-17T00:00:00Z',
  '2.1.283': '2026-09-25T20:00:00Z', // younger than the 7-day cooldown at `now`
};
const minutesFromNow = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();

describe('parseSemver / compareSemver', () => {
  it('accepts strict semver and rejects loose version text', () => {
    expect(parseSemver('2.1.282')).not.toBeNull();
    expect(parseSemver('2.1.300-beta.1')).not.toBeNull();
    for (const bad of ['', 'v2.1.282', '2.1', '2.1.282.1', '02.1.0', '2.1.x', ' 2.1.282', 'unknown']) {
      expect(parseSemver(bad), bad).toBeNull();
    }
  });

  it('orders releases above their prereleases and by numeric identifiers', () => {
    expect(compareSemver('2.1.300-beta.1', '2.1.282')).toBe(1);
    expect(compareSemver('2.1.282-beta.1', '2.1.282')).toBe(-1);
    expect(compareSemver('2.1.282-beta.2', '2.1.282-beta.10')).toBe(-1);
    expect(compareSemver('2.10.0', '2.9.9')).toBe(1);
    expect(compareSemver('2.1.282+build.5', '2.1.282')).toBe(0);
  });
});

describe('claudeUpdatePlan decision order', () => {
  it('treats an empty current version as missing', () => {
    expect(claudeUpdatePlan({ current: '', versionTimes: times, now, layout: 'native' }).action).toBe('missing');
  });

  it('never installs over a current version it cannot parse', () => {
    for (const current of ['garbage', 'v2.1.280', '2.1', '2.1.280.1']) {
      const plan = claudeUpdatePlan({ current, versionTimes: times, now, layout: 'native' });
      expect(plan.action, current).toBe('unknown');
      expect(plan.target, current).toBeNull();
    }
  });

  it('does not downgrade a prerelease newer than the eligible target', () => {
    expect(claudeUpdatePlan({ current: '2.1.300-beta.1', versionTimes: times, now, layout: 'native' }))
      .toMatchObject({ action: 'current', target: '2.1.282' });
  });

  it('upgrades a prerelease to its own eligible release', () => {
    expect(claudeUpdatePlan({ current: '2.1.282-beta.1', versionTimes: times, now, layout: 'native' }))
      .toMatchObject({ action: 'install', target: '2.1.282' });
  });

  it('reports an up-to-date binary on a non-native layout as unmanaged-layout, not current', () => {
    for (const layout of ['wrapper', 'npm', 'other'] as const) {
      expect(claudeUpdatePlan({ current: '2.1.282', versionTimes: times, now, layout }).action, layout)
        .toBe('unmanaged-layout');
    }
  });

  it('prefers missing over malformed metadata', () => {
    expect(claudeUpdatePlan({ current: '', versionTimes: 'not-an-object', now, layout: 'native' }).action)
      .toBe('missing');
  });

  it('prefers unknown over a non-native layout', () => {
    expect(claudeUpdatePlan({ current: 'garbage', versionTimes: times, now, layout: 'wrapper' }).action)
      .toBe('unknown');
  });

  it('prefers held over a non-native layout when metadata is anomalous', () => {
    expect(claudeUpdatePlan({
      current: '2.1.280', versionTimes: { ...times, '2.1.284': 'not-a-date' }, now, layout: 'wrapper',
    }).action).toBe('held');
  });
});

describe('claudeUpdatePlan metadata anomalies', () => {
  it('holds instead of throwing when a newer release has an invalid publish time', () => {
    let plan: ReturnType<typeof claudeUpdatePlan> | undefined;
    expect(() => {
      plan = claudeUpdatePlan({
        current: '2.1.280', versionTimes: { ...times, '2.1.284': 'not-a-date' }, now, layout: 'native',
      });
    }).not.toThrow();
    expect(plan).toMatchObject({ action: 'held', target: null });
    expect(plan?.anomalies?.join(' ')).toContain('2.1.284');
  });

  it('still plans when only an older release has an invalid publish time', () => {
    expect(claudeUpdatePlan({
      current: '2.1.280', versionTimes: { ...times, '2.1.100': 'not-a-date' }, now, layout: 'native',
    })).toMatchObject({ action: 'install', target: '2.1.282' });
  });

  it('holds when a newer release carries a non-string publish time', () => {
    expect(claudeUpdatePlan({
      current: '2.1.280', versionTimes: { ...times, '2.1.284': 12345 }, now, layout: 'native',
    }).action).toBe('held');
  });

  it('holds on a publish time in the future beyond the allowed skew, and not within it', () => {
    const outside = claudeUpdatePlan({
      current: '2.1.280',
      versionTimes: { ...times, '2.1.290': minutesFromNow(PUBLISH_TIME_SKEW_MINUTES + 1) },
      now,
      layout: 'native',
    });
    expect(outside.action).toBe('held');
    const inside = claudeUpdatePlan({
      current: '2.1.280',
      versionTimes: { ...times, '2.1.290': minutesFromNow(PUBLISH_TIME_SKEW_MINUTES - 1) },
      now,
      layout: 'native',
    });
    expect(inside).toMatchObject({ action: 'install', target: '2.1.282' });
  });

  it('holds on metadata that is not a JSON object', () => {
    for (const versionTimes of [null, [], 'x', 42]) {
      expect(claudeUpdatePlan({ current: '2.1.280', versionTimes, now, layout: 'native' }).action, String(versionTimes))
        .toBe('held');
    }
  });

  it('never targets a prerelease even when it is the newest eligible entry', () => {
    const plan = claudeUpdatePlan({
      current: '2.1.280', versionTimes: { ...times, '2.1.299-rc.1': '2026-09-01T00:00:00Z' }, now, layout: 'native',
    });
    expect(plan.target).toBe('2.1.282');
  });
});

describe('claudeUpdatePlan input validation', () => {
  it('rejects a negative or non-finite cooldown', () => {
    for (const cooldownMinutes of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        () => claudeUpdatePlan({ current: '2.1.280', versionTimes: times, now, cooldownMinutes, layout: 'native' }),
        String(cooldownMinutes),
      ).toThrow(/cooldown/);
    }
  });

  it('rejects an invalid clock', () => {
    expect(() => claudeUpdatePlan({ current: '2.1.280', versionTimes: times, now: new Date('nope'), layout: 'native' }))
      .toThrow(/now/);
  });
});
