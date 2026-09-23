// src/lib/private-fs-isolated.ts
// Opt-in hardened private-file publication (#2732).
//
// The default writers in ./private-fs.ts run in-process and stay the right
// choice for hot paths. The writers here delegate the temp write, fsync and
// publishing rename/link to an isolated bounded child pinned to the target
// directory's identity, so an ancestor-directory exchange mid-write fails
// closed (ESTALE) instead of writing through a decoy. Each call costs two
// short-lived child processes and blocks the calling thread until they exit
// (bounded by a 10 s supervisor deadline and a 15 s outer timeout).
//
// This module is deliberately separate from ./private-fs.ts: deployers that
// ship only private-fs.ts (the bot-errors runtime) do not pick up the child
// sources or their dependencies.
//
// Every error thrown here carries `publication`, read with
// privatePublicationStateOf():
//   'not-published' — the target was provably not replaced or created;
//   'published'     — the child reported the publication, a later step failed;
//   'unknown'       — no trustworthy receipt (timeout, killed, bad transport).

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, unlinkSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { assertWritablePrivateFileSync, forceEnsurePrivateDirectorySync, fsyncDirectory } from './private-fs.ts';
import { SIGNAL } from './signals.ts';

export type PrivatePublicationState = 'not-published' | 'published' | 'unknown';

export interface IsolatedPrivateWriteError extends NodeJS.ErrnoException {
  publication: PrivatePublicationState;
}

const PUBLICATION_STATES: ReadonlySet<string> = new Set(['not-published', 'published', 'unknown']);

/**
 * Publication state of an error thrown by an isolated writer. Anything that did
 * not come from these writers reads as 'unknown', the conservative answer.
 */
export function privatePublicationStateOf(error: unknown): PrivatePublicationState {
  const state = (error as { publication?: unknown } | null | undefined)?.publication;
  return state === 'not-published' || state === 'published' ? state : 'unknown';
}

type DirectoryFsyncMode = 'best-effort' | 'required';
type PublicationMode = 'replace' | 'create';

/**
 * Atomically replace a private file with a mode-0600 payload through an
 * isolated child. Same signature and atomic-replace contract as
 * writeAtomicPrivateFileSync in ./private-fs.ts.
 *
 * The parent canonicalizes the target directory once (so platform symlinks
 * already in the path, for example macOS `/var` -> `/private/var`, stay
 * usable), identity-binds every ancestor of that canonical path, and delegates
 * the temp write, file fsync, rename and parent-directory fsync to the child.
 * The child pins its working directory to the bound dev/ino and re-validates it
 * and the absolute bound path before each mutation. The target directory itself
 * must be a real directory.
 */
export function writeAtomicPrivateFileIsolatedSync(
  filePath: string,
  data: string | Buffer,
  label = 'private file',
  directoryFsync: DirectoryFsyncMode = 'best-effort',
): void {
  publishIsolated(filePath, data, label, directoryFsync, 'replace');
}

/**
 * Exclusively create a private file (mode 0600) through an isolated child:
 * the fully written and fsynced temp is hard-linked onto the target, which
 * fails EEXIST atomically when the target already exists, so an existing file
 * is never replaced. The temp name is then removed and the directory fsynced.
 */
export function createPrivateFileIsolatedSync(
  filePath: string,
  data: string | Buffer,
  label = 'private file',
  directoryFsync: DirectoryFsyncMode = 'best-effort',
): void {
  publishIsolated(filePath, data, label, directoryFsync, 'create');
}

const MAX_HEADER_BYTES = 2048;
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const CHILD_DEADLINE_MS = 10_000;
const OUTER_TIMEOUT_MS = 15_000;
const CHILD_ERROR_CODES: ReadonlySet<string> = new Set([
  'EACCES', 'EDQUOT', 'EEXIST', 'EFBIG', 'EINVAL', 'EIO', 'ELOOP', 'ENAMETOOLONG',
  'ENOSPC', 'EPERM', 'EROFS', 'ESTALE',
]);

type BoundedProcessFailureKind =
  | 'timeout'
  | 'cleanup-uncertain'
  | 'output-limit'
  | 'unexpected-signal'
  | 'transport-invalid';

