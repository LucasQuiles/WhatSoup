import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { pathIsInsideRoot } from '../lib/home-confinement.ts';
import { forceEnsurePrivateDirectorySync, fsyncDirectory, privateWriteError } from '../lib/private-fs.ts';
import { shortHash } from '../lib/short-hash.ts';
import { errorMessage } from '../lib/error-message.ts';
import { fileSnapshot, isVanishedEntry, modeString } from './auth-bond-files.ts';
import type {
  AuthBondCaptureOutcome,
  AuthBondCaptureResult,
  AuthBondSnapshot,
  AuthTreeObservation,
  AuthTreeSteps,
  CaptureAbortCause,
  LatestManifest,
} from './auth-bond-types.ts';

/** Thrown at a slice boundary once an abort has woken the run. */
export class CaptureAbortedError extends Error {
  readonly abortCause: CaptureAbortCause;

  constructor(abortCause: CaptureAbortCause) {
    super('auth bond capture aborted');
    this.abortCause = abortCause;
  }
}

export function settleablePromise<T>(): { promise: Promise<T>; settle: (value: T) => void } {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { settle = resolve; });
  return { promise, settle };
}

export function captureOutcome(result: AuthBondCaptureResult): AuthBondCaptureOutcome {
  if (result.aborted) return 'aborted';
  if (result.blocked) return 'blocked';
  if (result.ok) return result.captured ? 'captured' : 'unchanged';
  return result.deferred ? 'deferred' : 'failed';
}

export function wholeMs(ms: number): number {
  return Math.max(0, Math.round(ms));
}

/**
 * errorMessage(), except that it cannot throw.
 *
 * String() of a value with no usable conversion throws: a null-prototype
 * object, or one whose toString or message getter throws. The capture's result
 * builders run where one more throw would leave the run unsettled and
 * shutdownCaptures() waiting, so they format thrown values through this.
 */
export function captureErrorText(err: unknown): string {
  try {
    // String() again: an Error's message is typed string but can hold any value.
    return String(errorMessage(err));
  } catch {
    // Intentional: a thrown value with no string form is recorded as this fixed text.
    return 'thrown value has no string form';
  }
}

export const DEFAULT_KEEP_BACKUPS = 96;
export const DEFAULT_MAX_HISTORY_FILES = 100_000;
export const DEFAULT_CAPTURE_ATTEMPTS = 3;
export const DEFAULT_CAPTURE_RETRY_DELAY_MS = 75;
/**
 * Consecutive runs that may end deferred on an incomplete read; the next such
 * run fails and pages.
 *
 * An incomplete read (an entry vanished between the walk's listing and its
 * read) defers, because a sliced capture lets routine Baileys unlinks and creds
 * saves land inside its walk. Deferring without limit would hide a tree that
 * never reads completely, which main paged at once. Counted in runs, not
 * attempts; any run that ends otherwise resets the count. Each deferred run
 * re-arms the settled snapshot, whose 5-minute floor spaces the runs, so a
 * persistent fault pages about half an hour after the first incomplete read.
 */
export const INCOMPLETE_READ_DEFERRED_RUNS = 6;
export const INCOMPLETE_READ_DEFERRAL =
  'auth bond auth tree read was incomplete; capture deferred until a complete read';
export const INCOMPLETE_READ_BOUND_FAILURE = [
  `auth bond auth tree read was incomplete in ${INCOMPLETE_READ_DEFERRED_RUNS + 1} consecutive runs;`,
  'an entry kept vanishing between its listing and its read',
].join(' ');
/**
 * How long inspectCached() may serve a tree walk before starting another.
 *
 * This is the worst-case detection latency for anything only the walk can see —
 * chiefly a symlink planted into the auth tree, which produces no creds-update
 * or snapshot-capture event and so is never caught by invalidation. Before the
 * cache the harden walk ran on every health request (~5 s at the fleet poll
 * cadence), so 30 s is a deliberate and bounded loss of detection speed bought
 * in exchange for taking two full-tree walks off every request. inspect() is
 * unaffected and still walks live for every restore, capture and verification.
 */
