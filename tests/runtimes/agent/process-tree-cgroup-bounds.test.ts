import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectCgroupMemberPids,
  observeCgroupMemberPids,
  PROCESS_TREE_CGROUP_MAX_BYTES,
  PROCESS_TREE_CGROUP_MAX_DEPTH,
  PROCESS_TREE_CGROUP_MAX_ENTRIES,
  PROCESS_TREE_CGROUP_MAX_TIME_MS,
  readBoundedCgroupDirectory,
  type CgroupObservationIo,
} from '../../../src/runtimes/agent/process-tree-cgroup.ts';

function depthOf(path: string): number {
  return path.split('/').filter((segment) => segment === 'child').length;
}

function depthIo(lastDirectoryDepth: number): CgroupObservationIo {
  return {
    readText: async () => ({ text: '', byteLength: 0, truncated: false }),
    readDirectory: async (path) => ({
      entries: depthOf(path) < lastDirectoryDepth
        ? [{ name: 'child', isDirectory: true }]
        : [],
      truncated: false,
      timedOut: false,
    }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('bounded cgroup observation', () => {
  // @skip-env: exercises the native non-Linux platform branch.
  it.runIf(process.platform !== 'linux')(
    'returns before attempting Linux cgroup filesystem observation',
    async () => {
      await expect(observeCgroupMemberPids()).resolves.toEqual({
        state: 'not_applicable',
      });
    },
  );

  it('accepts depth 32 and becomes inconclusive before descending to depth 33', async () => {
    await expect(
      collectCgroupMemberPids('/cgroup', depthIo(PROCESS_TREE_CGROUP_MAX_DEPTH)),
    ).resolves.toEqual({ state: 'complete', memberPids: [] });

    await expect(
      collectCgroupMemberPids('/cgroup', depthIo(PROCESS_TREE_CGROUP_MAX_DEPTH + 1)),
    ).resolves.toEqual({
      state: 'inconclusive',
      diagnosticCode: 'PROCESS_TREE_CGROUP_LIMIT_DEPTH',
    });
  });

  it('accepts exactly 4,096 entries and rejects one more without partial output', async () => {
    const io = (count: number): CgroupObservationIo => ({
      readText: async () => ({ text: '101\n', byteLength: 4, truncated: false }),
      readDirectory: async (_path, maxEntries) => ({
        entries: Array.from({ length: Math.min(count, maxEntries) }, (_, index) => ({
          name: `entry-${index}`,
          isDirectory: false,
        })),
        truncated: count > maxEntries,
        timedOut: false,
      }),
    });

    await expect(
      collectCgroupMemberPids('/cgroup', io(PROCESS_TREE_CGROUP_MAX_ENTRIES)),
    ).resolves.toEqual({ state: 'complete', memberPids: [101] });
    await expect(
      collectCgroupMemberPids('/cgroup', io(PROCESS_TREE_CGROUP_MAX_ENTRIES + 1)),
    ).resolves.toEqual({
      state: 'inconclusive',
      diagnosticCode: 'PROCESS_TREE_CGROUP_LIMIT_ENTRIES',
    });
  });

  it('accepts exactly 4 MiB and rejects a one-byte-over read', async () => {
    const io = (byteLength: number): CgroupObservationIo => ({
      readText: async () => ({ text: '', byteLength, truncated: false }),
      readDirectory: async () => ({ entries: [], truncated: false, timedOut: false }),
    });

    await expect(
      collectCgroupMemberPids('/cgroup', io(PROCESS_TREE_CGROUP_MAX_BYTES)),
    ).resolves.toEqual({ state: 'complete', memberPids: [] });
    await expect(
      collectCgroupMemberPids('/cgroup', io(PROCESS_TREE_CGROUP_MAX_BYTES + 1)),
    ).resolves.toEqual({
      state: 'inconclusive',
      diagnosticCode: 'PROCESS_TREE_CGROUP_LIMIT_BYTES',
    });
  });

  it('stops traversal when the shared wall deadline is exhausted', async () => {
    const clock = [0, 0, PROCESS_TREE_CGROUP_MAX_TIME_MS];
    const now = () => clock.shift() ?? PROCESS_TREE_CGROUP_MAX_TIME_MS;
    const io: CgroupObservationIo = {
      readText: async () => ({ text: '', byteLength: 0, truncated: false }),
      readDirectory: async () => ({ entries: [], truncated: false, timedOut: false }),
    };

    await expect(
      collectCgroupMemberPids('/cgroup', io, { now }),
    ).resolves.toEqual({
      state: 'inconclusive',
      diagnosticCode: 'PROCESS_TREE_CGROUP_LIMIT_TIME',
    });
  });

  it('returns at 250 ms even when an injected reader never settles', async () => {
    vi.useFakeTimers();
    const observation = observeCgroupMemberPids(
      () => new Promise<readonly number[] | null>(() => undefined),
    );

    await vi.advanceTimersByTimeAsync(PROCESS_TREE_CGROUP_MAX_TIME_MS);
    await expect(observation).resolves.toEqual({
      state: 'inconclusive',
      diagnosticCode: 'PROCESS_TREE_CGROUP_LIMIT_TIME',
    });
  });

  it('pulls at most one entry beyond the cap and closes the directory handle', async () => {
    let reads = 0;
    const close = vi.fn(async () => undefined);
    const result = await readBoundedCgroupDirectory({
      async read() {
        reads += 1;
        return { name: `entry-${reads}`, isDirectory: false };
      },
      close,
    }, PROCESS_TREE_CGROUP_MAX_ENTRIES);

    expect(result).toMatchObject({
      entries: expect.any(Array),
      truncated: true,
      timedOut: false,
    });
    expect(result.entries).toHaveLength(PROCESS_TREE_CGROUP_MAX_ENTRIES);
    expect(reads).toBe(PROCESS_TREE_CGROUP_MAX_ENTRIES + 1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('signals cooperative reader cancellation while bounding caller latency', async () => {
    vi.useFakeTimers();
    let aborted = false;
    const observation = observeCgroupMemberPids((signal: AbortSignal) =>
      new Promise<readonly number[] | null>(() => {
        signal?.addEventListener('abort', () => {
          aborted = true;
        }, { once: true });
      })
    );

    await vi.advanceTimersByTimeAsync(PROCESS_TREE_CGROUP_MAX_TIME_MS);
    await expect(observation).resolves.toEqual({
      state: 'inconclusive',
      diagnosticCode: 'PROCESS_TREE_CGROUP_LIMIT_TIME',
    });
    expect(aborted).toBe(true);
  });
});
