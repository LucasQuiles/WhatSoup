/**
 * The auth-bond tree walks, tree copy and private JSON write, written once as
 * step generators and driven either inline (drainSync) or off the event loop
 * (drainYielding). Split out of auth-bond.ts, which owns the policy built on
 * them: snapshot status, capture, restore and retention.
 */
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
  type Stats,
} from 'node:fs';
import * as fsp from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { forceEnsurePrivateDirectorySync, fsyncDirectory, privateWriteError } from '../lib/private-fs.ts';
import { errorMessage } from '../lib/error-message.ts';
import { isVanishedEntry, modeString } from './auth-bond-files.ts';

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
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

/**
 * The asynchronous filesystem captureAsync() runs its requests on.
 *
 * A seam, not configuration: production always uses AUTH_BOND_CAPTURE_FS
 * (node:fs/promises), and tests substitute one operation to slow it down or
 * make one stage fail.
 */
export interface AuthBondCaptureFs {
  lstat(path: string): Promise<Stats>;
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<Buffer>;
  /** Recursive. */
  mkdir(path: string, mode: number): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  copyFile(src: string, dst: string): Promise<void>;
  /** Recursive and forced, as rmSync(path, { recursive: true, force: true }). */
  rm(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  open(path: string, flags: 'wx' | 'r', mode?: number): Promise<FileHandle>;
  unlink(path: string): Promise<void>;
}

export const AUTH_BOND_CAPTURE_FS: AuthBondCaptureFs = Object.freeze({
  lstat: (path: string) => fsp.lstat(path),
  readdir: (path: string) => fsp.readdir(path),
  readFile: (path: string) => fsp.readFile(path),
  mkdir: async (path: string, mode: number) => { await fsp.mkdir(path, { recursive: true, mode }); },
  chmod: (path: string, mode: number) => fsp.chmod(path, mode),
  copyFile: (src: string, dst: string) => fsp.copyFile(src, dst),
  rm: (path: string) => fsp.rm(path, { recursive: true, force: true }),
  rename: (from: string, to: string) => fsp.rename(from, to),
  open: (path: string, flags: 'wx' | 'r', mode?: number) => fsp.open(path, flags, mode),
  unlink: (path: string) => fsp.unlink(path),
});

/**
 * One filesystem call handed out of a step generator.
 *
 * Every call a walk, copy or capture makes per tree entry, and every call that
 * writes or removes, goes out through one of these instead of being made
 * inline. drainSync runs `sync` on the spot, so inspect(), capture() and
 * restore make exactly the node:fs calls they made before, in the same order.
 * drainYielding given a filesystem runs `async` instead, which moves the I/O
 * onto the libuv threadpool: a slow disk then delays the capture, not the event
 * loop (#3677). The two halves of each request sit side by side in
 * `request` below so they cannot drift apart.
 */
export interface StepRequest<T = unknown> {
  sync(): T;
  async(fs: AuthBondCaptureFs, signal: AbortSignal | undefined): Promise<T>;
}

/**
 * `undefined` is a slice boundary; anything else is a filesystem request.
 *
 * A slice boundary is also the ONLY place an abort can land. Every boundary
 * sits outside any try block that swallows errors, so an abort can never be
 * mistaken for a filesystem fault and absorbed, and a request is never
 * interrupted, so the steps always know what they have written.
 */
export type AuthTreeSteps<T> = Generator<StepRequest | undefined, T, unknown>;

export type PrivateHandle = number | FileHandle;

export function* perform<T>(request: StepRequest<T>): AuthTreeSteps<T> {
  // Both drivers send back exactly the value this request produced.
  return (yield request as StepRequest) as T;
}

/**
 * Raised into a capture when it is cancelled or the guard is closed, and the
 * rejection captureAsync() settles with. Not a capture failure: no state about
 * the credential is recorded for it.
 */
export class AuthBondCaptureAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthBondCaptureAbortedError';
  }
}

function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (ms <= 0 || signal?.aborted === true) { resolve(); return; }
    const onAbort = (): void => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** One event-loop turn, cut short by an abort so a cancel never waits on a timer. */
