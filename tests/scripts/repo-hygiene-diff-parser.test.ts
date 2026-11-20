/**
 * The added-line parser of the repository hygiene guard reads a hunk by its header counts.
 *
 * An added line whose text starts with `++ ` prints as `+++ …` in a unified diff. Read as a file
 * header, `+++ /dev/null` would drop every later added line of that file, and `+++ b/<path>` would
 * move them to another path. Inside a hunk's declared counts every `+` line is content; past the
 * counts the parser keeps its earlier handling, so short hand-written diffs keep their lines.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveBoundaryTerms } from '../../scripts/lib/repo-hygiene-boundary.ts';
import { parseUnifiedDiffAddedLines, scanAddedLines } from '../../scripts/repo-hygiene-guard.ts';
import { isolatedGitEnv } from '../helpers/isolated-git-env.ts';
import { SYNTHETIC_PRIVATE_TERMS_FILE } from '../helpers/private-terms-env.ts';

const termRules = resolveBoundaryTerms({ WHATSOUP_PRIVATE_TERMS_FILE: SYNTHETIC_PRIVATE_TERMS_FILE }).rules;

describe('parseUnifiedDiffAddedLines inside a hunk', () => {
  it('reads an added line that starts with "++ /dev/null" as content and keeps the lines after it', () => {
    const lines = parseUnifiedDiffAddedLines([
      'diff --git a/notes.md b/notes.md',
      '--- a/notes.md',
      '+++ b/notes.md',
      '@@ -1,0 +2,3 @@',
      '+++ /dev/null',
      '+second',
      '+third',
      '',
    ].join('\n'));
    expect(lines).toEqual([
      { filePath: 'notes.md', line: 2, text: '++ /dev/null' },
      { filePath: 'notes.md', line: 3, text: 'second' },
      { filePath: 'notes.md', line: 4, text: 'third' },
    ]);
  });

  it('keeps the file of the hunk when an added line names another path', () => {
    const lines = parseUnifiedDiffAddedLines([
      'diff --git a/docs/a.md b/docs/a.md',
      '--- a/docs/a.md',
      '+++ b/docs/a.md',
      '@@ -3 +3,2 @@',
      '-old',
      '+++ b/tests/fixtures/other.json',
      '+kept',
      'diff --git a/docs/b.md b/docs/b.md',
      '--- a/docs/b.md',
      '+++ b/docs/b.md',
      '@@ -0,0 +1 @@',
      '+next file',
      '',
    ].join('\n'));
    expect(lines).toEqual([
      { filePath: 'docs/a.md', line: 3, text: '++ b/tests/fixtures/other.json' },
      { filePath: 'docs/a.md', line: 4, text: 'kept' },
      { filePath: 'docs/b.md', line: 1, text: 'next file' },
    ]);
  });

  it('keeps the earlier handling past the declared counts', () => {
    const lines = parseUnifiedDiffAddedLines([
      '+++ b/notes.md',
      '@@ -0,0 +1 @@',
      '+counted',
      '+past the count',
      '',
    ].join('\n'));
    expect(lines).toEqual([
      { filePath: 'notes.md', line: 1, text: 'counted' },
      { filePath: 'notes.md', line: 2, text: 'past the count' },
    ]);
  });
});

describe('a real git diff with a header-shaped added line', () => {
  let root: string | null = null;

  afterEach(() => {
    if (root !== null) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it('still finds a synthetic term on the line after "++ /dev/null"', () => {
    root = mkdtempSync(join(tmpdir(), 'whatsoup-diff-parser-'));
    const git = (...args: string[]): string => execFileSync('git', args, {
      cwd: root!,
      env: isolatedGitEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    git('init', '-q');
    git('config', 'user.name', 'Guard Test');
    git('config', 'user.email', 'guard@users.noreply.github.com');
    writeFileSync(join(root, 'notes.md'), 'one\n');
    git('add', 'notes.md');
    git('commit', '-q', '-m', 'base');
    writeFileSync(join(root, 'notes.md'), 'one\n++ /dev/null\nruns on zorblab\n');
    git('commit', '-q', '-am', 'head');

    const diff = git('diff', '--unified=0', '--no-ext-diff', 'HEAD^', 'HEAD');
    expect(diff).toContain('\n+++ /dev/null\n');
    const lines = parseUnifiedDiffAddedLines(diff);
    expect(lines.map((line) => line.line)).toEqual([2, 3]);
    const codes = scanAddedLines(lines, termRules).map((issue) => `${issue.filePath}:${issue.line}:${issue.code}`);
    expect(codes).toContain('notes.md:3:private-host-label');
  });
});
