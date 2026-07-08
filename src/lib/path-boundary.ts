import { realpathSync } from 'node:fs';

/**
 * Check whether a resolved filesystem path is within an allowed root.
 *
 * Both the resolved path and the allowedRoot are canonicalized via realpathSync
 * before comparison so this works correctly on macOS, where /var/folders is a
 * symlink to /private/var/folders (and the same for /tmp).
 *
 * Fail-closed: returns false when allowedRoot is undefined.
 */
export function isPathWithinAllowedRoot(
  resolvedPath: string,
  allowedRoot: string | undefined,
): boolean {
  if (!allowedRoot) return false;
  let canonicalAllowedRoot: string;
  try {
    canonicalAllowedRoot = realpathSync(allowedRoot);
  } catch {
    canonicalAllowedRoot = allowedRoot;
  }
  return (
    resolvedPath === canonicalAllowedRoot ||
    resolvedPath.startsWith(canonicalAllowedRoot + '/')
  );
}
