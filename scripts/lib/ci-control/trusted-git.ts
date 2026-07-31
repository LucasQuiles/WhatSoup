import { accessSync, constants, lstatSync, realpathSync, type Stats } from 'node:fs';

/**
 * Absolute paths where a trusted `git` binary may live, in trust order. Resolution never
 * consults PATH, `which`, `command -v`, or an environment-variable override — in a
 * security-sensitive CI validation script (outgoing ref policy, hook identity), that kind of
 * dynamic lookup turns a pinned trusted binary into a PATH-injection vector. See #2616: a
 * hardcoded `/usr/bin/git` silently failed wherever git ships from Homebrew or MacPorts instead
 * of the base OS, which is why this list carries those locations too — but only ever as fixed,
 * individually-vetted candidates, never as a search.
 */
export const DEFAULT_TRUSTED_GIT_CANDIDATES: readonly string[] = [
  '/usr/bin/git',
  '/opt/homebrew/bin/git',
  '/usr/local/bin/git',
  '/opt/local/bin/git',
];

/** Thrown when no candidate in the allowlist resolves to a trusted git binary. */
export class TrustedGitUnavailableError extends Error {
  readonly candidates: readonly string[];

  constructor(candidates: readonly string[]) {
    super(`no trusted git executable found among: ${candidates.join(', ')}`);
    this.name = 'TrustedGitUnavailableError';
    this.candidates = candidates;
  }
}

/**
 * A file owned by root, or by this process's own effective uid, is the only ownership this
 * module treats as trusted. Homebrew on Apple Silicon installs git under an admin-user-owned
 * prefix (not root), so the running user's own euid must be admitted alongside root — anything
 * owned by a third party, trusted or not, is rejected.
 */
export function isTrustedGitOwner(uid: number): boolean {
  if (uid === 0) return true;
  const euid = process.geteuid?.();
  return euid !== undefined && uid === euid;
}

function qualifies(candidate: string): string | null {
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    return null;
  }
  let stat: Stats;
  try {
    stat = lstatSync(real);
  } catch {
    return null;
  }
  // realpathSync already resolved every symlink in the chain, so `real` still naming a symlink
  // here would mean it changed underneath us between the two calls; reject rather than trust it.
  if (stat.isSymbolicLink() || !stat.isFile()) return null;
  if ((stat.mode & 0o022) !== 0) return null;
  if (!isTrustedGitOwner(stat.uid)) return null;
  try {
    accessSync(real, constants.X_OK);
  } catch {
    return null;
  }
  return real;
}

/**
 * Resolve the trusted `git` executable from a static allowlist of absolute paths. The first
 * candidate that exists, is a regular file at the end of its symlink chain, is executable, is
 * not group- or world-writable, and is owned by root or this process's own effective uid wins.
 * Throws `TrustedGitUnavailableError` naming every candidate checked when none qualify — callers
 * must let that propagate and fail closed, never fall back to a bare `git` lookup.
 */
export function resolveTrustedGit(
  candidates: readonly string[] = DEFAULT_TRUSTED_GIT_CANDIDATES,
): string {
  for (const candidate of candidates) {
    const resolved = qualifies(candidate);
    if (resolved !== null) return resolved;
  }
  throw new TrustedGitUnavailableError(candidates);
}
