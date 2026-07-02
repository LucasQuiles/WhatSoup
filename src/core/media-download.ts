import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from '../config.ts';
import { createChildLogger } from '../logger.ts';
import { resizeImageIfNeeded } from './image-resize.ts';

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
  // No mp4/ftyp entry: a 3-null-byte prefix matched the ftyp box-size of every
  // M4A voice note (audio/mp4), firing a false MIME-mismatch warning, and the
  // ftyp container cannot distinguish audio/mp4 from video/mp4 anyway. Anomaly
  // detection for mp4 is unreliable — rely on the declared MIME type (#1072).
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
  declaredSizeBytes?: number,
): Promise<MediaDownload | null> {
  // QR-057: reject BEFORE buffering when the server-declared fileLength already exceeds the
  // cap. The post-download check below (buffer.length) is a fail-safe that fires only after
  // downloadMediaMessage has fully buffered the blob into memory (no streaming abort); this
  // pre-check avoids that allocation for honest large media. Same media is rejected either
  // way — no behavioural change, just earlier. An understated fileLength still falls through
  // to the post-download cap (bounded by the 30s timeout + WhatsApp's upload ceiling).
  if (declaredSizeBytes !== undefined && declaredSizeBytes > MAX_SIZE_BYTES) {
    log.warn(
      { mimeType, declaredSizeBytes, maxBytes: MAX_SIZE_BYTES },
      'Media download rejected pre-fetch — declared fileLength exceeds 25MB limit',
    );
    return null;
  }

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

    // QR-097: type-confusion reject. If the bytes are a RECOGNIZED non-image
    // (e.g. application/pdf, audio/ogg) but the declared MIME is image/*, this is
    // malformed or hostile — feeding those bytes to the image resizer would hand
    // a PDF/other payload to a libvips loader under an image pretext. Drop it
    // before decode. Zero legitimate-traffic impact: a real image's magic bytes
    // are png/jpeg/gif/webp (detected as image/*) or unrecognized (null, left to
    // the resizer as before) — never a known non-image type.
    if (detectedMime !== null && !detectedMime.startsWith('image/') && mimeType.startsWith('image/')) {
      log.warn(
        { declared: mimeType, detected: detectedMime, sizeBytes: buffer.length },
        'Media type-confusion rejected — declared image/* but bytes are a recognized non-image',
      );
      return null;
    }

    log.info({ mimeType, sizeBytes: buffer.length, durationMs }, 'Media downloaded');

    // Resize images that exceed Claude's 2000px multi-image limit
    if (mimeType.startsWith('image/')) {
      const resized = await resizeImageIfNeeded(buffer, mimeType);
      return { buffer: resized.buffer, mimeType: resized.mimeType };
    }

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
