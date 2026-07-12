import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function physicalIdentityError(cause: unknown): Error {
  return new Error('Unable to determine physical directory identity', { cause });
}

/**
 * Compare existing directories by device/inode identity. A genuinely missing
 * child is provably distinct, but dangling links and unreadable ancestors are
 * ambiguous and throw so callers can fail closed before writing.
 */
export function isSamePhysicalDirectory(candidatePath: string, referencePath: string): boolean {
  let reference: fs.BigIntStats;
  try {
    reference = fs.statSync(path.resolve(referencePath), { bigint: true });
    if (!reference.isDirectory()) throw new Error('reference path is not a directory');
  } catch (err) {
    throw physicalIdentityError(err);
  }

  const candidate = path.resolve(candidatePath);
  try {
    const candidateStat = fs.statSync(candidate, { bigint: true });
    if (!candidateStat.isDirectory()) throw new Error('candidate path is not a directory');
    return candidateStat.dev === reference.dev && candidateStat.ino === reference.ino;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw physicalIdentityError(err);
    }

    let current = candidate;
    while (true) {
      try {
        fs.lstatSync(current);
      } catch (ancestorErr) {
        if ((ancestorErr as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw physicalIdentityError(ancestorErr);
        }
        const parent = path.dirname(current);
        if (parent === current) throw physicalIdentityError(err);
        current = parent;
        continue;
      }

      try {
        if (!fs.statSync(current, { bigint: true }).isDirectory()) {
          throw new Error('nearest existing path is not a directory');
        }
      } catch (ancestorErr) {
        throw physicalIdentityError(ancestorErr);
      }
      if (current === candidate) throw physicalIdentityError(err);
      return false;
    }
  }
}

export function hasUnsupportedTildePrefix(inputPath: string): boolean {
  const trimmed = inputPath.trim();
  return trimmed.startsWith('~') && trimmed !== '~' && !trimmed.startsWith('~/');
}

export function expandHomePath(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}
