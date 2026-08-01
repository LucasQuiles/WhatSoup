import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type Stats,
} from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

const HEALTH_TOKEN_PREFIX = 'WHATSOUP_HEALTH_TOKEN=';
const CANONICAL_HEALTH_TOKEN_RE = /^[0-9a-f]{64}$/;
const CanonicalHealthTokenSchema = z.string().regex(CANONICAL_HEALTH_TOKEN_RE);
const PRIVATE_HEALTH_TOKEN_FILE_MODE = 0o600;
const MAX_CANONICAL_FILE_BYTES = Buffer.byteLength(HEALTH_TOKEN_PREFIX) + 64 + 1;

declare const canonicalHealthTokenBrand: unique symbol;
export type CanonicalHealthToken = string & {
  readonly [canonicalHealthTokenBrand]: true;
};

export class HealthTokenFileRejectedError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'HealthTokenFileRejectedError';
    this.code = code;
  }
}

function rejectHealthTokenFile(message: string, code = 'EINVAL'): never {
  throw new HealthTokenFileRejectedError(message, code);
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) {
    rejectHealthTokenFile('health token ownership cannot be validated on this platform', 'ENOTSUP');
  }
  return uid;
}

function assertPrivateTokenDirectory(stat: Stats, expectedUid: number): void {
  if (stat.isSymbolicLink()) {
    rejectHealthTokenFile('health token directory must be a real non-symlink directory', 'ELOOP');
  }
  if (!stat.isDirectory()) {
    rejectHealthTokenFile('health token directory must be a real directory');
  }
  if (stat.uid !== expectedUid) {
    rejectHealthTokenFile('health token directory must be owned by the current uid', 'EACCES');
  }
  if ((stat.mode & 0o022) !== 0) {
    rejectHealthTokenFile('health token directory must not be group- or world-writable', 'EACCES');
  }
}

function assertPrivateTokenFile(stat: Stats, expectedUid: number): void {
  if (stat.isSymbolicLink()) {
    rejectHealthTokenFile('health token file must be a regular non-symlink file', 'ELOOP');
  }
  if (!stat.isFile()) {
    rejectHealthTokenFile('health token file path is non-regular');
  }
  if (stat.uid !== expectedUid) {
    rejectHealthTokenFile('health token file must be owned by the current uid', 'EACCES');
  }
  if ((stat.mode & 0o7777) !== PRIVATE_HEALTH_TOKEN_FILE_MODE) {
    rejectHealthTokenFile('health token file must have mode 0600', 'EACCES');
  }
}

function assertSamePathIdentity(beforeOpen: Stats, opened: Stats, label: 'file' | 'directory'): void {
  if (beforeOpen.dev !== opened.dev || beforeOpen.ino !== opened.ino) {
    rejectHealthTokenFile(`health token ${label} changed while it was being opened`, 'ESTALE');
  }
}

function readBoundedUtf8(fd: number): string {
  const buffer = Buffer.alloc(MAX_CANONICAL_FILE_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const count = readSync(fd, buffer, offset, buffer.length - offset, null);
    if (count === 0) break;
    offset += count;
  }
  if (offset > MAX_CANONICAL_FILE_BYTES) {
    rejectHealthTokenFile('health token file must contain exactly one canonical assignment');
  }
  return buffer.subarray(0, offset).toString('utf8');
}

export function isCanonicalHealthToken(value: unknown): value is CanonicalHealthToken {
  // The schema infers plain `string`; the brand is conferred by this
  // predicate's signature, exactly as the previous typeof ladder did.
  return CanonicalHealthTokenSchema.safeParse(value).success;
}

export function parseCanonicalHealthTokenFile(contents: string): CanonicalHealthToken | null {
  const line = contents.endsWith('\n') ? contents.slice(0, -1) : contents;
  if (line.includes('\n') || !line.startsWith(HEALTH_TOKEN_PREFIX)) return null;

  const token = line.slice(HEALTH_TOKEN_PREFIX.length);
  return isCanonicalHealthToken(token) ? token : null;
}

/**
 * Read the transitional per-instance token file through a verified descriptor.
 * A missing file is the only absent case; every unsafe or malformed existing
 * path is rejected without including credential material in the error.
 */
export function readPrivateHealthTokenFileSync(filePath: string): CanonicalHealthToken | null {
  const expectedUid = currentUid();
  const tokenDir = dirname(filePath);
  const dirBefore = lstatSync(tokenDir);
  assertPrivateTokenDirectory(dirBefore, expectedUid);

  let fileBefore: Stats;
  try {
    fileBefore = lstatSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  assertPrivateTokenFile(fileBefore, expectedUid);

  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let fd: number | undefined;
  try {
    fd = openSync(filePath, flags);
    const opened = fstatSync(fd);
    assertPrivateTokenFile(opened, expectedUid);
    assertSamePathIdentity(fileBefore, opened, 'file');

    const dirAfter = lstatSync(tokenDir);
    assertPrivateTokenDirectory(dirAfter, expectedUid);
    assertSamePathIdentity(dirBefore, dirAfter, 'directory');

    if (opened.size > MAX_CANONICAL_FILE_BYTES) {
      rejectHealthTokenFile('health token file must contain exactly one canonical assignment');
    }
    const token = parseCanonicalHealthTokenFile(readBoundedUtf8(fd));
    if (token === null) {
      rejectHealthTokenFile('health token file must contain exactly one canonical assignment');
    }
    return token;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
