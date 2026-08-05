import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  scanForZeroByteTracked,
  scanForZeroByteTrackedCounted,
} from '../../scripts/check-zero-byte-tracked.ts';

// The guard enumerates via `git ls-files`, so every case needs a real repo —
// a plain fixture directory would report zero tracked files and prove nothing.
const repos: string[] = [];

function makeRepo(files: Record<string, string>, opts: { track?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'zero-byte-guard-'));
  repos.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  if (opts.track !== false) execFileSync('git', ['add', '-A'], { cwd: root });
  return root;
}

afterEach(() => {
  while (repos.length) rmSync(repos.pop()!, { recursive: true, force: true });
});

const files = (root: string) => scanForZeroByteTracked(root).map((f) => f.file);

describe('zero-byte tracked-file guard', () => {
  it('flags a tracked file emptied to zero bytes', () => {
    // The regression case: CLUSTER-alert-recovery-lifecycle.md landed at 0 bytes.
    const root = makeRepo({ 'CLUSTER-notes.md': '', 'README.md': 'real content\n' });
    expect(files(root)).toEqual(['CLUSTER-notes.md']);
  });

  it('does not flag files that have content', () => {
    const root = makeRepo({ 'a.md': 'x\n', 'b/c.ts': 'export const x = 1;\n' });
    expect(files(root)).toEqual([]);
  });

  it('allows placeholders whose entire purpose is to be empty', () => {
    const root = makeRepo({
      'lib/.gitkeep': '',
      'other/.keep': '',
      'pkg/__init__.py': '',
      'pkg/py.typed': '',
      'seed/.placeholder': '',
    });
    expect(files(root)).toEqual([]);
  });

  it('matches the allowlist by exact basename, not by suffix or prefix', () => {
    // A suffix/substring rule would let an emptied `notes.gitkeep` or a
    // `.gitkeep.md` through — which is the class of hole this guard exists for.
    const root = makeRepo({ 'notes.gitkeep': '', '.gitkeep.md': '', 'x/.gitkeep': '' });
    expect(files(root).sort()).toEqual(['.gitkeep.md', 'notes.gitkeep']);
  });

  it('flags an emptied .gitignore — being empty is not its purpose', () => {
    const root = makeRepo({ '.gitignore': '', 'keep.md': 'content\n' });
    expect(files(root)).toEqual(['.gitignore']);
  });

  it('ignores untracked zero-byte files', () => {
    const root = makeRepo({ 'tracked.md': 'content\n' });
    writeFileSync(join(root, 'scratch.md'), '');
    expect(files(root)).toEqual([]);
  });

  it('ignores symlinks, whose lstat size is their target path length', () => {
    const root = makeRepo({ 'real.md': 'content\n' });
    symlinkSync('real.md', join(root, 'link.md'));
    execFileSync('git', ['add', '-A'], { cwd: root });
    expect(files(root)).toEqual([]);
  });

  it('surfaces a non-empty findings list when a tracked file is emptied', () => {
    // Failure path proven on the counted result itself: the guard-test-coverage
    // checker requires an in-test invocation linked to a non-empty findings
    // assertion — the files() helper above hides the invocation from that walk.
    const result = scanForZeroByteTrackedCounted(
      makeRepo({ 'emptied.md': '', 'real.md': 'content\n' }),
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings.map((f) => f.file)).toContain('emptied.md');
  });

  it('reports how many tracked files it examined, so a no-op scan is detectable', () => {
    const withFiles = scanForZeroByteTrackedCounted(makeRepo({ 'a.md': 'x\n', 'b.md': 'y\n' }));
    expect(withFiles.filesExamined).toBe(2);

    const empty = scanForZeroByteTrackedCounted(makeRepo({}));
    expect(empty.filesExamined).toBe(0);
    expect(empty.findings).toEqual([]);
  });
});
