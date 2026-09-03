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
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathIsInsideRoot } from '../lib/home-confinement.ts';
import { DEFAULT_FRESH_INVALID_GRACE_MS } from '../lib/auth-bond-policy.ts';
import { forceEnsurePrivateDirectorySync, fsyncDirectory, privateWriteError } from '../lib/private-fs.ts';
import { shortHash } from '../lib/short-hash.ts';
import { errorMessage } from '../lib/error-message.ts';
import { decideRestoreFromCandidate, readTerminalLatchJournal } from './terminal-latch.ts';
import { readRestoreCandidateEvidence } from './auth-generation-v2.ts';

export type AuthBondStatus = 'present' | 'missing' | 'invalid';

export interface AuthBondFileSnapshot {
  path: string;
  exists: boolean;
  mode: string | null;
  size: number | null;
  mtime: string | null;
  sha256: string | null;
  /**
   * errno of a non-ENOENT failure while snapshotting, else null.
   *
   * `exists: false` alone cannot be read as "absent": it is also what a bare
   * catch produced for EACCES/EIO. With this field, absent is `exists:false,
   * error:null` and unreadable is a non-null error — and when lstat succeeded
   * but the content read did not, `exists` stays TRUE alongside the error.
   */
  error: string | null;
}

export interface AuthBondBackupSnapshot {
  root: string;
  latest: string | null;
  latestAt: string | null;
  latestReason: string | null;
  latestTreeHash: string | null;
  lastCaptureAt: string | null;
  lastCaptureReason: string | null;
  lastCaptureError: string | null;
  lastCaptureDeferredAt: string | null;
  lastCaptureDeferredReason: string | null;
  lastCaptureDeferredAgeMs: number | null;
  lastRestoreAt: string | null;
  lastRestoreSource: string | null;
  lastRestoreError: string | null;
  lastSweepError: string | null;
}

/**
 * Where the two full-tree walks in a snapshot came from.
 *
 * Present only on snapshots served by inspectCached(); inspect() omits it
 * because its walks are always live. A consumer that must reason about
 * freshness (the /health projection does) reads `ageMs`; a consumer that needs
 * a guaranteed-current tree calls inspect() and pays for it.
 */
export interface AuthBondTreeProvenance {
  /** 'absent' means no walk has completed yet, so the tree fields are null. */
  readonly source: 'cached' | 'absent';
  /** Age of the cached walk in milliseconds; null when source is 'absent'. */
  readonly ageMs: number | null;
  readonly refreshInFlight: boolean;
  /** Completed refreshes since construction. */
  readonly refreshCount: number;
  readonly lastInvalidationReason: string | null;
}

export interface AuthBondSnapshot {
  status: AuthBondStatus;
  authDir: AuthBondFileSnapshot;
  creds: AuthBondFileSnapshot;
  meHash: string | null;
  treeHash: string | null;
  fileCount: number | null;
  totalBytes: number | null;
  backup: AuthBondBackupSnapshot;
  issues: string[];
  treeProvenance?: AuthBondTreeProvenance;
}

export interface AuthBondCaptureResult {
  ok: boolean;
  snapshot: AuthBondSnapshot;
  captured: boolean;
  deferred: boolean;
  path: string | null;
  error: string | null;
}

export interface AuthBondRestoreResult {
  attempted: boolean;
  restored: boolean;
  source: string | null;
  snapshot: AuthBondSnapshot;
  error: string | null;
}

interface LatestManifest {
  backupPath?: string;
  createdAt?: string;
  reason?: string;
  treeHash?: string;
}

interface BackupManifest {
  instanceName?: string;
  reason?: string;
  createdAt?: string;
  authDir?: string;
  treeHash?: string | null;
  credsHash?: string | null;
  meHash?: string | null;
}

interface AuthBondGuardOptions {
  authDir: string;
  stateRoot?: string;
  instanceName: string;
  now?: () => Date;
  keepBackups?: number;
  maxHistoryFiles?: number;
  autoRestore?: boolean;
  captureAttempts?: number;
  captureRetryDelayMs?: number;
  captureBlockReason?: () => string | null;
  freshInvalidGraceMs?: number;
  /** Ceiling on how stale inspectCached() may serve a tree walk. See DEFAULT_TREE_CACHE_MAX_AGE_MS. */
  treeCacheMaxAgeMs?: number;
}

/** The two full-tree walks, held apart from the cheap per-request checks. */
interface AuthBondTreeObservation {
  readonly hardenIssues: string[];
  readonly tree: AuthTreeObservation | null;
  readonly observedAtMs: number;
}