export const DEFAULT_TREE_CACHE_MAX_AGE_MS = 30_000;
/**
 * How many max-age periods a digest may go unrefreshed before it stops counting
 * as evidence of a healthy tree and starts counting as an absence of evidence.
 *
 * Four, so 120 s at the default max age. The bound has to sit far above normal
 * operation and far below anything that could hide a real fault. A full
 * refresh of a `personal`-sized tree — 17,681 files, 24.4 MB, both walks — was
 * measured at 614 ms wall time, so 120 s is on the order of 200 consecutive
 * refresh opportunities. Reaching it means refreshes are failing or being
 * starved, not that the host is briefly busy.
 *
 * It is also well inside the observed invalidation interval. The `personal`
 * instance recorded 3,860 creds updates over 22.06 days of uptime, about one
 * per 8.2 minutes, so ordinary invalidation traffic cannot hold a digest past
 * this bound; only a genuinely stuck refresh can.
 */
export const TREE_STALE_RISK_MULTIPLE = 4;
/** Backoff ceiling for walks that keep failing: 2^4 = 16 refresh floors. */
export const MAX_REFRESH_BACKOFF_STEPS = 4;
/**
 * Floor under the failure-retry wait, independent of treeRefreshMinIntervalMs.
 *
 * Every non-publishing walk now schedules its own successor, so the retry
 * cadence must not be able to collapse to zero. treeRefreshMinIntervalMs is
 * caller-supplied and tests set it to 0, where `0 * 2 ** n` is still 0 and the
 * retry chain degenerates into a 0 ms timer loop. This clamp applies ONLY to
 * the failure-retry wait; the reader admission floor stays exactly what the
 * caller configured, so a test asking for an unthrottled reader still gets one.
 */
export const MIN_REFRESH_RETRY_INTERVAL_MS = 50;
/**
 * Floor between the STARTS of two tree walks.
 *
 * Needed because the key-store seam fires far more often than once per send.
 * Baileys writes one Signal session per recipient device
 * (node_modules/@whiskeysockets/baileys/lib/Signal/libsignal.js:361) plus a few
 * constant writes per send, so a 50-device group send drives roughly 50
 * invalidations. Without a floor, a busy instance would start a fresh 614 ms
 * walk per write and spend more CPU on the digest than the per-request walk
 * this change exists to remove.
 *
 * Five seconds is chosen as a strict non-regression bound: the fleet polls
 * /health every 5 s, so the pre-change code performed two full walks every 5 s
 * on this instance. Refreshing no more often than that can never be worse than
 * what it replaced, and is normally far better because a quiet instance
 * refreshes only on the 30 s max age.
 *
 * A rate-limited refresh is not a lost one, and no caller has to come back for
 * it. Convergence belongs to the successor timer: a mutation queues exactly one
 * through scheduleTreeRefreshSuccessor, and so does every walk that fails or
 * completes without publishing. A READER queues nothing — it has nothing to
 * converge on — and starts a walk only when the floor has elapsed AND no
 * successor is already armed. The last observation stays served, marked stale,
 * throughout.
 *
 * The stale risk bound is 24 floors wide, so the floor limiter on its own
 * cannot hold a digest past it. The repeated-failure back-off is a separate,
 * clamped widening and CAN reach past the bound; its schedule, and what the
 * bound does and does not promise, are stated where it is computed, in
 * scheduleTreeRefreshSuccessor.
 */
export const DEFAULT_TREE_REFRESH_MIN_INTERVAL_MS = 5_000;
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export function safeName(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned === '' ? 'unknown' : cleaned;
}

export function isoForFileName(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function isHistoryStagingDirName(name: string): boolean {
  return /\.tmp-\d+$/.test(name);
}

/** A history entry the prune may remove: a real folder. One gone or unreadable is not. */
export function isHistoryEntryDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Live, O(1) check that the auth root is a real directory.
 *
 * Deliberately NOT part of the cached tree walk: replacing the auth root with a
 * symlink is precisely the mutation a stale cache would miss, and one lstat is
 * cheap enough to run on every request.
 */
export function authRootKindIssue(path: string): string | null {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    // Absence and unreadability are classified by the caller's own snapshot.
    return null;
  }
  if (st.isSymbolicLink()) return 'auth_dir_symlink';
  if (!st.isDirectory()) return 'auth_dir_not_directory';
  return null;
}

