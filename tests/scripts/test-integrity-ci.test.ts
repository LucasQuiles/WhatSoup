import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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

describe('test-integrity CI wrapper', () => {
  it('routes verify:release through the required test-integrity gate', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.['guard:test-integrity:required']).toBe(
      'WHATSOUP_REQUIRE_TEST_INTEGRITY=1 npm run guard:test-integrity',
    );
    const releaseSteps =
      packageJson.scripts?.['verify:release']
        ?.split('&&')
        .map((step) => step.trim()) ?? [];
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
});