const BOUNDED_PROCESS_FAILURES: Record<BoundedProcessFailureKind, { message: string; code: string }> = {
  timeout: { message: 'owned child exceeded its execution deadline', code: 'ETIMEDOUT' },
  'cleanup-uncertain': { message: 'owned child process-group or temp cleanup is uncertain', code: 'EOWNERDEAD' },
  'output-limit': { message: 'owned child exceeded its bounded output limit', code: 'EFBIG' },
  'unexpected-signal': { message: 'owned child terminated from an unexpected signal', code: 'EINTR' },
  'transport-invalid': { message: 'owned child supervisor receipt is invalid', code: 'EPROTO' },
};

class BoundedProcessError extends Error implements IsolatedPrivateWriteError {
  readonly kind: BoundedProcessFailureKind;
  readonly code: string;
  readonly publication: PrivatePublicationState;

  constructor(kind: BoundedProcessFailureKind, publication: PrivatePublicationState) {
    const contract = BOUNDED_PROCESS_FAILURES[kind];
    super(contract.message);
    this.name = 'BoundedProcessError';
    this.kind = kind;
    this.code = contract.code;
    this.publication = publication;
  }
}

function boundedProcessFailure(kind: BoundedProcessFailureKind, publication: PrivatePublicationState): never {
  throw new BoundedProcessError(kind, publication);
}

function publicationError(message: string, code: string, publication: PrivatePublicationState): IsolatedPrivateWriteError {
  const error = new Error(message) as IsolatedPrivateWriteError;
  error.code = code;
  error.publication = publication;
  return error;
}

/** An error without a publication state; the calling phase attaches one. */
function plainError(message: string, code: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/** Attach a publication state to an error that does not carry one yet. */
function withPublicationState(error: unknown, publication: PrivatePublicationState): unknown {
  if (error !== null && typeof error === 'object') {
    if (!PUBLICATION_STATES.has(String((error as { publication?: unknown }).publication))) {
      (error as { publication?: PrivatePublicationState }).publication = publication;
    }
    return error;
  }
  return publicationError(String(error), 'EIO', publication);
}

interface DirectoryIdentity {
  path: string;
  dev: number;
  ino: number;
}

interface PreparedPublication {
  boundDir: string;
  boundTarget: string;
  tempName: string;
  boundAncestors: DirectoryIdentity[];
  payload: Buffer;
  payloadSha256: string;
  frame: Buffer;
}

function preparePublication(
  filePath: string,
  data: string | Buffer,
  label: string,
  directoryFsync: DirectoryFsyncMode,
  mode: PublicationMode,
): PreparedPublication {
  const dir = dirname(filePath);
  forceEnsurePrivateDirectorySync(dir, `${label} directory`);
  assertWritablePrivateFileSync(filePath, label);
  const boundDir = realpathSync(dir);
  const boundAncestors = bindDirectoryAncestorIdentitiesSync(boundDir, label);
  assertDirectoryAncestorIdentitiesSync(boundAncestors, label);
  const directoryIdentity = boundAncestors.at(-1);
  if (!directoryIdentity || directoryIdentity.path !== boundDir) {
    throw publicationError('isolated publication directory could not be bound', 'ESTALE', 'not-published');
  }
  const targetName = basename(filePath);
  if (targetName !== filePath.slice(filePath.length - targetName.length) || targetName === '.' || targetName === '..') {
    throw publicationError(`refusing to write ${label} to an invalid target name`, 'EINVAL', 'not-published');
  }
  const tempName = `.${targetName}.${process.pid}.${randomUUID()}.tmp`;
  const payload = typeof data === 'string' ? Buffer.from(data) : data;
  if (payload.byteLength > MAX_PAYLOAD_BYTES) {
    throw publicationError(`refusing to write ${label} above maximum size`, 'EFBIG', 'not-published');
  }
  const payloadSha256 = createHash('sha256').update(payload).digest('hex');
  const header = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    operation: mode === 'create' ? 'create-publish' : 'replace-publish',
    directoryPath: directoryIdentity.path,
    directoryDev: String(directoryIdentity.dev),
    directoryIno: String(directoryIdentity.ino),
    directoryFsync,
    targetName,
    tempName,
    payloadSize: payload.byteLength,
    payloadSha256,
  }));
  if (header.byteLength > MAX_HEADER_BYTES) {
    throw publicationError('isolated publication control frame is invalid', 'EINVAL', 'not-published');
  }
  const frame = Buffer.allocUnsafe(4 + header.byteLength + payload.byteLength);
  frame.writeUInt32BE(header.byteLength, 0);
  header.copy(frame, 4);
  payload.copy(frame, 4 + header.byteLength);
  // The mutations run in the child, so the parent asserts the target once more
  // immediately before handing off; the child re-asserts it, relative to its
  // bound working directory, right before publication.
  assertWritablePrivateFileSync(filePath, label);
  return {
    boundDir,
    boundTarget: join(boundDir, targetName),
    tempName,
    boundAncestors,
    payload,
    payloadSha256,
    frame,
  };
}

