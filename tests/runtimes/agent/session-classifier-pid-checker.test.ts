import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readFileSync: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: mocks.readFileSync,
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: mocks.execFileSync,
  };
});

const { defaultPidOwnershipChecker } = await import('../../../src/runtimes/agent/session-classifier.ts');

describe('defaultPidOwnershipChecker', () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mocks.readFileSync.mockReset();
    mocks.execFileSync.mockReset();
    killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
  });

  afterEach(() => {
    killSpy.mockRestore();
  });

  it('classifies a failed liveness probe as dead and unowned', () => {
    killSpy.mockImplementation(() => {
      throw new Error('no such process');
    });

    expect(defaultPidOwnershipChecker(1234)).toEqual({ alive: false, owned: false });
    expect(mocks.readFileSync).not.toHaveBeenCalled();
    expect(mocks.execFileSync).not.toHaveBeenCalled();
  });

  it('accepts a direct child claude process from procfs evidence', () => {
    mocks.readFileSync.mockImplementation((path: string) => {
      if (path.endsWith('/status')) return `Name:\tclaude\nPPid:\t${process.pid}\n`;
      if (path.endsWith('/cmdline')) return 'claude\u0000--print';
      throw new Error(`unexpected path ${path}`);
    });

    expect(defaultPidOwnershipChecker(2345)).toEqual({ alive: true, owned: true });
    expect(mocks.execFileSync).not.toHaveBeenCalled();
  });

  it('rejects procfs evidence when the process parent differs', () => {
    mocks.readFileSync.mockReturnValue(`Name:\tclaude\nPPid:\t${process.pid + 1}\n`);

    expect(defaultPidOwnershipChecker(3456)).toEqual({ alive: true, owned: false });
    expect(mocks.readFileSync).toHaveBeenCalledTimes(1);
    expect(mocks.execFileSync).not.toHaveBeenCalled();
  });

  it('rejects procfs evidence when the parent process id is absent', () => {
    mocks.readFileSync.mockReturnValue('Name:\tclaude\n');

    expect(defaultPidOwnershipChecker(3567)).toEqual({ alive: true, owned: false });
    expect(mocks.readFileSync).toHaveBeenCalledTimes(1);
    expect(mocks.execFileSync).not.toHaveBeenCalled();
  });

  it('rejects procfs evidence when the command is not claude', () => {
    mocks.readFileSync.mockImplementation((path: string) => {
      if (path.endsWith('/status')) return `Name:\tnode\nPPid:\t${process.pid}\n`;
      if (path.endsWith('/cmdline')) return 'node\u0000worker.js';
      throw new Error(`unexpected path ${path}`);
    });

    expect(defaultPidOwnershipChecker(4567)).toEqual({ alive: true, owned: false });
    expect(mocks.execFileSync).not.toHaveBeenCalled();
  });

  it('falls back to ps when procfs is unavailable and accepts child claude output', () => {
    mocks.readFileSync.mockImplementation(() => {
      throw new Error('no procfs');
    });
    mocks.execFileSync.mockReturnValue(Buffer.from(`${process.pid} claude\n`));

    expect(defaultPidOwnershipChecker(5678)).toEqual({ alive: true, owned: true });
    expect(mocks.execFileSync).toHaveBeenCalledWith('ps', ['-o', 'ppid=,comm=', '-p', '5678'], {
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });

  it('keeps ps fallback conservative when ownership evidence does not match', () => {
    mocks.readFileSync.mockImplementation(() => {
      throw new Error('no procfs');
    });
    mocks.execFileSync.mockReturnValue(`${process.pid} node\n`);

    expect(defaultPidOwnershipChecker(6789)).toEqual({ alive: true, owned: false });
  });

  it('keeps live PIDs unowned when both procfs and ps ownership checks fail', () => {
    mocks.readFileSync.mockImplementation(() => {
      throw new Error('permission denied');
    });
    mocks.execFileSync.mockImplementation(() => {
      throw new Error('ps failed');
    });

    expect(defaultPidOwnershipChecker(7890)).toEqual({ alive: true, owned: false });
  });

  // Production 2026-07-17: a cleared/invalid claude_pid reached the ps fallback
  // and procps rejected it with "error: process ID out of range" + usage text on
  // the service's inherited stderr. Invalid pids must never reach any probe:
  // pid<=0 also has process-group semantics in kill(), so the guard must sit
  // before process.kill, not just before ps.
  describe('invalid pid guard', () => {
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['zero', 0],
      ['negative', -1],
      ['float', 12.5],
      ['string garbage', 'garbage'],
    ])('never probes and resolves dead+unowned for %s pid', (_label, pid) => {
      mocks.readFileSync.mockImplementation(() => {
        throw new Error('no procfs');
      });

      expect(defaultPidOwnershipChecker(pid as unknown as number)).toEqual({
        alive: false,
        owned: false,
      });
      expect(killSpy).not.toHaveBeenCalled();
      expect(mocks.readFileSync).not.toHaveBeenCalled();
      expect(mocks.execFileSync).not.toHaveBeenCalled();
    });

    it('still probes a valid pid', () => {
      mocks.readFileSync.mockImplementation(() => {
        throw new Error('no procfs');
      });
      mocks.execFileSync.mockReturnValue(Buffer.from(`${process.pid} claude\n`));

      expect(defaultPidOwnershipChecker(4242)).toEqual({ alive: true, owned: true });
      expect(killSpy).toHaveBeenCalledWith(4242, 0);
      expect(mocks.execFileSync).toHaveBeenCalledTimes(1);
    });
  });
});
