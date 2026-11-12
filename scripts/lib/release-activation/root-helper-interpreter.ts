/**
 * Exact binaries for the root plist replacement helper (protected_plist.py).
 *
 * The helper runs as root through `sudo -n`. A sudoers rule matches each
 * command by its absolute path, and a PATH lookup would let a user-writable
 * directory choose what runs as root, so these stay fixed absolute paths.
 * This module is the one allowlisted home for them under
 * portability.no-hardcoded-platform-binaries; callers import the constants.
 */
export const ROOT_HELPER_SUDO = '/usr/bin/sudo';
export const ROOT_HELPER_PYTHON = '/usr/bin/python3';