const DEFAULT_KEEP_BACKUPS = 96;
const DEFAULT_MAX_HISTORY_FILES = 100_000;
const DEFAULT_CAPTURE_ATTEMPTS = 3;
const DEFAULT_CAPTURE_RETRY_DELAY_MS = 75;
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
const DEFAULT_TREE_CACHE_MAX_AGE_MS = 30_000;
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function safeName(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned === '' ? 'unknown' : cleaned;
}

function hashBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function isoForFileName(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function isHistoryStagingDirName(name: string): boolean {
  return /\.tmp-\d+$/.test(name);
}

function modeString(mode: number): string {
  return (mode & 0o777).toString(8);
}

/**
 * Snapshot one path, keeping "absent" and "unreadable" distinct.
 *
 * The two failures are stated separately on purpose, and it matters which one
 * you are looking at: absent means re-pair, unreadable means fix the mode or
 * the disk. The same ENOENT-only rule isVanishedEntry documents applies here —
 * a blanket catch turned EACCES/EIO into "there are no credentials".
 *
 * lstat and the content read are caught separately because a read that fails
 * AFTER a successful lstat has already proven the file exists; collapsing both
 * into one catch reported exists:false for a file the very same call had just
 * stat'd, and discarded the mode/size/mtime it had successfully obtained.
 */
function fileSnapshot(path: string, includeHash = false): AuthBondFileSnapshot {
  const absent = (error: string | null): AuthBondFileSnapshot => ({
    path,
    exists: false,
    mode: null,
    size: null,
    mtime: null,
    sha256: null,
    error,
  });

  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    // ENOENT is the only code that means "not there"; anything else is a fault
    // we could not see past, so it is reported as such rather than as absence.
    return absent(isVanishedEntry(err) ? null : errnoCode(err));
  }

  const base = {
    path,
    exists: true,
    mode: modeString(st.mode),
    size: st.size,
    mtime: st.mtime.toISOString(),
  };

  if (!includeHash || !st.isFile() || st.isSymbolicLink()) {
    return { ...base, sha256: null, error: null };
  }

  try {
    return { ...base, sha256: hashBuffer(readFileSync(path)), error: null };
  } catch (err) {
    // The file demonstrably exists — lstat just returned for it. Keep the
    // metadata that succeeded and report why the content could not be hashed.
    return { ...base, sha256: null, error: errnoCode(err) };
  }
}

