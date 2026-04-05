// tests/mcp/tools/media.test.ts

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, mkdirSync, symlinkSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import { registerMediaTools, type MediaDeps } from '../../../src/mcp/tools/media.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';
import { Database } from '../../../src/core/database.ts';

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
    deps = { connection, db: testDb.raw };
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
    db = new Database(':memory:');
    db.open();
    registry = new ToolRegistry();
    mediaCalls = makeCalls();
    connection = makeConnection(mediaCalls);
    deps = { connection, db: db.raw };
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
      rawMessage: null,
    });

    const result = await registry.call(
      'download_media',
      { message_id: 'msg-stale' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('no_raw_message');
  });
});
