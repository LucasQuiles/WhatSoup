import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function extensionForMimeType(mimeType: string): string {
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'm4a';
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('wav')) return 'wav';
  return 'bin';
}

export function resolveBinaryPath(binary: string): string | null {
  if (binary.includes('/')) return existsSync(binary) ? binary : null;

  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']) {
    const candidate = join(dir, binary);
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

export async function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const wrapped = new Error(
            stderr?.trim() || stdout?.trim() || error.message,
            { cause: error },
          );
          reject(wrapped);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

export async function withNormalizedAudioFile<T>(
  buffer: Buffer,
  mimeType: string,
  fn: (wavPath: string) => Promise<T>,
): Promise<T> {
  const ffmpeg = resolveBinaryPath('ffmpeg');
  if (!ffmpeg) throw new Error('ffmpeg is not installed');

  const dir = await mkdtemp(join(tmpdir(), 'whatsoup-transcription-'));
  const inputPath = join(dir, `input.${extensionForMimeType(mimeType)}`);
  const wavPath = join(dir, 'normalized.wav');

  try {
    await writeFile(inputPath, buffer);
    await runCommand(ffmpeg, [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', inputPath,
      '-ar', '16000',
      '-ac', '1',
      wavPath,
    ], 30_000);
    return await fn(wavPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
