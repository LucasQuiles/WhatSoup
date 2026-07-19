/**
 * S-03 — the read-only update availability/version check must work from a
 * DETACHED immutable release, which is how the fleet actually runs
 * (`WhatSoup-release-<sha>`, HEAD-detached). After the mutating in-place update
 * path was retired, `UpdateChecker.checkNow()` is the retained availability
 * check; this fixture proves it (a) reports availability correctly from a
 * detached HEAD and (b) never mutates HEAD or the working tree.
 *
 * Real git (no mocks) against a throwaway remote+clone in a temp dir.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanGitEnv } from '../../src/lib/git-env.ts';
import { UpdateChecker } from '../../src/fleet/update-checker.ts';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() }).trim();
}

describe('UpdateChecker.checkNow — detached immutable release', () => {
  let tmpRoot: string | undefined;

  afterEach(() => {
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = undefined;
    }
  });

  it('reports an available update from a detached HEAD without moving HEAD or touching the tree', async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'whatsoup-update-detached-'));
    const remote = join(tmpRoot, 'remote.git');
    const seed = join(tmpRoot, 'seed');
    const repo = join(tmpRoot, 'repo');

    git(tmpRoot, ['init', '--bare', remote]);
    git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    git(tmpRoot, ['init', seed]);
    git(seed, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    git(seed, ['config', 'user.email', 'whatsoup-test.invalid']);
    git(seed, ['config', 'user.name', 'WhatSoup Test']);
    writeFileSync(join(seed, 'file.txt'), 'v1\n');
    git(seed, ['add', 'file.txt']);
    git(seed, ['commit', '-m', 'release commit']);
    git(seed, ['remote', 'add', 'origin', remote]);
    git(seed, ['push', '-u', 'origin', 'main']);

    // Clone, then detach HEAD at the release commit — the immutable-release layout.
    git(tmpRoot, ['clone', remote, repo]);
    const releaseSha = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['checkout', '--detach', releaseSha]);
    // Prove the checkout is genuinely detached (no symbolic HEAD).
    expect(() => git(repo, ['symbolic-ref', '-q', 'HEAD'])).toThrow();
    // An operator's untracked file must survive a read-only availability check.
    writeFileSync(join(repo, 'operator-note.txt'), 'do not touch\n');

    // Advance the remote so an update is genuinely available.
    writeFileSync(join(seed, 'file.txt'), 'v2\n');
    git(seed, ['add', 'file.txt']);
    git(seed, ['commit', '-m', 'newer release']);
    git(seed, ['push', 'origin', 'main']);

    const state = await new UpdateChecker(repo).checkNow();

    // Availability detected from the detached release.
    expect(state.sha).toBe(releaseSha.slice(0, state.sha.length));
    expect(state.updateAvailable).toBe(true);
    expect(state.remoteSha).not.toBe('unknown');
    expect(state.checkedAt).not.toBe('');

    // Read-only: HEAD still detached at the same commit, tree untouched.
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(releaseSha);
    expect(() => git(repo, ['symbolic-ref', '-q', 'HEAD'])).toThrow();
    expect(readFileSync(join(repo, 'file.txt'), 'utf8')).toBe('v1\n');
    expect(readFileSync(join(repo, 'operator-note.txt'), 'utf8')).toBe('do not touch\n');
  });
});
