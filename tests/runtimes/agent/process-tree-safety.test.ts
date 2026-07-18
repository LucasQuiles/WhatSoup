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

  it('soft-records a persistently-ambiguous survivor instead of throwing, and never SIGKILLs it', async () => {
    execFileSyncMock
      .mockReturnValueOnce(rootRows()) // entry snapshot: root + child owned
      .mockReturnValueOnce(rootRows()) // pre-signal: clean → SIGTERM both
      .mockReturnValue(ambiguousChild()); // TERM check + escalation re-census + final: child ambiguous

    const outcomes: Array<{ outcome: string; ambiguousPids: readonly number[] }> = [];
    await expect(
      killSessionTree(ROOT_PID, 'SIGTERM', {
        generationMarker: 'persistent-ambiguous',
        termGraceMs: 0,
        killGraceMs: 0,
        ambiguityResolveMs: 0,
        onOutcome: (o) => outcomes.push(o),
      }),
    ).resolves.toBeUndefined();

    // Safety invariant: the ambiguous child is never escalated to SIGKILL.
    expect(killSpy.mock.calls.some((c: unknown[]) => c[0] === CHILD_PID && c[1] === 'SIGKILL')).toBe(false);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].outcome).toBe('unresolved_ambiguous');
    expect(outcomes[0].ambiguousPids).toContain(CHILD_PID);
  });

  it('reports outcome=terminated when the tree exits within the grace (no escalation)', async () => {
    execFileSyncMock
      .mockReturnValueOnce(rootRows()) // entry
      .mockReturnValueOnce(rootRows()) // pre-signal SIGTERM
      .mockReturnValue(selfOnly()); // TERM check + final: all gone

    const outcomes: Array<{ outcome: string; escalated: boolean }> = [];
    await expect(
      killSessionTree(ROOT_PID, 'SIGTERM', {
        generationMarker: 'clean-terminate',
        termGraceMs: 0,
        killGraceMs: 0,
        ambiguityResolveMs: 0,
        onOutcome: (o) => outcomes.push(o),
      }),
    ).resolves.toBeUndefined();

    expect(outcomes[0].outcome).toBe('terminated');
    expect(outcomes[0].escalated).toBe(false);
  });

  it('reports outcome=escalated when a confirmed survivor is SIGKILLed', async () => {
    execFileSyncMock
      .mockReturnValueOnce(rootRows()) // entry
      .mockReturnValueOnce(rootRows()) // pre-signal SIGTERM
      .mockReturnValueOnce(rootRows()) // TERM check: still alive → survivors
      .mockReturnValueOnce(rootRows()) // escalation re-census: confirmed → SIGKILL
      .mockReturnValue(selfOnly()); // final: gone

    const outcomes: Array<{ outcome: string; escalated: boolean }> = [];
    await expect(
      killSessionTree(ROOT_PID, 'SIGTERM', {
        generationMarker: 'escalate-confirmed',
        termGraceMs: 0,
        killGraceMs: 0,
        ambiguityResolveMs: 0,
        onOutcome: (o) => outcomes.push(o),
      }),
    ).resolves.toBeUndefined();

    // Escalation is a process-group SIGKILL (negative pgid) when root leads its group.
    expect(killSpy.mock.calls.some((c: unknown[]) => c[1] === 'SIGKILL')).toBe(true);
    expect(outcomes[0].outcome).toBe('escalated');
    expect(outcomes[0].escalated).toBe(true);
  });
});
