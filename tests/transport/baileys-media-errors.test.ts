// tests/transport/baileys-media-errors.test.ts
//
// Branch coverage for src/transport/baileys-media-errors.ts.
//
// Two exports under test:
//   1. isBaileysEncryptedTmpEnoent — type guard with four guard branches
//      (not-Error, code !== 'ENOENT', path not a string, regex no-match).
//   2. createMediaReadStream — attaches a synchronous 'error' listener on
//      a fs.ReadStream so the 'error' event is observed by our logger
//      callback before any undici body-consumer listener is attached.
//      The branch under test is the arrow callback (the `log.error(...)`
//      call) which only executes when the stream emits 'error'.

import { describe, it, expect, vi } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Logger } from 'pino';
import {
  isBaileysEncryptedTmpEnoent,
  createMediaReadStream,
} from '../../src/transport/baileys-media-errors.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a typed NodeJS.ErrnoException with the given properties.
 * The source file is `.unknown → Error → NodeJS.ErrnoException` so we
 * attach the `code` / `path` properties to a real Error instance.
 */
function makeNodeError(opts: { code?: string; path?: unknown; message?: string }): NodeJS.ErrnoException {
  const e = new Error(opts.message ?? 'x') as NodeJS.ErrnoException;
  if (opts.code !== undefined) e.code = opts.code;
  if (opts.path !== undefined) e.path = opts.path as string;
  return e;
}

// ─── isBaileysEncryptedTmpEnoent ──────────────────────────────────────────────

describe('isBaileysEncryptedTmpEnoent — type guard', () => {
  it('returns false for non-Error inputs (string)', () => {
    // Branch: !(err instanceof Error) → true → return false
    expect(isBaileysEncryptedTmpEnoent('nope')).toBe(false);
  });

  it('returns false for non-Error inputs (plain object that LOOKS like ENOENT)', () => {
    // Branch: !(err instanceof Error) → true → return false
    // This is the load-bearing case: an object literal with `code:'ENOENT'`
    // and a media-shaped path must NOT be mis-identified as the production
    // error shape.
    const fakeErr = { code: 'ENOENT', path: '/tmp/user/1000/document-abc-enc' };
    expect(isBaileysEncryptedTmpEnoent(fakeErr)).toBe(false);
  });

  it('returns false for non-Error inputs (null and undefined)', () => {
    expect(isBaileysEncryptedTmpEnoent(null)).toBe(false);
    expect(isBaileysEncryptedTmpEnoent(undefined)).toBe(false);
  });

  it('returns false when code is not ENOENT (e.g. EACCES) even if path matches regex', () => {
    // Branch: nodeErr.code === 'ENOENT' → false → return false
    const err = makeNodeError({ code: 'EACCES', path: '/tmp/user/1000/document-abc-enc' });
    expect(isBaileysEncryptedTmpEnoent(err)).toBe(false);
  });

  it('returns false when code is ENOENT but path is undefined', () => {
    // Branch: typeof nodeErr.path === 'string' → false → return false
    const err = makeNodeError({ code: 'ENOENT', path: undefined });
    expect(isBaileysEncryptedTmpEnoent(err)).toBe(false);
  });

  it('returns false when code is ENOENT but path is a non-string (number)', () => {
    // Branch: typeof nodeErr.path === 'string' → false → return false
    // Defensive guard: a mis-cast numeric `path` must not pass.
    const err = makeNodeError({ code: 'ENOENT', path: 42 });
    expect(isBaileysEncryptedTmpEnoent(err)).toBe(false);
  });

  it('returns false when path is a string but does not match the media-enc regex', () => {
    // Branch: regex.test(nodeErr.path) → false → return false
    const err = makeNodeError({ code: 'ENOENT', path: '/tmp/user/1000/notmedia.txt' });
    expect(isBaileysEncryptedTmpEnoent(err)).toBe(false);
  });

  it('returns false for a path that ends with -enc but uses an unsupported prefix', () => {
    // Branch: regex.test(nodeErr.path) → false → return false
    // The regex only allows document|image|audio|video|sticker.
    const err = makeNodeError({ code: 'ENOENT', path: '/tmp/user/1000/invoice-deadbeef-enc' });
    expect(isBaileysEncryptedTmpEnoent(err)).toBe(false);
  });

  it('returns true for an ENOENT with a document-enc path (production signature)', () => {
    // All four guard branches pass: Error ✓, code===ENOENT ✓, path:string ✓, regex ✓
    const err = makeNodeError({
      code: 'ENOENT',
      path: '/tmp/user/1000/document-abc123-enc',
    });
    expect(isBaileysEncryptedTmpEnoent(err)).toBe(true);
  });

  it('returns true for each supported media prefix (image, audio, video, sticker, document)', () => {
    // One combined assertion covering the alternation in the regex:
    //   (?:document|image|audio|video|sticker)
    const results = [
      isBaileysEncryptedTmpEnoent(makeNodeError({ code: 'ENOENT', path: '/tmp/x/image-1-enc' })),
      isBaileysEncryptedTmpEnoent(makeNodeError({ code: 'ENOENT', path: '/tmp/x/audio-2-enc' })),
      isBaileysEncryptedTmpEnoent(makeNodeError({ code: 'ENOENT', path: '/tmp/x/video-3-enc' })),
      isBaileysEncryptedTmpEnoent(makeNodeError({ code: 'ENOENT', path: '/tmp/x/sticker-4-enc' })),
      isBaileysEncryptedTmpEnoent(makeNodeError({ code: 'ENOENT', path: '/tmp/x/document-5-enc' })),
    ];
    expect(results).toEqual([true, true, true, true, true]);
  });

  it('returns true for a Windows-style backslash separator in the path', () => {
    // The regex's `(?:^|[/\\])` anchor must accept both POSIX `/` and
    // Windows `\` separators before the media prefix.
    const err = makeNodeError({
      code: 'ENOENT',
      path: 'C:\\tmp\\user\\1000\\document-deadbeef-enc',
    });
    expect(isBaileysEncryptedTmpEnoent(err)).toBe(true);
  });

  it('returns true for a path that starts directly with the media prefix (no separator)', () => {
    // The `(?:^|[/\\])` anchor must also accept the start-of-string case
    // so a bare `document-xyz-enc` is recognised too.
    const err = makeNodeError({ code: 'ENOENT', path: 'document-deadbeef-enc' });
    expect(isBaileysEncryptedTmpEnoent(err)).toBe(true);
  });
});

