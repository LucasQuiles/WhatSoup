import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { transcribeAudio } from '../../../../src/runtimes/chat/providers/whisper.ts';

const FIXTURE_PATH = join(process.cwd(), 'tests/fixtures/audio/hello.ogg');
const VENV_ROOT = join(process.env.HOME ?? '', '.local/share/whatsoup/transcription-venv');
const hasLocalProvider = (
  existsSync('/opt/homebrew/bin/ffmpeg') && (
    existsSync(join(VENV_ROOT, 'bin/python3.12')) ||
    existsSync(join(VENV_ROOT, 'bin/python3')) ||
    existsSync('/opt/homebrew/bin/whisper-cli')
  )
);

describe('transcription integration', () => {
  // @skip-env requires local ffmpeg/whisper tooling and the real audio fixture.
  it.skipIf(!hasLocalProvider || !existsSync(FIXTURE_PATH))('transcribes a real audio fixture through the shared chain', async () => {
    delete process.env.OPENAI_API_KEY;
    const buffer = await readFile(FIXTURE_PATH);
    const result = await transcribeAudio(buffer, 'audio/ogg');
    expect(result).toMatch(/hello.*test/i);
  }, 30_000);
});
