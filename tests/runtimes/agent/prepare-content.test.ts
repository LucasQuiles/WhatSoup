// tests/runtimes/agent/prepare-content.test.ts
// Unit tests for the prepareContentForAgent function in the agent runtime.
// Media pipeline (processMedia) is mocked to isolate the agent-specific logic.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage } from '../../../src/core/types.ts';

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock the processMedia import used inside prepareContentForAgent
const mockProcessMedia = vi.fn();

vi.mock('../../../src/runtimes/chat/media/processor.ts', () => ({
  processMedia: mockProcessMedia,
}));

// Mock Baileys — downloadMediaMessage is imported dynamically inside the download fn
vi.mock('@whiskeysockets/baileys', () => ({
  downloadMediaMessage: vi.fn(async () => Buffer.from('audio-bytes')),
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
  },
}));

vi.mock('../../../src/core/messages.ts', () => ({
  getRecentMessages: vi.fn(() => []),
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('prepareContentForAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── text passthrough ──────────────────────────────────────────────────────

  it('returns content as-is for text messages (non-null)', async () => {
    const msg = makeMsg({ contentType: 'text', content: 'hello world' });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('hello world');
    expect(mockProcessMedia).not.toHaveBeenCalled();
  });

  it('returns empty string for text messages with null content', async () => {
    const msg = makeMsg({ contentType: 'text', content: null });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('');
    expect(mockProcessMedia).not.toHaveBeenCalled();
  });

  // ── audio / transcription ─────────────────────────────────────────────────

  it('returns transcription text for audio messages', async () => {
    mockProcessMedia.mockResolvedValue({ content: 'This is a transcription.', images: [] });
    const msg = makeMsg({ contentType: 'audio', content: null });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('This is a transcription.');
    expect(mockProcessMedia).toHaveBeenCalledOnce();
  });

  it('returns fallback label when audio transcription produces empty string', async () => {
    mockProcessMedia.mockResolvedValue({ content: '', images: [] });
    const msg = makeMsg({ contentType: 'audio', content: null });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('[audio message received]');
  });

  it('includes download function when rawMessage is present', async () => {
    mockProcessMedia.mockResolvedValue({ content: 'transcribed', images: [] });
    const msg = makeMsg({ contentType: 'audio', rawMessage: { some: 'raw' } });
    await prepareContentForAgent(msg);
    const [, downloadFn] = mockProcessMedia.mock.calls[0];
    expect(downloadFn).toBeTypeOf('function');
  });

  it('passes null download function when rawMessage is absent', async () => {
    mockProcessMedia.mockResolvedValue({ content: '[audio — couldn\'t download]', images: [] });
    const msg = makeMsg({ contentType: 'audio', rawMessage: undefined });
    await prepareContentForAgent(msg);
    const [, downloadFn] = mockProcessMedia.mock.calls[0];
    expect(downloadFn).toBeNull();
  });

  // ── document extraction ───────────────────────────────────────────────────

  it('returns extracted text for document messages', async () => {
    mockProcessMedia.mockResolvedValue({ content: 'Document text content here.', images: [] });
    const msg = makeMsg({ contentType: 'document', content: 'report.pdf' });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('Document text content here.');
  });

  // ── images: visual label replaces buffer ──────────────────────────────────

  it('returns image label (no caption) for image without caption', async () => {
    mockProcessMedia.mockResolvedValue({
      content: '',
      images: [{ mimeType: 'image/jpeg', base64: 'abc123' }],
    });
    const msg = makeMsg({ contentType: 'image', content: null });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('[Image received — visual not available in text mode]');
  });

  it('includes caption text alongside image label when caption is present', async () => {
    mockProcessMedia.mockResolvedValue({
      content: 'Check this out',
      images: [{ mimeType: 'image/jpeg', base64: 'abc123' }],
    });
    const msg = makeMsg({ contentType: 'image', content: 'Check this out' });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('Check this out\n[Image received — visual not available in text mode]');
  });

  it('returns sticker label for sticker messages', async () => {
    mockProcessMedia.mockResolvedValue({
      content: '',
      images: [{ mimeType: 'image/webp', base64: 'stk' }],
    });
    const msg = makeMsg({ contentType: 'sticker', content: null });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('[Sticker received — visual not available in text mode]');
  });

  it('returns video label for video messages', async () => {
    mockProcessMedia.mockResolvedValue({
      content: '[Video frames at: 0s, 5s]',
      images: [{ mimeType: 'image/jpeg', base64: 'frm' }],
    });
    const msg = makeMsg({ contentType: 'video', content: null });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('[Video frames at: 0s, 5s]\n[Video received — frames not available in text mode]');
  });

  // ── location / contact / poll ─────────────────────────────────────────────

  it('returns location text from processMedia for location messages', async () => {
    mockProcessMedia.mockResolvedValue({ content: '[Location: 40.7128,-74.0060]', images: [] });
    const msg = makeMsg({ contentType: 'location', content: '40.7128,-74.0060' });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('[Location: 40.7128,-74.0060]');
  });

  it('returns contact text from processMedia for contact messages', async () => {
    mockProcessMedia.mockResolvedValue({ content: '[Contact: Alice]', images: [] });
    const msg = makeMsg({ contentType: 'contact', content: 'Alice' });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('[Contact: Alice]');
  });

  it('returns poll text from processMedia for poll messages', async () => {
    mockProcessMedia.mockResolvedValue({ content: '[Poll: Best pizza?]', images: [] });
    const msg = makeMsg({ contentType: 'poll', content: 'Best pizza?' });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('[Poll: Best pizza?]');
  });

  // ── unknown / fallback ────────────────────────────────────────────────────

  it('returns fallback label for unknown content type when processMedia returns empty', async () => {
    mockProcessMedia.mockResolvedValue({ content: '', images: [] });
    const msg = makeMsg({ contentType: 'unknown', content: null });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('[unknown message received]');
  });

  it('returns processMedia content for unknown type when it has content', async () => {
    mockProcessMedia.mockResolvedValue({ content: '[unsupported message type]', images: [] });
    const msg = makeMsg({ contentType: 'unknown', content: null });
    const result = await prepareContentForAgent(msg);
    expect(result).toBe('[unsupported message type]');
  });
});
