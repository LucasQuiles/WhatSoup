import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, type Stats } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { cleanGitEnv } from '../../src/lib/git-env.ts';

const SOURCE_RELATIVE_PATH = 'src/main.ts';
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024;
const MAX_SNAPSHOT_PATHS = 50_000;

export interface SourceMutationAnchorOptions {
  cwd: string;
  suppliedAnchor?: string;
}

export interface SourceMutationAssertionOptions {
  cwd: string;
  expectedDigest: string;
  stage: string;
  spec: string;
  report: (message: string) => void;
}

type RepositoryInputState = `file:${string}` | `symlink:${string}` | 'missing';

export interface RepositoryInputSnapshot {
  digest: string;
  entries: ReadonlyMap<string, RepositoryInputState>;
}

export interface RepositoryInputSnapshotDependencies {
  listFiles?: (cwd: string) => string[];
}

export interface RepositoryInputSnapshotOptions {
  cwd: string;
  dependencies?: RepositoryInputSnapshotDependencies;
}

export interface RepositoryInputAssertionOptions {
  cwd: string;
  snapshot: RepositoryInputSnapshot;
  stage: string;
  report: (message: string) => void;
  dependencies?: RepositoryInputSnapshotDependencies;
}

function digestPrefix(digest: string): string {
  return digest.slice(0, 16);
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function repositoryInputPaths(cwd: string): string[] {
  const result = spawnSync('git', ['-C', cwd, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8',
    env: cleanGitEnv(),
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = result.error?.message || result.stderr.trim() || `exit ${String(result.status)}`;
    throw new Error(detail);
  }
  return [...new Set(result.stdout.split('\0').filter((entry) => entry !== ''))].sort();
}

function absoluteRepositoryPath(cwd: string, inputPath: string): string {
  if (inputPath.includes('\0') || isAbsolute(inputPath) || inputPath.split('/').includes('..')) {
    throw new Error(`invalid Git input path ${JSON.stringify(inputPath)}`);
  }
  const absolute = resolve(cwd, inputPath);
  const contained = relative(cwd, absolute);
  if (contained === '' || contained === '..' || contained.startsWith(`..${sep}`) || isAbsolute(contained)) {
    throw new Error(`Git input path escapes repository ${JSON.stringify(inputPath)}`);
  }
  return absolute;
}

function sameInputFile(before: Stats, after: Stats): boolean {
  return after.isFile() && before.dev === after.dev && before.ino === after.ino
    && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

function repositoryInputState(
  cwd: string,
  inputPath: string,
  budget: { bytes: number; chunk: Buffer },
): RepositoryInputState {
  const absolute = absoluteRepositoryPath(cwd, inputPath);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot inspect ${inputPath}: ${detail}`, { cause: error });
  }
  if (stat.isSymbolicLink()) {
    try {
      return `symlink:${sha256(readlinkSync(absolute))}`;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`cannot read symlink ${inputPath}: ${detail}`, { cause: error });
    }
  }
  if (!stat.isFile()) throw new Error(`Git input ${inputPath} is not a regular file or symbolic link`);
  if (stat.size > MAX_INPUT_BYTES) throw new Error(`${inputPath} exceeds ${MAX_INPUT_BYTES}-byte file limit`);
  budget.bytes += stat.size;
  if (budget.bytes > MAX_SNAPSHOT_BYTES) throw new Error(`repository inputs exceed ${MAX_SNAPSHOT_BYTES}-byte snapshot limit`);
  try {
    const hash = createHash('sha256');
    const descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!sameInputFile(stat, fstatSync(descriptor))) throw new Error('input changed before read');
      let total = 0;
      for (;;) {
        const count = readSync(descriptor, budget.chunk, 0, Math.min(budget.chunk.length, stat.size - total + 1), null);
        if (count === 0) break;
        total += count;
        if (total > stat.size) throw new Error('input grew during read');
        hash.update(budget.chunk.subarray(0, count));
      }
      if (total !== stat.size || !sameInputFile(stat, fstatSync(descriptor)) || !sameInputFile(stat, lstatSync(absolute))) {
        throw new Error('input changed during read');
      }
    } finally {
      closeSync(descriptor);
    }
    return `file:${hash.digest('hex')}`;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read ${inputPath}: ${detail}`, { cause: error });
  }
}

function snapshotDigest(entries: ReadonlyMap<string, RepositoryInputState>): string {
  const hash = createHash('sha256');
  for (const [inputPath, state] of [...entries.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(inputPath).update('\0').update(state).update('\0');
  }
  return hash.digest('hex');
}

/**
 * Snapshot every Git-maintained verification input before an outer test run. The Git command
 * deliberately includes untracked, nonignored files, so an existing dirty worktree is valid
 * while a test cannot persist a new input undetected. Missing tracked paths are also a valid
 * initial state; only a transition after this snapshot is drift.
 */
export function captureRepositoryInputSnapshot(options: RepositoryInputSnapshotOptions): RepositoryInputSnapshot {
  let paths: string[];
  try {
    paths = options.dependencies?.listFiles?.(options.cwd) ?? repositoryInputPaths(options.cwd);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`FINAL-SOURCE cannot enumerate repository inputs: ${detail}`, { cause: error });
  }
  const entries = new Map<string, RepositoryInputState>();
  try {
    if (paths.length > MAX_SNAPSHOT_PATHS) throw new Error(`repository inputs exceed ${MAX_SNAPSHOT_PATHS}-path snapshot limit`);
    const budget = { bytes: 0, chunk: Buffer.allocUnsafe(64 * 1024) };
    for (const inputPath of paths) entries.set(inputPath, repositoryInputState(options.cwd, inputPath, budget));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`FINAL-SOURCE cannot snapshot repository input: ${detail}`, { cause: error });
  }
  return { entries, digest: snapshotDigest(entries) };
}

