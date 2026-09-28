/**
 * #2481: the commit of the tree that runs `release:activate`, i.e. the tree
 * that supplies the invariant floor. The receipt records it next to the floor.
 *
 * A release snapshot names its commit in `.whatsoup-release-manifest.json`;
 * that wins without running git, but only when the manifest is a regular file
 * of at most 64 KiB (a FIFO, a directory or a huge file is never opened).
 * Otherwise git is asked for the work tree's top level and HEAD, with the
 * repository's clean git environment (so an inherited `GIT_DIR` /
 * `GIT_WORK_TREE` cannot point it at another repository), and the answer
 * counts only when that top level IS the tool root: a tool tree nested in some
 * other checkout gets null, not the parent's HEAD.
 *
 * The whole lookup is bounded. Every filesystem call is asynchronous, so the
 * timer that bounds it can always fire; past the bound the commit is null.
 *
 * Trust limits: `git` is resolved from PATH, as the repository's other tool
 * git calls are (scripts/lib/semantic-quality/git-tree.ts:41-44), and the
 * manifest's commit is taken as written. `toolCommit` is provenance for the
 * operator, not an attestation of the loaded source.
 */
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { cleanGitEnv } from '../../../src/lib/git-env.ts';
import { isRecord } from '../../../src/lib/type-guards.ts';

/** Upper bound on the whole lookup; the git child gets the same bound as its own timeout. */
export const TOOL_COMMIT_TIMEOUT_MS = 5_000;

const RELEASE_MANIFEST_FILE = '.whatsoup-release-manifest.json';
const MANIFEST_MAX_BYTES = 64 * 1024;
const FULL_COMMIT = /^[0-9a-f]{40}$/;

/** Run a program with argv (never a shell string); non-zero exit is a result, not a throw. */
export type ToolCommitExec = (
  file: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<{ code: number; stdout: string }>;

/** The asynchronous filesystem calls the lookup makes (node:fs/promises by default). */
export interface ToolCommitFs {
  lstat: (filePath: string) => Promise<{ isFile(): boolean; size: number }>;
  readFile: (filePath: string, encoding: 'utf8') => Promise<string>;
  realpath: (filePath: string) => Promise<string>;
}

export interface ToolCommitOptions {
  root: string;
  exec: ToolCommitExec;
  fs?: ToolCommitFs;
  timeoutMs?: number;
}

const DEFAULT_FS: ToolCommitFs = { lstat, readFile, realpath };

async function manifestCommit(root: string, fs: ToolCommitFs): Promise<string | null> {
  const manifestPath = path.join(root, RELEASE_MANIFEST_FILE);
  try {
    const stat = await fs.lstat(manifestPath);
    // Opening a FIFO without a writer would block; a directory or a huge file is not a manifest.
    if (!stat.isFile() || stat.size > MANIFEST_MAX_BYTES) return null;
    const manifest: unknown = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const source = isRecord(manifest) && isRecord(manifest['source']) ? manifest['source'] : {};
    const commit = source['commit'];
    return typeof commit === 'string' && FULL_COMMIT.test(commit) ? commit : null;
  } catch {
    // Not a release snapshot (or an unreadable manifest): ask the checkout.
    return null;
  }
}

async function checkoutCommit(root: string, exec: ToolCommitExec, fs: ToolCommitFs, timeoutMs: number): Promise<string | null> {
  try {
    // Bare `git` from PATH, like scripts/lib/semantic-quality/git-tree.ts.
    const result = await exec('git', ['-C', root, 'rev-parse', '--show-toplevel', 'HEAD'], {
      env: cleanGitEnv(),
      timeoutMs,
    });
    if (result.code !== 0) return null;
    const lines = result.stdout.split('\n').filter((line) => line !== '');
    if (lines.length !== 2) return null;
    const [topLevel, commit] = lines as [string, string];
    if (!FULL_COMMIT.test(commit)) return null;
    return (await fs.realpath(topLevel)) === (await fs.realpath(root)) ? commit : null;
  } catch {
    return null;
  }
}

/** The tool tree's release-manifest commit, else its own checkout's HEAD; null when neither resolves in time. */
export async function resolveToolCommit(options: ToolCommitOptions): Promise<string | null> {
  const fs = options.fs ?? DEFAULT_FS;
  const timeoutMs = options.timeoutMs ?? TOOL_COMMIT_TIMEOUT_MS;
  // The bound starts before any work; nothing below is synchronous I/O, so the timer can always fire.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
  const lookup = (async () => await manifestCommit(options.root, fs)
    ?? await checkoutCommit(options.root, options.exec, fs, timeoutMs))();
  try {
    return await Promise.race([lookup, expired]);
  } finally {
    clearTimeout(timer);
  }
}
