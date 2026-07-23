/**
 * Baseline growth guard — end-to-end proof against a real git repo.
 *
 * The pure weighing rules are covered by `baseline-weight.test.ts`. What this file proves
 * is the part that can only be proven end-to-end: that the guard actually READS TWO GIT
 * REVISIONS and refuses growth between them, and that its registry cannot silently narrow
 * to a subset of the baselines that exist.
 *
 * The growth case is exercised against a throwaway git repo via the `--repo` seam rather
 * than by mutating this one. Only the repo ROOT differs from a production run; the
 * revision resolution, weighing, and comparison are all the production code path.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { BASELINE_REGISTRY } from '../../scripts/lib/baseline-weight.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const guard = resolve(repoRoot, 'scripts/baseline-growth-guard.ts');

const tempRoots: string[] = [];
afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } as NodeJS.ProcessEnv,
  });
}

/** A throwaway repo whose `main` holds `boundaryEntries` boundary-baseline entries. */
function makeRepo(boundaryEntries: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'baseline-growth-'));
  tempRoots.push(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'guard@test.invalid']);
  git(dir, ['config', 'user.name', 'guard test']);
  mkdirSync(join(dir, '.claude/fitness'), { recursive: true });
  writeBoundary(dir, boundaryEntries);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'baseline']);
  return dir;
}

function writeBoundary(dir: string, count: number): void {
  const entries = Array.from({ length: count }, (_, i) => ({
    file: `src/core/f${i}.ts`,
    line: i + 1,
    specifier: '../runtimes/types.ts',
    fromLayer: 'core',
    toLayer: 'runtimes',
  }));
  writeFileSync(
    join(dir, '.claude/fitness/boundary-baseline.json'),
    `${JSON.stringify(entries, null, 2)}\n`,
  );
}

function commitCandidate(dir: string, message: string): void {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', message]);
}

/**
 * Run the guard and return its raw result.
 *
 * `spawnSync`, not `execFileSync`: the guard signals its outcome through the exit code
 * (0/1/2), and execFileSync THROWS on any non-zero exit, which would force every
 * assertion through a catch block and make the inconclusive and block paths look like
 * infrastructure errors rather than results.
 */
