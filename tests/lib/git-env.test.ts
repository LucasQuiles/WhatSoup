import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe('git env helpers', () => {
  it('reads full WhatSoup git SHA with GIT_SHA fallback and rejects non-full values', async () => {
    const prevWhatsoup = process.env.WHATSOUP_GIT_SHA;
    const prevGeneric = process.env.GIT_SHA;
    try {
      const gitEnv = await import('../../src/lib/git-env.ts');
      expect(typeof gitEnv.readWhatsoupGitSha).toBe('function');

      process.env.WHATSOUP_GIT_SHA = 'a'.repeat(40);
      process.env.GIT_SHA = 'b'.repeat(40);
      expect(gitEnv.readWhatsoupGitSha?.()).toBe('a'.repeat(40));

      delete process.env.WHATSOUP_GIT_SHA;
      expect(gitEnv.readWhatsoupGitSha?.()).toBe('b'.repeat(40));

      process.env.WHATSOUP_GIT_SHA = 'short-sha';
      delete process.env.GIT_SHA;
      expect(gitEnv.readWhatsoupGitSha?.()).toBeNull();
    } finally {
      restoreEnv('WHATSOUP_GIT_SHA', prevWhatsoup);
      restoreEnv('GIT_SHA', prevGeneric);
    }
  });

  it('reads non-empty WhatSoup git branch as nullable health metadata', async () => {
    const prevBranch = process.env.WHATSOUP_GIT_BRANCH;
    try {
      const gitEnv = await import('../../src/lib/git-env.ts');
      expect(typeof gitEnv.readWhatsoupGitBranch).toBe('function');

      process.env.WHATSOUP_GIT_BRANCH = 'main';
      expect(gitEnv.readWhatsoupGitBranch?.()).toBe('main');

      process.env.WHATSOUP_GIT_BRANCH = '';
      expect(gitEnv.readWhatsoupGitBranch?.()).toBeNull();

      delete process.env.WHATSOUP_GIT_BRANCH;
      expect(gitEnv.readWhatsoupGitBranch?.()).toBeNull();
    } finally {
      restoreEnv('WHATSOUP_GIT_BRANCH', prevBranch);
    }
  });

  // A read-only git child killed while holding the optional index lock leaves a
  // stale index.lock that blocks every later commit in that worktree.
  it.each([
    ['unset', undefined],
    ['enabled', '1'],
    ['true', 'true'],
    ['disabled', '0'],
  ])('always disables optional git locks when the parent value is %s', async (_label, parentValue) => {
    const prevOptionalLocks = process.env.GIT_OPTIONAL_LOCKS;
    try {
      restoreEnv('GIT_OPTIONAL_LOCKS', parentValue);
      const gitEnv = await import('../../src/lib/git-env.ts');
      expect(gitEnv.cleanGitEnv().GIT_OPTIONAL_LOCKS).toBe('0');
    } finally {
      restoreEnv('GIT_OPTIONAL_LOCKS', prevOptionalLocks);
    }
  });

  it('keeps connection lifecycle audit on the shared SHA helper', () => {
    const source = readFileSync('src/transport/connection.ts', 'utf8');
    expect(source).toContain("readWhatsoupGitSha } from '../lib/git-env.ts'");
    expect(source).toContain('codeSha: readWhatsoupGitSha(),');
    expect(source).not.toContain('codeSha: process.env.WHATSOUP_GIT_SHA ?? process.env.GIT_SHA ?? null');
  });
});
