// #2219 Option A — png-estate guard companion test: invokes the EXACT guard
// (ratchet mode against this repo; staged/ratchet red cases against fixture
// repos with a mutation-proven red case per rule), and pins the live census to
// the exported baselines so a stale baseline is red, not silent headroom.
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach } from 'vitest';

import {
  DOCS_SCREENSHOT_MAX_BYTES,
  MAX_NEW_PNG_BYTES,
  TRACKED_PNG_BYTES_BASELINE,
  TRACKED_PNG_COUNT_BASELINE,
} from '../../scripts/png-estate-guard.ts';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const GUARD = join(REPO_ROOT, 'scripts/png-estate-guard.ts');
const NODE = process.execPath;

const scratchDirs: string[] = [];
afterEach(() => {
  while (scratchDirs.length > 0) rmSync(scratchDirs.pop()!, { recursive: true, force: true });
});

function runGuard(cwd: string, args: string[] = []): { status: number | null; out: string } {
  const res = spawnSync(NODE, ['--experimental-strip-types', GUARD, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: res.status, out: `${res.stdout}\n${res.stderr}` };
}

function makeFixtureRepo(): { root: string; git: (args: string[]) => string } {
  const root = mkdtempSync(join(tmpdir(), 'png-guard-'));
  scratchDirs.push(root);
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30_000 });
  git(['init', '--quiet']);
  git(['config', 'user.email', 'guard-test@example.invalid']);
  git(['config', 'user.name', 'guard-test']);
  return { root, git };
}

