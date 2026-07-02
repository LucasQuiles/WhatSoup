import type { Readable } from 'node:stream';
import { createReadStream, fstatSync, realpathSync, statSync } from 'node:fs';
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
 *
 * QR-090 (fd-pin TOCTOU guard): callers realpath-validate `path` within
 * `allowedRoot`, but this re-opens the path BY NAME (symlink-following). A
 * confined agent could swap `path` for a symlink to an out-of-root secret in the
 * window between the caller's check and this open, exfiltrating it to the chat.
 * Once the stream's fd is open, verify the ACTUALLY-OPENED inode against the
 * canonical path and confirm the canonical path is within `allowedRoot`; on any
 * mismatch, destroy the stream fail-closed. The `open` event fires before any
 * `data`, so no bytes leak. Lazy open is preserved — a file deleted between check
 * and open still surfaces ENOENT via the `error` listener (open never fires), so
 * the delete-race error timing is unchanged.
 */
export function createMediaReadStream(path: string, allowedRoot: string, log: Logger): Readable {
  const stream = createReadStream(path);
  stream.on('open', (fd: number) => {
    try {
      const opened = fstatSync(fd);
      const canonical = realpathSync(path);
      const canonicalStat = statSync(canonical);
      let root: string;
      try {
        root = realpathSync(allowedRoot);
      } catch {
        root = allowedRoot;
      }
      const withinRoot = !!root && (canonical === root || canonical.startsWith(root + '/'));
      if (!withinRoot || canonicalStat.dev !== opened.dev || canonicalStat.ino !== opened.ino) {
        log.error(
          { path, canonical, allowedRoot: root },
          'media stream fd-pin validation failed — path escaped allowedRoot or was swapped after check (QR-090); destroying stream',
        );
        stream.destroy(new Error('media path failed fd-pin validation'));
      }
    } catch (err) {
      log.error({ err, path }, 'media stream fd-pin validation error (QR-090); destroying stream');
      stream.destroy(err instanceof Error ? err : new Error('media path validation error'));
    }
  });
  stream.on('error', (err) => {
    log.error({ err, path }, 'media stream open error intercepted (would have raised uncaughtException); propagating to retry listener');
  });
  return stream;
}
