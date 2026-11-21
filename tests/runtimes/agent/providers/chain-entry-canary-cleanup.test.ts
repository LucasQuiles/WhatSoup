/**
 * How probeChainEntryCompletion reports the process-tree reap it relies on.
 * The reaper is replaced so each case can force an outcome; the probed child is
 * a real hung Node process, killed directly after each case.
 */
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { killSessionTreeMock } = vi.hoisted(() => ({ killSessionTreeMock: vi.fn() }));
vi.mock('../../../../src/runtimes/agent/process-tree.ts', () => ({ killSessionTree: killSessionTreeMock }));

import { probeChainEntryCompletion } from '../../../../src/runtimes/agent/providers/chain-entry-canary.ts';

const HANG = ['-e', 'setInterval(() => {}, 1000)'];
// Writes past the 64 KiB stdout limit, then hangs, so the overflow verdict needs a reap.
const OVERFLOW_THEN_HANG = ['-e', "process.stdout.write('x'.repeat(70 * 1024)); setInterval(() => {}, 1000)"];

function probeHungChild() {
  return probeChainEntryCompletion(process.execPath, HANG, 'Reply with exactly: OK', { PATH: process.env.PATH }, 300);
}

function probeOverflowingChild() {
  return probeChainEntryCompletion(process.execPath, OVERFLOW_THEN_HANG, 'Reply with exactly: OK', { PATH: process.env.PATH }, 10_000);
}

/** Hold the reap pending; the returned controls finish or fail it. */
function holdReap() {
  const controls = { finish: () => {}, fail: (_err: Error) => {} };
  killSessionTreeMock.mockImplementation(() => new Promise<void>((resolve, reject) => {
    controls.finish = resolve;
    controls.fail = reject;
  }));
  return controls;
}

describe('probeChainEntryCompletion process-tree cleanup reporting', () => {
  const targets: ChildProcess[] = [];

  beforeEach(() => {
    killSessionTreeMock.mockReset();
  });

  afterEach(() => {
    for (const child of targets.splice(0)) child.kill('SIGKILL');
  });

  function recordTarget(): void {
    const target = killSessionTreeMock.mock.calls.at(-1)?.[0] as ChildProcess | undefined;
    if (target) targets.push(target);
  }

  it('reaps the spawned child itself under a fresh canary generation marker', async () => {
    killSessionTreeMock.mockResolvedValue(undefined);

    await probeHungChild();
    recordTarget();
    await probeHungChild();
    recordTarget();

    expect(killSessionTreeMock).toHaveBeenCalledTimes(2);
    const [first, second] = killSessionTreeMock.mock.calls;
    expect(typeof (first![0] as ChildProcess).pid).toBe('number');
    expect(first![0]).not.toBe(second![0]);
    expect(first![1]).toBe('SIGTERM');
    const markers = [first![2].generationMarker, second![2].generationMarker];
    expect(markers.every((marker: string) => marker.startsWith('chain-canary:'))).toBe(true);
    expect(markers[0]).not.toBe(markers[1]);
  });

  it('keeps the timeout verdict and records an ambiguous reap', async () => {
    killSessionTreeMock.mockImplementation(async (_target, _signal, options) => {
      options.onOutcome({ outcome: 'unresolved_ambiguous', generationMarker: options.generationMarker, durationMs: 1, escalated: false, ambiguousPids: [1234] });
    });

    const result = await probeHungChild();
    recordTarget();

    expect(result.status).toBe('timeout');
    expect(result.failureClass).toBe('timeout');
    expect(result.evidence).toContain('cleanup ambiguous');
  });

  it('keeps the timeout verdict and records a failed reap', async () => {
    killSessionTreeMock.mockRejectedValue(new Error('Refusing to signal session process tree: pre-signal census unavailable'));

    const result = await probeHungChild();
    recordTarget();

    expect(result.status).toBe('timeout');
    expect(result.evidence).toContain('cleanup failed');
  });

  it('does not report the probe as settled before the reap finishes', async () => {
    let finishReap!: () => void;
    killSessionTreeMock.mockImplementation(() => new Promise<void>((resolve) => { finishReap = resolve; }));
    let settled = false;

    const pending = probeHungChild().then((result) => { settled = true; return result; });
    await vi.waitFor(() => expect(killSessionTreeMock).toHaveBeenCalled());
    recordTarget();
    expect(settled).toBe(false);

    finishReap();
    expect((await pending).status).toBe('timeout');
  });

  describe('a child error while the reap is pending', () => {
    async function startStopping(probe: () => Promise<{ status: string; failureClass: string | null; evidence: string | null }>) {
      let settled = false;
      const pending = probe().then((result) => { settled = true; return result; });
      await vi.waitFor(() => expect(killSessionTreeMock).toHaveBeenCalled(), { timeout: 5_000 });
      recordTarget();
      const target = killSessionTreeMock.mock.calls.at(-1)![0] as ChildProcess;
      // What the shared reaper's target.kill() can surface during cleanup.
      target.emit('error', new Error('kill EPERM'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { pending, isSettled: () => settled };
    }

    it('keeps the timeout verdict and settles only when the reap completes', async () => {
      const reap = holdReap();
      const run = await startStopping(probeHungChild);
      expect(run.isSettled()).toBe(false);

      reap.finish();
      const result = await run.pending;
      expect(result.status).toBe('timeout');
      expect(result.failureClass).toBe('timeout');
      expect(result.evidence).not.toContain('EPERM');
    });

    it('keeps the timeout verdict and records the cleanup failure when the reap fails', async () => {
      const reap = holdReap();
      const run = await startStopping(probeHungChild);
      expect(run.isSettled()).toBe(false);

      reap.fail(new Error('Refusing to signal session process tree: pre-signal census unavailable'));
      const result = await run.pending;
      expect(result.status).toBe('timeout');
      expect(result.evidence).toContain('cleanup failed');
      expect(result.evidence).not.toContain('EPERM');
    });

    it('keeps the overflow verdict and settles only when the reap completes', async () => {
      const reap = holdReap();
      const run = await startStopping(probeOverflowingChild);
      expect(run.isSettled()).toBe(false);

      reap.finish();
      const result = await run.pending;
      expect(result.status).toBe('failed');
      expect(result.evidence).toBe('output exceeded 65536 bytes');
    });
  });

  it('still reports a spawn error with no reap when the binary cannot start', async () => {
    const result = await probeChainEntryCompletion('/nonexistent/opencode-canary-binary', [], 'Reply with exactly: OK', { PATH: process.env.PATH }, 5_000);

    expect(result.status).toBe('failed');
    expect(result.failureClass).toBe('spawn');
    expect(result.evidence).toContain('ENOENT');
    expect(killSessionTreeMock).not.toHaveBeenCalled();
  });
});
