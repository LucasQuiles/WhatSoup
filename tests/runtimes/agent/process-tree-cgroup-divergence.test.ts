/**
 * #1869 — cgroup-vs-PPID divergence telemetry for the provider-tree reaper.
 *
 * The reaper owns processes by PPID descent from the provider root; workload
 * daemons that double-fork and reparent off that tree (but stay in the service
 * cgroup) are invisible to it and accumulate silently. This telemetry surfaces
 * the raw divergence so the accumulation is observable, WITHOUT changing what the
 * reaper kills (classifying which off-tree members are session-owned-and-leaked
 * is a separate leak-signature decision, out of scope here). These tests cover
 * the pure divergence computation and the best-effort emit isolation (it must
 * never throw into, or otherwise affect, the termination path).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureProcessTreeRootAuthority,
  computeCgroupDivergence,
  emitCgroupDivergence,
  killSessionTree as killSessionTreeRaw,
  resetProcessTreeTerminationLeasesForTesting,
  type CgroupDivergenceInfo,
  type KillSessionTreeOptions,
  type ProcessTreeRootAuthority,
  type ProcessTreeTarget,
} from '../../../src/runtimes/agent/process-tree.ts';

// #1869: mock node:child_process for killSessionTree integration tests so the
// ps census is fully controlled. Pure-function tests that don't call execFileSync
// are unaffected.
const { birthTokenMock, execFileSyncMock } = vi.hoisted(() => ({
  birthTokenMock: vi.fn((pid: number) => `birth:${pid}`),
  execFileSyncMock: vi.fn(),
}));
vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
}));
vi.mock('../../../src/lib/process-identity.ts', () => ({
  processBirthTokenSupportsNumericSignal: () => true,
  probeProcessBirthToken: birthTokenMock,
  probeProcessBirthTokens: (pids: readonly number[]) => {
    const observed = new Map<number, string>();
    for (const pid of pids) {
      const token = birthTokenMock(pid);
      if (typeof token === 'string') observed.set(pid, token);
    }
    return observed;
  },
}));

type TestKillOptions = Omit<KillSessionTreeOptions, 'rootAuthority'> & {
  readonly rootAuthority?: ProcessTreeRootAuthority;
};

function killSessionTree(
  target: number | ProcessTreeTarget,
  signal: NodeJS.Signals,
  options: TestKillOptions,
) {
  const capturedTarget: ProcessTreeTarget = typeof target === 'number'
    ? {
        pid: target,
        exitCode: null,
        signalCode: null,
        kill: (requestedSignal) => process.kill(target, requestedSignal),
      }
    : target;
  return killSessionTreeRaw(capturedTarget, signal, {
    ...options,
    rootAuthority: options.rootAuthority
      ?? captureProcessTreeRootAuthority(capturedTarget)!,
  });
}

describe('computeCgroupDivergence (pure)', () => {
  it('counts cgroup members not in the PPID-owned set, excluding the provider root', () => {
    // root=100; owned tree = 100,101,102; cgroup also holds 200,201 (reparented off-tree)
    const info = computeCgroupDivergence([100, 101, 102, 200, 201], [{ pid: 101 }, { pid: 102 }], 100);
    expect(info).toEqual<CgroupDivergenceInfo>({
      cgroupMemberCount: 5,
      ownedCount: 2,
      offTreeCount: 2, // 200, 201 (100 is the root, 101/102 are owned)
    });
  });

  it('excludes the provider root PID from off-tree even when it is not in the owned list', () => {
    const info = computeCgroupDivergence([100, 300], [], 100);
    expect(info.offTreeCount).toBe(1); // only 300 (root 100 is excluded)
  });

  it('reports zero off-tree when every cgroup member is owned or the root', () => {
    const info = computeCgroupDivergence([100, 101], [{ pid: 101 }], 100);
    expect(info.offTreeCount).toBe(0);
  });

  it('handles an empty cgroup membership', () => {
    expect(computeCgroupDivergence([], [{ pid: 101 }], 100)).toEqual<CgroupDivergenceInfo>({
      cgroupMemberCount: 0,
      ownedCount: 1,
      offTreeCount: 0,
    });
  });
});

describe('emitCgroupDivergence (best-effort isolation)', () => {
  it('emits the divergence gauge when the injected reader returns members', async () => {
    const sink = vi.fn();
    await emitCgroupDivergence([{ pid: 101 }], 100, {
      generationMarker: 'g',
      onCgroupDivergence: sink,
      readCgroupMemberPids: () => [100, 101, 200],
    });
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith<[CgroupDivergenceInfo]>({
      cgroupMemberCount: 3,
      ownedCount: 1,
      offTreeCount: 1, // 200
    });
  });

  it('does NOT emit when the reader returns null (cgroup membership undeterminable)', async () => {
    const sink = vi.fn();
    await emitCgroupDivergence([{ pid: 101 }], 100, {
      generationMarker: 'g',
      onCgroupDivergence: sink,
      readCgroupMemberPids: () => null,
    });
    expect(sink).not.toHaveBeenCalled();
  });

  it('never throws and does not emit when the reader throws', async () => {
    const sink = vi.fn();
    await expect(
      emitCgroupDivergence([{ pid: 101 }], 100, {
        generationMarker: 'g',
        onCgroupDivergence: sink,
        readCgroupMemberPids: () => {
          throw new Error('cgroup read blew up');
        },
      }),
    ).resolves.toBeDefined();
    expect(sink).not.toHaveBeenCalled();
  });

  it('never throws when the sink itself throws', async () => {
    await expect(
      emitCgroupDivergence([{ pid: 101 }], 100, {
        generationMarker: 'g',
        onCgroupDivergence: () => {
          throw new Error('sink blew up');
        },
        readCgroupMemberPids: () => [100, 200],
      }),
    ).resolves.toBeDefined();
  });

  it('is a no-op (no throw) when no sink is provided', async () => {
    await expect(
      emitCgroupDivergence([{ pid: 101 }], 100, {
        generationMarker: 'g',
        readCgroupMemberPids: () => [100, 200],
      }),
    ).resolves.toBeDefined();
  });

  it('accepts the exact member ceiling and fails telemetry closed one item over', async () => {
    const exactSink = vi.fn();
    const exact = await emitCgroupDivergence([], 50_000, {
      generationMarker: 'exact-entry-limit',
      onCgroupDivergence: exactSink,
      readCgroupMemberPids: () => Array.from({ length: 4_096 }, (_, index) => index + 1),
    });
    expect(exact).toMatchObject({ state: 'complete' });
    expect(exactSink).toHaveBeenCalledTimes(1);

    const overSink = vi.fn();
    const over = await emitCgroupDivergence([], 50_000, {
      generationMarker: 'over-entry-limit',
      onCgroupDivergence: overSink,
      readCgroupMemberPids: () => Array.from({ length: 4_097 }, (_, index) => index + 1),
    });
    expect(over).toEqual({
      state: 'inconclusive',
      diagnosticCode: 'PROCESS_TREE_CGROUP_LIMIT_ENTRIES',
    });
    expect(overSink).not.toHaveBeenCalled();
  });

  it('rejects malformed injected membership without emitting a partial gauge', async () => {
    const sink = vi.fn();
    const observation = await emitCgroupDivergence([], 100, {
      generationMarker: 'invalid-membership',
      onCgroupDivergence: sink,
      readCgroupMemberPids: () => [100, Number.NaN],
    });
    expect(observation).toEqual({
      state: 'inconclusive',
      diagnosticCode: 'PROCESS_TREE_CGROUP_INPUT_INVALID',
    });
    expect(sink).not.toHaveBeenCalled();
  });
});

describe('#1869 killSessionTree cgroup isolation (mock ps)', () => {
  const ROOT_PID = 51_001;
  const CHILD_PID = 51_002;
  const SIBLING_SESSION_PID = 99_999;
  const START = 'Fri Jul 10 08:00:00 2026';

  let killSpy: ReturnType<typeof vi.spyOn>;

  function census(rows: Array<{ pid: number; ppid: number; pgid: number; command: string }>): string {
    return [
      'PID PPID PGID STARTED COMMAND',
      ...rows.map((row) =>
        `${row.pid} ${row.ppid} ${row.pgid} ${START} ${row.command}`,
      ),
    ].join('\n');
  }

  beforeEach(() => {
    resetProcessTreeTerminationLeasesForTesting();
    birthTokenMock.mockReset().mockImplementation((pid: number) => `birth:${pid}`);
    execFileSyncMock.mockReset();
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    resetProcessTreeTerminationLeasesForTesting();
    killSpy.mockRestore();
  });

  it('observes but never signals a cgroup-only sibling session', async () => {
    const withSibling = census([
      { pid: process.pid, ppid: 1, pgid: process.pid, command: 'test-runner' },
      { pid: ROOT_PID, ppid: process.pid, pgid: ROOT_PID, command: 'provider-root' },
      { pid: CHILD_PID, ppid: ROOT_PID, pgid: ROOT_PID, command: 'provider-child' },
      // A different resident provider in the same service cgroup is not owned by ROOT_PID.
      {
        pid: SIBLING_SESSION_PID,
        ppid: process.pid,
        pgid: SIBLING_SESSION_PID,
        command: 'sibling-provider',
      },
    ]);
    const serviceMainAndSibling = census([
      { pid: process.pid, ppid: 1, pgid: process.pid, command: 'test-runner' },
      {
        pid: SIBLING_SESSION_PID,
        ppid: process.pid,
        pgid: SIBLING_SESSION_PID,
        command: 'sibling-provider',
      },
    ]);

    execFileSyncMock
      .mockReturnValueOnce(withSibling) // entry: build PPID-owned tree
      .mockReturnValueOnce(withSibling) // pre-signal resolution
      .mockReturnValueOnce(serviceMainAndSibling); // final: sibling survives owned-tree exit

    const divergenceSink = vi.fn();

    await expect(killSessionTree(ROOT_PID, 'SIGKILL', {
      generationMarker: 'test-preserve-sibling',
      killGraceMs: 0,
      onCgroupDivergence: divergenceSink,
      readCgroupMemberPids: () => [
        process.pid,
        ROOT_PID,
        CHILD_PID,
        SIBLING_SESSION_PID,
      ],
    })).resolves.toMatchObject({ outcome: 'terminated' });

    // The divergence sink reports the off-tree PID that the PPID walk missed
    expect(divergenceSink).toHaveBeenCalledTimes(1);
    expect(divergenceSink).toHaveBeenCalledWith<[CgroupDivergenceInfo]>({
      cgroupMemberCount: 4,
      ownedCount: 2,
      offTreeCount: 2, // service main plus sibling session
    });

    // Cgroup membership alone proves co-location, not ownership. Signaling the
    // sibling reproduces the observed cross-session crash during idle TTL.
    expect(killSpy).not.toHaveBeenCalledWith(SIBLING_SESSION_PID, 'SIGKILL');
    expect(killSpy.mock.calls).toEqual([
      [CHILD_PID, 'SIGKILL'],
      [ROOT_PID, 'SIGKILL'],
    ]);
  });

  it('falls back to owned PIDs when an off-tree process shares the root process group', async () => {
    const withSharedGroupSibling = census([
      { pid: process.pid, ppid: 1, pgid: process.pid, command: 'test-runner' },
      { pid: ROOT_PID, ppid: process.pid, pgid: ROOT_PID, command: 'provider-root' },
      { pid: CHILD_PID, ppid: ROOT_PID, pgid: ROOT_PID, command: 'provider-child' },
      {
        pid: SIBLING_SESSION_PID,
        ppid: process.pid,
        pgid: ROOT_PID,
        command: 'off-tree-shared-group-process',
      },
    ]);
    const serviceMainAndSibling = census([
      { pid: process.pid, ppid: 1, pgid: process.pid, command: 'test-runner' },
      {
        pid: SIBLING_SESSION_PID,
        ppid: process.pid,
        pgid: ROOT_PID,
        command: 'off-tree-shared-group-process',
      },
    ]);

    execFileSyncMock
      .mockReturnValueOnce(withSharedGroupSibling)
      .mockReturnValueOnce(withSharedGroupSibling)
      .mockReturnValueOnce(serviceMainAndSibling);

    await expect(killSessionTree(ROOT_PID, 'SIGKILL', {
      generationMarker: 'test-preserve-shared-group-sibling',
      killGraceMs: 0,
      readCgroupMemberPids: () => [
        process.pid,
        ROOT_PID,
        CHILD_PID,
        SIBLING_SESSION_PID,
      ],
    })).resolves.toMatchObject({ outcome: 'terminated' });

    expect(killSpy).not.toHaveBeenCalledWith(-ROOT_PID, 'SIGKILL');
    expect(killSpy).not.toHaveBeenCalledWith(SIBLING_SESSION_PID, 'SIGKILL');
    expect(killSpy.mock.calls).toEqual([
      [CHILD_PID, 'SIGKILL'],
      [ROOT_PID, 'SIGKILL'],
    ]);
  });

  it('refuses an absent target instead of adopting cgroup peers as owned', async () => {
    const withoutRoot = census([
      { pid: process.pid, ppid: 1, pgid: process.pid, command: 'test-runner' },
      {
        pid: SIBLING_SESSION_PID,
        ppid: process.pid,
        pgid: SIBLING_SESSION_PID,
        command: 'sibling-provider',
      },
    ]);
    const selfOnly = census([
      { pid: process.pid, ppid: 1, pgid: process.pid, command: 'test-runner' },
    ]);

    execFileSyncMock
      .mockReturnValueOnce(withoutRoot) // entry: the requested provider root is already gone
      .mockReturnValueOnce(withoutRoot) // broken cgroup-union path: pre-signal resolution
      .mockReturnValueOnce(selfOnly);   // broken cgroup-union path: peer appears to exit

    await expect(killSessionTree(ROOT_PID, 'SIGKILL', {
      generationMarker: 'test-missing-root',
      killGraceMs: 0,
      readCgroupMemberPids: () => [process.pid, SIBLING_SESSION_PID],
    })).rejects.toMatchObject({ code: 'PROCESS_TREE_ROOT_MISSING' });

    expect(killSpy).not.toHaveBeenCalledWith(SIBLING_SESSION_PID, 'SIGKILL');
  });

  it('keeps PPID-owned termination isolated from a throwing cgroup reader', async () => {
    const normal = census([
      { pid: process.pid, ppid: 1, pgid: process.pid, command: 'test-runner' },
      { pid: ROOT_PID, ppid: process.pid, pgid: ROOT_PID, command: 'provider-root' },
      { pid: CHILD_PID, ppid: ROOT_PID, pgid: ROOT_PID, command: 'provider-child' },
    ]);
    const selfOnly = census([
      { pid: process.pid, ppid: 1, pgid: process.pid, command: 'test-runner' },
    ]);

    execFileSyncMock
      .mockReturnValueOnce(normal)
      .mockReturnValueOnce(normal)
      .mockReturnValueOnce(selfOnly);

    await expect(killSessionTree(ROOT_PID, 'SIGKILL', {
      generationMarker: 'test-reader-isolation',
      killGraceMs: 0,
      onCgroupDivergence: vi.fn(),
      readCgroupMemberPids: () => {
        throw new Error('reader blew up');
      },
    })).resolves.toMatchObject({
      outcome: 'terminated',
      diagnosticState: 'inconclusive',
      diagnosticCodes: ['PROCESS_TREE_CGROUP_OBSERVATION_UNAVAILABLE'],
    });

    expect(killSpy.mock.calls).toEqual([
      [CHILD_PID, 'SIGKILL'],
      [ROOT_PID, 'SIGKILL'],
    ]);
  });

  it('emits a zero divergence gauge when every cgroup member is already in the PPID tree', async () => {
    const normal = census([
      { pid: process.pid, ppid: 1, pgid: process.pid, command: 'test-runner' },
      { pid: ROOT_PID, ppid: process.pid, pgid: ROOT_PID, command: 'provider-root' },
      { pid: CHILD_PID, ppid: ROOT_PID, pgid: ROOT_PID, command: 'provider-child' },
    ]);
    const selfOnly = census([
      { pid: process.pid, ppid: 1, pgid: process.pid, command: 'test-runner' },
    ]);

    execFileSyncMock
      .mockReturnValueOnce(normal) // entry
      .mockReturnValueOnce(normal) // pre-signal
      .mockReturnValueOnce(selfOnly); // final

    const divergenceSink = vi.fn();

    await expect(killSessionTree(ROOT_PID, 'SIGKILL', {
      generationMarker: 'test-no-divergence',
      killGraceMs: 0,
      onCgroupDivergence: divergenceSink,
      readCgroupMemberPids: () => [ROOT_PID, CHILD_PID],
    })).resolves.toMatchObject({ outcome: 'terminated' });

    expect(divergenceSink).toHaveBeenCalledTimes(1);
    expect(divergenceSink).toHaveBeenCalledWith<[CgroupDivergenceInfo]>({
      cgroupMemberCount: 2,
      ownedCount: 2,
      offTreeCount: 0,
    });
  });
});