// ─── createMediaReadStream ────────────────────────────────────────────────────

describe('createMediaReadStream — error-listener callback', () => {
  it('invokes the internal error-listener callback with the failing path (ENOENT)', async () => {
    expect.assertions(3);

    // Mock logger — only `error` is exercised by the source.
    const log = { error: vi.fn() } as unknown as Logger;

    // Open a NON-EXISTENT path so createReadStream emits 'error' synchronously
    // on the next tick. The function's internal listener logs the failure
    // before any caller listener can observe the same event.
    const missingPath = '/nonexistent-dir-xyz/document-deadbeef-enc';
    const stream = createMediaReadStream(missingPath, '/nonexistent-dir-xyz', log);

    // Attach our own listener so we can await the re-emission without
    // relying on real timers. The internal listener runs synchronously,
    // our listener resolves this promise when the event is re-emitted.
    await new Promise<void>((resolve) => {
      stream.on('error', () => resolve());
    });

    // The internal listener must have logged exactly once...
    expect(log.error).toHaveBeenCalledTimes(1);
    // ...and the structured log payload must carry the path that failed.
    expect(vi.mocked(log.error).mock.calls[0]?.[0]).toMatchObject({
      path: missingPath,
    });
    // The log message must mention interception / propagation so operators
    // can correlate it with the suppression contract documented at the call site.
    expect(vi.mocked(log.error).mock.calls[0]?.[1]).toMatch(/intercept/i);

    // Cleanup: the stream is already in an error state; drop our listener
    // so it does not leak between tests.
    stream.removeAllListeners('error');
  });

  it('returns a Readable and opens an existing file without invoking log.error', async () => {
    expect.assertions(3);

    const log = { error: vi.fn() } as unknown as Logger;
    const tmpDir = mkdtempSync(join(tmpdir(), 'ws-media-errors-'));
    const filePath = join(tmpDir, 'document-abc-enc');
    writeFileSync(filePath, 'payload');

    try {
      const stream = createMediaReadStream(filePath, tmpDir, log);

      // Sanity: the returned object is a Readable (has .on, .pipe, etc.).
      expect(typeof stream.on).toBe('function');
      expect(stream.readable).toBe(true);

      // Consume + close so the handle is released before tmpDir cleanup.
      await new Promise<void>((resolve, reject) => {
        stream.on('end', () => resolve());
        stream.on('error', (e) => reject(e));
        stream.resume();
      });

      // The error path was not taken — log.error must NOT have been called.
      expect(log.error).not.toHaveBeenCalled();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
