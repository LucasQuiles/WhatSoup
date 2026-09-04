import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hoistedLoggerMock, type SingletonLoggerMock } from '../../helpers/logger-mock.ts';

const { birthTokenMock, birthTokenBatchMock, execFileSyncMock, processTreeLog } = vi.hoisted(() => {
  const token = vi.fn((pid: number) => `birth:${pid}`);
  return {
    birthTokenMock: token,
    birthTokenBatchMock: vi.fn((pids: readonly number[]) => {
      const observed = new Map<number, string>();
      for (const pid of pids) {
        const value = token(pid);
        if (typeof value === 'string') observed.set(pid, value);
      }
      return observed;
    }),
    execFileSyncMock: vi.fn(),
    processTreeLog: {} as SingletonLoggerMock,
  };
});
hoistedLoggerMock(processTreeLog);

vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
}));

vi.mock('../../../src/lib/process-identity.ts', () => ({
  processBirthTokenSupportsNumericSignal: (token: string) =>
    !token.startsWith('darwin-lstart:'),
  probeProcessBirthToken: birthTokenMock,
  probeProcessBirthTokens: birthTokenBatchMock,
}));

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => processTreeLog,
}));

import {
  bindProcessTreeRootAuthority,
  captureProcessTreeRootAuthority,
  emitCgroupDivergence,
  getRegisteredProcessTreeTerminationLease,
  killSessionTree as killSessionTreeRaw,
  resetProcessTreeTerminationLeasesForTesting,
  retryKillSessionTree,
  PROCESS_TREE_DIAGNOSTIC_SOURCES,
  ProcessTreeTerminationError,
  type KillSessionOutcome,
  type KillSessionTreeOptions,
  type ProcessTreeRootAuthority,
  type ProcessTreeTarget,
  type ProcessTreeTerminationErrorCode,
} from '../../../src/runtimes/agent/process-tree.ts';

const ROOT_PID = 51_001;
const CHILD_PID = 51_002;
const LATE_CHILD_PID = 51_003;
const START = 'Fri Jul 10 08:00:00 2026';

type TestKillOptions = Omit<KillSessionTreeOptions, 'rootAuthority'> & {
  readonly rootAuthority?: ProcessTreeRootAuthority;
};

function killSessionTree(
  target: number | ProcessTreeTarget,
  signal: NodeJS.Signals,
  options: TestKillOptions,
): Promise<KillSessionOutcome> {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    return killSessionTreeRaw(target, signal, options as KillSessionTreeOptions);
  }
  const forwarded = Object.create(Object.getPrototypeOf(options)) as KillSessionTreeOptions;
  const descriptors = Object.getOwnPropertyDescriptors(options);
  Object.defineProperties(forwarded, descriptors);
  const forwardedTarget: ProcessTreeTarget = typeof target === 'number'
    ? {
        pid: target,
        exitCode: null,
        signalCode: null,
        kill: (requestedSignal) => process.kill(target, requestedSignal),
      }
    : target;
  if (!Object.hasOwn(descriptors, 'rootAuthority')) {
    const fallbackTarget: ProcessTreeTarget = {
      pid: ROOT_PID,
      exitCode: null,
      signalCode: null,
      kill: () => true,
    };
    Object.defineProperty(forwarded, 'rootAuthority', {
      configurable: true,
      enumerable: true,
      value: captureProcessTreeRootAuthority(forwardedTarget)
        ?? captureProcessTreeRootAuthority(fallbackTarget),
    });
  }
  return killSessionTreeRaw(forwardedTarget, signal, forwarded);
}

function census(
  rows: Array<{ pid: number; ppid: number; pgid: number; start?: string; command: string }>,
): string {
  return [
    'PID PPID PGID STARTED COMMAND',
    ...rows.map((row) =>
      `${row.pid} ${row.ppid} ${row.pgid} ${row.start ?? START} ${row.command}`,
    ),
  ].join('\n');
}

function rootRows(includeSelf = true): ReturnType<typeof census> {
  return census([
    ...(includeSelf
      ? [{ pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' }]
      : []),
    { pid: ROOT_PID, ppid: process.pid, pgid: ROOT_PID, command: 'provider-root' },
    { pid: CHILD_PID, ppid: ROOT_PID, pgid: ROOT_PID, command: 'provider-child' },
  ]);
}

let killSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  birthTokenMock.mockReset().mockImplementation((pid: number) => `birth:${pid}`);
  birthTokenBatchMock.mockClear();
  execFileSyncMock.mockReset();
  for (const sink of Object.values(processTreeLog)) sink.mockClear();
  killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
});

afterEach(() => {
  resetProcessTreeTerminationLeasesForTesting();
  killSpy.mockRestore();
});

