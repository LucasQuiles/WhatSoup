import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { transcribeWithFasterWhisper } from '../../../../../src/runtimes/chat/providers/transcription/faster-whisper.ts';

vi.mock('../../../../../src/runtimes/chat/providers/transcription/local-audio.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../../src/runtimes/chat/providers/transcription/local-audio.ts')>(),
  withNormalizedAudioFile: async (_buffer: Buffer, _mime: string, callback: (wav: string) => Promise<string>) => callback('/unused.wav'),
}));

afterEach(() => vi.unstubAllEnvs());

it('does not import an ambient transcription dependency after a successful isolated probe', async () => {
  const root = mkdtempSync(join(tmpdir(), 'whatsoup-transcription-isolation-'));
  try {
    const python = process.env.WHATSOUP_TEST_LOCKED_PYTHON ?? 'python3.13';
    const target = join(root, 'venv');
    const created = spawnSync(python, ['-I', '-m', 'venv', '--without-pip', target], { encoding: 'utf8' });
    expect(created.status, created.stderr).toBe(0);
    const marker = join(root, 'ambient-dependency-ran');
    writeFileSync(join(root, 'faster_whisper.py'), `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("executed")\nraise RuntimeError("ambient transcription dependency")\n`);
    vi.stubEnv('PYTHONPATH', root);
    vi.stubEnv('WHATSOUP_FASTER_WHISPER_PYTHON', join(target, 'bin/python'));

    await expect(transcribeWithFasterWhisper(Buffer.from('audio'), 'audio/wav'))
      .rejects.toThrow("No module named 'faster_whisper'");
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('rejects a real legacy interpreter before attempting audio normalization or model execution', async () => {
  const python = process.env.WHATSOUP_TEST_LEGACY_PYTHON ?? 'python3.12';
  const probe = spawnSync(python, ['-I', '-c', 'import sys; print(sys.executable); print(sys.version_info[:2])'], {
    encoding: 'utf8', timeout: 5_000,
  });
  expect(probe.status, probe.stderr || probe.error?.message).toBe(0);
  const [executable, version] = probe.stdout.trim().split('\n');
  expect(version).toBe('(3, 12)');
  vi.stubEnv('WHATSOUP_FASTER_WHISPER_PYTHON', executable);

  await expect(transcribeWithFasterWhisper(Buffer.from('not audio'), 'audio/wav'))
    .rejects.toThrow('CPython 3.13.16 is required; found cpython:3.12.');
});
