/**
 * Physical (kernel-equivalent) home confinement for operator-supplied paths.
 *
 * One module because the same rule is enforced at two very different layers —
 * API admission (src/fleet/routes/ops.ts) and plist render admission
 * (src/fleet/platform.ts) — and when they were near-duplicate code a repair to
 * one silently missed the other. That is the defect class this module exists to
 * end, so new call sites belong here rather than in a private copy.
 *
 * Dependency-light: Node builtins only.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Does a `path.relative()` result step OUT of the parent directory?
 *
 * A bare `relative.startsWith('..')` also matches a legitimate entry whose own
 * name begins with dots (`..config` relativises to `..config`, not
 * `../config`), so it over-rejected real paths. Only a `..` COMPONENT escapes.
 * An absolute result means the two paths share no root, which is always an
 * escape.
 */
export function relativePathEscapes(relative: string): boolean {
  return relative === '..'
    || relative.startsWith('..' + path.sep)
    || path.isAbsolute(relative);
}

export function pathIsInsideDirectory(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relativePathEscapes(relative);
}

export function pathIsAtOrInsideDirectory(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || !relativePathEscapes(relative);
}

/**
 * Is nothing at all at this path? A DANGLING symlink is NOT absent — something
 * is there, it just does not resolve. `lstat` separates the two without
 * following the link. Same distinction as `isTrulyAbsent` in
 * src/fleet/launchd-render-options.ts.
 */
export function nothingExistsAt(targetPath: string): boolean {
  try {
    fs.lstatSync(targetPath);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/**
 * Make a path absolute WITHOUT normalising it.
 *
 * `path.resolve` would collapse the `..` these checks exist to catch, so the
 * raw spelling is preserved by concatenation instead.
 */
export function rawAbsolutePath(inputPath: string, cwd: string = process.cwd()): string {
  return path.isAbsolute(inputPath) ? inputPath : `${cwd}${path.sep}${inputPath}`;
}

/**
 * PHYSICAL resolution of the longest prefix of `targetPath` that exists,
 * REFUSING any segment that exists but does not resolve.
 *
 * Two bypasses motivate this, both invisible to lexical checks:
 *
 * 1. `..` AFTER a symlink. `path.resolve` collapses `..` textually, so
 *    `<home>/link/../x` with `link -> /outside` reads as `<home>/x`, while the
 *    kernel resolves `..` against the link TARGET and lands outside home.
 * 2. A DANGLING symlink with no traversal syntax at all. The previous walk
 *    treated a dangling link as absent and climbed past it to an in-home
 *    ancestor, so the path was admitted and whoever could later create the link
 *    target chose where it pointed. Here raw === resolved, so a
 *    raw-versus-resolved comparison never fires.
 *
 * The distinction that closes (2) without breaking ordinary use is ABSENT
 * versus PRESENT-BUT-UNRESOLVABLE. Walking up past a genuinely absent segment
 * is safe and necessary — callers legitimately name directories that do not
 * exist yet, and an agent's default workspace is several such segments deep.
 * Walking past a segment that EXISTS and fails to resolve is the bypass, so
 * that is refused. `lstat` separates the two without following the link.
 *
 * A tempting stricter rule, "only the final leaf may be absent", was measured
 * and rejected: it refuses the default agent workspace
 * (`~/.local/share/<...>/instances/<name>/workspace`, created after
 * validation) and broke 20 existing tests. It buys nothing, because an absent
 * segment is not an escape vector until something is created there, and that is
 * equally true of the leaf.
 *
 * `fs.realpathSync.native` (libc realpath(3)) is load-bearing and must not be
 * swapped back to `fs.realpathSync`, which calls `path.resolve()` first and so
 * collapses `..` before walking symlinks. The two bindings agree on the errno
 * taxonomy that matters here (ENOENT, ELOOP, ENOTDIR) — confirmed by probe in
 * the portability review — so the swap does not change how callers classify
 * failures.
 */
export function realpathLongestAbsentTolerantPrefix(targetPath: string): string {
  let current = targetPath;
  for (;;) {
    try {
      return fs.realpathSync.native(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // Something IS here and does not resolve: a dangling symlink. Refuse
      // rather than climb past it.
      if (!nothingExistsAt(current)) throw err;
      const parent = path.dirname(current);
      if (parent === current) throw err;
      current = parent;
    }
  }
}

