/**
 * #2481: the commit of the tree that runs release:activate (the tree that
 * supplies the invariant floor). The lookup is bounded, runs git with the
 * repository's clean git environment, and accepts a commit only from the
 * work tree whose top level is the tool root. The exec seam is faked; no git
 * runs here.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resolveToolCommit,
  TOOL_COMMIT_TIMEOUT_MS,
  type ToolCommitExec,
} from '../../scripts/lib/release-activation/tool-commit.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('whatsoup-tool-commit-');
const COMMIT = 'b'.repeat(40);

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

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('resolveToolCommit', () => {
  it('is bounded: an exec that never settles gives null once the bound expires', async () => {
    vi.useFakeTimers();
    const root = tmp.make('root');
    const never: ToolCommitExec = () => new Promise(() => { /* a git that never exits */ });
    let settled: string | null | 'pending' = 'pending';
    const pending = resolveToolCommit({ root, exec: never }).then((value) => { settled = value; return value; });

    await vi.advanceTimersByTimeAsync(TOOL_COMMIT_TIMEOUT_MS - 1);
    expect(settled).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBeNull();
    expect(TOOL_COMMIT_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
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
    writeFileSync(path.join(root, '.whatsoup-release-manifest.json'), JSON.stringify({ source: { commit: COMMIT } }));
    const calls: Call[] = [];

    expect(await resolveToolCommit({ root, exec: answering(() => '', calls) })).toBe(COMMIT);
    expect(calls).toEqual([]);
  });
});
