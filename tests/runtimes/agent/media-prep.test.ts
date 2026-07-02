// tests/runtimes/agent/media-prep.test.ts
// Direct branch-coverage tests for src/runtimes/agent/media-prep.ts
//
// Sibling-harness style: vi.hoisted + vi.mock + vi.fn (mirrors prepare-content.test.ts).
// Imports come directly from media-prep.ts (not via runtime.ts re-exports) so each
// test is scoped to the module under test. Heavyweight agent-runtime dependencies
// are not pulled in.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from '../../../src/core/types.ts';

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const {
  mockUpdateMediaPath,
  mockUpdateTranscription,
  mockDownloadMedia,
  mockWriteTempFile,
  mockTranscribeAudio,
  mockExtractDocumentText,
  mockConfigMediaDir,
} = vi.hoisted(() => ({
  mockUpdateMediaPath: vi.fn(),
  mockUpdateTranscription: vi.fn(),
  mockDownloadMedia: vi.fn(),
  mockWriteTempFile: vi.fn(),
  mockTranscribeAudio: vi.fn(),
  mockExtractDocumentText: vi.fn(),
  mockConfigMediaDir: vi.fn(),
}));

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../src/config.ts', () => ({
  // Use a getter so tests can override mediaDir per-test via
  // `mockConfigMediaDir.mockReturnValue(...)` and the next read of
  // `config.mediaDir` in the production code sees the new value.
  config: {
    get mediaDir(): string {
      return mockConfigMediaDir();
    },
  },
}));

// Mock Baileys — downloadMediaMessage is imported dynamically inside the download fn
vi.mock('@whiskeysockets/baileys', async () => {
  const { baileysMediaMock } = await import('../../helpers/baileys-mock.ts');
  const m = baileysMediaMock();
  m.downloadMediaMessage.mockImplementation(async () => Buffer.from('media-bytes'));
  return m;
});

vi.mock('../../../src/core/media-download.ts', () => ({
  downloadMedia: mockDownloadMedia,
  writeTempFile: mockWriteTempFile,
  cleanupTempFile: vi.fn(),
}));

vi.mock('../../../src/runtimes/chat/providers/whisper.ts', () => ({
  transcribeAudio: mockTranscribeAudio,
}));

vi.mock('../../../src/runtimes/chat/media/documents.ts', () => ({
  extractDocumentText: mockExtractDocumentText,
}));

vi.mock('../../../src/core/messages.ts', () => ({
  updateMediaPath: mockUpdateMediaPath,
  updateTranscription: mockUpdateTranscription,
}));

// node:fs is NOT mocked — relocateMediaToWorkspace exercises the real
// mkdirSync / copyFileSync against a temp workspace. The "mkdirSync throws"
// branch is hit by pointing at a path under a read-only parent, and the
// "copyFileSync throws" branch by deleting the source file between calls.

// ─── Import under test ────────────────────────────────────────────────────────

import {
  prepareContentForAgent,
  relocateMediaToWorkspace,
  __resetCreatedMediaDirsForTests,
  __rememberCreatedMediaDirForTests,
  __getCreatedMediaDirsSizeForTests,
  __hasCreatedMediaDirForTests,
} from '../../../src/runtimes/agent/media-prep.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: 'msg-1',
    chatJid: '15551234567@s.whatsapp.net',
    senderJid: '15559876543@s.whatsapp.net',
    senderName: 'Test User',
    content: null,
    contentType: 'audio',
    isFromMe: false,
    isGroup: false,
    mentionedJids: [],
    timestamp: Date.now(),
    quotedMessageId: null,
    contentText: null,
    isResponseWorthy: true,
    rawMessage: { key: 'raw-msg' },
    ...overrides,
  };
}

