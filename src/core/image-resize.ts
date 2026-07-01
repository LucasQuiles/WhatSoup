// src/core/image-resize.ts
// Resize images that exceed Claude's dimension limits for multi-image sessions.
// Claude rejects turns when any image in a many-image request exceeds 2000px.
// We resize to MAX_DIMENSION (1920px — safe margin below 2000) on the longest edge,
// preserving aspect ratio. JPEG output for smaller file sizes.

import { createChildLogger } from '../logger.ts';

const log = createChildLogger('image-resize');

/** Claude's hard limit for multi-image requests. We use 1920 for safety margin. */
const MAX_DIMENSION = 1920;

/** Minimum size worth resizing — don't waste CPU on thumbnails. */
const MIN_SIZE_BYTES = 10_000;

/** Maximum time we'll spend resizing a single image. */
const RESIZE_TIMEOUT_MS = 15_000;

// QR-055: the 25MB download cap bounds only COMPRESSED bytes, not decoded pixels. A
// low-entropy decompression-bomb image (e.g. 13000x13000 = 169MP in <1MB) passes the
// byte cap, then sharp's toBuffer() decode forces a multi-hundred-MB libvips allocation
// (up to sharp's ~268MP default limitInputPixels). The RESIZE_TIMEOUT_MS race only
// abandons the await — it cannot cancel the in-flight libvips work. Bound the pixel
// count two ways: a hard sharp limitInputPixels (libvips rejects at decode), AND an
// explicit metadata dimension check that skips the expensive decode entirely (graceful
// degrade to the original — an over-cap image is left un-resized, same as the prior
// >2000px pass-through path). 50MP comfortably covers real photos (8K = ~33MP).
const MAX_INPUT_PIXELS = 50_000_000;

export interface ResizeResult {
  buffer: Buffer;
  mimeType: string;
  resized: boolean;
  originalWidth?: number;
  originalHeight?: number;
  finalWidth?: number;
  finalHeight?: number;
}

/**
 * Resize an image buffer if it exceeds MAX_DIMENSION on either axis.
 * Returns the original buffer untouched if no resize is needed or if
 * processing fails (graceful degradation — never block on resize errors).
 */
export async function resizeImageIfNeeded(
  buffer: Buffer,
  mimeType: string,
): Promise<ResizeResult> {
  // Only process image types
  if (!mimeType.startsWith('image/')) {
    return { buffer, mimeType, resized: false };
  }

  // Skip tiny images
  if (buffer.length < MIN_SIZE_BYTES) {
    return { buffer, mimeType, resized: false };
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    const result = await Promise.race([
      _doResize(buffer, mimeType),
      new Promise<ResizeResult>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('resize timeout')), RESIZE_TIMEOUT_MS);
      }),
    ]);
    return result;
  } catch (err) {
    log.warn({ err, mimeType, sizeBytes: buffer.length }, 'image resize failed — using original');
    return { buffer, mimeType, resized: false };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

async function _doResize(buffer: Buffer, mimeType: string): Promise<ResizeResult> {
  const { default: sharp } = await import('sharp');
  // limitInputPixels is a HARD backstop set ABOVE the explicit MAX_INPUT_PIXELS check below,
  // so metadata()/decode still succeed for images the explicit check handles gracefully
  // (with reported dimensions + a clear log), while libvips still throws "Input image exceeds
  // pixel limit" — caught by the outer try/catch → graceful degrade — for the rare case where
  // metadata reports no dimensions and the explicit check is bypassed. Bounds that edge's
  // decode at 2× the policy cap instead of sharp's ~268MP default.
  const image = sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS * 2 });
  const metadata = await image.metadata();

  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;

  // QR-055: reject decompression bombs BEFORE the expensive toBuffer() decode. metadata()
  // reads dimensions from the header without decoding pixels, so this is cheap; a small
  // compressed image can still declare a huge pixel count. Skip resize (degrade to original)
  // rather than allocate hundreds of MB for an image Claude would reject anyway.
  if (width * height > MAX_INPUT_PIXELS) {
    log.warn(
      { width, height, pixels: width * height, limit: MAX_INPUT_PIXELS, mimeType },
      'image exceeds pixel limit — skipping resize (decompression-bomb guard)',
    );
    return {
      buffer,
      mimeType,
      resized: false,
      originalWidth: width,
      originalHeight: height,
      finalWidth: width,
      finalHeight: height,
    };
  }

  // No resize needed
  if (width <= MAX_DIMENSION && height <= MAX_DIMENSION) {
    log.debug({ width, height, mimeType }, 'image within limits — no resize needed');
    return {
      buffer,
      mimeType,
      resized: false,
      originalWidth: width,
      originalHeight: height,
      finalWidth: width,
      finalHeight: height,
    };
  }

  // Resize: fit within MAX_DIMENSION × MAX_DIMENSION, preserving aspect ratio.
  // Preserve WebP format for stickers/webp inputs (animated stickers lose frames
  // if converted to JPEG). All other formats output as JPEG for size efficiency.
  let pipeline = image.resize(MAX_DIMENSION, MAX_DIMENSION, {
    fit: 'inside',
    withoutEnlargement: true,
  });
  let outputMime: string;
  if (mimeType === 'image/webp') {
    pipeline = pipeline.webp({ quality: 85 });
    outputMime = 'image/webp';
  } else {
    pipeline = pipeline.jpeg({ quality: 85, mozjpeg: true });
    outputMime = 'image/jpeg';
  }
  const resized = await pipeline.toBuffer({ resolveWithObject: true });

  log.info(
    {
      originalWidth: width,
      originalHeight: height,
      finalWidth: resized.info.width,
      finalHeight: resized.info.height,
      originalBytes: buffer.length,
      resizedBytes: resized.data.length,
      reduction: `${Math.round((1 - resized.data.length / buffer.length) * 100)}%`,
    },
    'image resized for Claude compatibility',
  );

  return {
    buffer: resized.data,
    mimeType: outputMime,
    resized: true,
    originalWidth: width,
    originalHeight: height,
    finalWidth: resized.info.width,
    finalHeight: resized.info.height,
  };
}
