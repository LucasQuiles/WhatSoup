import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { trackTmpDirs } from '../helpers/tmp-dir.ts';
import { cleanGitEnv, PUSH_BASE_OID_ENV } from '../../scripts/lib/guard-core.ts';
import { BRANCH_SCAN_LIMITS, scanBranchRange } from '../../scripts/lib/publication-branch-scan.ts';
import { runPublicationGuard, validateBranchDiff } from '../../scripts/publication-guard.ts';

const tmp = trackTmpDirs('');
// Built at run time so this test file does not itself carry the literal.
const privatePath = ['~', 'workspace', 'notes'].join('/');

function git(repo: string, args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore', env: cleanGitEnv() });
}

function gitOutput(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: cleanGitEnv() }).trim();
}

function commitFile(repo: string, filePath: string, text: string, message: string): string {
  mkdirSync(join(repo, filePath, '..'), { recursive: true });
  writeFileSync(join(repo, filePath), text);
  git(repo, ['add', filePath]);
  git(repo, ['commit', '-m', message]);
  return gitOutput(repo, ['rev-parse', 'HEAD']);
}

/** A repository whose origin/main is its one base commit. */
function branchRepo(): { repo: string; baseOid: string } {
  const repo = tmp.make('publication-branch-scan');
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'guard-test@users.noreply.github.com']);
  git(repo, ['config', 'user.name', 'Guard Test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  const baseOid = commitFile(repo, 'note.txt', 'public-safe\n', 'base');
  git(repo, ['update-ref', 'refs/remotes/origin/main', baseOid]);
  return { repo, baseOid };
}

const twentyLines = Array.from({ length: 20 }, (_, i) => `// line ${i}\n`).join('');

// Hosted CI sets GITHUB_BASE_REF for the whole job; each case sets what it needs.
beforeEach(() => {
  vi.stubEnv('GITHUB_BASE_REF', '');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('publication branch scan — files Git takes as binary', () => {
  const branchPatch = (repo: string) => gitOutput(repo, ['log', '--format=', '-p', 'origin/main..HEAD', '--', 'src/note.ts']);

  it.each([
    ['a -diff attribute', '.gitattributes', '*.ts -diff\n'],
    ['a binary attribute', '.gitattributes', '*.ts binary\n'],
    ['a nested -diff attribute', 'src/.gitattributes', '*.ts -diff\n'],
  ])('flags a literal that %s on the branch would print as a binary difference', (_label, attributesPath, rule) => {
    const { repo } = branchRepo();
    commitFile(repo, attributesPath, rule, 'mark sources as binary');
    commitFile(repo, 'src/note.ts', `// ${privatePath}\n`, 'add literal');
    commitFile(repo, 'src/note.ts', '// clean\n', 'remove literal');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(branchPatch(repo)).toContain('Binary files');
    expect(runPublicationGuard(['--branch-diff'], repo)).toBe(1);
    expect(error.mock.calls.join('\n')).toContain('local-home-path');
  });

  it.each([
    ['on an earlier line', `\0\n// ${privatePath}\n`],
    ['earlier on the same line', `export const nul = '\0'; // ${privatePath}\n`],
  ])('flags a literal after a NUL byte %s, which makes Git take the file as binary', (_label, text) => {
    const { repo } = branchRepo();
    commitFile(repo, 'src/note.ts', text, 'add literal after a NUL byte');
    commitFile(repo, 'src/note.ts', '// clean\n', 'remove literal');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(branchPatch(repo)).toContain('Binary files');
    expect(runPublicationGuard(['--branch-diff'], repo)).toBe(1);
    expect(error.mock.calls.join('\n')).toContain('local-home-path');
  });
});

describe('publication branch scan — line and time limits', () => {
  it('stops part way through the patch when the added-line limit is passed, and scans no line after the stop', () => {
    const { repo } = branchRepo();
    commitFile(repo, 'src/many.ts', twentyLines, 'twenty added lines');
    const scanned: string[] = [];

    const stopped = scanBranchRange(repo, 'origin/main', (_filePath, text) => {
      scanned.push(text);
      return [];
    }, { ...BRANCH_SCAN_LIMITS, addedLines: 10 });

    expect('inconclusive' in stopped && stopped.inconclusive).toBe('addedLines 11 is over the limit of 10');
    expect(stopped.used.addedLines).toBe(11);
    expect(scanned).toHaveLength(10);
  });

  it('is INCONCLUSIVE when the time limit passes during the scan, and scans no line after the stop', () => {
    const { repo } = branchRepo();
    commitFile(repo, 'src/many.ts', twentyLines, 'twenty added lines');
    let clock = 0;
    const scanned: string[] = [];

    const stopped = scanBranchRange(repo, 'origin/main', (_filePath, text) => {
      scanned.push(text);
      if (scanned.length === 3) clock = 1_001;
      return [];
    }, { ...BRANCH_SCAN_LIMITS, milliseconds: 1_000 }, 'HEAD', () => clock);

    expect('inconclusive' in stopped && stopped.inconclusive).toBe('milliseconds 1001 is over the limit of 1000');
    expect(stopped.used).toMatchObject({ addedLines: 4, milliseconds: 1_001 });
    expect(scanned).toHaveLength(3);
  });

  it('gives a git read only the time left, so a hung read is INCONCLUSIVE within the limit', () => {
    const { repo } = branchRepo();
    commitFile(repo, 'src/note.ts', '// clean\n', 'clean work');
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8', env: cleanGitEnv() }).trim();
    const binDir = join(repo, 'fake-bin');
    mkdirSync(binDir);
    writeFileSync(join(binDir, 'git'), `#!/usr/bin/env bash
if [[ "$1" == "log" ]]; then exec sleep 5; fi
exec '${realGit.replaceAll("'", "'\\''")}' "$@"
`);
    chmodSync(join(binDir, 'git'), 0o755);
    vi.stubEnv('PATH', `${binDir}:${process.env.PATH ?? ''}`);
    const started = Date.now();

    const stopped = validateBranchDiff(repo, 'origin/main', { ...BRANCH_SCAN_LIMITS, milliseconds: 1_000 });

    expect('inconclusive' in stopped && stopped.inconclusive).toContain('a git read failed');
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});

describe('publication branch scan — the base', () => {
  // origin/main stands for any local base that already holds the branch's line: a
  // fork's main, a tracking ref set by hand, or the main of another remote.
  const repoWithBaseHoldingTheLine = () => {
    const { repo, baseOid } = branchRepo();
    commitFile(repo, 'src/note.ts', `// ${privatePath}\n`, 'add literal');
    git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    return { repo, liveBase: baseOid };
  };

  it('compares with the live push base, not a local base that already holds the line', () => {
    const { repo, liveBase } = repoWithBaseHoldingTheLine();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(runPublicationGuard(['--branch-diff'], repo)).toBe(0);
    vi.stubEnv(PUSH_BASE_OID_ENV, liveBase);
    expect(runPublicationGuard(['--branch-diff'], repo)).toBe(1);
    expect(error.mock.calls.join('\n')).toContain('local-home-path');
  });

  it('names the live push base in its scope lines', () => {
    const { repo, baseOid } = branchRepo();
    vi.stubEnv(PUSH_BASE_OID_ENV, baseOid);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(runPublicationGuard(['--branch-diff'], repo)).toBe(0);
    expect(log.mock.calls.join('\n')).toContain(`base: ${baseOid} (the live push base)`);
  });

  it('refuses a GITHUB_BASE_REF that names another commit than the live push base', () => {
    const { repo, liveBase } = repoWithBaseHoldingTheLine();
    vi.stubEnv(PUSH_BASE_OID_ENV, liveBase);
    vi.stubEnv('GITHUB_BASE_REF', 'main');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(runPublicationGuard(['--branch-diff'], repo)).toBe(2);
    expect(error.mock.calls.join('\n')).toContain(`GITHUB_BASE_REF origin/main is not the live push base ${liveBase}`);
  });

  it('accepts a GITHUB_BASE_REF that names the live push base', () => {
    const { repo, baseOid } = branchRepo();
    commitFile(repo, 'src/note.ts', `// ${privatePath}\n`, 'add literal');
    vi.stubEnv(PUSH_BASE_OID_ENV, baseOid);
    vi.stubEnv('GITHUB_BASE_REF', 'main');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(runPublicationGuard(['--branch-diff'], repo)).toBe(1);
  });

  it.each([
    ['an abbreviated id', (oid: string) => oid.slice(0, 12)],
    ['the id of no commit in the repository', () => 'f'.repeat(40)],
    ['a ref name', () => 'origin/main'],
  ])('is INCONCLUSIVE when the live push base is %s', (_label, value) => {
    const { repo, liveBase } = repoWithBaseHoldingTheLine();
    vi.stubEnv(PUSH_BASE_OID_ENV, value(liveBase));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(runPublicationGuard(['--branch-diff'], repo)).toBe(2);
    expect(error.mock.calls.join('\n')).toContain(`${PUSH_BASE_OID_ENV} is not a full id of a commit in this repository`);
  });
});
