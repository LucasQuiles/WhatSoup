// tests/runtimes/agent/prepare-content.test.ts
// Unit tests for the prepareContentForAgent function in the agent runtime.
// Media is downloaded and saved to disk; the agent receives file paths.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage } from '../../../src/core/types.ts';

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockUpdateMediaPath } = vi.hoisted(() => ({
  mockUpdateMediaPath: vi.fn(),
}));

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock Baileys — downloadMediaMessage is imported dynamically inside the download fn
vi.mock('@whiskeysockets/baileys', () => ({
  downloadMediaMessage: vi.fn(async () => Buffer.from('media-bytes')),
}));

// Mock media-download module: writeTempFile returns a predictable path
const mockDownloadMedia = vi.fn();
const mockWriteTempFile = vi.fn();

vi.mock('../../../src/core/media-download.ts', () => ({
  downloadMedia: mockDownloadMedia,
  writeTempFile: mockWriteTempFile,
  cleanupTempFile: vi.fn(),
}));

// Mock Whisper transcription
const mockTranscribeAudio = vi.fn();

vi.mock('../../../src/runtimes/chat/providers/whisper.ts', () => ({
  transcribeAudio: mockTranscribeAudio,
}));

// Mock document text extraction
const mockExtractDocumentText = vi.fn();

vi.mock('../../../src/runtimes/chat/media/documents.ts', () => ({
  extractDocumentText: mockExtractDocumentText,
}));

// Mock all the heavyweight agent-runtime dependencies so we can import just
// the exported function without pulling in the entire runtime graph.
vi.mock('../../../src/runtimes/agent/session-db.ts', () => ({
  ensureAgentSchema: vi.fn(),
  createSession: vi.fn(() => 1),
  incrementMessageCount: vi.fn(),
  updateSessionId: vi.fn(),
  updateSessionStatus: vi.fn(),
  getActiveSession: vi.fn(() => null),
  backfillWorkspaceKeys: vi.fn(),
  markOrphaned: vi.fn(),
  sweepOrphanedSessions: vi.fn(() => []),
  getResumableSessionForChat: vi.fn(() => null),
}));

vi.mock('../../../src/runtimes/agent/session.ts', () => ({
  SessionManager: vi.fn().mockImplementation(() => ({
    spawnSession: vi.fn(),
    sendTurn: vi.fn(),
    handleNew: vi.fn(),
    getStatus: vi.fn(() => ({ active: false, pid: null, sessionId: null, startedAt: null, messageCount: 0, lastMessageAt: null })),
    shutdown: vi.fn(),
    clearTurnWatchdog: vi.fn(),
    tickWatchdog: vi.fn(),
  })),
  formatAge: vi.fn(() => '1m ago'),
}));

vi.mock('../../../src/runtimes/agent/outbound-queue.ts', () => ({
  OutboundQueue: vi.fn().mockImplementation(() => ({
    enqueueText: vi.fn(),
    enqueueToolUpdate: vi.fn(),
    indicateTyping: vi.fn(),
    flush: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    abortTurn: vi.fn(),
    updateDeliveryJid: vi.fn(),
    setInboundSeq: vi.fn(),
    markLastTerminal: vi.fn(),
  })),
}));

vi.mock('../../../src/config.ts', () => ({
  config: {
    adminPhones: new Set<string>(),
    toolUpdateMode: 'full',
    pineconeAllowedIndexes: [],
  },
}));

vi.mock('../../../src/core/messages.ts', () => ({
  getRecentMessages: vi.fn(() => []),
  updateMediaPath: mockUpdateMediaPath,
}));

vi.mock('../../../src/core/access-list.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/access-list.ts')>();
  return actual;
});

vi.mock('../../../src/core/workspace.ts', () => ({
  chatJidToWorkspace: vi.fn((_cwd: string, chatJid: string) => ({
    kind: 'dm' as const,
    workspaceKey: chatJid,
    workspacePath: `/tmp/${chatJid}`,
  })),
  provisionWorkspace: vi.fn(() => '/tmp/test.sock'),
  writeSandboxArtifacts: vi.fn(),
  ensurePermissionsSettings: vi.fn(),
}));