// #2292 L2 — unguarded by name: every call site wraps this in its own
// try/catch (auth-bond.ts:481,517,616,919 verified), so the throw-on-invalid
// contract is already load-bearing, not accidental. Renamed rather than
// guarded internally so the contract is legible at the call site instead of
// depending on caller discipline that happened to already be correct.
export function readJsonOrThrow(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function extractMeHash(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const me = (parsed as Record<string, unknown>)['me'];
  if (typeof me !== 'object' || me === null || Array.isArray(me)) return null;
  const record = me as Record<string, unknown>;
  const id = typeof record['id'] === 'string'
    ? record['id']
    : typeof record['lid'] === 'string'
      ? record['lid']
      : null;
  return id ? shortHash(id, 20) : null;
}

/**
 * Units one slice may hold between two yields.
 *
 * The tree walks exist in exactly one implementation each, written as
 * generators, because two of the properties they carry are load-bearing and
 * cannot be allowed to drift between a sync and an async copy: the digest byte
 * format (a mismatch silently breaks tamper detection against a recorded
 * baseline) and the `complete: false` fail-closed rule. Driving the same
 * generator two ways makes divergence impossible rather than merely tested for.
 *
 * Each generator yields the units of its next entry BEFORE doing that entry,
 * and the driver decides whether the entry still fits in the current slice. The
 * generators keep no counter of their own, so a driver that runs several of
 * them (a capture run does) holds one budget across all of them, and a phase
 * boundary never restarts the count.
 *
 * 64 keeps a slice at roughly a millisecond for Baileys key files, so a
 * yielding drive of the 17,680-file `personal` tree never holds the loop for
 * anything close to the 250 ms starvation threshold. A slice holds 64 walk
 * entries, 16 copy or delete entries, or a mix of the two.
 */
export const AUTH_TREE_SLICE_UNITS = 64;
/** One walk entry: an lstat, plus a readdir for a folder or a read in the digest pass. */
export const WALK_ENTRY_UNITS = 1;
/**
 * One copy or delete entry. These write: at an estimated 100 to 250 µs per
 * copied file, four walk entries' worth keeps a slice at a few milliseconds.
 */
const WRITE_ENTRY_UNITS = 4;

/** Run a walk to completion inline. Behaviour identical to the pre-generator code. */
function drainSync<T>(steps: AuthTreeSteps<T>): T {
  let step = steps.next();
  while (!step.done) step = steps.next();
  // The return value lives on the final {done: true} result, never on the
  // intermediate ones a plain for..of would surface.
  return step.value;
}

/**
 * Run a walk while handing the event loop back between slices.
 *
 * The await comes BEFORE the first next(), so no part of the walk runs in the
 * caller's synchronous turn — the whole point is that a caller can start a
 * refresh without paying for any of it.
 */
export async function drainYielding<T>(steps: AuthTreeSteps<T>): Promise<T> {
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  let units = 0;
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    if (units + step.value > AUTH_TREE_SLICE_UNITS) {
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      units = 0;
    }
    units += step.value;
  }
}

/**
 * Enumerate the auth tree.
 *
 * `complete: false` means at least one entry vanished mid-walk, so `paths` is a
 * SUBSET of what was on disk. Callers must not treat a subset as a description
 * of the tree — see inspectAuthTree.
 */
function* walkAuthFilesSteps(root: string): AuthTreeSteps<{ paths: string[]; complete: boolean }> {
  const out: string[] = [];
  const stack = [root];
  let complete = true;
  while (stack.length > 0) {
    yield WALK_ENTRY_UNITS;
    const current = stack.pop()!;
    let st;
    try {
      st = lstatSync(current);
    } catch (err) {
      // lstat does not follow the final component, so an existing symlink —
      // even a dangling one — returns the link itself rather than ENOENT. This
      // allowance therefore cannot mask the symlink refusal below.
      if (isVanishedEntry(err)) { complete = false; continue; }
      throw err;
    }
    if (st.isDirectory()) {
      let entries: string[];
      try {
        entries = readdirSync(current)
          .filter(name => name !== '.DS_Store')
          .map(name => join(current, name))
          .sort()
          .reverse();
      } catch (err) {
        // A vanished directory takes its whole subtree out of the walk, which
        // is a larger loss than a single file — and one that leaves no trace in
        // `paths`. It only shows up as `complete: false`.
        if (isVanishedEntry(err)) { complete = false; continue; }
        throw err;
      }
      stack.push(...entries);
      continue;
    }
    if (st.isSymbolicLink()) {
      throw privateWriteError(`refusing to walk auth tree containing symlink: ${relative(root, current) || '.'}`, 'ELOOP');
    }
    if (st.isFile()) {
      out.push(current);
    }
  }
  return { paths: out.sort(), complete };
}

