import { spawnSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { transcribeWithFasterWhisper } from '../../../../../src/runtimes/chat/providers/transcription/faster-whisper.ts';

afterEach(() => vi.unstubAllEnvs());

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
