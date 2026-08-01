import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveBinaryPath } from '../../../../src/runtimes/chat/providers/transcription/local-audio.ts';
import { transcribeAudio } from '../../../../src/runtimes/chat/providers/whisper.ts';

const FIXTURE_PATH = join(process.cwd(), 'tests/fixtures/audio/hello.ogg');
const VENV_ROOT = join(process.env.HOME ?? '', '.local/share/whatsoup/transcription-venv');

// Probe via PATH lookup (resolveBinaryPath, the same seam whisper-cpp.ts's
// resolveWhisperCli() uses) instead of hardcoding /opt/homebrew/bin/* —
// that hardcoded form only ever matched Apple Silicon and always evaluated
// false on Linux CI / Intel Mac, so this test silently skipped there even
// with a fully installed toolchain (#2304).
const ffmpegPath = resolveBinaryPath('ffmpeg');
const whisperCliPath = resolveBinaryPath('whisper-cli');
const venvPythonPath = existsSync(join(VENV_ROOT, 'bin/python3.12'))
  ? join(VENV_ROOT, 'bin/python3.12')
  : existsSync(join(VENV_ROOT, 'bin/python3'))
    ? join(VENV_ROOT, 'bin/python3')
    : null;
const hasLocalProvider = Boolean(ffmpegPath) && Boolean(venvPythonPath || whisperCliPath);

if (!hasLocalProvider) {
  // Loud skip reason: name exactly what was probed and what was (not) found,
  // so a green-but-skipped CI run is diagnosable without re-deriving the gate.
  console.warn(
    '[transcription-integration] skipping real-audio test — local provider unavailable: '
    + `ffmpeg (via PATH)=${ffmpegPath ? 'found' : 'NOT FOUND'}, `
    + `whisper-cli (via PATH)=${whisperCliPath ? 'found' : 'NOT FOUND'}, `
    + `faster-whisper venv (${VENV_ROOT})=${venvPythonPath ? 'found' : 'NOT FOUND'}`,
  );
}

describe('transcription integration', () => {
  // @skip-env requires local ffmpeg/whisper tooling and the real audio fixture.
  it.skipIf(!hasLocalProvider || !existsSync(FIXTURE_PATH))('transcribes a real audio fixture through the shared chain', async () => {
    delete process.env.OPENAI_API_KEY;
    const buffer = await readFile(FIXTURE_PATH);
    const result = await transcribeAudio(buffer, 'audio/ogg');
    expect(result).toMatch(/hello.*test/i);
  }, 30_000);
});
