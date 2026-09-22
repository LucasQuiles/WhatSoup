// src/lib/private-fs.ts
// Shared private-file helpers used by workspace, auth-bond, and outbox writers.
//
// TWO DISTINCT ALGORITHMS — do not merge them:
//   assertPrivateDirectorySync / ensurePrivateDirectorySync (workspace pattern):
//     assert-first, mkdir on ENOENT, then chmod to 0700. Refuses symlinks before chmod.
//   forceEnsurePrivateDirectorySync (auth-bond / bot-errors pattern):
//     mkdir-then-force-chmod. Refuses symlinks after mkdir.

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { BigIntStats, Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { systemClock } from './clock.ts';
import { SIGNAL } from './signals.ts';

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
 *
 * This in-process writer is the default for hot paths. Writers that must also
 * survive an ancestor-directory exchange mid-write use
 * {@link writeAtomicPrivateFileIsolatedSync}, which costs two child processes
 * per write.
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

/**
 * Opt-in hardened variant of {@link writeAtomicPrivateFileSync} with the same
 * signature and the same mode-0600 atomic-replace contract.
 *
 * The sibling temp is collision-resistant and opened exclusively with
 * O_NOFOLLOW by an isolated bounded child, then fsynced before an atomic
 * rename onto the target. After rename the child fsyncs the parent directory
 * (best-effort by default; callers that must prove the rename is
 * crash-durable can require that fsync to succeed).
 *
 * The replacement mutations are bound to the opened directory: the parent
 * canonicalizes the target directory once, identity-binds every ancestor of
 * that canonical path, then delegates the temp-write and the publishing rename
 * to the child. The child operates relative to its working directory — pinned
 * to the bound dev/ino — and re-validates both that identity and the absolute
 * bound path before each mutation, so an ancestor exchange after binding
 * (directory renamed away, decoy symlinked into place) surfaces as ESTALE
 * instead of silently writing through the decoy. Failure-path temp removal is
 * identity-guarded inside the child: the temp is only unlinked while it still
 * resolves to the inode the child created, so cleanup never unlinks through a
 * swapped pathname.
 *
 * Canonicalizing before binding keeps platform symlinks that already exist in
 * the path (for example macOS `/var` -> `/private/var`) usable; the target
 * directory itself must still be a real directory.
 *
 * Errors: child-side failures surface as a sanitized code (EACCES, EEXIST,
 * EFBIG, EINVAL, EIO, ELOOP, ENOSPC, ESTALE); supervision failures throw a
 * BoundedProcessError (ETIMEDOUT, EOWNERDEAD, EFBIG, EINTR, EPROTO).
 */
export function writeAtomicPrivateFileIsolatedSync(
  filePath: string,
  data: string | Buffer,
  label = 'private file',
  directoryFsync: 'best-effort' | 'required' = 'best-effort',
): void {
  const dir = dirname(filePath);
  forceEnsurePrivateDirectorySync(dir, `${label} directory`);
  assertWritablePrivateFileSync(filePath, label);
  const boundDir = realpathSync(dir);
  const boundAncestors = bindDirectoryAncestorIdentitiesSync(boundDir, label);
  assertDirectoryAncestorIdentitiesSync(boundAncestors, label);
  const assertBoundAncestors = () => assertDirectoryAncestorIdentitiesSync(boundAncestors, label);
  const directoryIdentity = boundAncestors.at(-1);
  if (!directoryIdentity || directoryIdentity.path !== boundDir) {
    throw privateWriteError('replacement publication directory could not be bound', 'ESTALE');
  }
  const targetName = basename(filePath);
  if (targetName !== filePath.slice(filePath.length - targetName.length) || targetName === '.' || targetName === '..') {
    throw privateWriteError(`refusing to write ${label} to an invalid target name`, 'EINVAL');
  }
  const boundTarget = join(boundDir, targetName);
  const tempName = `.${targetName}.${process.pid}.${randomUUID()}.tmp`;
  const payload = typeof data === 'string' ? Buffer.from(data) : data;
  if (payload.byteLength > REPLACE_MAX_PAYLOAD_BYTES) {
    throw privateWriteError(`refusing to write ${label} above maximum size`, 'EFBIG');
  }
  const payloadSha256 = createHash('sha256').update(payload).digest('hex');
  const header = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    operation: 'replace-publish',
    directoryPath: directoryIdentity.path,
    directoryDev: String(directoryIdentity.dev),
    directoryIno: String(directoryIdentity.ino),
    directoryFsync,
    targetName,
    tempName,
    payloadSize: payload.byteLength,
    payloadSha256,
  }));
  if (header.byteLength > REPLACE_MAX_HEADER_BYTES) {
    throw privateWriteError('replacement publication control frame is invalid', 'EINVAL');
  }
  const frame = Buffer.allocUnsafe(4 + header.byteLength + payload.byteLength);
  frame.writeUInt32BE(header.byteLength, 0);
  header.copy(frame, 4);
  payload.copy(frame, 4 + header.byteLength);
  // The mutations run in the isolated child, so the parent asserts the target
  // once more immediately before handing off; the child re-asserts it again,
  // relative to its bound working directory, right before the rename.
  assertWritablePrivateFileSync(filePath, label);
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(
      process.execPath,
      [
        '--input-type=commonjs', '--eval', BOUNDED_PROCESS_SUPERVISOR_SOURCE,
        REPLACE_PUBLISH_CHILD_SOURCE, '4096', '10000',
      ],
      {
        cwd: boundDir,
        input: frame,
        env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        timeout: 15_000,
        killSignal: SIGNAL.KILL,
        maxBuffer: 4096,
        windowsHide: true,
      },
    );
  } catch {
    boundedProcessFailure('cleanup-uncertain');
  }
  assertBoundAncestors();
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    requireBoundedOuterCleanup(result);
    if (code === 'ETIMEDOUT') boundedProcessFailure('timeout');
    if (code === 'ENOBUFS') boundedProcessFailure('output-limit');
    boundedProcessFailure('transport-invalid');
  }
  if (result.status === 71) boundedProcessFailure('timeout');
  if (result.status === 72) boundedProcessFailure('output-limit');
  if (result.status !== 0 || result.signal !== null) {
    requireBoundedOuterCleanup(result);
    boundedProcessFailure(result.signal === null ? 'transport-invalid' : 'unexpected-signal');
  }
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : null;
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : null;
  const transportValid = !result.error
    && result.status === 0
    && result.signal === null
    && stdout !== null
    && stderr !== null
    && stderr.byteLength === 0;
  type ReplaceSuccessReceipt = {
    schemaVersion: number;
    status: string;
    published: { dev: string; ino: string; sizeBytes: number; payloadSha256: string };
  };
  let successReceipt: ReplaceSuccessReceipt | null = null;
  if (transportValid && stdout !== null && stdout.byteLength <= 512) {
    try {
      successReceipt = JSON.parse(stdout.toString('utf8')) as ReplaceSuccessReceipt;
    } catch { /* intentional: malformed child receipt stays null and publication is refused — fail-closed */ }
  }
  if (
    successReceipt !== null
    && stdout?.at(-1) === 0x0a
    && successReceipt.schemaVersion === 1
    && successReceipt.status === 'ok'
    && successReceipt.published !== null
    && typeof successReceipt.published === 'object'
    && JSON.stringify(Object.keys(successReceipt).sort()) === JSON.stringify(['published', 'schemaVersion', 'status'])
    && JSON.stringify(Object.keys(successReceipt.published).sort()) === JSON.stringify(['dev', 'ino', 'payloadSha256', 'sizeBytes'])
    && successReceipt.published.sizeBytes === payload.byteLength
    && successReceipt.published.payloadSha256 === payloadSha256
    && stdout.equals(Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      status: 'ok',
      published: successReceipt.published,
    })}\n`))
  ) {
    assertBoundAncestors();
    const published = lstatSync(boundTarget);
    if (
      published.isSymbolicLink()
      || !published.isFile()
      || published.nlink !== 1
      || (published.mode & 0o777) !== 0o600
      || String(published.dev) !== successReceipt.published.dev
      || String(published.ino) !== successReceipt.published.ino
      || published.size !== payload.byteLength
    ) throw privateWriteError('replacement publication result is invalid', 'EIO');
    let descriptor: number | null = null;
    try {
      descriptor = openSync(
        boundTarget,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const opened = fstatSync(descriptor);
      if (
        !opened.isFile()
        || opened.nlink !== 1
        || (opened.mode & 0o777) !== 0o600
        || opened.dev !== published.dev
        || opened.ino !== published.ino
        || opened.size !== payload.byteLength
      ) throw privateWriteError('replacement publication result is invalid', 'EIO');
      const readback = Buffer.alloc(payload.byteLength + 1);
      let length = 0;
      while (length < readback.byteLength) {
        const count = readSync(descriptor, readback, length, readback.byteLength - length, null);
        if (count === 0) break;
        length += count;
      }
      const finalStat = fstatSync(descriptor);
      if (
        length !== payload.byteLength
        || !readback.subarray(0, length).equals(payload)
        || !finalStat.isFile()
        || finalStat.nlink !== 1
        || finalStat.dev !== opened.dev
        || finalStat.ino !== opened.ino
        || finalStat.size !== opened.size
      ) throw privateWriteError('replacement publication result is invalid', 'EIO');
    } finally {
      if (descriptor !== null) closeSync(descriptor);
    }
    assertBoundAncestors();
    return;
  }
  const errorMatch = transportValid && stdout !== null && stdout.byteLength <= 256
    ? /^\{"schemaVersion":1,"status":"error","code":"([A-Z0-9]+)","cleanup":"(complete|uncertain)"\}\n$/.exec(stdout.toString('utf8'))
    : null;
  if (errorMatch?.[2] === 'uncertain') boundedProcessFailure('cleanup-uncertain');
  const code = errorMatch && REPLACE_CHILD_ERROR_CODES.has(errorMatch[1]) ? errorMatch[1] : 'EIO';
  throw privateWriteError(
    code === 'EEXIST'
      ? 'refusing to create private file because it already exists'
      : `atomic ${label} publication failed`,
    code,
  );
}

const REPLACE_MAX_HEADER_BYTES = 2048;
const REPLACE_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const REPLACE_CHILD_ERROR_CODES: ReadonlySet<string> = new Set([
  'EACCES', 'EEXIST', 'EFBIG', 'EINVAL', 'EIO', 'ELOOP', 'ENOSPC', 'ESTALE',
]);

// Generic bounded supervisor: runs `childSource` (argv[1]) in its own process
// group with a capture limit (argv[2]) and a deadline (argv[3]), relays the
// child's stdout/stderr only on a clean exit, and reports the child's process
// group id on fd 3 so the parent can reap it if the supervisor itself is
// killed by the outer spawnSync timeout. Exit 70 = supervision failure,
// 71 = deadline, 72 = output limit.
const BOUNDED_PROCESS_SUPERVISOR_SOURCE = String.raw`
'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const MAX_CAPTURE_BYTES = Number(process.argv[2]);
const DEADLINE_MS = Number(process.argv[3]);
const GRACE_MS = 1000;
const SETTLE_MS = 750;
const POLL_MS = 10;
const MAX_FRAME_BYTES = ${4 + REPLACE_MAX_HEADER_BYTES + REPLACE_MAX_PAYLOAD_BYTES};
const childSource = process.argv[1];
let child = null;
let closed = false;
let closeCode = null;
let closeSignal = null;
let failureCode = null;
let terminatingAt = null;
let killSent = false;
let finished = false;
let pollTimer = null;
let deadlineTimer = null;
let stdoutBytes = 0;
let stderrBytes = 0;
const stdoutChunks = [];
const stderrChunks = [];
const groupAlive = () => {
  if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0) return false;
  try { process.kill(-child.pid, 0); return true; } catch (error) {
    return !(error && error.code === 'ESRCH');
  }
};
const signalGroup = (signal) => {
  if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0) return;
  try { process.kill(-child.pid, signal); } catch (error) {
    if (!error || error.code !== 'ESRCH') failureCode = failureCode || 70;
  }
};
const finish = (transportClean) => {
  if (finished) return;
  finished = true;
  if (deadlineTimer !== null) clearTimeout(deadlineTimer);
  if (pollTimer !== null) clearTimeout(pollTimer);
  if (!transportClean || !closed || groupAlive()) process.exit(70);
  if (failureCode !== null) process.exit(failureCode);
  const stdout = Buffer.concat(stdoutChunks, stdoutBytes);
  const stderr = Buffer.concat(stderrChunks, stderrBytes);
  if (stdout.byteLength > 0) fs.writeSync(1, stdout);
  if (stderr.byteLength > 0) fs.writeSync(2, stderr);
  process.exit(closeSignal === null && Number.isInteger(closeCode) ? closeCode : 70);
};
const pollTermination = () => {
  if (finished) return;
  const alive = groupAlive();
  if (closed && !alive) {
    finish(true);
    return;
  }
  if (terminatingAt !== null) {
    // Monotonic by design: the grace/settle deadline measures elapsed time,
    // so a wall clock that steps under NTP/settime could fire the SIGKILL
    // early or hang the reap. performance.now() is a global here.
    const elapsed = performance.now() - terminatingAt;
    if (!killSent && elapsed >= GRACE_MS) {
      killSent = true;
      signalGroup('SIGKILL');
    }
    if (elapsed >= GRACE_MS + SETTLE_MS) {
      signalGroup('SIGKILL');
      finish(false);
      return;
    }
  }
  pollTimer = setTimeout(pollTermination, POLL_MS);
};
const terminate = (code) => {
  failureCode = failureCode || code;
  if (terminatingAt === null) {
    terminatingAt = performance.now();
    signalGroup('SIGTERM');
    pollTermination();
  }
};
const capture = (chunks, chunk, stream) => {
  const bytes = Buffer.from(chunk);
  if (stream === 'stdout') stdoutBytes += bytes.byteLength;
  else stderrBytes += bytes.byteLength;
  if (stdoutBytes > MAX_CAPTURE_BYTES || stderrBytes > MAX_CAPTURE_BYTES) {
    terminate(72);
    return;
  }
  chunks.push(bytes);
};
const fatal = () => {
  failureCode = 70;
  signalGroup('SIGKILL');
  process.exit(70);
};
process.once('SIGTERM', fatal);
process.once('uncaughtException', fatal);
process.once('unhandledRejection', fatal);
let frame;
try {
  if (
    !Number.isSafeInteger(MAX_CAPTURE_BYTES)
    || MAX_CAPTURE_BYTES < 1
    || MAX_CAPTURE_BYTES > ${128 * 1024 * 1024}
    || !Number.isSafeInteger(DEADLINE_MS)
    || DEADLINE_MS < 1
    || DEADLINE_MS > 60000
  ) process.exit(70);
  frame = fs.readFileSync(0);
  if (
    frame.byteLength < 4
    || frame.byteLength > MAX_FRAME_BYTES
    || typeof childSource !== 'string'
    || childSource.length === 0
  ) process.exit(70);
  child = spawn(process.execPath, ['--input-type=commonjs', '--eval', childSource], {
    cwd: '.',
    env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const parentControl = Buffer.from(JSON.stringify({ schemaVersion: 1, processGroupId: child.pid }) + '\n');
  if (parentControl.byteLength < 2 || parentControl.byteLength > 128) throw new Error('invalid parent control');
  fs.writeSync(3, parentControl);
} catch {
  fatal();
}
child.stdout.on('data', (chunk) => capture(stdoutChunks, chunk, 'stdout'));
child.stderr.on('data', (chunk) => capture(stderrChunks, chunk, 'stderr'));
child.stdin.on('error', () => terminate(70));
child.once('error', () => {
  closed = true;
  closeCode = 70;
  terminate(70);
});
child.once('close', (code, signal) => {
  closed = true;
  closeCode = code;
  closeSignal = signal;
  if (groupAlive()) terminate(70);
  else finish(true);
});
deadlineTimer = setTimeout(() => terminate(71), DEADLINE_MS);
child.stdin.end(frame);
`;

const REPLACE_PUBLISH_CHILD_SOURCE = String.raw`
'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const reply = (value) => process.stdout.write(JSON.stringify(value) + '\n');
let descriptor = null;
let directoryDescriptor = null;
let control = null;
let directoryValidated = false;
let tempCreated = false;
let tempIdentity = null;
const codedError = (message, code) => {
  const error = new Error(message); error.code = code; return error;
};
const validateCwdIdentity = () => {
  const cwd = fs.lstatSync('.');
  if (
    !cwd.isDirectory()
    || String(cwd.dev) !== control.directoryDev
    || String(cwd.ino) !== control.directoryIno
  ) throw codedError('directory identity mismatch', 'ESTALE');
};
const validateBoundDirectory = () => {
  validateCwdIdentity();
  let bound;
  try { bound = fs.lstatSync(control.directoryPath); } catch {
    throw codedError('directory identity mismatch', 'ESTALE');
  }
  if (
    bound.isSymbolicLink()
    || !bound.isDirectory()
    || String(bound.dev) !== control.directoryDev
    || String(bound.ino) !== control.directoryIno
  ) throw codedError('directory identity mismatch', 'ESTALE');
  directoryValidated = true;
};
const openBoundDirectory = () => {
  const candidate = fs.openSync('.', 'r');
  const opened = fs.fstatSync(candidate);
  if (
    !opened.isDirectory()
    || String(opened.dev) !== control.directoryDev
    || String(opened.ino) !== control.directoryIno
  ) {
    try { fs.closeSync(candidate); } catch {}
    throw codedError('directory identity mismatch', 'ESTALE');
  }
  return candidate;
};
const cleanupOwnedTemp = () => {
  if (!directoryValidated || !tempIdentity || !control || typeof control.tempName !== 'string') return;
  validateCwdIdentity();
  let temp;
  try { temp = fs.lstatSync(control.tempName); } catch (error) {
    if (error && error.code === 'ENOENT') {
      if (directoryDescriptor === null) directoryDescriptor = openBoundDirectory();
      fs.fsyncSync(directoryDescriptor);
      return;
    }
    throw error;
  }
  if (
    temp.isSymbolicLink()
    || !temp.isFile()
    || String(temp.dev) !== tempIdentity.dev
    || String(temp.ino) !== tempIdentity.ino
  ) throw codedError('temp identity mismatch', 'ESTALE');
  fs.unlinkSync(control.tempName);
  if (directoryDescriptor === null) directoryDescriptor = openBoundDirectory();
  fs.fsyncSync(directoryDescriptor);
};
const closeOwnedDescriptors = () => {
  if (descriptor !== null) { try { fs.closeSync(descriptor); } catch {} descriptor = null; }
  if (directoryDescriptor !== null) { try { fs.closeSync(directoryDescriptor); } catch {} directoryDescriptor = null; }
};
process.once('SIGTERM', () => {
  try { cleanupOwnedTemp(); } catch {}
  closeOwnedDescriptors();
  process.exit(70);
});
try {
  const frame = fs.readFileSync(0);
  if (frame.byteLength < 4) {
    const error = new Error('invalid frame'); error.code = 'EINVAL'; throw error;
  }
  const headerSize = frame.readUInt32BE(0);
  if (headerSize < 2 || headerSize > ${REPLACE_MAX_HEADER_BYTES} || frame.byteLength < 4 + headerSize) {
    const error = new Error('invalid frame'); error.code = 'EINVAL'; throw error;
  }
  try { control = JSON.parse(frame.subarray(4, 4 + headerSize).toString('utf8')); } catch {
    const error = new Error('invalid frame'); error.code = 'EINVAL'; throw error;
  }
  const keys = Object.keys(control || {}).sort();
  const expectedKeys = [
    'directoryDev', 'directoryFsync', 'directoryIno', 'directoryPath', 'operation',
    'payloadSha256', 'payloadSize', 'schemaVersion', 'targetName', 'tempName',
  ].sort();
  const payload = frame.subarray(4 + headerSize);
  if (
    JSON.stringify(keys) !== JSON.stringify(expectedKeys)
    || control.schemaVersion !== 1
    || control.operation !== 'replace-publish'
    || typeof control.directoryPath !== 'string'
    || control.directoryPath.length < 1
    || control.directoryPath.charCodeAt(0) !== 47
    || control.directoryPath.includes('\0')
    || (control.directoryFsync !== 'best-effort' && control.directoryFsync !== 'required')
    || !/^[^/\\\0]+$/.test(control.targetName)
    || control.targetName === '.'
    || control.targetName === '..'
    || !/^\.[^/\\\0]+\.tmp$/.test(control.tempName)
    || control.targetName === control.tempName
    || !/^[0-9]+$/.test(control.directoryDev)
    || !/^[0-9]+$/.test(control.directoryIno)
    || !Number.isSafeInteger(control.payloadSize)
    || control.payloadSize < 0
    || control.payloadSize > ${REPLACE_MAX_PAYLOAD_BYTES}
    || payload.byteLength !== control.payloadSize
    || !/^[0-9a-f]{64}$/.test(control.payloadSha256)
    || crypto.createHash('sha256').update(payload).digest('hex') !== control.payloadSha256
  ) {
    const error = new Error('invalid child input'); error.code = 'EINVAL'; throw error;
  }
  validateBoundDirectory();
  descriptor = fs.openSync(
    control.tempName,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    0o600,
  );
  tempCreated = true;
  const opened = fs.fstatSync(descriptor);
  if (!opened.isFile() || opened.nlink !== 1) {
    const error = new Error('invalid temp'); error.code = 'EINVAL'; throw error;
  }
  tempIdentity = { dev: String(opened.dev), ino: String(opened.ino) };
  fs.fchmodSync(descriptor, 0o600);
  fs.writeFileSync(descriptor, payload);
  fs.fchmodSync(descriptor, 0o600);
  fs.fsyncSync(descriptor);
  fs.closeSync(descriptor);
  descriptor = null;
  validateBoundDirectory();
  let targetStat = null;
  try { targetStat = fs.lstatSync(control.targetName); } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  if (targetStat !== null && (targetStat.isSymbolicLink() || !targetStat.isFile())) {
    throw codedError(
      'refusing to publish over symlinked or non-regular target',
      targetStat.isSymbolicLink() ? 'ELOOP' : 'EINVAL',
    );
  }
  fs.renameSync(control.tempName, control.targetName);
  tempCreated = false;
  if (directoryDescriptor === null) directoryDescriptor = openBoundDirectory();
  if (control.directoryFsync === 'required') fs.fsyncSync(directoryDescriptor);
  else { try { fs.fsyncSync(directoryDescriptor); } catch {} }
  fs.closeSync(directoryDescriptor);
  directoryDescriptor = null;
  const published = fs.lstatSync(control.targetName);
  if (!published.isFile() || published.isSymbolicLink() || published.nlink !== 1 || (published.mode & 0o777) !== 0o600) {
    const error = new Error('invalid result'); error.code = 'EIO'; throw error;
  }
  reply({
    schemaVersion: 1,
    status: 'ok',
    published: {
      dev: String(published.dev),
      ino: String(published.ino),
      sizeBytes: published.size,
      payloadSha256: crypto.createHash('sha256').update(payload).digest('hex'),
    },
  });
} catch (caught) {
  if (descriptor !== null) { try { fs.closeSync(descriptor); } catch {} descriptor = null; }
  let cleanupFailed = tempCreated && tempIdentity === null;
  try { cleanupOwnedTemp(); } catch { cleanupFailed = true; }
  closeOwnedDescriptors();
  const allowed = new Set(['EACCES', 'EEXIST', 'EFBIG', 'EINVAL', 'EIO', 'ELOOP', 'ENOSPC', 'ESTALE']);
  const code = !cleanupFailed && allowed.has(caught && caught.code) ? caught.code : 'EIO';
  reply({ schemaVersion: 1, status: 'error', code, cleanup: cleanupFailed ? 'uncertain' : 'complete' });
}
`;

type BoundedProcessFailureKind =
  | 'timeout'
  | 'cleanup-uncertain'
  | 'output-limit'
  | 'unexpected-signal'
  | 'transport-invalid';

const BOUNDED_PROCESS_FAILURES: Record<BoundedProcessFailureKind, { message: string; code: string }> = {
  timeout: { message: 'owned child exceeded its execution deadline', code: 'ETIMEDOUT' },
  'cleanup-uncertain': { message: 'owned child process-group cleanup is uncertain', code: 'EOWNERDEAD' },
  'output-limit': { message: 'owned child exceeded its bounded output limit', code: 'EFBIG' },
  'unexpected-signal': { message: 'owned child terminated from an unexpected signal', code: 'EINTR' },
  'transport-invalid': { message: 'owned child supervisor receipt is invalid', code: 'EPROTO' },
};

class BoundedProcessError extends Error implements NodeJS.ErrnoException {
  readonly kind: BoundedProcessFailureKind;
  readonly code: string;

  constructor(kind: BoundedProcessFailureKind) {
    const contract = BOUNDED_PROCESS_FAILURES[kind];
    super(contract.message);
    this.name = 'BoundedProcessError';
    this.kind = kind;
    this.code = contract.code;
  }
}

function boundedProcessFailure(kind: BoundedProcessFailureKind): never {
  throw new BoundedProcessError(kind);
}

function parseBoundedProcessControl(
  value: unknown,
  supervisorPid: number | undefined,
): number | null {
  if (!Buffer.isBuffer(value) || value.byteLength < 2 || value.byteLength > 128) return null;
  const match = /^\{"schemaVersion":1,"processGroupId":([1-9][0-9]*)\}\n$/.exec(value.toString('utf8'));
  if (match === null) return null;
  const processGroupId = Number(match[1]);
  if (
    !Number.isSafeInteger(processGroupId)
    || processGroupId <= 1
    || processGroupId === process.pid
    || processGroupId === supervisorPid
    || !value.equals(Buffer.from(`${JSON.stringify({ schemaVersion: 1, processGroupId })}\n`))
  ) return null;
  return processGroupId;
}

function reapBoundedProcessGroup(processGroupId: number): boolean {
  if (process.platform === 'win32') return false;
  try {
    process.kill(-processGroupId, SIGNAL.KILL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    return false;
  }
  const deadline = systemClock.now() + 2_000;
  do {
    try {
      process.kill(-processGroupId, 0);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return true;
      if (code !== 'EPERM') return false;
    }
  } while (systemClock.now() < deadline);
  return false;
}

function requireBoundedOuterCleanup(result: ReturnType<typeof spawnSync>): void {
  const control = Array.isArray(result.output) ? result.output[3] : null;
  const processGroupId = parseBoundedProcessControl(control, result.pid);
  if (processGroupId === null || !reapBoundedProcessGroup(processGroupId)) {
    boundedProcessFailure('cleanup-uncertain');
  }
}

interface DirectoryIdentity {
  path: string;
  dev: number;
  ino: number;
}

function bindDirectoryAncestorIdentitiesSync(dirPath: string, label: string): DirectoryIdentity[] {
  const absolute = resolve(dirPath);
  const root = parse(absolute).root;
  let current = root;
  const identities: DirectoryIdentity[] = [];
  for (const component of absolute.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, component);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw privateWriteError(`refusing to use ${label} through symlinked directory ancestor`, 'ELOOP');
    }
    if (!stat.isDirectory()) {
      throw privateWriteError(`refusing to use ${label} through non-directory ancestor`, 'EINVAL');
    }
    identities.push({ path: current, dev: stat.dev, ino: stat.ino });
  }
  return identities;
}

function assertDirectoryAncestorIdentitiesSync(identities: readonly DirectoryIdentity[], label: string): void {
  for (const identity of identities) {
    const stat = lstatSync(identity.path);
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== identity.dev || stat.ino !== identity.ino) {
      throw privateWriteError(`refusing to use ${label} after directory ancestor identity changed`, 'ESTALE');
    }
  }
}

export interface PrivateReadOptions {
  label?: string;
  maxBytes: number;
  /** Keep file protections while allowing a conventional current-user 0755 parent. */
  requirePrivateParent?: boolean;
}

export interface PrivateObservedReadOptions extends PrivateReadOptions {
  observation: { root: string };
}

export interface PrivateFileIdentity {
  device: string;
  inode: string;
  size: number;
  mode: number;
  uid: number;
  links: number;
  modifiedNs: string;
  changedNs: string;
}

export interface PrivateFileObservation {
  bytes: Buffer;
  rawSha256: string;
  identity: PrivateFileIdentity;
}

function observedIdentity(stat: Stats | BigIntStats): PrivateFileIdentity {
  if (!('mtimeNs' in stat)) {
    throw privateWriteError('private observation requires precise file metadata', 'ENOTSUP');
  }
  return {
    device: String(stat.dev), inode: String(stat.ino), size: Number(stat.size),
    mode: Number(stat.mode), uid: Number(stat.uid), links: Number(stat.nlink),
    modifiedNs: String(stat.mtimeNs), changedNs: String(stat.ctimeNs),
  };
}

function assertUnchangedObservation(
  before: PrivateFileIdentity, after: PrivateFileIdentity, label: string,
): void {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw privateWriteError(`refusing to read changed ${label}`, 'ESTALE');
  }
}

function observeReadParents(filePath: string, root: string, label: string) {
  if (!isAbsolute(root) || resolve(root) !== root || !isAbsolute(filePath) || resolve(filePath) !== filePath) {
    throw privateWriteError('private observation requires canonical absolute paths', 'EINVAL');
  }
  const child = relative(root, filePath);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw privateWriteError('private file is outside its observation root', 'EINVAL');
  }
  if (typeof process.getuid !== 'function') {
    throw privateWriteError('private observation requires current-user ownership evidence', 'ENOTSUP');
  }
  const parents: { path: string; identity: PrivateFileIdentity }[] = [];
  let path = parse(filePath).root;
  const parts = relative(path, dirname(filePath)).split(sep).filter(Boolean);
  for (const part of ['', ...parts]) {
    if (part) path = join(path, part);
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink()) {
      throw privateWriteError(`refusing to read ${label} through a symlink ancestor`, 'ELOOP');
    }
    if (!stat.isDirectory()) {
      throw privateWriteError(`refusing to read ${label} through a non-directory ancestor`, 'EINVAL');
    }
    if (path === root || path.startsWith(root + sep)) {
      assertCurrentUserOwnsPrivatePath(stat, `refusing to use ${label} directory not owned by current user`);
      if ((Number(stat.mode) & 0o077) !== 0) {
        throw privateWriteError(`refusing to use ${label} directory with non-private permissions`, 'EACCES');
      }
    }
    parents.push({ path, identity: observedIdentity(stat) });
  }
  return parents;
}

function assertOwnedDirectorySync(dirPath: string, label: string): Stats {
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
  return stat;
}

function assertStrictPrivateDirectorySync(dirPath: string, label: string): void {
  const stat = assertOwnedDirectorySync(dirPath, label);
  if ((stat.mode & 0o077) !== 0) {
    throw privateWriteError(`refusing to use ${label} directory with non-private permissions`, 'EACCES');
  }
}

function assertCurrentUserOwnsPrivatePath(stat: Stats | BigIntStats, message: string): void {
  const currentUserId = typeof process.getuid === 'function' ? process.getuid() : null;
  if (currentUserId !== null && Number(stat.uid) !== currentUserId) {
    throw privateWriteError(message, 'EACCES');
  }
}

function assertReadablePrivateFileStat(
  stat: Stats | BigIntStats,
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
  if ((Number(stat.mode) & 0o077) !== 0) {
    throw privateWriteError(`refusing to read ${label} with non-private permissions`, 'EACCES');
  }
  if (stat.size > maxBytes) {
    throw privateWriteError(`refusing to read ${label} above maximum size`, 'EFBIG');
  }
}

/** Read a bounded private regular file without following symlinks or FIFOs. */
export function readPrivateFileSync(filePath: string, options: PrivateObservedReadOptions): PrivateFileObservation | null;
export function readPrivateFileSync(filePath: string, options: PrivateReadOptions): string | null;
export function readPrivateFileSync(
  filePath: string, options: PrivateReadOptions | PrivateObservedReadOptions,
): string | PrivateFileObservation | null {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new RangeError('maxBytes must be a positive safe integer');
  }
  const label = options.label ?? 'private file';
  const dir = dirname(filePath);
  const observation = 'observation' in options ? options.observation : null;
  let parents: ReturnType<typeof observeReadParents> = [];
  try {
    if (observation) parents = observeReadParents(filePath, observation.root, label);
    if (options.requirePrivateParent === false) assertOwnedDirectorySync(dir, label);
    else assertStrictPrivateDirectorySync(dir, label);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  let pathStat: Stats | BigIntStats;
  try {
    pathStat = observation ? lstatSync(filePath, { bigint: true }) : lstatSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  assertReadablePrivateFileStat(pathStat, label, options.maxBytes);
  if (observation && Number(pathStat.nlink) !== 1) {
    throw privateWriteError(`refusing to observe ${label} with a hard link`, 'EMLINK');
  }

  let fd: number | null = null;
  try {
    fd = openSync(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const openedStat = observation ? fstatSync(fd, { bigint: true }) : fstatSync(fd);
    assertReadablePrivateFileStat(openedStat, label, options.maxBytes);
    if (observation) assertUnchangedObservation(observedIdentity(pathStat), observedIdentity(openedStat), label);

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
    const bytes = data.subarray(0, length);
    if (!observation) return bytes.toString('utf-8');

    const afterStat = fstatSync(fd, { bigint: true });
    assertReadablePrivateFileStat(afterStat, label, options.maxBytes);
    const identity = observedIdentity(afterStat);
    assertUnchangedObservation(observedIdentity(openedStat), identity, label);
    assertUnchangedObservation(identity, observedIdentity(lstatSync(filePath, { bigint: true })), label);
    if (length !== identity.size) {
      throw privateWriteError(`refusing to read changed ${label}`, 'ESTALE');
    }
    const afterParents = observeReadParents(filePath, observation.root, label);
    for (const [index, before] of parents.entries()) {
      const after = afterParents[index];
      if (!after || before.path !== after.path || before.identity.device !== after.identity.device
        || before.identity.inode !== after.identity.inode || before.identity.mode !== after.identity.mode
        || before.identity.uid !== after.identity.uid) {
        throw privateWriteError(`refusing to read ${label} through a changed ancestor`, 'ESTALE');
      }
    }
    return { bytes, rawSha256: createHash('sha256').update(bytes).digest('hex'), identity };
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

  // Whether the append will CREATE the file (new directory entry) or extend an
  // existing one. On creation — including post-rotation recreation — the file
  // fsync below flushes the data, but the directory entry that links the
  // filename to the inode is separate metadata; a crash between the two can
  // leave a named-but-unlinked inode, losing the whole forensic file. We fsync
  // the parent directory in that case. A plain append to an existing file does
  // not touch the directory entry, so the extra dir fsync is skipped there.
  const willCreate = !existsSync(filePath);

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

  if (willCreate) fsyncDirectory(dir);
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
