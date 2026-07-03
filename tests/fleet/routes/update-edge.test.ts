import { existsSync, unlinkSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createServiceManagerSpy,
  execFileAsyncSpy,
  execFileCbSpy,
  restartSpy,
} = vi.hoisted(() => ({
  createServiceManagerSpy: vi.fn(),
  execFileAsyncSpy: vi.fn(),
  execFileCbSpy: vi.fn(),
  restartSpy: vi.fn(),
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

vi.mock('../../../src/fleet/platform.ts', () => ({
  createServiceManager: createServiceManagerSpy,
}));

import { handleUpdate } from '../../../src/fleet/routes/update.ts';

const patchPaths = new Set<string>();

function createDefaultServiceManager() {
  return {
    restart: restartSpy,
    start: vi.fn(),
    stop: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    startFire: vi.fn(),
  };
}

async function settleRestartSpy(): Promise<void> {
  await Promise.allSettled(
    restartSpy.mock.results.map((result) => (
      result.type === 'return' ? result.value : Promise.resolve()
    )),
  );
  await Promise.resolve();
  await Promise.resolve();
}

function makeReqRes() {
  const chunks: string[] = [];
  let closeHandler: (() => void) | undefined;

  const req = {
    on: vi.fn((event: string, cb: () => void) => {
      if (event === 'close') {
        closeHandler = cb;
      }
    }),
    triggerClose: () => closeHandler?.(),
  } as any;

  const res = {
    writeHead: vi.fn(),
    write: vi.fn((chunk: string) => {
      chunks.push(chunk);
      return true;
    }),
    end: vi.fn(),
    get chunks() {
      return chunks;
    },
  } as any;

  return { req, res };
}

function makeChecker() {
  return {
    checkNow: vi.fn().mockResolvedValue({}),
  } as any;
}

function parseSSE(chunks: string[]) {
  return chunks.map((chunk) => {
    const lines = chunk.split('\n').filter(Boolean);
    const event = lines.find((line) => line.startsWith('event:'))?.slice('event:'.length).trim();
    const dataLine = lines.find((line) => line.startsWith('data:'))?.slice('data:'.length).trim();
    return { event, data: dataLine ? JSON.parse(dataLine) : undefined };
  });
}

function sseSequence(chunks: string[]) {
  return parseSSE(chunks).map((entry) => ({
    event: entry.event,
    step: entry.data?.step,
    ...(entry.data?.status === undefined ? {} : { status: entry.data.status }),
  }));
}

function execFileAsyncCalls() {
  return execFileAsyncSpy.mock.calls.map(([cmd, args, options]: any[]) => ({
    cmd,
    args,
    cwd: options?.cwd,
    timeout: options?.timeout,
  }));
}

beforeEach(() => {
  vi.resetAllMocks();
  restartSpy.mockResolvedValue(undefined);
  createServiceManagerSpy.mockImplementation(createDefaultServiceManager);
  execFileCbSpy.mockImplementation((_cmd: unknown, _args: unknown, cb: (err?: Error | null) => void) => {
    cb(null);
    return {} as any;
  });
});

afterEach(async () => {
  await settleRestartSpy();
  for (const patchPath of patchPaths) {
    if (existsSync(patchPath)) {
      unlinkSync(patchPath);
    }
  }
  patchPaths.clear();
});

describe('handleUpdate edge behavior', () => {
  it('rejects tracked dirty working trees before pulling while ignoring untracked files', async () => {
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: ' M src/fleet/index.ts\n?? local-note.txt\n', stderr: '' });

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    const events = parseSSE(res.chunks);
    expect(sseSequence(res.chunks)).toEqual([
      { event: 'error', step: 'pull' },
    ]);
    expect(events[0].data).toEqual({
      step: 'pull',
      message: 'Working tree has 1 uncommitted change(s). Commit or stash before updating.',
    });
    expect(execFileAsyncCalls()).toEqual([
      { cmd: 'git', args: ['rev-parse', 'HEAD'], cwd: '/repo', timeout: 5_000 },
      { cmd: 'git', args: ['status', '--porcelain'], cwd: '/repo', timeout: 5_000 },
    ]);
    expect(restartSpy).not.toHaveBeenCalled();
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('continues to pull when the preflight status probe fails', async () => {
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234\n', stderr: '' })
      .mockRejectedValueOnce(new Error('status unavailable'))
      .mockResolvedValueOnce({ stdout: 'Updating abc..def\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'def5678\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');
    await settleRestartSpy();

    expect(sseSequence(res.chunks)).toEqual([
      { event: 'progress', step: 'pull', status: 'running' },
      { event: 'progress', step: 'pull', status: 'done' },
      { event: 'progress', step: 'install', status: 'running' },
      { event: 'progress', step: 'install', status: 'skip' },
      { event: 'progress', step: 'console-install', status: 'running' },
      { event: 'progress', step: 'console-install', status: 'skip' },
      { event: 'progress', step: 'console-build', status: 'skip' },
      { event: 'progress', step: 'restart', status: 'running' },
    ]);
    expect(restartSpy).toHaveBeenCalledWith('whatsoup-fleet');
  });

  it('preserves and stops before rebuild or restart when console npm install fails', async () => {
    const installErr: any = new Error('console install failed');
    installErr.stderr = 'npm ERR! console deps';
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234abc1234abc1234abc1234abc1234abc1234\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'Updating abc..def\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'def5678\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'console/package-lock.json\n', stderr: '' })
      .mockRejectedValueOnce(installErr)
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    const events = parseSSE(res.chunks);
    expect(sseSequence(res.chunks)).toEqual([
      { event: 'progress', step: 'pull', status: 'running' },
      { event: 'progress', step: 'pull', status: 'done' },
      { event: 'progress', step: 'install', status: 'running' },
      { event: 'progress', step: 'install', status: 'skip' },
      { event: 'progress', step: 'console-install', status: 'running' },
      { event: 'error', step: 'console-install' },
      { event: 'progress', step: 'preserve', status: 'done' },
    ]);
    expect(events[5].data).toEqual({
      step: 'console-install',
      message: 'npm ERR! console deps',
    });
    expect(events[6].data).toMatchObject({
      step: 'preserve',
      status: 'done',
      previousSha: 'abc1234abc1234abc1234abc1234abc1234abc1234',
      preservedFiles: [],
    });
    expect(execFileAsyncCalls()).toEqual([
      { cmd: 'git', args: ['rev-parse', 'HEAD'], cwd: '/repo', timeout: 5_000 },
      { cmd: 'git', args: ['status', '--porcelain'], cwd: '/repo', timeout: 5_000 },
      { cmd: 'git', args: ['pull', 'origin', 'main'], cwd: '/repo', timeout: 60_000 },
      { cmd: 'git', args: ['rev-parse', '--short', 'HEAD'], cwd: '/repo', timeout: 5_000 },
      {
        cmd: 'git',
        args: ['diff', 'abc1234abc1234abc1234abc1234abc1234abc1234', '--name-only'],
        cwd: '/repo',
        timeout: 10_000,
      },
      { cmd: 'npm', args: ['install'], cwd: '/repo/console', timeout: 120_000 },
      { cmd: 'git', args: ['status', '--porcelain'], cwd: '/repo', timeout: 5_000 },
    ]);
    expect(restartSpy).not.toHaveBeenCalled();
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('emits preserve skipped when generated drift exists but diff capture fails', async () => {
    const installErr: any = new Error('install failed');
    installErr.stderr = 'npm ERR! install failed';
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234abc1234abc1234abc1234abc1234abc1234\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'Updating abc..def\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'def5678\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'package-lock.json\n', stderr: '' })
      .mockRejectedValueOnce(installErr)
      .mockResolvedValueOnce({ stdout: ' M package-lock.json\n', stderr: '' })
      .mockRejectedValueOnce(new Error('diff failed'));

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    const events = parseSSE(res.chunks);
    expect(sseSequence(res.chunks)).toEqual([
      { event: 'progress', step: 'pull', status: 'running' },
      { event: 'progress', step: 'pull', status: 'done' },
      { event: 'progress', step: 'install', status: 'running' },
      { event: 'error', step: 'install' },
      { event: 'progress', step: 'preserve', status: 'skipped' },
    ]);
    expect(events[4].data).toEqual({
      step: 'preserve',
      status: 'skipped',
      reason: 'diff-capture-failed',
      previousSha: 'abc1234abc1234abc1234abc1234abc1234abc1234',
      files: ['package-lock.json'],
      message: 'Update validation failed. Unable to capture a patch; fleet server was not restarted.',
    });
    expect(restartSpy).not.toHaveBeenCalled();
  });

  it('keeps the patch artifact and reports no stash ref when stash preservation fails', async () => {
    const installErr: any = new Error('install failed');
    installErr.stderr = 'npm ERR! install failed';
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234abc1234abc1234abc1234abc1234abc1234\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'Updating abc..def\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'def5678\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'package-lock.json\n', stderr: '' })
      .mockRejectedValueOnce(installErr)
      .mockResolvedValueOnce({ stdout: ' M package-lock.json\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'diff --git a/package-lock.json b/package-lock.json\n', stderr: '' })
      .mockRejectedValueOnce(new Error('stash failed'));

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    const events = parseSSE(res.chunks);
    const preserveEvent = events[events.length - 1];
    expect(preserveEvent.event).toBe('progress');
    expect(preserveEvent.data).toMatchObject({
      step: 'preserve',
      status: 'done',
      previousSha: 'abc1234abc1234abc1234abc1234abc1234abc1234',
      preservedFiles: ['package-lock.json'],
    });
    expect(preserveEvent.data.patchPath).toMatch(/^\/tmp\/whatsoup-update-preserve-.*-abc1234\.patch$/);
    expect(preserveEvent.data.stashRef).toBeUndefined();
    patchPaths.add(preserveEvent.data.patchPath);
    expect(existsSync(preserveEvent.data.patchPath)).toBe(true);
    expect(execFileAsyncCalls().at(-1)).toMatchObject({
      cmd: 'git',
      args: expect.arrayContaining(['stash', 'push']),
      cwd: '/repo',
      timeout: 15_000,
    });
  });

  it('continues to restart when the asynchronous version refresh rejects', async () => {
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'Updating abc..def\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'def5678\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });
    const checker = {
      checkNow: vi.fn().mockRejectedValue(new Error('refresh failed')),
    } as any;

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, checker, '/repo');
    await settleRestartSpy();

    expect(checker.checkNow).toHaveBeenCalledTimes(1);
    expect(sseSequence(res.chunks)).toContainEqual({
      event: 'progress',
      step: 'restart',
      status: 'running',
    });
    expect(restartSpy).toHaveBeenCalledWith('whatsoup-fleet');
  });

  it('keeps the original pull error when SSH fallback cannot read the origin URL', async () => {
    const sshErr: any = new Error('pull failed');
    sshErr.stderr = 'Permission denied (publickey).';
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(sshErr)
      .mockRejectedValueOnce(new Error('remote unavailable'));

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    const events = parseSSE(res.chunks);
    expect(sseSequence(res.chunks)).toEqual([
      { event: 'progress', step: 'pull', status: 'running' },
      { event: 'error', step: 'pull' },
    ]);
    expect(events[1].data).toEqual({
      step: 'pull',
      message: 'Permission denied (publickey).',
    });
    expect(execFileAsyncCalls()).toEqual([
      { cmd: 'git', args: ['rev-parse', 'HEAD'], cwd: '/repo', timeout: 5_000 },
      { cmd: 'git', args: ['status', '--porcelain'], cwd: '/repo', timeout: 5_000 },
      { cmd: 'git', args: ['pull', 'origin', 'main'], cwd: '/repo', timeout: 60_000 },
      { cmd: 'git', args: ['remote', 'get-url', 'origin'], cwd: '/repo', timeout: 5_000 },
    ]);
  });

  it('keeps the original pull error when SSH fallback cannot derive a GitHub HTTPS URL', async () => {
    const sshErr: any = new Error('pull failed');
    sshErr.stderr = 'Permission denied (publickey).';
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(sshErr)
      .mockResolvedValueOnce({ stdout: 'ssh://git.example.invalid/private/repo.git\n', stderr: '' });

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    const events = parseSSE(res.chunks);
    expect(sseSequence(res.chunks)).toEqual([
      { event: 'progress', step: 'pull', status: 'running' },
      { event: 'error', step: 'pull' },
    ]);
    expect(events[1].data).toEqual({
      step: 'pull',
      message: 'Permission denied (publickey).',
    });
    expect(execFileAsyncCalls()).toEqual([
      { cmd: 'git', args: ['rev-parse', 'HEAD'], cwd: '/repo', timeout: 5_000 },
      { cmd: 'git', args: ['status', '--porcelain'], cwd: '/repo', timeout: 5_000 },
      { cmd: 'git', args: ['pull', 'origin', 'main'], cwd: '/repo', timeout: 60_000 },
      { cmd: 'git', args: ['remote', 'get-url', 'origin'], cwd: '/repo', timeout: 5_000 },
    ]);
  });

  it('emits an unknown-step SSE error if the service manager factory throws synchronously', async () => {
    createServiceManagerSpy.mockImplementationOnce(() => {
      throw new Error('service manager unavailable');
    });
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'Updating abc..def\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'def5678\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'src/fleet/routes/update.ts\n', stderr: '' });

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    const events = parseSSE(res.chunks);
    expect(sseSequence(res.chunks)).toEqual([
      { event: 'progress', step: 'pull', status: 'running' },
      { event: 'progress', step: 'pull', status: 'done' },
      { event: 'progress', step: 'install', status: 'running' },
      { event: 'progress', step: 'install', status: 'skip' },
      { event: 'progress', step: 'console-install', status: 'running' },
      { event: 'progress', step: 'console-install', status: 'skip' },
      { event: 'progress', step: 'console-build', status: 'skip' },
      { event: 'progress', step: 'restart', status: 'running' },
      { event: 'error', step: 'unknown' },
    ]);
    expect(events[8].data).toEqual({
      step: 'unknown',
      message: 'service manager unavailable',
    });
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(restartSpy).not.toHaveBeenCalled();
  });
});