function publishIsolated(
  filePath: string,
  data: string | Buffer,
  label: string,
  directoryFsync: DirectoryFsyncMode,
  mode: PublicationMode,
): void {
  let prepared: PreparedPublication;
  try {
    prepared = preparePublication(filePath, data, label, directoryFsync, mode);
  } catch (error) {
    throw withPublicationState(error, 'not-published');
  }

  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(
      process.execPath,
      [
        '--input-type=module', '--eval', BOUNDED_PROCESS_SUPERVISOR_SOURCE,
        ISOLATED_PUBLISH_CHILD_SOURCE, '4096', String(CHILD_DEADLINE_MS),
      ],
      {
        cwd: prepared.boundDir,
        input: prepared.frame,
        env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        timeout: OUTER_TIMEOUT_MS,
        killSignal: SIGNAL.KILL,
        maxBuffer: 4096,
        windowsHide: true,
      },
    );
  } catch {
    boundedProcessFailure('cleanup-uncertain', 'unknown');
  }

  // Process cleanup runs before anything else can throw, so no failure path
  // leaves the child's process group behind.
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    requireBoundedOuterCleanup(result);
    requireOrphanTempCleanup(prepared);
    if (code === 'ETIMEDOUT') boundedProcessFailure('timeout', 'unknown');
    if (code === 'ENOBUFS') boundedProcessFailure('output-limit', 'unknown');
    boundedProcessFailure('transport-invalid', 'unknown');
  }
  if (result.status === 71 || result.status === 72) {
    // The supervisor itself reaped the child's group before exiting with these
    // codes; signalling the group id again could hit a reused id.
    requireOrphanTempCleanup(prepared);
    boundedProcessFailure(result.status === 71 ? 'timeout' : 'output-limit', 'unknown');
  }
  if (result.status !== 0 || result.signal !== null) {
    requireBoundedOuterCleanup(result);
    requireOrphanTempCleanup(prepared);
    boundedProcessFailure(result.signal === null ? 'transport-invalid' : 'unexpected-signal', 'unknown');
  }

  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : null;
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : null;
  const transportValid = stdout !== null && stderr !== null && stderr.byteLength === 0;
  const success = transportValid && stdout !== null ? parseSuccessReceipt(stdout, prepared) : null;
  const failure = transportValid && stdout !== null && success === null ? parseErrorReceipt(stdout) : null;
  const childState: PrivatePublicationState = success !== null
    ? 'published'
    : failure !== null
      ? (failure.published ? 'published' : 'not-published')
      : 'unknown';

  try {
    assertDirectoryAncestorIdentitiesSync(prepared.boundAncestors, label);
  } catch (error) {
    throw withPublicationState(error, childState);
  }

  if (success !== null) {
    verifyPublishedTarget(prepared, success, label);
    return;
  }
  if (failure === null) {
    throw publicationError(`isolated ${label} publication returned no valid receipt`, 'EIO', 'unknown');
  }
  if (failure.cleanup === 'uncertain') boundedProcessFailure('cleanup-uncertain', childState);
  const code = CHILD_ERROR_CODES.has(failure.code) ? failure.code : 'EIO';
  let message = `isolated ${label} publication failed`;
  if (code === 'EEXIST') {
    message = failure.stage === 'publish'
      ? 'refusing to create private file because it already exists'
      : `isolated ${label} publication failed: temporary file already exists`;
  }
  throw publicationError(message, code, childState);
}

interface SuccessReceipt {
  dev: string;
  ino: string;
  sizeBytes: number;
  payloadSha256: string;
}