// #2292 L2 — unguarded by name: every call site wraps this in its own
// try/catch (auth-bond.ts:481,517,616,919 verified), so the throw-on-invalid
// contract is already load-bearing, not accidental. Renamed rather than
// guarded internally so the contract is legible at the call site instead of
// depending on caller discipline that happened to already be correct.
function readJsonOrThrow(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

function extractMeHash(parsed: unknown): string | null {
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
 * True only for "the entry is no longer there" — Baileys rotates key files
 * constantly, so an entry can disappear between the readdir that listed it and
 * the stat/read that consumes it.
 *
 * ENOENT only, on purpose. EACCES means the tree is genuinely unreadable and
 * EIO means the disk is failing; both are real faults that must keep
 * propagating. A blanket `catch { continue }` here would convert them into a
 * silently short auth-tree observation.
 */
function isVanishedEntry(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/**
 * errno of a filesystem rejection, defaulting to EIO when the thrown value
 * carries no code — an unlabelled failure is still a failure, and returning
 * null there would make it indistinguishable from success.
 */
function errnoCode(err: unknown): string {
  return (err as NodeJS.ErrnoException | null)?.code ?? 'EIO';
}

export interface AuthTreeObservation {
  treeHash: string;
  fileCount: number;
  totalBytes: number;
}

/**
 * Entries processed between yields.
 *
 * The tree walks exist in exactly one implementation each, written as
 * generators, because two of the properties they carry are load-bearing and
 * cannot be allowed to drift between a sync and an async copy: the digest byte
 * format (a mismatch silently breaks tamper detection against a recorded
 * baseline) and the `complete: false` fail-closed rule. Driving the same
 * generator two ways makes divergence impossible rather than merely tested for.
 *
 * 64 keeps a slice at roughly a millisecond for Baileys key files, so a
 * yielding drive of the 17,680-file `personal` tree never holds the loop for
 * anything close to the 250 ms starvation threshold.
 */
const AUTH_TREE_YIELD_EVERY = 64;

type AuthTreeSteps<T> = Generator<void, T, void>;

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
async function drainYielding<T>(steps: AuthTreeSteps<T>): Promise<T> {
  for (;;) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    const step = steps.next();
    if (step.done) return step.value;
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
  let sinceYield = 0;
  while (stack.length > 0) {
    if (++sinceYield >= AUTH_TREE_YIELD_EVERY) { sinceYield = 0; yield; }
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
function* inspectAuthTreeSteps(authDir: string): AuthTreeSteps<AuthTreeObservation | null> {
  if (!existsSync(authDir)) return null;
  const { paths, complete } = yield* walkAuthFilesSteps(authDir);
  if (!complete) return null;
  const hasher = createHash('sha256');
  let totalBytes = 0;
  let sinceYield = 0;
  for (const path of paths) {
    if (++sinceYield >= AUTH_TREE_YIELD_EVERY) { sinceYield = 0; yield; }
    const rel = relative(authDir, path);
    // stat and read together: a file that survived the stat can still be
    // renamed away before the read, so both halves need the same allowance.
    let st;
    let contents;
    try {
      st = lstatSync(path);
      contents = readFileSync(path);
    } catch (err) {
      if (isVanishedEntry(err)) return null;
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

function inspectAuthTree(authDir: string): AuthTreeObservation | null {
  return drainSync(inspectAuthTreeSteps(authDir));
}

function copyPrivateTree(src: string, dst: string): void {
  const st = lstatSync(src);
  if (st.isDirectory()) {
    mkdirSync(dst, { recursive: true, mode: 0o700 });
    chmodSync(dst, 0o700);
    for (const entry of readdirSync(src)) {
      if (entry === '.DS_Store') continue;
      copyPrivateTree(join(src, entry), join(dst, entry));
    }
    return;
  }
  if (st.isSymbolicLink()) {
    throw privateWriteError(`refusing to copy auth tree containing symlink: ${src}`, 'ELOOP');
  }
  copyFileSync(src, dst);
  chmodSync(dst, 0o600);
}

function* hardenPrivateTreeSteps(root: string): AuthTreeSteps<string[]> {
  if (!existsSync(root)) return [];
  const issues: string[] = [];
  const stack = [root];
  let sinceYield = 0;
  while (stack.length > 0) {
    if (++sinceYield >= AUTH_TREE_YIELD_EVERY) { sinceYield = 0; yield; }
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

function hardenPrivateTree(root: string): string[] {
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

function writePrivateJson(path: string, value: unknown): void {
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
    try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

function authTreeValidationError(
  authDir: string,
  expected: { credsHash?: string | null; meHash?: string | null; treeHash?: string | null },
  prefix: string,
): string | null {
  const symlinkIssues = hardenPrivateTree(authDir).filter(issue => issue.startsWith('auth_tree_symlink:'));
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

  const treeHash = inspectAuthTree(authDir)?.treeHash ?? null;
  if (!treeHash) return `${prefix} auth tree is unreadable`;
  if (expected.treeHash && treeHash !== expected.treeHash) {
    return `${prefix} auth tree hash mismatch`;
  }
  return null;
}

function validateCopiedAuthTree(authDir: string, expected: AuthBondSnapshot): string | null {
  return authTreeValidationError(authDir, {
    credsHash: expected.creds.sha256,
    meHash: expected.meHash,
    treeHash: expected.treeHash,
  }, 'copied');
}

function readLatestManifest(path: string): LatestManifest | null {
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
const pathIsInside = pathIsInsideRoot;

export class AuthBondGuard {
  private readonly authDir: string;
  private readonly instanceName: string;
  private readonly now: () => Date;
  private readonly keepBackups: number;
  private readonly maxHistoryFiles: number;
  private readonly autoRestore: boolean;
  private readonly captureAttempts: number;
  private readonly captureRetryDelayMs: number;
  private readonly captureBlockReason: () => string | null;
  private readonly freshInvalidGraceMs: number;
  private readonly root: string;
  private readonly stateRoot: string;
  private readonly historyRoot: string;
  private readonly stagingRoot: string;
  private readonly latestManifestPath: string;
  private readonly treeCacheMaxAgeMs: number;
  private treeObservation: AuthBondTreeObservation | null = null;
  private treeRefresh: Promise<void> | null = null;
  private treeRefreshCount = 0;
  /** Bumped by every invalidation so a walk started before one cannot publish over it. */
  private treeGeneration = 0;
  private lastTreeInvalidationReason: string | null = null;
  private lastCaptureAt: string | null = null;
  private lastCaptureReason: string | null = null;
  private lastCaptureError: string | null = null;
  private lastCaptureDeferredAt: string | null = null;
  private lastCaptureDeferredReason: string | null = null;
  private lastCaptureDeferredAgeMs: number | null = null;
  private lastRestoreAt: string | null = null;
  private lastRestoreSource: string | null = null;
  private lastRestoreError: string | null = null;
  private lastSweepError: string | null = null;

  constructor(options: AuthBondGuardOptions) {
    this.authDir = options.authDir;
    this.instanceName = safeName(options.instanceName);
    this.now = options.now ?? (() => new Date());
    this.keepBackups = options.keepBackups ?? DEFAULT_KEEP_BACKUPS;
    this.maxHistoryFiles = Math.max(2, options.maxHistoryFiles ?? DEFAULT_MAX_HISTORY_FILES);
    this.autoRestore = options.autoRestore ?? true;
    this.captureAttempts = Math.max(1, options.captureAttempts ?? DEFAULT_CAPTURE_ATTEMPTS);
    this.captureRetryDelayMs = Math.max(0, options.captureRetryDelayMs ?? DEFAULT_CAPTURE_RETRY_DELAY_MS);
    this.captureBlockReason = options.captureBlockReason ?? (() => null);
    this.freshInvalidGraceMs = Math.max(0, options.freshInvalidGraceMs ?? DEFAULT_FRESH_INVALID_GRACE_MS);
    const stateRoot = options.stateRoot && options.stateRoot.trim() !== ''
      ? options.stateRoot
      : join(dirname(options.authDir), '..', 'state');
    this.stateRoot = stateRoot;
    this.root = join(stateRoot, 'auth-bond-backups', this.instanceName);
    this.historyRoot = join(this.root, 'history');
    this.stagingRoot = join(this.root, 'staging');
    this.latestManifestPath = join(this.root, 'latest.json');
    this.treeCacheMaxAgeMs = Math.max(0, options.treeCacheMaxAgeMs ?? DEFAULT_TREE_CACHE_MAX_AGE_MS);
  }

  /**
   * Full live inspection: both tree walks run inline, on this thread, now.
   *
   * This is the contract every restore, capture and verification path depends
   * on, so it is deliberately NOT cached — a stale tree hash there would turn a
   * fail-closed tamper check into a fail-open one. Observability readers want
   * inspectCached() instead.
   */
  inspect(): AuthBondSnapshot {
    return this.buildSnapshot(hardenPrivateTree(this.authDir), () => inspectAuthTree(this.authDir));
  }

  /**
   * Observability read: never walks the tree on the calling thread.
   *
   * The cheap half of a snapshot (two lstats and one small creds.json read)
   * still runs live, so a deleted or corrupted creds.json is reported at once.
   * Only the two full-tree walks come from cache, because those are the ones
   * that cost ~400 ms on an instance carrying 17,680 key files, and they were
   * being paid on every single GET /health.
   */
  inspectCached(): AuthBondSnapshot {
    const observation = this.treeObservation;
    const ageMs = observation === null ? null : Math.max(0, Date.now() - observation.observedAtMs);
    if (observation === null || (ageMs !== null && ageMs >= this.treeCacheMaxAgeMs)) {
      void this.refreshTreeCache();
    }
    return this.buildSnapshot(
      observation?.hardenIssues ?? [],
      () => observation?.tree ?? null,
      {
        source: observation === null ? 'absent' : 'cached',
        ageMs,
        // Assigned synchronously by refreshTreeCache, so a refresh started
        // immediately above is already visible here.
        refreshInFlight: this.treeRefresh !== null,
        refreshCount: this.treeRefreshCount,
        lastInvalidationReason: this.lastTreeInvalidationReason,
      },
    );
  }

  /**
   * Drop the cached walk so the next read starts a fresh one.
   *
   * Called from the events that are known to change the tree — a saved
   * creds.json and a captured auth-bond snapshot. Events cannot cover every
   * change (nothing emits when a file is planted by hand), which is what
   * treeCacheMaxAgeMs is for.
   */
  invalidateTreeCache(reason: string): void {
    this.treeObservation = null;
    this.treeGeneration += 1;
    this.lastTreeInvalidationReason = reason;
  }

  /** Complete a refresh. Callers that need a digest present before proceeding await this. */
  async warmTreeCache(): Promise<void> {
    // A refresh already in flight may be superseded by an invalidation and
    // discard its result, leaving no observation behind. One retry covers that
    // without looping forever on a walk that genuinely cannot complete.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.refreshTreeCache();
      if (this.treeObservation !== null) return;
    }
  }

  private refreshTreeCache(): Promise<void> {
    const inFlight = this.treeRefresh;
    if (inFlight !== null) return inFlight;
    const generation = this.treeGeneration;
    const run = (async (): Promise<void> => {
      try {
        const hardenIssues = await drainYielding(hardenPrivateTreeSteps(this.authDir));
        // walkAuthFilesSteps throws on a symlink rather than reporting it, and
        // the harden pass has already recorded that same condition as an issue.
        // Skipping the digest walk here mirrors inspect(), where a symlink
        // forces status away from 'present' and the tree is never walked.
        const tree = hardenIssues.some(issue => issue.startsWith('auth_tree_symlink:'))
          ? null
          : await drainYielding(inspectAuthTreeSteps(this.authDir));
        // A refresh is single-flight, so an invalidation landing mid-walk would
        // otherwise be erased: this walk would finish and stamp a fresh
        // observedAtMs over the null, hiding the change until the max age
        // expired. Discarding a superseded walk keeps the cache absent instead,
        // which the next read turns into a new refresh.
        if (generation !== this.treeGeneration) return;
        this.treeObservation = { hardenIssues, tree, observedAtMs: Date.now() };
        this.treeRefreshCount += 1;
      } catch {
        // Keep the last known observation and let the next read retry. A failed
        // refresh must never propagate: its only caller is a fire-and-forget
        // `void` from a read path, where a rejection becomes an unhandled
        // rejection and main.ts turns that into an instance shutdown.
      } finally {
        this.treeRefresh = null;
      }
    })();
    this.treeRefresh = run;
    return run;
  }

  private buildSnapshot(
    hardenIssues: readonly string[],
    readTree: () => AuthTreeObservation | null,
    treeProvenance?: AuthBondTreeProvenance,
  ): AuthBondSnapshot {
    const credsPath = join(this.authDir, 'creds.json');
    const issues: string[] = [];
    issues.push(...hardenIssues);
    const authDir = fileSnapshot(this.authDir);
    const creds = fileSnapshot(credsPath, true);
    let status: AuthBondStatus = 'present';
    let meHash: string | null = null;
    const hasSymlinkIssue = issues.some(issue => issue.startsWith('auth_tree_symlink:'));

    // An errno means the path could not be READ, which is not the same as it
    // not being there. The distinction is the operator's next move: 'missing'
    // says re-pair (destructive), 'unreadable' says fix a mode or a disk.
    // Classified ahead of the content checks below, which would otherwise read
    // the null hash of an unread file as "empty" or as a hash mismatch.
    const authDirUnreadable = authDir.error !== null;
    const credsUnreadable = creds.error !== null;

    if (authDirUnreadable) {
      status = 'invalid';
      issues.push(`auth_dir_unreadable:${authDir.error}`);
    } else if (!authDir.exists) {
      status = 'missing';
      issues.push('auth_dir_missing');
    }
    if (credsUnreadable) {
      status = 'invalid';
      issues.push(`creds_json_unreadable:${creds.error}`);
    } else if (!creds.exists) {
      status = 'missing';
      issues.push('creds_json_missing');
    }
    if (hasSymlinkIssue) {
      status = 'invalid';
    }
    if (creds.exists && !credsUnreadable && !hasSymlinkIssue) {
      if (creds.size === 0 || creds.sha256 === EMPTY_SHA256) {
        status = 'invalid';
        issues.push('creds_json_empty');
      } else {
        try {
          const parsed = readJsonOrThrow(credsPath);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            status = 'invalid';
            issues.push('creds_json_not_object');
          } else {
            meHash = extractMeHash(parsed);
            if (!meHash) {
              status = 'invalid';
              issues.push('creds_json_missing_me');
            }
          }
        } catch {
          status = 'invalid';
          issues.push('creds_json_invalid_json');
        }
      }
    }

    const tree = status === 'present' ? readTree() : null;
    return {
      status,
      authDir,
      creds,
      meHash,
      treeHash: tree?.treeHash ?? null,
      fileCount: tree?.fileCount ?? null,
      totalBytes: tree?.totalBytes ?? null,
      backup: this.backupSnapshot(),
      issues,
      ...(treeProvenance ? { treeProvenance } : {}),
    };
  }

  capture(reason: string): AuthBondCaptureResult {
    let lastResult: AuthBondCaptureResult | null = null;
    for (let attempt = 1; attempt <= this.captureAttempts; attempt += 1) {
      lastResult = this.captureOnce(reason);
      if (lastResult.ok || !lastResult.deferred || attempt === this.captureAttempts) return lastResult;
      sleepSync(this.captureRetryDelayMs);
    }
    return lastResult!;
  }

  private captureOnce(reason: string): AuthBondCaptureResult {
    const snapshot = this.inspect();
    const blockedReason = this.captureBlockReason();
    if (blockedReason) {
      this.lastCaptureAt = this.now().toISOString();
      this.lastCaptureReason = reason;
      this.lastCaptureError = `auth bond capture blocked: ${blockedReason}`;
      return { ok: false, snapshot: this.inspect(), captured: false, deferred: false, path: null, error: this.lastCaptureError };
    }
    if (snapshot.status !== 'present' || !snapshot.treeHash) {
      const freshAgeMs = this.freshInvalidCredentialAgeMs(snapshot);
      if (freshAgeMs !== null && freshAgeMs < this.freshInvalidGraceMs) {
        return this.deferFreshInvalidCapture(reason, freshAgeMs, 'auth bond credential write still in flight');
      }
      this.lastCaptureAt = this.now().toISOString();
      this.lastCaptureReason = reason;
      this.lastCaptureError = `auth bond is ${snapshot.status}: ${snapshot.issues.join(',')}`;
      return { ok: false, snapshot: this.inspect(), captured: false, deferred: false, path: null, error: this.lastCaptureError };
    }

    let tmp: string | null = null;
    let publishedTarget: string | null = null;
    try {
      forceEnsurePrivateDirectorySync(this.root, 'auth-bond backup root directory');
      forceEnsurePrivateDirectorySync(this.historyRoot, 'auth-bond backup history directory');
      forceEnsurePrivateDirectorySync(this.stagingRoot, 'auth-bond backup staging directory');
      this.sweepOrphanedStaging();

      const latest = readLatestManifest(this.latestManifestPath);
      if (
        latest?.treeHash === snapshot.treeHash
        && latest.backupPath
        && this.backupPathProblem(latest.backupPath) === null
      ) {
        this.lastCaptureAt = this.now().toISOString();
        this.lastCaptureReason = reason;
        this.lastCaptureError = null;
        return { ok: true, snapshot: this.inspect(), captured: false, deferred: false, path: latest.backupPath, error: null };
      }

      const createdAt = this.now();
      const dirName = `${isoForFileName(createdAt)}.${safeName(reason)}.${snapshot.treeHash.slice(0, 16)}`;
      const target = join(this.historyRoot, dirName);
      tmp = join(this.stagingRoot, `${dirName}.tmp-${process.pid}`);
      rmSync(tmp, { recursive: true, force: true });
      mkdirSync(tmp, { recursive: true, mode: 0o700 });
      const copiedAuthDir = join(tmp, 'auth');
      copyPrivateTree(this.authDir, copiedAuthDir);
      const copiedAuthError = validateCopiedAuthTree(copiedAuthDir, snapshot);
      if (copiedAuthError) throw new Error(copiedAuthError);
      const manifest = {
        instanceName: this.instanceName,
        reason,
        createdAt: createdAt.toISOString(),
        authDir: this.authDir,
        treeHash: snapshot.treeHash,
        credsHash: snapshot.creds.sha256,
        meHash: snapshot.meHash,
      };
      writePrivateJson(join(tmp, 'manifest.json'), manifest);
      renameSync(tmp, target);
      publishedTarget = target;
      tmp = null;

      writePrivateJson(this.latestManifestPath, {
        backupPath: target,
        createdAt: createdAt.toISOString(),
        reason,
        treeHash: snapshot.treeHash,
      });
      publishedTarget = null;

      this.lastCaptureAt = createdAt.toISOString();
      this.lastCaptureReason = reason;
      this.lastCaptureError = null;
      this.pruneHistory(snapshot.fileCount);
      return { ok: true, snapshot: this.inspect(), captured: true, deferred: false, path: target, error: null };
    } catch (err) {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
      if (publishedTarget) rmSync(publishedTarget, { recursive: true, force: true });
      const freshSnapshot = this.inspect();
      const freshAgeMs = this.freshInvalidCredentialAgeMs(freshSnapshot);
      if (freshAgeMs !== null && freshAgeMs < this.freshInvalidGraceMs) {
        return this.deferFreshInvalidCapture(reason, freshAgeMs, 'auth bond changed during capture');
      }
      this.lastCaptureAt = this.now().toISOString();
      this.lastCaptureReason = reason;
      this.lastCaptureError = errorMessage(err);
      return { ok: false, snapshot: this.inspect(), captured: false, deferred: false, path: null, error: this.lastCaptureError };
    }
  }

  private freshInvalidCredentialAgeMs(snapshot: AuthBondSnapshot): number | null {
    if (snapshot.status === 'present') return null;
    if (!snapshot.creds.exists || !snapshot.creds.mtime) return null;
    if (!snapshot.issues.some(issue => issue === 'creds_json_empty' || issue === 'creds_json_invalid_json')) {
      return null;
    }
    const mtime = Date.parse(snapshot.creds.mtime);
    if (!Number.isFinite(mtime)) return null;
    return Math.max(0, this.now().getTime() - mtime);
  }

  private deferFreshInvalidCapture(
    reason: string,
    ageMs: number,
    message: string,
  ): AuthBondCaptureResult {
    this.lastCaptureDeferredAt = this.now().toISOString();
    this.lastCaptureDeferredReason = reason;
    this.lastCaptureDeferredAgeMs = ageMs;
    return {
      ok: false,
      snapshot: this.inspect(),
      captured: false,
      deferred: true,
      path: null,
      error: `${message}: age_ms=${ageMs}`,
    };
  }

  restoreLatestIfNeeded(): AuthBondRestoreResult {
    const before = this.inspect();
    if (before.status === 'present') {
      return { attempted: false, restored: false, source: null, snapshot: before, error: null };
    }
    if (!this.autoRestore) {
      return { attempted: false, restored: false, source: null, snapshot: before, error: 'auto-restore disabled' };
    }

    const latest = readLatestManifest(this.latestManifestPath);
    const latestBackupPath = latest?.backupPath ?? null;
    const source = latestBackupPath ? join(latestBackupPath, 'auth') : null;
    if (latestBackupPath) {
      const latestProblem = this.backupPathProblem(latestBackupPath);
      if (latestProblem) {
        this.lastRestoreAt = this.now().toISOString();
        this.lastRestoreSource = latestBackupPath;
        this.lastRestoreError = latestProblem;
        return {
          attempted: true,
          restored: false,
          source: latestBackupPath,
          snapshot: this.inspect(),
          error: latestProblem,
        };
      }
    }
    if (!source || !existsSync(source)) {
      const error = 'no auth-bond backup available';
      this.lastRestoreAt = this.now().toISOString();
      this.lastRestoreSource = null;
      this.lastRestoreError = error;
      return { attempted: true, restored: false, source: null, snapshot: this.inspect(), error };
    }
    const backupError = this.validateBackupForRestore(latestBackupPath!, latest);
    if (backupError) {
      this.lastRestoreAt = this.now().toISOString();
      this.lastRestoreSource = latestBackupPath;
      this.lastRestoreError = backupError;
      return {
        attempted: true,
        restored: false,
        source: latestBackupPath,
        snapshot: this.inspect(),
        error: backupError,
      };
    }

    // Terminal-latch gate: while a terminal revocation latch is active, restore
    // authority comes only from the CANDIDATE's own manifest + V2 generation
    // receipt (exact digest binding). Unbound legacy backups, the exact revoked
    // tree, and corrupt/ambiguous state all refuse — before any mutation.
    const latchState = readTerminalLatchJournal(this.stateRoot);
    const latchDecision = decideRestoreFromCandidate(
      latchState,
      readRestoreCandidateEvidence(latestBackupPath!),
    );
    if (!latchDecision.allow) {
      const error = `terminal_latch_refused:${latchDecision.refusal}`;
      this.lastRestoreAt = this.now().toISOString();
      this.lastRestoreSource = latestBackupPath;
      this.lastRestoreError = error;
      return {
        attempted: true,
        restored: false,
        source: latestBackupPath,
        snapshot: this.inspect(),
        error,
      };
    }

    forceEnsurePrivateDirectorySync(this.root, 'auth-bond backup root directory');
    const restoredAt = this.now();
    const quarantineRoot = join(this.root, 'quarantine');
    forceEnsurePrivateDirectorySync(quarantineRoot, 'auth-bond quarantine directory');
    const quarantine = join(
      quarantineRoot,
      `${isoForFileName(restoredAt)}.${safeName(basename(this.authDir))}.broken`,
    );
    const tmp = `${this.authDir}.restore-${process.pid}`;
    let movedOriginal = false;

    try {
      rmSync(tmp, { recursive: true, force: true });
      if (existsSync(this.authDir)) {
        renameSync(this.authDir, quarantine);
        movedOriginal = true;
      } else {
        forceEnsurePrivateDirectorySync(dirname(this.authDir), 'auth parent directory');
      }
      copyPrivateTree(source, tmp);
      const copiedAuthError = this.validateAuthTreeAgainstBackupManifest(tmp, latestBackupPath!, latest, 'copied');
      if (copiedAuthError) throw new Error(copiedAuthError);
      renameSync(tmp, this.authDir);
      this.lastRestoreAt = restoredAt.toISOString();
      this.lastRestoreSource = latestBackupPath;
      this.lastRestoreError = null;
      return {
        attempted: true,
        restored: true,
        source: latestBackupPath,
        snapshot: this.inspect(),
        error: null,
      };
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true });
      if (movedOriginal && !existsSync(this.authDir)) {
        try {
          renameSync(quarantine, this.authDir);
        } catch {
          // Preserve the original failure; the alert evidence includes the quarantine path.
        }
      }
      const error = errorMessage(err);
      this.lastRestoreAt = restoredAt.toISOString();
      this.lastRestoreSource = latestBackupPath;
      this.lastRestoreError = `${error}; quarantine=${quarantine}`;
      return {
        attempted: true,
        restored: false,
        source: latestBackupPath,
        snapshot: this.inspect(),
        error: this.lastRestoreError,
      };
    }
  }

  private backupSnapshot(): AuthBondBackupSnapshot {
    const latest = readLatestManifest(this.latestManifestPath);
    const latestPath = latest?.backupPath && this.backupPathProblem(latest.backupPath) === null ? latest.backupPath : null;
    return {
      root: this.root,
      latest: latestPath,
      latestAt: latest?.createdAt ?? null,
      latestReason: latest?.reason ?? null,
      latestTreeHash: latest?.treeHash ?? null,
      lastCaptureAt: this.lastCaptureAt,
      lastCaptureReason: this.lastCaptureReason,
      lastCaptureError: this.lastCaptureError,
      lastCaptureDeferredAt: this.lastCaptureDeferredAt,
      lastCaptureDeferredReason: this.lastCaptureDeferredReason,
      lastCaptureDeferredAgeMs: this.lastCaptureDeferredAgeMs,
      lastRestoreAt: this.lastRestoreAt,
      lastRestoreSource: this.lastRestoreSource,
      lastRestoreError: this.lastRestoreError,
      lastSweepError: this.lastSweepError,
    };
  }

  private validateBackupForRestore(backupPath: string, latest: LatestManifest | null): string | null {
    const pathProblem = this.backupPathProblem(backupPath);
    if (pathProblem) return pathProblem;
    return this.validateAuthTreeAgainstBackupManifest(join(backupPath, 'auth'), backupPath, latest, 'backup');
  }

  private validateAuthTreeAgainstBackupManifest(
    authDir: string,
    backupPath: string,
    latest: LatestManifest | null,
    prefix: string,
  ): string | null {
    const manifestPath = join(backupPath, 'manifest.json');
    let manifest: BackupManifest;
    try {
      const parsed = readJsonOrThrow(manifestPath);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return `backup manifest is not an object: ${manifestPath}`;
      }
      manifest = parsed as BackupManifest;
    } catch (err) {
      return `backup manifest is unreadable: ${manifestPath}: ${errorMessage(err)}`;
    }

    if (manifest.instanceName && safeName(manifest.instanceName) !== this.instanceName) {
      return `backup instance mismatch: manifest=${safeName(manifest.instanceName)} expected=${this.instanceName}`;
    }
    if (latest?.treeHash && manifest.treeHash && latest.treeHash !== manifest.treeHash) {
      return 'latest pointer tree hash does not match backup manifest';
    }

    return authTreeValidationError(authDir, {
      credsHash: manifest.credsHash,
      meHash: manifest.meHash,
      treeHash: manifest.treeHash,
    }, prefix);
  }

  private backupPathProblem(backupPath: string): string | null {
    if (!pathIsInside(this.historyRoot, backupPath)) {
      return `backup path escapes history root: ${backupPath}`;
    }
    try {
      const st = lstatSync(backupPath);
      if (st.isSymbolicLink()) return `backup path is a symlink: ${backupPath}`;
      if (!st.isDirectory()) return `backup path is not a directory: ${backupPath}`;
    } catch (err) {
      return `backup path is unreadable: ${backupPath}: ${errorMessage(err)}`;
    }
    return null;
  }

  /**
   * Remove orphaned staging temp dirs (`<name>.tmp-<pid>`) left behind when a
   * process is SIGKILLed mid-capture. Staging only ever holds in-progress temp
   * copies — never the published backups (those live under historyRoot/latest) —
   * so deleting a dead process's leftovers is always safe and prevents
   * credential-bearing residue from accumulating on disk (#1076/#1078).
   * The current process's own in-flight staging (`.tmp-<our pid>`) is preserved.
   */
  private sweepOrphanedStaging(): void {
    if (!existsSync(this.stagingRoot)) return;
    let entries: string[];
    try {
      entries = readdirSync(this.stagingRoot);
    } catch (err) {
      // Record the sweep failure so it surfaces in the backup snapshot /
      // health status instead of silently abandoning staging cleanup (#2289 M4).
      // Every subsequent capture deposits another credential-tree copy under
      // staging/ if the sweep never runs, so this must be visible to operators.
      this.lastSweepError = `staging sweep failed: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }
    this.lastSweepError = null;
    const ownSuffix = `.tmp-${process.pid}`;
    for (const name of entries) {
      if (!isHistoryStagingDirName(name) || name.endsWith(ownSuffix)) continue;
      rmSync(join(this.stagingRoot, name), { recursive: true, force: true });
    }
  }

  private pruneHistory(snapshotFileCount: number | null): void {
    if (this.keepBackups <= 0 || !existsSync(this.historyRoot)) return;
    const fileBound = snapshotFileCount && snapshotFileCount > 0
      ? Math.max(2, Math.floor(this.maxHistoryFiles / snapshotFileCount))
      : this.keepBackups;
    const retainedBackups = Math.min(this.keepBackups, fileBound);
    const entries = readdirSync(this.historyRoot)
      .filter(name => !isHistoryStagingDirName(name))
      .map(name => join(this.historyRoot, name))
      .filter(path => {
        try {
          return lstatSync(path).isDirectory();
        } catch {
          return false;
        }
      })
      .sort()
      .reverse();
    for (const stale of entries.slice(retainedBackups)) {
      rmSync(stale, { recursive: true, force: true });
    }
  }
}
