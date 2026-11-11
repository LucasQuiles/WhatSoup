import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hoistedLoggerMock, type SingletonLoggerMock } from '../../helpers/logger-mock.ts';

const { birthTokenMock, birthTokenBatchMock, execFileSyncMock, processTreeLog } = vi.hoisted(() => ({
  birthTokenMock: vi.fn((pid: number) => `birth:${pid}`),
  birthTokenBatchMock: vi.fn((pids: readonly number[]) => new Map(
    pids.map((pid) => [pid, `birth:${pid}`]),
  )),
  execFileSyncMock: vi.fn(),
  processTreeLog: {} as SingletonLoggerMock,
}));
hoistedLoggerMock(processTreeLog);

vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
}));

vi.mock('../../../src/lib/process-identity.ts', () => ({
  processBirthTokenSupportsNumericSignal: () => true,
  probeProcessBirthToken: birthTokenMock,
  probeProcessBirthTokens: birthTokenBatchMock,
}));

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => processTreeLog,
}));

import {
  captureProcessTreeRootAuthority,
  killSessionTree,
  resetProcessTreeTerminationLeasesForTesting,
} from '../../../src/runtimes/agent/process-tree.ts';

const ROOT_PID = 51_001;
const CHILD_PID = 51_002;
const START = 'Fri Jul 10 08:00:00 2026';

function census(
  rows: Array<{ pid: number; ppid: number; pgid: number; command: string }>,
): string {
  return [
    'PID PPID PGID STARTED COMMAND',
    ...rows.map((row) => `${row.pid} ${row.ppid} ${row.pgid} ${START} ${row.command}`),
  ].join('\n');
}

let killSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  birthTokenMock.mockReset().mockImplementation((pid: number) => `birth:${pid}`);
  birthTokenBatchMock.mockReset().mockImplementation((pids: readonly number[]) => new Map(
    pids.map((pid) => [pid, `birth:${pid}`]),
  ));
  execFileSyncMock.mockReset();
  for (const sink of Object.values(processTreeLog)) sink.mockClear();
  killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
});

afterEach(() => {
  resetProcessTreeTerminationLeasesForTesting();
  killSpy.mockRestore();
});

describe('process-tree census identifier domain', () => {
  it('accepts unrelated Linux kernel rows with zero parent and process-group identifiers', async () => {
    const target = {
      pid: ROOT_PID,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    };
    const rootAuthority = captureProcessTreeRootAuthority(target);
    expect(rootAuthority).not.toBeNull();

    const kernelRow = { pid: 2, ppid: 0, pgid: 0, command: '[kthreadd]' };
    const parentRow = {
      pid: process.pid,
      ppid: 1,
      pgid: process.pid,
      command: 'vitest-parent',
    };
    const live = census([
      kernelRow,
      parentRow,
      { pid: ROOT_PID, ppid: process.pid, pgid: ROOT_PID, command: 'provider-root' },
      { pid: CHILD_PID, ppid: ROOT_PID, pgid: ROOT_PID, command: 'provider-child' },
    ]);
    execFileSyncMock
      .mockReturnValueOnce(live)
      .mockReturnValueOnce(live)
      .mockReturnValue(census([kernelRow, parentRow]));

    await expect(killSessionTree(target, 'SIGKILL', {
      generationMarker: 'linux-zero-kernel-identifiers',
      rootAuthority: rootAuthority!,
      killGraceMs: 0,
    })).resolves.toMatchObject({
      outcome: 'terminated',
      ownedProcessCount: 2,
      signaledProcessCount: 2,
    });

    expect(target.kill).toHaveBeenCalledWith('SIGKILL');
    expect(killSpy).toHaveBeenCalledWith(CHILD_PID, 'SIGKILL');
    expect(killSpy.mock.calls.some(([pid]: unknown[]) => pid === 2)).toBe(false);
  });
});
