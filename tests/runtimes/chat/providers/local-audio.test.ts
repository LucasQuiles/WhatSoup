import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../../../../src/runtimes/chat/providers/transcription/local-audio.ts';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('runCommand', () => {
  it('returns stdout for a successful command', async () => {
    const result = await runCommand(process.execPath, ['-e', 'process.stdout.write("ok")'], 1_000);
    expect(result.stdout).toBe('ok');
  });

  it('kills a timed out child process', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'whatsoup-local-audio-'));
    const pidPath = join(dir, 'pid.txt');

    await expect(runCommand(
      process.execPath,
      ['-e', 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);', pidPath],
      100,
    )).rejects.toThrow(/timed out/i);

    const pid = Number((await readFile(pidPath, 'utf8')).trim());
    await new Promise((resolve) => setTimeout(resolve, 2_200));
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
    await expect(runCommand(
      process.execPath,
      ['-e', script, pidPath],
      100,
    )).rejects.toThrow(/timed out/i);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(2_000);

    const pid = Number((await readFile(pidPath, 'utf8')).trim());
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(isAlive(pid)).toBe(false);

    await rm(dir, { recursive: true, force: true });
  }, 10_000);
});
