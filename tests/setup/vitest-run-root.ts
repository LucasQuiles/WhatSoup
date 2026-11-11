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
// is exported, else /tmp (a config without this globalSetup, such as a nested
// run that inherits no run root).
export function resolveWorkerTempRoot(env: NodeJS.ProcessEnv = process.env): string {
  const runRoot = env[RUN_ROOT_ENV];
  if (runRoot === undefined || runRoot === '') return defaultTempParent();
  if (!isMarkedRunRoot(runRoot)) {
    throw new Error(`${RUN_ROOT_ENV} is set but does not name a marked Vitest run root: ${runRoot}`);
  }
  return runRoot;
}

// Never throws: a failed or refused removal is reported on stderr and left in
// place, so teardown cannot fail a finished run.
export function removeRunRoot(root: string, token: string): boolean {
  if (!isMarkedRunRoot(root, token)) {
    process.stderr.write(`vitest-run-root: refusing to remove ${root}: not this run's marked root\n`);
    return false;
  }
  try {
    rmSync(root, { recursive: true, force: true, ...REMOVE_RETRY });
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`vitest-run-root: could not remove ${root}: ${reason}\n`);
    return false;
  }
}

export function startRunRoot(parent: string = defaultTempParent()): () => void {
  const previous = process.env[RUN_ROOT_ENV];
  const root = realpathSync(mkdtempSync(join(parent, RUN_ROOT_PREFIX)));
  chmodSync(root, 0o700);
  const token = randomUUID();
  writeFileSync(join(root, RUN_ROOT_MARKER), token, { mode: 0o600 });
  process.env[RUN_ROOT_ENV] = root;

  let removed = false;
  const remove = (): void => {
    if (removed) return;
    removed = true;
    removeRunRoot(root, token);
  };
  // Vitest ends the main process with process.exit() on SIGINT/SIGTERM, which
  // skips teardown but still emits `exit`.
  process.once('exit', remove);

  return () => {
    process.off('exit', remove);
    remove();
    if (previous === undefined) delete process.env[RUN_ROOT_ENV];
    else process.env[RUN_ROOT_ENV] = previous;
  };
}

export default function setup(): () => void {
  return startRunRoot();
}