const FAKE_PATH = '/var/folders/whatsoup/media/tmp/abcdef12.jpg';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('media-prep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetCreatedMediaDirsForTests();
    // Default mediaDir for relocateMediaToWorkspace tests
    mockConfigMediaDir.mockReturnValue('/var/folders/whatsoup/media/tmp');
    // Default: successful download returning a buffer
    mockDownloadMedia.mockResolvedValue({ buffer: Buffer.from('media-bytes'), mimeType: 'image/jpeg' });
    mockWriteTempFile.mockReturnValue(FAKE_PATH);
    mockTranscribeAudio.mockResolvedValue('Hello world transcription.');
    mockExtractDocumentText.mockResolvedValue('Extracted document text.');
    mockUpdateMediaPath.mockReset();
    mockUpdateTranscription.mockReset();
  });

  afterEach(() => {
    __resetCreatedMediaDirsForTests();
  });

  // ── LRU helpers (LEAK-10 coverage) ──────────────────────────────────────

  it('caps createdMediaDirs at 5,000 entries and evicts the oldest directory', () => {
    __resetCreatedMediaDirsForTests();
    for (let i = 0; i <= 5_000; i++) {
      __rememberCreatedMediaDirForTests(`/tmp/workspace-${i}/media`);
    }
    expect(__getCreatedMediaDirsSizeForTests()).toBe(5_000);
    expect(__hasCreatedMediaDirForTests('/tmp/workspace-0/media')).toBe(false);
    expect(__hasCreatedMediaDirForTests('/tmp/workspace-1/media')).toBe(true);
    expect(__hasCreatedMediaDirForTests('/tmp/workspace-5000/media')).toBe(true);
  });

  it('__resetCreatedMediaDirsForTests clears the LRU set', () => {
    __rememberCreatedMediaDirForTests('/tmp/alpha/media');
    __rememberCreatedMediaDirForTests('/tmp/beta/media');
    expect(__getCreatedMediaDirsSizeForTests()).toBe(2);
    __resetCreatedMediaDirsForTests();
    expect(__getCreatedMediaDirsSizeForTests()).toBe(0);
  });

  it('__hasCreatedMediaDirForTests returns true for remembered paths and false otherwise', () => {
    __resetCreatedMediaDirsForTests();
    expect(__hasCreatedMediaDirForTests('/tmp/never-seen/media')).toBe(false);
    __rememberCreatedMediaDirForTests('/tmp/seen/media');
    expect(__hasCreatedMediaDirForTests('/tmp/seen/media')).toBe(true);
  });

  // ── prepareContentForAgent: text passthrough ─────────────────────────────

  it('returns content as-is for text messages with non-null content', async () => {
    const msg = makeMsg({ contentType: 'text', content: 'hello world' });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('hello world');
    expect(mockDownloadMedia).not.toHaveBeenCalled();
  });

  it('returns empty string for text messages with null content', async () => {
    const msg = makeMsg({ contentType: 'text', content: null });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('');
    expect(mockDownloadMedia).not.toHaveBeenCalled();
  });

  // ── prepareContentForAgent: image ────────────────────────────────────────

  it('invokes the lazily-built download function which calls Baileys downloadMediaMessage', async () => {
    // Real flow: downloadMedia invokes the downloadFn we passed, which then
    // imports @whiskeysockets/baileys and calls downloadMediaMessage. Mock
    // downloadMedia to call the downloadFn to exercise the dynamic import
    // + downloadMediaMessage path (lines 79-80 in the source).
    mockDownloadMedia.mockImplementation(async (downloadFn: () => Promise<Buffer>) => {
      const buffer = await downloadFn();
      return { buffer, mimeType: 'image/jpeg' };
    });
    mockWriteTempFile.mockReturnValue('/tmp/img.jpg');
    const msg = makeMsg({ contentType: 'image', content: null });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('[Image: /tmp/img.jpg]');
  });

  it('returns file path only for image without caption', async () => {
    mockWriteTempFile.mockReturnValue('/tmp/img.jpg');
    const msg = makeMsg({ contentType: 'image', content: null });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('[Image: /tmp/img.jpg]');
    expect(mockWriteTempFile).toHaveBeenCalledWith(expect.any(Buffer), 'jpg');
  });

  it('includes caption alongside image file path when caption is present', async () => {
    mockWriteTempFile.mockReturnValue('/tmp/img.jpg');
    const msg = makeMsg({ contentType: 'image', content: 'Check this out' });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('[Image: /tmp/img.jpg]\nCheck this out');
  });

  // ── prepareContentForAgent: sticker ──────────────────────────────────────

  it('returns sticker file path for sticker messages', async () => {
    mockWriteTempFile.mockReturnValue('/tmp/sticker.webp');
    const msg = makeMsg({ contentType: 'sticker', content: null });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('[Sticker: /tmp/sticker.webp]');
    expect(mockWriteTempFile).toHaveBeenCalledWith(expect.any(Buffer), 'webp');
  });

  // ── prepareContentForAgent: audio + transcription ────────────────────────

  it('returns transcription and file path for audio messages', async () => {
    mockWriteTempFile.mockReturnValue('/tmp/voice.ogg');
    const msg = makeMsg({ contentType: 'audio', content: null });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('[Voice note transcription]: Hello world transcription.\n[Audio file: /tmp/voice.ogg]');
    expect(mockTranscribeAudio).toHaveBeenCalledOnce();
    expect(mockWriteTempFile).toHaveBeenCalledWith(expect.any(Buffer), 'ogg');
  });

  it('persists transcription to DB when db and messageId are provided', async () => {
    mockWriteTempFile.mockReturnValue('/tmp/voice.ogg');
    const fakeDb = { raw: {} } as never;
    const msg = makeMsg({ contentType: 'audio', content: null, messageId: 'msg-audio-1' });
    const result = await prepareContentForAgent(msg, fakeDb, 'msg-audio-1');
    expect(result).toBe('[Voice note transcription]: Hello world transcription.\n[Audio file: /tmp/voice.ogg]');
    expect(mockUpdateTranscription).toHaveBeenCalledWith(fakeDb, 'msg-audio-1', 'Hello world transcription.');
  });

  it('does not persist transcription when transcript is the unavailable placeholder', async () => {
    mockWriteTempFile.mockReturnValue('/tmp/voice.ogg');
    mockTranscribeAudio.mockResolvedValue('transcription unavailable: no providers');
    const fakeDb = { raw: {} } as never;
    const msg = makeMsg({ contentType: 'audio', content: null, messageId: 'msg-audio-2' });
    const result = await prepareContentForAgent(msg, fakeDb, 'msg-audio-2');
    expect(result).toContain('transcription unavailable');
    expect(mockUpdateTranscription).not.toHaveBeenCalled();
  });

  it('does not persist transcription when transcript is empty string', async () => {
    mockWriteTempFile.mockReturnValue('/tmp/voice.ogg');
    mockTranscribeAudio.mockResolvedValue('');
    const fakeDb = { raw: {} } as never;
    const msg = makeMsg({ contentType: 'audio', content: null, messageId: 'msg-audio-3' });
    const result = await prepareContentForAgent(msg, fakeDb, 'msg-audio-3');
    expect(result).toBe('[Voice note transcription]: \n[Audio file: /tmp/voice.ogg]');
    expect(mockUpdateTranscription).not.toHaveBeenCalled();
  });

  it('still returns transcription text even when updateTranscription throws', async () => {
    mockWriteTempFile.mockReturnValue('/tmp/voice.ogg');
    mockUpdateTranscription.mockImplementation(() => {
      throw new Error('db write failed');
    });
    const fakeDb = { raw: {} } as never;
    const msg = makeMsg({ contentType: 'audio', content: null, messageId: 'msg-audio-err' });
    const result = await prepareContentForAgent(msg, fakeDb, 'msg-audio-err');
    expect(result).toBe('[Voice note transcription]: Hello world transcription.\n[Audio file: /tmp/voice.ogg]');
  });

  it('does not call updateTranscription when db is not provided for audio', async () => {
    mockWriteTempFile.mockReturnValue('/tmp/voice.ogg');
    const msg = makeMsg({ contentType: 'audio', content: null });
    await prepareContentForAgent(msg);
    expect(mockUpdateTranscription).not.toHaveBeenCalled();
  });

  it('does not call updateTranscription when messageId is not provided for audio', async () => {
    mockWriteTempFile.mockReturnValue('/tmp/voice.ogg');
    const fakeDb = { raw: {} } as never;
    const msg = makeMsg({ contentType: 'audio', content: null });
    await prepareContentForAgent(msg, fakeDb, undefined);
    expect(mockUpdateTranscription).not.toHaveBeenCalled();
  });

  it('QR-061: uses extracted raw MIME for audio (M4A voice note not pinned to audio/ogg)', async () => {
    mockDownloadMedia.mockResolvedValue({ buffer: Buffer.from('m4a-bytes'), mimeType: 'audio/mp4' });
    mockWriteTempFile.mockReturnValue('/tmp/voice.m4a');
    const msg = makeMsg({
      contentType: 'audio',
      content: null,
      rawMessage: { message: { audioMessage: { mimetype: 'audio/mp4' } } },
    });
    await prepareContentForAgent(msg);
    // Defect (unfixed): audio was pinned to the hardcoded 'audio/ogg' (extractRawMime ran for
    // documents only) → OpenAI Whisper got a mislabeled file. Fix derives the real MIME.
    expect(mockDownloadMedia).toHaveBeenCalledWith(expect.any(Function), 'audio/mp4', undefined);
  });

  it('QR-061: uses extracted raw MIME for video (WebM not pinned to video/mp4)', async () => {
    mockDownloadMedia.mockResolvedValue({ buffer: Buffer.from('webm-bytes'), mimeType: 'video/webm' });
    mockWriteTempFile.mockReturnValue('/tmp/video.webm');
    const msg = makeMsg({
      contentType: 'video',
      content: null,
      rawMessage: { message: { videoMessage: { mimetype: 'video/webm' } } },
    });
    await prepareContentForAgent(msg);
    expect(mockDownloadMedia).toHaveBeenCalledWith(expect.any(Function), 'video/webm', undefined);
  });

  it('QR-061: audio with no declared mimetype still falls back to audio/ogg (no over-trigger)', async () => {
    mockDownloadMedia.mockResolvedValue({ buffer: Buffer.from('ogg-bytes'), mimeType: 'audio/ogg' });
    mockWriteTempFile.mockReturnValue('/tmp/voice.ogg');
    const msg = makeMsg({ contentType: 'audio', content: null, rawMessage: { key: 'raw-msg' } });
    await prepareContentForAgent(msg);
    expect(mockDownloadMedia).toHaveBeenCalledWith(expect.any(Function), 'audio/ogg', undefined);
  });

  it('falls through to descriptive text when rawMessage is absent on audio (no downloadFn)', async () => {
    const msg = makeMsg({ contentType: 'audio', rawMessage: undefined, content: 'fallback-caption' });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('fallback-caption');
    expect(mockDownloadMedia).not.toHaveBeenCalled();
  });

  // ── prepareContentForAgent: video ────────────────────────────────────────

  it('returns file path only for video without caption', async () => {
    mockDownloadMedia.mockResolvedValue({ buffer: Buffer.from('vid-bytes'), mimeType: 'video/mp4' });
    mockWriteTempFile.mockReturnValue('/tmp/video.mp4');
    const msg = makeMsg({ contentType: 'video', content: null });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('[Video: /tmp/video.mp4]');
    expect(mockWriteTempFile).toHaveBeenCalledWith(expect.any(Buffer), 'mp4');
  });

  it('includes caption alongside video file path when caption is present', async () => {
    mockDownloadMedia.mockResolvedValue({ buffer: Buffer.from('vid-bytes'), mimeType: 'video/mp4' });
    mockWriteTempFile.mockReturnValue('/tmp/video.mp4');
    const msg = makeMsg({ contentType: 'video', content: 'Watch this' });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('[Video: /tmp/video.mp4]\nWatch this');
  });

  // ── prepareContentForAgent: document ────────────────────────────────────

  it('returns document file path and extracted text', async () => {
    mockDownloadMedia.mockResolvedValue({ buffer: Buffer.from('pdf-bytes'), mimeType: 'application/pdf' });
    mockWriteTempFile.mockReturnValue('/tmp/report.pdf');
    const msg = makeMsg({ contentType: 'document', content: 'report.pdf' });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('[Document: /tmp/report.pdf]\nExtracted document text.');
    expect(mockWriteTempFile).toHaveBeenCalledWith(expect.any(Buffer), 'pdf');
    expect(mockExtractDocumentText).toHaveBeenCalledOnce();
  });

  it('preserves uppercase extension from document filename and lowercases it', async () => {
    mockDownloadMedia.mockResolvedValue({ buffer: Buffer.from('xlsx-bytes'), mimeType: 'application/vnd.ms-excel' });
    mockWriteTempFile.mockReturnValue('/tmp/data.XLSX');
    const msg = makeMsg({ contentType: 'document', content: 'data.XLSX' });
    await prepareContentForAgent(msg);
    expect(mockWriteTempFile).toHaveBeenCalledWith(expect.any(Buffer), 'xlsx');
  });

  it('strips non-alphanumeric characters from the document extension and truncates to 10 chars', async () => {
    mockDownloadMedia.mockResolvedValue({ buffer: Buffer.from('x'), mimeType: 'application/octet-stream' });
    mockWriteTempFile.mockReturnValue('/tmp/cleaned.bin');
    // Filename has TWO dots; lastIndexOf picks the second one. The substring
    // after it starts with `!@#` which all get stripped, leaving the
    // alphanumeric tail, then truncated to 10 chars.
    const msg = makeMsg({ contentType: 'document', content: 'report.t@r.!@#abcdefghijk' });
    await prepareContentForAgent(msg);
    const callArgs = vi.mocked(mockWriteTempFile).mock.calls[0];
    const ext = callArgs[1];
    expect(ext).toBe('abcdefghij'); // sanitized, lowercased, sliced to 10
  });

  it('falls back to bin extension when document filename has no dot', async () => {
    mockDownloadMedia.mockResolvedValue({ buffer: Buffer.from('bin-bytes'), mimeType: 'application/octet-stream' });
    mockWriteTempFile.mockReturnValue('/tmp/file.bin');
    const msg = makeMsg({ contentType: 'document', content: 'no-extension-filename' });
    await prepareContentForAgent(msg);
    expect(mockWriteTempFile).toHaveBeenCalledWith(expect.any(Buffer), 'bin');
  });

  it('falls back to bin extension when document filename starts with a dot (dotIdx === 0)', async () => {
    mockDownloadMedia.mockResolvedValue({ buffer: Buffer.from('bin-bytes'), mimeType: 'application/octet-stream' });
    mockWriteTempFile.mockReturnValue('/tmp/dotfile.bin');
    const msg = makeMsg({ contentType: 'document', content: '.env' });
    await prepareContentForAgent(msg);
    expect(mockWriteTempFile).toHaveBeenCalledWith(expect.any(Buffer), 'bin');
  });

  it('falls back to bin extension when document has no filename and no content', async () => {
    mockDownloadMedia.mockResolvedValue({ buffer: Buffer.from('bin-bytes'), mimeType: 'application/octet-stream' });
    mockWriteTempFile.mockReturnValue('/tmp/file.bin');
    const msg = makeMsg({ contentType: 'document', content: null });
    await prepareContentForAgent(msg);
    expect(mockWriteTempFile).toHaveBeenCalledWith(expect.any(Buffer), 'bin');
  });

  it('uses extracted raw MIME for document when rawMessage has documentMessage mimetype', async () => {
    mockDownloadMedia.mockResolvedValue({ buffer: Buffer.from('doc-bytes'), mimeType: 'application/pdf' });
    mockWriteTempFile.mockReturnValue('/tmp/file.pdf');
    const msg = makeMsg({
      contentType: 'document',
      content: 'file.pdf',
      rawMessage: { message: { documentMessage: { mimetype: 'application/pdf' } } },
    });
    await prepareContentForAgent(msg);
    // QR-057: downloadMedia now also receives the declared fileLength (undefined — none in this stub).
    expect(mockDownloadMedia).toHaveBeenCalledWith(expect.any(Function), 'application/pdf', undefined);
  });

  it('falls back to octet-stream MIME for document when rawMessage has no mimetype', async () => {
    mockDownloadMedia.mockResolvedValue({ buffer: Buffer.from('doc-bytes'), mimeType: 'application/octet-stream' });
    mockWriteTempFile.mockReturnValue('/tmp/file.bin');
    const msg = makeMsg({
      contentType: 'document',
      content: 'file.bin',
      rawMessage: { message: { documentMessage: {} } },
    });
    await prepareContentForAgent(msg);
    expect(mockDownloadMedia).toHaveBeenCalledWith(expect.any(Function), 'application/octet-stream', undefined);
  });

  // ── prepareContentForAgent: descriptive-only types ──────────────────────

  it('returns location text without downloading any file', async () => {
    const msg = makeMsg({ contentType: 'location', content: '40.7128,-74.0060' });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('[Location: 40.7128,-74.0060]');
    expect(mockDownloadMedia).not.toHaveBeenCalled();
  });

  it('returns generic location label when location content is null', async () => {
    const msg = makeMsg({ contentType: 'location', content: null });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('[Location shared]');
  });

  it('returns contact text without downloading any file', async () => {
    const msg = makeMsg({ contentType: 'contact', content: 'Alice' });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('[Contact: Alice]');
    expect(mockDownloadMedia).not.toHaveBeenCalled();
  });

  it('returns generic contact label when contact content is null', async () => {
    const msg = makeMsg({ contentType: 'contact', content: null });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('[Contact shared]');
  });

  it('returns poll text without downloading any file', async () => {
    const msg = makeMsg({ contentType: 'poll', content: 'Best pizza?' });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('[Poll: Best pizza?]');
    expect(mockDownloadMedia).not.toHaveBeenCalled();
  });

  it('returns generic poll label when poll content is null', async () => {
    const msg = makeMsg({ contentType: 'poll', content: null });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('[Poll]');
  });

  // ── prepareContentForAgent: download failure ────────────────────────────

  it('returns download-failed label when media download fails for image', async () => {
    mockDownloadMedia.mockResolvedValue(null);
    const msg = makeMsg({ contentType: 'image', content: null });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('[image — download failed]');
    expect(mockWriteTempFile).not.toHaveBeenCalled();
  });

  it('appends caption to download-failed label when caption is present', async () => {
    mockDownloadMedia.mockResolvedValue(null);
    const msg = makeMsg({ contentType: 'image', content: 'nice pic' });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('[image — download failed]\nnice pic');
  });

  it('returns download-failed label without caption content for audio', async () => {
    mockDownloadMedia.mockResolvedValue(null);
    const msg = makeMsg({ contentType: 'audio', content: null });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('[audio — download failed]');
  });

  // ── prepareContentForAgent: unknown / fallback ──────────────────────────

  it('returns fallback label for unknown content type with no rawMessage and no content', async () => {
    const msg = makeMsg({ contentType: 'unknown', content: null, rawMessage: undefined });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('[unknown message received]');
  });

  it('returns content for unknown type when content is present', async () => {
    const msg = makeMsg({ contentType: 'unknown', content: 'some content', rawMessage: undefined });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('some content');
  });

  it('handles unknown content type with rawMessage by falling through to descriptive path', async () => {
    // rawMessage is present → downloadFn built → mimeMap[unknown] undefined → !typeInfo is true
    const msg = makeMsg({ contentType: 'unknown', content: null });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('[unknown message received]');
    expect(mockDownloadMedia).not.toHaveBeenCalled();
  });

  it('handles unknown content type with rawMessage and content via descriptive path', async () => {
    const msg = makeMsg({ contentType: 'unknown', content: 'caption-here' });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('caption-here');
  });

  // ── prepareContentForAgent: media_path persistence ──────────────────────

  it('calls updateMediaPath with db and messageId after writeTempFile for image', async () => {
    mockWriteTempFile.mockReturnValue('/tmp/img.jpg');
    const fakeDb = { raw: {} } as never;
    const msg = makeMsg({ contentType: 'image', content: null, messageId: 'msg-persist-1' });
    await prepareContentForAgent(msg, fakeDb, 'msg-persist-1');
    expect(mockUpdateMediaPath).toHaveBeenCalledOnce();
    expect(mockUpdateMediaPath).toHaveBeenCalledWith(fakeDb, 'msg-persist-1', '/tmp/img.jpg');
  });

  it('does not call updateMediaPath when db is not provided', async () => {
    mockWriteTempFile.mockReturnValue('/tmp/img.jpg');
    const msg = makeMsg({ contentType: 'image', content: null });
    await prepareContentForAgent(msg);
    expect(mockUpdateMediaPath).not.toHaveBeenCalled();
  });

  it('does not call updateMediaPath when messageId is not provided', async () => {
    mockWriteTempFile.mockReturnValue('/tmp/img.jpg');
    const fakeDb = { raw: {} } as never;
    const msg = makeMsg({ contentType: 'image', content: null });
    await prepareContentForAgent(msg, fakeDb, undefined);
    expect(mockUpdateMediaPath).not.toHaveBeenCalled();
  });

  it('still returns file path even if updateMediaPath throws', async () => {
    mockWriteTempFile.mockReturnValue('/tmp/img.jpg');
    mockUpdateMediaPath.mockImplementation(() => {
      throw new Error('db error');
    });
    const fakeDb = { raw: {} } as never;
    const msg = makeMsg({ contentType: 'image', content: null, messageId: 'msg-err' });
    const result = await prepareContentForAgent(msg, fakeDb, 'msg-err');
    expect(result).toBe('[Image: /tmp/img.jpg]');
  });

  // ── relocateMediaToWorkspace: early returns ─────────────────────────────

  it('returns content unchanged when mediaDir is empty', () => {
    mockConfigMediaDir.mockReturnValue('');
    const content = 'See /var/folders/whatsoup/media/tmp/abc.jpg for details';
    const result = relocateMediaToWorkspace(content, '/workspace/user1');
    expect(result).toBe(content);
  });

  it('returns content unchanged when content does not include the mediaTmpDir', () => {
    const content = 'No media paths here at all';
    const result = relocateMediaToWorkspace(content, '/workspace/user1');
    expect(result).toBe(content);
  });

  // ── relocateMediaToWorkspace: mkdir + copy ─────────────────────────────

  it('creates the workspace media directory on first relocation and copies the file', () => {
    __resetCreatedMediaDirsForTests();
    const mediaTmp = mkdtempSync(join(tmpdir(), 'mp-mediadir-'));
    writeFileSync(join(mediaTmp, 'abc123.jpg'), Buffer.from('source-bytes'));
    mockConfigMediaDir.mockReturnValue(mediaTmp);
    const content = `See ${mediaTmp}/abc123.jpg for details`;
    const workspace = mkdtempSync(join(tmpdir(), 'mp-reloc-'));

    const result = relocateMediaToWorkspace(content, workspace);
    const destFile = join(workspace, 'media', 'abc123.jpg');
    expect(existsSync(destFile)).toBe(true);
    expect(statSync(destFile).size).toBe(12);
    expect(result).toBe(`See ${destFile} for details`);
  });

  it('skips mkdirSync when the workspace media directory was already created in this process', () => {
    __resetCreatedMediaDirsForTests();
    const mediaTmp = mkdtempSync(join(tmpdir(), 'mp-mediadir-skip-'));
    writeFileSync(join(mediaTmp, 'file.png'), Buffer.from('img'));
    mockConfigMediaDir.mockReturnValue(mediaTmp);
    const workspace = mkdtempSync(join(tmpdir(), 'mp-reloc-skip-'));
    const destDir = join(workspace, 'media');
    // Pre-create the dir AND mark it remembered to simulate a prior
    // successful call. With the LRU guard hit, the function must NOT call
    // mkdirSync, but it must still copy the file.
    mkdirSync(destDir, { recursive: true, mode: 0o700 });
    __rememberCreatedMediaDirForTests(destDir);

    const result = relocateMediaToWorkspace(
      `inline ${mediaTmp}/file.png ref`,
      workspace,
    );
    expect(result).toContain(join(destDir, 'file.png'));
    expect(existsSync(join(destDir, 'file.png'))).toBe(true);
  });

  it('returns content unchanged when mkdirSync throws (workspace path is a file)', () => {
    __resetCreatedMediaDirsForTests();
    const parent = mkdtempSync(join(tmpdir(), 'mp-mkdirfail-'));
    // workspacePath resolves to a regular file, not a directory — mkdirSync
    // of `<file>/media` will throw ENOTDIR.
    const fakeWorkspace = join(parent, 'fake-ws');
    writeFileSync(fakeWorkspace, 'not a dir');
    mockConfigMediaDir.mockReturnValue('/var/folders/whatsoup/media/tmp');
    const content = 'See /var/folders/whatsoup/media/tmp/abc.jpg for details';
    const result = relocateMediaToWorkspace(content, fakeWorkspace);
    expect(result).toBe(content);
  });

  it('keeps the original media path in content when copyFileSync throws (no rewrite)', () => {
    __resetCreatedMediaDirsForTests();
    const mediaTmp = mkdtempSync(join(tmpdir(), 'mp-mediadir-missing-'));
    mockConfigMediaDir.mockReturnValue(mediaTmp);
    // No source file created → real copyFileSync will throw ENOENT.
    const content = `See ${mediaTmp}/missing.jpg for details`;
    const workspace = mkdtempSync(join(tmpdir(), 'mp-reloc-fail-'));

    const result = relocateMediaToWorkspace(content, workspace);
    expect(result).toBe(content);
  });

  it('replaces every occurrence of the media tmp dir path in the content', () => {
    __resetCreatedMediaDirsForTests();
    const mediaTmp = mkdtempSync(join(tmpdir(), 'mp-mediadir-multi-'));
    writeFileSync(join(mediaTmp, 'a.jpg'), Buffer.from('a'));
    writeFileSync(join(mediaTmp, 'b.png'), Buffer.from('b'));
    writeFileSync(join(mediaTmp, 'c.pdf'), Buffer.from('c'));
    mockConfigMediaDir.mockReturnValue(mediaTmp);
    const content = [
      `first ${mediaTmp}/a.jpg one`,
      `second ${mediaTmp}/b.png two`,
      `third ${mediaTmp}/c.pdf three`,
    ].join('\n');
    const workspace = mkdtempSync(join(tmpdir(), 'mp-reloc-multi-'));

    const result = relocateMediaToWorkspace(content, workspace);
    const destDir = join(workspace, 'media');
    expect(result).toContain(join(destDir, 'a.jpg'));
    expect(result).toContain(join(destDir, 'b.png'));
    expect(result).toContain(join(destDir, 'c.pdf'));
    expect(result).not.toContain(`${mediaTmp}/`);
  });

  it('does not rewrite text that resembles a path but is not under mediaTmpDir', () => {
    __resetCreatedMediaDirsForTests();
    const mediaTmp = mkdtempSync(join(tmpdir(), 'mp-mediadir-mixed-'));
    writeFileSync(join(mediaTmp, 'real.jpg'), Buffer.from('r'));
    mockConfigMediaDir.mockReturnValue(mediaTmp);
    const content = `/elsewhere/file.jpg and ${mediaTmp}/real.jpg`;
    const workspace = mkdtempSync(join(tmpdir(), 'mp-reloc-mixed-'));

    const result = relocateMediaToWorkspace(content, workspace);
    expect(result).toContain('/elsewhere/file.jpg');
    expect(result).not.toContain(`${mediaTmp}/real.jpg`);
    expect(result).toContain(join(workspace, 'media', 'real.jpg'));
  });

  it('escapes regex metacharacters in the mediaTmpDir path', () => {
    __resetCreatedMediaDirsForTests();
    // Use a path with regex metacharacters: the dot and + in `.dir+test`
    // would, without proper escaping, change the regex semantics. We need
    // the production code to escape these for `RegExp` to match the
    // literal string.
    const baseName = 'mp-mediadir-regex';
    const suffix = '.dir+test';
    const base = mkdtempSync(join(tmpdir(), `${baseName}-`));
    // Create a sibling directory whose name contains regex metachars.
    const mediaTmp = base + suffix;
    mkdirSync(mediaTmp, { recursive: true });
    writeFileSync(join(mediaTmp, 'x.jpg'), Buffer.from('x'));
    mockConfigMediaDir.mockReturnValue(mediaTmp);
    const content = `see ${mediaTmp}/x.jpg here`;
    const workspace = mkdtempSync(join(tmpdir(), 'mp-reloc-regex-'));

    const result = relocateMediaToWorkspace(content, workspace);
    expect(result).toContain(join(workspace, 'media', 'x.jpg'));
    expect(result).not.toContain(`${mediaTmp}/x.jpg`);
  });

  it('skips mkdirSync on second invocation once the dir is remembered', () => {
    __resetCreatedMediaDirsForTests();
    const mediaTmp = mkdtempSync(join(tmpdir(), 'mp-mediadir-real-'));
    writeFileSync(join(mediaTmp, 'first.jpg'), Buffer.from('1'));
    writeFileSync(join(mediaTmp, 'second.jpg'), Buffer.from('2'));
    mockConfigMediaDir.mockReturnValue(mediaTmp);
    const workspace = mkdtempSync(join(tmpdir(), 'mp-reloc-real-'));
    const content1 = `one ${mediaTmp}/first.jpg end`;
    const content2 = `two ${mediaTmp}/second.jpg end`;

    const r1 = relocateMediaToWorkspace(content1, workspace);
    const r2 = relocateMediaToWorkspace(content2, workspace);

    expect(r1).toContain(join(workspace, 'media', 'first.jpg'));
    expect(r2).toContain(join(workspace, 'media', 'second.jpg'));
    expect(existsSync(join(workspace, 'media'))).toBe(true);
  });
});
