import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileSyncMock, processTreeLog } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  processTreeLog: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
}));

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => processTreeLog,
}));

import {
  killSessionTree,
  PROCESS_TREE_DIAGNOSTIC_SOURCES,
  ProcessTreeTerminationError,
  type ProcessTreeTerminationErrorCode,
} from '../../../src/runtimes/agent/process-tree.ts';

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
  for (const sink of Object.values(processTreeLog)) sink.mockClear();
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

async function expectTerminationCode(
  operation: Promise<void>,
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

    execFileSyncMock.mockReturnValue(census([
      { pid: process.pid, ppid: 1, pgid: process.pid, command: 'vitest-parent' },
    ]));
    await expectTerminationCode(
      killSessionTree(ROOT_PID, 'SIGTERM', { generationMarker: 'root-unverified' }),
      'PROCESS_TREE_ROOT_IDENTITY_UNVERIFIED',
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
    await expectTerminationCode(
      killSessionTree(ROOT_PID, 'SIGKILL', {
        generationMarker: 'final-census',
        killGraceMs: 0,
      }),
      'PROCESS_TREE_FINAL_CENSUS_UNAVAILABLE',
    );

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
      'PROCESS_TREE_SIGNAL_FAILED',
    );

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
        ambiguousCount: 0,
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

  it('omits an invalid optional row identifier from diagnostics', async () => {
    await expectTerminationCode(
      killSessionTree(ROOT_PID, 'SIGTERM', {
        generationMarker: '',
        diagnosticSource: 'session_shutdown',
        diagnosticSessionRowId: Number.NaN,
      }),
      'PROCESS_TREE_INVALID_GENERATION',
    );
    expect(processTreeLog.warn).toHaveBeenCalledWith(
      expect.not.objectContaining({ sessionRowId: expect.anything() }),
      'process-tree termination failed',
    );
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

    const first = killSessionTree(ROOT_PID, 'SIGTERM', {
      ...baseOptions,
      onOutcome: firstOutcome,
      onCgroupDivergence: firstDivergence,
    });
    const second = killSessionTree(ROOT_PID, 'SIGTERM', {
      ...baseOptions,
      onOutcome: secondOutcome,
      onCgroupDivergence: secondDivergence,
    });

    expect(second).toBe(first);
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(firstOutcome).toHaveBeenCalledTimes(1);
    expect(secondOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'terminated' }));
    expect(firstDivergence).toHaveBeenCalledTimes(1);
    expect(secondDivergence).toHaveBeenCalledWith({
      cgroupMemberCount: 2,
      ownedCount: 2,
      offTreeCount: 0,
    });
  });

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

  it('keeps termination successful but makes a throwing outcome sink visible', async () => {
    execFileSyncMock
      .mockReturnValueOnce(rootRows())
      .mockReturnValueOnce(rootRows())
      .mockReturnValue(selfOnly());
    const sinkError = new Error('outcome sink failed');

    await expect(
      killSessionTree(ROOT_PID, 'SIGTERM', {
        generationMarker: 'throwing-outcome-sink',
        diagnosticSource: 'session_shutdown',
        termGraceMs: 0,
        killGraceMs: 0,
        ambiguityResolveMs: 0,
        onOutcome: () => {
          throw sinkError;
        },
      }),
    ).resolves.toBeUndefined();

    expect(processTreeLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: sinkError,
        sink: 'outcome',
        source: 'session_shutdown',
      }),
      'process-tree telemetry sink failed',
    );
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

    await expect(
      killSessionTree(ROOT_PID, 'SIGTERM', {
        generationMarker: 'ambiguous-sibling-in-group',
        termGraceMs: 0,
        killGraceMs: 0,
        ambiguityResolveMs: 0,
      }),
    ).resolves.toBeUndefined();

    // No process-group broadcast (a negative pid) fires while a sibling is ambiguous:
    // that broadcast is indiscriminate and would reach the ambiguous child.
    expect(killSpy.mock.calls.some((c: unknown[]) => typeof c[0] === 'number' && (c[0] as number) < 0)).toBe(false);
    // The confirmed root survivor is signaled per-PID; the ambiguous child never is.
    expect(killSpy).toHaveBeenCalledWith(ROOT_PID, 'SIGTERM');
    expect(killSpy.mock.calls.some((c: unknown[]) => c[0] === CHILD_PID)).toBe(false);
  });
});
