// #2219 png-estate guard companion test: invokes the EXACT guard (ratchet mode
// against this repo; staged/ratchet red and boundary cases against fixture
// repos with a mutation-proven red case per rule), and pins the live census to
// the exported baselines so a stale baseline is red, not silent headroom.
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach } from 'vitest';

import {
  MAX_NEW_PNG_BYTES,
  TRACKED_PNG_BYTES_BASELINE,
  TRACKED_PNG_COUNT_BASELINE,
  TRACKED_PNG_SIZE_BASELINE,
} from '../../scripts/png-estate-guard.ts';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const NODE = process.execPath;
const WIZARD = 'docs/screenshots/add-line-wizard.png';
const WIZARD_ORIGINAL_BYTES = 755_125; // pre-compression blob size

const scratchDirs: string[] = [];
afterEach(() => {
  while (scratchDirs.length > 0) rmSync(scratchDirs.pop()!, { recursive: true, force: true });
});

function runGuard(cwd: string, args: string[] = []): { status: number | null; out: string } {
  const res = spawnSync(NODE, [
    '--experimental-strip-types',
    join(REPO_ROOT, 'scripts/png-estate-guard.ts'),
    ...args,
  ], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: res.status, out: `${res.stdout}\n${res.stderr}` };
}

interface Fixture {
  root: string;
  git: (args: string[]) => string;
  put: (path: string, bytes: number, fill?: number) => void;
  commit: (paths: string[]) => void;
}

function makeFixtureRepo(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'png-guard-'));
  scratchDirs.push(root);
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30_000 });
  git(['init', '--quiet']);
  git(['config', 'user.email', 'guard-test@example.invalid']);
  git(['config', 'user.name', 'guard-test']);
  const put = (path: string, bytes: number, fill = 1): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), Buffer.alloc(bytes, fill));
  };
  const commit = (paths: string[]): void => {
    git(['add', '-f', ...paths]);
    git(['commit', '-qm', 'fixture', '--no-verify']);
  };
  return { root, git, put, commit };
}

