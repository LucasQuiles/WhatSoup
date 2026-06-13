import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanGitEnv } from '../../scripts/lib/guard-core.ts';
import { isInternalPublicationPath, runPublicationGuard } from '../../scripts/publication-guard.ts';

const internalDocPath = 'docs/sdlc/closed/example/state.md';

const repos: string[] = [];

function git(repo: string, args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore', env: cleanGitEnv() });
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
});