function walkAuthFiles(root: string): { paths: string[]; complete: boolean } {
  return drainSync(walkAuthFilesSteps(root));
}

/**
 * Hash the auth tree, or return null if it could not be observed completely.
 *
 * An incomplete observation yields NO hash rather than a shorter one. The
 * digest commits only to the files it hashed, so a tree read while an entry was
 * vanishing would produce a digest byte-identical to that of a genuinely
 * smaller tree — `hash({a,b,c} with c skipped) === hash({a,b})`. `treeHash` is
 * a tamper-detection primitive (authTreeValidationError below compares it
 * against a recorded baseline, and ConnectionManager gates clearing the local
 * auth-bond alert on it), so a partial read silently colliding with a real tree
 * state would turn that control from fail-closed into fail-open.
 *
 * Returning null keeps it fail-closed without the crash that #2285 is about:
 * every consumer already handles null (`auth tree is unreadable`, and the
 * capture path skips on a missing treeHash), whereas the pre-fix throw escaped
 * inspect() on a `void`-ed async path and shut the instance down.
 */
export function* inspectAuthTreeSteps(
  authDir: string,
  read?: { incomplete: boolean },
): AuthTreeSteps<AuthTreeObservation | null> {
  if (!existsSync(authDir)) return null;
  const { paths, complete } = yield* walkAuthFilesSteps(authDir);
  if (!complete) {
    // `read` tells a capture that an entry vanished, which it defers, from a
    // root that was absent, which it does not.
    if (read) read.incomplete = true;
    return null;
  }
  const hasher = createHash('sha256');
  let totalBytes = 0;
  for (const path of paths) {
    yield WALK_ENTRY_UNITS;
    const rel = relative(authDir, path);
    // stat and read together: a file that survived the stat can still be
    // renamed away before the read, so both halves need the same allowance.
    let st;
    let contents;
    try {
      st = lstatSync(path);
      contents = readFileSync(path);
    } catch (err) {
      if (isVanishedEntry(err)) {
        if (read) read.incomplete = true;
        return null;
      }
      throw err;
    }
    totalBytes += st.size;
    hasher.update(rel);
    hasher.update('\0');
    hasher.update(modeString(st.mode));
    hasher.update('\0');
    hasher.update('file');
    hasher.update('\0');
    hasher.update(contents);
    hasher.update('\0');
  }
  // Safe as paths.length precisely because a short read returns null above:
  // every path in `paths` was hashed, so the count and the digest describe the
  // same file set.
  return { treeHash: hasher.digest('hex'), fileCount: paths.length, totalBytes };
}

export function inspectAuthTree(authDir: string): AuthTreeObservation | null {
  return drainSync(inspectAuthTreeSteps(authDir));
}

/**
 * Copy the auth tree, as slices.
 *
 * The same pre-order, readdir-order traversal and the same fs calls per entry
 * as the recursive copy it replaces, kept on an explicit stack so it can yield.
 *
 * Strict by default: an entry that vanishes between its listing and its lstat,
 * readdir or copy throws, as the recursive copy did. Restore copies this way.
 * Its validation compares the whole tree only when the backup manifest records
 * a treeHash, so a skipped backup entry could install a shorter tree; the
 * throw makes restore roll back instead.
 *
 * With `skipVanished`, the capture's copy skips such an entry (a consumed
 * pre-key Baileys unlinks, a creds saver's temp file renamed away), as
 * removeTreeSteps skips one. Skipping cannot publish a partial tree: the
 * capture validates its copy against the full pre-copy digest, so the copy
 * fails that check with `copied auth tree hash mismatch`, and a change with
 * the same identity defers.
 */
