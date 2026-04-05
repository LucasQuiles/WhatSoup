import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from '../config.ts';
import { createChildLogger } from '../logger.ts';

const log = createChildLogger('media:download');

const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_SIZE_BYTES = 25 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Magic-byte MIME detection (first 16 bytes)
// ---------------------------------------------------------------------------

const SIGNATURES: Array<[string, Buffer]> = [
  ['image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47])],
  ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff])],
  ['image/gif', Buffer.from([0x47, 0x49, 0x46])],
  ['image/webp', Buffer.from([0x52, 0x49, 0x46, 0x46])], // RIFF
  ['application/pdf', Buffer.from([0x25, 0x50, 0x44, 0x46])],
  ['video/mp4', Buffer.from([0x00, 0x00, 0x00])], // ftyp at offset 4
  ['audio/ogg', Buffer.from([0x4f, 0x67, 0x67, 0x53])],
];

export function detectMime(buf: Buffer): string | null {
  for (const [mime, sig] of SIGNATURES) {
    if (buf.length >= sig.length && buf.subarray(0, sig.length).equals(sig)) return mime;
  }
  return null;
}

export interface MediaDownload {
  buffer: Buffer;
  mimeType: string;
}

export async function downloadMedia(
  downloadFn: () => Promise<Buffer>,
  mimeType: string,
): Promise<MediaDownload | null> {
  const startMs = Date.now();
  let handle: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      handle = setTimeout(() => reject(new Error('Download timed out after 30s')), DOWNLOAD_TIMEOUT_MS);
    });

    const buffer = await Promise.race([downloadFn(), timeoutPromise]);

    if (buffer.length > MAX_SIZE_BYTES) {
      log.warn(
        { mimeType, sizeBytes: buffer.length, maxBytes: MAX_SIZE_BYTES },
        'Media download rejected — exceeds 25MB limit',
      );
      return null;
    }

    const durationMs = Date.now() - startMs;

    // Magic-byte validation: warn if declared MIME disagrees with file signature
    const detectedMime = detectMime(buffer);
    if (detectedMime && detectedMime !== mimeType) {
      log.warn(
        { declared: mimeType, detected: detectedMime, sizeBytes: buffer.length },
        'Media MIME mismatch — declared type differs from magic bytes',
      );
    }

    log.info({ mimeType, sizeBytes: buffer.length, durationMs }, 'Media downloaded');
    return { buffer, mimeType };
  } catch (err) {
    log.error({ err, mimeType, durationMs: Date.now() - startMs }, 'Media download failed');
    return null;
  } finally {
    if (handle) clearTimeout(handle);
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
