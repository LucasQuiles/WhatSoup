import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path, { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { trackTmpDirs } from '../helpers/tmp-dir.ts';
import { RELEASE_STEPS } from '../../scripts/push-gate.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const wrapperScript = path.join(repoRoot, 'scripts', 'test-integrity-ci.sh');
const tmp = trackTmpDirs('whatsoup-test-integrity-');

function runTestIntegrity(env: NodeJS.ProcessEnv): { status: number; stderr: string } {
  const result = spawnSync('bash', ['scripts/test-integrity-ci.sh'], {
    cwd: new URL('../..', import.meta.url),
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
      TEST_INTEGRITY_BIN: '/tmp/whatsoup-missing-test-integrity-bin',
    },
  });
  return {
    status: result.status ?? 1,
    stderr: result.stderr,
  };
}

function makeFixture(): string {
  return tmp.make('ci');
}

function writeFixtureFile(fixture: string, relativePath: string, contents: string): void {
  const absolutePath = path.join(fixture, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
}

/**
 * Builds a throwaway git repo that reproduces the scanned-tree shape which
 * triggers the nested-worktree defect: a real, git-tracked test file
 * alongside a `.claude/worktrees/<agent>/...` checkout containing its own
 * test file. Deliberately has no .gitignore / .git/info/exclude entry for
 * `.claude/worktrees/` so the exclusion under test cannot be passing by
 * accident of gitignore configuration.
 */
function makeNestedWorktreeFixture(): string {
  const fixture = makeFixture();
  spawnSync('git', ['init', '-q'], { cwd: fixture });
  writeFixtureFile(fixture, 'tests/tracked-example.test.ts', "test('tracked', () => {});\n");
  spawnSync('git', ['add', 'tests/tracked-example.test.ts'], { cwd: fixture });
  writeFixtureFile(fixture, 'tests/untracked-example.test.ts', "test('untracked', () => {});\n");
  writeFixtureFile(
    fixture,
    '.claude/worktrees/fake-agent/tests/evil.test.ts',
    "test('must never be scanned from the parent repo', () => {});\n",
  );
  return fixture;
}

/**
 * A stand-in for the real test-integrity plugin binary. Reimplements only
 * the file-vs-directory half of the plugin's own collect_paths(): a literal
 * file argument is recorded as-is, a directory argument is walked
 * recursively — matching path.is_file()/path.rglob("*") in
 * test_integrity.py's collect_paths(). This lets the test observe exactly
 * which files scripts/test-integrity-ci.sh hands the plugin, without
 * requiring the real plugin to be installed.
 */
function makeCollectPathsStub(fixture: string, captureFile: string): string {
  const stubPath = path.join(fixture, 'collect-paths-stub.sh');
  writeFileSync(
    stubPath,
    `#!/usr/bin/env bash
set -euo pipefail
shift 3 # drop: baseline --check --ci
paths=("$@")
if [ "\${#paths[@]}" -eq 0 ]; then
  paths=(".")
fi
: > "${captureFile}"
for p in "\${paths[@]}"; do
  if [ -f "$p" ]; then
    printf '%s\\n' "$p" >> "${captureFile}"
  elif [ -d "$p" ]; then
    find "$p" -type f >> "${captureFile}"
  fi
done
echo "TEST_INTEGRITY_BASELINE_CHECK status=pass exit_class=clean total_findings=0 baseline_findings=0 new_findings=0 drifted_findings=0 baseline=stub"
`,
  );
  chmodSync(stubPath, 0o755);
  return stubPath;
}

describe('test-integrity CI wrapper', () => {
  it('routes verify:release through the required test-integrity gate', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.['guard:test-integrity:required']).toBe(
      'WHATSOUP_REQUIRE_TEST_INTEGRITY=1 npm run guard:test-integrity',
    );
    const releaseSteps = RELEASE_STEPS.map((step) => step.cmd);
    expect(
      releaseSteps.filter((step) => step === 'npm run guard:test-integrity:required'),
    ).toHaveLength(1);
    expect(
      releaseSteps.some((step) =>
        /(?:^|\s)npm run guard:test-integrity(?:\s|$)/.test(step),
      ),
    ).toBe(false);
  });

  it('allows local optional plugin absence for developer machines', () => {
    const result = runTestIntegrity({
      CI: '',
      GITHUB_ACTIONS: '',
      WHATSOUP_REQUIRE_TEST_INTEGRITY: '',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('skipping');
  });

  it('fails closed when the plugin is missing under CI', () => {
    const result = runTestIntegrity({
      CI: 'true',
      GITHUB_ACTIONS: '',
      WHATSOUP_REQUIRE_TEST_INTEGRITY: '',
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('test-integrity plugin not found');
    expect(result.stderr).toContain('CI=true');
    expect(result.stderr).not.toContain('skipping');
  });

  it('fails closed when the plugin is missing in GitHub Actions', () => {
    const result = runTestIntegrity({
      CI: '',
      GITHUB_ACTIONS: 'true',
      WHATSOUP_REQUIRE_TEST_INTEGRITY: '',
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('GITHUB_ACTIONS=true');
    expect(result.stderr).not.toContain('skipping');
  });

  it('fails closed when explicitly required outside CI', () => {
    const result = runTestIntegrity({
      CI: '',
      GITHUB_ACTIONS: '',
      WHATSOUP_REQUIRE_TEST_INTEGRITY: '1',
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('WHATSOUP_REQUIRE_TEST_INTEGRITY=1');
    expect(result.stderr).not.toContain('skipping');
  });

  it('never hands the plugin files under a nested .claude/worktrees/ checkout, and still scans real repo test files', () => {
    const fixture = makeNestedWorktreeFixture();
    const captureFile = path.join(fixture, 'captured-paths.txt');
    const stub = makeCollectPathsStub(fixture, captureFile);

    const result = spawnSync('bash', [wrapperScript], {
      cwd: fixture,
      encoding: 'utf8',
      env: {
        ...process.env,
        TEST_INTEGRITY_BIN: stub,
        CI: '',
        GITHUB_ACTIONS: '',
        WHATSOUP_REQUIRE_TEST_INTEGRITY: '',
      },
    });

    expect(result.status, result.stderr).toBe(0);
    const captured = existsSync(captureFile) ? readFileSync(captureFile, 'utf8') : '';
    const capturedLines = captured.split('\n').filter(Boolean);

    expect(
      capturedLines.some((line) => line.includes('.claude/worktrees/')),
      `scanned paths must never include a nested worktree checkout; got:\n${captured}`,
    ).toBe(false);
    expect(
      capturedLines.some((line) => line.endsWith('tests/tracked-example.test.ts')),
      `scanned paths must still include tracked repo test files; got:\n${captured}`,
    ).toBe(true);
    expect(
      capturedLines.some((line) => line.endsWith('tests/untracked-example.test.ts')),
      `scanned paths must still include untracked-but-not-ignored repo test files; got:\n${captured}`,
    ).toBe(true);
  });
});
