import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createChildLogger } from '../../../../logger.ts';
import { resolveBinaryPath, runCommand, withNormalizedAudioFile } from './local-audio.ts';
import type { TranscriptionProvider } from './types.ts';

const log = createChildLogger('whisper-cpp');
const DEFAULT_MODEL = process.env.WHATSOUP_WHISPER_CPP_MODEL ?? join(homedir(), '.local/share/whatsoup/models/whisper.cpp/ggml-small.bin');

function resolveWhisperCli(): string | null {
  const configured = process.env.WHATSOUP_WHISPER_CPP_BIN;
  if (configured) return resolveBinaryPath(configured);
  return resolveBinaryPath('whisper-cli');
}

function cleanTranscript(output: string): string {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^\[[^\]]+\]\s*/, '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}

export async function transcribeWithWhisperCpp(buffer: Buffer, mimeType: string): Promise<string> {
  const whisperCli = resolveWhisperCli();
  if (!whisperCli) throw new Error('whisper-cli is not installed');
  if (!existsSync(DEFAULT_MODEL)) throw new Error(`whisper.cpp model missing at ${DEFAULT_MODEL}`);

  return await withNormalizedAudioFile(buffer, mimeType, async (wavPath) => {
    const { stdout } = await runCommand(
      whisperCli,
      ['-m', DEFAULT_MODEL, '-f', wavPath, '-l', 'auto', '-nt', '-np'],
      45_000,
    );

    const text = cleanTranscript(stdout);
    if (!text) throw new Error('whisper.cpp returned an empty transcript');
    log.info({ modelPath: DEFAULT_MODEL, textLength: text.length }, 'whisper.cpp transcription complete');
    return text;
  });
}

export const whisperCppProvider: TranscriptionProvider = {
  name: 'whisper.cpp',
  isAvailable: () => Boolean(resolveWhisperCli()) && existsSync(DEFAULT_MODEL),
  transcribe: transcribeWithWhisperCpp,
};
