import { spawnSync } from 'node:child_process';
import { cleanGitEnv } from '../../src/lib/git-env.ts';

const TIMEOUT_MS = 15_000;

export function gitFixtureEnv(): NodeJS.ProcessEnv {
  return {
    ...cleanGitEnv(),
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@local',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@local',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
}

// maintenance.auto=false: `git commit` otherwise starts a detached
// `git maintenance run --auto` that deletes .git/objects/maintenance.lock after
// commit returns. A fixture that then removes .git races that delete, and
// Node's rmSync reports success while leaving the rest of .git behind.
export function gitFixture(repoRoot: string, args: string[]): void {
  const result = spawnSync('git', ['-c', 'maintenance.auto=false', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: gitFixtureEnv(),
    timeout: TIMEOUT_MS,
  });

  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (${String(result.status)}): ${
        result.stderr || result.stdout || result.error?.message || 'no output'
      }`,
    );
  }
}
