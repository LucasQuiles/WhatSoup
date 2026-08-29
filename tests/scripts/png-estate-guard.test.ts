// #2219 Option A — png-estate guard companion test: invokes the EXACT guard
// (ratchet mode against this repo; staged mode against fixture repos with a
// mutation-proven red case per rule) so guard-test-coverage sees failure-path
// proof, not presence.
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach } from 'vitest';

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

function makeFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'png-guard-'));
  scratchDirs.push(root);
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git(['init', '--quiet']);
  git(['config', 'user.email', 'guard-test@example.invalid']);
  git(['config', 'user.name', 'guard-test']);
  // The guard is copied so the fixture invocation cannot depend on this
  // repo's index state.
  mkdirSync(join(root, 'scripts'), { recursive: true });
  cpSync(GUARD, join(root, 'scripts/png-estate-guard.ts'));
  return root;
}

describe('png-estate guard (#2219 Option A)', () => {
  it('ratchet mode passes against this repository (artifacts/ clean, census within baseline)', () => {
    const { status, out } = runGuard(REPO_ROOT);
    expect(out).toContain('png-estate guard passed (ratchet)');
    expect(status).toBe(0);
  });

  it('staged mode rejects a staged PNG under artifacts/', () => {
    const root = makeFixtureRepo();
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    mkdirSync(join(root, 'artifacts/dashboard-polish'), { recursive: true });
    writeFileSync(join(root, 'artifacts/dashboard-polish/regrown.png'), Buffer.alloc(64, 7));
    git(['add', '-f', 'artifacts/dashboard-polish/regrown.png']);

    const { status, out } = runGuard(root, ['--staged']);
    expect(status).toBe(1);
    expect(out).toContain('artifacts/ images are not tracked');
  });

  it('staged mode rejects an oversized new PNG and accepts a small one', () => {
    const root = makeFixtureRepo();
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    mkdirSync(join(root, 'docs/screenshots'), { recursive: true });
    writeFileSync(join(root, 'docs/screenshots/huge.png'), Buffer.alloc(150 * 1024, 1));
    git(['add', 'docs/screenshots/huge.png']);

    const oversized = runGuard(root, ['--staged']);
    expect(oversized.status).toBe(1);
    expect(oversized.out).toContain('exceeds the');

    git(['reset']);
    writeFileSync(join(root, 'docs/screenshots/small.png'), Buffer.alloc(8 * 1024, 1));
    git(['add', 'docs/screenshots/small.png']);
    const small = runGuard(root, ['--staged']);
    expect(small.out).toContain('png-estate guard passed (staged)');
    expect(small.status).toBe(0);
  });

  it('ratchet mode rejects a tracked PNG under artifacts/', () => {
    const root = makeFixtureRepo();
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    mkdirSync(join(root, 'artifacts'), { recursive: true });
    writeFileSync(join(root, 'artifacts/tracked.png'), Buffer.alloc(64, 3));
    git(['add', '-f', 'artifacts/tracked.png']);
    git(['commit', '-qm', 'fixture', '--no-verify']);

    const { status, out } = runGuard(root);
    expect(status).toBe(1);
    expect(out).toContain('tracked PNG(s) under artifacts/');
  });
});
