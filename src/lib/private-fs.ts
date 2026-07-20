// src/lib/private-fs.ts
// Shared private-file helpers used by workspace, auth-bond, and outbox writers.
//
// TWO DISTINCT ALGORITHMS — do not merge them:
//   assertPrivateDirectorySync / ensurePrivateDirectorySync (workspace pattern):
//     assert-first, mkdir on ENOENT, then chmod to 0700. Refuses symlinks before chmod.
//   forceEnsurePrivateDirectorySync (auth-bond / bot-errors pattern):
//     mkdir-then-force-chmod. Refuses symlinks after mkdir.

import { randomUUID } from 'node:crypto';
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
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, join } from 'node:path';

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

export interface PrivateWriteOptions {
  /** Refuse to overwrite: open with O_EXCL so a pre-existing path fails EEXIST. */
  exclusive?: boolean;
  /** File permission bits for the created/updated file. Defaults to 0o600. */
  mode?: number;
}

/**
 * Write a private file with TOCTOU-resistant symlink refusal.
 *
 * Guard sequence (must stay in this order — the symlink/non-file refusal runs
 * BEFORE the write): assert the parent directory is a real (non-symlink)
 * directory, lstat the target and refuse a symlink (ELOOP) or non-regular file
 * (EINVAL), then open with O_NOFOLLOW so the kernel also refuses a symlink at
 * open time, re-check via fstat, force the mode, truncate, write, and re-force
 * the mode.
 *
 * Backward-compatible: called as `(path, string)` it behaves exactly as the
 * original fixed-mode string writer (mode 0o600, no O_EXCL). The optional
 * `options` add Buffer payloads, a per-call `mode`, and an `exclusive`
 * (refuse-overwrite / O_EXCL) mode.
 */
export function writePrivateFileSync(
  filePath: string,
  data: string | Buffer,
  options: PrivateWriteOptions = {},
): void {
  assertPrivateDirectorySync(dirname(filePath));
  const mode = options.mode ?? 0o600;

  try {
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      throw privateWriteError('refusing to write private file through symlink', 'ELOOP');
    }
    if (!stat.isFile()) {
      throw privateWriteError('refusing to write private file over non-regular path', 'EINVAL');
    }
    if (options.exclusive) {
      throw privateWriteError('refusing to create private file because it already exists', 'EEXIST');
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const flags = constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK |
    (options.exclusive ? constants.O_EXCL : 0);
  let fd: number | undefined;
  try {
    fd = openSync(filePath, flags, mode);
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw privateWriteError('refusing to write private file over non-regular path', 'EINVAL');
    }
    fchmodSync(fd, mode);
    ftruncateSync(fd, 0);
    if (typeof data === 'string') writeFileSync(fd, data, { encoding: 'utf-8' });
    else writeFileSync(fd, data);
    fchmodSync(fd, mode);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Atomically replace a private file with a mode-0600 payload.
 *
 * The sibling temp is collision-resistant and opened exclusively with
 * O_NOFOLLOW, then fsynced before rename. After rename the parent directory is
 * fsynced; by default that fsync is best-effort, and callers that must prove
 * the rename is crash-durable can require it to succeed.
 */
export function writeAtomicPrivateFileSync(
  filePath: string,
  data: string | Buffer,
  label = 'private file',
  directoryFsync: 'best-effort' | 'required' = 'best-effort',
): void {
  const dir = dirname(filePath);
  forceEnsurePrivateDirectorySync(dir, `${label} directory`);
  assertWritablePrivateFileSync(filePath, label);

  const tmpPath = join(dir, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | null = null;
  let tempCreated = false;
  try {
    fd = openSync(
      tmpPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    tempCreated = true;
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw privateWriteError(`refusing to write ${label} over non-regular path`, 'EINVAL');
    }
    fchmodSync(fd, 0o600);
    if (typeof data === 'string') writeFileSync(fd, data, { encoding: 'utf-8' });
    else writeFileSync(fd, data);
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;

    assertWritablePrivateFileSync(filePath, label);
    renameSync(tmpPath, filePath);
    tempCreated = false;
    if (directoryFsync === 'required') fsyncDirectoryRequired(dir);
    else fsyncDirectory(dir);
  } catch (err) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* preserve the original failure */ }
    }
    if (tempCreated) {
      try { unlinkSync(tmpPath); } catch { /* preserve the original failure */ }
    }
    throw err;
  }
}

