// tests/runtimes/agent/media-bridge.test.ts
// Tests for src/runtimes/agent/media-bridge.ts
// Uses real Unix sockets and real temp files — no mocks for infrastructure.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createConnection, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Messenger, OutboundMedia, SubmissionReceipt } from '../../../src/core/types.ts';
import { startMediaBridge, setMediaBridgeChat, type MediaBridge } from '../../../src/runtimes/agent/media-bridge.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSocketPath(): string {
  return join(tmpdir(), `mb-test-${randomBytes(6).toString('hex')}.sock`);
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mb-root-'));
}

function makeMessenger(
  onSendMedia?: (chatJid: string, media: OutboundMedia) => Promise<void>,
): Messenger {
  return {
    sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
    sendMedia: vi.fn(async (chatJid: string, media: OutboundMedia) => {
      if (onSendMedia) await onSendMedia(chatJid, media);
      return { waMessageId: 'mock-id' } as SubmissionReceipt;
    }),
  } as unknown as Messenger;
}

function destroyCapturedMediaStreams(messenger: Messenger): void {
  for (const [, media] of vi.mocked(messenger.sendMedia).mock.calls) {
    const stream = (media as OutboundMedia & { stream?: { destroy?: () => void; on?: (event: 'error', listener: () => void) => void } }).stream;
    stream?.on?.('error', () => {});
    stream?.destroy?.();
  }
}

/**
 * Send a newline-terminated JSON request to the bridge and collect one
 * newline-terminated JSON response.
 */
function sendRequest(
  socketPath: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return sendRawRequest(socketPath, JSON.stringify(payload) + '\n');
}

function sendRawRequest(
  socketPath: string,
  payload: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath, () => {
      client.write(payload);
    });

    let buf = '';
    client.on('data', (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        client.destroy();
        try {
          resolve(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>);
        } catch (e) {
          reject(e);
        }
      }
    });

    client.on('error', reject);

    setTimeout(() => {
      client.destroy();
      reject(new Error('sendRequest timeout'));
    }, 3000);
  });
}

/** Wait for the bridge server to be listening. */
function waitListening(bridge: MediaBridge): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = bridge._server;
    if (server.listening) {
      resolve();
      return;
    }
    server.once('listening', resolve);
    server.once('error', reject);
    setTimeout(() => reject(new Error('bridge listen timeout')), 3000);
  });
}

function waitForClientConnect(client: Socket, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('client connect timeout')), timeoutMs);
    client.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    client.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitForClientClose(client: Socket, timeoutMs = 500): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('client close timeout')), timeoutMs);
    client.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    client.once('error', () => {
      // Remote destroy may reset the connection before close; close is the
      // lifecycle signal we care about, so ignore socket errors here.
    });
  });
}

class SyntheticSocket extends EventEmitter {
  destroy = vi.fn();
  write = vi.fn();
  // Mirror net.Socket.setEncoding (returns this) — the bridge sets utf8 on accept (QR-053).
  setEncoding = vi.fn(() => this);
}

// ─── Test state ───────────────────────────────────────────────────────────────

let socketPath: string;
let allowedRoot: string;
let bridge: MediaBridge;
let messenger: Messenger;

beforeEach(async () => {
  socketPath = makeSocketPath();
  allowedRoot = makeTempDir();
  messenger = makeMessenger();
  bridge = startMediaBridge(socketPath, messenger, allowedRoot);
  await waitListening(bridge);
});

