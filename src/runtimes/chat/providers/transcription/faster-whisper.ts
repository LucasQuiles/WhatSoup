import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChildLogger } from '../../../../logger.ts';
import { runCommand, withNormalizedAudioFile } from './local-audio.ts';
import type { TranscriptionProvider } from './types.ts';

const log = createChildLogger('faster-whisper');
const SCRIPT_PATH = fileURLToPath(new URL('../../../../../scripts/transcribe-faster-whisper.py', import.meta.url));
const VENV_ROOT = join(homedir(), '.local/share/whatsoup/transcription-venv');
const MODEL_DIR = join(homedir(), '.local/share/whatsoup/models/faster-whisper');
const DEFAULT_MODEL = process.env.WHATSOUP_FASTER_WHISPER_MODEL ?? 'large-v3-turbo';

function resolvePython(): string | null {
  const candidates = [
    process.env.WHATSOUP_FASTER_WHISPER_PYTHON,
    join(VENV_ROOT, 'bin/python3.12'),
    join(VENV_ROOT, 'bin/python3'),
    join(VENV_ROOT, 'bin/python'),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

export async function transcribeWithFasterWhisper(buffer: Buffer, mimeType: string): Promise<string> {
  const pythonBin = resolvePython();
  if (!pythonBin) throw new Error('faster-whisper python runtime is not installed');
  if (!existsSync(SCRIPT_PATH)) throw new Error(`faster-whisper wrapper missing at ${SCRIPT_PATH}`);

  return await withNormalizedAudioFile(buffer, mimeType, async (wavPath) => {
    const { stdout } = await runCommand(
      pythonBin,
      [SCRIPT_PATH, '--input', wavPath, '--model', DEFAULT_MODEL, '--model-dir', MODEL_DIR],
      30_000,
    );

    let parsed: { text?: string };
    try {
      parsed = JSON.parse(stdout) as { text?: string };
    } catch (error) {
      throw new Error(`faster-whisper produced non-JSON output: ${stdout.slice(0, 200)}`, { cause: error });
    }
    const text = parsed.text?.trim();
    if (!text) throw new Error('faster-whisper returned an empty transcript');
    log.info({ model: DEFAULT_MODEL, textLength: text.length }, 'faster-whisper transcription complete');
    return text;
  });
}

export const fasterWhisperProvider: TranscriptionProvider = {
  name: 'faster-whisper',
  isAvailable: () => Boolean(resolvePython()) && existsSync(SCRIPT_PATH),
  transcribe: transcribeWithFasterWhisper,
};