export interface PrivateReadOptions {
  label?: string;
  maxBytes: number;
}

function assertStrictPrivateDirectorySync(dirPath: string, label: string): void {
  const stat = lstatSync(dirPath);
  if (stat.isSymbolicLink()) {
    throw privateWriteError(`refusing to use ${label} directory through symlink`, 'ELOOP');
  }
  if (!stat.isDirectory()) {
    throw privateWriteError(`refusing to use ${label} directory over non-directory path`, 'EINVAL');
  }
  assertCurrentUserOwnsPrivatePath(
    stat,
    `refusing to use ${label} directory not owned by current user`,
  );
  if ((stat.mode & 0o077) !== 0) {
    throw privateWriteError(`refusing to use ${label} directory with non-private permissions`, 'EACCES');
  }
}

function assertCurrentUserOwnsPrivatePath(stat: Stats, message: string): void {
  const currentUserId = typeof process.getuid === 'function' ? process.getuid() : null;
  if (currentUserId !== null && stat.uid !== currentUserId) {
    throw privateWriteError(message, 'EACCES');
  }
}

function assertReadablePrivateFileStat(
  stat: Stats,
  label: string,
  maxBytes: number,
): void {
  if (stat.isSymbolicLink()) {
    throw privateWriteError(`refusing to read ${label} through symlink`, 'ELOOP');
  }
  if (!stat.isFile()) {
    throw privateWriteError(`refusing to read ${label} from non-regular path`, 'EINVAL');
  }
  assertCurrentUserOwnsPrivatePath(
    stat,
    `refusing to read ${label} not owned by current user`,
  );
  if ((stat.mode & 0o077) !== 0) {
    throw privateWriteError(`refusing to read ${label} with non-private permissions`, 'EACCES');
  }
  if (stat.size > maxBytes) {
    throw privateWriteError(`refusing to read ${label} above maximum size`, 'EFBIG');
  }
}

