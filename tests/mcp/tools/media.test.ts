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

const { mockDownloadMediaMessage } = vi.hoisted(() => ({
  mockDownloadMediaMessage: vi.fn(),
}));

vi.mock('@whiskeysockets/baileys', () => ({
  downloadMediaMessage: mockDownloadMediaMessage,
}));

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

  it('allows any path for global session without allowedRoot', async () => {
    // Write to a location outside of any workspace
    const outsidePath = join(tmpdir(), `global-test-${randomBytes(4).toString('hex')}.jpg`);
    writeFileSync(outsidePath, 'data');
    filesToClean.push(outsidePath);

    // Global session has no allowedRoot
    const result = await registry.call(
      'send_media',
      { filePath: outsidePath, chatJid: '1234567890@s.whatsapp.net' },
      globalSession(),
    );

    expect(result.isError).toBeUndefined();
    expect(mediaCalls).toHaveLength(1);
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

    const row = db.raw.prepare('SELECT media_path FROM messages WHERE message_id = ?')
      .get('msg-quoted') as { media_path: string | null };
    expect(row.media_path).toBeNull();
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
    opts: { mediaPath?: string; content?: string } = {},
  ): void {
    testDb.raw.prepare(`
      INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content_type,
        content, is_from_me, timestamp, media_path)
      VALUES ('chat@g.us', 'chat_at_g.us', 'sender@s.whatsapp.net', ?, 'audio', ?, 0, 1700000000, ?)
    `).run(
      messageId,
      opts.content ?? JSON.stringify({ type: 'audio', duration: 10, ptt: true, transcription: null }),
      opts.mediaPath ?? null,
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