afterEach(() => {
  destroyCapturedMediaStreams(messenger);
  bridge();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('startMediaBridge', () => {
  it('creates a Unix socket server that accepts connections', async () => {
    expect(bridge._server.listening).toBe(true);
  });

  it('returns a callable handle with _server and _currentChatJid properties', () => {
    expect({
      handleType: typeof bridge,
      serverListening: bridge._server.listening,
      currentChatJid: bridge._currentChatJid,
    }).toStrictEqual({
      handleType: 'function',
      serverListening: true,
      currentChatJid: null,
    });
  });

  it('handles server error events without throwing', () => {
    expect(() => {
      bridge._server.emit('error', new Error('synthetic server error'));
    }).not.toThrow();
  });
});

describe('setMediaBridgeChat', () => {
  it('updates _currentChatJid on the bridge', () => {
    setMediaBridgeChat(bridge, 'group1@g.us');
    expect(bridge._currentChatJid).toBe('group1@g.us');
  });

  it('can be overwritten with a different chat JID', () => {
    setMediaBridgeChat(bridge, 'first@g.us');
    setMediaBridgeChat(bridge, 'second@g.us');
    expect(bridge._currentChatJid).toBe('second@g.us');
  });
});

describe('bridge request handling', () => {
  it('sends media and returns ok:true for a valid PNG in the allowed root', async () => {
    const imgPath = join(allowedRoot, 'photo.png');
    writeFileSync(imgPath, Buffer.from([137, 80, 78, 71])); // PNG magic bytes

    setMediaBridgeChat(bridge, '15551234567@s.whatsapp.net');
    const res = await sendRequest(socketPath, { path: imgPath });

    expect(res.ok).toBe(true);
    expect(messenger.sendMedia).toHaveBeenCalledWith(
      '15551234567@s.whatsapp.net',
      expect.objectContaining({ type: 'image', mimetype: 'image/png' }),
    );
    const media = vi.mocked(messenger.sendMedia).mock.calls[0]?.[1] as OutboundMedia & { stream?: NodeJS.ReadableStream };
    expect(media.stream).toBeDefined();
    expect('buffer' in media).toBe(false);
    media.stream?.destroy?.();
  });

  it('retries Baileys encrypted tmp ENOENT with a fresh stream', async () => {
    const imgPath = join(allowedRoot, 'photo.png');
    writeFileSync(imgPath, Buffer.from([137, 80, 78, 71]));
    const tmpErr = Object.assign(
      new Error('ENOENT: no such file or directory, open /tmp/image123-enc'),
      { code: 'ENOENT', path: '/tmp/image123-enc' },
    );
    let attempts = 0;
    messenger = makeMessenger(async () => {
      attempts += 1;
      if (attempts === 1) throw tmpErr;
    });
    bridge();
    bridge = startMediaBridge(socketPath, messenger, allowedRoot);
    await waitListening(bridge);

    setMediaBridgeChat(bridge, '15551234567@s.whatsapp.net');
    const res = await sendRequest(socketPath, { path: imgPath });

    expect(res.ok).toBe(true);
    expect(messenger.sendMedia).toHaveBeenCalledTimes(2);
    const first = vi.mocked(messenger.sendMedia).mock.calls[0]?.[1] as OutboundMedia & { stream?: NodeJS.ReadableStream };
    const second = vi.mocked(messenger.sendMedia).mock.calls[1]?.[1] as OutboundMedia & { stream?: NodeJS.ReadableStream };
    expect(first.stream).toBeDefined();
    expect(second.stream).toBeDefined();
    expect(first.stream).not.toBe(second.stream);
  });

  it('infers document type for .pdf extension', async () => {
    const pdfPath = join(allowedRoot, 'report.pdf');
    writeFileSync(pdfPath, Buffer.from('%PDF-1.4'));

    setMediaBridgeChat(bridge, 'chat@g.us');
    const res = await sendRequest(socketPath, { path: pdfPath });

    expect(res.ok).toBe(true);
    expect(messenger.sendMedia).toHaveBeenCalledWith(
      'chat@g.us',
      expect.objectContaining({ type: 'document', mimetype: 'application/pdf' }),
    );
  });

  it('infers audio and video media types from extensions', async () => {
    const audioPath = join(allowedRoot, 'voice.mp3');
    const videoPath = join(allowedRoot, 'clip.mp4');
    writeFileSync(audioPath, Buffer.alloc(4));
    writeFileSync(videoPath, Buffer.alloc(4));

    setMediaBridgeChat(bridge, 'chat@g.us');
    const audioRes = await sendRequest(socketPath, { path: audioPath });
    const videoRes = await sendRequest(socketPath, { path: videoPath, caption: 'clip caption' });

    expect(audioRes.ok).toBe(true);
    expect(videoRes.ok).toBe(true);
    expect(messenger.sendMedia).toHaveBeenNthCalledWith(
      1,
      'chat@g.us',
      expect.objectContaining({ type: 'audio', mimetype: 'audio/mpeg' }),
    );
    expect(messenger.sendMedia).toHaveBeenNthCalledWith(
      2,
      'chat@g.us',
      expect.objectContaining({ type: 'video', mimetype: 'video/mp4', caption: 'clip caption' }),
    );
  });

  it('falls back to document/octet-stream for unknown extensions', async () => {
    const filePath = join(allowedRoot, 'artifact.custombin');
    writeFileSync(filePath, Buffer.alloc(4));

    setMediaBridgeChat(bridge, 'chat@g.us');
    const res = await sendRequest(socketPath, { path: filePath, caption: 123, filename: 456 });

    expect(res.ok).toBe(true);
    expect(messenger.sendMedia).toHaveBeenCalledWith(
      'chat@g.us',
      expect.objectContaining({
        type: 'document',
        filename: 'artifact.custombin',
        mimetype: 'application/octet-stream',
        caption: undefined,
      }),
    );
  });

  it('ignores request chatJid and uses the current bridge chat', async () => {
    const filePath = join(allowedRoot, 'doc.txt');
    writeFileSync(filePath, 'hello');

    setMediaBridgeChat(bridge, 'default@g.us');
    const res = await sendRequest(socketPath, {
      path: filePath,
      chatJid: 'explicit@g.us',
    });

    expect(res.ok).toBe(true);
    expect(messenger.sendMedia).toHaveBeenCalledWith(
      'default@g.us',
      expect.anything(),
    );
  });

  it('passes caption to messenger for image types', async () => {
    const imgPath = join(allowedRoot, 'photo.jpg');
    writeFileSync(imgPath, Buffer.alloc(4));

    setMediaBridgeChat(bridge, 'chat@g.us');
    await sendRequest(socketPath, { path: imgPath, caption: 'look at this!' });

    expect(messenger.sendMedia).toHaveBeenCalledWith(
      'chat@g.us',
      expect.objectContaining({ caption: 'look at this!' }),
    );
  });

  it('uses custom filename when provided for document types', async () => {
    const docPath = join(allowedRoot, 'report.xlsx');
    writeFileSync(docPath, Buffer.alloc(4));

    setMediaBridgeChat(bridge, 'chat@g.us');
    await sendRequest(socketPath, { path: docPath, filename: 'Q1-Report.xlsx' });

    expect(messenger.sendMedia).toHaveBeenCalledWith(
      'chat@g.us',
      expect.objectContaining({ filename: 'Q1-Report.xlsx' }),
    );
  });
});

describe('bridge validation', () => {
  it('rejects request with missing path', async () => {
    setMediaBridgeChat(bridge, 'chat@g.us');
    const res = await sendRequest(socketPath, { chatJid: 'chat@g.us' });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/missing path/);
  });

  it('rejects request with path outside allowedRoot', async () => {
    setMediaBridgeChat(bridge, 'chat@g.us');
    const res = await sendRequest(socketPath, { path: '/etc/passwd' });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/path not allowed/);
  });

  it('rejects path traversal that escapes allowedRoot', async () => {
    setMediaBridgeChat(bridge, 'chat@g.us');
    const escapedPath = join(allowedRoot, '..', 'escape.txt');
    const res = await sendRequest(socketPath, { path: escapedPath });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/path not allowed/);
  });

  it('accepts a canonical (symlink-resolved) path that maps under allowedRoot (macOS /private/var regression)', async () => {
    // On macOS, os.tmpdir() returns /var/folders/... but realpathSync() resolves
    // to /private/var/folders/... Callers that canonicalize paths upstream
    // (e.g. a child Claude Code subprocess) would pass the /private/var form
    // and get rejected by a root path check that never canonicalizes. Regression
    // guard: ensure the bridge's path-boundary check accepts the canonical form.
    setMediaBridgeChat(bridge, 'chat@g.us');
    const filename = 'canonical-regression.png';
    const underRoot = join(allowedRoot, filename);
    // Create the file so the write/read side succeeds if the guard lets us through.
    writeFileSync(underRoot, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    // Use realpathSync to get the canonical form the way an upstream caller would.
    const canonicalPath = realpathSync(underRoot);

    const res = await sendRequest(socketPath, { path: canonicalPath });

    // The request may fail downstream (no Messenger configured etc.), but it
    // must NOT fail with "path not allowed".
    if (!res.ok) {
      expect(String(res.error)).not.toMatch(/path not allowed/);
    }
  });


  it('returns ok:false when file does not exist', async () => {
    setMediaBridgeChat(bridge, 'chat@g.us');
    const missingPath = join(allowedRoot, 'nonexistent.png');
    const res = await sendRequest(socketPath, { path: missingPath });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/file not found/);
  });

  it('falls back to resolved path when neither file nor parent canonicalize', async () => {
    setMediaBridgeChat(bridge, 'chat@g.us');
    const missingPath = join(realpathSync(allowedRoot), 'missing-parent', 'nonexistent.png');

    const res = await sendRequest(socketPath, { path: missingPath });

    expect(res.ok).toBe(false);
    expect(res.error).toBe(`file not found: ${resolve(missingPath)}`);
  });

  it('returns failed read when stat throws a non-ENOENT error', async () => {
    setMediaBridgeChat(bridge, 'chat@g.us');
    const invalidPath = join(allowedRoot, 'bad\0name.png');

    const res = await sendRequest(socketPath, { path: invalidPath });

    expect(res).toEqual({ ok: false, error: 'failed to read file' });
  });

  it('returns ok:false when no current chat is set', async () => {
    // bridge._currentChatJid is null; request-level chatJid is intentionally ignored.
    const filePath = join(allowedRoot, 'test.png');
    writeFileSync(filePath, Buffer.alloc(4));

    const res = await sendRequest(socketPath, { path: filePath, chatJid: 'explicit@g.us' });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/current chat/);
  });

  it('returns error for invalid JSON', async () => {
    const response = await sendRawRequest(socketPath, 'not-json\n');

    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/invalid JSON/);
  });

  it('skips empty request lines before handling a valid request', async () => {
    const filePath = join(allowedRoot, 'empty-line.png');
    writeFileSync(filePath, Buffer.from([137, 80, 78, 71]));

    setMediaBridgeChat(bridge, 'chat@g.us');
    const response = await sendRawRequest(socketPath, `\n  \n${JSON.stringify({ path: filePath })}\n`);

    expect(response.ok).toBe(true);
    expect(messenger.sendMedia).toHaveBeenCalledTimes(1);
  });

  it('closes the client socket when request buffering exceeds the limit', async () => {
    const client = createConnection(socketPath);
    await waitForClientConnect(client);

    client.write('x'.repeat(1_024 * 1_024 + 1));

    try {
      await waitForClientClose(client);
    } finally {
      client.destroy();
    }

    expect(messenger.sendMedia).not.toHaveBeenCalled();
  });

  it('handles socket error events and write failures on accepted sockets', async () => {
    const filePath = join(allowedRoot, 'synthetic.png');
    writeFileSync(filePath, Buffer.from([137, 80, 78, 71]));
    const syntheticSocket = new SyntheticSocket();
    syntheticSocket.write.mockImplementation(() => {
      throw new Error('write failed');
    });

    bridge._server.emit('connection', syntheticSocket as unknown as Socket);
    syntheticSocket.emit('error', new Error('synthetic socket error'));

    setMediaBridgeChat(bridge, 'chat@g.us');
    syntheticSocket.emit('data', Buffer.from(`${JSON.stringify({ path: filePath })}\n`));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(messenger.sendMedia).toHaveBeenCalledTimes(1);
    expect(syntheticSocket.write).toHaveBeenCalled();
  });
});

