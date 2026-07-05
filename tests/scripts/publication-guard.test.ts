import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanGitEnv } from '../../scripts/lib/guard-core.ts';
import {
  internalPublicationRoots,
  isInternalPublicationPath,
  runPublicationGuard,
  scanTextForPrivateLiterals,
} from '../../scripts/publication-guard.ts';

const internalDocPath = 'docs/sdlc/closed/example/state.md';

const repos: string[] = [];

function git(repo: string, args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore', env: cleanGitEnv() });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function installGitShowFailureShim(repo: string): void {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8', env: cleanGitEnv() }).trim();
  const binDir = join(repo, 'fake-bin');
  mkdirSync(binDir);
  const fakeGit = join(binDir, 'git');
  writeFileSync(fakeGit, `#!/usr/bin/env bash
if [[ "$1" == "show" && "$2" == ":0:docs/publication-audit.md" ]]; then
  echo "fatal: simulated object database read failure" >&2
  exit 128
fi
exec ${shellQuote(realGit)} "$@"
`);
  chmodSync(fakeGit, 0o755);
  vi.stubEnv('PATH', `${binDir}:${process.env.PATH ?? ''}`);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const repo of repos.splice(0)) {
    rmSync(repo, { recursive: true, force: true });
  }
});

function makeRepo(docText: string, classification: 'PUBLIC' | 'PRIVATE-ARCHIVE'): string {
  const repo = mkdtempSync(join(tmpdir(), 'publication-guard-'));
  repos.push(repo);

  mkdirSync(join(repo, 'docs/sdlc/closed/example'), { recursive: true });
  writeFileSync(join(repo, internalDocPath), docText);
  writeFileSync(join(repo, 'docs/publication-audit.md'), `# Publication Audit

**Total classification rows:** 1

| Classification | Count |
|---|---:|
| PUBLIC | ${classification === 'PUBLIC' ? 1 : 0} |
| PRIVATE-ARCHIVE | ${classification === 'PRIVATE-ARCHIVE' ? 1 : 0} |
| SANITIZE | 0 |
| DELETE | 0 |
| Total | 1 |

| Path | Classification | Rationale |
|---|---|---|
| \`${internalDocPath}\` | ${classification} | Fixture row. |
`);

  git(repo, ['init']);
  git(repo, ['add', 'docs/publication-audit.md', internalDocPath]);
  return repo;
}

describe('publication guard release mode', () => {
  it('passes when every tracked internal doc is PUBLIC and private-literal clean', () => {
    const repo = makeRepo('Public-safe release note.\n', 'PUBLIC');

    expect(runPublicationGuard(['--release'], repo)).toBe(0);
  });

  it('fails when a tracked internal doc remains non-PUBLIC', () => {
    const repo = makeRepo('Internal release prep note.\n', 'PRIVATE-ARCHIVE');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(runPublicationGuard(['--release'], repo)).toBe(1);
    expect(error.mock.calls.join('\n')).toContain('release-internal-doc-still-tracked');
  });

  it('fails when a PUBLIC row still contains private literals', () => {
    const privatePath = ['/Users', 'privateuser', 'LAB', 'WhatSoup'].join('/');
    const repo = makeRepo(`Operator path: ${privatePath}\n`, 'PUBLIC');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(runPublicationGuard(['--release'], repo)).toBe(1);
    expect(error.mock.calls.join('\n')).toContain('local-home-path');
  });
});

