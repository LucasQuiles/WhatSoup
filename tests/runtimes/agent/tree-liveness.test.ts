// tests/runtimes/agent/tree-liveness.test.ts
// Real-process tests for the CPU-progress liveness assessor: a sleeping tree
// must read as NOT alive, a busy tree as alive, and a vanished root as null.

import { spawn } from 'node:child_process';
import { describe, expect, it, afterEach } from 'vitest';
import {
  assessTreeLiveness,
  parsePsTimeMs,
  sampleTreeCpuMs,
} from '../../../src/runtimes/agent/tree-liveness.ts';

/**
 * Structured timing exemption (test-integrity `js-sleep-in-test`): the subject
 * under test is REAL cumulative CPU time of REAL child processes measured across
 * a wall-clock window. Fake timers cannot advance an external process's CPU
 * clock, and there is no condition to poll that is not itself the assessment
 * being tested — elapsed real time is the test fixture.
 */
function TIMING(waitMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, waitMs));
}

const children: ReturnType<typeof spawn>[] = [];

function spawnTracked(cmd: string, args: string[]): ReturnType<typeof spawn> {
  const child = spawn(cmd, args, { stdio: 'ignore' });
  children.push(child);
  return child;
}

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
});

describe('parsePsTimeMs', () => {
  it('parses mm:ss.cc, hh:mm:ss, and dd-hh:mm:ss forms', () => {
    expect(parsePsTimeMs('0:00.05')).toBe(50);
    expect(parsePsTimeMs('2:03.50')).toBe(123_500);
    expect(parsePsTimeMs('1:02:03')).toBe(3_723_000);
    expect(parsePsTimeMs('2-01:02:03')).toBe(176_523_000);
    expect(parsePsTimeMs('   0:01.00  ')).toBe(1_000);
  });

  it('rejects garbage', () => {
    expect(parsePsTimeMs('')).toBeNull();
    expect(parsePsTimeMs('not-a-time')).toBeNull();
    expect(parsePsTimeMs('12')).toBeNull();
  });
});

describe('sampleTreeCpuMs', () => {
  it('samples a live process tree', async () => {
    const child = spawnTracked('sleep', ['30']);
    const sample = await sampleTreeCpuMs(child.pid!);
    expect(sample).not.toBeNull();
    expect(sample!.pids).toContain(child.pid);
    expect(sample!.cpuMs).toBeGreaterThanOrEqual(0);
  });

  it('returns null for a vanished pid', async () => {
    const child = spawnTracked('sleep', ['30']);
    const pid = child.pid!;
    child.kill('SIGKILL');
    await TIMING(300);
    const sample = await sampleTreeCpuMs(pid);
    expect(sample).toStrictEqual(null);
  });
});

describe('assessTreeLiveness', () => {
  it('reads an idle sleeper as not alive (no CPU progress)', async () => {
    const child = spawnTracked('sleep', ['30']);
    // Let spawn-time CPU settle before the first sample.
    await TIMING(300);
    const verdict = await assessTreeLiveness(child.pid!, { windowMs: 1_200 });
    expect(verdict).not.toBeNull();
    expect(verdict!.alive).toBe(false);
    expect(verdict!.cpuDeltaMs).toBeLessThan(200);
  }, 15_000);

  it('reads a busy loop as alive (CPU progress)', async () => {
    const child = spawnTracked('node', ['-e', 'const end = Date.now() + 12_000; while (Date.now() < end) { Math.sqrt(Math.random()); }']);
    await TIMING(300);
    const verdict = await assessTreeLiveness(child.pid!, { windowMs: 1_200 });
    expect(verdict).not.toBeNull();
    expect(verdict!.alive).toBe(true);
    expect(verdict!.cpuDeltaMs).toBeGreaterThanOrEqual(200);
  }, 15_000);

  it('returns null when the root exits before assessment', async () => {
    const child = spawnTracked('sleep', ['30']);
    const pid = child.pid!;
    child.kill('SIGKILL');
    await TIMING(300);
    const verdict = await assessTreeLiveness(pid, { windowMs: 200 });
    expect(verdict).toStrictEqual(null);
  });
});
