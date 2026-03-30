// tests/mcp/tools/media.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, mkdirSync, symlinkSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import { registerMediaTools, type MediaDeps } from '../../../src/mcp/tools/media.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';

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

describe('registerMediaTools', () => {
  let registry: ToolRegistry;
  let mediaCalls: Array<{ chatJid: string; media: unknown }>;
  let connection: ReturnType<typeof makeConnection>;
  let deps: MediaDeps;
  let workspace: string;
  let filesToClean: string[] = [];
  let dirsToClean: string[] = [];

  beforeEach(() => {
    registry = new ToolRegistry();
    mediaCalls = makeCalls();
    connection = makeConnection(mediaCalls);
    deps = { connection };
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

  it('infers MIME type from .webp extension', async () => {
    const filePath = writeFile('sticker.webp');
    const session = chatSession('1234567890', '1234567890@s.whatsapp.net', workspace);

    await registry.call('send_media', { filePath }, session);

    const media = mediaCalls[0].media as any;
    expect(media.mimetype).toBe('image/webp');
  });

  it('infers MIME type from .ogg extension', async () => {
    const filePath = writeFile('voice.ogg');
    const session = chatSession('1234567890', '1234567890@s.whatsapp.net', workspace);

    await registry.call('send_media', { filePath }, session);

    const media = mediaCalls[0].media as any;
    expect(media.mimetype).toContain('audio/ogg');
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