/**
 * Compare the outer-run snapshot after its child finishes. This detects persistent changes,
 * not an input that a child changes and restores before this boundary observes it.
 */
export function assertRepositoryInputUnchanged(options: RepositoryInputAssertionOptions): void {
  const current = captureRepositoryInputSnapshot({ cwd: options.cwd, dependencies: options.dependencies });
  if (current.digest === options.snapshot.digest) return;

  const added: string[] = [];
  const changed: string[] = [];
  const deleted: string[] = [];
  const restored: string[] = [];
  for (const [inputPath, state] of current.entries) {
    const before = options.snapshot.entries.get(inputPath);
    if (before === undefined) added.push(inputPath);
    else if (before === 'missing' && state !== 'missing') restored.push(inputPath);
    else if (before !== state && state === 'missing') deleted.push(inputPath);
    else if (before !== state) changed.push(inputPath);
  }
  for (const [inputPath, state] of options.snapshot.entries) {
    if (!current.entries.has(inputPath) && state !== 'missing') deleted.push(inputPath);
  }
  const details = [
    `stage=${options.stage}`,
    ...added.map((inputPath) => `added=${inputPath}`),
    ...changed.map((inputPath) => `changed=${inputPath}`),
    ...deleted.map((inputPath) => `deleted=${inputPath}`),
    ...restored.map((inputPath) => `restored=${inputPath}`),
    `baseline=${digestPrefix(options.snapshot.digest)}`,
    `current=${digestPrefix(current.digest)}`,
  ];
  const message = `FINAL-SOURCE drift: ${details.join(' ')}`;
  options.report(message);
  throw new Error(message);
}

export function sourceMutationDigest(cwd: string): string {
  try {
    return createHash('sha256')
      .update(readFileSync(join(cwd, SOURCE_RELATIVE_PATH)))
      .digest('hex');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`TRIPWIRE cannot read ${SOURCE_RELATIVE_PATH}: ${detail}`, { cause: error });
  }
}

/**
 * Establish the parent-process source digest before test workers start. A caller-supplied
 * digest is a contract with the parent, so reject malformed or stale values rather than
 * letting workers start from an unverified baseline.
 */
export function establishSourceMutationAnchor(options: SourceMutationAnchorOptions): string {
  const currentDigest = sourceMutationDigest(options.cwd);
  if (options.suppliedAnchor === undefined) return currentDigest;
  if (!SHA256.test(options.suppliedAnchor)) {
    throw new Error(`TRIPWIRE ${SOURCE_RELATIVE_PATH} supplied anchor is not a lowercase SHA-256 digest`);
  }
  if (options.suppliedAnchor !== currentDigest) {
    throw new Error(
      `TRIPWIRE ${SOURCE_RELATIVE_PATH} supplied anchor does not match current source: `
      + `supplied=${digestPrefix(options.suppliedAnchor)} current=${digestPrefix(currentDigest)}`,
    );
  }
  return currentDigest;
}

/**
 * Emit and throw one shared diagnostic. The throw makes a mutation a test failure instead of
 * a log-only observation, while the explicit callback preserves the raw worker diagnostic.
 */
export function assertSourceMutationUnchanged(options: SourceMutationAssertionOptions): void {
  let currentDigest: string;
  try {
    currentDigest = sourceMutationDigest(options.cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.report(message);
    throw error;
  }
  if (currentDigest === options.expectedDigest) return;

  const message = `TRIPWIRE ${SOURCE_RELATIVE_PATH} mutated: stage=${options.stage} spec=${options.spec} `
    + `baseline=${digestPrefix(options.expectedDigest)} current=${digestPrefix(currentDigest)}`;
  options.report(message);
  throw new Error(message);
}