function runGuard(args: string[]): { status: number | null; out: string } {
  const r = spawnSync(
    process.execPath,
    ['--experimental-strip-types', resolve(repoRoot, 'scripts/baseline-growth-guard.ts'), ...args],
    { cwd: repoRoot, encoding: 'utf8', timeout: 60_000 },
  );
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('baseline growth guard — the red proof', () => {
  it('BLOCKS (exit 1) when a baseline gains entries', () => {
    const dir = makeRepo(2);
    writeBoundary(dir, 5); // institutionalise 3 more violations
    commitCandidate(dir, 'grow baseline');

    // Spelled out inline with the guard path as a literal, rather than via runGuard():
    // `guard-test-coverage-check.ts` proves failure-path coverage from the AST, and it
    // only recognises a subprocess invocation when the exact guard path appears inside a
    // spawnSync/execFileSync call in a test body, with the failure assertion linked to
    // that call's result. Routing this through the helper hid the guard from that check.
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        resolve(repoRoot, 'scripts/baseline-growth-guard.ts'),
        '--repo',
        dir,
        '--base',
        'HEAD^',
      ],
      { cwd: repoRoot, encoding: 'utf8', timeout: 60_000 },
    );
    const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;

    // Single-argument `expect` on purpose. `guard-test-coverage-check.ts` parses this
    // assertion from the AST to prove the failure path is exercised, and its
    // `parseExpectation` bails on any expect() with two arguments — so the idiomatic
    // `expect(x, 'message')` form is invisible to it. The message is surfaced by the
    // console.error above instead, which keeps a failure just as diagnosable.
    if (result.status !== 1) console.error(`guard exited ${result.status}, expected 1:\n${out}`);
    expect(result.status).toBe(1);
    expect(out).toMatch(/boundary-baseline\.json/);
    expect(out, 'the message must state the actual weights').toMatch(/2 -> 5/);
    expect(out, 'and must say what to do instead').toMatch(/may only shrink/);
  });

  it('PASSES (exit 0) when a baseline shrinks', () => {
    const dir = makeRepo(5);
    writeBoundary(dir, 1);
    commitCandidate(dir, 'shrink baseline');
    const { status, out } = runGuard(['--repo', dir, '--base', 'HEAD^']);
    expect(status, out).toBe(0);
  });

  it('BLOCKS committed growth even when mutable worktree bytes hide it', () => {
    const dir = makeRepo(2);
    writeBoundary(dir, 5);
    commitCandidate(dir, 'grow baseline');
    writeBoundary(dir, 2); // a lifecycle script restores apparently safe ambient bytes

    const { status, out } = runGuard(['--repo', dir, '--base', 'HEAD^', '--candidate', 'HEAD']);
    expect(status, out).toBe(1);
    expect(out).toMatch(/2 -> 5/);
  });

  it('PASSES a committed shrink even when mutable worktree bytes look larger', () => {
    const dir = makeRepo(5);
    writeBoundary(dir, 1);
    commitCandidate(dir, 'shrink baseline');
    writeBoundary(dir, 9); // ambient bytes must not change the exact candidate decision

    const { status, out } = runGuard(['--repo', dir, '--base', 'HEAD^', '--candidate', 'HEAD']);
    expect(status, out).toBe(0);
  });

  it('PASSES (exit 0) when a baseline is unchanged', () => {
    const dir = makeRepo(3);
    const { status, out } = runGuard(['--repo', dir, '--base', 'HEAD']);
    expect(status, out).toBe(0);
  });

  it('is INCONCLUSIVE (exit 2), never a pass, when the baseline becomes unparseable', () => {
    // A truncated/corrupt baseline weighs as nothing. Since shrinking is allowed, treating
    // an unweighable document as 0 would sail through as an improvement.
    const dir = makeRepo(4);
    writeFileSync(join(dir, '.claude/fitness/boundary-baseline.json'), '{ this is not json');
    commitCandidate(dir, 'corrupt baseline');
    const { status, out } = runGuard(['--repo', dir, '--base', 'HEAD^']);
    expect(status, `expected INCONCLUSIVE, got ${status}.\n${out}`).toBe(2);
    // Case-insensitive: an unparseable document is reported through the shape-error
    // channel ("FAIL(inconclusive): ... could not be weighed"), not the comparison
    // channel. Same outcome, different message — the exit code is the contract.
    expect(out).toMatch(/inconclusive/i);
    expect(out, 'the unreadable file must be named').toMatch(/boundary-baseline\.json/);
  });

  it('is INCONCLUSIVE, not silently dropped, when a registered baseline has the wrong shape', () => {
    // REGRESSION. The first version collapsed "file absent" and "could not weigh it" into
    // one null, then dropped any baseline that was null on BOTH sides as "not in the tree
    // yet". Two of the seven real baselines had the wrong shape recorded in the registry,
    // threw on every read, and were dropped — the guard printed a clean pass over the other
    // five and never mentioned them. A baseline the guard cannot read is UNWATCHED, and
    // unwatched must never present as clean.
    const dir = mkdtempSync(join(tmpdir(), 'baseline-growth-shape-'));
    tempRoots.push(dir);
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'guard@test.invalid']);
    git(dir, ['config', 'user.name', 'guard test']);
    mkdirSync(join(dir, '.claude/fitness'), { recursive: true });
    // Registered as 'entry-array', committed as an object: unweighable at BOTH revisions.
    writeFileSync(
      join(dir, '.claude/fitness/boundary-baseline.json'),
      JSON.stringify({ notAnArray: true }),
    );
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'wrong shape']);

    const { status, out } = runGuard(['--repo', dir, '--base', 'HEAD']);
    expect(status, `expected INCONCLUSIVE, got ${status}.\n${out}`).toBe(2);
    expect(out, 'the broken baseline must be named').toMatch(/boundary-baseline\.json/);
    expect(out).toMatch(/could not be weighed|unwatched/);
  });

  it('is INCONCLUSIVE (exit 2) when the base revision cannot be resolved', () => {
    const dir = makeRepo(2);
    const { status, out } = runGuard(['--repo', dir, '--base', 'no-such-revision']);
    expect(status, out).toBe(2);
  });

  it('refuses a flag-shaped value instead of using it as a revision', () => {
    // `--base --json` must not hand "--json" to git as a ref.
    const { status, out } = runGuard(['--base', '--json']);
    expect(status).toBe(2);
    expect(out).toMatch(/another flag/);
  });

  it('is INCONCLUSIVE when the candidate revision cannot be resolved', () => {
    const dir = makeRepo(2);
    const { status, out } = runGuard(['--repo', dir, '--candidate', 'no-such-revision']);
    expect(status, out).toBe(2);
    expect(out).toMatch(/candidate revision/i);
  });

  it('refuses a flag-shaped candidate value instead of using it as a revision', () => {
    const { status, out } = runGuard(['--candidate', '--json']);
    expect(status).toBe(2);
    expect(out).toMatch(/another flag/);
  });

  it('refuses an unknown flag rather than silently ignoring it', () => {
    const { status, out } = runGuard(['--repoo', '/tmp']);
    expect(status).toBe(2);
    expect(out).toMatch(/Unknown argument/);
  });
});

