// tests/mcp/tools/media.test.ts

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, mkdirSync, symlinkSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import { registerMediaTools, type MediaDeps } from '../../../src/mcp/tools/media.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';
import { Database } from '../../../src/core/database.ts';

const { mockDownloadMediaMessage, mockTranscribeAudio, mockCoreDownloadMedia, realDownloadMediaHolder } = vi.hoisted(() => ({
  mockDownloadMediaMessage: vi.fn(),
  mockTranscribeAudio: vi.fn(),
  mockCoreDownloadMedia: vi.fn(),
  // Holds the real downloadMedia function captured during the vi.mock factory.
  // Use this to restore the default pass-through without re-importing the mock module.
  realDownloadMediaHolder: { fn: null as null | ((...args: unknown[]) => unknown) },
}));

vi.mock('@whiskeysockets/baileys', () => ({
  downloadMediaMessage: mockDownloadMediaMessage,
}));

vi.mock('../../../src/runtimes/chat/providers/whisper.ts', () => ({
  transcribeAudio: mockTranscribeAudio,
}));

// Wrap media-download so individual tests can intercept downloadMedia (coreDownloadMedia).
// The default delegates to the real module; error-path tests use mockRejectedValueOnce / mockResolvedValueOnce.
// realDownloadMediaHolder.fn is captured here (from importActual) so beforeEach can safely
// restore the default without re-importing the mock module (which would cause infinite recursion).
vi.mock('../../../src/core/media-download.ts', async (importActual) => {
  const real = await importActual<typeof import('../../../src/core/media-download.ts')>();
  realDownloadMediaHolder.fn = real.downloadMedia as (...args: unknown[]) => unknown;
  mockCoreDownloadMedia.mockImplementation(real.downloadMedia);
  return {
    writeTempFile: real.writeTempFile,
    downloadMedia: mockCoreDownloadMedia,
  };
});