function parseSuccessReceipt(stdout: Buffer, prepared: PreparedPublication): SuccessReceipt | null {
  if (stdout.byteLength > 512 || stdout.at(-1) !== 0x0a) return null;
  let receipt: { schemaVersion?: unknown; status?: unknown; published?: unknown };
  try {
    receipt = JSON.parse(stdout.toString('utf8')) as typeof receipt;
  } catch {
    // intentional: malformed child receipt yields null and the caller refuses the publication — fail-closed
    return null;
  }
  const published = receipt.published as SuccessReceipt | null | undefined;
  if (
    receipt.schemaVersion !== 1
    || receipt.status !== 'ok'
    || published === null
    || typeof published !== 'object'
    || JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(['published', 'schemaVersion', 'status'])
    || JSON.stringify(Object.keys(published).sort()) !== JSON.stringify(['dev', 'ino', 'payloadSha256', 'sizeBytes'])
    || published.sizeBytes !== prepared.payload.byteLength
    || published.payloadSha256 !== prepared.payloadSha256
    || !stdout.equals(Buffer.from(`${JSON.stringify({ schemaVersion: 1, status: 'ok', published })}\n`))
  ) return null;
  return published;
}

interface ErrorReceipt {
  code: string;
  stage: 'prepare' | 'temp' | 'publish' | 'post';
  cleanup: 'complete' | 'uncertain';
  published: boolean;
}

const ERROR_RECEIPT_PATTERN =
  /^\{"schemaVersion":1,"status":"error","code":"([A-Z0-9]+)","stage":"(prepare|temp|publish|post)","cleanup":"(complete|uncertain)","published":(true|false)\}\n$/;

function parseErrorReceipt(stdout: Buffer): ErrorReceipt | null {
  if (stdout.byteLength > 256) return null;
  const match = ERROR_RECEIPT_PATTERN.exec(stdout.toString('utf8'));
  if (match === null) return null;
  return {
    code: match[1],
    stage: match[2] as ErrorReceipt['stage'],
    cleanup: match[3] as ErrorReceipt['cleanup'],
    published: match[4] === 'true',
  };
}

