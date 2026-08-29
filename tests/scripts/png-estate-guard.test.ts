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
});
