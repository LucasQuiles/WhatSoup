/**
 * Which release does a launchd job ACTUALLY execute?
 *
 * The answer is in `ProgramArguments`, never in `WorkingDirectory`. This module
 * exists because the release-drift observer read `WorkingDirectory` for two
 * months on mini11 and therefore could not have caught the incident it was
 * installed to catch:
 *
 *  - The bot and fleet jobs run a wrapper symlink (`~/.local/bin/whatsoup` →
 *    `<release>/deploy/whatsoup`). `deploy/whatsoup` resolves its own path
 *    through symlinks and takes the parent's parent as REPO_ROOT, so the
 *    symlink target selects the release.
 *  - The auxiliary jobs (`harness-maintenance`, `release-drift-check`,
 *    `reply-guarantee`) run `/bin/bash <absolute script path>`, and each script
 *    derives its own root from `${BASH_SOURCE[0]}`. The script path selects the
 *    release.
 *
 * `WorkingDirectory` only sets cwd. It is still worth reading — as a
 * CROSS-CHECK. When it disagrees with the real selector, that disagreement IS
 * the false-pass signature: a hand-edited `WorkingDirectory` makes a stale job
 * look freshly activated.
 *
 * Resolution fails closed. A job whose release cannot be determined must never
 * fall back to `WorkingDirectory`, because that fallback is the defect.
 */
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';

import { parsePlist } from '../check-service-units.ts';
import { RELEASE_MANIFEST_FILE } from '../release-snapshot-plan.ts';

/** How a job's release was derived from its `ProgramArguments`. */
export type ReleaseSelectorKind = 'wrapper-symlink' | 'program-argument';

export interface LaunchdReleaseSelection {
  plistPath: string;
  label: string | null;
  /** The release root the job actually executes from. */
  releasePath: string;
  selector: ReleaseSelectorKind;
  /** The fully symlink-resolved `ProgramArguments` entry `releasePath` came from. */
  selectorPath: string;
  /** Raw `WorkingDirectory`, or null when the plist sets none. */
  workingDirectory: string | null;
  /**
   * Release root implied by `WorkingDirectory` — a cross-check, never the
   * selector. Null when the plist sets no `WorkingDirectory` or when the
   * directory lies outside any release.
   */
  workingDirectoryReleasePath: string | null;
}

/** A launchd job whose release could not be determined, distinct from an IO fault. */
export class LaunchdReleaseSelectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaunchdReleaseSelectorError';
  }
}

/** Bounds the walk so a symlink cycle terminates instead of hanging the observer. */
const MAX_SYMLINK_HOPS = 32;

/** The directory name `deploy/whatsoup` and `deploy/whatsoup-fleet` live under. */
const WRAPPER_PARENT_DIR = 'deploy';

/**
 * Follow symlinks on the FINAL path component only, matching the wrapper's own
 * `_resolve_symlinks`. Resolving intermediate directories (as `realpath` does)
 * would diverge from the root the wrapper computes at runtime.
 */
function resolveSymlinkChain(target: string): string {
  let current = path.resolve(target);
  for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop += 1) {
    let stats;
    try {
      stats = lstatSync(current);
    } catch {
      // A path that does not exist still selects a release by its location.
      return current;
    }
    if (!stats.isSymbolicLink()) return current;
    current = path.resolve(path.dirname(current), readlinkSync(current));
  }
  throw new LaunchdReleaseSelectorError(`symlink chain exceeds ${MAX_SYMLINK_HOPS} hops: ${target}`);
}

/**
 * Nearest ancestor (inclusive) bearing a release manifest.
 *
 * The manifest is the only marker used. A looser one — `package.json`, say —
 * would resolve a pinned-node interpreter path to whatever ancestor happened to
 * carry one, which is exactly the class of wrong answer this module replaces.
 */
function findReleaseRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(dir, RELEASE_MANIFEST_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The wrapper's own rule: `<release>/deploy/whatsoup` → `<release>`.
 *
 * Applied structurally rather than by manifest lookup, because the wrapper
 * derives REPO_ROOT this way whether or not a manifest is present — a release
 * missing its manifest must still resolve, so the drift check can report the
 * missing manifest instead of failing to locate the job.
 */
function wrapperReleaseRoot(resolvedArgv0: string): string | null {
  const parent = path.dirname(resolvedArgv0);
  if (path.basename(parent) !== WRAPPER_PARENT_DIR) return null;
  return path.dirname(parent);
}

/**
 * Derive the release a launchd job runs, from the plist at `plistPath`.
 *
 * @throws {LaunchdReleaseSelectorError} when no `ProgramArguments` entry names a
 * release. Callers must not substitute `WorkingDirectory`.
 */
export function resolveLaunchdReleaseSelection(plistPath: string): LaunchdReleaseSelection {
  const absolutePlistPath = path.resolve(plistPath);
  const parsed = parsePlist(readFileSync(absolutePlistPath, 'utf8'));
  if (!parsed) throw new LaunchdReleaseSelectorError(`invalid launchd plist: ${absolutePlistPath}`);

  const workingDirectory = parsed.scalarKeys['WorkingDirectory']?.trim() || null;
  const cross = {
    plistPath: absolutePlistPath,
    label: parsed.label,
    workingDirectory,
    workingDirectoryReleasePath: workingDirectory === null ? null : findReleaseRoot(workingDirectory),
  };

  const args = parsed.programArguments;
  if (args.length === 0) {
    throw new LaunchdReleaseSelectorError(`launchd plist has no ProgramArguments: ${absolutePlistPath}`);
  }

  // The executable itself first: a wrapper symlink selects the release outright.
  if (path.isAbsolute(args[0])) {
    const resolvedArgv0 = resolveSymlinkChain(args[0]);
    const wrapperRoot = wrapperReleaseRoot(resolvedArgv0);
    if (wrapperRoot !== null) {
      return { ...cross, releasePath: wrapperRoot, selector: 'wrapper-symlink', selectorPath: resolvedArgv0 };
    }
  }

  // Otherwise the executable is an interpreter (`/bin/bash`, a pinned node) and
  // the release comes from the first argument that lives inside one. Order
  // matters: the script path precedes any absolute flag VALUE, so the script
  // wins over, say, the instance plist passed to release-drift-check.
  for (const arg of args) {
    if (!path.isAbsolute(arg)) continue;
    const resolved = resolveSymlinkChain(arg);
    const releaseRoot = findReleaseRoot(path.dirname(resolved));
    if (releaseRoot !== null) {
      return { ...cross, releasePath: releaseRoot, selector: 'program-argument', selectorPath: resolved };
    }
  }

  throw new LaunchdReleaseSelectorError(
    `no ProgramArguments entry resolves to a release for ${parsed.label ?? absolutePlistPath}; ` +
      'WorkingDirectory is not a substitute because it does not select the release',
  );
}

/** Does `WorkingDirectory` name a different release than the job actually runs? */
export function hasWorkingDirectoryMismatch(selection: LaunchdReleaseSelection): boolean {
  return selection.workingDirectoryReleasePath !== null
    && selection.workingDirectoryReleasePath !== selection.releasePath;
}
