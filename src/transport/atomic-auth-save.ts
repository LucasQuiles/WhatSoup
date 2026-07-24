import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { BufferJSON } from '@whiskeysockets/baileys';

import { createChildLogger } from '../logger.ts';
import { privateWriteError } from '../lib/private-fs.ts';

const log = createChildLogger('atomic-auth-save');

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

export async function writeAtomicBaileysJson(path: string, data: unknown): Promise<void> {
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

export function createAtomicCredsSaver(authDir: string, getCreds: () => unknown): () => Promise<void> {
  let tail: Promise<void> = Promise.resolve();
  const credsPath = join(authDir, 'creds.json');

  return () => {
    const next = tail.then(() => writeAtomicBaileysJson(credsPath, getCreds()));
    tail = next.then(
      () => undefined,
      (err) => {
        // The serialisation chain (tail) must not stay rejected, or every subsequent
        // save would be permanently blocked by one failure. But flattening both paths
        // to `undefined` with no log meant fire-and-forget callers — notably
        // `sock.ev.on('creds.update', saveCreds)` in auth.ts — silently swallowed
        // credential write failures (disk full, permission denied, I/O error). Await-
        // based callers see the rejection via `next`; this ensures the silent path is
        // visible too. See #2165.
        log.error({ err }, 'credential save failed — will retry on next creds.update');
        return undefined;
      },
    );
    return next;
  };
}
