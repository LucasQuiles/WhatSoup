import { describe, expect, it } from 'vitest';

import { checkTestJobs, type TestPlan } from '../../scripts/check-test-jobs.ts';
import { classifyTestChanges } from '../../scripts/lib/test-selection-policy.ts';

const fullPlan: TestPlan = {
  profile: 'full',
  lanes: {
    root: true,
    console: true,
    browser: true,
    python: true,
    guard: true,
    docker: true,
    compatibility: true,
  },
};

const affectedRootPlan: TestPlan = {
  profile: 'affected',
  lanes: {
    root: true,
    console: false,
    browser: false,
    python: false,
    guard: false,
    docker: false,
    compatibility: true,
  },
};

const docsPlan: TestPlan = {
  profile: 'docs',
  lanes: {
    root: false,
    console: false,
    browser: false,
    python: false,
    guard: false,
    docker: false,
    compatibility: false,
  },
};

describe('checkTestJobs', () => {
  it('requires all selected validation jobs for a full profile', () => {
    const result = checkTestJobs('node24', fullPlan, {
      selection: 'success',
      full: 'success',
      'bot-errors-health-macos': 'success',
      'compatibility-full': 'success',
    });

    expect(result).toEqual({ ok: true, required: ['selection', 'full', 'bot-errors-health-macos'], failed: [] });

    const compatibility = checkTestJobs('node25', fullPlan, {
      selection: 'success',
      full: 'success',
      'compatibility-full': 'success',
      'guard-compatibility': 'success',
    });

    expect(compatibility).toEqual({ ok: true, required: ['selection', 'compatibility-full', 'guard-compatibility'], failed: [] });
  });

  it.each(['failure', 'cancelled', 'skipped', 'missing'] as const)(
    'rejects %s Node 25 guard validation for a real guard-only change',
    (result) => {
      const plan = classifyTestChanges(['tools/whatsoup_guard/src/index.ts']);
      expect(plan).toMatchObject({ profile: 'affected', lanes: { guard: true, compatibility: false } });
      const checked = checkTestJobs('node25', plan, {
        selection: 'success',
        ...(result === 'missing' ? {} : { 'guard-compatibility': result }),
      });
      expect(checked.ok).toBe(false);
      expect(checked.failed).toEqual([{ job: 'guard-compatibility', result }]);
    },
  );

  it('accepts a guard-only change after Node 25 guard validation succeeds', () => {
    const plan = classifyTestChanges(['tools/whatsoup_guard/src/index.ts']);
    expect(checkTestJobs('node25', plan, {
      selection: 'success', 'guard-compatibility': 'success', 'compatibility-affected': 'skipped',
    })).toEqual({ ok: true, required: ['selection', 'guard-compatibility'], failed: [] });
  });

  it.each(['full', 'affected'] as const)('requires guard validation alongside root compatibility for %s work', (profile) => {
    const plan = profile === 'full' ? fullPlan : {
      ...affectedRootPlan, lanes: { ...affectedRootPlan.lanes, guard: true },
    };
    const rootJob = profile === 'full' ? 'compatibility-full' : 'compatibility-affected';
    expect(checkTestJobs('node25', plan, { selection: 'success', [rootJob]: 'success' }).failed)
      .toEqual([{ job: 'guard-compatibility', result: 'missing' }]);
    expect(checkTestJobs('node25', plan, { selection: 'success', 'guard-compatibility': 'success' }).failed)
      .toEqual([{ job: rootJob, result: 'missing' }]);
  });

  it('allows intentionally skipped Node 25 guard validation for documentation changes', () => {
    const plan = classifyTestChanges(['README.md']);
    expect(checkTestJobs('node25', plan, {
      selection: 'success', docs: 'success', 'guard-compatibility': 'skipped',
    })).toEqual({ ok: true, required: ['selection', 'docs'], failed: [] });
  });

  it('accepts root-only compatibility without requiring an unselected guard job', () => {
    expect(checkTestJobs('node25', affectedRootPlan, {
      selection: 'success', 'compatibility-affected': 'success', 'guard-compatibility': 'skipped',
    })).toEqual({ ok: true, required: ['selection', 'compatibility-affected'], failed: [] });
  });

  it('requires the compatibility affected job only when its lane is selected', () => {
    const node24 = checkTestJobs('node24', affectedRootPlan, {
      selection: 'success',
      affected: 'success',
      'compatibility-affected': 'skipped',
    });
    expect(node24).toEqual({ ok: true, required: ['selection', 'affected'], failed: [] });

    const node25 = checkTestJobs('node25', affectedRootPlan, {
      selection: 'success',
      affected: 'success',
      'compatibility-affected': 'skipped',
    });
    expect(node25.ok).toBe(false);
    expect(node25.failed).toEqual([{ job: 'compatibility-affected', result: 'skipped' }]);
  });

  it('requires the docs validation job but no application or Docker job for docs', () => {
    const result = checkTestJobs('node24', docsPlan, {
      selection: 'success',
      docs: 'success',
      full: 'skipped',
      affected: 'skipped',
    });

    expect(result).toEqual({ ok: true, required: ['selection', 'docs'], failed: [] });
  });

  it.each(['failure', 'cancelled', 'skipped', 'missing'] as const)(
    'fails closed when a selected job is %s',
    (result) => {
      const checked = checkTestJobs('node24', affectedRootPlan, {
        selection: 'success',
        affected: result,
      });

      expect(checked.ok).toBe(false);
      expect(checked.failed).toEqual([{ job: 'affected', result }]);
    },
  );

  it('rejects invalid profile and lane shapes instead of treating them as docs', () => {
    const result = checkTestJobs('node24', {
      profile: 'docs',
      lanes: { ...docsPlan.lanes, root: true },
    }, { selection: 'success', docs: 'success' });

    expect(result.ok).toBe(false);
    expect(result.failed).toEqual([{ job: 'selection', result: 'invalid-plan' }]);
  });
});