export function* copyPrivateTreeSteps(
  src: string,
  dst: string,
  { skipVanished }: { readonly skipVanished: boolean } = { skipVanished: false },
): AuthTreeSteps<void> {
  const stack: Array<readonly [string, string]> = [[src, dst]];
  while (stack.length > 0) {
    yield WRITE_ENTRY_UNITS;
    const [from, to] = stack.pop()!;
    let st;
    try {
      st = lstatSync(from);
    } catch (err) {
      if (skipVanished && isVanishedEntry(err)) continue;
      throw err;
    }
    if (st.isDirectory()) {
      mkdirSync(to, { recursive: true, mode: 0o700 });
      chmodSync(to, 0o700);
      let entries: string[];
      try {
        entries = readdirSync(from).filter(entry => entry !== '.DS_Store');
      } catch (err) {
        if (skipVanished && isVanishedEntry(err)) continue;
        throw err;
      }
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        stack.push([join(from, entries[i]), join(to, entries[i])]);
      }
      continue;
    }
    if (st.isSymbolicLink()) {
      throw privateWriteError(`refusing to copy auth tree containing symlink: ${from}`, 'ELOOP');
    }
    try {
      copyFileSync(from, to);
    } catch (err) {
      if (skipVanished && isVanishedEntry(err)) continue;
      throw err;
    }
    chmodSync(to, 0o600);
  }
}

/** Restore's copy, drained in one turn. Strict: a backup entry that vanishes mid-copy throws. */
export function copyPrivateTree(src: string, dst: string): void {
  drainSync(copyPrivateTreeSteps(src, dst));
}

/**
 * Remove a file or a tree, as slices: files first, then each emptied folder.
 * An entry that vanishes on the way counts as removed, as with `force: true`.
 */
export function* removeTreeSteps(root: string): AuthTreeSteps<void> {
  const pending: Array<{ path: string; expanded: boolean }> = [{ path: root, expanded: false }];
  while (pending.length > 0) {
    // Each step is priced as a delete entry, a folder's expansion included.
    yield WRITE_ENTRY_UNITS;
    const top = pending[pending.length - 1];
    if (!top.expanded) {
      let st;
      try {
        st = lstatSync(top.path);
      } catch (err) {
        if (isVanishedEntry(err)) { pending.pop(); continue; }
        throw err;
      }
      if (st.isDirectory()) {
        top.expanded = true;
        let names: string[];
        try {
          names = readdirSync(top.path);
        } catch (err) {
          if (isVanishedEntry(err)) { pending.pop(); continue; }
          throw err;
        }
        for (const name of names) pending.push({ path: join(top.path, name), expanded: false });
        continue;
      }
    }
    pending.pop();
    rmSync(top.path, { recursive: true, force: true });
  }
}

export function* hardenPrivateTreeSteps(root: string): AuthTreeSteps<string[]> {
  if (!existsSync(root)) return [];
  const issues: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    yield WALK_ENTRY_UNITS;
    const current = stack.pop()!;
    let st;
    try {
      st = lstatSync(current);
    } catch (err) {
      const rel = current === root ? '.' : relative(root, current);
      issues.push(`auth_mode_stat_failed:${rel}:${errorMessage(err)}`);
      continue;
    }

    if (st.isSymbolicLink()) {
      const rel = current === root ? '.' : relative(root, current);
      issues.push(`auth_tree_symlink:${rel}`);
      continue;
    }

    const desiredMode = st.isDirectory() ? 0o700 : st.isFile() ? 0o600 : null;
    if (desiredMode !== null && (st.mode & 0o777) !== desiredMode) {
      try {
        chmodSync(current, desiredMode);
      } catch (err) {
        const rel = current === root ? '.' : relative(root, current);
        issues.push(`auth_mode_chmod_failed:${rel}:${errorMessage(err)}`);
      }
    }

    if (st.isDirectory()) {
      try {
        const entries = readdirSync(current)
          .filter(name => name !== '.DS_Store')
          .map(name => join(current, name))
          .sort()
          .reverse();
        stack.push(...entries);
      } catch (err) {
        const rel = current === root ? '.' : relative(root, current);
        issues.push(`auth_mode_readdir_failed:${rel}:${errorMessage(err)}`);
      }
    }
  }
  return issues;
}

