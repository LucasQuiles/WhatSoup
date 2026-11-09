import { afterEach, describe, expect, it, vi } from 'vitest';

const { censusMock } = vi.hoisted(() => ({ censusMock: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: censusMock }));
vi.mock('../../../src/lib/process-identity.ts', () => ({
  probeProcessBirthToken: (pid: number) => `birth:${pid}`,
  probeProcessBirthTokens: (pids: readonly number[]) => new Map(pids.map((pid) => [pid, `birth:${pid}`])),
  processBirthTokenSupportsNumericSignal: () => true,
}));

import {
  captureProcessTreeRootAuthority,
  killSessionTree,
  resetProcessTreeTerminationLeasesForTesting,
} from '../../../src/runtimes/agent/process-tree.ts';

afterEach(() => {
  resetProcessTreeTerminationLeasesForTesting();
  vi.useRealTimers();
});

describe('process-tree signal grace', () => {
  it.each(['reject', 'timeout'] as const)('refuses to signal when protection fails by %s', async (failure) => {
    vi.useFakeTimers();
    const pid = 51_001;
    const start = 'Fri Jul 10 08:00:00 2026';
    censusMock.mockReturnValue([
      'PID PPID PGID STARTED COMMAND',
      `${process.pid} 1 ${process.pid} ${start} vitest-parent`,
      `${pid} ${process.pid} ${pid} ${start} provider-root`,
    ].join('\n'));
    const target = { pid, exitCode: null, signalCode: null, kill: vi.fn(() => true) };
    const stopping = killSessionTree(target, 'SIGTERM', {
      generationMarker: `protection-${failure}`,
      rootAuthority: captureProcessTreeRootAuthority(target)!,
      beforeSignal: () => failure === 'reject'
        ? Promise.reject(new Error('protection unavailable'))
        : new Promise<void>(() => {}),
    });
    const rejected = expect(stopping).rejects.toMatchObject({ code: 'PROCESS_TREE_SIGNAL_FAILED' });
    if (failure === 'timeout') await vi.advanceTimersByTimeAsync(60_001);
    await rejected;
    expect(target.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses a root reparented while signal protection was pending', async () => {
    const pid = 51_001;
    let parent = process.pid;
    const start = 'Fri Jul 10 08:00:00 2026';
    censusMock.mockImplementation(() => [
      'PID PPID PGID STARTED COMMAND',
      `${process.pid} 1 ${process.pid} ${start} vitest-parent`,
      `${pid} ${parent} ${pid} ${start} provider-root`,
    ].join('\n'));
    const target = { pid, exitCode: null, signalCode: null, kill: vi.fn(() => true) };
    const stopping = killSessionTree(target, 'SIGTERM', {
      generationMarker: 'protection-parent-change',
      rootAuthority: captureProcessTreeRootAuthority(target)!,
      beforeSignal: async () => { parent = 1; },
    });
    await expect(stopping).rejects.toMatchObject({ code: 'PROCESS_TREE_ROOT_IDENTITY_UNVERIFIED' });
    expect(target.kill).not.toHaveBeenCalled();
  });

  it('waits before both TERM and KILL and checks identity after each wait', async () => {
    let alive = true;
    const pid = 51_001;
    const start = 'Fri Jul 10 08:00:00 2026';
    const events: string[] = [];
    censusMock.mockImplementation(() => {
      events.push('census');
      return ['PID PPID PGID STARTED COMMAND',
        `${process.pid} 1 ${process.pid} ${start} vitest-parent`,
        ...(alive ? [`${pid} ${process.pid} ${pid} ${start} provider-root`] : []),
      ].join('\n');
    });
    const target = {
      pid, exitCode: null, signalCode: null,
      kill: vi.fn((signal: NodeJS.Signals) => {
        events.push(signal);
        if (signal === 'SIGKILL') alive = false;
        return true;
      }),
    };
    let releaseTerm!: () => void;
    let releaseKill!: () => void;
    const term = new Promise<void>((resolve) => { releaseTerm = resolve; });
    const kill = new Promise<void>((resolve) => { releaseKill = resolve; });
    const beforeSignal = vi.fn((signal: NodeJS.Signals) => {
      events.push(`wait:${signal}`);
      return signal === 'SIGTERM' ? term : kill;
    });
    const stopping = killSessionTree(target, 'SIGTERM', {
      generationMarker: 'signal-grace', rootAuthority: captureProcessTreeRootAuthority(target)!,
      termGraceMs: 0, killGraceMs: 0, beforeSignal,
    });
    try {
      await vi.waitFor(() => expect(beforeSignal).toHaveBeenCalledWith('SIGTERM'));
      expect(target.kill).not.toHaveBeenCalled();
      events.push('release:SIGTERM');
      releaseTerm();
      await vi.waitFor(() => expect(beforeSignal).toHaveBeenCalledWith('SIGKILL'));
      expect(target.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
      events.push('release:SIGKILL');
      releaseKill();
      const outcome = await stopping;
      expect(outcome.outcome).toBe('escalated');
      expect(target.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
      for (const signal of ['SIGTERM', 'SIGKILL']) {
        const release = events.indexOf(`release:${signal}`);
        const sent = events.indexOf(signal);
        expect(events.slice(release + 1, sent)).toContain('census');
      }
    } finally {
      releaseTerm();
      releaseKill();
      await stopping;
    }
  });
});