/** Parent-side read-back of what the child reports it published. */
function verifyPublishedTarget(prepared: PreparedPublication, receipt: SuccessReceipt, label: string): void {
  const invalid = () => publicationError(`isolated ${label} publication result is invalid`, 'EIO', 'published');
  let published: Stats;
  try {
    published = lstatSync(prepared.boundTarget);
  } catch (error) {
    throw withPublicationState(error, 'published');
  }
  if (
    published.isSymbolicLink()
    || !published.isFile()
    || published.nlink !== 1
    || (published.mode & 0o777) !== 0o600
    || String(published.dev) !== receipt.dev
    || String(published.ino) !== receipt.ino
    || published.size !== prepared.payload.byteLength
  ) throw invalid();
  let descriptor: number | null = null;
  try {
    descriptor = openSync(prepared.boundTarget, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || (opened.mode & 0o777) !== 0o600
      || opened.dev !== published.dev
      || opened.ino !== published.ino
      || opened.size !== prepared.payload.byteLength
    ) throw invalid();
    const readback = Buffer.alloc(prepared.payload.byteLength + 1);
    let length = 0;
    while (length < readback.byteLength) {
      const count = readSync(descriptor, readback, length, readback.byteLength - length, null);
      if (count === 0) break;
      length += count;
    }
    const finalStat = fstatSync(descriptor);
    if (
      length !== prepared.payload.byteLength
      || !readback.subarray(0, length).equals(prepared.payload)
      || !finalStat.isFile()
      || finalStat.nlink !== 1
      || finalStat.dev !== opened.dev
      || finalStat.ino !== opened.ino
      || finalStat.size !== opened.size
    ) throw invalid();
  } catch (error) {
    throw withPublicationState(error, 'published');
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  try {
    assertDirectoryAncestorIdentitiesSync(prepared.boundAncestors, label);
  } catch (error) {
    throw withPublicationState(error, 'published');
  }
}

/**
 * After the child was killed (it may have been blocked in a synchronous fsync
 * and never run its own SIGTERM cleanup), remove a leftover temp. The child
 * never reports the temp's inode on this path, so the guard is: ancestors
 * unchanged, the collision-resistant name this call chose, a regular
 * single-link file owned by this user. Anything else is left in place and the
 * failure is reported as cleanup-uncertain.
 */
function requireOrphanTempCleanup(prepared: PreparedPublication): void {
  if (!removeOrphanTempSync(prepared)) boundedProcessFailure('cleanup-uncertain', 'unknown');
}

function removeOrphanTempSync(prepared: PreparedPublication): boolean {
  const tempPath = join(prepared.boundDir, prepared.tempName);
  try {
    assertDirectoryAncestorIdentitiesSync(prepared.boundAncestors, 'orphan temp');
    let stat: Stats;
    try {
      stat = lstatSync(tempPath);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (uid !== null && stat.uid !== uid)) {
      return false;
    }
    unlinkSync(tempPath);
    fsyncDirectory(prepared.boundDir);
    return true;
  } catch {
    // intentional: any failure to prove the temp is gone is reported as cleanup-uncertain by the caller
    return false;
  }
}

function parseBoundedProcessControl(value: unknown, supervisorPid: number | undefined): number | null {
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

const REAP_WAIT_CELL = new Int32Array(new SharedArrayBuffer(4));

/**
 * Kill and wait out the child's detached process group after its supervisor
 * died. The group is probed first: when it is already gone nothing is
 * signalled, so a group id that has since been reused is left alone (a residual
 * window remains between the probe and the kill). Waiting uses the monotonic
 * clock and sleeps between probes instead of spinning.
 */
function reapBoundedProcessGroup(processGroupId: number): boolean {
  if (process.platform === 'win32') return false;
  const groupGone = (): boolean | null => {
    try {
      process.kill(-processGroupId, 0);
      return false;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return true;
      return code === 'EPERM' ? false : null;
    }
  };
  const initial = groupGone();
  if (initial === true) return true;
  if (initial === null) return false;
  try {
    process.kill(-processGroupId, SIGNAL.KILL);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
  const deadline = performance.now() + 2_000;
  do {
    const gone = groupGone();
    if (gone === true) return true;
    if (gone === null) return false;
    Atomics.wait(REAP_WAIT_CELL, 0, 0, 10);
  } while (performance.now() < deadline);
  return false;
}

function requireBoundedOuterCleanup(result: ReturnType<typeof spawnSync>): void {
  const control = Array.isArray(result.output) ? result.output[3] : null;
  const processGroupId = parseBoundedProcessControl(control, result.pid);
  if (processGroupId === null || !reapBoundedProcessGroup(processGroupId)) {
    boundedProcessFailure('cleanup-uncertain', 'unknown');
  }
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
      throw plainError(`refusing to use ${label} through symlinked directory ancestor`, 'ELOOP');
    }
    if (!stat.isDirectory()) {
      throw plainError(`refusing to use ${label} through non-directory ancestor`, 'EINVAL');
    }
    identities.push({ path: current, dev: stat.dev, ino: stat.ino });
  }
  return identities;
}

function assertDirectoryAncestorIdentitiesSync(identities: readonly DirectoryIdentity[], label: string): void {
  for (const identity of identities) {
    let stat: Stats;
    try {
      stat = lstatSync(identity.path);
    } catch {
      throw plainError(`refusing to use ${label} after directory ancestor identity changed`, 'ESTALE');
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== identity.dev || stat.ino !== identity.ino) {
      throw plainError(`refusing to use ${label} after directory ancestor identity changed`, 'ESTALE');
    }
  }
}

// Generic bounded supervisor (ES module, evaluated with --input-type=module):
// runs `childSource` (argv[1]) in its own process group with a capture limit
// (argv[2]) and a deadline (argv[3]), relays the child's stdout/stderr only on a
// clean exit, and reports the child's process group id on fd 3 so the parent
// can reap it if the supervisor itself is killed by the outer spawnSync
// timeout. Exit 70 = supervision failure, 71 = deadline, 72 = output limit;
// on 71/72 the supervisor has already reaped the group.
const BOUNDED_PROCESS_SUPERVISOR_SOURCE = String.raw`
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const MAX_CAPTURE_BYTES = Number(process.argv[2]);
const DEADLINE_MS = Number(process.argv[3]);
const GRACE_MS = 1000;
const SETTLE_MS = 750;
const POLL_MS = 10;
const MAX_FRAME_BYTES = ${4 + MAX_HEADER_BYTES + MAX_PAYLOAD_BYTES};
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
    // Monotonic by design: the grace/settle deadline measures elapsed time.
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
  child = spawn(process.execPath, ['--input-type=module', '--eval', childSource], {
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

// Publishing child (ES module). Replace mode renames the temp over the target;
// create mode hard-links it (atomic EEXIST when the target exists) and then
// removes the temp name. Every error receipt names the stage that failed and
// whether the target had already been published.
const ISOLATED_PUBLISH_CHILD_SOURCE = String.raw`
import fs from 'node:fs';
import crypto from 'node:crypto';
const reply = (value) => process.stdout.write(JSON.stringify(value) + '\n');
let descriptor = null;
let directoryDescriptor = null;
let control = null;
let directoryValidated = false;
let tempCreated = false;
let tempIdentity = null;
let stage = 'prepare';
let published = false;
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
const fsyncDirectory = (required) => {
  if (directoryDescriptor === null) directoryDescriptor = openBoundDirectory();
  if (required) fs.fsyncSync(directoryDescriptor);
  else { try { fs.fsyncSync(directoryDescriptor); } catch {} }
};
const cleanupOwnedTemp = () => {
  // After a rename (replace) or the temp unlink (create) the temp name no
  // longer belongs to this child; there is nothing to clean up.
  if (!tempCreated) return;
  if (!directoryValidated || !tempIdentity || !control || typeof control.tempName !== 'string') return;
  validateCwdIdentity();
  let temp;
  try { temp = fs.lstatSync(control.tempName); } catch (error) {
    if (error && error.code === 'ENOENT') {
      fsyncDirectory(true);
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
  fsyncDirectory(true);
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
  if (frame.byteLength < 4) throw codedError('invalid frame', 'EINVAL');
  const headerSize = frame.readUInt32BE(0);
  if (headerSize < 2 || headerSize > ${MAX_HEADER_BYTES} || frame.byteLength < 4 + headerSize) {
    throw codedError('invalid frame', 'EINVAL');
  }
  try { control = JSON.parse(frame.subarray(4, 4 + headerSize).toString('utf8')); } catch {
    throw codedError('invalid frame', 'EINVAL');
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
    || (control.operation !== 'replace-publish' && control.operation !== 'create-publish')
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
    || control.payloadSize > ${MAX_PAYLOAD_BYTES}
    || payload.byteLength !== control.payloadSize
    || !/^[0-9a-f]{64}$/.test(control.payloadSha256)
    || crypto.createHash('sha256').update(payload).digest('hex') !== control.payloadSha256
  ) throw codedError('invalid child input', 'EINVAL');
  validateBoundDirectory();
  stage = 'temp';
  descriptor = fs.openSync(
    control.tempName,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    0o600,
  );
  tempCreated = true;
  const opened = fs.fstatSync(descriptor);
  if (!opened.isFile() || opened.nlink !== 1) throw codedError('invalid temp', 'EINVAL');
  tempIdentity = { dev: String(opened.dev), ino: String(opened.ino) };
  fs.fchmodSync(descriptor, 0o600);
  fs.writeFileSync(descriptor, payload);
  fs.fchmodSync(descriptor, 0o600);
  fs.fsyncSync(descriptor);
  fs.closeSync(descriptor);
  descriptor = null;
  stage = 'publish';
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
  if (control.operation === 'create-publish') {
    if (targetStat !== null) throw codedError('target exists', 'EEXIST');
    fs.linkSync(control.tempName, control.targetName);
    published = true;
    stage = 'post';
    fsyncDirectory(true);
    fs.unlinkSync(control.tempName);
    tempCreated = false;
    fsyncDirectory(control.directoryFsync === 'required');
  } else {
    fs.renameSync(control.tempName, control.targetName);
    published = true;
    tempCreated = false;
    stage = 'post';
    fsyncDirectory(control.directoryFsync === 'required');
  }
  fs.closeSync(directoryDescriptor);
  directoryDescriptor = null;
  const result = fs.lstatSync(control.targetName);
  if (!result.isFile() || result.isSymbolicLink() || result.nlink !== 1 || (result.mode & 0o777) !== 0o600) {
    throw codedError('invalid result', 'EIO');
  }
  reply({
    schemaVersion: 1,
    status: 'ok',
    published: {
      dev: String(result.dev),
      ino: String(result.ino),
      sizeBytes: result.size,
      payloadSha256: crypto.createHash('sha256').update(payload).digest('hex'),
    },
  });
} catch (caught) {
  if (descriptor !== null) { try { fs.closeSync(descriptor); } catch {} descriptor = null; }
  let cleanupFailed = tempCreated && tempIdentity === null;
  try { cleanupOwnedTemp(); } catch { cleanupFailed = true; }
  closeOwnedDescriptors();
  const allowed = new Set([
    'EACCES', 'EDQUOT', 'EEXIST', 'EFBIG', 'EINVAL', 'EIO', 'ELOOP', 'ENAMETOOLONG',
    'ENOSPC', 'EPERM', 'EROFS', 'ESTALE',
  ]);
  const code = allowed.has(caught && caught.code) ? caught.code : 'EIO';
  reply({
    schemaVersion: 1,
    status: 'error',
    code,
    stage,
    cleanup: cleanupFailed ? 'uncertain' : 'complete',
    published,
  });
}
`;
