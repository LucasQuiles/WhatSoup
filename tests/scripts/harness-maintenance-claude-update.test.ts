import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { claudeUpdatePlan, run } from '../../scripts/harness-maintenance-guard.ts';

const now = new Date('2026-09-26T08:30:00Z');
const times = {
  '2.1.280': '2026-09-10T00:00:00Z',
  '2.1.282': '2026-09-17T00:00:00Z',
  '2.1.283': '2026-09-25T20:00:00Z', // younger than the 7-day cooldown at `now`
};

describe('claudeUpdatePlan', () => {
  it('installs the newest version that has cleared the publish-age cooldown', () => {
    expect(claudeUpdatePlan({ current: '2.1.280', versionTimes: times, now, layout: 'native' }))
      .toMatchObject({ action: 'install', target: '2.1.282' });
  });

  it('never installs a release younger than the cooldown', () => {
    expect(claudeUpdatePlan({ current: '2.1.282', versionTimes: times, now, layout: 'native' }))
      .toMatchObject({ action: 'current', target: '2.1.282' });
  });

  it('does not downgrade a binary already newer than the eligible target', () => {
    expect(claudeUpdatePlan({ current: '2.1.283', versionTimes: times, now, layout: 'native' }).action)
      .toBe('current');
  });

  it('holds when no version has cleared the cooldown', () => {
    expect(claudeUpdatePlan({
      current: '2.1.279', versionTimes: { '2.1.283': '2026-09-25T20:00:00Z' }, now, layout: 'native',
    })).toMatchObject({ action: 'held', target: null });
  });

  it('refuses to install through a layout the native installer could overwrite', () => {
    for (const layout of ['wrapper', 'npm', 'other'] as const) {
      const plan = claudeUpdatePlan({ current: '2.1.280', versionTimes: times, now, layout });
      expect(plan.action, layout).toBe('unmanaged-layout');
      expect(plan.target, layout).toBe('2.1.282');
    }
  });

  it('reports a missing service binary before anything else', () => {
    expect(claudeUpdatePlan({ current: null, versionTimes: times, now, layout: 'native' }).action).toBe('missing');
  });

  it('ignores prerelease tags when choosing the target', () => {
    const plan = claudeUpdatePlan({
      current: '2.1.280', versionTimes: { ...times, '2.1.290-beta.1': '2026-09-01T00:00:00Z' }, now, layout: 'native',
    });
    expect(plan.target).toBe('2.1.282');
  });

  it('is reachable from the CLI and exits 0 with JSON', () => {
    const dir = path.join(process.cwd(), 'tests', 'fixtures');
    const timeJson = path.join(dir, 'claude-npm-time.json');
    const result = run([
      '--claude-update-plan', '--current', '2.1.280', '--time-json', timeJson,
      '--cooldown-minutes', '10080', '--layout', 'native', '--now', '2026-09-26T08:30:00Z',
    ]) as { action: string; target: string };
    expect(result).toMatchObject({ action: 'install', target: '2.1.282' });
  });
});

// The shell wiring (per-instance resolution, consumer policy, install and rollback) is exercised
// behaviourally against the real script in tests/deploy/harness-maintenance-claude-e2e.test.ts.