describe('png-estate guard (#2219)', () => {
  it('ratchet mode passes against this repository', () => {
    const { status, out } = runGuard(REPO_ROOT);
    expect(out).toContain('png-estate guard passed (ratchet)');
    expect(status).toBe(0);
  });

  it('the exported baselines equal the live tracked-PNG census exactly (no silent headroom)', () => {
    // Same plumbing as the guard: NUL rows, symlinks excluded, index blob sizes.
    const rows = execFileSync('git', ['ls-files', '-sz'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30_000,
    }).split('\0').filter(Boolean);
    const sizes: Record<string, number> = {};
    for (const row of rows) {
      const tab = row.indexOf('\t');
      const [mode, oid] = row.slice(0, tab).split(' ');
      const path = row.slice(tab + 1);
      if (mode === '120000' || !path.toLowerCase().endsWith('.png')) continue;
      sizes[path] = Number.parseInt(
        execFileSync('git', ['cat-file', '-s', oid!], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000 }),
        10,
      );
    }
    expect(sizes).toEqual(TRACKED_PNG_SIZE_BASELINE);
    const values = Object.values(sizes);
    expect({ count: values.length, bytes: values.reduce((a, b) => a + b, 0) }).toEqual({
      count: TRACKED_PNG_COUNT_BASELINE,
      bytes: TRACKED_PNG_BYTES_BASELINE,
    });
  });

  it('staged mode rejects a staged PNG under artifacts/, including non-ASCII names', () => {
    const { root, git, put } = makeFixtureRepo();
    put('artifacts/dashboard-polish/regrown.png', 64, 7);
    put('artifacts/dashboard-polish/ä-regrown.png', 64, 8);
    git(['add', '-f', 'artifacts/dashboard-polish']);

    // Keep one exact subprocess call in a live test body so the coverage
    // meta-guard can prove this guard's failure path without trusting the
    // helper call graph.
    const result = spawnSync(NODE, [
      '--experimental-strip-types',
      join(REPO_ROOT, 'scripts/png-estate-guard.ts'),
      '--staged',
    ], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
    });
    const out = `${result.stdout}\n${result.stderr}`;
    expect(result.status).toBe(1);
    expect(out).toContain('regrown.png: artifacts/ images are not tracked');
    expect(out).toContain('ä-regrown.png: artifacts/ images are not tracked');
  });

  it('staged mode sizes the INDEX blob: oversized staged bytes stay red after a worktree truncation, small ones stay green', () => {
    const { root, git, put } = makeFixtureRepo();
    put('docs/screenshots/huge.png', 150 * 1024);
    git(['add', 'docs/screenshots/huge.png']);
    // Post-staging truncation must not change the verdict (the index blob is
    // what lands in history).
    put('docs/screenshots/huge.png', 8);

    const oversized = runGuard(root, ['--staged']);
    expect(oversized.status).toBe(1);
    expect(oversized.out).toContain('exceeds the');
    expect(oversized.out).toContain(String(MAX_NEW_PNG_BYTES));

    git(['reset']);
    put('docs/screenshots/small.png', 8 * 1024);
    git(['add', 'docs/screenshots/small.png']);
    const small = runGuard(root, ['--staged']);
    expect(small.out).toContain('png-estate guard passed (staged)');
    expect(small.status).toBe(0);
  });

  it('staged mode catches an oversized rename-with-modification (diff-filter includes R)', () => {
    const { root, git, put, commit } = makeFixtureRepo();
    put('docs/screenshots/before.png', 90 * 1024, 2);
    commit(['docs/screenshots/before.png']);

    renameSync(join(root, 'docs/screenshots/before.png'), join(root, 'docs/screenshots/after.png'));
    put('docs/screenshots/after.png', 150 * 1024, 3);
    git(['add', '-A', 'docs/screenshots']);

    const { status, out } = runGuard(root, ['--staged']);
    expect(status).toBe(1);
    expect(out).toContain('docs/screenshots/after.png');
    expect(out).toContain('exceeds the');
  });

  describe('staged: a tracked docs/screenshots PNG may not grow', () => {
    function staged(headBytes: number, newBytes: number, path = 'docs/screenshots/shot.png') {
      const fx = makeFixtureRepo();
      fx.put(path, headBytes, 9);
      fx.commit([path]);
      fx.put(path, newBytes, 10);
      fx.git(['add', path]);
      return runGuard(fx.root, ['--staged']);
    }

    it('passes at exactly the HEAD size, above the new-PNG bound', () => {
      const res = staged(500 * 1024, 500 * 1024);
      expect(res.out).toContain('png-estate guard passed (staged): 1 staged PNG(s)');
      expect(res.status).toBe(0);
    });

    it('passes a shrink that stays above the new-PNG bound', () => {
      const res = staged(700 * 1024, 300 * 1024);
      expect(res.status).toBe(0);
    });

    it('rejects one byte of growth, even below the new-PNG bound', () => {
      const res = staged(47 * 1024, 47 * 1024 + 1);
      expect(res.status).toBe(1);
      expect(res.out).toContain('a tracked screenshot may not grow');
    });

    it('does not extend to a changed PNG outside docs/screenshots/', () => {
      const res = staged(300 * 1024, 200 * 1024, 'docs/design-system/tracked.png');
      expect(res.status).toBe(1);
      expect(res.out).toContain('new-PNG bound');
    });

    it('holds a NEW docs/screenshots PNG to the new-PNG bound: exactly the bound passes, one byte over fails', () => {
      const fx = makeFixtureRepo();
      fx.put('docs/screenshots/seed.png', 16);
      fx.commit(['docs/screenshots/seed.png']);
      fx.put('docs/screenshots/new.png', MAX_NEW_PNG_BYTES, 11);
      fx.git(['add', 'docs/screenshots/new.png']);
      expect(runGuard(fx.root, ['--staged']).status).toBe(0);
      fx.put('docs/screenshots/new.png', MAX_NEW_PNG_BYTES + 1, 11);
      fx.git(['add', 'docs/screenshots/new.png']);
      const over = runGuard(fx.root, ['--staged']);
      expect(over.status).toBe(1);
      expect(over.out).toContain('new-PNG bound');
    });
  });

  it('ratchet mode rejects a tracked PNG under artifacts/ regardless of extension case', () => {
    const { root, put, commit } = makeFixtureRepo();
    put('artifacts/tracked.PnG', 64, 3);
    commit(['artifacts/tracked.PnG']);

    const { status, out } = runGuard(root);
    expect(status).toBe(1);
    expect(out).toContain('tracked PNG(s) under artifacts/');
  });

  it('ratchet mode rejects census growth beyond the count baseline', () => {
    const { root, put, commit } = makeFixtureRepo();
    for (let i = 0; i < TRACKED_PNG_COUNT_BASELINE + 1; i += 1) put(`docs/screenshots/s${i}.png`, 16, i % 251);
    commit(['docs/screenshots']);

    const { status, out } = runGuard(root);
    expect(status).toBe(1);
    expect(out).toContain(
      `tracked PNG count ${TRACKED_PNG_COUNT_BASELINE + 1} exceeds the ratchet baseline ${TRACKED_PNG_COUNT_BASELINE}`,
    );
  });

  it('ratchet mode rejects total-byte growth when every file is within its own bound', () => {
    // 24 baselined paths at exactly their baseline plus one unbaselined PNG at
    // exactly the new-PNG bound (larger than the dropped path): count and every
    // per-file rule hold, only the total exceeds.
    const { root, put, commit } = makeFixtureRepo();
    const entries = Object.entries(TRACKED_PNG_SIZE_BASELINE).sort((a, b) => a[1] - b[1]);
    const [dropped, ...kept] = entries;
    expect(dropped![1]).toBeLessThan(MAX_NEW_PNG_BYTES);
    for (const [path, bytes] of kept) put(path, bytes);
    put('docs/screenshots/extra.png', MAX_NEW_PNG_BYTES);
    commit(['docs']);

    const { status, out } = runGuard(root);
    expect(status).toBe(1);
    expect(out).toMatch(/tracked PNG bytes \d+ exceed the ratchet baseline/);
    expect(out).not.toContain('per-path size baseline');
    expect(out).not.toContain('new-PNG bound');
    expect(out).not.toContain('tracked PNG count');
  });

  describe('ratchet: per-path size baseline (CI enforcement)', () => {
    function ratchet(files: Array<[string, number]>) {
      const fx = makeFixtureRepo();
      for (const [path, bytes] of files) fx.put(path, bytes);
      fx.commit(files.map(([path]) => path));
      return runGuard(fx.root);
    }

    it('rejects a NEW unbaselined 600 KB screenshot', () => {
      const res = ratchet([['docs/screenshots/new-shot.png', 600 * 1024]]);
      expect(res.status).toBe(1);
      expect(res.out).toContain('outside the per-path baseline exceed the');
      expect(res.out).toContain('docs/screenshots/new-shot.png');
    });

    it('holds an unbaselined PNG anywhere to the new-PNG bound: exactly the bound passes, one byte over fails', () => {
      expect(ratchet([['docs/other/new.png', MAX_NEW_PNG_BYTES]]).status).toBe(0);
      const over = ratchet([['docs/other/new.png', MAX_NEW_PNG_BYTES + 1]]);
      expect(over.status).toBe(1);
      expect(over.out).toContain('new-PNG bound');
    });

    it('rejects a baselined screenshot regrown to its pre-compression size', () => {
      const res = ratchet([[WIZARD, WIZARD_ORIGINAL_BYTES]]);
      expect(res.status).toBe(1);
      expect(res.out).toContain(`${WIZARD} (${WIZARD_ORIGINAL_BYTES} > ${TRACKED_PNG_SIZE_BASELINE[WIZARD]} bytes)`);
    });

    it('passes a baselined screenshot at exactly its baseline, fails one byte over, passes a shrink', () => {
      const base = TRACKED_PNG_SIZE_BASELINE[WIZARD]!;
      expect(ratchet([[WIZARD, base]]).status).toBe(0);
      const over = ratchet([[WIZARD, base + 1]]);
      expect(over.status).toBe(1);
      expect(over.out).toContain('a tracked PNG may not grow');
      expect(ratchet([[WIZARD, base - 1024]]).status).toBe(0);
    });
  });
});
