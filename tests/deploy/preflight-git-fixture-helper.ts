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

export function gitFixture(repoRoot: string, args: string[]): void {
  const result = spawnSync('git', args, {
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
