import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runCommand } from '../../../../src/runtimes/chat/providers/transcription/local-audio.ts';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPid(pidPath: string): Promise<number> {
  let pid = 0;
  await vi.waitFor(async () => {
    pid = Number((await readFile(pidPath, 'utf8')).trim());
    expect(pid).toBeGreaterThan(0);
  }, { timeout: 2_000, interval: 10 });
  return pid;
}

describe('runCommand', () => {
  it('returns stdout for a successful command', async () => {
    const result = await runCommand(process.execPath, ['-e', 'process.stdout.write("ok")'], 1_000);
    expect(result.stdout).toBe('ok');
  });

  it('kills a timed out child process', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'whatsoup-local-audio-'));
    const pidPath = join(dir, 'pid.txt');

    const command = runCommand(
      process.execPath,
      ['-e', 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);', pidPath],
      1_000,
    );
    const rejection = expect(command).rejects.toThrow(/timed out/i);

    const pid = await waitForPid(pidPath);
    await rejection;
    expect(isAlive(pid)).toBe(false);

    await rm(dir, { recursive: true, force: true });
  });

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'whatsoup-local-audio-'));
    const pidPath = join(dir, 'pid.txt');
    const script = [
      'process.on("SIGTERM", () => {});',
      'require("node:fs").writeFileSync(process.argv[1], String(process.pid));',
      'setInterval(() => {}, 1000);',
    ].join('');

    const start = Date.now();
    const command = runCommand(
      process.execPath,
      ['-e', script, pidPath],
      1_000,
    );
    const rejection = expect(command).rejects.toThrow(/timed out/i);
    const pid = await waitForPid(pidPath);
    await rejection;
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(3_000);

    expect(isAlive(pid)).toBe(false);

    await rm(dir, { recursive: true, force: true });
  }, 10_000);
});
