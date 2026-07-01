import { describe, it, expect, vi, beforeEach } from 'vitest';
import sharp from 'sharp';

// Mock the logger before importing the module under test
vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { resizeImageIfNeeded, type ResizeResult } from '../../src/core/image-resize.ts';

/** Create a real PNG buffer of given dimensions. */
const makeImage = (w: number, h: number, format: 'png' | 'webp' | 'jpeg' = 'png') => {
  const pipeline = sharp({
    create: { width: w, height: h, channels: 3, background: { r: 255, g: 0, b: 0 } },
  });
  switch (format) {
    case 'webp':
      return pipeline.webp().toBuffer();
    case 'jpeg':
      return pipeline.jpeg().toBuffer();
    default:
      return pipeline.png().toBuffer();
  }
};

/**
 * Create a buffer guaranteed to be >= minBytes.
 * We generate a large-enough image — sharp's PNG output for big dimensions exceeds 10KB easily.
 */
const makeLargeImage = async (w: number, h: number, format: 'png' | 'webp' | 'jpeg' = 'png') => {
  const buf = await makeImage(w, h, format);
  // If by some compression miracle the buffer is < 10KB, pad it
  if (buf.length < 10_000) {
    return Buffer.concat([buf, Buffer.alloc(10_000 - buf.length)]);
  }
  return buf;
};

