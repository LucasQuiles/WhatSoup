import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';

import { MAX_EXACT_SINGLE_BLOB_BYTES } from './input-limits.ts';

type Identity = { dev: number; ino: number };

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function readWorkingDocument(repoRoot: string, relativePath: string): Buffer | null {
  if (relativePath.startsWith('/') || relativePath.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('working document path is invalid');
  }
  const root = lstatSync(repoRoot);
  if (!root.isDirectory()) throw new Error('repository root must be a directory');
  const rootIdentity: Identity = { dev: root.dev, ino: root.ino };
  const rootFd = openSync(repoRoot, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const openedRoot = fstatSync(rootFd);
    if (!openedRoot.isDirectory() || !sameIdentity(rootIdentity, openedRoot)) {
      throw new Error('repository root changed before reading');
    }
    const parents: { path: string; identity: Identity }[] = [];
    const validateParents = () => {
      const observedRoot = lstatSync(repoRoot);
      if (!observedRoot.isDirectory() || !sameIdentity(rootIdentity, observedRoot)) {
        throw new Error('repository root changed while reading');
      }
      for (const parent of parents) {
        const observed = lstatSync(parent.path);
        if (!observed.isDirectory() || !sameIdentity(parent.identity, observed)) {
          throw new Error('working document parent changed while reading');
        }
      }
    };
    let path = repoRoot;
    const parts = relativePath.split('/');
    for (const [index, part] of parts.entries()) {
      path = resolve(path, part);
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (stat === undefined) {
        validateParents();
        return null;
      }
      if (index < parts.length - 1) {
        if (!stat.isDirectory()) throw new Error('working document parent must be a directory');
        parents.push({ path, identity: { dev: stat.dev, ino: stat.ino } });
        continue;
      }
      if (!stat.isFile() || (stat.mode & 0o111) !== 0) throw new Error('working document must be a regular non-executable file');
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        validateParents();
        const opened = fstatSync(fd);
        if (!opened.isFile() || !sameIdentity(stat, opened) || opened.mode !== stat.mode) {
          throw new Error('working document changed before reading');
        }
        if (opened.size > MAX_EXACT_SINGLE_BLOB_BYTES) throw new Error('working document exceeds byte limit');
        const bytes = Buffer.alloc(MAX_EXACT_SINGLE_BLOB_BYTES + 1);
        let total = 0;
        while (total < bytes.length) {
          const count = readSync(fd, bytes, total, bytes.length - total, total);
          if (count === 0) break;
          total += count;
        }
        if (total > MAX_EXACT_SINGLE_BLOB_BYTES) throw new Error('working document exceeds byte limit');
        const after = fstatSync(fd);
        if (total !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
          throw new Error('working document changed while reading');
        }
        validateParents();
        return bytes.subarray(0, total);
      } finally {
        closeSync(fd);
      }
    }
    return null;
  } finally {
    closeSync(rootFd);
  }
}

function main(): number {
  const [repoRoot, relativePath] = process.argv.slice(2);
  if (typeof repoRoot !== 'string' || typeof relativePath !== 'string' || process.argv.length !== 4) return 2;
  try {
    const bytes = readWorkingDocument(repoRoot, relativePath);
    writeSync(1, bytes === null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), bytes]));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'working document reader failed';
    const diagnostic = message.includes('parent changed')
      ? 'working document parent changed'
      : message.includes('repository root')
        ? 'repository root changed'
        : message.includes('deadline')
          ? 'working document reader deadline elapsed'
          : 'working document reader failed';
    writeSync(2, `${diagnostic}\n`);
    return 2;
  }
}

process.exit(main());
