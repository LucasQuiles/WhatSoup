import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config and logger — download.ts imports both
vi.mock('../../src/config.ts', () => ({
  config: {
    mediaDir: '/tmp',
    adminPhones: new Set(['15550100001']),
    accessMode: 'allowlist',
    healthPort: 9090,
    models: {
      conversation: 'claude-opus-4-5',
      extraction: 'claude-haiku-4-5',
      validation: 'claude-haiku-4-5',
      fallback: 'claude-sonnet-4-5',
    },
  },
}));

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock fs so writeTempFile doesn't actually write to disk
vi.mock('node:fs', () => ({
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

const mockResizeImageIfNeeded = vi.fn();
vi.mock('../../src/core/image-resize.ts', () => ({
  resizeImageIfNeeded: (...args: any[]) => mockResizeImageIfNeeded(...args),
}));

import { unlinkSync } from 'node:fs';
import { downloadMedia, detectMime, cleanupTempFile } from '../../src/core/media-download.ts';

const MB = 1024 * 1024;

// Default: resize mock passes through the buffer unchanged
beforeEach(() => {
  mockResizeImageIfNeeded.mockReset();
  mockResizeImageIfNeeded.mockImplementation(async (buf: Buffer, mime: string) => ({
    buffer: buf,
    mimeType: mime,
    resized: false,
  }));
});

describe('downloadMedia — positive', () => {
  it('returns buffer and mimeType on success', async () => {
    const fakeBuffer = Buffer.alloc(1024, 0x42); // 1 KB
    const downloadFn = vi.fn().mockResolvedValue(fakeBuffer);

    const result = await downloadMedia(downloadFn, 'image/jpeg');

    expect(result).not.toBeNull();
    expect(result!.buffer).toBe(fakeBuffer);
    expect(result!.mimeType).toBe('image/jpeg');
    expect(downloadFn).toHaveBeenCalledOnce();
  });
});

describe('downloadMedia — negative', () => {
  it('returns null when download function rejects (simulates timeout)', async () => {
    const downloadFn = vi.fn().mockRejectedValue(new Error('Download timed out after 30s'));

    const result = await downloadMedia(downloadFn, 'image/jpeg');

    expect(result).toStrictEqual(null);
  });

  it('returns null when the buffer exceeds 25MB', async () => {
    // 26 MB buffer — should be rejected
    const bigBuffer = Buffer.alloc(26 * MB, 0x00);
    const downloadFn = vi.fn().mockResolvedValue(bigBuffer);

    const result = await downloadMedia(downloadFn, 'video/mp4');

    expect(result).toStrictEqual(null);
  });

  it('returns null on unexpected error in download function', async () => {
    const downloadFn = vi.fn().mockRejectedValue(new Error('Network error'));

    const result = await downloadMedia(downloadFn, 'audio/ogg');

    expect(result).toStrictEqual(null);
  });

  it('accepts buffers exactly at the 25MB boundary', async () => {
    // Exactly 25 MB — should be accepted (boundary is >25MB not >=)
    const exactBuffer = Buffer.alloc(25 * MB, 0x00);
    const downloadFn = vi.fn().mockResolvedValue(exactBuffer);

    const result = await downloadMedia(downloadFn, 'application/pdf');

    expect(result).not.toBeNull();
    expect(result!.buffer.length).toBe(25 * MB);
  });
});

describe('downloadMedia — QR-057 pre-fetch fileLength guard', () => {
  it('rejects BEFORE invoking the download function when declared fileLength exceeds the cap', async () => {
    const downloadFn = vi.fn().mockResolvedValue(Buffer.alloc(1024));

    const result = await downloadMedia(downloadFn, 'video/mp4', 100 * MB);

    expect(result).toStrictEqual(null);
    // The whole point: the blob is never buffered into memory.
    expect(downloadFn).not.toHaveBeenCalled();
  });

  it('proceeds normally when declared fileLength is under the cap', async () => {
    const fakeBuffer = Buffer.alloc(2048, 0x42);
    const downloadFn = vi.fn().mockResolvedValue(fakeBuffer);

    const result = await downloadMedia(downloadFn, 'audio/ogg', 1 * MB);

    expect(result).not.toBeNull();
    expect(result!.buffer).toBe(fakeBuffer);
    expect(downloadFn).toHaveBeenCalledOnce();
  });

  it('proceeds (back-compat) when declared fileLength is omitted', async () => {
    const fakeBuffer = Buffer.alloc(512, 0x42);
    const downloadFn = vi.fn().mockResolvedValue(fakeBuffer);

    const result = await downloadMedia(downloadFn, 'image/jpeg');

    expect(result).not.toBeNull();
    expect(downloadFn).toHaveBeenCalledOnce();
  });
});

describe('downloadMedia — image resize integration', () => {
  it('calls resizeImageIfNeeded with correct args for image downloads', async () => {
    const fakeBuffer = Buffer.alloc(1024, 0x42);
    const resizedBuffer = Buffer.from('resized');
    const downloadFn = vi.fn().mockResolvedValue(fakeBuffer);
    mockResizeImageIfNeeded.mockResolvedValue({
      buffer: resizedBuffer,
      mimeType: 'image/jpeg',
      resized: true,
    });

    await downloadMedia(downloadFn, 'image/jpeg');

    expect(mockResizeImageIfNeeded).toHaveBeenCalledOnce();
    expect(mockResizeImageIfNeeded).toHaveBeenCalledWith(fakeBuffer, 'image/jpeg');
  });

  it('does NOT call resizeImageIfNeeded for non-image MIME types', async () => {
    const fakeBuffer = Buffer.alloc(512, 0x00);
    const downloadFn = vi.fn().mockResolvedValue(fakeBuffer);

    await downloadMedia(downloadFn, 'audio/ogg');

    expect(mockResizeImageIfNeeded).not.toHaveBeenCalled();
  });

  it('returns the MIME type from resize output', async () => {
    const fakeBuffer = Buffer.alloc(1024, 0x42);
    const downloadFn = vi.fn().mockResolvedValue(fakeBuffer);
    mockResizeImageIfNeeded.mockResolvedValue({
      buffer: Buffer.from('converted'),
      mimeType: 'image/jpeg',
      resized: true,
    });

    const result = await downloadMedia(downloadFn, 'image/png');

    expect(result).not.toBeNull();
    expect(result!.mimeType).toBe('image/jpeg');
  });

  it('returns original buffer when resize reports {resized: false}', async () => {
    const fakeBuffer = Buffer.alloc(1024, 0x42);
    const downloadFn = vi.fn().mockResolvedValue(fakeBuffer);
    mockResizeImageIfNeeded.mockResolvedValue({
      buffer: fakeBuffer,
      mimeType: 'image/jpeg',
      resized: false,
    });

    const result = await downloadMedia(downloadFn, 'image/jpeg');

    expect(result).not.toBeNull();
    expect(result!.buffer).toBe(fakeBuffer);
    expect(result!.mimeType).toBe('image/jpeg');
  });
});

describe('detectMime', () => {
  // Regression guard for #1072: an M4A voice note (audio/mp4) begins with the
  // ftyp box whose first 3 bytes are 0x00 0x00 0x00. The old 3-null-byte
  // video/mp4 signature matched it, producing a false MIME-mismatch warning.
  it('does not misdetect an M4A/ftyp buffer as video/mp4', () => {
    const m4a = Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
    expect(detectMime(m4a)).not.toBe('video/mp4');
  });

  it('still detects the unambiguous signatures', () => {
    expect(detectMime(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png');
    expect(detectMime(Buffer.from([0xff, 0xd8, 0xff]))).toBe('image/jpeg');
    expect(detectMime(Buffer.from([0x4f, 0x67, 0x67, 0x53]))).toBe('audio/ogg');
    expect(detectMime(Buffer.from([0x25, 0x50, 0x44, 0x46]))).toBe('application/pdf');
  });
});

describe('downloadMedia — MIME mismatch warning', () => {
  it('warns (and still returns) when magic bytes disagree with the declared type', async () => {
    // PNG magic bytes declared as a PDF → detectMime !== mimeType → mismatch branch (line 68 true).
    // Non-image declared type so it returns directly without the resize path.
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const downloadFn = vi.fn().mockResolvedValue(pngBytes);

    const result = await downloadMedia(downloadFn, 'application/pdf');

    expect(result).not.toBeNull();
    expect(result!.mimeType).toBe('application/pdf');
    expect(result!.buffer).toBe(pngBytes);
  });

  it('does not warn when magic bytes match the declared type', async () => {
    // PNG magic declared as image/png → detected === declared → mismatch `!==` false arm.
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const downloadFn = vi.fn().mockResolvedValue(pngBytes);

    const result = await downloadMedia(downloadFn, 'image/png');

    expect(result).not.toBeNull();
  });
});

describe('cleanupTempFile', () => {
  beforeEach(() => {
    vi.mocked(unlinkSync).mockReset();
  });

  it('unlinks the file on the happy path', () => {
    expect(() => cleanupTempFile('/tmp/whatsoup-media/x.ogg')).not.toThrow();
    expect(unlinkSync).toHaveBeenCalledWith('/tmp/whatsoup-media/x.ogg');
  });

  it('swallows errors when unlink fails (best-effort)', () => {
    vi.mocked(unlinkSync).mockImplementationOnce(() => {
      throw new Error('ENOENT: file already gone');
    });
    expect(() => cleanupTempFile('/tmp/whatsoup-media/missing.ogg')).not.toThrow();
  });
});
