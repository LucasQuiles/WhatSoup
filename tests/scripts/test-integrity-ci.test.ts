import { spawnSync } from 'node:child_process';
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
