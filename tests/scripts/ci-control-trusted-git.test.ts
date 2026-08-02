/**
 * Trusted-git allowlist resolver — #2616.
 *
 * Two security-sensitive CI scripts (outgoing ref policy, hook identity) used to hardcode
 * `/usr/bin/git`, which silently fails wherever git ships from Homebrew or MacPorts instead of
 * the base OS. The fix is a STATIC allowlist, never a PATH/`which` search — a dynamic lookup in
 * this position would turn a pinned trusted binary into a PATH-injection vector. These tests
 * pin that: candidates are fixed absolute paths, qualification is realpath + regular-file +
 * executable + not-group/world-writable + root-or-euid-owned, and any failure to qualify throws
 * rather than falling back to a bare `git` lookup.
 */
import { chmodSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TRUSTED_GIT_CANDIDATES,
  TrustedGitUnavailableError,
  isTrustedGitOwner,
  resolveTrustedGit,
} from '../../scripts/lib/ci-control/trusted-git.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('');

function fixtureFile(mode: number): string {
  const root = tmp.make('trusted-git');
  const path = join(root, 'git');
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, mode);
  return path;
}

const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('DEFAULT_TRUSTED_GIT_CANDIDATES', () => {
  it('is the fixed, ordered allowlist — never a PATH search', () => {
    expect(DEFAULT_TRUSTED_GIT_CANDIDATES).toEqual([
      '/usr/bin/git',
      '/opt/homebrew/bin/git',
      '/usr/local/bin/git',
      '/opt/local/bin/git',
    ]);
  });
});

describe('isTrustedGitOwner', () => {
  it('trusts uid 0 (root) unconditionally', () => {
    expect(isTrustedGitOwner(0)).toBe(true);
  });

  it('trusts this process\'s own effective uid', () => {
    const euid = process.geteuid?.();
    if (euid === undefined) return;
    expect(isTrustedGitOwner(euid)).toBe(true);
  });

  it('rejects a third-party uid that is neither root nor this process\'s euid', () => {
    const euid = process.geteuid?.() ?? -1;
    const other = euid === 424242 ? 424243 : 424242;
    expect(isTrustedGitOwner(other)).toBe(false);
  });
});

describe('resolveTrustedGit', () => {
  it('resolves a well-formed candidate and returns it', () => {
    const path = fixtureFile(0o755);
    expect(resolveTrustedGit([path])).toBe(path);
  });

  it('falls through nonexistent and disqualified candidates to the first that qualifies', () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'trusted-git-missing-')), 'git');
    const goodPath = fixtureFile(0o755);
    expect(resolveTrustedGit([missing, goodPath])).toBe(goodPath);
  });

  it('resolves a symlink candidate to its realpath target, not the link itself', () => {
    const target = fixtureFile(0o755);
    const linkRoot = tmp.make('trusted-git-link');
    const link = join(linkRoot, 'git');
    symlinkSync(target, link);
    expect(resolveTrustedGit([link])).toBe(realpathSync(target));
  });

  it('rejects a group- or world-writable candidate', () => {
    if (runningAsRoot) return;
    // rwxr-xrwx: exec bits set throughout, but "other" is writable — must be rejected on
    // writability alone, independent of the (passing) executable check.
    const path = fixtureFile(0o757);
    expect(() => resolveTrustedGit([path])).toThrow(TrustedGitUnavailableError);
  });

  it('rejects a non-executable candidate', () => {
    if (runningAsRoot) return;
    const path = fixtureFile(0o644);
    expect(() => resolveTrustedGit([path])).toThrow(TrustedGitUnavailableError);
  });

  it('throws TrustedGitUnavailableError naming every candidate checked when none qualify', () => {
    const first = join(mkdtempSync(join(tmpdir(), 'trusted-git-none-a-')), 'git');
    const second = join(mkdtempSync(join(tmpdir(), 'trusted-git-none-b-')), 'git');
    try {
      resolveTrustedGit([first, second]);
      expect.unreachable('expected resolveTrustedGit to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(TrustedGitUnavailableError);
      const trusted = error as TrustedGitUnavailableError;
      expect(trusted.candidates).toEqual([first, second]);
      expect(trusted.message).toContain(first);
      expect(trusted.message).toContain(second);
    }
  });

  it('resolves the real system git from the default allowlist', () => {
    const path = resolveTrustedGit();
    expect(path.endsWith('/git')).toBe(true);
  });
});
