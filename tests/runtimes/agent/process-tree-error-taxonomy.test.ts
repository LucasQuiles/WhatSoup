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
  captureProcessTreeRootAuthority,
  killSessionTree as killSessionTreeRaw,
  resetProcessTreeTerminationLeasesForTesting,
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
