import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';

// One temporary root per Vitest run (Vitest globalSetup).
//
// Each test file gets a fresh fork worker, and bot-errors-vitest-isolation.ts
// makes a HOME for it in the run root. Vitest ends a worker with SIGTERM (then
// SIGKILL after 500 ms) once its file is done, and Node does not emit `exit`
// on a signal death, so a worker whose afterAll did not run or failed
// (collection-only passes, bailed files, a child still writing into the
// worker's tmp) left its HOME behind. This module runs in the main Vitest
// process, which outlives every worker: setup creates the run root and exports
// it before any worker forks (Vitest builds the worker environment from
// process.env when it schedules the files), and teardown removes the run root
// with every worker HOME still inside it.
export const RUN_ROOT_ENV = 'WHATSOUP_VITEST_RUN_ROOT';
// The run root and the worker HOME in it are on the path of every socket a test
// makes in its TMPDIR, and macOS limits a socket path to 103 bytes
// (vitest-socket-path-length.test.ts). So the run root gets a one-letter prefix,
// and a HOME in it gets none (workerHomePrefix).
export const RUN_ROOT_PREFIX = 'w';
export const RUN_ROOT_MARKER = '.whatsoup-vitest-run-root';
// A worker HOME made directly in /tmp, when no run root is exported.
export const WORKER_HOME_PREFIX = 'ws-vh-';

// Retries cover ENOTEMPTY/EBUSY from a process that is still writing into a
// tree while it is removed.
export const REMOVE_RETRY = { maxRetries: 5, retryDelay: 100 } as const;

// One removal attempt on the run root. Node 24's native rmSync sleeps whole
// seconds between retries, sleep(i * retryDelay / 1000), so these ten retries
// wait about 1 s in total, not 5.5 s; the exit hook's wait below is the window
// a late writer gets.
export const RUN_ROOT_REMOVE_RETRY = { maxRetries: 10, retryDelay: 100 } as const;

// The total time the exit hook waits for the run root to go, in one bound: it
// starts no attempt after it, so its worst wall time is this bound plus one
// attempt. A child process that a test file left running may still write into a
// worker HOME when the run ends; the list probe's late writer runs 2.5 s. One
// attempt takes about 1 s of back-off plus the time to remove what a writer
// added (up to about 5 s against a writer in a tight loop on macOS). Ten seconds
// outlasts the probe's writer with a margin for a slow host, and the worst case,
// about 15 s, stays inside the 30 s and 120 s timeouts of the callers that run
// `vitest list` in a child process.
export const RUN_ROOT_EXIT_WAIT_MS = 10_000;
const RUN_ROOT_EXIT_PAUSE_MS = 100;
// The final failure names this many remaining top-level entries at most.
const REMAINING_ENTRIES_SHOWN = 20;

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

// The directory a worker creates its HOME in, which is also the
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

// The mkdtempSync prefix for a worker HOME in tempRoot (resolveWorkerTempRoot).
// In a run root the HOME name is only the six random characters: the root is
// this run's own and is removed whole. The trailing separator makes the HOME a
// child of the root; without it mkdtempSync would create a sibling in /tmp.
// Directly in /tmp, a shared directory, the HOME keeps a recognizable prefix.
export function workerHomePrefix(tempRoot: string): string {
  return tempRoot === defaultTempParent() ? join(tempRoot, WORKER_HOME_PREFIX) : `${tempRoot}${sep}`;
}

export type RemoveTree = (root: string) => void;
export type RemoveEntry = (path: string) => void;

