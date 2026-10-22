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
function relativePathEscapes(relative: string): boolean {
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
 * following the link. The launchd render-options resolver
 * (src/fleet/launchd-render-options.ts) calls this rather than keeping its own
 * copy of the same probe, so a repair here reaches both call sites.
 *
 * Trailing separators are stripped before the probe because POSIX reads a
 * trailing `/` as a following `.`, so `lstat('<link>/')` reports on the link's
 * TARGET instead of the link. Without the strip a dangling link named
 * `<home>/dangle/` read as absent, the ancestor climb in
 * realpathLongestAbsentTolerantPrefix walked past it to an in-home ancestor,
 * and one character turned a refusal into an admission at every caller. The
 * pattern is anchored so it can never empty the string: `lstat('')` is ENOENT,
 * which would report the filesystem root as absent.
 */
export function nothingExistsAt(targetPath: string): boolean {
  const bare = targetPath.replace(/(?!^)\/+$/, '');
  try {
    fs.lstatSync(bare);
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
 * This absent-tolerant walk is for planning directories before creation.
 * It is not final consumption admission: that requires every intermediate
 * component to resolve, through physicalPrefixIsConfined below.
 *
 * `fs.realpathSync.native` (libc realpath(3)) is load-bearing and must not be
 * swapped back to `fs.realpathSync`, which calls `path.resolve()` first and so
 * collapses `..` before walking symlinks. The two bindings agree on the errno
 * taxonomy that matters here (ENOENT, ELOOP, ENOTDIR) — confirmed by probe in
 * the portability review — so the swap does not change how callers classify
 * failures.
 */
export function realpathLongestAbsentTolerantPrefix(targetPath: string): string {
  // A `..` anywhere in the spelling makes the climb unsound, so the climb is
  // not attempted at all.
  //
  // The climb discards components RIGHT TO LEFT. For `<home>/absent/../link`
  // with `link -> /outside`, the whole path fails to resolve because `absent`
  // does not exist, and each climb then throws away `link`, then `..`, then
  // `absent`, landing on `<home>` and reporting the path as confined. The `..`
  // is discarded before the symlink to its left is ever followed, while the
  // caller goes on to persist the LEXICALLY collapsed `<home>/link`, which is
  // the symlink. Absence and traversal are individually safe here and lethal
  // together, so the combination is refused.
  const hasTraversal = targetPath.split(path.sep).includes('..');
  let current = targetPath;
  for (;;) {
    try {
      return fs.realpathSync.native(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // Something IS here and does not resolve: a dangling symlink. Refuse
      // rather than climb past it.
      if (!nothingExistsAt(current)) throw err;
      if (hasTraversal) throw err;
      const parent = path.dirname(current);
      if (parent === current) throw err;
      current = parent;
    }
  }
}

/**
 * Is this spelling already canonical — absolute, no `.`/`..` component, no
 * redundant separators?
 *
 * Applied before returning accepted physical paths for a launchd service
 * `PATH` or `CLAUDE_CONFIG_DIR`. For those, physical containment is not enough
 * on its own: a `..` component is re-resolved by the kernel at exec time
 * against whatever the filesystem looks like then, so a spelling that resolves
 * in-home today escapes later if any leading component becomes a symlink.
 * Refusing the spelling outright removes that whole class, and costs operators
 * nothing because a canonical form always exists.
 *
 * Lives here rather than beside either caller because the API-admission guard
 * (src/fleet/routes/ops.ts) and the render-admission guard
 * (src/fleet/platform.ts) must apply the SAME predicate: this module exists
 * because near-duplicate copies of a confinement rule drifted apart once
 * already. A third copy is exactly what it is here to prevent.
 */
export function isCanonicalAbsolutePath(value: string): boolean {
  if (!value.startsWith('/')) return false;
  if (value !== path.posix.normalize(value)) return false;
  return !value.split('/').some((segment) => segment === '.' || segment === '..');
}

/**
 * Final-consumption physical policy: every intermediate must resolve.
 * Only an absent final leaf is tolerated; its parent must already be confined.
 * This remains a point-in-time check and assumes trusted writable ancestors.
 */
export function physicalPrefixIsConfined(rawAbsolute: string, homeReal: string): boolean {
  return pathIsAtOrInsideDirectory(resolveFinalPath(rawAbsolute), homeReal);
}

function resolveFinalPath(rawAbsolute: string): string {
  try {
    return fs.realpathSync.native(rawAbsolute);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || !nothingExistsAt(rawAbsolute)) throw err;
    // Only the final leaf may be absent. Resolving its parent refuses both
    // missing intermediates and dangling links instead of walking past them.
    return path.join(fs.realpathSync.native(path.dirname(rawAbsolute)), path.basename(rawAbsolute));
  }
}

export function plannedPrefixIsConfined(rawAbsolute: string, homeReal: string): boolean {
  return pathIsAtOrInsideDirectory(realpathLongestAbsentTolerantPrefix(rawAbsolute), homeReal);
}

/** Return the physical path that the immediate consumer must use. */
export function admitHomeConfinedPath(inputPath: string, homeDir: string): string {
  const homeReal = fs.realpathSync.native(homeDir);
  if (!isCanonicalAbsolutePath(inputPath)
    || (!pathIsInsideDirectory(inputPath, path.resolve(homeDir))
      && !pathIsInsideDirectory(inputPath, homeReal))) {
    throw new Error('path must resolve inside the home directory');
  }
  const accepted = resolveFinalPath(inputPath);
  if (!pathIsInsideDirectory(accepted, homeReal) || !physicalPrefixIsConfined(accepted, homeReal)) {
    throw new Error('path must resolve inside the home directory');
  }
  return accepted;
}

/** Provision planned directories one checked component at a time. */
export function ensureHomeConfinedDirectory(inputPath: string, homeDir: string): string {
  const homeReal = fs.realpathSync.native(homeDir);
  const lexicalHome = path.resolve(homeDir);
  const root = pathIsInsideDirectory(inputPath, lexicalHome) ? lexicalHome : homeReal;
  if (!isCanonicalAbsolutePath(inputPath) || !pathIsInsideDirectory(inputPath, root)
    || !plannedPrefixIsConfined(inputPath, homeReal)) {
    throw new Error('directory must resolve inside the home directory');
  }
  let current = homeReal;
  for (const segment of path.relative(root, inputPath).split(path.sep)) {
    const accepted = admitHomeConfinedPath(path.join(current, segment), homeReal);
    try {
      fs.mkdirSync(accepted, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    current = admitHomeConfinedPath(accepted, homeReal);
    if (!fs.statSync(current).isDirectory()) throw new Error('home-confined path must be a directory');
  }
  return current;
}

/**
 * Lexical containment, for callers that only need "is this path under that
 * root" with no filesystem access.
 *
 * Exported so src/transport/auth-bond.ts stops carrying its own copy. That copy
 * used the bare `rel.startsWith('..')` test, so it inherited the same
 * over-rejection of in-root names that merely begin with dots.
 */
export function pathIsInsideRoot(root: string, candidate: string): boolean {
  return pathIsInsideDirectory(path.resolve(candidate), path.resolve(root));
}

/**
 * Is `inputPath` physically confined to `homeDir`?
 *
 * Applied to ONE path value at a time - a `pathPrepend` ENTRY or
 * `claudeConfigDir` - and never to a joined `PATH` string. The rendered `PATH`
 * is the entries followed by the generating shell's ambient tail, and that tail
 * legitimately carries system directories outside home, so a predicate over the
 * joined value would reject every real row. The fleet service-path survey
 * measured this: on the joined value it rejects every live row, on the entries
 * it rejects none.
 *
 * Throws whatever resolution threw; callers decide the refusal shape.
 */
export function isPhysicallyInsideHome(inputPath: string, homeDir: string): boolean {
  const homeReal = fs.realpathSync.native(homeDir);
  const raw = rawAbsolutePath(inputPath);
  // Lexical gate first, and STRICT: it is the only check that separates "an
  // absent directory under home" from "home itself", since both resolve to a
  // prefix of home.
  if (!pathIsInsideDirectory(path.resolve(raw), path.resolve(homeDir))) return false;
  // Every intermediate must resolve; only the final leaf may be absent.
  return physicalPrefixIsConfined(raw, homeReal);
}
