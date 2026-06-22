// src/lib/private-fs.ts
// Shared private-file helpers used by workspace, auth-bond, and outbox writers.
//
// TWO DISTINCT ALGORITHMS — do not merge them:
//   assertPrivateDirectorySync / ensurePrivateDirectorySync (workspace pattern):
//     assert-first, mkdir on ENOENT, then chmod to 0700. Refuses symlinks before chmod.
//   forceEnsurePrivateDirectorySync (auth-bond / bot-errors pattern):
//     mkdir-then-force-chmod. Refuses symlinks after mkdir.

import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export function privateWriteError(message: string, code: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

export function assertPrivateDirectorySync(dirPath: string): void {
  const stat = lstatSync(dirPath);
  if (stat.isSymbolicLink()) {
    throw privateWriteError('refusing to use private directory through symlink', 'ELOOP');
  }
  if (!stat.isDirectory()) {
    throw privateWriteError('refusing to use private directory over non-directory path', 'EINVAL');
  }
}

export function ensurePrivateDirectorySync(dirPath: string): void {
  try {
    assertPrivateDirectorySync(dirPath);
    chmodSync(dirPath, 0o700);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  assertPrivateDirectorySync(dirPath);
  chmodSync(dirPath, 0o700);
}

export function writePrivateFileSync(filePath: string, data: string): void {
  assertPrivateDirectorySync(dirname(filePath));

  try {
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      throw privateWriteError('refusing to write private file through symlink', 'ELOOP');
    }
    if (!stat.isFile()) {
      throw privateWriteError('refusing to write private file over non-regular path', 'EINVAL');
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let fd: number | undefined;
  try {
    fd = openSync(filePath, flags, 0o600);
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw privateWriteError('refusing to write private file over non-regular path', 'EINVAL');
    }
    fchmodSync(fd, 0o600);
    ftruncateSync(fd, 0);
    writeFileSync(fd, data, { encoding: 'utf-8' });
    fchmodSync(fd, 0o600);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * mkdir-then-force-chmod variant used by auth-bond and bot-errors writers.
 * Threads the caller-supplied label into error messages verbatim.
 *
 * Algorithm: mkdir (recursive, 0o700) -> lstat -> refuse symlink -> chmodSync to
 * 0o700. Unlike assertPrivateDirectorySync/ensurePrivateDirectorySync this
 * variant always calls chmodSync even when the directory already existed.
 */
export function forceEnsurePrivateDirectorySync(dirPath: string, label: string): void {
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  const st = lstatSync(dirPath);
  if (st.isSymbolicLink()) {
    throw privateWriteError(`refusing to use ${label} through symlink: ${dirPath}`, 'ELOOP');
  }
  if (!st.isDirectory()) {
    throw privateWriteError(`refusing to use ${label} over non-directory path: ${dirPath}`, 'EINVAL');
  }
  chmodSync(dirPath, 0o700);
}

/**
 * Best-effort fsync of a directory so a freshly created/renamed entry survives a
 * crash. Some platforms/filesystems reject directory fsync; the preceding file
 * fsync is the durability guarantee, and directory fsync is the extra
 * crash-survival guarantee where the platform supports it. Errors are swallowed.
 */
export function fsyncDirectory(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    fsyncSync(fd);
  } catch {
    // Directory fsync is best-effort on some filesystems.
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