// Mock config so path confinement checks use tmpdir() as the managed media directory.
// This allows tests to write files under /tmp and have them treated as within the media base.
vi.mock('../../../src/config.ts', () => ({
  config: {
    mediaDir: tmpdir(),
    adminPhones: new Set<string>(),
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDir(): string {
  const dir = join(tmpdir(), `whatsoup-media-test-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeCalls(): Array<{ chatJid: string; media: unknown }> {
  return [];
}

function makeConnection(mediaCalls: Array<{ chatJid: string; media: unknown }>) {
  return {
    sendMedia: async (chatJid: string, media: unknown) => {
      mediaCalls.push({ chatJid, media });
      return { waMessageId: null };
    },
  } as unknown as import('../../../src/transport/connection.ts').ConnectionManager;
}

function chatSession(
  conversationKey: string,
  deliveryJid: string,
  allowedRoot?: string,
): SessionContext {
  return { tier: 'chat-scoped', conversationKey, deliveryJid, allowedRoot };
}

function globalSession(): SessionContext {
  return { tier: 'global' };
}

function destroyCapturedMediaStreams(mediaCalls: Array<{ media: unknown }>): void {
  for (const { media } of mediaCalls) {
    const stream = (media as { stream?: { destroy?: () => void; on?: (event: 'error', listener: () => void) => void } } | null)?.stream;
    stream?.on?.('error', () => {});
    stream?.destroy?.();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const testDb = new Database(':memory:');
testDb.open();

describe('registerMediaTools', () => {
  let registry: ToolRegistry;
  let mediaCalls: Array<{ chatJid: string; media: unknown }>;
  let connection: ReturnType<typeof makeConnection>;
  let deps: MediaDeps;
  let workspace: string;
  let filesToClean: string[] = [];
  let dirsToClean: string[] = [];

  afterAll(() => {
    testDb.close();
  });

  beforeEach(() => {
    registry = new ToolRegistry();
    mediaCalls = makeCalls();
    connection = makeConnection(mediaCalls);
    deps = { connection, db: testDb };
    registerMediaTools(registry, deps);
    workspace = tempDir();
    dirsToClean.push(workspace);
    filesToClean = [];
  });

  afterEach(() => {
    destroyCapturedMediaStreams(mediaCalls);
    for (const f of filesToClean) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
    for (const d of [...dirsToClean].reverse()) {
      try { rmdirSync(d, { recursive: true } as any); } catch { /* ignore */ }
    }
    dirsToClean = [];
  });

  function writeFile(filename: string, content: Buffer | string = 'test'): string {
    const p = join(workspace, filename);
    writeFileSync(p, content);
    filesToClean.push(p);
    return p;
  }

  // ── media type routing ────────────────────────────────────────────────────

  it('accepts a file under a macOS tmpdir workspace (canonicalizes /var/folders ↔ /private/var/folders)', async () => {
    // Regression: allowedRoot = /var/folders/... but realpathSync(filePath) = /private/var/folders/...
    // Previously the startsWith check failed on every macOS tmpdir workspace. isPathWithinAllowedRoot
    // now canonicalizes both sides via realpathSync before comparing.
    const filePath = writeFile('regression-macos-tmpdir.jpg');
    const session = chatSession('1234567890', '1234567890@s.whatsapp.net', workspace);

    const result = await registry.call('send_media', { filePath }, session);

    expect(result.isError).toBeUndefined();
    expect(mediaCalls).toHaveLength(1);
  });

  it('sends an image file', async () => {
    const filePath = writeFile('photo.jpg');
    const session = chatSession('1234567890', '1234567890@s.whatsapp.net', workspace);

    const result = await registry.call(
      'send_media',
      { filePath, caption: 'A photo' },
      session,
    );

    expect(result.isError).toBeUndefined();
    expect(mediaCalls).toHaveLength(1);
    const media = mediaCalls[0].media as any;
    expect(media.type).toBe('image');
    expect(media.mimetype).toBe('image/jpeg');
    expect(media.caption).toBe('A photo');
    expect(media.stream).toBeDefined();
    expect(media.buffer).toBeUndefined();
    media.stream.destroy();
  });

  // ── client-safety guardrail: a media caption is agent free-text too ──────
  it('redacts an internal path leaked in a media caption before sending', async () => {
    const filePath = writeFile('leaky.jpg');
    // JID assembled at runtime so no literal user-JID appears in committed source.
    const jid = `${'1234567890'}@${'s.whatsapp.net'}`;
    const session = chatSession('1234567890', jid, workspace);

    const result = await registry.call(
      'send_media',
      { filePath, caption: 'saved at /Users/testuser/.claude/settings.json fyi' },
      session,
    );

    expect(result.isError).toBeUndefined();
    const media = mediaCalls[0].media as any;
    expect(media.caption).not.toContain('/Users/testuser');
    expect(media.caption).not.toContain('settings.json');
    media.stream.destroy();
  });

  it('retries Baileys encrypted tmp ENOENT with a fresh stream for file sends', async () => {
    const filePath = writeFile('photo.jpg');
    const session = chatSession('15551234567', '15551234567@s.whatsapp.net', workspace);
    const tmpErr = Object.assign(
      new Error('ENOENT: no such file or directory, open /tmp/image123-enc'),
      { code: 'ENOENT', path: '/tmp/image123-enc' },
    );
    connection.sendMedia = vi.fn(async (chatJid: string, media: unknown) => {
      mediaCalls.push({ chatJid, media });
      if (mediaCalls.length === 1) throw tmpErr;
      return { waMessageId: null };
    }) as typeof connection.sendMedia;

    const result = await registry.call('send_media', { filePath }, session);

    expect(result.isError).toBeUndefined();
    expect(connection.sendMedia).toHaveBeenCalledTimes(2);
    expect(mediaCalls).toHaveLength(2);
    expect((mediaCalls[0].media as { stream?: unknown }).stream).toBeDefined();
    expect((mediaCalls[1].media as { stream?: unknown }).stream).toBeDefined();
    expect((mediaCalls[0].media as { stream?: unknown }).stream)
      .not.toBe((mediaCalls[1].media as { stream?: unknown }).stream);
  });

  it('sends a PNG image file', async () => {
    const filePath = writeFile('image.png');
    const session = chatSession('1234567890', '1234567890@s.whatsapp.net', workspace);

    await registry.call('send_media', { filePath }, session);

    const media = mediaCalls[0].media as any;
    expect(media.type).toBe('image');
    expect(media.mimetype).toBe('image/png');
  });

  it('sends a document file', async () => {
    const filePath = writeFile('report.pdf');
    const session = chatSession('1234567890', '1234567890@s.whatsapp.net', workspace);

    await registry.call('send_media', { filePath }, session);

    const media = mediaCalls[0].media as any;
    expect(media.type).toBe('document');
    expect(media.mimetype).toBe('application/pdf');
    expect(media.filename).toBe('report.pdf');
  });

  it('sends an audio file', async () => {
    const filePath = writeFile('song.mp3');
    const session = chatSession('1234567890', '1234567890@s.whatsapp.net', workspace);

    await registry.call('send_media', { filePath }, session);

    const media = mediaCalls[0].media as any;
    expect(media.type).toBe('audio');
    expect(media.mimetype).toBe('audio/mpeg');
  });

  it('sends a video file', async () => {
    const filePath = writeFile('clip.mp4');
    const session = chatSession('1234567890', '1234567890@s.whatsapp.net', workspace);

    await registry.call('send_media', { filePath }, session);

    const media = mediaCalls[0].media as any;
    expect(media.type).toBe('video');
    expect(media.mimetype).toBe('video/mp4');
  });

  it('sends a .webp file as a sticker', async () => {
    const filePath = writeFile('sticker.webp');
    const session = chatSession('1234567890', '1234567890@s.whatsapp.net', workspace);

    await registry.call('send_media', { filePath }, session);

    const media = mediaCalls[0].media as any;
    expect(media.type).toBe('sticker');
    expect(media.mimetype).toBe('image/webp');
  });

  it('sends a sticker with isAnimated flag', async () => {
    const filePath = writeFile('animated.webp');
    const session = chatSession('1234567890', '1234567890@s.whatsapp.net', workspace);

    await registry.call('send_media', { filePath, isAnimated: true }, session);

    const media = mediaCalls[0].media as any;
    expect(media.type).toBe('sticker');
    expect(media.isAnimated).toBe(true);
  });

  it('infers MIME type from .ogg extension', async () => {
    const filePath = writeFile('voice.ogg');
    const session = chatSession('1234567890', '1234567890@s.whatsapp.net', workspace);

    await registry.call('send_media', { filePath }, session);

    const media = mediaCalls[0].media as any;
    expect(media.mimetype).toContain('audio/ogg');
  });

  // ── new capability: voice note seconds ───────────────────────────────────

  it('passes ptt and seconds for audio', async () => {
    const filePath = writeFile('voice.ogg');
    const session = chatSession('1234567890', '1234567890@s.whatsapp.net', workspace);

    await registry.call('send_media', { filePath, ptt: true, seconds: 12 }, session);

    const media = mediaCalls[0].media as any;
    expect(media.type).toBe('audio');
    expect(media.ptt).toBe(true);
    expect(media.seconds).toBe(12);
  });

  // ── new capability: PTV video note ───────────────────────────────────────

  it('sends video as PTV (round video note)', async () => {
    const filePath = writeFile('note.mp4');
    const session = chatSession('1234567890', '1234567890@s.whatsapp.net', workspace);

    await registry.call('send_media', { filePath, ptv: true }, session);

    const media = mediaCalls[0].media as any;
    expect(media.type).toBe('video');
    expect(media.ptv).toBe(true);
  });

  // ── new capability: GIF playback ─────────────────────────────────────────

  it('sends video with gifPlayback flag', async () => {
    const filePath = writeFile('anim.mp4');
    const session = chatSession('1234567890', '1234567890@s.whatsapp.net', workspace);

    await registry.call('send_media', { filePath, gifPlayback: true }, session);

    const media = mediaCalls[0].media as any;
    expect(media.type).toBe('video');
    expect(media.gifPlayback).toBe(true);
  });

  // ── new capability: viewOnce ──────────────────────────────────────────────

  it('sends image with viewOnce flag', async () => {
    const filePath = writeFile('secret.jpg');
    const session = chatSession('1234567890', '1234567890@s.whatsapp.net', workspace);

    await registry.call('send_media', { filePath, viewOnce: true }, session);

    const media = mediaCalls[0].media as any;
    expect(media.type).toBe('image');
    expect(media.viewOnce).toBe(true);
  });

  it('sends video with viewOnce flag', async () => {
    const filePath = writeFile('secret.mp4');
    const session = chatSession('1234567890', '1234567890@s.whatsapp.net', workspace);

    await registry.call('send_media', { filePath, viewOnce: true }, session);

    const media = mediaCalls[0].media as any;
    expect(media.type).toBe('video');
    expect(media.viewOnce).toBe(true);
  });

  // ── file size rejection ───────────────────────────────────────────────────

  it('rejects files larger than 50 MB', async () => {
    // Write a file header then truncate to 51 MB without allocating real memory
    const filePath = join(workspace, 'big.mp4');
    // Create a sparse file by writing a byte at offset 51MB
    const fd = require('fs').openSync(filePath, 'w');
    require('fs').writeSync(fd, Buffer.alloc(1), 0, 1, 51 * 1024 * 1024);
    require('fs').closeSync(fd);
    filesToClean.push(filePath);

    const session = chatSession('1234567890', '1234567890@s.whatsapp.net', workspace);
    const result = await registry.call('send_media', { filePath }, session);

    const body = JSON.parse(result.content[0].text);
    expect(body.error).toMatch(/too large/);
  });

  // ── unsupported extension ─────────────────────────────────────────────────

  it('rejects unsupported file extension', async () => {
    const filePath = writeFile('data.xyz');
    const session = chatSession('1234567890', '1234567890@s.whatsapp.net', workspace);

    const result = await registry.call('send_media', { filePath }, session);

    const body = JSON.parse(result.content[0].text);
    expect(body.error).toMatch(/Unsupported file extension/);
  });

  // ── mediaType override ────────────────────────────────────────────────────

  it('overrides auto-detected type when mediaType is provided', async () => {
    const filePath = writeFile('image.png');
    const session = chatSession('1234567890', '1234567890@s.whatsapp.net', workspace);

    const result = await registry.call(
      'send_media',
      { filePath, mediaType: 'sticker' },
      session,
    );

    expect(result.isError).toBeUndefined();
    const media = mediaCalls[0].media as any;
    expect(media.type).toBe('sticker');
    // MIME still comes from extension
    expect(media.mimetype).toBe('image/png');
  });

  // Gap #32: media type override path — effectiveType = mediaTypeOverride ?? mediaInfo.type
  // Exercises every branch of the switch(effectiveType) when the override is supplied.
  it('sends mp3 as document when mediaType override is "document"', async () => {
    const filePath = writeFile('audio.mp3');
    const session = chatSession('1234567890', '1234567890@s.whatsapp.net', workspace);

    const result = await registry.call(
      'send_media',
      { filePath, mediaType: 'document', filename: 'lecture.mp3' },
      session,
    );

    expect(result.isError).toBeUndefined();
    const media = mediaCalls[0].media as any;
    // Override wins: type should be document, not audio
    expect(media.type).toBe('document');
    // MIME is still inferred from the .mp3 extension
    expect(media.mimetype).toBe('audio/mpeg');
    // Filename is passed through for document type
    expect(media.filename).toBe('lecture.mp3');
  });

  it('reports the overridden mediaType in the success result', async () => {
    const filePath = writeFile('clip.mp4');
    const session = chatSession('1234567890', '1234567890@s.whatsapp.net', workspace);

    const result = await registry.call(
      'send_media',
      { filePath, mediaType: 'document' },
      session,
    );

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    // The response mediaType should reflect the effective (overridden) type
    expect(body.mediaType).toBe('document');
  });

  // ── path boundary enforcement ─────────────────────────────────────────────

  it('rejects absolute path outside allowedRoot', async () => {
    const outsidePath = join(tmpdir(), `outside-${randomBytes(4).toString('hex')}.jpg`);
    writeFileSync(outsidePath, 'data');
    filesToClean.push(outsidePath);

    const session = chatSession('1234567890', '1234567890@s.whatsapp.net', workspace);
    const result = await registry.call('send_media', { filePath: outsidePath }, session);

    const body = JSON.parse(result.content[0].text);
    expect(body.error).toMatch(/Path outside workspace/);
  });

  it('rejects symlink that escapes the workspace boundary', async () => {
    // Create a real file outside workspace
    const outsidePath = join(tmpdir(), `escape-target-${randomBytes(4).toString('hex')}.jpg`);
    writeFileSync(outsidePath, 'secret');
    filesToClean.push(outsidePath);

    // Create a symlink inside workspace pointing outside
    const linkPath = join(workspace, 'escape.jpg');
    symlinkSync(outsidePath, linkPath);
    filesToClean.push(linkPath);

    const session = chatSession('1234567890', '1234567890@s.whatsapp.net', workspace);
    const result = await registry.call('send_media', { filePath: linkPath }, session);

    const body = JSON.parse(result.content[0].text);
    expect(body.error).toMatch(/Path outside workspace/);
  });

  it('accepts symlink that resolves within the workspace', async () => {
    // Create real file inside workspace
    const realFile = writeFile('real.jpg');

    // Create symlink also inside workspace pointing to the real file
    const linkPath = join(workspace, 'link.jpg');
    symlinkSync(realFile, linkPath);
    filesToClean.push(linkPath);

    const session = chatSession('1234567890', '1234567890@s.whatsapp.net', workspace);
    const result = await registry.call('send_media', { filePath: linkPath }, session);

    expect(result.isError).toBeUndefined();
    expect(mediaCalls).toHaveLength(1);
  });

  it('rejects any path for a global session without allowedRoot (fail-closed, #1094)', async () => {
    // Write to a location outside of any workspace
    const outsidePath = join(tmpdir(), `global-test-${randomBytes(4).toString('hex')}.jpg`);
    writeFileSync(outsidePath, 'data');
    filesToClean.push(outsidePath);

    // Global session has no allowedRoot -> fail closed: the boundary check must
    // reject the path rather than allowing arbitrary host-file reads (audit #1094).
    const result = await registry.call(
      'send_media',
      { filePath: outsidePath, chatJid: '1234567890@s.whatsapp.net' },
      globalSession(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/outside|allowed root|workspace/i);
    expect(mediaCalls).toHaveLength(0);
  });

  it('returns error for nonexistent file', async () => {
    const session = chatSession('1234567890', '1234567890@s.whatsapp.net', workspace);
    const result = await registry.call(
      'send_media',
      { filePath: join(workspace, 'ghost.jpg') },
      session,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.error).toMatch(/File not found/);
  });
});

// ---------------------------------------------------------------------------
// download_media
// ---------------------------------------------------------------------------

describe('download_media', () => {
  let registry: ToolRegistry;
  let mediaCalls: Array<{ chatJid: string; media: unknown }>;
  let connection: ReturnType<typeof makeConnection>;
  let db: Database;
  let deps: MediaDeps;
  let workspace: string;
  let filesToClean: string[] = [];
  let dirsToClean: string[] = [];

  beforeEach(() => {
    mockDownloadMediaMessage.mockReset();
    mockDownloadMediaMessage.mockResolvedValue(Buffer.from('downloaded-media'));

    db = new Database(':memory:');
    db.open();
    registry = new ToolRegistry();
    mediaCalls = makeCalls();
    connection = makeConnection(mediaCalls);
    deps = { connection, db: db };
    registerMediaTools(registry, deps);
    workspace = tempDir();
    dirsToClean.push(workspace);
    filesToClean = [];
  });

  afterEach(() => {
    db.close();
    for (const f of filesToClean) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
    for (const d of [...dirsToClean].reverse()) {
      try { rmdirSync(d, { recursive: true } as any); } catch { /* ignore */ }
    }
    dirsToClean = [];
  });

  function insertMessage(
    messageId: string,
    contentType: string,
    opts: { mediaPath?: string; rawMessage?: string } = {},
  ): void {
    db.raw.prepare(`
      INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content_type, is_from_me, timestamp, media_path, raw_message)
      VALUES ('chat@g.us', 'chat_at_g.us', 'sender@s.whatsapp.net', ?, ?, 0, 1700000000, ?, ?)
    `).run(messageId, contentType, opts.mediaPath ?? null, opts.rawMessage ?? null);
  }

  it('returns cached file when media_path is set and file exists', async () => {
    const filePath = join(workspace, 'cached.jpg');
    writeFileSync(filePath, 'fake-image-data');
    filesToClean.push(filePath);

    insertMessage('msg-cached', 'image', { mediaPath: filePath });

    const result = await registry.call(
      'download_media',
      { message_id: 'msg-cached' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.file_path).toBe(filePath);
    expect(body.cached).toBe(true);
    expect(body.content_type).toBe('image');
  });

  it('does not return cached media from a different bound conversation', async () => {
    const filePath = join(workspace, 'other-chat.jpg');
    writeFileSync(filePath, 'fake-image-data');
    filesToClean.push(filePath);

    db.raw.prepare(`
      INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content_type, is_from_me, timestamp, media_path)
      VALUES ('other@g.us', 'other_at_g.us', 'sender@s.whatsapp.net', 'msg-other-chat', 'image', 0, 1700000000, ?)
    `).run(filePath);

    const result = await registry.call(
      'download_media',
      { message_id: 'msg-other-chat' },
      { tier: 'global', conversationKey: 'chat_at_g.us' } as SessionContext,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('different conversation');
  });

  it('returns unsupported_type error for text messages', async () => {
    insertMessage('msg-text', 'text');

    const result = await registry.call(
      'download_media',
      { message_id: 'msg-text' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('unsupported_type');
  });

  it('returns error for unknown message_id', async () => {
    const result = await registry.call(
      'download_media',
      { message_id: 'nonexistent' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('not_found');
  });

  it('falls through to download when media_path file is missing from disk', async () => {
    insertMessage('msg-stale', 'image', {
      mediaPath: '/tmp/whatsoup-media/deleted.jpg',
      rawMessage: undefined,
    });

    const result = await registry.call(
      'download_media',
      { message_id: 'msg-stale' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('no_raw_message');
  });

  it('downloads media from raw_message when no cached file exists', async () => {
    // Create a fake raw_message with imageMessage structure
    const rawMessage = JSON.stringify({
      message: {
        imageMessage: {
          url: 'https://mmg.whatsapp.net/fake',
          mimetype: 'image/jpeg',
          mediaKey: Buffer.from('fake-key').toString('base64'),
          fileEncSha256: Buffer.from('fake-hash').toString('base64'),
          fileSha256: Buffer.from('fake-sha').toString('base64'),
          fileLength: 1024,
          directPath: '/fake/path',
        },
      },
    });

    insertMessage('msg-download', 'image', { rawMessage });

    // We can't easily mock Baileys in this integration test, so we verify
    // the error path when Baileys download fails (media expired)
    const result = await registry.call(
      'download_media',
      { message_id: 'msg-download' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.cached).toBe(false);
    expect(body.content_type).toBe('image');
    expect(body.file_size).toBe(Buffer.from('downloaded-media').length);
    expect(existsSync(body.file_path)).toBe(true);
    filesToClean.push(body.file_path);

    const row = db.raw.prepare('SELECT media_path FROM messages WHERE message_id = ?')
      .get('msg-download') as { media_path: string | null };
    expect(row.media_path).toBe(body.file_path);
  });

  it('downloads quoted media when quoted=true on a text message', async () => {
    const rawMessage = JSON.stringify({
      key: {
        remoteJid: 'chat@g.us',
      },
      message: {
        extendedTextMessage: {
          text: 'check this',
          contextInfo: {
            stanzaId: 'quoted-msg-1',
            quotedMessage: {
              imageMessage: {
                mimetype: 'image/png',
                url: 'https://mmg.whatsapp.net/fake-quoted',
                mediaKey: Buffer.from('fake-key').toString('base64'),
              },
            },
          },
        },
      },
    });

    insertMessage('msg-quoted', 'text', { rawMessage });

    const result = await registry.call(
      'download_media',
      { message_id: 'msg-quoted', quoted: true },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.cached).toBe(false);
    expect(body.content_type).toBe('image');
    expect(body.mime_type).toBe('image/png');
    expect(existsSync(body.file_path)).toBe(true);
    filesToClean.push(body.file_path);

    const row = db.raw.prepare('SELECT content_type, media_path FROM messages WHERE message_id = ?')
      .get('msg-quoted') as { content_type: string; media_path: string | null };
    expect({ ...row }).toStrictEqual({ content_type: 'text', media_path: null });
  });

  it('returns no_quoted_media when quoted=true but no downloadable quoted message exists', async () => {
    const rawMessage = JSON.stringify({
      key: {
        remoteJid: 'chat@g.us',
      },
      message: {
        extendedTextMessage: {
          text: 'check this',
          contextInfo: {
            stanzaId: 'quoted-msg-2',
            quotedMessage: {
              conversation: 'plain quoted text',
            },
          },
        },
      },
    });

    insertMessage('msg-no-quoted-media', 'text', { rawMessage });

    const result = await registry.call(
      'download_media',
      { message_id: 'msg-no-quoted-media', quoted: true },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('no_quoted_media');
  });
});

// ---------------------------------------------------------------------------
// transcribe_audio
// ---------------------------------------------------------------------------

describe('transcribe_audio', () => {
  let registry: ToolRegistry;
  let connection: ReturnType<typeof makeConnection>;
  let mediaCalls: Array<{ chatJid: string; media: unknown }>;
  let testDb: Database;
  let deps: MediaDeps;

  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.open();
    registry = new ToolRegistry();
    mediaCalls = makeCalls();
    connection = makeConnection(mediaCalls);
    deps = { connection, db: testDb };
    registerMediaTools(registry, deps);
  });

  afterEach(() => {
    testDb.close();
  });

  function insertAudioMessage(
    messageId: string,
    opts: { mediaPath?: string; content?: string; rawMessage?: string } = {},
  ): void {
    testDb.raw.prepare(`
      INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content_type,
        content, is_from_me, timestamp, media_path, raw_message)
      VALUES ('chat@g.us', 'chat_at_g.us', 'sender@s.whatsapp.net', ?, 'audio', ?, 0, 1700000000, ?, ?)
    `).run(
      messageId,
      opts.content ?? JSON.stringify({ type: 'audio', duration: 10, ptt: true, transcription: null }),
      opts.mediaPath ?? null,
      opts.rawMessage ?? null,
    );
  }

  it('returns error for non-audio message', async () => {
    testDb.raw.prepare(`
      INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content_type, is_from_me, timestamp)
      VALUES ('chat@g.us', 'chat_at_g.us', 'sender@s.whatsapp.net', 'msg-image', 'image', 0, 1700000000)
    `).run();

    const result = await registry.call(
      'transcribe_audio',
      { message_id: 'msg-image' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('not_audio');
  });

  it('returns error for unknown message_id', async () => {
    const result = await registry.call(
      'transcribe_audio',
      { message_id: 'nonexistent' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('not_found');
  });

  it('returns cached transcription if already transcribed', async () => {
    insertAudioMessage('msg-transcribed', {
      content: JSON.stringify({ type: 'audio', duration: 5, ptt: true, transcription: 'Already done' }),
    });

    // Set content_text too
    testDb.raw.prepare('UPDATE messages SET content_text = ? WHERE message_id = ?')
      .run('Already done', 'msg-transcribed');

    const result = await registry.call(
      'transcribe_audio',
      { message_id: 'msg-transcribed' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.transcription).toBe('Already done');
    expect(body.cached).toBe(true);
  });

  it('does not return cached transcription from a different bound conversation', async () => {
    testDb.raw.prepare(`
      INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content_type,
        content, content_text, is_from_me, timestamp)
      VALUES ('other@g.us', 'other_at_g.us', 'sender@s.whatsapp.net', 'msg-other-audio', 'audio',
        ?, 'Secret transcript', 0, 1700000000)
    `).run(JSON.stringify({ type: 'audio', transcription: 'Secret transcript' }));

    const result = await registry.call(
      'transcribe_audio',
      { message_id: 'msg-other-audio' },
      { tier: 'global', conversationKey: 'chat_at_g.us' } as SessionContext,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('different conversation');
    expect(result.content[0].text).not.toContain('Secret transcript');
  });

  it('conversation-bound session: DENIES a cross-conversation transcript via the BINDING even with no top-level conversationKey (fail-open regression)', async () => {
    // Before assertConversationAccess keyed on the binding, a session whose
    // top-level conversationKey was absent fell through the guard entirely —
    // the real-handler proof that the allowlisted transcribe_audio is
    // conversation-safe for bound sessions.
    testDb.raw.prepare(`
      INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content_type,
        content, content_text, is_from_me, timestamp)
      VALUES ('other@g.us', 'other_at_g.us', 'sender@s.whatsapp.net', 'msg-other-audio2', 'audio',
        ?, 'Secret transcript', 0, 1700000000)
    `).run(JSON.stringify({ type: 'audio', transcription: 'Secret transcript' }));

    const result = await registry.call(
      'transcribe_audio',
      { message_id: 'msg-other-audio2' },
      {
        tier: 'global',
        binding: Object.freeze({ kind: 'conversation-bound', conversationKey: 'chat_at_g.us', deliveryJid: 'chat@g.us' }),
      } as SessionContext,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('different conversation');
    expect(result.content[0].text).not.toContain('Secret transcript');
  });

  it('conversation-bound session: serves its OWN conversation transcript (allowlisted global tool, end to end)', async () => {
    insertAudioMessage('msg-own-audio', {
      content: JSON.stringify({ type: 'audio', duration: 5, ptt: true, transcription: 'Own transcript' }),
    });
    testDb.raw.prepare('UPDATE messages SET content_text = ? WHERE message_id = ?')
      .run('Own transcript', 'msg-own-audio');

    const result = await registry.call(
      'transcribe_audio',
      { message_id: 'msg-own-audio' },
      {
        tier: 'global',
        conversationKey: 'chat_at_g.us',
        deliveryJid: 'chat@g.us',
        binding: Object.freeze({ kind: 'conversation-bound', conversationKey: 'chat_at_g.us', deliveryJid: 'chat@g.us' }),
      } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.transcription).toBe('Own transcript');
    expect(body.cached).toBe(true);
  });

  it('returns error when no media_path and no raw_message', async () => {
    insertAudioMessage('msg-no-media');

    const result = await registry.call(
      'transcribe_audio',
      { message_id: 'msg-no-media' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('no_audio_data');
  });

  function audioRawMessage(mimetype?: string): string {
    return JSON.stringify({
      message: {
        audioMessage: {
          url: 'https://mmg.whatsapp.net/fake-audio',
          mimetype,
          mediaKey: Buffer.from('fake-key').toString('base64'),
          fileEncSha256: Buffer.from('fake-hash').toString('base64'),
          fileSha256: Buffer.from('fake-sha').toString('base64'),
          fileLength: 1024,
          directPath: '/fake/audio-path',
        },
      },
    });
  }

  it('downloads raw audio, saves media_path, and uses the downloaded MIME for transcription', async () => {
    mockDownloadMediaMessage.mockResolvedValue(Buffer.from('downloaded-audio'));
    mockTranscribeAudio.mockResolvedValue('downloaded transcript');
    insertAudioMessage('msg-download-audio', {
      rawMessage: audioRawMessage('audio/mp4'),
      content: 'not-json',
    });

    const result = await registry.call(
      'transcribe_audio',
      { message_id: 'msg-download-audio' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body).toEqual({ transcription: 'downloaded transcript', duration: null, cached: false });
    expect(mockDownloadMediaMessage).toHaveBeenCalledOnce();
    const [buffer, mime] = mockTranscribeAudio.mock.calls[0];
    expect((buffer as Buffer).toString()).toBe('downloaded-audio');
    expect(mime).toBe('audio/mp4');

    const row = testDb.raw.prepare('SELECT media_path, content, content_text FROM messages WHERE message_id = ?')
      .get('msg-download-audio') as { media_path: string | null; content: string; content_text: string };
    expect(row.media_path).toMatch(/\.m4a$/);
    expect(existsSync(row.media_path!)).toBe(true);
    expect(JSON.parse(row.content)).toEqual({ transcription: 'downloaded transcript' });
    expect(row.content_text).toBe('downloaded transcript');
  });

  it('uses the default ogg MIME and extension when raw audio has no mimetype', async () => {
    mockDownloadMediaMessage.mockResolvedValue(Buffer.from('downloaded-audio'));
    mockTranscribeAudio.mockClear();
    mockTranscribeAudio.mockResolvedValue('fresh transcript');
    insertAudioMessage('msg-download-ogg', {
      rawMessage: audioRawMessage(),
    });

    const result = await registry.call(
      'transcribe_audio',
      { message_id: 'msg-download-ogg' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.transcription).toBe('fresh transcript');
    expect(mockTranscribeAudio.mock.calls[0][1]).toBe('audio/ogg');
    const row = testDb.raw.prepare('SELECT media_path FROM messages WHERE message_id = ?')
      .get('msg-download-ogg') as { media_path: string | null };
    expect(row.media_path).toMatch(/\.ogg$/);
  });
});

// ---------------------------------------------------------------------------
// download_media — path confinement security
// ---------------------------------------------------------------------------

describe('download_media — path confinement', () => {
  let registry: ToolRegistry;
  let connection: ReturnType<typeof makeConnection>;
  let mediaCalls: Array<{ chatJid: string; media: unknown }>;
  let db: Database;
  let deps: MediaDeps;
  let workspace: string;
  let filesToClean: string[] = [];
  let dirsToClean: string[] = [];

  beforeEach(() => {
    mockDownloadMediaMessage.mockReset();
    mockDownloadMediaMessage.mockResolvedValue(Buffer.from('downloaded-media'));

    db = new Database(':memory:');
    db.open();
    registry = new ToolRegistry();
    mediaCalls = makeCalls();
    connection = makeConnection(mediaCalls);
    deps = { connection, db };
    registerMediaTools(registry, deps);
    workspace = tempDir();
    dirsToClean.push(workspace);
    filesToClean = [];
  });

  afterEach(() => {
    db.close();
    for (const f of filesToClean) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
    for (const d of [...dirsToClean].reverse()) {
      try { rmdirSync(d, { recursive: true } as any); } catch { /* ignore */ }
    }
    dirsToClean = [];
  });

  function insertMessage(
    messageId: string,
    contentType: string,
    opts: { mediaPath?: string; rawMessage?: string } = {},
  ): void {
    db.raw.prepare(`
      INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content_type, is_from_me, timestamp, media_path, raw_message)
      VALUES ('chat@g.us', 'chat_at_g.us', 'sender@s.whatsapp.net', ?, ?, 0, 1700000000, ?, ?)
    `).run(messageId, contentType, opts.mediaPath ?? null, opts.rawMessage ?? null);
  }

  it('does not return a cached media_path that points outside the managed media dir', async () => {
    // Seed a row with a media_path pointing to a sensitive system file.
    // Even though the file "exists", the confinement check must reject it.
    insertMessage('msg-escape', 'image', { mediaPath: '/etc/passwd' });

    const result = await registry.call(
      'download_media',
      { message_id: 'msg-escape' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    // Must NOT return cached: true with /etc/passwd as file_path.
    expect(body.cached).not.toBe(true);
    expect(body.file_path).not.toBe('/etc/passwd');
    // Without raw_message it falls through to a no_raw_message error — not a file path leak.
    expect(body.error).toBe('no_raw_message');
  });

  it('does not return a cached path that escapes mediaDir via path traversal', async () => {
    // A path that normalises to outside mediaDir via traversal segments.
    insertMessage('msg-traversal', 'image', { mediaPath: `${tmpdir()}/whatsoup-media/../../etc/passwd` });

    const result = await registry.call(
      'download_media',
      { message_id: 'msg-traversal' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.cached).not.toBe(true);
    expect(body.file_path).toBeUndefined();
    expect(body.error).toBe('no_raw_message');
  });
});

// ---------------------------------------------------------------------------
// download_media — stale cache + valid raw_message fallback
// ---------------------------------------------------------------------------

describe('download_media — stale cache with raw_message fallback', () => {
  let registry: ToolRegistry;
  let connection: ReturnType<typeof makeConnection>;
  let mediaCalls: Array<{ chatJid: string; media: unknown }>;
  let db: Database;
  let deps: MediaDeps;
  let filesToClean: string[] = [];

  beforeEach(() => {
    mockDownloadMediaMessage.mockReset();
    mockDownloadMediaMessage.mockResolvedValue(Buffer.from('fresh-download'));

    db = new Database(':memory:');
    db.open();
    registry = new ToolRegistry();
    mediaCalls = makeCalls();
    connection = makeConnection(mediaCalls);
    deps = { connection, db };
    registerMediaTools(registry, deps);
    filesToClean = [];
  });

  afterEach(() => {
    db.close();
    for (const f of filesToClean) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
  });

  it('re-downloads and updates media_path when cached file no longer exists on disk', async () => {
    // media_path points inside mediaDir (tmpdir) but the file has been deleted.
    const stalePath = join(tmpdir(), `whatsoup-stale-${randomBytes(4).toString('hex')}.jpg`);
    // Do NOT create the file — it's intentionally absent.

    const rawMessage = JSON.stringify({
      message: {
        imageMessage: {
          url: 'https://mmg.whatsapp.net/fake',
          mimetype: 'image/jpeg',
          mediaKey: Buffer.from('fake-key').toString('base64'),
          fileEncSha256: Buffer.from('fake-hash').toString('base64'),
          fileSha256: Buffer.from('fake-sha').toString('base64'),
          fileLength: 512,
          directPath: '/fake/path',
        },
      },
    });

    db.raw.prepare(`
      INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content_type, is_from_me, timestamp, media_path, raw_message)
      VALUES ('chat@g.us', 'chat_at_g.us', 'sender@s.whatsapp.net', 'msg-stale-fallback', 'image', 0, 1700000000, ?, ?)
    `).run(stalePath, rawMessage);

    const result = await registry.call(
      'download_media',
      { message_id: 'msg-stale-fallback' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    // Should have re-downloaded, not returned stale cached path.
    expect(body.cached).toBe(false);
    expect(body.content_type).toBe('image');
    expect(body.file_size).toBe(Buffer.from('fresh-download').length);
    expect(body.file_path).not.toBe(stalePath);
    expect(existsSync(body.file_path)).toBe(true);
    filesToClean.push(body.file_path);

    // DB row must be updated with the new path.
    const row = db.raw.prepare('SELECT media_path FROM messages WHERE message_id = ?')
      .get('msg-stale-fallback') as { media_path: string | null };
    expect(row.media_path).toBe(body.file_path);
  });
});

// ---------------------------------------------------------------------------
// download_media — MIME / extension handling for documents
// ---------------------------------------------------------------------------

describe('download_media — document MIME and extension handling', () => {
  let registry: ToolRegistry;
  let connection: ReturnType<typeof makeConnection>;
  let mediaCalls: Array<{ chatJid: string; media: unknown }>;
  let db: Database;
  let deps: MediaDeps;
  let filesToClean: string[] = [];

  beforeEach(() => {
    mockDownloadMediaMessage.mockReset();
    mockDownloadMediaMessage.mockResolvedValue(Buffer.from('doc-content'));

    db = new Database(':memory:');
    db.open();
    registry = new ToolRegistry();
    mediaCalls = makeCalls();
    connection = makeConnection(mediaCalls);
    deps = { connection, db };
    registerMediaTools(registry, deps);
    filesToClean = [];
  });

  afterEach(() => {
    db.close();
    for (const f of filesToClean) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
  });

  it('derives file extension from documentMessage.fileName when present', async () => {
    const rawMessage = JSON.stringify({
      message: {
        documentMessage: {
          url: 'https://mmg.whatsapp.net/fake-doc',
          mimetype: 'application/pdf',
          fileName: 'report.pdf',
          mediaKey: Buffer.from('fake-key').toString('base64'),
          fileEncSha256: Buffer.from('fake-hash').toString('base64'),
          fileSha256: Buffer.from('fake-sha').toString('base64'),
          fileLength: 2048,
          directPath: '/fake/doc-path',
        },
      },
    });

    db.raw.prepare(`
      INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content_type, is_from_me, timestamp, raw_message)
      VALUES ('chat@g.us', 'chat_at_g.us', 'sender@s.whatsapp.net', 'msg-doc-pdf', 'document', 0, 1700000000, ?)
    `).run(rawMessage);

    const result = await registry.call(
      'download_media',
      { message_id: 'msg-doc-pdf' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.cached).toBe(false);
    expect(body.content_type).toBe('document');
    // File path should end in .pdf — derived from fileName in documentMessage.
    expect(body.file_path).toMatch(/\.pdf$/);
    expect(existsSync(body.file_path)).toBe(true);
    filesToClean.push(body.file_path);
  });

  it('falls back to .bin extension when documentMessage has no fileName', async () => {
    const rawMessage = JSON.stringify({
      message: {
        documentMessage: {
          url: 'https://mmg.whatsapp.net/fake-bin',
          mimetype: 'application/octet-stream',
          mediaKey: Buffer.from('fake-key').toString('base64'),
          fileEncSha256: Buffer.from('fake-hash').toString('base64'),
          fileSha256: Buffer.from('fake-sha').toString('base64'),
          fileLength: 1024,
          directPath: '/fake/bin-path',
        },
      },
    });

    db.raw.prepare(`
      INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content_type, is_from_me, timestamp, raw_message)
      VALUES ('chat@g.us', 'chat_at_g.us', 'sender@s.whatsapp.net', 'msg-doc-bin', 'document', 0, 1700000000, ?)
    `).run(rawMessage);

    const result = await registry.call(
      'download_media',
      { message_id: 'msg-doc-bin' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.cached).toBe(false);
    expect(body.content_type).toBe('document');
    // No fileName → falls back to default 'bin' extension.
    expect(body.file_path).toMatch(/\.bin$/);
    expect(existsSync(body.file_path)).toBe(true);
    filesToClean.push(body.file_path);
  });

  it('uses mimetype from raw documentMessage when extractRawMime finds one', async () => {
    const rawMessage = JSON.stringify({
      message: {
        documentMessage: {
          url: 'https://mmg.whatsapp.net/fake-xlsx',
          mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          fileName: 'data.xlsx',
          mediaKey: Buffer.from('fake-key').toString('base64'),
          fileEncSha256: Buffer.from('fake-hash').toString('base64'),
          fileSha256: Buffer.from('fake-sha').toString('base64'),
          fileLength: 4096,
          directPath: '/fake/xlsx-path',
        },
      },
    });

    db.raw.prepare(`
      INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content_type, is_from_me, timestamp, raw_message)
      VALUES ('chat@g.us', 'chat_at_g.us', 'sender@s.whatsapp.net', 'msg-doc-xlsx', 'document', 0, 1700000000, ?)
    `).run(rawMessage);

    const result = await registry.call(
      'download_media',
      { message_id: 'msg-doc-xlsx' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.cached).toBe(false);
    expect(body.mime_type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(body.file_path).toMatch(/\.xlsx$/);
    filesToClean.push(body.file_path);
  });
});

// ---------------------------------------------------------------------------
// download_media — download error paths (timeout, expired, null result)
// These require mocking coreDownloadMedia because the real impl never throws.
// ---------------------------------------------------------------------------

describe('download_media — coreDownloadMedia error paths', () => {
  let registry: ToolRegistry;
  let connection: ReturnType<typeof makeConnection>;
  let mediaCalls: Array<{ chatJid: string; media: unknown }>;
  let db: Database;
  let deps: MediaDeps;
  let filesToClean: string[] = [];

  beforeEach(async () => {
    mockDownloadMediaMessage.mockReset();
    // Restore default pass-through using the real fn captured at mock-factory time.
    // (Dynamic import in beforeEach would return the mock module, causing infinite recursion.)
    if (realDownloadMediaHolder.fn) mockCoreDownloadMedia.mockImplementation(realDownloadMediaHolder.fn as typeof import('../../../src/core/media-download.ts').downloadMedia);

    db = new Database(':memory:');
    db.open();
    registry = new ToolRegistry();
    mediaCalls = makeCalls();
    connection = makeConnection(mediaCalls);
    deps = { connection, db };
    registerMediaTools(registry, deps);
    filesToClean = [];
  });

  afterEach(() => {
    db.close();
    for (const f of filesToClean) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
  });

  function insertImageMessage(messageId: string, rawMessage: string): void {
    db.raw.prepare(`
      INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content_type, is_from_me, timestamp, raw_message)
      VALUES ('chat@g.us', 'chat_at_g.us', 'sender@s.whatsapp.net', ?, 'image', 0, 1700000000, ?)
    `).run(messageId, rawMessage);
  }

  const fakeRaw = JSON.stringify({ message: { imageMessage: { url: 'https://mmg.whatsapp.net/fake', mimetype: 'image/jpeg' } } });

  it('returns download_timeout when coreDownloadMedia throws a timeout error', async () => {
    insertImageMessage('msg-timeout', fakeRaw);
    mockCoreDownloadMedia.mockRejectedValueOnce(new Error('Download timed out after 30s'));

    const result = await registry.call(
      'download_media',
      { message_id: 'msg-timeout' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('download_timeout');
  });

  it('returns media_expired when coreDownloadMedia throws a 404 error', async () => {
    insertImageMessage('msg-expired', fakeRaw);
    mockCoreDownloadMedia.mockRejectedValueOnce(new Error('404 media gone'));

    const result = await registry.call(
      'download_media',
      { message_id: 'msg-expired' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('media_expired');
  });

  it('returns download_failed when coreDownloadMedia throws an unknown error', async () => {
    insertImageMessage('msg-err', fakeRaw);
    mockCoreDownloadMedia.mockRejectedValueOnce(new Error('socket hang up'));

    const result = await registry.call(
      'download_media',
      { message_id: 'msg-err' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('download_failed');
    expect(body.message).toMatch(/Media download failed/);
  });

  it('returns download_failed when coreDownloadMedia resolves null (size limit exceeded)', async () => {
    insertImageMessage('msg-null', fakeRaw);
    mockCoreDownloadMedia.mockResolvedValueOnce(null);

    const result = await registry.call(
      'download_media',
      { message_id: 'msg-null' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('download_failed');
    expect(body.message).toMatch(/25MB limit/);
  });

  it('returns unsupported_type for quoted content type not in mimeMap (e.g. reaction)', async () => {
    // A message that quotes a reaction — effectiveContentType = 'reaction', not in mimeMap
    const rawMessage = JSON.stringify({
      message: {
        extendedTextMessage: {
          text: 'reply',
          contextInfo: {
            stanzaId: 'q1',
            quotedMessage: {
              reactionMessage: { text: '👍' },
            },
          },
        },
      },
    });
    db.raw.prepare(`
      INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content_type, is_from_me, timestamp, raw_message)
      VALUES ('chat@g.us', 'chat_at_g.us', 'sender@s.whatsapp.net', 'msg-quoted-react', 'text', 0, 1700000000, ?)
    `).run(rawMessage);

    // quoted=true but the extractQuotedMedia will return null for a reactionMessage (no media)
    const result = await registry.call(
      'download_media',
      { message_id: 'msg-quoted-react', quoted: true },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    // extractQuotedMedia returns null → no_quoted_media
    expect(body.error).toBe('no_quoted_media');
  });

  it('returns download_failed with non-Error thrown by coreDownloadMedia', async () => {
    insertImageMessage('msg-string-err', fakeRaw);
    mockCoreDownloadMedia.mockRejectedValueOnce('unexpected string error');

    const result = await registry.call(
      'download_media',
      { message_id: 'msg-string-err' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('download_failed');
  });
});

// ---------------------------------------------------------------------------
// transcribe_audio — full execution paths (media_path + raw_message download)
// ---------------------------------------------------------------------------

describe('transcribe_audio — execution paths', () => {
  let registry: ToolRegistry;
  let connection: ReturnType<typeof makeConnection>;
  let mediaCalls: Array<{ chatJid: string; media: unknown }>;
  let db: Database;
  let deps: MediaDeps;
  let workspace: string;
  let filesToClean: string[] = [];
  let dirsToClean: string[] = [];

  beforeEach(() => {
    mockTranscribeAudio.mockReset();
    mockDownloadMediaMessage.mockReset();
    mockDownloadMediaMessage.mockResolvedValue(Buffer.from('audio-data'));
    // Restore coreDownloadMedia default pass-through using the real fn captured at mock-factory time.
    if (realDownloadMediaHolder.fn) mockCoreDownloadMedia.mockImplementation(realDownloadMediaHolder.fn as typeof import('../../../src/core/media-download.ts').downloadMedia);

    db = new Database(':memory:');
    db.open();
    registry = new ToolRegistry();
    mediaCalls = makeCalls();
    connection = makeConnection(mediaCalls);
    deps = { connection, db };
    registerMediaTools(registry, deps);
    workspace = tempDir();
    dirsToClean.push(workspace);
    filesToClean = [];
  });

  afterEach(() => {
    db.close();
    for (const f of filesToClean) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
    for (const d of [...dirsToClean].reverse()) {
      try { rmdirSync(d, { recursive: true } as any); } catch { /* ignore */ }
    }
    dirsToClean = [];
  });

  function insertAudioRow(
    messageId: string,
    opts: {
      mediaPath?: string | null;
      rawMessage?: string | null;
      contentText?: string | null;
      content?: string | null;
    } = {},
  ): void {
    db.raw.prepare(`
      INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content_type,
        content, content_text, is_from_me, timestamp, media_path, raw_message)
      VALUES ('chat@g.us', 'chat_at_g.us', 'sender@s.whatsapp.net', ?, 'audio', ?, ?, 0, 1700000000, ?, ?)
    `).run(
      messageId,
      opts.content ?? null,
      opts.contentText ?? null,
      opts.mediaPath ?? null,
      opts.rawMessage ?? null,
    );
  }

  // ── cached transcription paths ─────────────────────────────────────────────

  it('returns cached transcription from content_text (content_text path)', async () => {
    insertAudioRow('msg-ct', { contentText: 'hello world' });

    const result = await registry.call(
      'transcribe_audio',
      { message_id: 'msg-ct' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.transcription).toBe('hello world');
    expect(body.cached).toBe(true);
    // transcribeAudio should NOT be called when using cache
    expect(mockTranscribeAudio).not.toHaveBeenCalled();
  });

  it('skips content_text containing "transcription unavailable" and proceeds', async () => {
    // content_text has "unavailable" marker → skip cache, but no other source → no_audio_data
    insertAudioRow('msg-unavail', { contentText: 'transcription unavailable' });

    const result = await registry.call(
      'transcribe_audio',
      { message_id: 'msg-unavail' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('no_audio_data');
  });

  it('returns cached transcription from structured content JSON (content path)', async () => {
    insertAudioRow('msg-content-json', {
      content: JSON.stringify({ transcription: 'from json content', duration: 7 }),
    });

    const result = await registry.call(
      'transcribe_audio',
      { message_id: 'msg-content-json' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.transcription).toBe('from json content');
    expect(body.cached).toBe(true);
    expect(mockTranscribeAudio).not.toHaveBeenCalled();
  });

  it('skips content JSON with "transcription unavailable" and proceeds', async () => {
    insertAudioRow('msg-json-unavail', {
      content: JSON.stringify({ transcription: 'transcription unavailable' }),
    });

    const result = await registry.call(
      'transcribe_audio',
      { message_id: 'msg-json-unavail' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('no_audio_data');
  });

  // ── media_path branch — different audio extensions ─────────────────────────

  it('reads from media_path (.mp3) and transcribes', async () => {
    const audioFile = join(workspace, 'voice.mp3');
    writeFileSync(audioFile, Buffer.from('fake-mp3-data'));
    filesToClean.push(audioFile);
    insertAudioRow('msg-mp3', { mediaPath: audioFile });
    mockTranscribeAudio.mockResolvedValueOnce('mp3 transcript');

    const result = await registry.call(
      'transcribe_audio',
      { message_id: 'msg-mp3' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.transcription).toBe('mp3 transcript');
    expect(body.cached).toBe(false);
    expect(mockTranscribeAudio).toHaveBeenCalledWith(expect.any(Buffer), 'audio/mpeg');
  });

  it('reads from media_path (.m4a) and uses correct MIME', async () => {
    const audioFile = join(workspace, 'voice.m4a');
    writeFileSync(audioFile, Buffer.from('fake-m4a-data'));
    filesToClean.push(audioFile);
    insertAudioRow('msg-m4a', { mediaPath: audioFile });
    mockTranscribeAudio.mockResolvedValueOnce('m4a transcript');

    const result = await registry.call(
      'transcribe_audio',
      { message_id: 'msg-m4a' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.transcription).toBe('m4a transcript');
    expect(mockTranscribeAudio).toHaveBeenCalledWith(expect.any(Buffer), 'audio/mp4');
  });

  it('reads from media_path (.wav) and uses correct MIME', async () => {
    const audioFile = join(workspace, 'voice.wav');
    writeFileSync(audioFile, Buffer.from('fake-wav-data'));
    filesToClean.push(audioFile);
    insertAudioRow('msg-wav', { mediaPath: audioFile });
    mockTranscribeAudio.mockResolvedValueOnce('wav transcript');

    const result = await registry.call(
      'transcribe_audio',
      { message_id: 'msg-wav' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.transcription).toBe('wav transcript');
    expect(mockTranscribeAudio).toHaveBeenCalledWith(expect.any(Buffer), 'audio/wav');
  });

  it('reads from media_path (.webm) and uses correct MIME', async () => {
    const audioFile = join(workspace, 'voice.webm');
    writeFileSync(audioFile, Buffer.from('fake-webm-data'));
    filesToClean.push(audioFile);
    insertAudioRow('msg-webm', { mediaPath: audioFile });
    mockTranscribeAudio.mockResolvedValueOnce('webm transcript');

    const result = await registry.call(
      'transcribe_audio',
      { message_id: 'msg-webm' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.transcription).toBe('webm transcript');
    expect(mockTranscribeAudio).toHaveBeenCalledWith(expect.any(Buffer), 'audio/webm');
  });

  it('reads from media_path (.ogg) and uses default audio/ogg MIME', async () => {
    const audioFile = join(workspace, 'voice.ogg');
    writeFileSync(audioFile, Buffer.from('fake-ogg-data'));
    filesToClean.push(audioFile);
    insertAudioRow('msg-ogg', { mediaPath: audioFile });
    mockTranscribeAudio.mockResolvedValueOnce('ogg transcript');

    const result = await registry.call(
      'transcribe_audio',
      { message_id: 'msg-ogg' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.transcription).toBe('ogg transcript');
    expect(mockTranscribeAudio).toHaveBeenCalledWith(expect.any(Buffer), 'audio/ogg');
  });

  // ── transcription_failed path ──────────────────────────────────────────────

  it('returns transcription_failed when transcribeAudio returns null', async () => {
    const audioFile = join(workspace, 'voice.ogg');
    writeFileSync(audioFile, Buffer.from('fake-ogg-data'));
    filesToClean.push(audioFile);
    insertAudioRow('msg-fail-null', { mediaPath: audioFile });
    mockTranscribeAudio.mockResolvedValueOnce(null);

    const result = await registry.call(
      'transcribe_audio',
      { message_id: 'msg-fail-null' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('transcription_failed');
  });

  it('returns transcription_failed when transcribeAudio returns "transcription unavailable"', async () => {
    const audioFile = join(workspace, 'voice.ogg');
    writeFileSync(audioFile, Buffer.from('fake-ogg-data'));
    filesToClean.push(audioFile);
    insertAudioRow('msg-fail-unavail', { mediaPath: audioFile });
    mockTranscribeAudio.mockResolvedValueOnce('transcription unavailable');

    const result = await registry.call(
      'transcribe_audio',
      { message_id: 'msg-fail-unavail' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('transcription_failed');
  });

  // ── successful transcription with duration ─────────────────────────────────

  it('returns transcription with duration from structured content', async () => {
    const audioFile = join(workspace, 'voice.ogg');
    writeFileSync(audioFile, Buffer.from('audio'));
    filesToClean.push(audioFile);
    insertAudioRow('msg-with-dur', {
      mediaPath: audioFile,
      content: JSON.stringify({ duration: 42 }),
    });
    mockTranscribeAudio.mockResolvedValueOnce('great transcript');

    const result = await registry.call(
      'transcribe_audio',
      { message_id: 'msg-with-dur' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.transcription).toBe('great transcript');
    expect(body.duration).toBe(42);
    expect(body.cached).toBe(false);
  });

  it('returns null duration when content has no duration field', async () => {
    const audioFile = join(workspace, 'voice.ogg');
    writeFileSync(audioFile, Buffer.from('audio'));
    filesToClean.push(audioFile);
    insertAudioRow('msg-no-dur', { mediaPath: audioFile });
    mockTranscribeAudio.mockResolvedValueOnce('no duration transcript');

    const result = await registry.call(
      'transcribe_audio',
      { message_id: 'msg-no-dur' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.transcription).toBe('no duration transcript');
    expect(body.duration).toStrictEqual(null);
  });

  // ── raw_message download fallback ──────────────────────────────────────────

  it('downloads audio from raw_message when media_path is absent', async () => {
    const rawMessage = JSON.stringify({
      message: {
        audioMessage: {
          url: 'https://mmg.whatsapp.net/audio',
          mimetype: 'audio/ogg; codecs=opus',
          mediaKey: Buffer.from('fake-key').toString('base64'),
          fileEncSha256: Buffer.from('fake-hash').toString('base64'),
          fileSha256: Buffer.from('fake-sha').toString('base64'),
          fileLength: 1024,
        },
      },
    });
    insertAudioRow('msg-raw-dl', { rawMessage });
    mockTranscribeAudio.mockResolvedValueOnce('raw download transcript');

    const result = await registry.call(
      'transcribe_audio',
      { message_id: 'msg-raw-dl' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.transcription).toBe('raw download transcript');
    expect(body.cached).toBe(false);
    // DB should be updated with the new media_path
    const row = db.raw.prepare('SELECT media_path FROM messages WHERE message_id = ?')
      .get('msg-raw-dl') as { media_path: string | null };
    expect(row.media_path).toBeTruthy();
    if (row.media_path) filesToClean.push(row.media_path);
  });

  it('returns no_audio_data when raw_message is invalid JSON', async () => {
    insertAudioRow('msg-bad-json', { rawMessage: 'not valid json {{' });

    const result = await registry.call(
      'transcribe_audio',
      { message_id: 'msg-bad-json' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('no_audio_data');
    expect(body.message).toMatch(/Cannot parse raw message/);
  });

  it('returns media_expired when coreDownloadMedia throws a 404-style error during transcription', async () => {
    const rawMessage = JSON.stringify({
      message: { audioMessage: { url: 'https://mmg.whatsapp.net/audio', mimetype: 'audio/ogg' } },
    });
    insertAudioRow('msg-expired-audio', { rawMessage });
    // coreDownloadMedia must throw directly — its real impl swallows errors and returns null.
    mockCoreDownloadMedia.mockRejectedValueOnce(new Error('410 media gone expired'));

    const result = await registry.call(
      'transcribe_audio',
      { message_id: 'msg-expired-audio' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('media_expired');
  });

  it('returns download_failed when coreDownloadMedia throws a generic error during transcription', async () => {
    const rawMessage = JSON.stringify({
      message: { audioMessage: { url: 'https://mmg.whatsapp.net/audio', mimetype: 'audio/ogg' } },
    });
    insertAudioRow('msg-dl-fail', { rawMessage });
    // coreDownloadMedia must throw directly — its real impl swallows errors and returns null.
    mockCoreDownloadMedia.mockRejectedValueOnce(new Error('network error'));

    const result = await registry.call(
      'transcribe_audio',
      { message_id: 'msg-dl-fail' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('download_failed');
  });
});
