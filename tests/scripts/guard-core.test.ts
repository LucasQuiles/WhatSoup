import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  cleanGitEnv,
  gitList,
  isTextCandidate,
  normalizeRepoPath,
  readStagedFileContent,
  readStagedFileContentResult,
} from '../../scripts/lib/guard-core.ts';

const repos: string[] = [];

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: cleanGitEnv() }).trim();
}

function makeRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'guard-core-'));
  repos.push(repo);
  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'Guard Core Test']);
  git(repo, ['config', 'user.email', 'guard-core-test@users.noreply.github.com']);
  return repo;
}

afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

describe('guard-core helpers', () => {
  it('normalizes repo paths and git list output', () => {
    const repo = makeRepo();
    mkdirSync(path.join(repo, 'nested'), { recursive: true });
    writeFileSync(path.join(repo, 'nested/example.md'), '# Example\n');
    git(repo, ['add', 'nested/example.md']);

    expect(normalizeRepoPath('./nested/example.md')).toBe('nested/example.md');
    expect(gitList(['ls-files'], repo)).toEqual(['nested/example.md']);
  });

  it('classifies shared text candidates without shrinking anonymizer coverage', () => {
    expect(isTextCandidate('Dockerfile')).toBe(true);
    expect(isTextCandidate('.env.local')).toBe(true);
    expect(isTextCandidate('config.env')).toBe(true);
    expect(isTextCandidate('fixture.example')).toBe(true);
    expect(isTextCandidate('src/example.ts')).toBe(true);
    expect(isTextCandidate('assets/image.png')).toBe(false);
  });

  it('returns missing staged and HEAD blobs without treating them as read failures', () => {
    const repo = makeRepo();
    writeFileSync(path.join(repo, 'README.md'), '# Example\n');
    git(repo, ['add', 'README.md']);
    git(repo, ['commit', '-m', 'seed']);

    expect(readStagedFileContentResult(repo, 'docs/publication-audit.md')).toEqual({
      ok: true,
      content: undefined,
    });
    expect(readStagedFileContent(repo, 'docs/publication-audit.md')).toBeUndefined();
  });
});
