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
  extractRawMime: vi.fn(() => undefined),
  extractRawFileLength: vi.fn(() => undefined),
}));

import { processMedia } from '../../../../src/runtimes/chat/media/processor.ts';
import { downloadMedia, writeTempFile } from '../../../../src/core/media-download.ts';
import { updateMediaPath } from '../../../../src/core/messages.ts';
import { transcribeAudio } from '../../../../src/runtimes/chat/providers/whisper.ts';
import { extractFrames } from '../../../../src/runtimes/chat/media/video.ts';
import { extractDocumentText } from '../../../../src/runtimes/chat/media/documents.ts';
import { extractUrls, extractLinkContent } from '../../../../src/runtimes/chat/media/links.ts';
import { extractRawMime } from '../../../../src/core/media-mime.ts';
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
  contentText: null,
  isResponseWorthy: true,
  ...overrides,
});

const makeDb = (): Database =>
  ({ raw: {} }) as unknown as Database;

const makeDownloadFn = (buf: Buffer) => vi.fn(async () => buf);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(downloadMedia).mockReset();
  vi.mocked(writeTempFile).mockReset();
  vi.mocked(transcribeAudio).mockReset();
  vi.mocked(extractFrames).mockReset();
  vi.mocked(extractDocumentText).mockReset();
  vi.mocked(extractUrls).mockReset();
  vi.mocked(extractUrls).mockReturnValue([]);
  vi.mocked(extractLinkContent).mockReset();
  vi.mocked(extractRawMime).mockReset();
  vi.mocked(extractRawMime).mockReturnValue(undefined);
});

