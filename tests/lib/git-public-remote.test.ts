import { describe, expect, it } from 'vitest';
import {
  githubPublicHttpsUrlFromRemote,
  publicFetchArgs,
  shouldRetryWithPublicHttps,
} from '../../src/lib/git-public-remote.ts';

describe('git public remote helpers', () => {
  it('converts GitHub SSH remotes to public HTTPS remotes', () => {
    expect(githubPublicHttpsUrlFromRemote('git@github.com:LucasQuiles/WhatSoup.git'))
      .toBe('https://github.com/LucasQuiles/WhatSoup.git');
    expect(githubPublicHttpsUrlFromRemote('ssh://git@github.com/LucasQuiles/WhatSoup.git'))
      .toBe('https://github.com/LucasQuiles/WhatSoup.git');
  });

  it('normalizes existing GitHub HTTPS remotes', () => {
    expect(githubPublicHttpsUrlFromRemote('https://github.com/LucasQuiles/WhatSoup'))
      .toBe('https://github.com/LucasQuiles/WhatSoup.git');
  });

  it('rejects non-GitHub remotes', () => {
    expect(githubPublicHttpsUrlFromRemote('https://example.invalid/LucasQuiles/WhatSoup.git')).toBeNull();
  });

  it('recognizes SSH auth failures as public HTTPS retry candidates', () => {
    const err: any = new Error('fatal: could not read from remote repository.');
    err.stderr = 'git@github.com: Permission denied (publickey).';
    expect(shouldRetryWithPublicHttps(err)).toBe(true);
  });

  it('does not retry unrelated git failures', () => {
    expect(shouldRetryWithPublicHttps(new Error('fatal: refusing to merge unrelated histories'))).toBe(false);
    expect(shouldRetryWithPublicHttps(new Error('fatal: could not read from remote repository.'))).toBe(false);
  });

  it('builds a deterministic fetch refspec for the update branch', () => {
    expect(publicFetchArgs('https://github.com/LucasQuiles/WhatSoup.git')).toEqual([
      'fetch',
      'https://github.com/LucasQuiles/WhatSoup.git',
      'main:refs/remotes/origin/main',
      '--quiet',
    ]);
  });
});
