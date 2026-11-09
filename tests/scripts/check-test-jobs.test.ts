import { describe, expect, it } from 'vitest';

import { checkTestJobs, type TestPlan } from '../../scripts/check-test-jobs.ts';

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
  it('requires both full matrix jobs for a full profile', () => {
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
    });

    expect(compatibility).toEqual({ ok: true, required: ['selection', 'compatibility-full'], failed: [] });
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
