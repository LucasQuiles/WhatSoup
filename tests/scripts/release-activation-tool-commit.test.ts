/**
 * #2481: the commit of the tree that runs release:activate (the tree that
 * supplies the invariant floor). The lookup is bounded, uses only
 * asynchronous filesystem calls, opens the release manifest once and reads it
 * only from that descriptor when it is a small regular file, runs git with the
 * repository's clean git environment, accepts a commit only from the work tree
 * whose top level is the tool root, and takes no step after its bound expired.
 * The exec seam is faked; no git runs here.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resolveToolCommit,
  TOOL_COMMIT_TIMEOUT_MS,
  type ToolCommitExec,
  type ToolCommitFileHandle,
  type ToolCommitFs,
} from '../../scripts/lib/release-activation/tool-commit.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const MKFIFO = '/usr/bin/mkfifo';

const absent = async (): Promise<never> => { throw Object.assign(new Error('ENOENT: injected'), { code: 'ENOENT' }); };

/**
 * A manifest that grew after its fstat: stat reports only the leading valid
 * JSON, but the descriptor serves that JSON plus trailing whitespace past
 * 64 KiB. JSON.parse accepts the trailing whitespace, so a reader that trusts
 * stat.size (or reads to EOF with no cap) would accept the manifest commit.
 */
function grownManifestHandle(json: string, closed: { count: number }): ToolCommitFileHandle {
  const content = Buffer.from(json + ' '.repeat(64 * 1024 + 16));
  return {
    stat: async () => ({ isFile: () => true, size: Buffer.byteLength(json) }),
    read: async (buffer, offset, length, position) => {
      const chunk = content.subarray(position, position + length);
      chunk.copy(buffer, offset);
      return { bytesRead: chunk.length };
    },
    close: async () => { closed.count += 1; },
  };
}

const tmp = trackTmpDirs('whatsoup-tool-commit-');
const COMMIT = 'b'.repeat(40);
const GIT_COMMIT = 'c'.repeat(40);
const MANIFEST = '.whatsoup-release-manifest.json';

