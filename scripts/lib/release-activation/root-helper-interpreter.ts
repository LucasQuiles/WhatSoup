/**
 * The root plist replacement helper (protected_plist.py) as activation runs it.
 *
 * The helper runs as root through `sudo -n`, from a fixed root-owned install
 * that the owner's install step (install_root_helper.py) copies from a reviewed
 * clone. root-helper.json is the one record of that install path and of the
 * helper's sha256: the install step verifies the bytes it installs against it,
 * and activation compares the installed helper with it before calling. That
 * comparison is a version check, not a security control: the security comes
 * from the root-owned install and the one exact sudoers rule
 * (docs/runbooks/release-deployment.md).
 *
 * A sudoers rule matches each command by its absolute path, and a PATH lookup
 * would let a user-writable directory choose what runs as root, so the binaries
 * stay fixed absolute paths. This module is the one allowlisted home for them
 * under portability.no-hardcoded-platform-binaries; callers import them.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const ROOT_HELPER_SUDO = '/usr/bin/sudo';
export const ROOT_HELPER_PYTHON = '/usr/bin/python3';
/** protected_plist.py's exit status when a failed replacement could not restore and confirm protection. */
export const ROOT_HELPER_RECOVERY_INCOMPLETE_EXIT = 3;
/** protected_plist.py's exit status when it refused or failed with the plist as found, protection unchanged. */
export const ROOT_HELPER_FAILED_AS_FOUND_EXIT = 2;
export const ROOT_HELPER_OUTDATED =
  'root plist helper missing or outdated; run the install step (docs/runbooks/release-deployment.md)';

export interface RootHelperPin {
  path: string;
  sha256: string;
}

const PIN_URL = new URL('./root-helper.json', import.meta.url);
const INSTALL_PATH = /^\/Library\/PrivilegedHelperTools\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** root-helper.json of this tree; throws when it is unreadable or malformed. */
export function readRootHelperPin(): RootHelperPin {
  const pin: unknown = JSON.parse(readFileSync(PIN_URL, 'utf8'));
  if (typeof pin !== 'object' || pin === null || Object.keys(pin).sort().join() !== 'path,sha256') {
    throw new Error('root-helper.json must hold exactly path and sha256');
  }
  const { path, sha256 } = pin as Record<string, unknown>;
  if (typeof path !== 'string' || !INSTALL_PATH.test(path) || typeof sha256 !== 'string' || !SHA256.test(sha256)) {
    throw new Error('root-helper.json must hold a PrivilegedHelperTools path and a sha256');
  }
  return { path, sha256 };
}

/**
 * The sudo argv: exactly the one sudoers rule, `-n` so a missing rule fails instead of prompting.
 * `-I` keeps the caller's environment, user site and script folder off the import path; `-S` keeps
 * site-packages and .pth files off it; `-B` writes no bytecode. sudo matches the argument order exactly.
 */
export function rootHelperArgs(pin: RootHelperPin): readonly string[] {
  return ['-n', ROOT_HELPER_PYTHON, '-I', '-S', '-B', pin.path];
}

/** The installed helper's bytes, or null when it cannot be read. */
export function readInstalledRootHelper(file: string): Buffer | null {
  try {
    return readFileSync(file);
  } catch {
    return null;
  }
}

/** Null when the installed bytes are the pinned helper; otherwise the operator message. */
export function rootHelperFailure(pin: RootHelperPin, installed: Buffer | null): string | null {
  if (installed === null) return ROOT_HELPER_OUTDATED;
  return createHash('sha256').update(installed).digest('hex') === pin.sha256 ? null : ROOT_HELPER_OUTDATED;
}
