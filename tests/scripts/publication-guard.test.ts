import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runPublicationGuard } from '../../scripts/publication-guard.ts';

const internalDocPath = 'docs/sdlc/closed/example/state.md';

const repos: string[] = [];

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

  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['add', 'docs/publication-audit.md', internalDocPath], { cwd: repo, stdio: 'ignore' });
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
