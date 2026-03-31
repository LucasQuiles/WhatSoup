// tests/runtimes/agent/media-bridge.test.ts
// Tests for src/runtimes/agent/media-bridge.ts
// Uses real Unix sockets and real temp files — no mocks for infrastructure.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createConnection } from 'node:net';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
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

/**
 * Send a newline-terminated JSON request to the bridge and collect one
 * newline-terminated JSON response.
 */
function sendRequest(
  socketPath: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath, () => {
      client.write(JSON.stringify(payload) + '\n');
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
  bridge();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('startMediaBridge', () => {
  it('creates a Unix socket server that accepts connections', async () => {
    expect(bridge._server.listening).toBe(true);
  });

  it('returns a callable handle with _server and _currentChatJid properties', () => {
    expect(typeof bridge).toBe('function');
    expect(bridge._server).toBeDefined();
    expect(bridge._currentChatJid).toBeNull();
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

  it('accepts chatJid in the request, overriding the current bridge chat', async () => {
    const filePath = join(allowedRoot, 'doc.txt');
    writeFileSync(filePath, 'hello');

    setMediaBridgeChat(bridge, 'default@g.us');
    const res = await sendRequest(socketPath, {
      path: filePath,
      chatJid: 'explicit@g.us',
    });

    expect(res.ok).toBe(true);
    expect(messenger.sendMedia).toHaveBeenCalledWith(
      'explicit@g.us',
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

  it('returns ok:false when file does not exist', async () => {
    setMediaBridgeChat(bridge, 'chat@g.us');
    const missingPath = join(allowedRoot, 'nonexistent.png');
    const res = await sendRequest(socketPath, { path: missingPath });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/file not found/);
  });

  it('returns ok:false when no chatJid and no current chat set', async () => {
    // bridge._currentChatJid is null and request has no chatJid
    const filePath = join(allowedRoot, 'test.png');
    writeFileSync(filePath, Buffer.alloc(4));

    const res = await sendRequest(socketPath, { path: filePath });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/chatJid/);
  });

  it('returns error for invalid JSON', async () => {
    // sendRequest won't work for raw invalid JSON — send it manually
    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const client = createConnection(socketPath, () => {
        client.write('not-json\n');
      });
      let buf = '';
      client.on('data', (chunk) => {
        buf += chunk.toString();
        const nl = buf.indexOf('\n');
        if (nl !== -1) {
          client.destroy();
          try { resolve(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>); }
          catch (e) { reject(e); }
        }
      });
      client.on('error', reject);
      setTimeout(() => { client.destroy(); reject(new Error('timeout')); }, 3000);
    });

    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/invalid JSON/);
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
});
