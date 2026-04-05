import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('../../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock media-download module
vi.mock('../../../../src/core/media-download.ts', () => ({
  downloadMedia: vi.fn(),
  writeTempFile: vi.fn(),
}));

// Mock messages module
vi.mock('../../../../src/core/messages.ts', () => ({
  updateMediaPath: vi.fn(),
}));

// Mock transcribeAudio
vi.mock('../../../../src/runtimes/chat/providers/whisper.ts', () => ({
  transcribeAudio: vi.fn(),
}));

// Mock video frames
vi.mock('../../../../src/runtimes/chat/media/video.ts', () => ({
  extractFrames: vi.fn(),
}));

// Mock links
vi.mock('../../../../src/runtimes/chat/media/links.ts', () => ({
  extractUrls: vi.fn(() => []),
  extractLinkContent: vi.fn(),
}));

// Mock documents
vi.mock('../../../../src/runtimes/chat/media/documents.ts', () => ({
  extractDocumentText: vi.fn(),
}));

// Mock media-mime
vi.mock('../../../../src/core/media-mime.ts', () => ({
  extractRawMime: vi.fn(() => null),
}));

import { processMedia } from '../../../../src/runtimes/chat/media/processor.ts';
import { downloadMedia, writeTempFile } from '../../../../src/core/media-download.ts';
import { updateMediaPath } from '../../../../src/core/messages.ts';
import { transcribeAudio } from '../../../../src/runtimes/chat/providers/whisper.ts';
import { extractFrames } from '../../../../src/runtimes/chat/media/video.ts';
import { extractDocumentText } from '../../../../src/runtimes/chat/media/documents.ts';
import type { IncomingMessage } from '../../../../src/core/types.ts';
import type { Database } from '../../../../src/core/database.ts';

const makeMsg = (overrides: Partial<IncomingMessage> = {}): IncomingMessage => ({
  messageId: 'test-msg-id',
  chatJid: 'chat@s.whatsapp.net',
  senderJid: 'sender@s.whatsapp.net',
  senderName: 'Test Sender',
  content: null,
  contentType: 'text',
  isFromMe: false,
  isGroup: false,
  mentionedJids: [],
  timestamp: 1234567890,
  quotedMessageId: null,
  isResponseWorthy: true,
  ...overrides,
});

const makeDb = (): Database =>
  ({ raw: {} }) as unknown as Database;

const makeDownloadFn = (buf: Buffer) => vi.fn(async () => buf);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('processMedia — disk persistence', () => {
  describe('image', () => {
    it('calls writeTempFile and updateMediaPath after successful download', async () => {
      const buf = Buffer.from('fake-image');
      vi.mocked(downloadMedia).mockResolvedValue({ buffer: buf, mimeType: 'image/jpeg' });
      vi.mocked(writeTempFile).mockReturnValue('/tmp/abc123.jpg');

      const db = makeDb();
      const msg = makeMsg({ contentType: 'image', messageId: 'img-001' });
      const result = await processMedia(msg, makeDownloadFn(buf), db, 'img-001');

      expect(writeTempFile).toHaveBeenCalledWith(buf, 'jpg');
      expect(updateMediaPath).toHaveBeenCalledWith(db, 'img-001', '/tmp/abc123.jpg');
      expect(result.images).toHaveLength(1);
    });

    it('does NOT call writeTempFile or updateMediaPath when db is missing', async () => {
      const buf = Buffer.from('fake-image');
      vi.mocked(downloadMedia).mockResolvedValue({ buffer: buf, mimeType: 'image/jpeg' });

      const msg = makeMsg({ contentType: 'image' });
      await processMedia(msg, makeDownloadFn(buf));

      expect(writeTempFile).not.toHaveBeenCalled();
      expect(updateMediaPath).not.toHaveBeenCalled();
    });

    it('does NOT call writeTempFile or updateMediaPath when messageId is missing', async () => {
      const buf = Buffer.from('fake-image');
      vi.mocked(downloadMedia).mockResolvedValue({ buffer: buf, mimeType: 'image/jpeg' });

      const db = makeDb();
      const msg = makeMsg({ contentType: 'image' });
      await processMedia(msg, makeDownloadFn(buf), db, undefined);

      expect(writeTempFile).not.toHaveBeenCalled();
      expect(updateMediaPath).not.toHaveBeenCalled();
    });
  });

  describe('sticker', () => {
    it('uses webp extension for sticker', async () => {
      const buf = Buffer.from('fake-sticker');
      vi.mocked(downloadMedia).mockResolvedValue({ buffer: buf, mimeType: 'image/webp' });
      vi.mocked(writeTempFile).mockReturnValue('/tmp/sticker.webp');

      const db = makeDb();
      const msg = makeMsg({ contentType: 'sticker', messageId: 'sticker-001' });
      await processMedia(msg, makeDownloadFn(buf), db, 'sticker-001');

      expect(writeTempFile).toHaveBeenCalledWith(buf, 'webp');
      expect(updateMediaPath).toHaveBeenCalledWith(db, 'sticker-001', '/tmp/sticker.webp');
    });
  });

  describe('audio', () => {
    it('calls writeTempFile with ogg extension and persists path', async () => {
      const buf = Buffer.from('fake-audio');
      vi.mocked(downloadMedia).mockResolvedValue({ buffer: buf, mimeType: 'audio/ogg' });
      vi.mocked(writeTempFile).mockReturnValue('/tmp/audio.ogg');
      vi.mocked(transcribeAudio).mockResolvedValue('hello world');

      const db = makeDb();
      const msg = makeMsg({ contentType: 'audio', messageId: 'audio-001' });
      await processMedia(msg, makeDownloadFn(buf), db, 'audio-001');

      expect(writeTempFile).toHaveBeenCalledWith(buf, 'ogg');
      expect(updateMediaPath).toHaveBeenCalledWith(db, 'audio-001', '/tmp/audio.ogg');
    });
  });

  describe('video', () => {
    it('calls writeTempFile with mp4 extension and persists path', async () => {
      const buf = Buffer.from('fake-video');
      vi.mocked(downloadMedia).mockResolvedValue({ buffer: buf, mimeType: 'video/mp4' });
      vi.mocked(writeTempFile).mockReturnValue('/tmp/video.mp4');
      vi.mocked(extractFrames).mockResolvedValue([
        { buffer: Buffer.from('frame'), timestamp: '0s' },
      ]);

      const db = makeDb();
      const msg = makeMsg({ contentType: 'video', messageId: 'video-001' });
      await processMedia(msg, makeDownloadFn(buf), db, 'video-001');

      expect(writeTempFile).toHaveBeenCalledWith(buf, 'mp4');
      expect(updateMediaPath).toHaveBeenCalledWith(db, 'video-001', '/tmp/video.mp4');
    });
  });

  describe('document', () => {
    it('uses extension from filename and persists path', async () => {
      const buf = Buffer.from('fake-pdf');
      vi.mocked(downloadMedia).mockResolvedValue({ buffer: buf, mimeType: 'application/pdf' });
      vi.mocked(writeTempFile).mockReturnValue('/tmp/report.pdf');
      vi.mocked(extractDocumentText).mockResolvedValue('document text');

      const db = makeDb();
      const msg = makeMsg({ contentType: 'document', content: 'report.pdf', messageId: 'doc-001' });
      await processMedia(msg, makeDownloadFn(buf), db, 'doc-001');

      expect(writeTempFile).toHaveBeenCalledWith(buf, 'pdf');
      expect(updateMediaPath).toHaveBeenCalledWith(db, 'doc-001', '/tmp/report.pdf');
    });

    it('falls back to bin extension when filename has no extension', async () => {
      const buf = Buffer.from('fake-doc');
      vi.mocked(downloadMedia).mockResolvedValue({ buffer: buf, mimeType: 'application/octet-stream' });
      vi.mocked(writeTempFile).mockReturnValue('/tmp/unknown.bin');
      vi.mocked(extractDocumentText).mockResolvedValue('[document: nodotfile — format not supported]');

      const db = makeDb();
      const msg = makeMsg({ contentType: 'document', content: 'nodotfile', messageId: 'doc-002' });
      await processMedia(msg, makeDownloadFn(buf), db, 'doc-002');

      expect(writeTempFile).toHaveBeenCalledWith(buf, 'bin');
    });
  });

  describe('error handling', () => {
    it('does not throw when writeTempFile fails — warns and continues', async () => {
      const buf = Buffer.from('fake-image');
      vi.mocked(downloadMedia).mockResolvedValue({ buffer: buf, mimeType: 'image/jpeg' });
      vi.mocked(writeTempFile).mockImplementation(() => {
        throw new Error('disk full');
      });

      const db = makeDb();
      const msg = makeMsg({ contentType: 'image', messageId: 'img-002' });

      // Should not throw
      const result = await processMedia(msg, makeDownloadFn(buf), db, 'img-002');

      expect(result.images).toHaveLength(1);
      expect(updateMediaPath).not.toHaveBeenCalled();
    });
  });
});