vi.mock('../../../src/mcp/socket-server.ts', () => ({
  WhatSoupSocketServer: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    updateDeliveryJid: vi.fn(),
  })),
}));

vi.mock('../../../src/mcp/registry.ts', () => ({
  ToolRegistry: class {
    register = vi.fn();
    listTools = vi.fn(() => []);
    call = vi.fn();
  },
}));

vi.mock('../../../src/mcp/register-all.ts', () => ({
  registerAllTools: vi.fn(),
}));

vi.mock('../../../src/runtimes/agent/media-bridge.ts', () => ({
  startMediaBridge: vi.fn(async () => ({})),
  setMediaBridgeChat: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, mkdirSync: vi.fn(), writeFileSync: vi.fn() };
});

// ─── Import under test ────────────────────────────────────────────────────────

import { prepareContentForAgent } from '../../../src/runtimes/agent/runtime.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: 'msg-1',
    chatJid: 'test@s.whatsapp.net',
    senderJid: 'sender@s.whatsapp.net',
    senderName: 'Test User',
    content: null,
    contentType: 'audio',
    isFromMe: false,
    isGroup: false,
    mentionedJids: [],
    timestamp: Date.now(),
    quotedMessageId: null,
    isResponseWorthy: true,
    rawMessage: { key: 'raw-msg' },
    ...overrides,
  };
}