describe('processMedia — disk persistence', () => {
  describe('text links', () => {
    it('returns plain text without link extraction when no URLs are present', async () => {
      vi.mocked(extractUrls).mockReturnValue([]);

      const result = await processMedia(makeMsg({ content: 'plain message' }), null);

      expect(result).toEqual({ content: 'plain message', images: [] });
      expect(extractLinkContent).not.toHaveBeenCalled();
    });

    it('normalizes missing text content to an empty string', async () => {
      const result = await processMedia(makeMsg({ contentType: 'text', content: null }), null);

      expect(result).toEqual({ content: '', images: [] });
    });

    it('summarizes at most three links and preserves raw fallback evidence', async () => {
      vi.mocked(extractUrls).mockReturnValue([
        'https://a.example',
        'https://b.example',
        'https://c.example',
        'https://d.example',
      ]);
      vi.mocked(extractLinkContent)
        .mockResolvedValueOnce({ title: 'ignored', content: 'raw fallback', fallbackLevel: 'raw' })
        .mockResolvedValueOnce({ title: 'Title B', content: 'body b', fallbackLevel: 'readability' })
        .mockResolvedValueOnce({ title: 'Title C', content: 'body c', fallbackLevel: 'meta' });

      const result = await processMedia(makeMsg({ content: 'see these links' }), null);

      expect(extractLinkContent).toHaveBeenCalledTimes(3);
      expect(extractLinkContent).toHaveBeenNthCalledWith(1, 'https://a.example');
      expect(extractLinkContent).toHaveBeenNthCalledWith(3, 'https://c.example');
      expect(result).toEqual({
        content: [
          'see these links',
          '[Link: https://a.example — raw fallback]',
          '[Link: Title B\nbody b]',
          '[Link: Title C\nbody c]',
        ].join('\n\n'),
        images: [],
      });
    });
  });

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

    it('reports image download failures without attempting persistence', async () => {
      vi.mocked(downloadMedia).mockResolvedValue(null);

      const result = await processMedia(
        makeMsg({ contentType: 'image', content: 'caption' }),
        makeDownloadFn(Buffer.from('missing-image')),
        makeDb(),
        'img-failed',
      );

      expect(result).toEqual({ content: "[image — couldn't download]", images: [] });
      expect(writeTempFile).not.toHaveBeenCalled();
      expect(updateMediaPath).not.toHaveBeenCalled();
    });

    it('uses raw image MIME when available and keeps the caption content', async () => {
      const buf = Buffer.from('png-image');
      vi.mocked(extractRawMime).mockReturnValue('image/png');
      vi.mocked(downloadMedia).mockResolvedValue({ buffer: buf, mimeType: 'image/png' });

      const result = await processMedia(
        makeMsg({ contentType: 'image', content: 'image caption', rawMessage: { message: {} } }),
        makeDownloadFn(buf),
      );

      expect(downloadMedia).toHaveBeenCalledWith(expect.any(Function), 'image/png', undefined);
      expect(result).toEqual({
        content: 'image caption',
        images: [{ mimeType: 'image/png', base64: buf.toString('base64') }],
      });
    });
  });

  describe('audio', () => {
    // Regression guard for #1074: the cache-file extension must follow the real
    // MIME type, not a hardcoded '.ogg', so transcribe_audio can later infer the
    // correct format.
    it('persists an M4A voice note with the .m4a extension (not .ogg)', async () => {
      const buf = Buffer.from('fake-m4a');
      vi.mocked(downloadMedia).mockResolvedValue({ buffer: buf, mimeType: 'audio/mp4' });
      vi.mocked(writeTempFile).mockReturnValue('/tmp/voice.m4a');
      vi.mocked(transcribeAudio).mockResolvedValue('hello');

      const db = makeDb();
      const msg = makeMsg({ contentType: 'audio', messageId: 'aud-001' });
      await processMedia(msg, makeDownloadFn(buf), db, 'aud-001');

      expect(writeTempFile).toHaveBeenCalledWith(buf, 'm4a');
      expect(updateMediaPath).toHaveBeenCalledWith(db, 'aud-001', '/tmp/voice.m4a');
    });

    it('persists an OGG voice note with the .ogg extension', async () => {
      const buf = Buffer.from('fake-ogg');
      vi.mocked(downloadMedia).mockResolvedValue({ buffer: buf, mimeType: 'audio/ogg' });
      vi.mocked(writeTempFile).mockReturnValue('/tmp/voice.ogg');
      vi.mocked(transcribeAudio).mockResolvedValue('hi');

      const db = makeDb();
      const msg = makeMsg({ contentType: 'audio', messageId: 'aud-002' });
      await processMedia(msg, makeDownloadFn(buf), db, 'aud-002');

      expect(writeTempFile).toHaveBeenCalledWith(buf, 'ogg');
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

    it('reports sticker download failures with a sticker-specific label', async () => {
      const result = await processMedia(makeMsg({ contentType: 'sticker' }), null);

      expect(result).toEqual({ content: "[sticker — couldn't download]", images: [] });
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

    it('uses raw audio MIME and returns a transcription failure marker when transcription fails', async () => {
      const buf = Buffer.from('fake-audio');
      vi.mocked(extractRawMime).mockReturnValue('audio/mpeg');
      vi.mocked(downloadMedia).mockResolvedValue({ buffer: buf, mimeType: 'audio/mpeg' });
      vi.mocked(transcribeAudio).mockRejectedValue(new Error('transcriber unavailable'));

      const result = await processMedia(makeMsg({ contentType: 'audio', rawMessage: { message: {} } }), makeDownloadFn(buf));

      expect(downloadMedia).toHaveBeenCalledWith(expect.any(Function), 'audio/mpeg', undefined);
      expect(transcribeAudio).toHaveBeenCalledWith(buf, 'audio/mpeg');
      expect(result).toEqual({ content: '[voice message — transcription failed]', images: [] });
    });

    it('reports audio download failures before transcription', async () => {
      await expect(processMedia(makeMsg({ contentType: 'audio' }), null))
        .resolves.toEqual({ content: "[audio — couldn't download]", images: [] });

      vi.mocked(downloadMedia).mockResolvedValue(null);

      const result = await processMedia(makeMsg({ contentType: 'audio' }), makeDownloadFn(Buffer.from('audio')));

      expect(result).toEqual({ content: "[audio — couldn't download]", images: [] });
      expect(transcribeAudio).not.toHaveBeenCalled();
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

    it('uses raw video MIME and returns frame timestamps with caption', async () => {
      const buf = Buffer.from('fake-video');
      vi.mocked(extractRawMime).mockReturnValue('video/quicktime');
      vi.mocked(downloadMedia).mockResolvedValue({ buffer: buf, mimeType: 'video/quicktime' });
      vi.mocked(extractFrames).mockResolvedValue([
        { buffer: Buffer.from('frame-a'), timestamp: '0:00' },
        { buffer: Buffer.from('frame-b'), timestamp: '0:10' },
      ]);

      const result = await processMedia(makeMsg({ contentType: 'video', content: 'clip caption' }), makeDownloadFn(buf));

      expect(downloadMedia).toHaveBeenCalledWith(expect.any(Function), 'video/quicktime', undefined);
      expect(result).toEqual({
        content: 'clip caption\n[Video frames at: 0:00, 0:10]',
        images: [
          { mimeType: 'image/jpeg', base64: Buffer.from('frame-a').toString('base64') },
          { mimeType: 'image/jpeg', base64: Buffer.from('frame-b').toString('base64') },
        ],
      });
    });

    it('reports video extraction failures and empty frame sets', async () => {
      const buf = Buffer.from('fake-video');
      vi.mocked(downloadMedia).mockResolvedValue({ buffer: buf, mimeType: 'video/mp4' });
      vi.mocked(extractFrames).mockRejectedValueOnce(new Error('ffmpeg failed'));

      await expect(processMedia(makeMsg({ contentType: 'video', content: 'clip caption' }), makeDownloadFn(buf)))
        .resolves.toEqual({ content: 'clip caption', images: [] });

      vi.mocked(extractFrames).mockResolvedValueOnce([]);
      await expect(processMedia(makeMsg({ contentType: 'video', content: null }), makeDownloadFn(buf)))
        .resolves.toEqual({ content: '[video — no frames extracted]', images: [] });

      vi.mocked(extractFrames).mockRejectedValueOnce(new Error('ffmpeg failed again'));
      await expect(processMedia(makeMsg({ contentType: 'video', content: null }), makeDownloadFn(buf)))
        .resolves.toEqual({ content: '[video — processing failed]', images: [] });
    });

    it('reports missing and failed video downloads before frame extraction', async () => {
      await expect(processMedia(makeMsg({ contentType: 'video' }), null))
        .resolves.toEqual({ content: "[video — couldn't download]", images: [] });

      vi.mocked(downloadMedia).mockResolvedValue(null);
      await expect(processMedia(makeMsg({ contentType: 'video' }), makeDownloadFn(Buffer.from('video'))))
        .resolves.toEqual({ content: "[video — couldn't download]", images: [] });

      expect(extractFrames).not.toHaveBeenCalled();
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

    it('uses raw document MIME and reports extraction failure with sanitized extension persistence', async () => {
      const buf = Buffer.from('fake-doc');
      vi.mocked(extractRawMime).mockReturnValue('application/vnd.custom');
      vi.mocked(downloadMedia).mockResolvedValue({ buffer: buf, mimeType: 'application/vnd.custom' });
      vi.mocked(writeTempFile).mockReturnValue('/tmp/archive.bad');
      vi.mocked(extractDocumentText).mockRejectedValue(new Error('unsupported parser'));

      const result = await processMedia(
        makeMsg({ contentType: 'document', content: 'archive.tar.?bad', rawMessage: { message: {} } }),
        makeDownloadFn(buf),
        makeDb(),
        'doc-bad',
      );

      expect(downloadMedia).toHaveBeenCalledWith(expect.any(Function), 'application/vnd.custom', undefined);
      expect(writeTempFile).toHaveBeenCalledWith(buf, 'bad');
      expect(result).toEqual({ content: '[document: archive.tar.?bad — could not extract text]', images: [] });
    });

    it('falls back to bin when a document filename extension sanitizes to empty', async () => {
      const buf = Buffer.from('fake-doc');
      vi.mocked(downloadMedia).mockResolvedValue({ buffer: buf, mimeType: 'text/plain' });
      vi.mocked(writeTempFile).mockReturnValue('/tmp/report.bin');
      vi.mocked(extractDocumentText).mockResolvedValue('plain text');

      const result = await processMedia(makeMsg({ contentType: 'document', content: 'report.!!!' }), makeDownloadFn(buf), makeDb(), 'doc-symbols');

      expect(writeTempFile).toHaveBeenCalledWith(buf, 'bin');
      expect(result).toEqual({ content: 'plain text', images: [] });
    });

    it('reports missing and failed document downloads before extraction', async () => {
      await expect(processMedia(makeMsg({ contentType: 'document' }), null))
        .resolves.toEqual({ content: "[document — couldn't download]", images: [] });

      vi.mocked(downloadMedia).mockResolvedValue(null);
      await expect(processMedia(makeMsg({ contentType: 'document' }), makeDownloadFn(Buffer.from('doc'))))
        .resolves.toEqual({ content: "[document — couldn't download]", images: [] });

      expect(extractDocumentText).not.toHaveBeenCalled();
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

  describe('non-media content', () => {
    it('formats location, contact, and poll messages with content-aware fallbacks', async () => {
      await expect(processMedia(makeMsg({ contentType: 'location', content: null }), null))
        .resolves.toEqual({ content: '[Location shared]', images: [] });
      await expect(processMedia(makeMsg({ contentType: 'location', content: '41.1,-72.3' }), null))
        .resolves.toEqual({ content: '[Location: 41.1,-72.3]', images: [] });
      await expect(processMedia(makeMsg({ contentType: 'contact', content: null }), null))
        .resolves.toEqual({ content: '[Contact shared]', images: [] });
      await expect(processMedia(makeMsg({ contentType: 'contact', content: 'Ada' }), null))
        .resolves.toEqual({ content: '[Contact: Ada]', images: [] });
      await expect(processMedia(makeMsg({ contentType: 'poll', content: null }), null))
        .resolves.toEqual({ content: '[Poll]', images: [] });
      await expect(processMedia(makeMsg({ contentType: 'poll', content: 'Ship it?' }), null))
        .resolves.toEqual({ content: '[Poll: Ship it?]', images: [] });
    });

    it('preserves unknown content or emits an unsupported fallback when content is absent', async () => {
      await expect(processMedia(makeMsg({ contentType: 'unknown', content: 'custom payload' }), null))
        .resolves.toEqual({ content: 'custom payload', images: [] });
      await expect(processMedia(makeMsg({ contentType: 'unknown', content: null }), null))
        .resolves.toEqual({ content: '[unsupported message type]', images: [] });
    });
  });
});