function nextTurn(signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted === true) { resolve(); return; }
    const onAbort = (): void => { clearImmediate(immediate); resolve(); };
    const immediate = setImmediate(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Best-effort, as fsyncDirectory: the preceding file fsync is the durability guarantee. */
async function fsyncDirectoryAsync(fs: AuthBondCaptureFs, path: string): Promise<void> {
  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(path, 'r');
    await handle.sync();
  } catch {
    // Directory fsync is best-effort on some filesystems.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export const request = {
  lstat: (path: string): StepRequest<Stats> => ({
    sync: () => lstatSync(path),
    async: fs => fs.lstat(path),
  }),
  readdir: (path: string): StepRequest<string[]> => ({
    sync: () => readdirSync(path),
    async: fs => fs.readdir(path),
  }),
  readFile: (path: string): StepRequest<Buffer> => ({
    sync: () => readFileSync(path),
    async: fs => fs.readFile(path),
  }),
  mkdir: (path: string): StepRequest<void> => ({
    sync: () => { mkdirSync(path, { recursive: true, mode: 0o700 }); },
    async: fs => fs.mkdir(path, 0o700),
  }),
  chmod: (path: string, mode: number): StepRequest<void> => ({
    sync: () => chmodSync(path, mode),
    async: fs => fs.chmod(path, mode),
  }),
  copyFile: (src: string, dst: string): StepRequest<void> => ({
    sync: () => copyFileSync(src, dst),
    async: fs => fs.copyFile(src, dst),
  }),
  rename: (from: string, to: string): StepRequest<void> => ({
    sync: () => renameSync(from, to),
    async: fs => fs.rename(from, to),
  }),
  rm: (path: string): StepRequest<void> => ({
    sync: () => rmSync(path, { recursive: true, force: true }),
    async: fs => fs.rm(path),
  }),
  unlink: (path: string): StepRequest<void> => ({
    sync: () => unlinkSync(path),
    async: fs => fs.unlink(path),
  }),
  openNew: (path: string): StepRequest<PrivateHandle> => ({
    sync: () => openSync(path, 'wx', 0o600),
    async: fs => fs.open(path, 'wx', 0o600),
  }),
  // A handle only ever reaches the driver that opened it, so each half knows
  // which member of PrivateHandle it holds.
  write: (handle: PrivateHandle, data: string): StepRequest<void> => ({
    sync: () => writeFileSync(handle as number, data, 'utf-8'),
    async: () => (handle as FileHandle).writeFile(data, 'utf-8'),
  }),
  fsync: (handle: PrivateHandle): StepRequest<void> => ({
    sync: () => fsyncSync(handle as number),
    async: () => (handle as FileHandle).sync(),
  }),
  close: (handle: PrivateHandle): StepRequest<void> => ({
    sync: () => closeSync(handle as number),
    async: () => (handle as FileHandle).close(),
  }),
  fsyncDirectory: (path: string): StepRequest<void> => ({
    sync: () => fsyncDirectory(path),
    async: fs => fsyncDirectoryAsync(fs, path),
  }),
  // The sync half is the Atomics.wait the sync capture() always used. Only the
  // async half keeps the event loop running across a deferred-capture retry.
  delay: (ms: number): StepRequest<void> => ({
    sync: () => sleepSync(ms),
    async: (_fs, signal) => abortableDelay(ms, signal),
  }),
};

/** Run steps to completion inline. Behaviour identical to the pre-generator code. */
export function drainSync<T>(steps: AuthTreeSteps<T>): T {
  let step = steps.next();
  while (!step.done) {
    const pending = step.value;
    if (pending === undefined) {
      step = steps.next();
      continue;
    }
    let value: unknown;
    try {
      value = pending.sync();
    } catch (err) {
      // Raised AT the request, so the generator's own try/catch sees it
      // exactly where the inline call used to throw.
      step = steps.throw(err);
      continue;
    }
    step = steps.next(value);
  }
  // The return value lives on the final {done: true} result, never on the
  // intermediate ones a plain for..of would surface.
  return step.value;
}

interface YieldingDrainOptions {
  /** Run requests on this filesystem. Absent: run each inline, as drainSync does. */
  fs?: AuthBondCaptureFs;
  /** Raise `signal.reason` into the steps at their next slice boundary. */
  signal?: AbortSignal;
}

/**
 * Run steps while handing the event loop back between slices.
 *
 * The await comes BEFORE the first next(), so no part of the walk runs in the
 * caller's synchronous turn — the whole point is that a caller can start a
 * refresh without paying for any of it.
 *
 * An abort is delivered once, by throwing it into the steps at the slice
 * boundary where they are suspended, so their own catch blocks run their
 * cleanup. Requests between two boundaries always run to completion.
 */
export async function drainYielding<T>(steps: AuthTreeSteps<T>, options: YieldingDrainOptions = {}): Promise<T> {
  const { fs, signal } = options;
  let abortDelivered = false;
  const resumeAfterTurn = (): IteratorResult<StepRequest | undefined, T> => {
    if (abortDelivered || signal?.aborted !== true) return steps.next();
    abortDelivered = true;
    return steps.throw(signal.reason);
  };
  await nextTurn(signal);
  let step = resumeAfterTurn();
  while (!step.done) {
    const pending = step.value;
    if (pending === undefined) {
      await nextTurn(signal);
      step = resumeAfterTurn();
      continue;
    }
    let value: unknown;
    try {
      value = fs === undefined ? pending.sync() : await pending.async(fs, signal);
    } catch (err) {
      step = steps.throw(err);
      continue;
    }
    step = steps.next(value);
  }
  return step.value;
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
      st = yield* perform(request.lstat(current));
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
        entries = (yield* perform(request.readdir(current)))
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
export function* inspectAuthTreeSteps(authDir: string): AuthTreeSteps<AuthTreeObservation | null> {
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
      st = yield* perform(request.lstat(path));
      contents = yield* perform(request.readFile(path));
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

/**
 * Copy a tree with private modes: directories 0700, files 0600. A symlink
 * anywhere in it is refused rather than followed.
 *
 * `slice` is shared across the recursion so the copy offers a slice boundary
 * every AUTH_TREE_YIELD_EVERY entries of the WHOLE tree, not of each directory.
 */
export function* copyPrivateTreeSteps(
  src: string,
  dst: string,
  slice: { sinceYield: number } = { sinceYield: 0 },
): AuthTreeSteps<void> {
  if (++slice.sinceYield >= AUTH_TREE_YIELD_EVERY) { slice.sinceYield = 0; yield; }
  const st = yield* perform(request.lstat(src));
  if (st.isDirectory()) {
    yield* perform(request.mkdir(dst));
    yield* perform(request.chmod(dst, 0o700));
    for (const entry of yield* perform(request.readdir(src))) {
      if (entry === '.DS_Store') continue;
      yield* copyPrivateTreeSteps(join(src, entry), join(dst, entry), slice);
    }
    return;
  }
  if (st.isSymbolicLink()) {
    throw privateWriteError(`refusing to copy auth tree containing symlink: ${src}`, 'ELOOP');
  }
  yield* perform(request.copyFile(src, dst));
  yield* perform(request.chmod(dst, 0o600));
}

export function copyPrivateTree(src: string, dst: string): void {
  drainSync(copyPrivateTreeSteps(src, dst));
}

export function* hardenPrivateTreeSteps(root: string): AuthTreeSteps<string[]> {
  if (!existsSync(root)) return [];
  const issues: string[] = [];
  const stack = [root];
  let sinceYield = 0;
  while (stack.length > 0) {
    if (++sinceYield >= AUTH_TREE_YIELD_EVERY) { sinceYield = 0; yield; }
    const current = stack.pop()!;
    let st;
    try {
      st = yield* perform(request.lstat(current));
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
        yield* perform(request.chmod(current, desiredMode));
      } catch (err) {
        const rel = current === root ? '.' : relative(root, current);
        issues.push(`auth_mode_chmod_failed:${rel}:${errorMessage(err)}`);
      }
    }

    if (st.isDirectory()) {
      try {
        const entries = (yield* perform(request.readdir(current)))
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

export function assertPrivateJsonTarget(path: string): void {
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

/** Durable private write: 0600 temp file, fsync, rename over the target, fsync the directory. */
export function* writePrivateJsonSteps(path: string, value: unknown): AuthTreeSteps<void> {
  const dir = dirname(path);
  forceEnsurePrivateDirectorySync(dir, 'auth-bond json directory');
  assertPrivateJsonTarget(path);

  const tmpPath = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  let handle: PrivateHandle | null = null;
  try {
    handle = yield* perform(request.openNew(tmpPath));
    yield* perform(request.write(handle, JSON.stringify(value, null, 2)));
    yield* perform(request.fsync(handle));
    yield* perform(request.close(handle));
    handle = null;
    assertPrivateJsonTarget(path);
    yield* perform(request.rename(tmpPath, path));
    yield* perform(request.chmod(path, 0o600));
    yield* perform(request.fsyncDirectory(dir));
  } catch (err) {
    if (handle !== null) yield* perform(request.close(handle));
    try { yield* perform(request.unlink(tmpPath)); } catch { /* best-effort cleanup */ }
    throw err;
  }
}
