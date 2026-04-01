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

import { downloadMedia } from '../../src/core/media-download.ts';

const MB = 1024 * 1024;

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

    expect(result).toBeNull();
  });

  it('returns null when the buffer exceeds 25MB', async () => {
    // 26 MB buffer — should be rejected
    const bigBuffer = Buffer.alloc(26 * MB, 0x00);
    const downloadFn = vi.fn().mockResolvedValue(bigBuffer);

    const result = await downloadMedia(downloadFn, 'video/mp4');

    expect(result).toBeNull();
  });

  it('returns null on unexpected error in download function', async () => {
    const downloadFn = vi.fn().mockRejectedValue(new Error('Network error'));

    const result = await downloadMedia(downloadFn, 'audio/ogg');

    expect(result).toBeNull();
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
