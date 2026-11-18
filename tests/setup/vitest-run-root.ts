import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

// One temporary root per Vitest run (Vitest globalSetup).
//
// Each test file gets a fresh fork worker, and bot-errors-vitest-isolation.ts
// makes a `ws-vh-*` HOME for it. Vitest ends a worker with SIGTERM (then
// SIGKILL after 500 ms) once its file is done, and Node does not emit `exit`
// on a signal death, so a worker whose afterAll did not run or failed
// (collection-only passes, bailed files, a child still writing into the
// worker's tmp) left its HOME behind. This module runs in the main Vitest
// process, which outlives every worker: setup creates the run root and exports
// it before any worker forks (Vitest builds the worker environment from
// process.env when it schedules the files), and teardown removes the run root
// with every worker HOME still inside it.
export const RUN_ROOT_ENV = 'WHATSOUP_VITEST_RUN_ROOT';
export const RUN_ROOT_PREFIX = 'ws-vr-';
export const RUN_ROOT_MARKER = '.whatsoup-vitest-run-root';

// Retries cover ENOTEMPTY/EBUSY from a process that is still writing into a
// tree while it is removed.
export const REMOVE_RETRY = { maxRetries: 5, retryDelay: 100 } as const;

// The run root gets a longer bounded window: a child process that a test file
// left running may still write into a worker HOME when the run ends. Node backs
// off linearly, so ten retries wait at most 5.5 s in total.
export const RUN_ROOT_REMOVE_RETRY = { maxRetries: 10, retryDelay: 100 } as const;

// /tmp, not os.tmpdir(): the macOS per-user TMPDIR is long enough to push
// test socket paths past the 104-byte sun_path limit.
export function defaultTempParent(): string {
  return realpathSync('/tmp');
}

function isMarkedRunRoot(root: string, token?: string): boolean {
  if (!isAbsolute(root)) return false;
  try {
    const stat = lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(root) !== root) return false;
    const marker = readFileSync(join(root, RUN_ROOT_MARKER), 'utf8');
    return token === undefined ? marker.length > 0 : marker === token;
  } catch {
    return false;
  }
}

// The directory a worker creates its `ws-vh-*` HOME in, which is also the
// containment root its cleanup checks against: the run root when a marked one
// is exported, else /tmp. A nested run whose config lacks this globalSetup still
// inherits the parent run's root through its environment and nests there; only
// a run with no exported root uses /tmp.
export function resolveWorkerTempRoot(env: NodeJS.ProcessEnv = process.env): string {
  const runRoot = env[RUN_ROOT_ENV];
  if (runRoot === undefined || runRoot === '') return defaultTempParent();
  if (!isMarkedRunRoot(runRoot)) {
    throw new Error(`${RUN_ROOT_ENV} is set but does not name a marked Vitest run root: ${runRoot}`);
  }
  return runRoot;
}

export type RemoveTree = (root: string) => void;

function removeTree(root: string): void {
  rmSync(root, { recursive: true, force: true, ...RUN_ROOT_REMOVE_RETRY });
}

// Never throws. A refused or failed removal, or a root that is still present
// afterwards, is reported on stderr and returns false; the caller fails the run.
export function removeRunRoot(root: string, token: string, remove: RemoveTree = removeTree): boolean {
  if (!isMarkedRunRoot(root, token)) {
    process.stderr.write(`vitest-run-root: refusing to remove ${root}: not this run's marked root\n`);
    return false;
  }
  try {
    remove(root);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`vitest-run-root: could not remove ${root}: ${reason}\n`);
    return false;
  }
  if (lstatSync(root, { throwIfNoEntry: false }) !== undefined) {
    process.stderr.write(`vitest-run-root: ${root} is still present after removal\n`);
    return false;
  }
  return true;
}

export interface RunRootOptions {
  // Test seam: the tree removal, so a removal that keeps failing is reproducible.
  remove?: RemoveTree;
}

// Vitest only logs an error thrown by a globalSetup teardown and still exits 0,
// so a run that leaves its root behind sets the exit status itself. An earlier
// failure keeps its own status.
function failRunClosed(): void {
  if (!process.exitCode) process.exitCode = 1;
}

export function startRunRoot(parent: string = defaultTempParent(), options: RunRootOptions = {}): () => void {
  const previous = process.env[RUN_ROOT_ENV];
  const root = realpathSync(mkdtempSync(join(parent, RUN_ROOT_PREFIX)));
  chmodSync(root, 0o700);
  const token = randomUUID();
  writeFileSync(join(root, RUN_ROOT_MARKER), token, { mode: 0o600 });
  process.env[RUN_ROOT_ENV] = root;

  // Only a removal that worked ends the attempts. Until then the exit hook stays
  // registered, so a root that teardown could not remove gets one more try.
  let removed = false;
  const reap = (): boolean => {
    if (!removed) removed = removeRunRoot(root, token, options.remove);
    return removed;
  };
  // Vitest ends the main process with process.exit() on SIGINT/SIGTERM, which
  // skips teardown but still emits `exit`.
  const reapAtExit = (): void => {
    if (!reap()) failRunClosed();
  };
  process.once('exit', reapAtExit);

  return () => {
    try {
      if (reap()) process.off('exit', reapAtExit);
      else failRunClosed();
    } finally {
      if (previous === undefined) delete process.env[RUN_ROOT_ENV];
      else process.env[RUN_ROOT_ENV] = previous;
    }
  };
}

export default function setup(): () => void {
  return startRunRoot();
}
