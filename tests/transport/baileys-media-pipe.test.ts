// #3315 (transport-escape half) — the pinned Baileys media download pipes an
// undici fetch stream with `.pipe()`, which forwards no 'error' events: a
// socket death mid-body destroyed the body stream with
// TypeError('terminated', cause: SocketError), the error fired on a
// zero-listener EventEmitter (process-level uncaughtException — the exact
// incident signature of release bc673), and the same event left the awaiting
// media handler pending forever. Repo code cannot reach the internal stream,
// so the fix is a patch-package overlay on the pin
// (patches/@whiskeysockets+baileys+7.0.0-rc12.patch) forwarding source errors
// into the returned Transform.
//
// This test drives the REAL vendored downloadEncryptedContent at a local HTTP
// server that starts a body and then destroys the socket mid-stream:
//   - the awaited consumption must REJECT (no forever-pending handler), and
//   - no uncaughtException may escape (the trap must never fire).
// Against the unpatched module both assertions fail — run
// `git apply -R patches/...` in node_modules (or reinstall without
// postinstall) to see the red fingerprint; `npm run postinstall` restores it.

import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';

import { downloadEncryptedContent } from '../../node_modules/@whiskeysockets/baileys/lib/Utils/messages-media.js';

/**
 * Structured timing exemption (test-integrity `js-sleep-in-test`): the second
 * property is an ABSENCE proof — a zero-listener 'error' emission escapes
 * asynchronously after the consumer already rejected, so the only observable
 * to poll is the very escape whose absence is asserted. Real time must pass
 * the would-be emission; fake timers cannot advance undici's socket teardown.
 */
function TIMING(waitMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, waitMs));
}

async function startAbortingServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => {
    // Start a plausible body, then kill the socket mid-stream: undici
    // destroys the fetch body with TypeError('terminated', cause SocketError).
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '65536' });
    res.write(randomBytes(4096));
    setTimeout(() => {
      res.socket?.destroy();
    }, 30);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address !== 'object') throw new Error('no server address');
  return { server, url: `http://127.0.0.1:${address.port}/blob.enc` };
}

describe('baileys media pipe overlay (#3315)', () => {
  it('a socket death mid-download rejects the awaited consumer and never escapes as an uncaughtException', async () => {
    const { server, url } = await startAbortingServer();
    const escaped: unknown[] = [];
    const trap = (err: unknown): void => {
      escaped.push(err);
    };
    process.on('uncaughtException', trap);
    try {
      const stream = await downloadEncryptedContent(
        url,
        // Any 32/16-byte key material works: the failure under test happens at
        // the transport layer, well before AES final() could reject it.
        { cipherKey: randomBytes(32), iv: randomBytes(16) },
        {},
      );
      const consume = (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(chunk as Buffer);
        return Buffer.concat(chunks);
      })();

      await expect(consume).rejects.toThrow();
      // Bounded absence window for the asynchronous escape (see TIMING above).
      await TIMING(150);
      expect(escaped).toEqual([]);
    } finally {
      process.removeListener('uncaughtException', trap);
      server.close();
    }
  }, 15_000);
});