describe('handler rejection safety', () => {
  it('returns a retryable error when sendMedia fails after opening a stream', async () => {
    const imgPath = join(allowedRoot, 'send-fails.png');
    writeFileSync(imgPath, Buffer.from([137, 80, 78, 71]));
    messenger = makeMessenger(async () => {
      throw new Error('transport down');
    });
    bridge();
    bridge = startMediaBridge(socketPath, messenger, allowedRoot);
    await waitListening(bridge);

    setMediaBridgeChat(bridge, 'chat@g.us');
    const res = await sendRequest(socketPath, { path: imgPath });

    expect(res).toEqual({ ok: false, error: 'failed to send media — try again' });
    expect(messenger.sendMedia).toHaveBeenCalledTimes(1);
  });

  it('responds ok:false instead of leaving the client hanging when the handler rejects', async () => {
    const imgPath = join(allowedRoot, 'photo.png');
    writeFileSync(imgPath, Buffer.from([137, 80, 78, 71]));

    // An error whose property access throws poisons the catch block inside
    // handleRequest (isBaileysEncryptedTmpEnoent reads err.code), so the
    // returned promise REJECTS instead of resolving to a BridgeResponse.
    // Without a rejection guard on the socket data path that is an
    // unhandledRejection (fatal at the process level) and the agent-side
    // client never receives a response line.
    class PoisonedError extends Error {
      get code(): never {
        throw new Error('poisoned property access');
      }
    }
    messenger = makeMessenger(async () => {
      throw new PoisonedError('send blew up');
    });
    bridge();
    bridge = startMediaBridge(socketPath, messenger, allowedRoot);
    await waitListening(bridge);

    setMediaBridgeChat(bridge, '15551234567@s.whatsapp.net');
    const res = await sendRequest(socketPath, { path: imgPath });

    expect(res).toEqual({ ok: false, error: 'internal error' });
  });
});

