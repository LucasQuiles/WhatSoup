import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pythonLockPolicy from '../../../../../requirements/python/lock-policy.json' with { type: 'json' };
import { createChildLogger } from '../../../../logger.ts';
import { runCommand, withNormalizedAudioFile } from './local-audio.ts';
import type { TranscriptionProvider } from './types.ts';

const log = createChildLogger('faster-whisper');
export const SCRIPT_PATH = fileURLToPath(new URL('../../../../../scripts/transcribe-faster-whisper.py', import.meta.url));
export const VENV_ROOT = join(homedir(), '.local/share/whatsoup/transcription-venv');
const MODEL_DIR = join(homedir(), '.local/share/whatsoup/models/faster-whisper');
export const DEFAULT_MODEL_NAME = 'large-v3-turbo';
export const DEFAULT_MODEL_PATH = join(
  MODEL_DIR,
  `${DEFAULT_MODEL_NAME}-0c94664816ec82be77b20e824c8e8675995b0029`,
);
// env-allowed: host-local toolchain; absence drives the managed-venv auto-probe chain
const configuredModel = process.env.WHATSOUP_FASTER_WHISPER_MODEL;
const DEFAULT_MODEL = configuredModel === undefined || configuredModel === DEFAULT_MODEL_NAME
  ? DEFAULT_MODEL_PATH
  : configuredModel && isAbsolute(configuredModel)
    ? configuredModel
    : null;
const DISPLAY_MODEL = configuredModel ?? DEFAULT_MODEL_NAME;

function localModelReady(): boolean {
  if (!DEFAULT_MODEL) return false;
  try {
    const file = (name: string) => statSync(join(DEFAULT_MODEL, name), { throwIfNoEntry: false })?.isFile() === true;
    return ['config.json', 'model.bin', 'tokenizer.json'].every(file)
      && (file('vocabulary.json') || file('vocabulary.txt'));
  } catch {
    return false;
  }
}

export function resolvePython(): string | null {
  const candidates = [
    // env-allowed: host-local toolchain; absence drives the managed-venv auto-probe chain
    process.env.WHATSOUP_FASTER_WHISPER_PYTHON,
    join(VENV_ROOT, 'bin/python3.13'),
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
  if (!DEFAULT_MODEL) throw new Error('WHATSOUP_FASTER_WHISPER_MODEL must be large-v3-turbo or an absolute local model directory');

  const { stdout: identity } = await runCommand(pythonBin, [
    '-I', '-c',
    'import sys; print(f"{sys.implementation.name}:{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")',
  ], 5_000);
  const expected = `${pythonLockPolicy.runtime.implementation}:${pythonLockPolicy.runtime.version}`;
  if (identity.trim() !== expected) {
    throw new Error(`faster-whisper CPython ${pythonLockPolicy.runtime.version} is required; found ${identity.trim().slice(0, 200) || 'unknown'}`);
  }

  return await withNormalizedAudioFile(buffer, mimeType, async (wavPath) => {
    const { stdout } = await runCommand(
      pythonBin,
      ['-I', SCRIPT_PATH, '--input', wavPath, '--model', DEFAULT_MODEL, '--model-dir', MODEL_DIR],
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
    log.info({ model: DISPLAY_MODEL, textLength: text.length }, 'faster-whisper transcription complete');
    return text;
  });
}

export const fasterWhisperProvider: TranscriptionProvider = {
  name: 'faster-whisper',
  isAvailable: () => Boolean(resolvePython()) && existsSync(SCRIPT_PATH) && localModelReady(),
  transcribe: transcribeWithFasterWhisper,
};