/** Read a bounded private regular file without following symlinks or FIFOs. */
export function readPrivateFileSync(filePath: string, options: PrivateReadOptions): string | null {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new RangeError('maxBytes must be a positive safe integer');
  }
  const label = options.label ?? 'private file';
  const dir = dirname(filePath);
  try {
    assertStrictPrivateDirectorySync(dir, label);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  let pathStat: Stats;
  try {
    pathStat = lstatSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  assertReadablePrivateFileStat(pathStat, label, options.maxBytes);

  let fd: number | null = null;
  try {
    fd = openSync(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const openedStat = fstatSync(fd);
    assertReadablePrivateFileStat(openedStat, label, options.maxBytes);

    const data = Buffer.alloc(options.maxBytes + 1);
    let length = 0;
    while (length < data.length) {
      const count = readSync(fd, data, length, data.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > options.maxBytes) {
      throw privateWriteError(`refusing to read ${label} above maximum size`, 'EFBIG');
    }
    return data.subarray(0, length).toString('utf-8');
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Delete a private regular file and attempt to settle the parent directory entry. */
export function deletePrivateFileSync(filePath: string, label = 'private file'): boolean {
  const dir = dirname(filePath);
  try {
    assertStrictPrivateDirectorySync(dir, label);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }

  let stat: Stats;
  try {
    stat = lstatSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  if (stat.isSymbolicLink()) {
    throw privateWriteError(`refusing to delete ${label} through symlink`, 'ELOOP');
  }
  if (!stat.isFile()) {
    throw privateWriteError(`refusing to delete ${label} from non-regular path`, 'EINVAL');
  }
  assertCurrentUserOwnsPrivatePath(
    stat,
    `refusing to delete ${label} not owned by current user`,
  );

  unlinkSync(filePath);
  fsyncDirectory(dir);
  return true;
}

/**
 * Assert that a private file path is safe to write through: lstat the target and
 * refuse a symlink (ELOOP) or any non-regular file (EINVAL). A missing target
 * (ENOENT) is fine — the file may not exist yet. The caller-supplied `label` is
 * threaded into the error messages verbatim so each consumer keeps its own
 * "refusing to write <label> …" wording.
 *
 * This is the TOCTOU symlink/non-regular guard shared by the marker and config
 * writers; it does NOT open or write the file.
 */
export function assertWritablePrivateFileSync(filePath: string, label = 'private file'): void {
  let stat: Stats;
  try {
    stat = lstatSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (stat.isSymbolicLink()) {
    throw privateWriteError(`refusing to write ${label} through symlink`, 'ELOOP');
  }
  if (!stat.isFile()) {
    throw privateWriteError(`refusing to write ${label} over non-regular path`, 'EINVAL');
  }
}

export interface PrivateJsonMarkerWriteOptions {
  /** Label used in target-path refusal errors. Defaults to "marker". */
  label?: string;
  /** Require the containing-directory fsync to succeed. Defaults to best-effort. */
  directoryFsync?: 'best-effort' | 'required';
}

/**
 * Atomically write a private JSON marker file (mode 0600) with TOCTOU-resistant
 * symlink refusal. The marker directory is created (recursive, 0o700) and
 * force-chmodded, then the payload is written to a temp file in the same
 * directory, forced to mode 0600, fsynced, and renamed over the target. The
 * directory is fsynced after publication; callers that must prove rollback
 * intent is crash-durable can require that fsync to succeed. The target is
 * re-asserted both before the temp write and immediately before the rename to
 * close the TOCTOU window. On any failure the temp file is cleaned up.
 *
 * No fallible target operation runs after rename in best-effort mode, so a
 * reported failure means the new payload was not published. The serialized
 * payload is `JSON.stringify(value, null, 2) + '\n'`.
 */
export function writePrivateJsonMarkerSync(
  filePath: string,
  value: unknown,
  options: PrivateJsonMarkerWriteOptions = {},
): void {
  writeAtomicPrivateFileSync(
    filePath,
    JSON.stringify(value, null, 2) + '\n',
    options.label ?? 'marker',
    options.directoryFsync,
  );
}

/**
 * Append one JSON value to a newline-delimited private event file (mode 0600).
 * This is for append-only evidence streams where overwriting a marker would lose
 * the incident timeline. The target is guarded before open and by O_NOFOLLOW;
 * the parent directory is private 0700 and the descriptor is fsynced before
 * close so an event is durable before a process parks or exits.
 */
export function appendPrivateJsonLineSync(filePath: string, value: unknown): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertPrivateDirectorySync(dir);
  chmodSync(dir, 0o700);
  assertWritablePrivateFileSync(filePath, 'event log');

  const flags = constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_APPEND |
    constants.O_NOFOLLOW;
  let fd: number | null = null;
  try {
    fd = openSync(filePath, flags, 0o600);
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw privateWriteError('refusing to write event log over non-regular path', 'EINVAL');
    }
    fchmodSync(fd, 0o600);
    writeFileSync(fd, JSON.stringify(value) + '\n', 'utf-8');
    fsyncSync(fd);
    fchmodSync(fd, 0o600);
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Read a private JSON marker and return it only if it is fresh — within
 * `maxAgeMs` of its `timestamp` (ISO) field. Returns null when the file is
 * missing, the timestamp is missing/unparseable (non-finite age), the age is
 * `>= maxAgeMs` (exclusive upper bound), or the read/parse fails for any reason.
 * Never throws.
 */
export function readFreshMarkerSync<T = unknown>(filePath: string, maxAgeMs: number): T | null {
  try {
    const marker = JSON.parse(readFileSync(filePath, 'utf-8')) as T & { timestamp?: string };
    const ageMs = Date.now() - new Date(marker.timestamp as string).getTime();
    if (!Number.isFinite(ageMs) || ageMs >= maxAgeMs) return null;
    return marker as T;
  } catch {
    // Marker file missing, unreadable, corrupt, or otherwise unusable — treat as absent.
    return null;
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
  try {
    fsyncDirectoryRequired(path);
  } catch {
    // Directory fsync is best-effort on some filesystems.
  }
}

function fsyncDirectoryRequired(path: string): void {
  let fd: number | null = null;
  let failure: unknown;
  let failed = false;
  try {
    fd = openSync(path, 'r');
    fsyncSync(fd);
  } catch (error) {
    failure = error;
    failed = true;
  }
  if (fd !== null) {
    try {
      closeSync(fd);
    } catch (error) {
      if (!failed) {
        failure = error;
        failed = true;
      }
    }
  }
  if (failed) throw failure;
}