describe('cleanup', () => {
  it('calling the bridge handle stops the server', async () => {
    // A fresh bridge so we can close it independently from the one in afterEach
    const extraSocketPath = makeSocketPath();
    const extraBridge = startMediaBridge(extraSocketPath, makeMessenger(), allowedRoot);
    await waitListening(extraBridge);

    expect(extraBridge._server.listening).toBe(true);

    // Invoke cleanup — wraps server.close()
    extraBridge();

    // Wait for the server's 'close' event to confirm it stopped
    await new Promise<void>((resolve) => {
      if (!extraBridge._server.listening) {
        resolve();
        return;
      }
      extraBridge._server.once('close', resolve);
    });

    expect(extraBridge._server.listening).toBe(false);
  });

  it('calling the bridge handle destroys active client sockets', async () => {
    const extraSocketPath = makeSocketPath();
    const extraBridge = startMediaBridge(extraSocketPath, makeMessenger(), allowedRoot);
    await waitListening(extraBridge);

    const client = createConnection(extraSocketPath);
    await waitForClientConnect(client);

    extraBridge();

    try {
      await waitForClientClose(client);
    } finally {
      client.destroy();
    }

    await new Promise<void>((resolve) => {
      if (!extraBridge._server.listening) {
        resolve();
        return;
      }
      extraBridge._server.once('close', resolve);
    });

    expect(extraBridge._server.listening).toBe(false);
  });
});
