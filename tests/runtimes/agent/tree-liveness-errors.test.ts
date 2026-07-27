import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: execFileMock,
}));

import { sampleTreeCpuMs } from '../../../src/runtimes/agent/tree-liveness.ts';

function replyFromPs(error: Error | null, stdout: string): void {
  execFileMock.mockImplementationOnce((...args: unknown[]) => {
    const callback = args.at(-1) as (err: Error | null, out: string, stderr: string) => void;
    callback(error, stdout, '');
  });
}

describe('tree liveness ps failures', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('rejects a failed process census even when ps returns partial stdout', async () => {
    replyFromPs(new Error('ps census interrupted'), '123 1\n124 123\n');
    replyFromPs(null, '0:01.00\n0:00.25\n');

    await expect(sampleTreeCpuMs(123)).resolves.toBeNull();
    expect(execFileMock).toHaveBeenCalledOnce();
  });

  it('rejects a failed CPU sample even when ps returns partial stdout', async () => {
    replyFromPs(null, '123 1\n124 123\n');
    replyFromPs(new Error('ps time interrupted'), '0:01.00\n');

    await expect(sampleTreeCpuMs(123)).resolves.toBeNull();
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});