describe('publication guard staged mode', () => {
  it('fails when staged internal docs are missing audit classification', () => {
    const repo = makeRepo('Public-safe release note.\n', 'PUBLIC');
    const newInternalDoc = 'docs/sdlc/closed/example/new-state.md';
    writeFileSync(join(repo, newInternalDoc), 'Internal planning note.\n');
    git(repo, ['add', newInternalDoc]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(runPublicationGuard(['--staged'], repo)).toBe(1);
    expect(error.mock.calls.join('\n')).toContain('staged-internal-doc-unclassified');
  });

  it('fails when staged markdown adds broken docs references', () => {
    const repo = makeRepo('Public-safe release note.\n', 'PUBLIC');
    const publicDoc = 'docs/readme.md';
    writeFileSync(join(repo, publicDoc), 'See `docs/missing-reference.md` for details.\n');
    git(repo, ['add', publicDoc]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(runPublicationGuard(['--staged'], repo)).toBe(1);
    expect(error.mock.calls.join('\n')).toContain('missing-doc-ref');
  });

  it('fails when staged public text adds private literals', () => {
    const repo = makeRepo('Public-safe release note.\n', 'PUBLIC');
    const publicDoc = 'docs/public-note.md';
    const token = ['ghp_', 'abcdefghijklmnop'].join('');
    writeFileSync(join(repo, publicDoc), `token: ${token}\n`);
    git(repo, ['add', publicDoc]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(runPublicationGuard(['--staged'], repo)).toBe(1);
    expect(error.mock.calls.join('\n')).toContain('github-token');
  });

  it('reports staged audit read errors separately from missing audit rows', () => {
    const repo = makeRepo('Public-safe release note.\n', 'PUBLIC');
    installGitShowFailureShim(repo);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(runPublicationGuard(['--staged'], repo)).toBe(1);
    expect(error.mock.calls.join('\n')).toContain('audit-read-failed');
  });

  it('allows shape-preserving synthetic LID fixtures in staged public text', () => {
    const repo = makeRepo('Public-safe release note.\n', 'PUBLIC');
    const publicDoc = 'docs/public-note.md';
    writeFileSync(join(repo, publicDoc), 'fixture: 81536414179000@lid\n');
    git(repo, ['add', publicDoc]);

    expect(runPublicationGuard(['--staged'], repo)).toBe(0);
  });

  it('ignores inherited hook Git environment when checking synthetic repos', () => {
    const repo = makeRepo('Public-safe release note.\n', 'PUBLIC');
    const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: cleanGitEnv(),
    }).trim();
    vi.stubEnv('GIT_DIR', gitDir);
    vi.stubEnv('GIT_WORK_TREE', process.cwd());

    expect(runPublicationGuard(['--release'], repo)).toBe(0);
  });
});

describe('publication guard root classification', () => {
  it('classifies docs/runbooks/ files as internal', () => {
    expect(isInternalPublicationPath('docs/runbooks/objective-tracking.md')).toBe(true);
    expect(isInternalPublicationPath('docs/runbooks/host-maintenance.md')).toBe(true);
  });

  it('fails staged mode when a docs/runbooks/ file is staged without audit classification', () => {
    const repo = mkdtempSync(join(tmpdir(), 'publication-guard-rb-'));
    repos.push(repo);

    mkdirSync(join(repo, 'docs/runbooks'), { recursive: true });
    const runbookPath = 'docs/runbooks/example-runbook.md';
    writeFileSync(join(repo, runbookPath), 'Internal operator runbook.\n');
    writeFileSync(join(repo, 'docs/publication-audit.md'), `# Publication Audit

**Total classification rows:** 0

| Classification | Count |
|---|---:|
| PUBLIC | 0 |
| PRIVATE-ARCHIVE | 0 |
| SANITIZE | 0 |
| DELETE | 0 |
| Total | 0 |

| Path | Classification | Rationale |
|---|---|---|
`);

    git(repo, ['init']);
    git(repo, ['add', runbookPath]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(runPublicationGuard(['--staged'], repo)).toBe(1);
    expect(error.mock.calls.join('\n')).toContain('staged-internal-doc-unclassified');
  });

  it('fails when a new runbook is staged but its audit row is only in the working tree', () => {
    const repo = mkdtempSync(join(tmpdir(), 'publication-guard-staged-audit-'));
    repos.push(repo);

    mkdirSync(join(repo, 'docs/runbooks'), { recursive: true });
    const existingRunbook = 'docs/runbooks/existing.md';
    const lines = ['# Publication Audit', '', '**Total classification rows:** 1', '', '| Classification | Count |', '|---|---:|', '| PUBLIC | 0 |', '| PRIVATE-ARCHIVE | 1 |', '| SANITIZE | 0 |', '| DELETE | 0 |', '| Total | 1 |', '', '| Path | Classification | Rationale |', '|---|---|---|', '| `' + existingRunbook + '` | PRIVATE-ARCHIVE | Existing runbook. |', ''];
    const initialAudit = lines.join('\n');

    writeFileSync(join(repo, existingRunbook), 'Existing runbook content.\n');
    writeFileSync(join(repo, 'docs/publication-audit.md'), initialAudit);
    git(repo, ['init']);
    // CI runners have no global git identity; the temp repo must provide one
    // for the baseline commit to succeed.
    git(repo, ['config', 'user.email', 'guard-test@users.noreply.github.com']);
    git(repo, ['config', 'user.name', 'Guard Test']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    git(repo, ['add', existingRunbook, 'docs/publication-audit.md']);
    git(repo, ['commit', '-m', 'initial']);

    const newRunbook = 'docs/runbooks/new-runbook.md';
    writeFileSync(join(repo, newRunbook), 'New internal runbook.\n');
    git(repo, ['add', newRunbook]);

    const updatedLines = ['# Publication Audit', '', '**Total classification rows:** 2', '', '| Classification | Count |', '|---|---:|', '| PUBLIC | 0 |', '| PRIVATE-ARCHIVE | 2 |', '| SANITIZE | 0 |', '| DELETE | 0 |', '| Total | 2 |', '', '| Path | Classification | Rationale |', '|---|---|---|', '| `' + existingRunbook + '` | PRIVATE-ARCHIVE | Existing runbook. |', '| `' + newRunbook + '` | PRIVATE-ARCHIVE | New runbook. |', ''];
    writeFileSync(join(repo, 'docs/publication-audit.md'), updatedLines.join('\n'));

    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(runPublicationGuard(['--staged'], repo)).toBe(1);
    expect(error.mock.calls.join('\n')).toContain('staged-internal-doc-unclassified');
  });
});

describe('publication audit root list drift pin', () => {
  it('docs/publication-audit.md prose root list has an exemplar for every internalPublicationRoots pattern', () => {
    const repoRoot = resolve(new URL('../..', import.meta.url).pathname);
    const auditText = readFileSync(join(repoRoot, 'docs/publication-audit.md'), 'utf8');
    const proseLine =
      auditText.split('\n').find((line) => line.includes('Internal publication roots covered by the guard:')) ?? '';
    // Extract backtick-quoted tokens from the prose line using index-based split.
    // (Avoids backtick-inside-regex that confuses tree-sitter paren matching.)
    const proseTokens: string[] = proseLine.split('`').filter((_, i) => i % 2 === 1);

    // Build exemplar paths from each prose token.
    // For directory roots (ends with /): append an example file path.
    // For glob patterns (contains *): replace * with empty or a concrete value.
    // For exact file refs: use as-is.
    const exemplars: string[] = [];
    for (const token of proseTokens) {
      const baseExact = token.replace(/\*([^*]*)$/, '$1').replace(/\/$/, '');
      const baseFilled = token.replace(/\*([^*]*)$/, 'example$1').replace(/\/$/, '');
      exemplars.push(
        baseExact, baseExact + '/example.md', baseExact + '/sub/file.md', baseExact + '.md', baseExact + '.json',
        baseFilled, baseFilled + '/example.md', baseFilled + '/sub/file.md', baseFilled + '.md', baseFilled + '.json',
      );
    }

    const missingPatterns: string[] = [];
    for (const pattern of internalPublicationRoots) {
      let covered = false;
      for (const c of exemplars) {
        if (pattern.test(c)) {
          covered = true;
          break;
        }
      }
      if (!covered) missingPatterns.push(String(pattern));
    }

    expect(missingPatterns).toEqual([]);
  });
});

describe('publication guard operational allowlist', () => {
  it('allows template-unit tokens only in operational fleet files, never alongside a real address', () => {
    // Composed so the test source itself carries no email-shaped literal.
    const personalUnit = ['whatsoup@personal', 'service'].join('.');
    expect(scanTextForPrivateLiterals('deploy/health-profiles/nucles.json', `"service": "${personalUnit}"`)).toEqual(
      [],
    );

    const flaggedElsewhere = scanTextForPrivateLiterals(
      'deploy/health-profiles/mini1.json',
      `"service": "${personalUnit}"`,
    );
    expect(flaggedElsewhere.map((issue) => issue.code)).toEqual(['personal-email']);

    const realAddress = ['operator', 'example.com'].join('@');
    const mixedLine = scanTextForPrivateLiterals(
      'deploy/health-profiles/nucles.json',
      `"service": "${personalUnit}" contact ${realAddress}`,
    );
    expect(mixedLine.map((issue) => issue.code)).toEqual(['personal-email']);
  });
});
