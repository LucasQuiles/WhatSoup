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
  computeCgroupDivergence,
  emitCgroupDivergence,
  killSessionTree,
  type CgroupDivergenceInfo,
} from '../../../src/runtimes/agent/process-tree.ts';

// #1869: mock node:child_process for killSessionTree integration tests so the
// ps census is fully controlled. Pure-function tests that don't call execFileSync
// are unaffected.
const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));
vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
}));

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
  it('emits the divergence gauge when the injected reader returns members', () => {
    const sink = vi.fn();
    emitCgroupDivergence([{ pid: 101 }], 100, {
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

  it('does NOT emit when the reader returns null (cgroup membership undeterminable)', () => {
    const sink = vi.fn();
    emitCgroupDivergence([{ pid: 101 }], 100, {
      generationMarker: 'g',
      onCgroupDivergence: sink,
      readCgroupMemberPids: () => null,
    });
    expect(sink).not.toHaveBeenCalled();
  });

  it('never throws and does not emit when the reader throws', () => {
    const sink = vi.fn();
    expect(() =>
      emitCgroupDivergence([{ pid: 101 }], 100, {
        generationMarker: 'g',
        onCgroupDivergence: sink,
        readCgroupMemberPids: () => {
          throw new Error('cgroup read blew up');
        },
      }),
    ).not.toThrow();
    expect(sink).not.toHaveBeenCalled();
  });

  it('never throws when the sink itself throws', () => {
    expect(() =>
      emitCgroupDivergence([{ pid: 101 }], 100, {
        generationMarker: 'g',
        onCgroupDivergence: () => {
          throw new Error('sink blew up');
        },
        readCgroupMemberPids: () => [100, 200],
      }),
    ).not.toThrow();
  });

  it('is a no-op (no throw) when no sink is provided', () => {
    expect(() =>
      emitCgroupDivergence([{ pid: 101 }], 100, {
        generationMarker: 'g',
        readCgroupMemberPids: () => [100, 200],
      }),
    ).not.toThrow();
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
    execFileSyncMock.mockReset();
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
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
    })).resolves.toBeUndefined();

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
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(-ROOT_PID, 'SIGKILL');
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
    })).resolves.toBeUndefined();

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
    })).rejects.toThrow('pre-signal root row missing or ambiguous');

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
    })).resolves.toBeUndefined();

    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(-ROOT_PID, 'SIGKILL');
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
    })).resolves.toBeUndefined();

    expect(divergenceSink).toHaveBeenCalledTimes(1);
    expect(divergenceSink).toHaveBeenCalledWith<[CgroupDivergenceInfo]>({
      cgroupMemberCount: 2,
      ownedCount: 2,
      offTreeCount: 0,
    });
  });
});