describe('registry coverage — the scan cannot silently narrow', () => {
  it('registers EVERY baseline file that exists in the tree', () => {
    // Without this, adding an eighth baseline file leaves it permanently unwatched and
    // every run still reports a clean pass over the other seven.
    const tracked = execFileSync('git', ['ls-files'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
      .split('\n')
      .filter((p) => /baseline.*\.json$/.test(p) || /-baseline\.json$/.test(p))
      // Fixtures and generated node_modules copies are not committed debt ceilings.
      .filter((p) => !p.includes('node_modules') && !p.includes('/fixtures/'));

    // Measured at 7 on origin/main 084908d91. `> 0` would be too weak: a pattern that
    // silently matched 3 of the 7 would still report every one of them registered, and the
    // other 4 would go unwatched with a green test. This asserts the scan still SEES them.
    expect(
      tracked.length,
      `the baseline scan found ${tracked.length} file(s); it saw 7 when written. If baselines ` +
        'were legitimately removed, lower this floor deliberately — do not delete the check.',
    ).toBeGreaterThanOrEqual(7);

    const registered = new Set(BASELINE_REGISTRY.map((b) => b.path));
    const unregistered = tracked.filter((p) => !registered.has(p));
    expect(
      unregistered,
      `${unregistered.length} baseline file(s) exist in the tree but are not in ` +
        'BASELINE_REGISTRY, so nothing stops them from growing. Add them to ' +
        `scripts/lib/baseline-weight.ts:\n  ${unregistered.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every registered path actually exists — no dead registry rows', () => {
    // A registry pointing at a deleted file would weigh null/null forever and get filtered
    // out, quietly shrinking real coverage while the row still looks like protection.
    const present = new Set(
      execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
        .split('\n')
        .filter(Boolean),
    );
    const dead = BASELINE_REGISTRY.filter((b) => !present.has(b.path)).map((b) => b.path);
    expect(dead, `dead registry rows: ${dead.join(', ')}`).toEqual([]);
  });
});

describe('remote exact-revision wiring', () => {
  it('binds the blocking workflow step to the exact GitHub candidate OID', () => {
    const workflow = readFileSync(resolve(repoRoot, '.github/workflows/quality.yml'), 'utf8');
    expect(workflow).toContain('npm run guard:baseline-growth -- --candidate "$GITHUB_SHA"');
  });
});

describe('the guard runs clean on this branch', () => {
  it('reports no baseline growth against the merge base', () => {
    // Green-on-arrival: wiring a guard that is already red would block every unrelated PR.
    const { status, out } = runGuard([]);
    expect(status, `guard is not green on arrival:\n${out}`).toBe(0);
  });
});