describe('process-tree fail-closed safety', () => {
  it.each([
    ['locally constructed', () => ({ pid: ROOT_PID, parentPid: process.pid, birthToken: `birth:${ROOT_PID}` })],
    ['spread copied', () => ({ ...captureProcessTreeRootAuthority({
      pid: ROOT_PID,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    })! })],
    ['serialized', () => JSON.parse(JSON.stringify(captureProcessTreeRootAuthority({
      pid: ROOT_PID,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    })!))],
  ])('rejects a %s root authority capability without signaling', async (_name, authority) => {
    execFileSyncMock.mockReturnValue(census([
      { pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' },
      { pid: ROOT_PID, ppid: process.pid, pgid: ROOT_PID, command: 'provider-root' },
    ]));
    const target = {
      pid: ROOT_PID,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    };

    await expectTerminationCode(
      killSessionTreeRaw(target, 'SIGKILL', {
        generationMarker: 'forged-capability',
        rootAuthority: authority() as ProcessTreeRootAuthority,
        killGraceMs: 0,
      }),
      'PROCESS_TREE_ROOT_IDENTITY_UNVERIFIED',
    );
    expect(target.kill).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('resolves stale-row cleanup only from the exact spawn-time row and provider binding', () => {
    const target = {
      pid: ROOT_PID,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(() => true),
    };
    const authority = captureProcessTreeRootAuthority(target);

    expect(authority).not.toBeNull();
    expect(bindProcessTreeRootAuthority(authority!, 73, 'codex-cli')).toBe(true);
    expect(getRegisteredProcessTreeTerminationLease(73, ROOT_PID, 'codex-cli')).toEqual({
      target,
      rootAuthority: authority,
    });
    expect(getRegisteredProcessTreeTerminationLease(74, ROOT_PID, 'codex-cli')).toBeNull();
    expect(getRegisteredProcessTreeTerminationLease(73, CHILD_PID, 'codex-cli')).toBeNull();
    expect(getRegisteredProcessTreeTerminationLease(73, ROOT_PID, 'opencode-cli')).toBeNull();
  });

  it('rejects forged, copied, conflicting, and terminal durable-row bindings', () => {
    const firstTarget = {
      pid: ROOT_PID,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(() => true),
    };
    const secondTarget = {
      pid: CHILD_PID,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(() => true),
    };
    const first = captureProcessTreeRootAuthority(firstTarget)!;
    const second = captureProcessTreeRootAuthority(secondTarget)!;

    expect(bindProcessTreeRootAuthority({ ...first }, 81, 'claude-cli')).toBe(false);
    expect(bindProcessTreeRootAuthority(first, 81, 'claude-cli')).toBe(true);
    expect(bindProcessTreeRootAuthority(first, 82, 'claude-cli')).toBe(false);
    expect(bindProcessTreeRootAuthority(second, 81, 'claude-cli')).toBe(false);

    firstTarget.exitCode = 0;
    expect(getRegisteredProcessTreeTerminationLease(81, ROOT_PID, 'claude-cli')).toBeNull();
    expect(bindProcessTreeRootAuthority(first, 82, 'claude-cli')).toBe(false);
  });

  it('reclaims terminal durable-row bindings before rejecting registry capacity', () => {
    for (let offset = 0; offset < 4_096; offset += 1) {
      const target = {
        pid: 60_000 + offset,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        kill: vi.fn(() => true),
      };
      const authority = captureProcessTreeRootAuthority(target);
      expect(authority).not.toBeNull();
      expect(bindProcessTreeRootAuthority(authority!, 10_000 + offset, 'codex-cli')).toBe(true);
      target.exitCode = 0;
    }

    const replacement = {
      pid: 70_000,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(() => true),
    };
    const replacementAuthority = captureProcessTreeRootAuthority(replacement);
    expect(replacementAuthority).not.toBeNull();
    expect(bindProcessTreeRootAuthority(
      replacementAuthority!,
      20_000,
      'codex-cli',
    )).toBe(true);
  });

  it('does not reclaim a durable-row binding whose terminal state is unreadable', () => {
    let stateReadable = true;
    const firstTarget = {
      pid: ROOT_PID,
      get exitCode(): number | null {
        if (!stateReadable) throw new Error('private target state');
        return null;
      },
      get signalCode(): NodeJS.Signals | null {
        if (!stateReadable) throw new Error('private target state');
        return null;
      },
      kill: vi.fn(() => true),
    };
    const secondTarget = {
      pid: CHILD_PID,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(() => true),
    };
    const first = captureProcessTreeRootAuthority(firstTarget)!;
    const second = captureProcessTreeRootAuthority(secondTarget)!;
    expect(bindProcessTreeRootAuthority(first, 91, 'opencode-cli')).toBe(true);

    stateReadable = false;
    expect(bindProcessTreeRootAuthority(second, 91, 'opencode-cli')).toBe(false);
    expect(getRegisteredProcessTreeTerminationLease(91, ROOT_PID, 'opencode-cli')).toBeNull();
  });

  it('rejects a valid census with no root row without sending a signal', async () => {
    execFileSyncMock.mockReturnValue(census([
      { pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' },
    ]));

    await expect(killSessionTree(ROOT_PID, 'SIGKILL', {
      generationMarker: 'missing-root',
    })).rejects.toMatchObject({ code: 'PROCESS_TREE_ROOT_MISSING' });
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('does not treat an exited child handle as proof that its tree is empty', async () => {
    execFileSyncMock.mockReturnValue(census([
      { pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' },
      { pid: CHILD_PID, ppid: ROOT_PID, pgid: CHILD_PID, command: 'orphaned-child' },
    ]));
    const target = {
      pid: ROOT_PID,
      exitCode: 42,
      signalCode: null,
      kill: vi.fn(() => true),
    };

    await expect(killSessionTree(target, 'SIGTERM', {
      generationMarker: 'exited-root-unproven-tree',
    })).rejects.toMatchObject({ code: 'PROCESS_TREE_ROOT_IDENTITY_UNVERIFIED' });
    expect(target.kill).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('rejects a terminal child handle even when its PID has been reused by another tree', async () => {
    execFileSyncMock.mockReturnValue(rootRows());
    const target = {
      pid: ROOT_PID,
      exitCode: 0,
      signalCode: null,
      kill: vi.fn(() => false),
    };

    await expectTerminationCode(
      killSessionTree(target, 'SIGKILL', {
        generationMarker: 'terminal-handle-reused-pid',
      }),
      'PROCESS_TREE_ROOT_IDENTITY_UNVERIFIED',
    );

    expect(target.kill).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('rejects a different lease while the same root PID termination is active', async () => {
    execFileSyncMock.mockReturnValue(rootRows());
    const first = killSessionTree(ROOT_PID, 'SIGTERM', {
      generationMarker: 'lease-a',
      termGraceMs: 0,
      killGraceMs: 0,
    });

    await expect(killSessionTree(ROOT_PID, 'SIGKILL', {
      generationMarker: 'lease-b',
    })).rejects.toThrow('Refusing process-tree lease change');
    await expect(first).rejects.toMatchObject({ code: 'PROCESS_TREE_SURVIVORS_REMAIN' });
  });

  it('uses identity-checked per-PID signals when the self PGID row is missing', async () => {
    execFileSyncMock
      .mockReturnValueOnce(rootRows(false))
      .mockReturnValueOnce(rootRows(false))
      .mockReturnValueOnce(census([]));

    await killSessionTree(ROOT_PID, 'SIGKILL', {
      generationMarker: 'missing-self',
      killGraceMs: 0,
    });

    expect(killSpy).toHaveBeenCalledWith(CHILD_PID, 'SIGKILL');
    expect(killSpy).toHaveBeenCalledWith(ROOT_PID, 'SIGKILL');
    expect(killSpy.mock.calls.some((call: unknown[]) =>
      typeof call[0] === 'number' && call[0] < 0,
    )).toBe(false);
  });

  it('never emits an unverified SIGKILL when TERM recensus is unreadable', async () => {
    execFileSyncMock
      .mockReturnValueOnce(rootRows())
      .mockReturnValueOnce(rootRows())
      .mockImplementation(() => {
        throw new Error('ps unavailable');
      });

    await expect(killSessionTree(ROOT_PID, 'SIGTERM', {
      generationMarker: 'recensus-failure',
      termGraceMs: 0,
      killGraceMs: 0,
    })).rejects.toMatchObject({ code: 'PROCESS_TREE_ESCALATION_CENSUS_UNAVAILABLE' });

    expect(killSpy.mock.calls.some((call: unknown[]) => call[1] === 'SIGKILL')).toBe(false);
  });

  it('does not signal a reused root PID with a different birth identity', async () => {
    execFileSyncMock
      .mockReturnValueOnce(rootRows())
      .mockReturnValueOnce(census([
        { pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' },
        {
          pid: ROOT_PID,
          ppid: process.pid,
          pgid: ROOT_PID,
          start: 'Fri Jul 10 08:00:01 2026',
          command: 'unrelated-reused-root',
        },
      ]))
      .mockReturnValue(census([]));

    await killSessionTree(ROOT_PID, 'SIGKILL', {
      generationMarker: 'pid-reuse',
      killGraceMs: 0,
    });

    expect(killSpy).not.toHaveBeenCalled();
  });

  it('revalidates the frozen birth identity immediately before numeric signal delivery', async () => {
    const target = {
      pid: ROOT_PID,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    };
    let rootProbes = 0;
    birthTokenMock.mockImplementation((pid: number) => {
      if (pid !== ROOT_PID) return `birth:${pid}`;
      rootProbes += 1;
      return rootProbes >= 5 ? 'birth:replacement' : `birth:${pid}`;
    });
    execFileSyncMock.mockReturnValue(census([
      { pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' },
      { pid: ROOT_PID, ppid: process.pid, pgid: ROOT_PID, command: 'provider-root' },
    ]));

    await expect(killSessionTree(target, 'SIGKILL', {
      generationMarker: 'pre-signal-reuse',
      killGraceMs: 0,
    })).resolves.toMatchObject({ outcome: 'terminated', signaledProcessCount: 0 });

    expect(target.kill).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('does not adopt a foreign numeric root without pre-existing birth authority', async () => {
    const foreign = census([
      { pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' },
      { pid: ROOT_PID, ppid: 1, pgid: ROOT_PID, command: 'foreign-root' },
      { pid: CHILD_PID, ppid: ROOT_PID, pgid: ROOT_PID, command: 'foreign-child' },
    ]);
    execFileSyncMock.mockReturnValue(foreign);

    await expectTerminationCode(
      killSessionTreeRaw(ROOT_PID, 'SIGKILL', {
        generationMarker: 'foreign-root-without-authority',
      } as unknown as KillSessionTreeOptions),
      'PROCESS_TREE_ROOT_IDENTITY_UNVERIFIED',
    );

    expect(killSpy).not.toHaveBeenCalled();
  });

  it('discovers and accounts for descendants that appear before the signal census', async () => {
    const withLateChild = census([
      { pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' },
      { pid: ROOT_PID, ppid: process.pid, pgid: ROOT_PID, command: 'provider-root' },
      { pid: CHILD_PID, ppid: ROOT_PID, pgid: ROOT_PID, command: 'provider-child' },
      {
        pid: LATE_CHILD_PID,
        ppid: CHILD_PID,
        pgid: LATE_CHILD_PID,
        command: 'late-provider-child',
      },
    ]);
    execFileSyncMock
      .mockReturnValueOnce(rootRows())
      .mockReturnValueOnce(withLateChild)
      .mockReturnValue(census([
        { pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' },
      ]));

    const outcome = await killSessionTree(ROOT_PID, 'SIGKILL', {
      generationMarker: 'late-descendant-union',
      killGraceMs: 0,
    });

    expect(outcome).toMatchObject({
      outcome: 'terminated',
      ownedProcessCount: 3,
      signaledProcessCount: 3,
    });
    expect(killSpy).toHaveBeenCalledWith(LATE_CHILD_PID, 'SIGKILL');
  });

  it('continues discovery from a verified retained child after the root exits', async () => {
    const childAnchorWithLateDescendant = census([
      { pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' },
      { pid: CHILD_PID, ppid: 1, pgid: ROOT_PID, command: 'provider-child' },
      {
        pid: LATE_CHILD_PID,
        ppid: CHILD_PID,
        pgid: ROOT_PID,
        command: 'late-provider-grandchild',
      },
    ]);
    execFileSyncMock
      .mockReturnValueOnce(rootRows())
      .mockReturnValueOnce(childAnchorWithLateDescendant)
      .mockReturnValue(census([
        { pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' },
      ]));

    const outcome = await killSessionTree(ROOT_PID, 'SIGKILL', {
      generationMarker: 'retained-child-anchor',
      killGraceMs: 0,
    });

    expect(outcome).toMatchObject({
      outcome: 'terminated',
      ownedProcessCount: 3,
      signaledProcessCount: 2,
    });
    expect(killSpy).toHaveBeenCalledWith(LATE_CHILD_PID, 'SIGKILL');
    expect(killSpy).toHaveBeenCalledWith(CHILD_PID, 'SIGKILL');
    expect(killSpy).not.toHaveBeenCalledWith(ROOT_PID, 'SIGKILL');
  });

  it('fails closed when a late descendant reuses a retained PID with a new birth identity', async () => {
    let childProbes = 0;
    birthTokenMock.mockImplementation((pid: number) => {
      if (pid !== CHILD_PID) return `birth:${pid}`;
      childProbes += 1;
      return childProbes === 1 ? 'birth:original-child' : 'birth:replacement-child';
    });
    const replacementUnderRoot = census([
      { pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' },
      { pid: ROOT_PID, ppid: process.pid, pgid: ROOT_PID, command: 'provider-root' },
      { pid: CHILD_PID, ppid: ROOT_PID, pgid: ROOT_PID, command: 'replacement-child' },
    ]);
    execFileSyncMock
      .mockReturnValueOnce(rootRows())
      .mockReturnValue(replacementUnderRoot);

    await expectTerminationCode(killSessionTree(ROOT_PID, 'SIGKILL', {
      generationMarker: 'late-descendant-reused-pid',
      killGraceMs: 0,
    }), 'PROCESS_TREE_AMBIGUOUS_IDENTITY_UNRESOLVED');

    expect(killSpy).not.toHaveBeenCalled();
  });

  it('withholds numeric descendant signals when Darwin birth identity is weak', async () => {
    birthTokenMock.mockImplementation((pid: number) => `darwin-lstart:same-second:${pid}`);
    const target = {
      pid: ROOT_PID,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    };
    execFileSyncMock
      .mockReturnValueOnce(rootRows())
      .mockReturnValueOnce(rootRows())
      .mockReturnValue(census([
        { pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' },
      ]));

    await expect(killSessionTree(target, 'SIGKILL', {
      generationMarker: 'darwin-weak-descendant-identity',
      killGraceMs: 0,
    })).resolves.toMatchObject({
      outcome: 'terminated',
      signaledProcessCount: 1,
    });

    expect(target.kill).toHaveBeenCalledWith('SIGKILL');
    expect(killSpy).not.toHaveBeenCalledWith(CHILD_PID, 'SIGKILL');
  });

  it('never broadens spawn authority through a process-group broadcast', async () => {
    execFileSyncMock
      .mockReturnValueOnce(rootRows())
      .mockReturnValueOnce(rootRows())
      .mockReturnValue(census([]));

    await expect(killSessionTree(ROOT_PID, 'SIGKILL', {
      generationMarker: 'no-group-broadcast',
      killGraceMs: 0,
    })).resolves.toMatchObject({ outcome: 'terminated' });

    expect(killSpy.mock.calls.some((call: unknown[]) =>
      typeof call[0] === 'number' && (call[0] as number) < 0,
    )).toBe(false);
  });
});

async function expectTerminationCode(
  operation: Promise<unknown>,
  code: ProcessTreeTerminationErrorCode,
): Promise<ProcessTreeTerminationError> {
  const error = await operation.then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(ProcessTreeTerminationError);
  expect(error).toMatchObject({ code });
  return error as ProcessTreeTerminationError;
}

describe('process-tree termination error taxonomy', () => {
  it('classifies invalid generation and invalid target input', async () => {
    await expectTerminationCode(
      killSessionTree(ROOT_PID, 'SIGTERM', { generationMarker: '  ' }),
      'PROCESS_TREE_INVALID_GENERATION',
    );
    await expectTerminationCode(
      killSessionTree(1, 'SIGTERM', { generationMarker: 'invalid-target' }),
      'PROCESS_TREE_INVALID_TARGET',
    );
    await expectTerminationCode(
      killSessionTree(ROOT_PID, 'SIGTERM', {
        generationMarker: undefined as unknown as string,
      }),
      'PROCESS_TREE_INVALID_GENERATION',
    );
  });

  it('exports the canonical diagnostic-source vocabulary for guard reuse', () => {
    expect(PROCESS_TREE_DIAGNOSTIC_SOURCES).toEqual([
      'session_shutdown',
      'stale_session_sweep',
      'ownership_loss_cleanup',
    ]);
  });

  it('distinguishes an unavailable initial census from an unverified root identity', async () => {
    execFileSyncMock.mockImplementationOnce(() => {
      throw new Error('ps unavailable');
    });
    await expectTerminationCode(
      killSessionTree(ROOT_PID, 'SIGTERM', { generationMarker: 'initial-census' }),
      'PROCESS_TREE_INITIAL_CENSUS_UNAVAILABLE',
    );
    resetProcessTreeTerminationLeasesForTesting();

    execFileSyncMock.mockReturnValue(census([
      { pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' },
    ]));
    await expectTerminationCode(
      killSessionTree(ROOT_PID, 'SIGTERM', { generationMarker: 'root-unverified' }),
      'PROCESS_TREE_ROOT_MISSING',
    );
  });

  it('classifies pre-signal and escalation census failures separately', async () => {
    execFileSyncMock
      .mockReturnValueOnce(rootRows())
      .mockImplementationOnce(() => {
        throw new Error('pre-signal ps unavailable');
      });
    await expectTerminationCode(
      killSessionTree(ROOT_PID, 'SIGTERM', {
        generationMarker: 'pre-signal-census',
        termGraceMs: 0,
        killGraceMs: 0,
      }),
      'PROCESS_TREE_PRE_SIGNAL_CENSUS_UNAVAILABLE',
    );
    resetProcessTreeTerminationLeasesForTesting();

    execFileSyncMock
      .mockReturnValueOnce(rootRows())
      .mockReturnValueOnce(rootRows())
      .mockReturnValueOnce(rootRows())
      .mockImplementationOnce(() => {
        throw new Error('escalation ps unavailable');
      });
    await expectTerminationCode(
      killSessionTree(ROOT_PID, 'SIGTERM', {
        generationMarker: 'escalation-census',
        termGraceMs: 0,
        killGraceMs: 0,
      }),
      'PROCESS_TREE_ESCALATION_CENSUS_UNAVAILABLE',
    );
  });

  it('classifies final-census, signal, and surviving-process failures', async () => {
    execFileSyncMock
      .mockReturnValueOnce(rootRows())
      .mockReturnValueOnce(rootRows())
      .mockImplementation(() => {
        throw new Error('final ps unavailable');
      });
    const error = await expectTerminationCode(
      killSessionTree(ROOT_PID, 'SIGKILL', {
        generationMarker: 'final-census',
        killGraceMs: 0,
      }),
      'PROCESS_TREE_FINAL_CENSUS_UNAVAILABLE',
    );
    resetProcessTreeTerminationLeasesForTesting();

    execFileSyncMock.mockReset().mockReturnValue(rootRows());
    killSpy.mockImplementation(() => {
      const error = new Error('operation not permitted') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    });
    await expectTerminationCode(
      killSessionTree(ROOT_PID, 'SIGKILL', {
        generationMarker: 'signal-failure',
        killGraceMs: 0,
      }),
      'PROCESS_TREE_SIGNAL_PERMISSION_DENIED',
    );
    resetProcessTreeTerminationLeasesForTesting();

    killSpy.mockImplementation(() => true);
    execFileSyncMock.mockReset().mockReturnValue(rootRows());
    await expectTerminationCode(
      killSessionTree(ROOT_PID, 'SIGKILL', {
        generationMarker: 'survivors-remain',
        killGraceMs: 0,
      }),
      'PROCESS_TREE_SURVIVORS_REMAIN',
    );
  });

  it('classifies an active-generation lease conflict', async () => {
    execFileSyncMock.mockReturnValue(rootRows());
    const active = killSessionTree(ROOT_PID, 'SIGTERM', {
      generationMarker: 'lease-owner',
      termGraceMs: 0,
      killGraceMs: 0,
    });
    const activeResult = expect(active).rejects.toMatchObject({
      code: 'PROCESS_TREE_SURVIVORS_REMAIN',
    });
    await expectTerminationCode(
      killSessionTree(ROOT_PID, 'SIGKILL', { generationMarker: 'lease-contender' }),
      'PROCESS_TREE_LEASE_CONFLICT',
    );
    await activeResult;
  });

  it('emits source-tagged bounded success, cgroup, and failure diagnostics', async () => {
    const selfOnly = census([
      { pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' },
    ]);
    execFileSyncMock
      .mockReturnValueOnce(rootRows())
      .mockReturnValueOnce(rootRows())
      .mockReturnValue(selfOnly);

    await killSessionTree(ROOT_PID, 'SIGKILL', {
      generationMarker: 'diagnostic-success',
      diagnosticSource: 'stale_session_sweep',
      diagnosticSessionRowId: 42,
      killGraceMs: 0,
      readCgroupMemberPids: () => [process.pid, ROOT_PID, CHILD_PID],
    });

    expect(processTreeLog.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'stale_session_sweep',
        sessionRowId: 42,
        outcome: 'terminated',
        ambiguousProcessCount: 0,
      }),
      'process-tree termination outcome',
    );
    expect(processTreeLog.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'stale_session_sweep',
        sessionRowId: 42,
        cgroupMemberCount: 3,
        ownedCount: 2,
      }),
      'process-tree cgroup divergence',
    );

    await expectTerminationCode(
      killSessionTree(ROOT_PID, 'SIGTERM', {
        generationMarker: '',
        diagnosticSource: 'ownership_loss_cleanup',
      }),
      'PROCESS_TREE_INVALID_GENERATION',
    );
    expect(processTreeLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'ownership_loss_cleanup',
        errorCode: 'PROCESS_TREE_INVALID_GENERATION',
        retryClass: 'invalid_request',
      }),
      'process-tree termination failed',
    );
    const failureRecord = processTreeLog.warn.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(failureRecord).not.toHaveProperty('err');
    expect(JSON.stringify(failureRecord)).not.toContain('diagnostic-success');
  });

  it('rejects an invalid optional row identifier without emitting it', async () => {
    await expectTerminationCode(
      killSessionTree(ROOT_PID, 'SIGTERM', {
        generationMarker: 'valid-generation',
        diagnosticSource: 'session_shutdown',
        diagnosticSessionRowId: Number.NaN,
      }),
      'PROCESS_TREE_INVALID_OPTIONS',
    );
    expect(JSON.stringify(processTreeLog.warn.mock.calls)).not.toContain('sessionRowId');
  });
});

// #1755: kill-time ambiguity must resolve-or-record, never throw-and-abort (which
// burned the full grace per chat and drove SIGTERM-timeout SIGKILLs). The safety
// invariant is unchanged: an ambiguous PID is never signaled.
describe('#1755 kill-time ambiguity resolution', () => {
  // Two identical CHILD rows → inspectOwned marks CHILD_PID ambiguous; root absent.
  function ambiguousChild(): string {
    return census([
      { pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' },
      { pid: CHILD_PID, ppid: ROOT_PID, pgid: ROOT_PID, command: 'provider-child' },
      { pid: CHILD_PID, ppid: ROOT_PID, pgid: ROOT_PID, command: 'provider-child' },
    ]);
  }
  function selfOnly(): string {
    return census([{ pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' }]);
  }

  it('replays diagnostics to a same-generation caller that joins an active termination', async () => {
    execFileSyncMock
      .mockReturnValueOnce(rootRows())
      .mockReturnValueOnce(rootRows())
      .mockReturnValue(selfOnly());
    const firstOutcome = vi.fn();
    const secondOutcome = vi.fn();
    const firstDivergence = vi.fn();
    const secondDivergence = vi.fn();
    const baseOptions = {
      generationMarker: 'coalesced-generation',
      diagnosticSource: 'session_shutdown' as const,
      termGraceMs: 0,
      killGraceMs: 0,
      ambiguityResolveMs: 0,
      readCgroupMemberPids: () => [ROOT_PID, CHILD_PID],
    };
    const target = {
      pid: ROOT_PID,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    };
    const rootAuthority = captureProcessTreeRootAuthority(target)!;

    const first = killSessionTreeRaw(target, 'SIGTERM', {
      ...baseOptions,
      rootAuthority,
      onOutcome: firstOutcome,
      onCgroupDivergence: firstDivergence,
    });
    const second = killSessionTreeRaw(target, 'SIGTERM', {
      ...baseOptions,
      rootAuthority,
      onOutcome: secondOutcome,
      onCgroupDivergence: secondDivergence,
    });

    expect(second).toBe(first);
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ outcome: 'terminated' }),
      expect.objectContaining({ outcome: 'terminated' }),
    ]);
    expect(firstOutcome).toHaveBeenCalledTimes(1);
    expect(secondOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'terminated' }));
    expect(firstDivergence).toHaveBeenCalledTimes(1);
    expect(secondDivergence).toHaveBeenCalledWith({
      cgroupMemberCount: 2,
      ownedCount: 2,
      offTreeCount: 0,
    });
  });

  it('rejects same-generation coalescing from a different target authority', async () => {
    execFileSyncMock
      .mockReturnValueOnce(rootRows())
      .mockReturnValueOnce(rootRows())
      .mockReturnValue(selfOnly());
    const firstTarget = {
      pid: ROOT_PID,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    };
    const secondTarget = {
      pid: ROOT_PID,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    };
    const firstAuthority = captureProcessTreeRootAuthority(firstTarget)!;
    const secondAuthority = captureProcessTreeRootAuthority(secondTarget)!;
    const options = {
      generationMarker: 'same-marker-different-authority',
      termGraceMs: 0,
      killGraceMs: 0,
      ambiguityResolveMs: 0,
    };

    const first = killSessionTreeRaw(firstTarget, 'SIGTERM', {
      ...options,
      rootAuthority: firstAuthority,
    });
    await expectTerminationCode(
      killSessionTreeRaw(secondTarget, 'SIGTERM', {
        ...options,
        rootAuthority: secondAuthority,
      }),
      'PROCESS_TREE_LEASE_CONFLICT',
    );
    await expect(first).resolves.toMatchObject({ outcome: 'terminated' });
    expect(firstTarget.kill).toHaveBeenCalled();
    expect(secondTarget.kill).not.toHaveBeenCalled();
  });

  it('rejects same-generation coalescing from a different authority for the same target', async () => {
    execFileSyncMock
      .mockReturnValueOnce(rootRows())
      .mockReturnValueOnce(rootRows())
      .mockReturnValue(selfOnly());
    const target = {
      pid: ROOT_PID, exitCode: null, signalCode: null, kill: vi.fn(() => true),
    };
    const firstAuthority = captureProcessTreeRootAuthority(target)!;
    const secondAuthority = captureProcessTreeRootAuthority(target)!;
    const options = {
      generationMarker: 'same-target-different-authority', termGraceMs: 0,
      killGraceMs: 0, ambiguityResolveMs: 0,
    };

    const first = killSessionTreeRaw(target, 'SIGTERM', { ...options, rootAuthority: firstAuthority });
    await expectTerminationCode(
      killSessionTreeRaw(target, 'SIGTERM', { ...options, rootAuthority: secondAuthority }),
      'PROCESS_TREE_LEASE_CONFLICT',
    );
    await expect(first).resolves.toMatchObject({ outcome: 'terminated' });
  });

  it('soft-records a persistently-ambiguous survivor instead of throwing, and never SIGKILLs it', async () => {
    execFileSyncMock
      .mockReturnValueOnce(rootRows()) // entry snapshot: root + child owned
      .mockReturnValueOnce(rootRows()) // pre-signal: clean → SIGTERM both
      .mockReturnValue(ambiguousChild()); // TERM check + escalation re-census + final: child ambiguous

    const outcomes: KillSessionOutcome[] = [];
    const outcome = await killSessionTree(ROOT_PID, 'SIGTERM', {
      generationMarker: 'persistent-ambiguous',
      termGraceMs: 0,
      killGraceMs: 0,
      ambiguityResolveMs: 0,
      onOutcome: (observed) => outcomes.push(observed),
    });

    // Safety invariant: the ambiguous child is never escalated to SIGKILL.
    expect(killSpy.mock.calls.some((c: unknown[]) => c[0] === CHILD_PID && c[1] === 'SIGKILL')).toBe(false);
    expect(outcome).toMatchObject({
      outcome: 'unresolved_ambiguous',
      ambiguousProcessCount: 1,
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].outcome).toBe('unresolved_ambiguous');
    expect(outcomes[0].ambiguousProcessCount).toBe(1);
    expect(outcomes[0]).not.toHaveProperty('ambiguousPids');
  });

  it('reports outcome=terminated when the tree exits within the grace (no escalation)', async () => {
    execFileSyncMock
      .mockReturnValueOnce(rootRows()) // entry
      .mockReturnValueOnce(rootRows()) // pre-signal SIGTERM
      .mockReturnValue(selfOnly()); // TERM check + final: all gone

    const outcomes: KillSessionOutcome[] = [];
    const outcome = await killSessionTree(ROOT_PID, 'SIGTERM', {
      generationMarker: 'clean-terminate',
      termGraceMs: 0,
      killGraceMs: 0,
      ambiguityResolveMs: 0,
      onOutcome: (observed) => outcomes.push(observed),
    });

    expect(outcome.outcome).toBe('terminated');
    expect(outcomes[0].outcome).toBe('terminated');
    expect(outcomes[0]).not.toHaveProperty('escalated');
  });

  it('keeps termination successful but makes a throwing outcome sink visible', async () => {
    execFileSyncMock
      .mockReturnValueOnce(rootRows())
      .mockReturnValueOnce(rootRows())
      .mockReturnValue(selfOnly());
    const sinkError = new Error('outcome sink failed');

    const outcome = await killSessionTree(ROOT_PID, 'SIGTERM', {
      generationMarker: 'throwing-outcome-sink',
      diagnosticSource: 'session_shutdown',
      termGraceMs: 0,
      killGraceMs: 0,
      ambiguityResolveMs: 0,
      onOutcome: () => {
        throw sinkError;
      },
    });

    expect(outcome).toMatchObject({
      outcome: 'terminated',
      diagnosticState: 'inconclusive',
      diagnosticCodes: ['PROCESS_TREE_OUTCOME_OBSERVER_FAILED'],
    });
    expect(processTreeLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        diagnosticCode: 'PROCESS_TREE_OUTCOME_OBSERVER_FAILED',
        sink: 'outcome',
        source: 'session_shutdown',
      }),
      'process-tree telemetry sink failed',
    );
    expect(JSON.stringify(processTreeLog.warn.mock.calls)).not.toContain(sinkError.message);
  });

  it('reports outcome=escalated when a confirmed survivor is SIGKILLed', async () => {
    execFileSyncMock
      .mockReturnValueOnce(rootRows()) // entry
      .mockReturnValueOnce(rootRows()) // pre-signal SIGTERM
      .mockReturnValueOnce(rootRows()) // TERM check: still alive → survivors
      .mockReturnValueOnce(rootRows()) // escalation re-census: confirmed → SIGKILL
      .mockReturnValue(selfOnly()); // final: gone

    const outcomes: KillSessionOutcome[] = [];
    const outcome = await killSessionTree(ROOT_PID, 'SIGTERM', {
      generationMarker: 'escalate-confirmed',
      termGraceMs: 0,
      killGraceMs: 0,
      ambiguityResolveMs: 0,
      onOutcome: (observed) => outcomes.push(observed),
    });

    // Escalation is a process-group SIGKILL (negative pgid) when root leads its group.
    expect(killSpy.mock.calls.some((c: unknown[]) => c[1] === 'SIGKILL')).toBe(true);
    expect(outcome.outcome).toBe('escalated');
    expect(outcomes[0].outcome).toBe('escalated');
    expect(outcomes[0]).not.toHaveProperty('escalated');
  });

  it('suppresses the process-group broadcast when an ambiguous sibling shares the root group, never signaling it', async () => {
    // root leads its group; a duplicate-row (ambiguous) child shares root.pgid.
    const rootWithAmbiguousChild = census([
      { pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' },
      { pid: ROOT_PID, ppid: process.pid, pgid: ROOT_PID, command: 'provider-root' },
      { pid: CHILD_PID, ppid: ROOT_PID, pgid: ROOT_PID, command: 'provider-child' },
      { pid: CHILD_PID, ppid: ROOT_PID, pgid: ROOT_PID, command: 'provider-child' },
    ]);
    execFileSyncMock
      .mockReturnValueOnce(rootWithAmbiguousChild) // entry: owned = root + ambiguous child
      .mockReturnValueOnce(rootWithAmbiguousChild) // pre-signal: root survivor, child ambiguous
      .mockReturnValue(ambiguousChild()); // TERM check + final: root gone, child still ambiguous

    const outcome = await killSessionTree(ROOT_PID, 'SIGTERM', {
      generationMarker: 'ambiguous-sibling-in-group',
      termGraceMs: 0,
      killGraceMs: 0,
      ambiguityResolveMs: 0,
    });

    expect(outcome).toMatchObject({
      outcome: 'unresolved_ambiguous',
      ambiguousProcessCount: 1,
    });
    // No process-group broadcast (a negative pid) fires while a sibling is ambiguous:
    // that broadcast is indiscriminate and would reach the ambiguous child.
    expect(killSpy.mock.calls.some((c: unknown[]) => typeof c[0] === 'number' && (c[0] as number) < 0)).toBe(false);
    // The confirmed root survivor is signaled per-PID; the ambiguous child never is.
    expect(killSpy).toHaveBeenCalledWith(ROOT_PID, 'SIGTERM');
    expect(killSpy.mock.calls.some((c: unknown[]) => c[0] === CHILD_PID)).toBe(false);
  });
});

describe('retained process-tree retry leases', () => {
  function ambiguousChild(): string {
    return census([
      { pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' },
      { pid: CHILD_PID, ppid: ROOT_PID, pgid: ROOT_PID, command: 'provider-child' },
      { pid: CHILD_PID, ppid: ROOT_PID, pgid: ROOT_PID, command: 'provider-child' },
    ]);
  }

  function selfOnly(): string {
    return census([
      { pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' },
    ]);
  }

  async function retainAmbiguousLease(generationMarker: string): Promise<{
    target: ProcessTreeTarget;
    rootAuthority: ProcessTreeRootAuthority;
  }> {
    execFileSyncMock
      .mockReturnValueOnce(rootRows())
      .mockReturnValueOnce(rootRows())
      .mockReturnValue(ambiguousChild());
    const target: ProcessTreeTarget = {
      pid: ROOT_PID,
      exitCode: null,
      signalCode: null,
      kill: (signal) => process.kill(ROOT_PID, signal),
    };
    const rootAuthority = captureProcessTreeRootAuthority(target)!;
    await expect(killSessionTreeRaw(target, 'SIGKILL', {
      generationMarker,
      rootAuthority,
      killGraceMs: 0,
      ambiguityResolveMs: 0,
    })).resolves.toMatchObject({ outcome: 'unresolved_ambiguous' });
    return { target, rootAuthority };
  }

  async function fillPermissionDeniedLeases(firstPid: number, count = 64): Promise<void> {
    const denied = new Error('denied') as NodeJS.ErrnoException;
    denied.code = 'EPERM';
    killSpy.mockImplementation(() => {
      throw denied;
    });
    for (let offset = 0; offset < count; offset += 1) {
      const pid = firstPid + offset;
      execFileSyncMock.mockReset().mockReturnValue(census([
        { pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' },
        { pid, ppid: process.pid, pgid: pid, command: 'provider-root' },
      ]));
      await expectTerminationCode(
        killSessionTree(pid, 'SIGKILL', { generationMarker: `permission-capacity-${pid}`, killGraceMs: 0 }),
        'PROCESS_TREE_SIGNAL_PERMISSION_DENIED',
      );
    }
  }

  it('retries only from retained identities and releases the lease after proof of exit', async () => {
    await retainAmbiguousLease('retained-retry');
    execFileSyncMock.mockReset().mockReturnValue(selfOnly());

    await expect(retryKillSessionTree(ROOT_PID, 'retained-retry')).resolves.toMatchObject({
      outcome: 'terminated',
    });
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
    await expectTerminationCode(
      retryKillSessionTree(ROOT_PID, 'retained-retry'),
      'PROCESS_TREE_RETRY_LEASE_MISSING',
    );
  });

  it('requires the explicit retry entry point after an inconclusive settlement', async () => {
    const { target, rootAuthority } = await retainAmbiguousLease('retry-only');
    const censusCalls = execFileSyncMock.mock.calls.length;

    await expectTerminationCode(
      killSessionTreeRaw(target, 'SIGKILL', {
        generationMarker: 'retry-only',
        rootAuthority,
        killGraceMs: 0,
      }),
      'PROCESS_TREE_RETRY_LEASE_REQUIRED',
    );
    expect(execFileSyncMock).toHaveBeenCalledTimes(censusCalls);
  });

  it('rejects a retry with no retained lease before census', async () => {
    await expectTerminationCode(
      retryKillSessionTree(ROOT_PID, 'missing-retry'),
      'PROCESS_TREE_RETRY_LEASE_MISSING',
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('retains but never automatically retries a permission-denied lease', async () => {
    execFileSyncMock.mockReturnValue(rootRows());
    const denied = new Error('denied') as NodeJS.ErrnoException;
    denied.code = 'EPERM';
    killSpy.mockImplementation(() => {
      throw denied;
    });
    await expectTerminationCode(
      killSessionTree(ROOT_PID, 'SIGKILL', {
        generationMarker: 'permission-retained',
        killGraceMs: 0,
      }),
      'PROCESS_TREE_SIGNAL_PERMISSION_DENIED',
    );
    const censusCalls = execFileSyncMock.mock.calls.length;

    await expectTerminationCode(
      retryKillSessionTree(ROOT_PID, 'permission-retained'),
      'PROCESS_TREE_RETRY_NOT_ALLOWED',
    );
    expect(execFileSyncMock).toHaveBeenCalledTimes(censusCalls);
  });

  it('bounds a retained lease to five total attempts', async () => {
    await retainAmbiguousLease('attempt-bound');
    execFileSyncMock.mockReset().mockReturnValue(ambiguousChild());
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      await expect(retryKillSessionTree(ROOT_PID, 'attempt-bound')).resolves.toMatchObject({
        outcome: 'unresolved_ambiguous',
      });
    }
    const censusCalls = execFileSyncMock.mock.calls.length;
    await expectTerminationCode(
      retryKillSessionTree(ROOT_PID, 'attempt-bound'),
      'PROCESS_TREE_RETRY_ATTEMPTS_EXHAUSTED',
    );
    expect(execFileSyncMock).toHaveBeenCalledTimes(censusCalls);
  });

  it('keeps an expired lease fenced and fails before census', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    await retainAmbiguousLease('expired-retry');
    execFileSyncMock.mockClear();
    now.mockReturnValue(121_001);

    await expectTerminationCode(
      retryKillSessionTree(ROOT_PID, 'expired-retry'),
      'PROCESS_TREE_RETRY_LEASE_EXPIRED',
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
    now.mockRestore();
  });

  it('does not reclaim capacity from root absence while retained descendants are unproved', async () => {
    const firstRetainedPid = 52_000;
    const firstRetainedChildPid = 54_000;
    const denied = new Error('denied') as NodeJS.ErrnoException;
    denied.code = 'EPERM';
    killSpy.mockImplementation(() => {
      throw denied;
    });

    for (let offset = 0; offset < 64; offset += 1) {
      const pid = firstRetainedPid + offset;
      const childPid = firstRetainedChildPid + offset;
      execFileSyncMock.mockReset().mockReturnValue(census([
        { pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' },
        { pid, ppid: process.pid, pgid: pid, command: 'provider-root' },
        { pid: childPid, ppid: pid, pgid: pid, command: 'provider-child' },
      ]));
      await expectTerminationCode(
        killSessionTree(pid, 'SIGKILL', {
          generationMarker: `retained-capacity-${offset}`,
          killGraceMs: 0,
        }),
        'PROCESS_TREE_SIGNAL_PERMISSION_DENIED',
      );
    }

    const replacementPid = 53_000;
    execFileSyncMock.mockReset().mockReturnValue(census([
      { pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' },
      ...Array.from({ length: 64 }, (_, offset) => ({
        pid: firstRetainedChildPid + offset,
        ppid: firstRetainedPid + offset,
        pgid: firstRetainedPid + offset,
        command: 'provider-child',
      })),
    ]));
    await expectTerminationCode(killSessionTree(replacementPid, 'SIGKILL', {
      generationMarker: 'replacement-after-root-only-proof',
      killGraceMs: 0,
    }), 'PROCESS_TREE_LEASE_CAPACITY');
  });

  it('reclaims retained lease capacity only after every frozen identity is proven gone', async () => {
    const firstRetainedPid = 56_000;
    const firstRetainedChildPid = 58_000;
    const denied = new Error('denied') as NodeJS.ErrnoException;
    denied.code = 'EPERM';
    killSpy.mockImplementation(() => {
      throw denied;
    });

    for (let offset = 0; offset < 64; offset += 1) {
      const pid = firstRetainedPid + offset;
      const childPid = firstRetainedChildPid + offset;
      execFileSyncMock.mockReset().mockReturnValue(census([
        { pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' },
        { pid, ppid: process.pid, pgid: pid, command: 'provider-root' },
        { pid: childPid, ppid: pid, pgid: pid, command: 'provider-child' },
      ]));
      await expectTerminationCode(
        killSessionTree(pid, 'SIGKILL', {
          generationMarker: `reclaimable-capacity-${offset}`,
          killGraceMs: 0,
        }),
        'PROCESS_TREE_SIGNAL_PERMISSION_DENIED',
      );
    }

    const replacementPid = 60_000;
    const replacementRows = census([
      { pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' },
      { pid: replacementPid, ppid: process.pid, pgid: replacementPid, command: 'provider-root' },
    ]);
    const selfRows = census([
      { pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' },
    ]);
    killSpy.mockImplementation(() => true);
    execFileSyncMock.mockReset()
      .mockReturnValueOnce(selfRows)
      .mockReturnValueOnce(replacementRows)
      .mockReturnValueOnce(replacementRows)
      .mockReturnValue(selfRows);

    await expect(killSessionTree(replacementPid, 'SIGKILL', {
      generationMarker: 'replacement-after-complete-proof',
      killGraceMs: 0,
    })).resolves.toMatchObject({
      outcome: 'terminated',
      ownedProcessCount: 1,
    });
    const emptyIdentityBatches = birthTokenBatchMock.mock.calls.filter(
      ([pids]) => pids.length === 0,
    );
    expect(emptyIdentityBatches.length).toBeLessThanOrEqual(2);
  });

  it('reclaims capacity from failed initializations only after their roots are proven absent', async () => {
    for (let offset = 0; offset < 64; offset += 1) {
      execFileSyncMock.mockReset().mockReturnValue(selfOnly());
      await expectTerminationCode(
        killSessionTree(62_000 + offset, 'SIGKILL', { generationMarker: `empty-capacity-${offset}`, killGraceMs: 0 }),
        'PROCESS_TREE_ROOT_MISSING',
      );
    }
    execFileSyncMock.mockReset().mockReturnValue(selfOnly());
    await expectTerminationCode(
      killSessionTree(63_000, 'SIGKILL', { generationMarker: 'replacement-after-empty-proof', killGraceMs: 0 }),
      'PROCESS_TREE_ROOT_MISSING',
    );
  });

  it('reclaims failed initializations after proving every root is a different incarnation', async () => {
    const firstPid = 63_100;
    for (let offset = 0; offset < 64; offset += 1) {
      execFileSyncMock.mockReset().mockReturnValue(selfOnly());
      await expectTerminationCode(
        killSessionTree(firstPid + offset, 'SIGKILL', { generationMarker: `empty-incarnation-${offset}`, killGraceMs: 0 }),
        'PROCESS_TREE_ROOT_MISSING',
      );
    }
    execFileSyncMock.mockReset().mockReturnValueOnce(census([
      { pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' },
      ...Array.from({ length: 64 }, (_, offset) => ({
        pid: firstPid + offset, ppid: process.pid,
        pgid: firstPid + offset, command: 'replacement-root',
      })),
    ])).mockReturnValue(selfOnly());
    birthTokenBatchMock.mockImplementationOnce((pids: readonly number[]) => new Map(
      pids.map((pid) => [pid, `replacement-birth:${pid}`]),
    ));
    await expectTerminationCode(
      killSessionTree(63_900, 'SIGKILL', { generationMarker: 'replacement-after-incarnation-proof', killGraceMs: 0 }),
      'PROCESS_TREE_ROOT_MISSING',
    );
  });

  it('reclaims absent leases even when another retained identity cannot be birth-checked', async () => {
    const firstPid = 64_000;
    await fillPermissionDeniedLeases(firstPid);
    const signalsBeforeReclamation = killSpy.mock.calls.length;
    execFileSyncMock.mockReset().mockReturnValueOnce(census([
      { pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' },
      { pid: firstPid, ppid: process.pid, pgid: firstPid, command: 'provider-root' },
    ])).mockReturnValue(selfOnly());
    birthTokenBatchMock.mockImplementationOnce(() => null as never);
    await expectTerminationCode(
      killSessionTree(65_000, 'SIGKILL', { generationMarker: 'replacement-with-unrelated-unverifiable-birth', killGraceMs: 0 }),
      'PROCESS_TREE_ROOT_MISSING',
    );
    expect(killSpy).toHaveBeenCalledTimes(signalsBeforeReclamation);
    await expectTerminationCode(
      retryKillSessionTree(firstPid, `permission-capacity-${firstPid}`),
      'PROCESS_TREE_RETRY_NOT_ALLOWED',
    );
  });

  it.each([
    {
      name: 'census loss',
      prepare: (firstPid: number) => {
        const unavailable = new Error('unavailable') as NodeJS.ErrnoException;
        unavailable.code = 'EACCES';
        execFileSyncMock.mockReset().mockImplementation(() => { throw unavailable; });
      },
    },
    {
      name: 'duplicate census rows',
      prepare: (firstPid: number) => {
        execFileSyncMock.mockReset().mockReturnValue(census([
          { pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' },
          ...Array.from({ length: 64 }, (_, offset) => [
            { pid: firstPid + offset, ppid: process.pid, pgid: firstPid + offset, command: 'provider-root' },
            { pid: firstPid + offset, ppid: process.pid, pgid: firstPid + offset, command: 'provider-root' },
          ]).flat(),
        ]));
      },
    },
    {
      name: 'birth observation loss',
      prepare: (firstPid: number) => {
        execFileSyncMock.mockReset().mockReturnValue(census([
          { pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' },
          ...Array.from({ length: 64 }, (_, offset) => ({
            pid: firstPid + offset, ppid: process.pid,
            pgid: firstPid + offset, command: 'provider-root',
          })),
        ]));
        birthTokenBatchMock.mockImplementationOnce(() => null as never);
      },
    },
  ])('preserves retained capacity through $name', async ({ prepare }) => {
    const firstPid = 66_000;
    await fillPermissionDeniedLeases(firstPid);
    const signalsBeforeReclamation = killSpy.mock.calls.length;
    prepare(firstPid);
    await expectTerminationCode(
      killSessionTree(67_000, 'SIGKILL', { generationMarker: 'blocked-capacity-replacement', killGraceMs: 0 }),
      'PROCESS_TREE_LEASE_CAPACITY',
    );
    expect(killSpy).toHaveBeenCalledTimes(signalsBeforeReclamation);
  });

  it('never reclaims an active lease while reclaiming inactive capacity', async () => {
    const firstPid = 68_000;
    await fillPermissionDeniedLeases(firstPid, 63);
    killSpy.mockImplementation(() => true);
    const activePid = 69_000;
    const activeRows = census([
      { pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' },
      { pid: activePid, ppid: process.pid, pgid: activePid, command: 'provider-root' },
    ]);
    execFileSyncMock.mockReset().mockReturnValue(activeRows);
    const target: ProcessTreeTarget = {
      pid: activePid, exitCode: null, signalCode: null,
      kill: (signal) => process.kill(activePid, signal),
    };
    const rootAuthority = captureProcessTreeRootAuthority(target)!;
    const options = {
      generationMarker: 'active-capacity-fence', rootAuthority,
      killGraceMs: 0, ambiguityResolveMs: 0,
    };
    const active = killSessionTreeRaw(target, 'SIGKILL', options);
    execFileSyncMock.mockReset().mockReturnValue(selfOnly());
    const replacement = killSessionTree(70_000, 'SIGKILL', {
      generationMarker: 'replacement-beside-active', killGraceMs: 0,
    });
    const joined = killSessionTreeRaw(target, 'SIGKILL', options);
    expect(joined).toBe(active);
    await expectTerminationCode(replacement, 'PROCESS_TREE_ROOT_MISSING');
    await expect(active).resolves.toMatchObject({ outcome: 'terminated' });
  });

  it('keeps the old generation fenced when only the root PID incarnation changes', async () => {
    await retainAmbiguousLease('old-incarnation');
    birthTokenMock.mockImplementation((pid: number) => `new-birth:${pid}`);
    execFileSyncMock.mockReset()
      .mockReturnValueOnce(rootRows())
      .mockReturnValueOnce(rootRows())
      .mockReturnValue(selfOnly());

    await expectTerminationCode(killSessionTree(ROOT_PID, 'SIGKILL', {
      generationMarker: 'new-incarnation-with-unproved-descendants',
      killGraceMs: 0,
    }), 'PROCESS_TREE_LEASE_CONFLICT');
  });

  it('rejects one identity over the bounded tree ceiling without signaling', async () => {
    const rows = [
      { pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' },
      { pid: ROOT_PID, ppid: process.pid, pgid: ROOT_PID, command: 'provider-root' },
      ...Array.from({ length: 4_096 }, (_, index) => ({
        pid: 60_000 + index,
        ppid: ROOT_PID,
        pgid: ROOT_PID,
        command: `provider-child-${index}`,
      })),
    ];
    execFileSyncMock.mockReturnValue(census(rows));

    await expectTerminationCode(
      killSessionTree(ROOT_PID, 'SIGKILL', {
        generationMarker: 'identity-over-limit',
      }),
      'PROCESS_TREE_IDENTITY_LIMIT',
    );
    expect(killSpy).not.toHaveBeenCalled();
  });
});

describe('typed process-tree outcome contract', () => {
  function selfOnly(): string {
    return census([
      { pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' },
    ]);
  }

  it('returns bounded state and counts without exporting correlation or PID data', async () => {
    execFileSyncMock
      .mockReturnValueOnce(rootRows())
      .mockReturnValueOnce(rootRows())
      .mockReturnValue(selfOnly());
    const observer = vi.fn();

    const outcome = await killSessionTree(ROOT_PID, 'SIGKILL', {
      generationMarker: 'private-generation-marker',
      killGraceMs: 0,
      onOutcome: observer,
    });

    expect(outcome).toMatchObject({
      outcome: 'terminated',
      ownedProcessCount: 2,
      signaledProcessCount: 2,
      ambiguousProcessCount: 0,
      diagnosticState: 'complete',
      diagnosticCodes: [],
    });
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
    expect(outcome.durationMs).toBeLessThanOrEqual(60_000);
    expect(outcome).not.toHaveProperty('generationMarker');
    expect(outcome).not.toHaveProperty('ambiguousPids');
    expect(JSON.stringify(outcome)).not.toContain('private-generation-marker');
    expect(observer).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'terminated',
      ambiguousProcessCount: 0,
    }));
  });

  it('rejects non-object options and malformed process targets before census or signal', async () => {
    await expectTerminationCode(
      Promise.resolve().then(() => killSessionTree(
        ROOT_PID,
        'SIGTERM',
        undefined as unknown as Parameters<typeof killSessionTree>[2],
      )),
      'PROCESS_TREE_INVALID_OPTIONS',
    );
    await expectTerminationCode(
      killSessionTree(
        { pid: ROOT_PID } as unknown as Parameters<typeof killSessionTree>[0],
        'SIGTERM',
        { generationMarker: 'invalid-target-object' },
      ),
      'PROCESS_TREE_INVALID_TARGET',
    );

    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['termGraceMs', -1],
    ['termGraceMs', 60_001],
    ['termGraceMs', Number.NaN],
    ['termGraceMs', Number.POSITIVE_INFINITY],
    ['termGraceMs', 1.5],
    ['killGraceMs', -1],
    ['killGraceMs', 60_001],
    ['killGraceMs', Number.NaN],
    ['killGraceMs', Number.POSITIVE_INFINITY],
    ['killGraceMs', 1.5],
    ['ambiguityResolveMs', -1],
    ['ambiguityResolveMs', 60_001],
    ['ambiguityResolveMs', Number.NaN],
    ['ambiguityResolveMs', Number.POSITIVE_INFINITY],
    ['ambiguityResolveMs', 1.5],
  ] as const)('rejects %s=%s outside the finite integer 0..60000 contract', async (field, value) => {
    await expectTerminationCode(
      killSessionTree(ROOT_PID, 'SIGKILL', {
        generationMarker: 'invalid-duration',
        [field]: value,
      }),
      'PROCESS_TREE_INVALID_DURATION',
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it.each([0, 60_000])('accepts duration boundary %s', async (duration) => {
    execFileSyncMock
      .mockReturnValueOnce(rootRows())
      .mockReturnValueOnce(rootRows())
      .mockReturnValue(selfOnly());

    await expect(killSessionTree(ROOT_PID, 'SIGKILL', {
      generationMarker: `valid-duration-${duration}`,
      termGraceMs: duration,
      killGraceMs: duration,
      ambiguityResolveMs: duration,
    })).resolves.toMatchObject({ outcome: 'terminated' });
  });

  it('captures option and target accessors once before acting', async () => {
    execFileSyncMock
      .mockReturnValueOnce(rootRows(false))
      .mockReturnValueOnce(rootRows(false))
      .mockReturnValue(selfOnly());
    const targetKill = vi.fn(() => true);
    const reads = { generation: 0, pid: 0, kill: 0 };
    const target = Object.defineProperties({}, {
      pid: {
        get: () => {
          reads.pid += 1;
          return ROOT_PID;
        },
      },
      kill: {
        get: () => {
          reads.kill += 1;
          return targetKill;
        },
      },
    }) as Parameters<typeof killSessionTree>[0];
    const options = Object.defineProperty({}, 'generationMarker', {
      get: () => {
        reads.generation += 1;
        return 'single-read-input';
      },
    }) as Parameters<typeof killSessionTree>[2];

    await expect(killSessionTree(target, 'SIGKILL', options)).resolves.toMatchObject({
      outcome: 'terminated',
    });
    expect(reads).toEqual({ generation: 1, pid: 1, kill: 1 });
    expect(targetKill).toHaveBeenCalledWith('SIGKILL');
  });

  it('distinguishes a missing root from a duplicate root', async () => {
    execFileSyncMock.mockReturnValueOnce(census([
      { pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' },
    ]));
    await expectTerminationCode(
      killSessionTree(ROOT_PID, 'SIGKILL', { generationMarker: 'missing-root-code' }),
      'PROCESS_TREE_ROOT_MISSING',
    );
    resetProcessTreeTerminationLeasesForTesting();

    execFileSyncMock.mockReturnValueOnce(census([
      { pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' },
      { pid: ROOT_PID, ppid: process.pid, pgid: ROOT_PID, command: 'provider-root' },
      { pid: ROOT_PID, ppid: process.pid, pgid: ROOT_PID, command: 'provider-root' },
    ]));
    await expectTerminationCode(
      killSessionTree(ROOT_PID, 'SIGKILL', { generationMarker: 'duplicate-root-code' }),
      'PROCESS_TREE_ROOT_AMBIGUOUS',
    );
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('distinguishes malformed and permission-denied census failures', async () => {
    execFileSyncMock.mockReturnValueOnce([
      'PID PPID PGID STARTED COMMAND',
      'this is not a process census row',
    ].join('\n'));
    await expectTerminationCode(
      killSessionTree(ROOT_PID, 'SIGKILL', { generationMarker: 'malformed-census' }),
      'PROCESS_TREE_CENSUS_MALFORMED',
    );
    resetProcessTreeTerminationLeasesForTesting();

    const denied = new Error('private operating-system detail') as NodeJS.ErrnoException;
    denied.code = 'EACCES';
    execFileSyncMock.mockImplementationOnce(() => {
      throw denied;
    });
    const error = await expectTerminationCode(
      killSessionTree(ROOT_PID, 'SIGKILL', { generationMarker: 'permission-census' }),
      'PROCESS_TREE_CENSUS_PERMISSION_DENIED',
    );
    expect(error.retryClass).toBe('permission_denied');
    expect(error.message).not.toContain('private operating-system detail');
    expect(killSpy).not.toHaveBeenCalled();
  });

  it.each([
    '',
    'not a process census header\n',
    `PID PPID PGID STARTED COMMAND\n2 0 -1 ${START} invalid-negative-group`,
  ])('classifies a structurally invalid census as malformed', async (output) => {
    execFileSyncMock.mockReturnValueOnce(output);
    await expectTerminationCode(
      killSessionTree(ROOT_PID, 'SIGKILL', { generationMarker: 'invalid-census-shape' }),
      'PROCESS_TREE_CENSUS_MALFORMED',
    );
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('classifies EPERM signaling as non-retryable permission denial', async () => {
    execFileSyncMock
      .mockReturnValueOnce(rootRows(false))
      .mockReturnValueOnce(rootRows(false));
    const denied = new Error('operation not permitted') as NodeJS.ErrnoException;
    denied.code = 'EPERM';
    killSpy.mockImplementation(() => {
      throw denied;
    });

    const error = await expectTerminationCode(
      killSessionTree(ROOT_PID, 'SIGKILL', {
        generationMarker: 'signal-permission',
        killGraceMs: 0,
      }),
      'PROCESS_TREE_SIGNAL_PERMISSION_DENIED',
    );
    expect(error.retryClass).toBe('permission_denied');
  });

  it('does not treat a false child-process kill result as successful delivery', async () => {
    execFileSyncMock
      .mockReturnValueOnce(rootRows(false))
      .mockReturnValueOnce(rootRows(false))
      .mockReturnValue(rootRows(false));
    const target = {
      pid: ROOT_PID,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => false),
    };

    await expectTerminationCode(
      killSessionTree(target, 'SIGKILL', {
        generationMarker: 'false-child-kill',
        killGraceMs: 0,
      }),
      'PROCESS_TREE_SIGNAL_FAILED',
    );
    expect(target.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('rejects a non-boolean child-process kill result at the runtime boundary', async () => {
    execFileSyncMock
      .mockReturnValueOnce(rootRows(false))
      .mockReturnValueOnce(rootRows(false));
    const target = {
      pid: ROOT_PID,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => 'delivered' as unknown as boolean),
    };

    await expectTerminationCode(
      killSessionTree(target, 'SIGKILL', {
        generationMarker: 'non-boolean-child-kill',
        killGraceMs: 0,
      }),
      'PROCESS_TREE_SIGNAL_FAILED',
    );
  });

  it('omits an unbounded system error code from public failure diagnostics', async () => {
    execFileSyncMock
      .mockReturnValueOnce(rootRows(false))
      .mockReturnValueOnce(rootRows(false));
    const privateCanary = 'PRIVATE/path: operator-only detail';
    const failed = new Error('private signal failure') as NodeJS.ErrnoException;
    failed.code = privateCanary;
    killSpy.mockImplementation(() => {
      throw failed;
    });

    const error = await expectTerminationCode(
      killSessionTree(ROOT_PID, 'SIGKILL', {
        generationMarker: 'bounded-system-code',
        diagnosticSource: 'session_shutdown',
        killGraceMs: 0,
      }),
      'PROCESS_TREE_SIGNAL_FAILED',
    );

    const failureRecord = processTreeLog.warn.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(error).not.toHaveProperty('cause');
    expect(error).not.toHaveProperty('systemCode');
    expect(JSON.stringify(error)).not.toContain(privateCanary);
    expect(failureRecord).not.toHaveProperty('causeCode');
    expect(failureRecord).not.toHaveProperty('systemCode');
    expect(JSON.stringify(failureRecord)).not.toContain(privateCanary);
  });

  it('retains only an allowlisted-shape system code in typed diagnostics', async () => {
    execFileSyncMock
      .mockReturnValueOnce(rootRows(false))
      .mockReturnValueOnce(rootRows(false));
    const failed = new Error('private signal failure') as NodeJS.ErrnoException;
    failed.code = 'EIO';
    killSpy.mockImplementation(() => {
      throw failed;
    });

    const error = await expectTerminationCode(
      killSessionTree(ROOT_PID, 'SIGKILL', {
        generationMarker: 'bounded-valid-system-code',
        diagnosticSource: 'session_shutdown',
        killGraceMs: 0,
      }),
      'PROCESS_TREE_SIGNAL_FAILED',
    );

    expect(error).toMatchObject({ systemCode: 'EIO' });
    expect(error).not.toHaveProperty('cause');
    expect(processTreeLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ systemCode: 'EIO' }),
      'process-tree termination failed',
    );
    expect(JSON.stringify(processTreeLog.warn.mock.calls)).not.toContain('private signal failure');
  });

  it('keeps a throwing system-code getter from replacing the typed termination error', async () => {
    execFileSyncMock
      .mockReturnValueOnce(rootRows(false))
      .mockReturnValueOnce(rootRows(false));
    const privateCanary = 'THROWING_CODE_GETTER_CANARY';
    const failed = Object.defineProperty(new Error('private signal failure'), 'code', {
      get: () => {
        throw new Error(privateCanary);
      },
    });
    killSpy.mockImplementation(() => {
      throw failed;
    });

    const error = await expectTerminationCode(
      killSessionTree(ROOT_PID, 'SIGKILL', {
        generationMarker: 'throwing-system-code-getter',
        diagnosticSource: 'session_shutdown',
        killGraceMs: 0,
      }),
      'PROCESS_TREE_SIGNAL_FAILED',
    );

    expect(error.message).not.toContain(privateCanary);
    expect(JSON.stringify(processTreeLog.warn.mock.calls)).not.toContain(privateCanary);
  });

  it('does not accept ESRCH as gone while the same process identity remains', async () => {
    execFileSyncMock
      .mockReturnValueOnce(rootRows(false))
      .mockReturnValueOnce(rootRows(false))
      .mockReturnValue(rootRows(false));
    const missing = new Error('no such process') as NodeJS.ErrnoException;
    missing.code = 'ESRCH';
    killSpy.mockImplementation(() => {
      throw missing;
    });

    await expectTerminationCode(
      killSessionTree(ROOT_PID, 'SIGKILL', {
        generationMarker: 'esrch-recheck',
        killGraceMs: 0,
      }),
      'PROCESS_TREE_SIGNAL_FAILED',
    );
  });

  it('accepts ESRCH only after recensus proves the owned identity is gone', async () => {
    const selfOnlyCensus = census([
      { pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' },
    ]);
    execFileSyncMock
      .mockReturnValueOnce(rootRows(false))
      .mockReturnValueOnce(rootRows(false))
      .mockReturnValue(selfOnlyCensus);
    const missing = new Error('no such process') as NodeJS.ErrnoException;
    missing.code = 'ESRCH';
    killSpy.mockImplementation(() => {
      throw missing;
    });

    await expect(killSessionTree(ROOT_PID, 'SIGKILL', {
      generationMarker: 'esrch-proved-gone',
      killGraceMs: 0,
    })).resolves.toMatchObject({
      outcome: 'terminated',
      signaledProcessCount: 0,
    });
  });

  it('keeps logger and outcome-observer failures from changing success', async () => {
    execFileSyncMock
      .mockReturnValueOnce(rootRows())
      .mockReturnValueOnce(rootRows())
      .mockReturnValue(selfOnly());
    processTreeLog.debug.mockImplementationOnce(() => {
      throw new Error('logger failed');
    });

    const outcome = await killSessionTree(ROOT_PID, 'SIGKILL', {
      generationMarker: 'isolated-diagnostics',
      diagnosticSource: 'session_shutdown',
      killGraceMs: 0,
      onOutcome: () => {
        throw new Error('observer failed');
      },
    });

    expect(outcome.outcome).toBe('terminated');
    expect(outcome.diagnosticState).toBe('inconclusive');
    expect(outcome.diagnosticCodes).toEqual(expect.arrayContaining([
      'PROCESS_TREE_DIAGNOSTIC_LOG_FAILED',
      'PROCESS_TREE_OUTCOME_OBSERVER_FAILED',
    ]));
  });

  it('assimilates an async outcome-observer rejection without changing termination', async () => {
    execFileSyncMock
      .mockReturnValueOnce(rootRows())
      .mockReturnValueOnce(rootRows())
      .mockReturnValue(census([
        { pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' },
      ]));
    let rejectObserver: (error: Error) => void = () => undefined;
    const observerResult = new Promise<void>((_resolve, reject) => {
      rejectObserver = reject;
    });
    void observerResult.catch(() => undefined);

    const outcome = await killSessionTree(ROOT_PID, 'SIGKILL', {
      generationMarker: 'async-observer-isolation',
      diagnosticSource: 'session_shutdown',
      killGraceMs: 0,
      onOutcome: () => observerResult as unknown as void,
    });
    rejectObserver(new Error('private async observer failure'));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(outcome.outcome).toBe('terminated');
    expect(processTreeLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        diagnosticCode: 'PROCESS_TREE_OUTCOME_OBSERVER_FAILED',
        sink: 'outcome',
      }),
      'process-tree telemetry sink failed',
    );
  });

  it('keeps a failure logger exception from replacing the termination error', async () => {
    processTreeLog.warn.mockImplementationOnce(() => {
      throw new Error('private logger failure');
    });

    const error = await expectTerminationCode(
      killSessionTree(ROOT_PID, 'SIGTERM', {
        generationMarker: '',
        diagnosticSource: 'ownership_loss_cleanup',
      }),
      'PROCESS_TREE_INVALID_GENERATION',
    );

    expect(error.diagnosticCodes).toContain('PROCESS_TREE_DIAGNOSTIC_LOG_FAILED');
    expect(error.message).not.toContain('private logger failure');
  });

  it('surfaces a cgroup diagnostic logger failure without blocking the gauge', async () => {
    const sink = vi.fn();
    processTreeLog.debug.mockImplementationOnce(() => {
      throw new Error('private logger failure');
    });

    const observation = await emitCgroupDivergence([{ pid: 101 }], 100, {
      generationMarker: 'cgroup-logger-isolation',
      diagnosticSource: 'session_shutdown',
      onCgroupDivergence: sink,
      readCgroupMemberPids: () => [100, 101],
    });

    expect(observation).toMatchObject({
      state: 'complete',
      diagnosticCodes: ['PROCESS_TREE_DIAGNOSTIC_LOG_FAILED'],
    });
    expect(sink).toHaveBeenCalledWith({
      cgroupMemberCount: 2,
      ownedCount: 1,
      offTreeCount: 0,
    });
  });

  it('assimilates an async cgroup-observer rejection without changing the observation', async () => {
    let rejectObserver: (error: Error) => void = () => undefined;
    const observerResult = new Promise<void>((_resolve, reject) => {
      rejectObserver = reject;
    });
    void observerResult.catch(() => undefined);

    const observation = await emitCgroupDivergence([{ pid: 101 }], 100, {
      generationMarker: 'async-cgroup-observer-isolation',
      diagnosticSource: 'session_shutdown',
      onCgroupDivergence: () => observerResult as unknown as void,
      readCgroupMemberPids: () => [100, 101],
    });
    rejectObserver(new Error('private async cgroup observer failure'));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(observation.state).toBe('complete');
    expect(processTreeLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        diagnosticCode: 'PROCESS_TREE_CGROUP_OBSERVER_FAILED',
        sink: 'cgroup_divergence',
      }),
      'process-tree telemetry sink failed',
    );
  });
});
