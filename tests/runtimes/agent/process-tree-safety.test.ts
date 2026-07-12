import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
}));

import { killSessionTree } from '../../../src/runtimes/agent/process-tree.ts';

const ROOT_PID = 51_001;
const CHILD_PID = 51_002;
const START = 'Fri Jul 10 08:00:00 2026';

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
  execFileSyncMock.mockReset();
  killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
});

afterEach(() => {
  killSpy.mockRestore();
});

describe('process-tree fail-closed safety', () => {
  it('rejects a valid census with no root row without sending a signal', async () => {
    execFileSyncMock.mockReturnValue(census([
      { pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' },
    ]));

    await expect(killSessionTree(ROOT_PID, 'SIGKILL', {
      generationMarker: 'missing-root',
    })).rejects.toThrow('root row missing or ambiguous');
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
    })).rejects.toThrow('root row missing or ambiguous');
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
    await expect(first).rejects.toThrow('still has live PIDs');
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
    })).rejects.toThrow('Refusing to escalate');

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
      .mockReturnValueOnce(census([]));

    await killSessionTree(ROOT_PID, 'SIGKILL', {
      generationMarker: 'pid-reuse',
      killGraceMs: 0,
    });

    expect(killSpy).not.toHaveBeenCalled();
  });
});