const FAKE_PATH = '/tmp/whatsoup/media/tmp/abcdef12.jpg';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('prepareContentForAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: successful download returning a buffer
    mockDownloadMedia.mockResolvedValue({ buffer: Buffer.from('media-bytes'), mimeType: 'image/jpeg' });
    mockWriteTempFile.mockReturnValue(FAKE_PATH);
    mockTranscribeAudio.mockResolvedValue('Hello world transcription.');
    mockExtractDocumentText.mockResolvedValue('Extracted document text.');
    mockUpdateMediaPath.mockReset();
  });

  // ── text passthrough ──────────────────────────────────────────────────────

  it('returns content as-is for text messages (non-null)', async () => {
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

  // ── images: file path in brackets ─────────────────────────────────────────

  it('returns file path for image without caption', async () => {
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

  // ── sticker ────────────────────────────────────────────────────────────────

  it('returns sticker file path for sticker messages', async () => {
    mockWriteTempFile.mockReturnValue('/tmp/sticker.webp');
    const msg = makeMsg({ contentType: 'sticker', content: null });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('[Sticker: /tmp/sticker.webp]');
    expect(mockWriteTempFile).toHaveBeenCalledWith(expect.any(Buffer), 'webp');
  });

  // ── audio: transcription + file path ──────────────────────────────────────

  it('returns transcription and file path for audio messages', async () => {
    mockWriteTempFile.mockReturnValue('/tmp/voice.ogg');
    const msg = makeMsg({ contentType: 'audio', content: null });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('[Voice note transcription]: Hello world transcription.\n[Audio file: /tmp/voice.ogg]');
    expect(mockTranscribeAudio).toHaveBeenCalledOnce();
    expect(mockWriteTempFile).toHaveBeenCalledWith(expect.any(Buffer), 'ogg');
  });

  it('includes download function when rawMessage is present', async () => {
    const msg = makeMsg({ contentType: 'audio', rawMessage: { some: 'raw' } });
    await prepareContentForAgent(msg);
    const [downloadFn] = mockDownloadMedia.mock.calls[0];
    expect(downloadFn).toBeTypeOf('function');
  });

  it('returns fallback when rawMessage is absent (no downloadFn for audio)', async () => {
    const msg = makeMsg({ contentType: 'audio', rawMessage: undefined });
    const result = await prepareContentForAgent(msg);
    // No typeInfo match because downloadFn is null → falls through to default path
    expect(result).toContain('audio');
    expect(mockDownloadMedia).not.toHaveBeenCalled();
  });

  // ── video ──────────────────────────────────────────────────────────────────

  it('returns video file path for video without caption', async () => {
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

  // ── document: file path + extracted text ──────────────────────────────────

  it('returns document file path and extracted text', async () => {
    mockDownloadMedia.mockResolvedValue({ buffer: Buffer.from('pdf-bytes'), mimeType: 'application/pdf' });
    mockWriteTempFile.mockReturnValue('/tmp/report.pdf');
    const msg = makeMsg({ contentType: 'document', content: 'report.pdf' });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('[Document: /tmp/report.pdf]\nExtracted document text.');
    expect(mockWriteTempFile).toHaveBeenCalledWith(expect.any(Buffer), 'pdf');
    expect(mockExtractDocumentText).toHaveBeenCalledOnce();
  });

  it('preserves original extension from document filename', async () => {
    mockDownloadMedia.mockResolvedValue({ buffer: Buffer.from('xlsx-bytes'), mimeType: 'application/vnd.ms-excel' });
    mockWriteTempFile.mockReturnValue('/tmp/data.xlsx');
    const msg = makeMsg({ contentType: 'document', content: 'data.xlsx' });
    await prepareContentForAgent(msg);
    expect(mockWriteTempFile).toHaveBeenCalledWith(expect.any(Buffer), 'xlsx');
  });

  it('falls back to bin extension for document with no filename', async () => {
    mockDownloadMedia.mockResolvedValue({ buffer: Buffer.from('bin-bytes'), mimeType: 'application/octet-stream' });
    mockWriteTempFile.mockReturnValue('/tmp/file.bin');
    const msg = makeMsg({ contentType: 'document', content: null });
    await prepareContentForAgent(msg);
    expect(mockWriteTempFile).toHaveBeenCalledWith(expect.any(Buffer), 'bin');
  });

  // ── location / contact / poll — no file ───────────────────────────────────

  it('returns location text without downloading any file', async () => {
    const msg = makeMsg({ contentType: 'location', content: '40.7128,-74.0060' });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('[Location: 40.7128,-74.0060]');
    expect(mockDownloadMedia).not.toHaveBeenCalled();
  });

  it('returns fallback for location with null content', async () => {
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

  it('returns poll text without downloading any file', async () => {
    const msg = makeMsg({ contentType: 'poll', content: 'Best pizza?' });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('[Poll: Best pizza?]');
    expect(mockDownloadMedia).not.toHaveBeenCalled();
  });

  // ── download failure ───────────────────────────────────────────────────────

  it('returns download-failed label when media download fails for image', async () => {
    mockDownloadMedia.mockResolvedValue(null);
    const msg = makeMsg({ contentType: 'image', content: null });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('[image — download failed]');
    expect(mockWriteTempFile).not.toHaveBeenCalled();
  });

  it('appends caption to download-failed label when caption present', async () => {
    mockDownloadMedia.mockResolvedValue(null);
    const msg = makeMsg({ contentType: 'image', content: 'nice pic' });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('[image — download failed]\nnice pic');
  });

  // ── unknown / fallback ────────────────────────────────────────────────────

  it('returns fallback label for unknown content type with no rawMessage', async () => {
    const msg = makeMsg({ contentType: 'unknown', content: null, rawMessage: undefined });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('[unknown message received]');
  });

  it('returns content for unknown type when content is present', async () => {
    const msg = makeMsg({ contentType: 'unknown', content: 'some content', rawMessage: undefined });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('some content');
  });

  // ── media_path persistence ────────────────────────────────────────────────

  it('calls updateMediaPath with db and messageId after writeTempFile for image', async () => {
    mockWriteTempFile.mockReturnValue('/tmp/img.jpg');
    const fakeDb = { raw: {} } as any;
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
    const fakeDb = { raw: {} } as any;
    const msg = makeMsg({ contentType: 'image', content: null });
    await prepareContentForAgent(msg, fakeDb, undefined);
    expect(mockUpdateMediaPath).not.toHaveBeenCalled();
  });

  it('still returns file path even if updateMediaPath throws', async () => {
    mockWriteTempFile.mockReturnValue('/tmp/img.jpg');
    mockUpdateMediaPath.mockImplementation(() => { throw new Error('db error'); });
    const fakeDb = { raw: {} } as any;
    const msg = makeMsg({ contentType: 'image', content: null, messageId: 'msg-err' });
    const result = await prepareContentForAgent(msg, fakeDb, 'msg-err');
    expect(result).toBe('[Image: /tmp/img.jpg]');
  });
});
