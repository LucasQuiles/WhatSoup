import type { Readable } from 'node:stream';
import { createReadStream } from 'node:fs';
import type { Logger } from 'pino';

export function isBaileysEncryptedTmpEnoent(err: unknown): err is NodeJS.ErrnoException {
  if (!(err instanceof Error)) return false;
  const nodeErr = err as NodeJS.ErrnoException;
  return nodeErr.code === 'ENOENT' &&
    typeof nodeErr.path === 'string' &&
    /(?:^|[/\\])(?:document|image|audio|video|sticker)[^/\\]*-enc$/.test(nodeErr.path);
}

/**
 * Create a fs.ReadStream with a synchronous 'error' listener pre-attached.
 *
 * Without this, if the underlying file is unlinked between stream creation
 * and the moment undici's body-consumer attaches its own 'error' listener,
 * Node's EventEmitter throws the 'error' event as an uncaughtException.
 * That matches the production crash observed 2026-05-18 17:12:22 EDT:
 *   ENOENT on /tmp/user/1000/document<hex>-enc → global handler → shutdown.
 *
 * This function attaches the listener synchronously (before the call returns)
 * so the window is zero. The error is still re-emitted to allow retry logic
 * at the caller to observe it via their own 'error' listener.
 */
export function createMediaReadStream(path: string, log: Logger): Readable {
  const stream = createReadStream(path);
  stream.on('error', (err) => {
    log.error({ err, path }, 'media stream open error intercepted (would have raised uncaughtException); propagating to retry listener');
  });
  return stream;
}
