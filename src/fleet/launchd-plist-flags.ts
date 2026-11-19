/**
 * #3829: removal checks for an installed launchd plist: the BSD file flags of the
 * plist and of its folder, and whether this process can write that folder. Node's
 * fs.Stats does not expose st_flags, so they are read with stat(1). The checks
 * live in their own module so service-manager tests can replace them without a
 * real stat or access call.
 */
import { execFileSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';

/** stat(1) reads one inode; anything slower is treated as unreadable. */
const STAT_TIMEOUT_MS = 5_000;

/**
 * The flags word of `filePath` itself. Without `-L`, stat(1) reports a final
 * symlink rather than its target, which is the name unlink(2) removes. Throws
 * when stat(1) fails or prints anything but a decimal number, so a caller can
 * refuse instead of guessing.
 */
export function readFileFlags(filePath: string): number {
  const output = execFileSync('/usr/bin/stat', ['-f', '%f', filePath], {
    encoding: 'utf8',
    timeout: STAT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (!/^\d+$/u.test(output)) throw new Error(`stat printed no file flags for ${filePath}`);
  return Number(output);
}

/**
 * Whether this process may remove an entry of `folderPath`: unlink(2) needs
 * write and search permission on the folder that holds the name. access(2)
 * answers for this process's own credentials. Any error counts as not writable,
 * so a caller refuses instead of guessing.
 */
export function canWriteFolder(folderPath: string): boolean {
  try {
    accessSync(folderPath, constants.W_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
