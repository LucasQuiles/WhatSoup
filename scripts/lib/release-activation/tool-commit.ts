/**
 * #2481: the commit of the tree that runs `release:activate`, i.e. the tree
 * that supplies the invariant floor. The receipt records it next to the floor.
 *
 * A release snapshot names its commit in `.whatsoup-release-manifest.json`;
 * that wins without running git, but only when the manifest is a regular file
 * of at most 64 KiB. It is opened once (non-blocking, never through a
 * symlink), checked with fstat on that descriptor, and read only from that
 * descriptor, at most 64 KiB + 1 bytes: the extra byte means the file grew
 * past the cap after the check, and the manifest is refused. A FIFO, a
 * directory or a huge file is never read. Otherwise git is asked for the work
 * tree's top level and HEAD, with the repository's clean git environment (so
 * an inherited `GIT_DIR` / `GIT_WORK_TREE` cannot point it at another
 * repository), and the answer counts only when that top level IS the tool
 * root: a tool tree nested in some other checkout gets null, not the parent's
 * HEAD.
 *
 * The whole lookup is bounded. Every filesystem call is asynchronous, so the
 * timer that bounds it can always fire; past the bound the commit is null. The
 * timer also marks the lookup expired, and every later step checks that mark
 * first, so a lookup that resumes after the bound never starts git and never
 * changes the result. A filesystem call already in flight cannot be cancelled
 * in Node: a stalled one can keep the process alive after the result is
 * returned. The lookup reads only the tool's own checkout, the tree this CLI
 * was loaded from.
 *
 * Trust limits: `git` is resolved from PATH, as the repository's other tool
 * git calls are (scripts/lib/semantic-quality/git-tree.ts:41-44), and the
 * manifest's commit is taken as written. `toolCommit` is provenance for the
 * operator, not an attestation of the loaded source.
 */
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';

import { cleanGitEnv } from '../../../src/lib/git-env.ts';
import { isRecord } from '../../../src/lib/type-guards.ts';

/** Upper bound on the whole lookup; the git child gets the same bound as its own timeout. */
export const TOOL_COMMIT_TIMEOUT_MS = 5_000;

const RELEASE_MANIFEST_FILE = '.whatsoup-release-manifest.json';
const MANIFEST_MAX_BYTES = 64 * 1024;
/** Opening a FIFO without a writer would block; a symlink is not followed. */
const MANIFEST_OPEN_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
const FULL_COMMIT = /^[0-9a-f]{40}$/;

/** Run a program with argv (never a shell string); non-zero exit is a result, not a throw. */
export type ToolCommitExec = (
  file: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<{ code: number; stdout: string }>;

/** The descriptor calls the manifest read makes. */
export interface ToolCommitFileHandle {
  stat(): Promise<{ isFile(): boolean; size: number }>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

/** The asynchronous filesystem calls the lookup makes (node:fs/promises by default). */
export interface ToolCommitFs {
  open(filePath: string, flags: number): Promise<ToolCommitFileHandle>;
  realpath(filePath: string): Promise<string>;
}

export interface ToolCommitOptions {
  root: string;
  exec: ToolCommitExec;
  fs?: ToolCommitFs;
  timeoutMs?: number;
}

const DEFAULT_FS: ToolCommitFs = {
  open: async (filePath, flags) => {
    const handle = await open(filePath, flags);
    return {
      stat: () => handle.stat(),
      read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
      close: () => handle.close(),
    };
  },
  realpath: (filePath) => realpath(filePath),
};

/** Set by the timer; checked before every step, so nothing starts after the bound. */
interface Deadline {
  expired: boolean;
}

class Expired extends Error {}

function live(deadline: Deadline): void {
  if (deadline.expired) throw new Expired();
}

/** Up to MANIFEST_MAX_BYTES + 1 bytes from the descriptor; more than the cap is null. */
async function readCapped(handle: ToolCommitFileHandle, deadline: Deadline): Promise<string | null> {
  const buffer = Buffer.alloc(MANIFEST_MAX_BYTES + 1);
  let total = 0;
  while (total < buffer.length) {
    live(deadline);
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return total > MANIFEST_MAX_BYTES ? null : buffer.toString('utf8', 0, total);
}

async function manifestCommit(root: string, fs: ToolCommitFs, deadline: Deadline): Promise<string | null> {
  const manifestPath = path.join(root, RELEASE_MANIFEST_FILE);
  let handle: ToolCommitFileHandle;
  try {
    live(deadline);
    handle = await fs.open(manifestPath, MANIFEST_OPEN_FLAGS);
  } catch (error) {
    if (error instanceof Expired) throw error;
    // Not a release snapshot (or an unreadable manifest): ask the checkout.
    return null;
  }
  try {
    live(deadline);
    const stat = await handle.stat();
    // A directory, a FIFO or a huge file is not a manifest.
    if (!stat.isFile() || stat.size > MANIFEST_MAX_BYTES) return null;
    const text = await readCapped(handle, deadline);
    if (text === null) return null;
    const manifest: unknown = JSON.parse(text);
    const source = isRecord(manifest) && isRecord(manifest['source']) ? manifest['source'] : {};
    const commit = source['commit'];
    return typeof commit === 'string' && FULL_COMMIT.test(commit) ? commit : null;
  } catch (error) {
    if (error instanceof Expired) throw error;
    return null;
  } finally {
    await handle.close().catch(() => { /* the result stands */ });
  }
}

async function checkoutCommit(
  root: string,
  exec: ToolCommitExec,
  fs: ToolCommitFs,
  timeoutMs: number,
  deadline: Deadline,
): Promise<string | null> {
  try {
    live(deadline);
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
    live(deadline);
    const top = await fs.realpath(topLevel);
    live(deadline);
    return top === (await fs.realpath(root)) ? commit : null;
  } catch {
    return null;
  }
}

/** The tool tree's release-manifest commit, else its own checkout's HEAD; null when neither resolves in time. */
export async function resolveToolCommit(options: ToolCommitOptions): Promise<string | null> {
  const fs = options.fs ?? DEFAULT_FS;
  const timeoutMs = options.timeoutMs ?? TOOL_COMMIT_TIMEOUT_MS;
  const deadline: Deadline = { expired: false };
  // The bound starts before any work; nothing below is synchronous I/O, so the timer can always fire.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      deadline.expired = true;
      resolve(null);
    }, timeoutMs);
  });
  const lookup = (async () => {
    try {
      return await manifestCommit(options.root, fs, deadline)
        ?? await checkoutCommit(options.root, options.exec, fs, timeoutMs, deadline);
    } catch {
      // Expired: the timer already answered null.
      return null;
    }
  })();
  try {
    return await Promise.race([lookup, expired]);
  } finally {
    clearTimeout(timer);
  }
}
