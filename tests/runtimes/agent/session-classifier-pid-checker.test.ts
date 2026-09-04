import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readFileSync: vi.fn(),
  execFileSync: vi.fn(),
  birthToken: vi.fn((pid: number) => `birth:${pid}`),
}));

vi.mock('../../../src/lib/process-identity.ts', () => ({
  probeProcessBirthToken: mocks.birthToken,
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
    mocks.birthToken.mockReset().mockImplementation((pid: number) => `birth:${pid}`);
    killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
  });

  afterEach(() => {
    killSpy.mockRestore();
  });

  it.each(['EPERM', 'EACCES', 'EIO'] as const)(
    'keeps a PID conservatively alive and unowned when kill -0 fails with %s',
    (code) => {
      killSpy.mockImplementation(() => {
        const error = new Error('private probe detail') as NodeJS.ErrnoException;
        error.code = code;
        throw error;
      });

      expect(defaultPidOwnershipChecker(1234)).toEqual({ alive: true, owned: false });
      expect(mocks.readFileSync).not.toHaveBeenCalled();
      expect(mocks.execFileSync).not.toHaveBeenCalled();
    },
  );

  it('treats only ESRCH from kill -0 as proof that a PID is dead', () => {
    killSpy.mockImplementation(() => {
      const error = new Error('gone') as NodeJS.ErrnoException;
      error.code = 'ESRCH';
      throw error;
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

  it.each([
    ['codex-cli', 'codex'],
    ['opencode-cli', 'opencode'],
  ] as const)('accepts a direct child for %s using the canonical provider binary', (provider, binary) => {
    mocks.readFileSync.mockImplementation((path: string) => {
      if (path.endsWith('/status')) return `Name:\t${binary}\nPPid:\t${process.pid}\n`;
      if (path.endsWith('/cmdline')) return `${binary}\u0000run`;
      throw new Error(`unexpected path ${path}`);
    });

    expect(defaultPidOwnershipChecker(2445, provider)).toEqual({ alive: true, owned: true });
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
    expect(mocks.execFileSync).toHaveBeenCalledWith('ps', ['-o', 'ppid=,command=', '-p', '5678'], {
      maxBuffer: 64 * 1024,
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });

  it.each([
    ['claude-cli', 'claude'],
    ['codex-cli', 'codex'],
    ['opencode-cli', 'opencode'],
  ] as const)('accepts a node-wrapped %s process from bounded full argv', (provider, binary) => {
    mocks.readFileSync.mockImplementation(() => {
      throw new Error('no procfs');
    });
    mocks.execFileSync.mockImplementation((_file: string, args: readonly string[]) =>
      Buffer.from(
        args.includes('ppid=,command=')
          ? `${process.pid} node /opt/local/bin/${binary} --flag\n`
          : `${process.pid} node\n`,
      ),
    );

    expect(defaultPidOwnershipChecker(5728, provider)).toEqual({ alive: true, owned: true });
  });

  it.each([
    ['codex-cli', 'codex'],
    ['opencode-cli', 'opencode'],
  ] as const)('accepts %s through the ps fallback using the same binary SSOT', (provider, binary) => {
    mocks.readFileSync.mockImplementation(() => {
      throw new Error('no procfs');
    });
    mocks.execFileSync.mockReturnValue(Buffer.from(`${process.pid} /usr/local/bin/${binary}\n`));

    expect(defaultPidOwnershipChecker(5778, provider)).toEqual({ alive: true, owned: true });
  });

  it('does not accept one provider binary as another provider identity', () => {
    mocks.readFileSync.mockImplementation((path: string) => {
      if (path.endsWith('/status')) return `Name:\tcodex\nPPid:\t${process.pid}\n`;
      if (path.endsWith('/cmdline')) return 'codex\u0000run';
      throw new Error(`unexpected path ${path}`);
    });

    expect(defaultPidOwnershipChecker(5888, 'opencode-cli')).toEqual({
      alive: true,
      owned: false,
    });
  });

  it.each([
    ['claude-cli', 'claude'],
    ['codex-cli', 'codex'],
    ['opencode-cli', 'opencode'],
  ] as const)('does not accept %s when its binary name is only an unrelated argument', (provider, binary) => {
    mocks.readFileSync.mockImplementation(() => {
      throw new Error('no procfs');
    });
    mocks.execFileSync.mockReturnValue(
      Buffer.from(`${process.pid} node unrelated.js --display-name ${binary}\n`),
    );

    expect(defaultPidOwnershipChecker(5999, provider)).toEqual({ alive: true, owned: false });
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

  it('rejects ownership when the process birth token changes during inspection', () => {
    mocks.readFileSync.mockImplementation((path: string) => {
      if (path.endsWith('/status')) return `Name:\tclaude\nPPid:\t${process.pid}\n`;
      if (path.endsWith('/cmdline')) return 'claude\u0000--print';
      throw new Error(`unexpected path ${path}`);
    });
    mocks.birthToken
      .mockReturnValueOnce('birth:before')
      .mockReturnValueOnce('birth:after');

    expect(defaultPidOwnershipChecker(7900)).toEqual({ alive: true, owned: false });
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