function removeEntry(path: string): void {
  rmSync(path, { recursive: true, force: true, ...RUN_ROOT_REMOVE_RETRY });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Removes the root with its marker last, so that the marker outlives a removal
// that stops part way and the next attempt checks the token as the first did.
// On Linux, Node's rmSync returns as if done when remove_all meets an entry that
// another process removed first (ENOENT), as a worker's own exit-hook HOME
// removal does while teardown runs. Each entry but the marker is removed on its
// own, and a failure of one does not stop the others. The marker goes only when
// it is the last entry, and then the empty root goes with rmdirSync. One window
// is left: an entry made after the last listing makes rmdirSync fail and leaves
// the root without its marker. The next attempt refuses it, so the run fails
// closed; nothing is removed that this attempt did not verify.
function removeTree(root: string, remove: RemoveEntry = removeEntry): void {
  const failures: string[] = [];
  for (const name of readdirSync(root)) {
    if (name === RUN_ROOT_MARKER) continue;
    try {
      remove(join(root, name));
    } catch (error) {
      failures.push(errorMessage(error));
    }
  }
  if (failures.length > 0) throw new Error(failures.join('; '));
  if (readdirSync(root).some((name) => name !== RUN_ROOT_MARKER)) return;
  rmSync(join(root, RUN_ROOT_MARKER), { force: true });
  rmdirSync(root);
}

function isGone(root: string): boolean {
  try {
    return lstatSync(root, { throwIfNoEntry: false }) === undefined;
  } catch {
    return false;
  }
}

// 'own': a directory at its canonical path whose marker is a regular file
// holding this run's token. 'other': anything else that is present, a root
// without its marker included. Never throws.
type RootState = 'own' | 'gone' | 'other';

function runRootState(root: string, token: string): RootState {
  try {
    if (!isAbsolute(root)) return 'other';
    const stat = lstatSync(root, { throwIfNoEntry: false });
    if (stat === undefined) return 'gone';
    if (!stat.isDirectory() || realpathSync(root) !== root) return 'other';
    const marker = join(root, RUN_ROOT_MARKER);
    if (lstatSync(marker, { throwIfNoEntry: false })?.isFile() !== true) return 'other';
    return readFileSync(marker, 'utf8') === token ? 'own' : 'other';
  } catch {
    // The root itself may have gone between two of the calls above.
    return isGone(root) ? 'gone' : 'other';
  }
}

export type RemoveResult = { outcome: 'removed' } | { outcome: 'refused' } | { outcome: 'present'; reason: string };

// One attempt; never throws. Every attempt requires this run's token, so a root
// without it is never removed; a refusal is reported on stderr.
export function removeRunRoot(root: string, token: string, remove: RemoveTree = removeTree): RemoveResult {
  const state = runRootState(root, token);
  if (state === 'gone') return { outcome: 'removed' };
  if (state === 'other') {
    process.stderr.write(`vitest-run-root: refusing to remove ${root}: not this run's marked root\n`);
    return { outcome: 'refused' };
  }
  let reason = `${root} is still present after removal`;
  try {
    remove(root);
  } catch (error) {
    reason = `could not remove ${root}: ${errorMessage(error)}`;
  }
  return isGone(root) ? { outcome: 'removed' } : { outcome: 'present', reason };
}

// The top-level entries left in the root, without walking the tree: their
// number and the first REMAINING_ENTRIES_SHOWN names in sorted order.
function remainingEntries(root: string): string {
  let names: string[];
  try {
    names = readdirSync(root).sort();
  } catch {
    return 'its top-level entries could not be listed';
  }
  const shown = names.slice(0, REMAINING_ENTRIES_SHOWN);
  return `${names.length} top-level entries remain (${shown.length} shown): ${shown.join(', ')}`;
}

// A blocking sleep that needs no timer: the exit hook runs synchronously, so a
// timer would never fire. Atomics.wait on a cell that nothing notifies returns
// after `ms`.
const pauseCell = new Int32Array(new SharedArrayBuffer(4));
function pause(ms: number): void {
  if (ms > 0) Atomics.wait(pauseCell, 0, 0, ms);
}

export interface RunRootOptions {
  // Test seam: the tree removal, so a removal that keeps failing is reproducible.
  remove?: RemoveTree;
  // Test seam: the removal of one top-level entry inside the default tree
  // removal, so a removal that stops part way is reproducible.
  removeEntry?: RemoveEntry;
  // Test seam: the exit hook's total wait. Anything but a finite number >= 0
  // means RUN_ROOT_EXIT_WAIT_MS.
  exitWaitMs?: number;
}

function exitWaitMs(requested: number | undefined): number {
  return typeof requested === 'number' && Number.isFinite(requested) && requested >= 0
    ? requested
    : RUN_ROOT_EXIT_WAIT_MS;
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

  // Teardown makes one attempt and the exit hook makes the last ones, so a root
  // that is gone when the process exits is a clean run. The run fails closed
  // when the exit hook's wait ends with the root present, or at once when the
  // root does not carry this run's token.
  const remove = options.remove ?? ((path: string): void => removeTree(path, options.removeEntry));
  let removed = false;
  const attempt = (): RemoveResult => {
    if (removed) return { outcome: 'removed' };
    const result = removeRunRoot(root, token, remove);
    removed = result.outcome === 'removed';
    return result;
  };
  // Vitest ends the main process with process.exit() on SIGINT/SIGTERM, which
  // skips teardown but still emits `exit`.
  const reapAtExit = (): void => {
    const waitMs = exitWaitMs(options.exitWaitMs);
    // A monotonic clock, so a wall-clock step cannot extend the wait.
    const deadline = performance.now() + waitMs;
    let result = attempt();
    while (result.outcome === 'present') {
      const left = deadline - performance.now();
      if (left <= 0) break;
      pause(Math.min(RUN_ROOT_EXIT_PAUSE_MS, left));
      if (performance.now() >= deadline) break;
      result = attempt();
    }
    if (result.outcome === 'removed') return;
    failRunClosed();
    const verdict = result.outcome === 'present'
      ? `could not remove ${root} within ${waitMs} ms (${result.reason})`
      : `left ${root} in place`;
    process.stderr.write(`vitest-run-root: ${verdict}; ${remainingEntries(root)}\n`);
  };
  process.once('exit', reapAtExit);

  return () => {
    try {
      const result = attempt();
      if (result.outcome === 'removed') process.off('exit', reapAtExit);
      else if (result.outcome === 'refused') failRunClosed();
      else process.stderr.write(`vitest-run-root: ${result.reason}; the exit hook tries again\n`);
    } finally {
      if (previous === undefined) delete process.env[RUN_ROOT_ENV];
      else process.env[RUN_ROOT_ENV] = previous;
    }
  };
}

export default function setup(): () => void {
  return startRunRoot();
}