describe('resizeImageIfNeeded', () => {
  // ── 1. Non-image MIME → skip ──
  describe('non-image MIME types', () => {
    it('returns resized: false for application/pdf', async () => {
      const buf = Buffer.alloc(20_000);
      const result = await resizeImageIfNeeded(buf, 'application/pdf');
      expect(result.resized).toBe(false);
      expect(result.buffer).toBe(buf); // exact same reference
      expect(result.mimeType).toBe('application/pdf');
    });

    it('returns resized: false for text/plain', async () => {
      const buf = Buffer.alloc(20_000);
      const result = await resizeImageIfNeeded(buf, 'text/plain');
      expect(result.resized).toBe(false);
      expect(result.buffer).toBe(buf);
    });

    it('returns resized: false for video/mp4', async () => {
      const buf = Buffer.alloc(20_000);
      const result = await resizeImageIfNeeded(buf, 'video/mp4');
      expect(result.resized).toBe(false);
    });
  });

  // ── 2. Small buffer (<10KB) → skip ──
  describe('small buffers', () => {
    it('skips buffers under 10KB even if image MIME', async () => {
      const buf = Buffer.alloc(9_999); // just under threshold
      const result = await resizeImageIfNeeded(buf, 'image/png');
      expect(result.resized).toBe(false);
      expect(result.buffer).toBe(buf);
    });

    it('skips exact 9999-byte buffer', async () => {
      const buf = Buffer.alloc(9_999);
      const result = await resizeImageIfNeeded(buf, 'image/jpeg');
      expect(result.resized).toBe(false);
    });

    it('skips empty buffer', async () => {
      const buf = Buffer.alloc(0);
      const result = await resizeImageIfNeeded(buf, 'image/png');
      expect(result.resized).toBe(false);
    });
  });

  // ── 3. Within 1920px on both axes → no resize, metadata populated ──
  describe('images within 1920px limits', () => {
    it('does not resize a 800x600 image', async () => {
      const buf = await makeLargeImage(800, 600);
      const result = await resizeImageIfNeeded(buf, 'image/png');
      expect(result.resized).toBe(false);
      expect(result.buffer).toBe(buf);
      expect(result.originalWidth).toBe(800);
      expect(result.originalHeight).toBe(600);
      expect(result.finalWidth).toBe(800);
      expect(result.finalHeight).toBe(600);
    });

    it('does not resize a 1920x1080 image', async () => {
      const buf = await makeLargeImage(1920, 1080);
      const result = await resizeImageIfNeeded(buf, 'image/png');
      expect(result.resized).toBe(false);
      expect(result.originalWidth).toBe(1920);
      expect(result.originalHeight).toBe(1080);
    });
  });

  // ── 6. Exactly 1920x1920 → NOT resized ──
  describe('boundary: exactly 1920x1920', () => {
    it('does not resize 1920x1920 (at limit, not over)', async () => {
      const buf = await makeLargeImage(1920, 1920);
      const result = await resizeImageIfNeeded(buf, 'image/png');
      expect(result.resized).toBe(false);
      expect(result.originalWidth).toBe(1920);
      expect(result.originalHeight).toBe(1920);
      expect(result.finalWidth).toBe(1920);
      expect(result.finalHeight).toBe(1920);
    });
  });

  // ── 4. Landscape oversized: 3000x2000 → 1920x1280 ──
  describe('landscape oversized image', () => {
    it('resizes 3000x2000 to 1920x1280', async () => {
      const buf = await makeLargeImage(3000, 2000);
      const result = await resizeImageIfNeeded(buf, 'image/png');
      expect(result.resized).toBe(true);
      expect(result.originalWidth).toBe(3000);
      expect(result.originalHeight).toBe(2000);
      expect(result.finalWidth).toBe(1920);
      expect(result.finalHeight).toBe(1280);
      expect(result.mimeType).toBe('image/jpeg'); // non-webp → JPEG output
    });
  });

  // ── 5. Portrait oversized: 2000x3000 → 1280x1920 ──
  describe('portrait oversized image', () => {
    it('resizes 2000x3000 to 1280x1920', async () => {
      const buf = await makeLargeImage(2000, 3000);
      const result = await resizeImageIfNeeded(buf, 'image/png');
      expect(result.resized).toBe(true);
      expect(result.originalWidth).toBe(2000);
      expect(result.originalHeight).toBe(3000);
      expect(result.finalWidth).toBe(1280);
      expect(result.finalHeight).toBe(1920);
      expect(result.mimeType).toBe('image/jpeg');
    });
  });

  // ── 7. WebP input → resized to WebP (not JPEG) ──
  describe('WebP format preservation', () => {
    it('outputs WebP when input is image/webp', async () => {
      const buf = await makeLargeImage(3000, 2000, 'webp');
      const result = await resizeImageIfNeeded(buf, 'image/webp');
      expect(result.resized).toBe(true);
      expect(result.mimeType).toBe('image/webp');
      expect(result.finalWidth).toBe(1920);
      expect(result.finalHeight).toBe(1280);

      // Verify the output buffer is actually WebP
      const meta = await sharp(result.buffer).metadata();
      expect(meta.format).toBe('webp');
    });
  });

  // ── 8. JPEG input → resized to JPEG ──
  describe('JPEG format output', () => {
    it('outputs JPEG for JPEG input', async () => {
      const buf = await makeLargeImage(3000, 2000, 'jpeg');
      const result = await resizeImageIfNeeded(buf, 'image/jpeg');
      expect(result.resized).toBe(true);
      expect(result.mimeType).toBe('image/jpeg');

      // Verify the output buffer is actually JPEG
      const meta = await sharp(result.buffer).metadata();
      expect(meta.format).toBe('jpeg');
    });

    it('outputs JPEG for PNG input (non-webp → JPEG)', async () => {
      const buf = await makeLargeImage(3000, 2000, 'png');
      const result = await resizeImageIfNeeded(buf, 'image/png');
      expect(result.resized).toBe(true);
      expect(result.mimeType).toBe('image/jpeg');

      const meta = await sharp(result.buffer).metadata();
      expect(meta.format).toBe('jpeg');
    });
  });

  // ── 9. Corrupt buffer → returns original, resized: false ──
  describe('corrupt/invalid image data', () => {
    it('returns original buffer on corrupt data', async () => {
      const buf = Buffer.alloc(20_000, 0xff); // garbage bytes, large enough
      const result = await resizeImageIfNeeded(buf, 'image/png');
      expect(result.resized).toBe(false);
      expect(result.buffer).toBe(buf);
      expect(result.mimeType).toBe('image/png');
    });

    it('returns original buffer for random noise', async () => {
      const buf = Buffer.from(Array.from({ length: 15_000 }, () => Math.floor(Math.random() * 256)));
      const result = await resizeImageIfNeeded(buf, 'image/jpeg');
      expect(result.resized).toBe(false);
      expect(result.buffer).toBe(buf);
    });
  });

  describe('sharp load failure', () => {
    it('returns the original image when sharp cannot be imported', async () => {
      vi.resetModules();
      vi.doMock('sharp', () => {
        throw new Error('sharp native module unavailable');
      });

      try {
        const { resizeImageIfNeeded: resizeWithBrokenSharp } = await import('../../src/core/image-resize.ts');
        const buf = Buffer.alloc(20_000, 0xaa);

        const result = await resizeWithBrokenSharp(buf, 'image/png');

        expect(result).toEqual({
          buffer: buf,
          mimeType: 'image/png',
          resized: false,
        });
      } finally {
        vi.doUnmock('sharp');
        vi.resetModules();
      }
    });
  });

  // ── 10. Result metadata populated correctly ──
  describe('metadata population', () => {
    it('populates all metadata fields on resize', async () => {
      const buf = await makeLargeImage(4000, 2000);
      const result = await resizeImageIfNeeded(buf, 'image/png');
      expect(result.resized).toBe(true);
      expect(result.originalWidth).toBe(4000);
      expect(result.originalHeight).toBe(2000);
      expect(result.finalWidth).toBe(1920);
      expect(result.finalHeight).toBe(960);
      expect(result.mimeType).toBe('image/jpeg');
      expect(result.buffer).not.toBe(buf); // different buffer
      expect(result.buffer.length).toBeGreaterThan(0);
    });

    it('populates metadata even when no resize needed', async () => {
      const buf = await makeLargeImage(1000, 500);
      const result = await resizeImageIfNeeded(buf, 'image/png');
      expect(result.resized).toBe(false);
      expect(result.originalWidth).toBe(1000);
      expect(result.originalHeight).toBe(500);
      expect(result.finalWidth).toBe(1000);
      expect(result.finalHeight).toBe(500);
    });

    it('does not populate metadata for non-image MIME', async () => {
      const buf = Buffer.alloc(20_000);
      const result = await resizeImageIfNeeded(buf, 'application/octet-stream');
      expect(result).toEqual({
        buffer: buf,
        mimeType: 'application/octet-stream',
        resized: false,
      });
    });

    it('does not populate metadata for small buffer skip', async () => {
      const buf = Buffer.alloc(5_000);
      const result = await resizeImageIfNeeded(buf, 'image/png');
      expect(result).toEqual({
        buffer: buf,
        mimeType: 'image/png',
        resized: false,
      });
    });
  });

  // ── Edge cases ──
  describe('edge cases', () => {
    it('handles 1921x1 (just over on width)', async () => {
      const buf = await makeLargeImage(1921, 100);
      const result = await resizeImageIfNeeded(buf, 'image/png');
      expect(result.resized).toBe(true);
      expect(result.finalWidth).toBe(1920);
      // Height should be scaled proportionally
      expect(result.finalHeight).toBeLessThanOrEqual(100);
    });

    it('handles 1x1921 (just over on height)', async () => {
      const buf = await makeLargeImage(100, 1921);
      const result = await resizeImageIfNeeded(buf, 'image/png');
      expect(result.resized).toBe(true);
      expect(result.finalHeight).toBe(1920);
      expect(result.finalWidth).toBeLessThanOrEqual(100);
    });

    it('handles square oversized image', async () => {
      const buf = await makeLargeImage(3000, 3000);
      const result = await resizeImageIfNeeded(buf, 'image/png');
      expect(result.resized).toBe(true);
      expect(result.finalWidth).toBe(1920);
      expect(result.finalHeight).toBe(1920);
    });

    it('resized buffer is smaller or similar in size', async () => {
      const buf = await makeLargeImage(4000, 3000, 'png');
      const result = await resizeImageIfNeeded(buf, 'image/png');
      expect(result.resized).toBe(true);
      // JPEG output from a large PNG should generally be smaller
      expect(result.buffer.length).toBeLessThan(buf.length);
    });
  });

  // ── QR-055: decompression-bomb pixel guard ──
  describe('decompression-bomb pixel guard (QR-055)', () => {
    it('skips resize (degrades to original) for an image exceeding the pixel cap, without decoding it', async () => {
      // ~50.4MP (8000x6300) — over the 50MP cap. A solid-colour PNG of these dimensions is
      // small compressed (a decompression bomb passes the 25MB byte cap), but decoding it
      // would force a ~150MB+ libvips allocation. The guard must skip the decode.
      const buf = await makeLargeImage(8000, 6300, 'png');

      const result = await resizeImageIfNeeded(buf, 'image/png');

      // Defect (unfixed): proceeds to toBuffer() and returns resized:true after a 50MP decode.
      // Fixed: the metadata dimension check skips the decode → resized:false, original buffer.
      expect(result.resized).toBe(false);
      expect(result.buffer).toBe(buf);
      expect(result.originalWidth).toBe(8000);
      expect(result.originalHeight).toBe(6300);
    });

    it('still resizes a large-but-under-cap image (guard does not over-trigger)', async () => {
      // 4000x3000 = 12MP, well under the 50MP cap but over the 1920px dimension → resizes.
      const buf = await makeLargeImage(4000, 3000, 'png');
      const result = await resizeImageIfNeeded(buf, 'image/png');
      expect(result.resized).toBe(true);
      expect(result.finalWidth).toBeLessThanOrEqual(1920);
    });
  });
});
