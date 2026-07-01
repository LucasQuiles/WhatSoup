import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileAsyncSpy, execFileCbSpy } = vi.hoisted(() => ({
  execFileAsyncSpy: vi.fn(),
  execFileCbSpy: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: execFileCbSpy,
}));

vi.mock('node:util', async (importOriginal) => {
  const original = (await importOriginal()) as typeof import('node:util');
  return {
    ...original,
    promisify: () => execFileAsyncSpy,
  };
});

import { UpdateChecker } from '../../src/fleet/update-checker.ts';

function execGit(checker: UpdateChecker, args: string[]): Promise<string> {
  return (checker as unknown as { execGit(args: string[]): Promise<string> }).execGit(args);
}

function execFileAsyncCalls() {
  return execFileAsyncSpy.mock.calls.map(([cmd, args, options]: any[]) => ({
    cmd,
    args,
    cwd: options?.cwd,
    timeout: options?.timeout,
    env: options?.env as NodeJS.ProcessEnv | undefined,
  }));
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('UpdateChecker edge behavior', () => {
  it('execGit runs git in the repo root, trims stdout, and strips inherited git worktree env', async () => {
    vi.stubEnv('GIT_DIR', '/tmp/outer/.git');
    vi.stubEnv('GIT_WORK_TREE', '/tmp/outer');
    execFileAsyncSpy.mockResolvedValueOnce({ stdout: ' abc1234 \n', stderr: '' });
    const checker = new UpdateChecker('/repo');

    const result = await execGit(checker, ['rev-parse', '--short', 'HEAD']);

    expect(result).toBe('abc1234');
    const [call] = execFileAsyncCalls();
    expect(call).toMatchObject({
      cmd: 'git',
      args: ['rev-parse', '--short', 'HEAD'],
      cwd: '/repo',
      timeout: 30_000,
    });
    expect([call.env?.GIT_DIR, call.env?.GIT_WORK_TREE]).toEqual([undefined, undefined]);
  });

  it('keeps remote state unknown when SSH fallback cannot read the configured origin URL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-03T01:02:03.004Z'));
    const sshErr: any = new Error('fetch failed');
    sshErr.stderr = 'Permission denied (publickey).';
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234\n', stderr: '' })
      .mockRejectedValueOnce(sshErr)
      .mockRejectedValueOnce(new Error('remote unavailable'));
    const checker = new UpdateChecker('/repo');

    const state = await checker.checkNow();

    expect(state).toEqual({
      sha: 'abc1234',
      remoteSha: 'unknown',
      updateAvailable: false,
      checkedAt: '2026-04-03T01:02:03.004Z',
    });
    expect(execFileAsyncCalls().map(({ args }) => args)).toEqual([
      ['rev-parse', '--short', 'HEAD'],
      ['fetch', 'origin', 'main', '--quiet'],
      ['remote', 'get-url', 'origin'],
    ]);
  });

  it('keeps remote state unknown when SSH fallback cannot derive a public GitHub URL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-03T02:03:04.005Z'));
    const sshErr: any = new Error('fetch failed');
    sshErr.stderr = 'Permission denied (publickey).';
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234\n', stderr: '' })
      .mockRejectedValueOnce(sshErr)
      .mockResolvedValueOnce({ stdout: 'ssh://git.example.invalid/private/repo.git\n', stderr: '' });
    const checker = new UpdateChecker('/repo');

    const state = await checker.checkNow();

    expect(state).toEqual({
      sha: 'abc1234',
      remoteSha: 'unknown',
      updateAvailable: false,
      checkedAt: '2026-04-03T02:03:04.005Z',
    });
    expect(execFileAsyncCalls().map(({ args }) => args)).toEqual([
      ['rev-parse', '--short', 'HEAD'],
      ['fetch', 'origin', 'main', '--quiet'],
      ['remote', 'get-url', 'origin'],
    ]);
  });

  it('start swallows a rejected immediate check and still arms the interval', async () => {
    vi.useFakeTimers();
    const checker = new UpdateChecker('/repo');
    const checkNowSpy = vi.spyOn(checker, 'checkNow').mockRejectedValue(new Error('initial check failed'));

    checker.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(checkNowSpy).toHaveBeenCalledTimes(1);
    const timer = (checker as unknown as { timer: NodeJS.Timeout | null }).timer;
    expect(timer).not.toBeNull();
    checker.stop();
  });

  it('periodic checks swallow rejections and keep the scheduler alive', async () => {
    vi.useFakeTimers();
    const checker = new UpdateChecker('/repo');
    const checkNowSpy = vi.spyOn(checker, 'checkNow')
      .mockResolvedValueOnce({} as any)
      .mockRejectedValueOnce(new Error('periodic check failed'))
      .mockResolvedValueOnce({} as any);

    checker.start();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await Promise.resolve();

    expect(checkNowSpy).toHaveBeenCalledTimes(3);
    checker.stop();
  });
});
