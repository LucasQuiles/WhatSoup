import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), 'deploy/scripts/run-with-timeout.sh');

function run(seconds: string, command: string[]): ReturnType<typeof spawnSync> {
  return spawnSync('bash', [SCRIPT, seconds, ...command], {
    encoding: 'utf8',
    env: { ...process.env, PATH: '/usr/bin:/bin' },
    timeout: 10_000,
  });
}

describe('run-with-timeout', () => {
  it('preserves command arguments exactly', () => {
    const result = run('5', ['/bin/sh', '-c', 'printf "<%s>" "$1"', 'sh', 'two words']);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('<two words>');
  });

  it('propagates an ordinary command failure', () => {
    const result = run('5', ['/bin/sh', '-c', 'exit 7']);
    expect(result.status).toBe(7);
  });

  it('returns 124 when the command exceeds the deadline', () => {
    const started = Date.now();
    const result = run('1', ['/bin/sh', '-c', 'sleep 5']);
    expect(result.status).toBe(124);
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('rejects missing or invalid inputs without running a command', () => {
    expect(run('0', ['/usr/bin/true']).status).toBe(64);
    expect(spawnSync('bash', [SCRIPT], { encoding: 'utf8' }).status).toBe(64);
  });
});