export function hardenPrivateTree(root: string): string[] {
  return drainSync(hardenPrivateTreeSteps(root));
}

function assertPrivateJsonTarget(path: string): void {
  if (!existsSync(path)) return;
  const lst = lstatSync(path);
  if (lst.isSymbolicLink()) {
    throw privateWriteError('refusing to write auth-bond json through symlink', 'ELOOP');
  }
  const st = statSync(path);
  if (!st.isFile()) {
    throw privateWriteError('refusing to write auth-bond json over non-regular path', 'EINVAL');
  }
}

export function writePrivateJson(path: string, value: unknown): void {
  const dir = dirname(path);
  forceEnsurePrivateDirectorySync(dir, 'auth-bond json directory');
  assertPrivateJsonTarget(path);

  const tmpPath = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(tmpPath, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(value, null, 2), 'utf-8');
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    assertPrivateJsonTarget(path);
    renameSync(tmpPath, path);
    chmodSync(path, 0o600);
    fsyncDirectory(dir);
  } catch (err) {
    if (fd !== null) closeSync(fd);
    try { unlinkSync(tmpPath); } catch { /* intentional: best-effort temp file cleanup; the write error is rethrown */ }
    throw err;
  }
}

export function authTreeValidationError(
  authDir: string,
  expected: { credsHash?: string | null; meHash?: string | null; treeHash?: string | null },
  prefix: string,
): string | null {
  return drainSync(authTreeValidationErrorSteps(authDir, expected, prefix));
}

function* authTreeValidationErrorSteps(
  authDir: string,
  expected: { credsHash?: string | null; meHash?: string | null; treeHash?: string | null },
  prefix: string,
): AuthTreeSteps<string | null> {
  const symlinkIssues = (yield* hardenPrivateTreeSteps(authDir)).filter(issue => issue.startsWith('auth_tree_symlink:'));
  if (symlinkIssues.length > 0) {
    return `${prefix} auth tree contains symlink: ${symlinkIssues.join(',')}`;
  }
  const credsPath = join(authDir, 'creds.json');
  const creds = fileSnapshot(credsPath, true);
  // Before the content checks: an unread file has a null hash, which the
  // comparison below would otherwise report as a hash mismatch — telling the
  // operator the copy is corrupt when it was never read in the first place.
  if (creds.error !== null) {
    return `${prefix} creds.json is unreadable (${creds.error})`;
  }
  if (!creds.exists) return `${prefix} auth missing creds.json`;
  if (creds.size === 0 || creds.sha256 === EMPTY_SHA256) {
    return `${prefix} creds.json is empty`;
  }
  if (expected.credsHash && creds.sha256 !== expected.credsHash) {
    return `${prefix} creds.json hash mismatch`;
  }

  let meHash: string | null = null;
  try {
    const parsed = readJsonOrThrow(credsPath);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return `${prefix} creds.json is not an object`;
    }
    meHash = extractMeHash(parsed);
  } catch {
    return `${prefix} creds.json is invalid json`;
  }

  if (!meHash) {
    return `${prefix} creds.json is missing identity`;
  }
  if (expected.meHash && meHash !== expected.meHash) {
    return `${prefix} creds.json identity mismatch`;
  }

  const treeHash = (yield* inspectAuthTreeSteps(authDir))?.treeHash ?? null;
  if (!treeHash) return `${prefix} auth tree is unreadable`;
  if (expected.treeHash && treeHash !== expected.treeHash) {
    return `${prefix} auth tree hash mismatch`;
  }
  return null;
}

export function validateCopiedAuthTreeSteps(authDir: string, expected: AuthBondSnapshot): AuthTreeSteps<string | null> {
  return authTreeValidationErrorSteps(authDir, {
    credsHash: expected.creds.sha256,
    meHash: expected.meHash,
    treeHash: expected.treeHash,
  }, 'copied');
}

export function readLatestManifest(path: string): LatestManifest | null {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    const parsed = readJsonOrThrow(path);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as LatestManifest;
  } catch {
    return null;
  }
}

// Containment lives in src/lib/home-confinement.ts. The copy that used to sit
// here was byte-equivalent, including the bare `rel.startsWith('..')` test that
// also rejects an in-root name beginning with dots.
export const pathIsInside = pathIsInsideRoot;
