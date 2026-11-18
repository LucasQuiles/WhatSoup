/**
 * #3829: BSD file flags of an installed launchd plist. Node's fs.Stats does not
 * expose st_flags, so they are read with stat(1). The reader lives in its own
 * module so service-manager tests can replace it without a real stat call.
 */
import { execFileSync } from 'node:child_process';

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
