import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PNG_SIGNATURE, seededBinary } from '../helpers/seeded-binary.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';
import { cleanGitEnv, createVerifiedBinaryCheck, PUSH_BASE_OID_ENV } from '../../scripts/lib/guard-core.ts';
import { BRANCH_SCAN_LIMITS, isPublicationFixtureExempt, scanBranchRange } from '../../scripts/lib/publication-branch-scan.ts';
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

function stageFile(repo: string, filePath: string, content: string | Buffer): void {
  mkdirSync(join(repo, filePath, '..'), { recursive: true });
  writeFileSync(join(repo, filePath), content);
  git(repo, ['add', filePath]);
}

function commitFile(repo: string, filePath: string, content: string | Buffer, message: string): string {
  stageFile(repo, filePath, content);
  git(repo, ['commit', '-m', message]);
  return gitOutput(repo, ['rev-parse', 'HEAD']);
}

/** The guard's exit code, and the paths and codes of the issues it printed, each once. */
function guardRun(repo: string, mode: '--staged' | '--branch-diff'): { code: number; paths: string[]; codes: string[] } {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const code = runPublicationGuard([mode], repo);
  const issues = error.mock.calls
    .map((call) => /^(\S+):\d+ \S+ (\S+):/.exec(String(call[0])))
    .filter((match): match is RegExpExecArray => match !== null);
  vi.restoreAllMocks();
  return {
    code,
    paths: [...new Set(issues.map((match) => match[1]))].sort(),
    codes: [...new Set(issues.map((match) => match[2]))].sort(),
  };
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

describe('publication scans — which paths they read', () => {
  const homeLine = `# ${privatePath}\n`;
  const flaggedAt = (filePath: string) => ({ code: 1, paths: [filePath], codes: ['local-home-path'] });

  it.each([
    ['a Python file', 'src/tool.py'],
    ['an extensionless script', 'bin/run'],
    ['an unlisted extension', 'assets/data.dat'],
    ['a text file in a fixture area', 'tools/agent-runtime-probes/probe.ts'],
    ['a fixture source file', 'scripts/repo-hygiene-guard.ts'],
  ])('flags a workspace path in %s when staged, in the branch diff, and from history after removal', (_label, filePath) => {
    const { repo } = branchRepo();
    stageFile(repo, filePath, homeLine);
    expect(guardRun(repo, '--staged')).toEqual(flaggedAt(filePath));
    git(repo, ['commit', '-m', 'add literal']);
    expect(guardRun(repo, '--branch-diff')).toEqual(flaggedAt(filePath));
    commitFile(repo, filePath, '# clean\n', 'remove literal');
    expect(guardRun(repo, '--branch-diff')).toEqual(flaggedAt(filePath));
  });

  it('keeps a fixture area on its earlier selection, and flags the same line in a file outside it', () => {
    const { repo } = branchRepo();
    const fixtures = ['tools/agent-runtime-probes/probe.py', 'tests/fixtures/redaction-parity-corpus.jsonl'];
    for (const filePath of [...fixtures, 'src/probe.py']) stageFile(repo, filePath, homeLine);
    expect(guardRun(repo, '--staged')).toEqual(flaggedAt('src/probe.py'));
    git(repo, ['commit', '-m', 'add literals']);
    expect(guardRun(repo, '--branch-diff')).toEqual(flaggedAt('src/probe.py'));
    expect(fixtures.map(isPublicationFixtureExempt)).toEqual([true, true]);
    expect(['tools/agent-runtime-probes/probe.ts', 'scripts/repo-hygiene-guard.ts', 'src/probe.py'].map(isPublicationFixtureExempt))
      .toEqual([false, false, false]);
  });

  it('skips a verified image that carries a workspace path, and flags the same bytes under an unlisted name', () => {
    const { repo } = branchRepo();
    const bytes = seededBinary(PNG_SIGNATURE, [privatePath]);
    stageFile(repo, 'assets/shot.PNG', bytes);
    stageFile(repo, 'assets/shot.dat', bytes);
    for (const mode of ['--staged', '--branch-diff'] as const) {
      const result = guardRun(repo, mode);
      expect(result.code).toBe(1);
      expect(result.paths).toEqual(['assets/shot.dat']);
      expect(result.codes).toContain('local-home-path');
      if (mode === '--staged') git(repo, ['commit', '-m', 'add images']);
    }
  });

  it('flags text that replaces a verified image, from the new blob, and from history once the image is back', () => {
    const { repo } = branchRepo();
    const filePath = 'assets/shot.png';
    const image = seededBinary(PNG_SIGNATURE);
    git(repo, ['update-ref', 'refs/remotes/origin/main', commitFile(repo, filePath, image, 'image at the base')]);

    stageFile(repo, filePath, homeLine);
    expect(guardRun(repo, '--staged')).toEqual(flaggedAt(filePath));
    git(repo, ['commit', '-m', 'text under the image name']);
    expect(guardRun(repo, '--branch-diff')).toEqual(flaggedAt(filePath));
    commitFile(repo, filePath, image, 'image back');
    expect(guardRun(repo, '--branch-diff')).toEqual(flaggedAt(filePath));
  });

  it('never takes a commit id, as a gitlink\'s index line gives, for a verified image', () => {
    const { repo, baseOid } = branchRepo();
    writeFileSync(join(repo, 'shot.png'), seededBinary(PNG_SIGNATURE));
    const imageBlob = gitOutput(repo, ['hash-object', '-w', 'shot.png']);
    const isVerifiedBinary = createVerifiedBinaryCheck(repo);

    expect(isVerifiedBinary('vendor/sub.png', imageBlob)).toBe(true);
    expect(isVerifiedBinary('vendor/sub.png', baseOid)).toBe(false);
    expect(isVerifiedBinary('vendor/sub.png', undefined)).toBe(false);
    expect(isVerifiedBinary('vendor/sub.dat', imageBlob)).toBe(false);
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

  /** Put a git on PATH that sleeps for the reads `hangs` matches and runs the real git otherwise. */
  const hangGitReads = (repo: string, hangs: string) => {
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8', env: cleanGitEnv() }).trim();
    const binDir = join(repo, 'fake-bin');
    mkdirSync(binDir);
    writeFileSync(join(binDir, 'git'), `#!/usr/bin/env bash
if [[ ${hangs} ]]; then exec sleep 5; fi
exec '${realGit.replaceAll("'", "'\\''")}' "$@"
`);
    chmodSync(join(binDir, 'git'), 0o755);
    vi.stubEnv('PATH', `${binDir}:${process.env.PATH ?? ''}`);
  };

  it('gives a git read only the time left, so a hung read is INCONCLUSIVE within the limit', () => {
    const { repo } = branchRepo();
    commitFile(repo, 'src/note.ts', '// clean\n', 'clean work');
    hangGitReads(repo, '"$1" == "log"');
    const started = Date.now();

    const stopped = validateBranchDiff(repo, 'origin/main', { ...BRANCH_SCAN_LIMITS, milliseconds: 1_000 });

    expect('inconclusive' in stopped && stopped.inconclusive).toContain('a git read failed');
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('gives a blob read for the verified-binary check only the time left, and is INCONCLUSIVE when it runs out', () => {
    const { repo } = branchRepo();
    // A small verified PNG: signature, a header length that starts with a NUL, nothing a rule matches.
    commitFile(repo, 'assets/dot.png', Buffer.concat([Buffer.from(PNG_SIGNATURE), Buffer.from([0, 0, 0, 0x0d]), Buffer.from('IHDR\n')]), 'image');
    hangGitReads(repo, '"$1" == "cat-file" && "$2" == "blob"');
    const started = Date.now();

    const stopped = validateBranchDiff(repo, 'origin/main', { ...BRANCH_SCAN_LIMITS, milliseconds: 1_000 });

    expect('inconclusive' in stopped && stopped.inconclusive).toMatch(/^milliseconds \d+ is over the limit of 1000$/);
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