describe('png-estate guard (#2219 Option A)', () => {
  it('ratchet mode passes against this repository (artifacts/ clean, census within baseline)', () => {
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
    let count = 0;
    let bytes = 0;
    for (const row of rows) {
      const tab = row.indexOf('\t');
      const [mode, oid] = row.slice(0, tab).split(' ');
      const path = row.slice(tab + 1);
      if (mode === '120000' || !path.toLowerCase().endsWith('.png')) continue;
      count += 1;
      bytes += Number.parseInt(
        execFileSync('git', ['cat-file', '-s', oid!], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000 }),
        10,
      );
    }
    expect({ count, bytes }).toEqual({
      count: TRACKED_PNG_COUNT_BASELINE,
      bytes: TRACKED_PNG_BYTES_BASELINE,
    });
  });

  it('staged mode rejects a staged PNG under artifacts/, including non-ASCII names', () => {
    const { root, git } = makeFixtureRepo();
    mkdirSync(join(root, 'artifacts/dashboard-polish'), { recursive: true });
    writeFileSync(join(root, 'artifacts/dashboard-polish/regrown.png'), Buffer.alloc(64, 7));
    writeFileSync(join(root, 'artifacts/dashboard-polish/ä-regrown.png'), Buffer.alloc(64, 8));
    git(['add', '-f', 'artifacts/dashboard-polish']);

    const { status, out } = runGuard(root, ['--staged']);
    expect(status).toBe(1);
    expect(out).toContain('regrown.png: artifacts/ images are not tracked');
    expect(out).toContain('ä-regrown.png: artifacts/ images are not tracked');
  });

  it('staged mode sizes the INDEX blob: oversized staged bytes stay red after a worktree truncation, small ones stay green', () => {
    const { root, git } = makeFixtureRepo();
    mkdirSync(join(root, 'docs/screenshots'), { recursive: true });
    writeFileSync(join(root, 'docs/screenshots/huge.png'), Buffer.alloc(150 * 1024, 1));
    git(['add', 'docs/screenshots/huge.png']);
    // Post-staging truncation must not change the verdict (the index blob is
    // what lands in history).
    writeFileSync(join(root, 'docs/screenshots/huge.png'), Buffer.alloc(8, 1));

    const oversized = runGuard(root, ['--staged']);
    expect(oversized.status).toBe(1);
    expect(oversized.out).toContain('exceeds the');
    expect(oversized.out).toContain(String(MAX_NEW_PNG_BYTES));

    git(['reset']);
    writeFileSync(join(root, 'docs/screenshots/small.png'), Buffer.alloc(8 * 1024, 1));
    git(['add', 'docs/screenshots/small.png']);
    const small = runGuard(root, ['--staged']);
    expect(small.out).toContain('png-estate guard passed (staged)');
    expect(small.status).toBe(0);
  });

  it('staged mode catches an oversized rename-with-modification (diff-filter includes R)', () => {
    const { root, git } = makeFixtureRepo();
    mkdirSync(join(root, 'docs/screenshots'), { recursive: true });
    writeFileSync(join(root, 'docs/screenshots/before.png'), Buffer.alloc(90 * 1024, 2));
    git(['add', 'docs/screenshots/before.png']);
    git(['commit', '-qm', 'fixture', '--no-verify']);

    renameSync(join(root, 'docs/screenshots/before.png'), join(root, 'docs/screenshots/after.png'));
    writeFileSync(join(root, 'docs/screenshots/after.png'), Buffer.alloc(150 * 1024, 3));
    git(['add', '-A', 'docs/screenshots']);

    const { status, out } = runGuard(root, ['--staged']);
    expect(status).toBe(1);
    expect(out).toContain('docs/screenshots/after.png');
    expect(out).toContain('exceeds the');
  });

  it('ratchet mode rejects a tracked PNG under artifacts/ regardless of extension case', () => {
    const { root, git } = makeFixtureRepo();
    mkdirSync(join(root, 'artifacts'), { recursive: true });
    writeFileSync(join(root, 'artifacts/tracked.PnG'), Buffer.alloc(64, 3));
    git(['add', '-f', 'artifacts/tracked.PnG']);
    git(['commit', '-qm', 'fixture', '--no-verify']);

    const { status, out } = runGuard(root);
    expect(status).toBe(1);
    expect(out).toContain('tracked PNG(s) under artifacts/');
  });

  it('ratchet mode rejects census growth beyond the count baseline', () => {
    const { root, git } = makeFixtureRepo();
    mkdirSync(join(root, 'docs/screenshots'), { recursive: true });
    for (let i = 0; i < TRACKED_PNG_COUNT_BASELINE + 1; i += 1) {
      writeFileSync(join(root, `docs/screenshots/s${i}.png`), Buffer.alloc(16, i % 251));
    }
    git(['add', 'docs/screenshots']);
    git(['commit', '-qm', 'fixture', '--no-verify']);

    const { status, out } = runGuard(root);
    expect(status).toBe(1);
    expect(out).toContain(
      `tracked PNG count ${TRACKED_PNG_COUNT_BASELINE + 1} exceeds the ratchet baseline ${TRACKED_PNG_COUNT_BASELINE}`,
    );
  });

  it('ratchet mode rejects byte growth beyond the bytes baseline', () => {
    const { root, git } = makeFixtureRepo();
    mkdirSync(join(root, 'docs/screenshots'), { recursive: true });
    const half = Math.ceil(TRACKED_PNG_BYTES_BASELINE / 2) + 1024;
    writeFileSync(join(root, 'docs/screenshots/big-a.png'), Buffer.alloc(half, 4));
    writeFileSync(join(root, 'docs/screenshots/big-b.png'), Buffer.alloc(half, 5));
    git(['add', 'docs/screenshots']);
    git(['commit', '-qm', 'fixture', '--no-verify']);

    const { status, out } = runGuard(root);
    expect(status).toBe(1);
    expect(out).toMatch(/tracked PNG bytes \d+ exceed the ratchet baseline/);
  });

  it('ratchet mode rejects a tracked docs/screenshots PNG above the per-file ceiling, and only there', () => {
    const { root, git } = makeFixtureRepo();
    mkdirSync(join(root, 'docs/screenshots'), { recursive: true });
    mkdirSync(join(root, 'docs/design-system'), { recursive: true });
    // Same size outside docs/screenshots/ is not subject to the ceiling.
    writeFileSync(join(root, 'docs/design-system/wide.png'), Buffer.alloc(DOCS_SCREENSHOT_MAX_BYTES + 1, 6));
    git(['add', 'docs/design-system']);
    git(['commit', '-qm', 'fixture', '--no-verify']);
    const outside = runGuard(root);
    expect(outside.out).toContain('png-estate guard passed (ratchet)');
    expect(outside.status).toBe(0);

    writeFileSync(join(root, 'docs/screenshots/regrown.png'), Buffer.alloc(DOCS_SCREENSHOT_MAX_BYTES + 1, 7));
    git(['add', 'docs/screenshots']);
    git(['commit', '-qm', 'fixture', '--no-verify']);
    const inside = runGuard(root);
    expect(inside.status).toBe(1);
    expect(inside.out).toContain(
      `docs/screenshots/regrown.png (${DOCS_SCREENSHOT_MAX_BYTES + 1} bytes)`,
    );
    expect(inside.out).toContain('per-file ceiling');
  });

  describe('staged in-place modification of a tracked docs/screenshots PNG', () => {
    function repoWithTrackedScreenshot(bytes: number): { root: string; git: (args: string[]) => string } {
      const repo = makeFixtureRepo();
      mkdirSync(join(repo.root, 'docs/screenshots'), { recursive: true });
      writeFileSync(join(repo.root, 'docs/screenshots/shot.png'), Buffer.alloc(bytes, 9));
      repo.git(['add', 'docs/screenshots/shot.png']);
      repo.git(['commit', '-qm', 'fixture', '--no-verify']);
      return repo;
    }

    it('passes when the new blob shrinks and is within the ceiling, though above the new-PNG bound', () => {
      const { root, git } = repoWithTrackedScreenshot(DOCS_SCREENSHOT_MAX_BYTES + 50 * 1024);
      writeFileSync(join(root, 'docs/screenshots/shot.png'), Buffer.alloc(MAX_NEW_PNG_BYTES + 200 * 1024, 10));
      git(['add', 'docs/screenshots/shot.png']);
      const { status, out } = runGuard(root, ['--staged']);
      expect(out).toContain('png-estate guard passed (staged): 1 staged PNG(s)');
      expect(status).toBe(0);
    });

    it('rejects growth above the new-PNG bound even within the ceiling', () => {
      const { root, git } = repoWithTrackedScreenshot(MAX_NEW_PNG_BYTES + 10 * 1024);
      writeFileSync(join(root, 'docs/screenshots/shot.png'), Buffer.alloc(MAX_NEW_PNG_BYTES + 20 * 1024, 11));
      git(['add', 'docs/screenshots/shot.png']);
      const { status, out } = runGuard(root, ['--staged']);
      expect(status).toBe(1);
      expect(out).toContain('grows the tracked screenshot');
    });

    it('rejects a shrinking blob that is still above the per-file ceiling', () => {
      const { root, git } = repoWithTrackedScreenshot(DOCS_SCREENSHOT_MAX_BYTES + 100 * 1024);
      writeFileSync(join(root, 'docs/screenshots/shot.png'), Buffer.alloc(DOCS_SCREENSHOT_MAX_BYTES + 1, 12));
      git(['add', 'docs/screenshots/shot.png']);
      const { status, out } = runGuard(root, ['--staged']);
      expect(status).toBe(1);
      expect(out).toContain('per-file ceiling');
    });

    it('does not extend the exemption to a NEW docs/screenshots PNG or an in-place change elsewhere', () => {
      const { root, git } = repoWithTrackedScreenshot(8 * 1024);
      mkdirSync(join(root, 'docs/design-system'), { recursive: true });
      writeFileSync(join(root, 'docs/design-system/tracked.png'), Buffer.alloc(300 * 1024, 13));
      git(['add', 'docs/design-system/tracked.png']);
      git(['commit', '-qm', 'fixture', '--no-verify']);

      writeFileSync(join(root, 'docs/screenshots/new.png'), Buffer.alloc(MAX_NEW_PNG_BYTES + 1, 14));
      writeFileSync(join(root, 'docs/design-system/tracked.png'), Buffer.alloc(200 * 1024, 15));
      git(['add', 'docs']);
      const { status, out } = runGuard(root, ['--staged']);
      expect(status).toBe(1);
      expect(out).toContain('docs/screenshots/new.png');
      expect(out).toContain('docs/design-system/tracked.png');
      expect(out).toContain('new-PNG bound');
    });
  });
});
