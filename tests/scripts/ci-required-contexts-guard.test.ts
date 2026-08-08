/**
 * #2980: required-CI-context guard tests.
 *
 * A1: DISCRIMINATING missing-context head → non-zero + ABSENT message naming
 *     the context (fails if guard removed — the pure function would return
 *     present for everything).
 * A2: all-registered head → exit 0.
 * A3: DISCRIMINATING check-runs-reporting context covered (fails if only
 *     actions/runs queried — a check-runs context present only in checkRuns
 *     would go ABSENT without the check-runs query).
 * A4: API error/timeout → non-zero, never green.
 * A5: ci-control-manifest.test.ts stays green (separate SSOT file — the
 *     manifest is untouched, so validateControlManifest is unaffected).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { trackTmpDirs } from '../helpers/tmp-dir.ts';
import {
  checkRequiredContexts,
  EXIT_ABSENT,
  EXIT_INCONCLUSIVE,
  EXIT_PASS,
  loadRequiredContexts,
  run,
  type ActionsRunsResponse,
  type CheckRunsResponse,
  type RequiredContext,
} from '../../scripts/ci-required-contexts-guard.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const tmp = trackTmpDirs('ws2980-');

const HEAD_SHA = 'abc123def456789012345678901234567890abcd';

const githubActionsContexts: RequiredContext[] = [
  { name: 'quality (24.x)', source: 'github-actions', workflow: 'Quality' },
  { name: 'quality (25.x)', source: 'github-actions', workflow: 'Quality' },
];

const actionsRunsAllPresent: ActionsRunsResponse = {
  workflow_runs: [
    { name: 'Quality', head_sha: HEAD_SHA, status: 'completed', conclusion: 'success' },
  ],
};

const checkRunsAllPresent: CheckRunsResponse = {
  check_runs: [
    { name: 'quality (24.x)', head_sha: HEAD_SHA, status: 'completed', conclusion: 'success' },
    { name: 'quality (25.x)', head_sha: HEAD_SHA, status: 'completed', conclusion: 'success' },
  ],
};

function makeOutput(): { stdout: string; stderr: string; out: { stdout: (s: string) => void; stderr: (s: string) => void } } {
  const buf = { stdout: '', stderr: '' };
  return {
    get stdout() { return buf.stdout; },
    get stderr() { return buf.stderr; },
    out: {
      stdout: (s: string) => { buf.stdout += s; },
      stderr: (s: string) => { buf.stderr += s; },
    },
  };
}

afterEach(() => {
  process.exitCode = undefined;
});

// -------------------------------------------------------------------------
// A1: DISCRIMINATING missing-context → non-zero + ABSENT message
// -------------------------------------------------------------------------

describe('A1: missing context is ABSENT and blocks', () => {
  it('reports ABSENT naming the context and exits non-zero when a required context has no run at the head SHA', () => {
    // actionsRuns has NO run at HEAD_SHA — quality workflow ran at a DIFFERENT sha
    const actionsRunsMissing: ActionsRunsResponse = {
      workflow_runs: [
        { name: 'Quality', head_sha: '9999'.repeat(10), status: 'completed', conclusion: 'success' },
      ],
    };

    const { verdicts, exitCode } = checkRequiredContexts(
      githubActionsContexts,
      HEAD_SHA,
      actionsRunsMissing,
      checkRunsAllPresent,
    );

    expect(exitCode).toBe(EXIT_ABSENT);
    const absent = verdicts.filter((v) => v.status === 'absent');
    expect(absent.length).toBe(2);
    // ABSENT message MUST name the context
    expect(absent[0]!.detail).toContain('ABSENT');
    expect(absent[0]!.detail).toContain('quality (24.x)');
    expect(absent[1]!.detail).toContain('ABSENT');
    expect(absent[1]!.detail).toContain('quality (25.x)');
  });

  it('DISCRIMINATOR: fails if the guard is a no-op that always returns present', () => {
    // If someone replaces checkRequiredContexts with a stub that always
    // returns present, this test fails because exitCode would be 0, not 1.
    const { exitCode } = checkRequiredContexts(
      githubActionsContexts,
      HEAD_SHA,
      null, // API error
      null,
    );
    expect(exitCode).not.toBe(EXIT_PASS);
  });
});

// -------------------------------------------------------------------------
// A2: all-registered head → exit 0
// -------------------------------------------------------------------------

describe('A2: all contexts present → exit 0', () => {
  it('exits 0 when every required context has a run at the exact head SHA', () => {
    const { verdicts, exitCode } = checkRequiredContexts(
      githubActionsContexts,
      HEAD_SHA,
      actionsRunsAllPresent,
      checkRunsAllPresent,
    );

    expect(exitCode).toBe(EXIT_PASS);
    expect(verdicts.every((v) => v.status === 'present')).toBe(true);
  });
});

// -------------------------------------------------------------------------
// A3: DISCRIMINATING check-runs-reporting context covered
// -------------------------------------------------------------------------

describe('A3: check-runs context is covered (fails if only actions/runs queried)', () => {
  const checkRunsContext: RequiredContext = { name: 'CodeQL', source: 'check-runs' };

  // A check-runs context present ONLY in the check-runs API response.
  const checkRunsWithCodeQL: CheckRunsResponse = {
    check_runs: [
      { name: 'CodeQL', head_sha: HEAD_SHA, status: 'completed', conclusion: 'success' },
    ],
  };

  // No matching workflow run — CodeQL is NOT a GitHub Actions workflow.
  const actionsRunsNoCodeQL: ActionsRunsResponse = {
    workflow_runs: [],
  };

  it('finds a check-runs context via the check-runs API and exits 0', () => {
    const { verdicts, exitCode } = checkRequiredContexts(
      [checkRunsContext],
      HEAD_SHA,
      actionsRunsNoCodeQL,
      checkRunsWithCodeQL,
    );

    expect(exitCode).toBe(EXIT_PASS);
    expect(verdicts[0]!.status).toBe('present');
    expect(verdicts[0]!.detail).toContain('CodeQL');
  });

  it('DISCRIMINATOR: a check-runs context goes ABSENT if checkRuns is null (simulating only actions/runs queried)', () => {
    // If the guard only queries actions/runs (checkRuns = null), a check-runs
    // context cannot be found → inconclusive (API unavailable for that source).
    // This test fails if someone removes the check-runs query path: the context
    // would silently go undetected instead of being flagged.
    const { verdicts, exitCode } = checkRequiredContexts(
      [checkRunsContext],
      HEAD_SHA,
      actionsRunsNoCodeQL,
      null, // check-runs API not queried
    );

    expect(exitCode).not.toBe(EXIT_PASS);
    expect(verdicts[0]!.status).not.toBe('present');
  });

  it('DISCRIMINATOR: a check-runs context with no matching check-run is ABSENT, not silently green', () => {
    const emptyCheckRuns: CheckRunsResponse = { check_runs: [] };
    const { verdicts, exitCode } = checkRequiredContexts(
      [checkRunsContext],
      HEAD_SHA,
      actionsRunsNoCodeQL,
      emptyCheckRuns,
    );

    expect(exitCode).toBe(EXIT_ABSENT);
    expect(verdicts[0]!.status).toBe('absent');
    expect(verdicts[0]!.detail).toContain('ABSENT');
    expect(verdicts[0]!.detail).toContain('CodeQL');
  });
});

// -------------------------------------------------------------------------
// A4: API error/timeout → non-zero, never green
// -------------------------------------------------------------------------

describe('A4: API error or timeout → non-zero, never green', () => {
  it('both APIs null → INCONCLUSIVE (exit 2), never green', () => {
    const { exitCode } = checkRequiredContexts(
      githubActionsContexts,
      HEAD_SHA,
      null,
      null,
    );
    expect(exitCode).toBe(EXIT_INCONCLUSIVE);
  });

  it('actions API null with github-actions contexts → INCONCLUSIVE, never green', () => {
    const { exitCode } = checkRequiredContexts(
      githubActionsContexts,
      HEAD_SHA,
      null,
      checkRunsAllPresent,
    );
    expect(exitCode).toBe(EXIT_INCONCLUSIVE);
  });

  it('check-runs API null with check-runs contexts → INCONCLUSIVE, never green', () => {
    const checkRunsCtx: RequiredContext = { name: 'CodeQL', source: 'check-runs' };
    const { exitCode } = checkRequiredContexts(
      [checkRunsCtx],
      HEAD_SHA,
      actionsRunsAllPresent,
      null,
    );
    expect(exitCode).toBe(EXIT_INCONCLUSIVE);
  });
});

// -------------------------------------------------------------------------
// Registry loading + run() integration
// -------------------------------------------------------------------------

describe('registry loading', () => {
  it('loads the production SSOT from the repo root', () => {
    const registry = loadRequiredContexts(repoRoot);
    expect(registry.schemaVersion).toBe(1);
    expect(registry.contexts.length).toBe(2);
    expect(registry.contexts.map((c) => c.name).sort()).toEqual(['quality (24.x)', 'quality (25.x)']);
    expect(registry.failurePolicy.missing).toBe('block');
    expect(registry.failurePolicy.apiError).toBe('block');
    expect(registry.failurePolicy.timeout).toBe('block');
  });

  it('rejects an invalid registry (missing schemaVersion)', () => {
    const root = tmp.make('bad-registry');
    mkdirSync(path.join(root, 'controls'), { recursive: true });
    writeFileSync(path.join(root, 'controls/ci-required-contexts.json'), '{"contexts":[]}', 'utf8');
    expect(() => loadRequiredContexts(root)).toThrow();
  });
});

describe('run() integration with mock deps', () => {
  function makeMockDeps(
    actionsRunsJson: string | null,
    checkRunsJson: string | null,
  ) {
    const calls: string[] = [];
    const ghApi = (endpoint: string): string => {
      calls.push(endpoint);
      if (endpoint.includes('/actions/runs')) {
        if (actionsRunsJson === null) throw new Error('mock API error: actions/runs');
        return actionsRunsJson;
      }
      if (endpoint.includes('/check-runs')) {
        if (checkRunsJson === null) throw new Error('mock API error: check-runs');
        return checkRunsJson;
      }
      throw new Error(`unexpected endpoint: ${endpoint}`);
    };
    return { ghApi, calls, gitHeadSha: () => HEAD_SHA, ownerRepo: () => 'owner/repo' };
  }

  it('A2 via run(): all present → exit 0', () => {
    const deps = makeMockDeps(
      JSON.stringify(actionsRunsAllPresent),
      JSON.stringify(checkRunsAllPresent),
    );
    const result = makeOutput();
    const code = run(['--head-sha', HEAD_SHA], repoRoot, deps, result.out);
    expect(code).toBe(0);
    expect(result.stdout).toContain('all 2 required context(s) present');
    expect(result.stderr).toBe('');
  });

  it('A1 via run(): missing context → exit 1 + ABSENT in stderr', () => {
    const emptyActions: ActionsRunsResponse = { workflow_runs: [] };
    const deps = makeMockDeps(JSON.stringify(emptyActions), JSON.stringify(checkRunsAllPresent));
    const result = makeOutput();
    const code = run(['--head-sha', HEAD_SHA], repoRoot, deps, result.out);
    expect(code).toBe(1);
    expect(result.stderr).toContain('ABSENT');
    expect(result.stderr).toContain('quality');
  });

  it('A4 via run(): both APIs fail → exit 2, never green', () => {
    const deps = makeMockDeps(null, null);
    const result = makeOutput();
    const code = run(['--head-sha', HEAD_SHA], repoRoot, deps, result.out);
    expect(code).toBe(2);
    expect(result.stderr).toContain('INCONCLUSIVE');
  });

  it('queries BOTH actions/runs and check-runs endpoints (A3: both APIs are called)', () => {
    const deps = makeMockDeps(
      JSON.stringify(actionsRunsAllPresent),
      JSON.stringify(checkRunsAllPresent),
    );
    const result = makeOutput();
    run(['--head-sha', HEAD_SHA], repoRoot, deps, result.out);
    expect(deps.calls.some((c) => c.includes('/actions/runs'))).toBe(true);
    expect(deps.calls.some((c) => c.includes('/check-runs'))).toBe(true);
  });
});