interface Call {
  file: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

function answering(stdout: (root: string) => string, calls: Call[] = []): ToolCommitExec {
  return async (file, args, options) => {
    calls.push({ file, args, env: options.env, timeoutMs: options.timeoutMs });
    return { code: 0, stdout: stdout(args[1]!) };
  };
}

/** A git that reports the root itself as the top level, at GIT_COMMIT. */
const gitAtRoot = (calls: Call[]): ToolCommitExec => answering((cwd) => `${cwd}\n${GIT_COMMIT}\n`, calls);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('resolveToolCommit', () => {
  it('is bounded: an exec that never settles gives null once the bound expires', async () => {
    vi.useFakeTimers();
    const root = tmp.make('root');
    const never: ToolCommitExec = () => new Promise(() => { /* a git that never exits */ });
    // The filesystem answers at once here, so only the exec can hold the lookup.
    const fs: ToolCommitFs = { open: absent, realpath: async (filePath) => filePath };
    let settled: string | null | 'pending' = 'pending';
    const pending = resolveToolCommit({ root, exec: never, fs }).then((value) => { settled = value; return value; });

    await vi.advanceTimersByTimeAsync(TOOL_COMMIT_TIMEOUT_MS - 1);
    expect(settled).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBeNull();
    expect(TOOL_COMMIT_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });

  it('is bounded when the filesystem itself never answers: a stalled open gives null at the bound', async () => {
    vi.useFakeTimers();
    const root = tmp.make('root');
    const calls: Call[] = [];
    const stalled = () => new Promise<never>(() => { /* a stalled filesystem */ });
    let settled: string | null | 'pending' = 'pending';
    const pending = resolveToolCommit({
      root,
      exec: gitAtRoot(calls),
      fs: { open: stalled, realpath: stalled },
    }).then((value) => { settled = value; return value; });

    await vi.advanceTimersByTimeAsync(TOOL_COMMIT_TIMEOUT_MS - 1);
    expect(settled).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBeNull();
    expect(calls).toEqual([]);
  });

  it('a lookup that resumes after the bound takes no further step: the git fallback is never called', async () => {
    vi.useFakeTimers();
    const root = tmp.make('root');
    const calls: Call[] = [];
    const late: { finish?: () => void } = {};
    // The manifest open answers only after the bound, and says "absent", which would normally lead to git.
    const lateOpen = () => new Promise<never>((_resolve, reject) => {
      late.finish = () => reject(Object.assign(new Error('ENOENT: injected'), { code: 'ENOENT' }));
    });
    const pending = resolveToolCommit({
      root,
      exec: gitAtRoot(calls),
      fs: { open: lateOpen, realpath: async (filePath) => filePath },
    });

    await vi.advanceTimersByTimeAsync(TOOL_COMMIT_TIMEOUT_MS);
    await expect(pending).resolves.toBeNull();
    expect(late.finish).toBeTypeOf('function');
    late.finish!();
    await vi.advanceTimersByTimeAsync(TOOL_COMMIT_TIMEOUT_MS);
    expect(calls).toEqual([]);
  });

  it('refuses a manifest that grows between the check and the read: more than 64 KiB from the same fd falls through to git', async () => {
    const root = tmp.make('root');
    const calls: Call[] = [];
    const closed = { count: 0 };
    const json = JSON.stringify({ source: { commit: COMMIT } });

    const commit = await resolveToolCommit({
      root,
      exec: gitAtRoot(calls),
      fs: { open: async () => grownManifestHandle(json, closed), realpath: async (filePath) => filePath },
    });

    // COMMIT here would mean the grown manifest was accepted.
    expect(commit).toBe(GIT_COMMIT);
    expect(calls).toHaveLength(1);
    expect(closed.count).toBe(1);
  });

  it('asks git for the top level and HEAD with the clean git environment and the bound as its own timeout', async () => {
    vi.stubEnv('GIT_DIR', '/elsewhere/.git');
    vi.stubEnv('GIT_WORK_TREE', '/elsewhere');
    const root = tmp.make('root');
    const calls: Call[] = [];

    const commit = await resolveToolCommit({ root, exec: answering((cwd) => `${cwd}\n${COMMIT}\n`, calls) });

    expect(commit).toBe(COMMIT);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe('git');
    expect(calls[0]!.args).toEqual(['-C', root, 'rev-parse', '--show-toplevel', 'HEAD']);
    expect(calls[0]!.env).not.toHaveProperty('GIT_DIR');
    expect(calls[0]!.env).not.toHaveProperty('GIT_WORK_TREE');
    expect(calls[0]!.timeoutMs).toBe(TOOL_COMMIT_TIMEOUT_MS);
  });

  it('refuses a commit from a work tree whose top level is not the tool root (a parent checkout)', async () => {
    const parent = tmp.make('parent');
    const root = path.join(parent, 'release');
    mkdirSync(root);

    expect(await resolveToolCommit({ root, exec: answering(() => `${parent}\n${COMMIT}\n`) })).toBeNull();
  });

  it('refuses output that is not a top level plus a full commit, and a failing git', async () => {
    const root = tmp.make('root');
    expect(await resolveToolCommit({ root, exec: answering((cwd) => `${cwd}\nnot-a-commit\n`) })).toBeNull();
    expect(await resolveToolCommit({ root, exec: answering(() => '') })).toBeNull();
    expect(await resolveToolCommit({ root, exec: async () => ({ code: 128, stdout: '' }) })).toBeNull();
    expect(await resolveToolCommit({ root, exec: async () => { throw new Error('spawn git ENOENT'); } })).toBeNull();
  });

  it('prefers the release manifest commit of a release snapshot, without running git', async () => {
    const root = tmp.make('root');
    writeFileSync(path.join(root, MANIFEST), JSON.stringify({ source: { commit: COMMIT } }));
    const calls: Call[] = [];

    expect(await resolveToolCommit({ root, exec: answering(() => '', calls) })).toBe(COMMIT);
    expect(calls).toEqual([]);
  });

  it('never reads a manifest that is a directory: it falls through to git', async () => {
    const root = tmp.make('root');
    mkdirSync(path.join(root, MANIFEST));
    const calls: Call[] = [];

    expect(await resolveToolCommit({ root, exec: gitAtRoot(calls) })).toBe(GIT_COMMIT);
    expect(calls).toHaveLength(1);
  });

  it('never reads a manifest that is a FIFO (a read would block with no writer): it falls through to git', async () => {
    // Fixture precondition, labelled: without mkfifo this test cannot build its FIFO.
    expect(existsSync(MKFIFO), `fixture needs ${MKFIFO}`).toBe(true);
    const root = tmp.make('root');
    execFileSync(MKFIFO, [path.join(root, MANIFEST)]);
    const calls: Call[] = [];

    expect(await resolveToolCommit({ root, exec: gitAtRoot(calls) })).toBe(GIT_COMMIT);
    expect(calls).toHaveLength(1);
  });

  it('never reads a manifest over 64 KiB, even a valid one: it falls through to git', async () => {
    const root = tmp.make('root');
    const padding = 'x'.repeat(64 * 1024);
    writeFileSync(path.join(root, MANIFEST), JSON.stringify({ source: { commit: COMMIT }, padding }));
    const calls: Call[] = [];

    expect(await resolveToolCommit({ root, exec: gitAtRoot(calls) })).toBe(GIT_COMMIT);
    expect(calls).toHaveLength(1);
  });
});
