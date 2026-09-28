/**
 * #2481: the commit of the tree that runs `release:activate`, i.e. the tree
 * that supplies the invariant floor. The receipt records it next to the floor.
 *
 * A release snapshot names its commit in `.whatsoup-release-manifest.json`;
 * that wins without running git. Otherwise git is asked for the work tree's
 * top level and HEAD, with the repository's clean git environment (so an
 * inherited `GIT_DIR` / `GIT_WORK_TREE` cannot point it at another
 * repository), and the answer counts only when that top level IS the tool
 * root: a tool tree nested in some other checkout gets null, not the parent's
 * HEAD. The whole lookup is bounded; past the bound the commit is null.
 */
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { cleanGitEnv } from '../../../src/lib/git-env.ts';
import { isRecord } from '../../../src/lib/type-guards.ts';

/** Upper bound on the whole lookup; the git child gets the same bound as its own timeout. */
export const TOOL_COMMIT_TIMEOUT_MS = 5_000;

const RELEASE_MANIFEST_FILE = '.whatsoup-release-manifest.json';
const FULL_COMMIT = /^[0-9a-f]{40}$/;

/** Run a program with argv (never a shell string); non-zero exit is a result, not a throw. */
export type ToolCommitExec = (
  file: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<{ code: number; stdout: string }>;

export interface ToolCommitOptions {
  root: string;
  exec: ToolCommitExec;
  readFile?: (filePath: string) => string;
  realpath?: (filePath: string) => string;
  timeoutMs?: number;
}

function manifestCommit(root: string, readFile: (filePath: string) => string): string | null {
  try {
    const manifest: unknown = JSON.parse(readFile(path.join(root, RELEASE_MANIFEST_FILE)));
    const source = isRecord(manifest) && isRecord(manifest['source']) ? manifest['source'] : {};
    const commit = source['commit'];
    return typeof commit === 'string' && FULL_COMMIT.test(commit) ? commit : null;
  } catch {
    // Not a release snapshot (or an unreadable manifest): ask the checkout.
    return null;
  }
}

async function checkoutCommit(options: Required<ToolCommitOptions>): Promise<string | null> {
  try {
    // Bare `git` from PATH, like scripts/lib/semantic-quality/git-tree.ts.
    const result = await options.exec('git', ['-C', options.root, 'rev-parse', '--show-toplevel', 'HEAD'], {
      env: cleanGitEnv(),
      timeoutMs: options.timeoutMs,
    });
    if (result.code !== 0) return null;
    const lines = result.stdout.split('\n').filter((line) => line !== '');
    if (lines.length !== 2) return null;
    const [topLevel, commit] = lines as [string, string];
    if (!FULL_COMMIT.test(commit)) return null;
    return options.realpath(topLevel) === options.realpath(options.root) ? commit : null;
  } catch {
    return null;
  }
}

/** The tool tree's release-manifest commit, else its own checkout's HEAD; null when neither resolves in time. */
export async function resolveToolCommit(options: ToolCommitOptions): Promise<string | null> {
  const resolved: Required<ToolCommitOptions> = {
    readFile: (filePath) => readFileSync(filePath, 'utf8'),
    realpath: (filePath) => realpathSync(filePath),
    timeoutMs: TOOL_COMMIT_TIMEOUT_MS,
    ...options,
  };
  // The bound starts before any work, so nothing below can hold the caller past it.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), resolved.timeoutMs); });
  const lookup = (async () => manifestCommit(resolved.root, resolved.readFile) ?? await checkoutCommit(resolved))();
  try {
    return await Promise.race([lookup, expired]);
  } finally {
    clearTimeout(timer);
  }
}
