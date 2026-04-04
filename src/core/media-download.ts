import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from '../config.ts';
import { createChildLogger } from '../logger.ts';

const log = createChildLogger('media:download');

const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_SIZE_BYTES = 25 * 1024 * 1024;

export interface MediaDownload {
  buffer: Buffer;
  mimeType: string;
}

export async function downloadMedia(
  downloadFn: () => Promise<Buffer>,
  mimeType: string,
): Promise<MediaDownload | null> {
  const startMs = Date.now();
  try {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Download timed out after 30s')), DOWNLOAD_TIMEOUT_MS),
    );

    const buffer = await Promise.race([downloadFn(), timeoutPromise]);

    if (buffer.length > MAX_SIZE_BYTES) {
      log.warn(
        { mimeType, sizeBytes: buffer.length, maxBytes: MAX_SIZE_BYTES },
        'Media download rejected — exceeds 25MB limit',
      );
      return null;
    }

    const durationMs = Date.now() - startMs;
    log.info({ mimeType, sizeBytes: buffer.length, durationMs }, 'Media downloaded');
    return { buffer, mimeType };
  } catch (err) {
    log.error({ err, mimeType, durationMs: Date.now() - startMs }, 'Media download failed');
    return null;
  }
}

export function writeTempFile(buffer: Buffer, ext: string): string {
  mkdirSync(config.mediaDir, { recursive: true, mode: 0o700 });
  const name = randomBytes(8).toString('hex');
  const filePath = join(config.mediaDir, `${name}.${ext}`);
  writeFileSync(filePath, buffer, { mode: 0o600 });
  return filePath;
}

export function cleanupTempFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // best-effort
  }
}
