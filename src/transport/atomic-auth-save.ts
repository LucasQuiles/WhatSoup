import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { BufferJSON } from '@whiskeysockets/baileys';

import { privateWriteError } from '../lib/private-fs.ts';

async function assertPrivateDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) {
    throw privateWriteError('refusing to use auth directory through symlink', 'ELOOP');
  }
  if (!stat.isDirectory()) {
    throw privateWriteError('refusing to use auth directory over non-directory path', 'EINVAL');
  }
}

async function assertWritableAuthJsonTarget(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      throw privateWriteError('refusing to write auth json through symlink', 'ELOOP');
    }
    if (!stat.isFile()) {
      throw privateWriteError('refusing to write auth json over non-regular path', 'EINVAL');
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Called the instant the rename makes new bytes visible, before the fallible
 * chmod that follows it. Anything deriving state from this file must be
 * invalidated here rather than after the returned promise settles: the rename
 * is the commit point, and a chmod failure after it would otherwise leave a
 * committed write that no observer was told about.
 *
 * Declared `void`, and the caller does not await it: the commit point must not
 * wait on an observer. TypeScript admits an async function in a void slot, so
 * the call site attaches a rejection handler to anything thenable rather than
 * letting it become an unhandled rejection — which main.ts turns into an
 * instance shutdown.
 */
export type AuthJsonCommitHook = () => void;

export async function writeAtomicBaileysJson(
  path: string,
  data: unknown,
  onCommitted?: AuthJsonCommitHook,
): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(dir);
  await chmod(dir, 0o700);
  await assertWritableAuthJsonTarget(path);

  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let file: Awaited<ReturnType<typeof open>> | null = null;

  try {
    file = await open(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await file.chmod(0o600);
    await file.writeFile(JSON.stringify(data, BufferJSON.replacer), 'utf8');
    await file.sync();
    await file.close();
    file = null;
    await assertWritableAuthJsonTarget(path);
    await rename(tmp, path);
    // The commit point. Fire before chmod, and never let a hook failure undo a
    // write that already succeeded.
    if (onCommitted) {
      try {
        const settled = onCommitted() as unknown;
        // An async hook's rejection cannot reach the synchronous catch above.
        if (settled && typeof (settled as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(settled).catch(() => { /* observers must not break the save */ });
        }
      } catch {
        // Intentional: the rename already committed, so observer failure cannot
        // be allowed to turn a durable credential save into an apparent failure.
      }
    }
    await chmod(path, 0o600);

    try {
      const dirHandle = await open(dir, 'r');
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch {
      // Some filesystems refuse directory fsync; the atomic rename still prevents zero-byte exposure.
    }
  } catch (err) {
    if (file) {
      try {
        await file.close();
      } catch {
        // best-effort
      }
    }
    try {
      await unlink(tmp);
    } catch {
      // best-effort
    }
    throw err;
  }
}

export function createAtomicCredsSaver(
  authDir: string,
  getCreds: () => unknown,
  onCommitted?: AuthJsonCommitHook,
): () => Promise<void> {
  let tail: Promise<void> = Promise.resolve();
  const credsPath = join(authDir, 'creds.json');

  return () => {
    const next = tail.then(() => writeAtomicBaileysJson(credsPath, getCreds(), onCommitted));
    tail = next.then(() => undefined, () => undefined);
    return next;
  };
}
