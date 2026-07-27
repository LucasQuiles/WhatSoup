import { realpathSync } from 'node:fs';

/**
 * Check whether an ALREADY-CANONICAL filesystem path is within an allowed root.
 *
 * Only `allowedRoot` is canonicalized here, via realpathSync — so that macOS
 * works correctly, where /var/folders is a symlink to /private/var/folders (and
 * the same for /tmp). **`resolvedPath` is compared exactly as supplied and is
 * NOT canonicalized**; the caller must realpath it first, which is what the
 * parameter name means.
 *
 * That distinction is load-bearing. Passing a merely `path.resolve`d value gives
 * a lexical check that a symlink defeats: the link passes containment while the
 * read that follows lands outside the root. See `mcp/tools/media.ts` and
 * `mcp/tools/status.ts` for the correct realpath-then-check shape, and
 * `fleet/static.ts` / `fleet/routes/data.ts` for variants that first canonicalize
 * as far as the path exists.
 *
 * (An earlier version of this docstring claimed BOTH operands were canonicalized.
 * They are not, and believing that is exactly how a caller ends up unconfined.)
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
