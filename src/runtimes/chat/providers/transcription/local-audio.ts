import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { getArchBinSuffix } from '../../../../lib/arch.ts';

const DEFAULT_MAX_BUFFER_BYTES = 20 * 1024 * 1024;
const KILL_GRACE_MS = 2_000;
const DEFAULT_EXECUTABLE_PATH = process.platform === 'darwin'
  ? ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(delimiter)
  : ['/usr/local/bin', '/usr/bin', '/bin'].join(delimiter);

export function extensionForMimeType(mimeType: string): string {
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'm4a';
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('wav')) return 'wav';
  return 'bin';
}

export function resolveBinaryPath(binary: string): string | null {
  const isExecutable = (candidate: string): boolean => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

  if (binary.includes('/')) {
    const candidate = resolve(binary);
    return isExecutable(candidate) ? candidate : null;
  }

  const pathDirs = (process.env.PATH ?? DEFAULT_EXECUTABLE_PATH).split(delimiter);
  for (const dir of pathDirs) {
    const candidate = resolve(dir || '.', binary);
    if (isExecutable(candidate)) return candidate;
  }

  // If the bare name is not on PATH, retry each directory with the arch
  // suffix (e.g. "ffmpeg-arm64") for hosts where prebuilt or Homebrew
  // binaries use arch-specific names. Explicit paths (with "/") are never
  // suffixed — the caller controls those.
  const archSuffix = getArchBinSuffix();
  if (archSuffix) {
    const archBinary = `${binary}${archSuffix}`;
    for (const dir of pathDirs) {
      const candidate = resolve(dir || '.', archBinary);
      if (isExecutable(candidate)) return candidate;
    }
  }

  return null;
}

export async function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const controller = new AbortController();
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: controller.signal,
      killSignal: 'SIGTERM',
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let pendingError: Error | null = null;
    let settled = false;
    let exited = false;
    let killTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
    };

    const rejectOnce = (error: Error) => {
      if (!pendingError) pendingError = error;
    };

    const requestTermination = (error: Error) => {
      rejectOnce(error);
      controller.abort();
      if (!killTimer) {
        killTimer = setTimeout(() => {
          if (!exited) child.kill('SIGKILL');
        }, KILL_GRACE_MS);
      }
    };

    const timeoutTimer = setTimeout(() => {
      requestTermination(new Error(`Command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buffer.length;
      stdoutChunks.push(buffer);
      if (stdoutBytes + stderrBytes > DEFAULT_MAX_BUFFER_BYTES) {
        requestTermination(new Error(`Command output exceeded ${DEFAULT_MAX_BUFFER_BYTES} bytes`));
      }
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += buffer.length;
      stderrChunks.push(buffer);
      if (stdoutBytes + stderrBytes > DEFAULT_MAX_BUFFER_BYTES) {
        requestTermination(new Error(`Command output exceeded ${DEFAULT_MAX_BUFFER_BYTES} bytes`));
      }
    });

    child.on('error', (error) => {
      if (error.name === 'AbortError') return;
      rejectOnce(new Error(error.message, { cause: error }));
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      exited = true;
      settled = true;
      cleanup();

      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');

      if (pendingError) {
        reject(pendingError);
        return;
      }

      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(
        stderr.trim() || stdout.trim() || `Command failed with code ${code ?? 'null'}${signal ? ` signal ${signal}` : ''}`,
      ));
    });
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
      // Untrusted-media hardening: `buffer` is attacker-controlled bytes (a
      // WhatsApp voice note) and ffmpeg auto-probes the container from CONTENT,
      // not the extension. A crafted concat/HLS payload would otherwise let
      // ffmpeg follow embedded file:// or http(s):// references (local-file read
      // / SSRF). Pin the input protocol whitelist to `file` so no demuxer can
      // reach off-disk, instead of relying on the host ffmpeg's implicit `safe`
      // default (which varies by version across the fleet). Placed before -i so
      // it governs the demuxer that opens the media.
      '-protocol_whitelist', 'file',
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
