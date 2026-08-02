import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  cleanGitEnv,
  gitList,
  isTextCandidate,
  normalizeRepoPath,
  readStagedFileContent,
  readStagedFileContentResult,
  readText,
} from '../../scripts/lib/guard-core.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('');

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: cleanGitEnv() }).trim();
}

function makeRepo(): string {
  const repo = tmp.make('guard-core');
  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'Guard Core Test']);
  git(repo, ['config', 'user.email', 'guard-core-test@users.noreply.github.com']);
  return repo;
}

describe('guard-core helpers', () => {
  it('normalizes repo paths and git list output', () => {
    const repo = makeRepo();
    mkdirSync(path.join(repo, 'nested'), { recursive: true });
    writeFileSync(path.join(repo, 'nested/example.md'), '# Example\n');
    git(repo, ['add', 'nested/example.md']);

    expect(normalizeRepoPath('./nested/example.md')).toBe('nested/example.md');
    expect(gitList(['ls-files'], repo)).toEqual(['nested/example.md']);
  });

  it('does not leak stderr for caught git probe failures', () => {
    const probe = `
      import { gitList } from './scripts/lib/guard-core.ts';
      import { mkdtempSync, rmSync } from 'node:fs';
      import { tmpdir } from 'node:os';
      import path from 'node:path';
      const dir = mkdtempSync(path.join(tmpdir(), 'guard-core-quiet-probe-'));
      try {
        try {
          gitList(['status'], dir);
        } catch {
          // Expected negative probe: callers may turn this into a fail-closed verdict.
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      console.log('done');
    `;
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', probe], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: cleanGitEnv(),
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('done');
    expect(result.stderr).toBe('');
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

  describe('readText', () => {
    it('returns file content when the file exists', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'guard-core-readtext-'));
      try {
        writeFileSync(path.join(dir, 'sample.txt'), 'hello\n');
        expect(readText(dir, 'sample.txt')).toBe('hello\n');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('returns null when the file is absent', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'guard-core-readtext-'));
      try {
        expect(readText(dir, 'nonexistent.txt')).toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
