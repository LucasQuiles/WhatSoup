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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { trackTmpDirs } from '../helpers/tmp-dir.ts';
import { BASELINE_REGISTRY, GROWTH_WAIVERS_PATH } from '../../scripts/lib/baseline-weight.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const guard = resolve(repoRoot, 'scripts/baseline-growth-guard.ts');

const tmp = trackTmpDirs('');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } as NodeJS.ProcessEnv,
  });
}

/** A throwaway repo whose `main` holds `boundaryEntries` boundary-baseline entries. */
function makeRepo(boundaryEntries: number): string {
  const dir = tmp.make('baseline-growth');
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
        'HEAD',
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
    const { status, out } = runGuard(['--repo', dir, '--base', 'HEAD']);
    expect(status, out).toBe(0);
  });

  it('PASSES (exit 0) when a baseline is unchanged', () => {
    const dir = makeRepo(3);
    const { status, out } = runGuard(['--repo', dir, '--base', 'HEAD']);
    expect(status, out).toBe(0);
  });

  it('BLOCKS constant-count replacement of a baseline identity', () => {
    const dir = makeRepo(1);
    const replacement = [{
      file: 'src/core/replacement.ts',
      line: 99,
      specifier: '../runtimes/types.ts',
      fromLayer: 'core',
      toLayer: 'runtimes',
    }];
    writeFileSync(
      join(dir, '.claude/fitness/boundary-baseline.json'),
      `${JSON.stringify(replacement, null, 2)}\n`,
    );

    const { status, out } = runGuard(['--repo', dir, '--base', 'HEAD']);
    expect(status, out).toBe(1);
    expect(out).toMatch(/boundary-baseline\.json/);
    expect(out).toMatch(/new|identity|subset/i);
  });

  it('is INCONCLUSIVE (exit 2), never a pass, when the baseline becomes unparseable', () => {
    // A truncated/corrupt baseline weighs as nothing. Since shrinking is allowed, treating
    // an unweighable document as 0 would sail through as an improvement.
    const dir = makeRepo(4);
    writeFileSync(join(dir, '.claude/fitness/boundary-baseline.json'), '{ this is not json');
    const { status, out } = runGuard(['--repo', dir, '--base', 'HEAD']);
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
    const dir = tmp.make('baseline-growth-shape');
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

  it('refuses an unknown flag rather than silently ignoring it', () => {
    const { status, out } = runGuard(['--repoo', '/tmp']);
    expect(status).toBe(2);
    expect(out).toMatch(/Unknown argument/);
  });

  it('BLOCKS an introduced baseline above its audited initial ceiling', () => {
    const dir = makeRepo(2);
    mkdirSync(join(dir, 'eslint-rules'), { recursive: true });
    writeFileSync(
      join(dir, 'eslint-rules/catch-ratchet-baseline.json'),
      JSON.stringify(Array.from({ length: 128 }, (_, index) => `entry-${index}`)),
    );

    const { status, out } = runGuard(['--repo', dir, '--base', 'HEAD']);
    expect(status, out).toBe(1);
    expect(out).toMatch(/catch-ratchet-baseline\.json/);
    expect(out).toMatch(/127 -> 128/);
  });

  it('permits an introduced baseline at or below its audited initial ceiling', () => {
    const dir = makeRepo(2);
    mkdirSync(join(dir, 'eslint-rules'), { recursive: true });
    writeFileSync(
      join(dir, 'eslint-rules/catch-ratchet-baseline.json'),
      JSON.stringify(Array.from({ length: 127 }, (_, index) => `entry-${index}`)),
    );

    const { status, out } = runGuard(['--repo', dir, '--base', 'HEAD']);
    expect(status, out).toBe(0);
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

describe('the guard runs clean on this branch', () => {
  it('reports no baseline growth against the merge base', () => {
    // Green-on-arrival: wiring a guard that is already red would block every unrelated PR.
    const { status, out } = runGuard([]);
    expect(status, `guard is not green on arrival:\n${out}`).toBe(0);
  });
});

describe('growth waivers — the reviewed-widening escape valve, fail-closed', () => {
  // Waiver fixtures use pinned dates far from the wall clock so expiry logic is
  // deterministic: an "active" waiver expires 2199-01-01, an "expired" one 2020-01-01.
  function writeFitness(dir: string, maxLines: number): void {
    writeFileSync(
      join(dir, '.claude/fitness/baseline.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        rules: {
          'arch.file-size': {
            measurements: [{ filePath: 'src/big.ts', lines: maxLines, maxLines }],
          },
        },
      }, null, 2)}\n`,
    );
  }

  function writeWaivers(dir: string, waiver: Record<string, unknown>): void {
    writeFileSync(
      join(dir, '.claude/fitness/growth-waivers.json'),
      `${JSON.stringify({ schemaVersion: 1, waivers: [waiver] }, null, 2)}\n`,
    );
  }

  const activeWaiver = (maxWeight: number): Record<string, unknown> => ({
    path: '.claude/fitness/baseline.json',
    maxWeight,
    reason: 'test widening',
    issue: 'https://example.invalid/issues/1',
    grantedAt: '2020-01-01',
    expiresAt: '2199-01-01',
  });

  it('WAIVES (exit 0) numeric growth within an active waiver present at the base', () => {
    const dir = makeRepo(2);
    writeFitness(dir, 100);
    writeWaivers(dir, activeWaiver(501)); // future weight = 1 + 500 = 501
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'waiver granted']);
    writeFitness(dir, 500); // widen under the cap
    const { status, out } = runGuard(['--repo', dir, '--base', 'HEAD']);
    expect(status, out).toBe(0);
    expect(out).toMatch(/WAIVED\(baseline-growth\)/);
    expect(out, 'the authorizing issue must be cited').toMatch(/example\.invalid\/issues\/1/);
  });

  it('BLOCKS (exit 1) growth exceeding the waiver cap', () => {
    const dir = makeRepo(2);
    writeFitness(dir, 100);
    writeWaivers(dir, activeWaiver(400)); // cap below the future weight of 501
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'waiver granted']);
    writeFitness(dir, 500);
    const { status, out } = runGuard(['--repo', dir, '--base', 'HEAD']);
    if (status !== 1) console.error(`guard exited ${status}, expected 1:\n${out}`);
    expect(status).toBe(1);
    expect(out).toMatch(/may only shrink/);
  });

  it('BLOCKS (exit 1) when the waiver exists only in the candidate — no self-authorization', () => {
    const dir = makeRepo(2);
    writeFitness(dir, 100);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'no waiver at base']);
    writeFitness(dir, 500);
    writeWaivers(dir, activeWaiver(501)); // smuggled in the same candidate
    const { status, out } = runGuard(['--repo', dir, '--base', 'HEAD']);
    if (status !== 1) console.error(`guard exited ${status}, expected 1:\n${out}`);
    expect(status).toBe(1);
    expect(out).toMatch(/may only shrink/);
  });

  it('BLOCKS (exit 1) under an expired waiver', () => {
    const dir = makeRepo(2);
    writeFitness(dir, 100);
    writeWaivers(dir, {
      ...activeWaiver(501),
      grantedAt: '2019-01-01',
      expiresAt: '2020-01-01',
    });
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'expired waiver']);
    writeFitness(dir, 500);
    const { status, out } = runGuard(['--repo', dir, '--base', 'HEAD']);
    if (status !== 1) console.error(`guard exited ${status}, expected 1:\n${out}`);
    expect(status).toBe(1);
  });

  it('is INCONCLUSIVE (exit 2) when the base waiver document is malformed', () => {
    // An unreadable authorization must not fail open into either blocking or allowing.
    const dir = makeRepo(2);
    writeFitness(dir, 100);
    writeFileSync(join(dir, '.claude/fitness/growth-waivers.json'), '{ not json');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'malformed waiver']);
    writeFitness(dir, 500);
    const { status, out } = runGuard(['--repo', dir, '--base', 'HEAD']);
    expect(status, `expected INCONCLUSIVE, got ${status}.\n${out}`).toBe(2);
    expect(out).toMatch(/growth-waivers/);
  });

  it('NEVER waives identity introduction, regardless of cap', () => {
    // A waiver widens a numeric ceiling; it must not admit new debt identities.
    const dir = makeRepo(1);
    writeWaivers(dir, {
      ...activeWaiver(1_000_000),
      path: '.claude/fitness/boundary-baseline.json',
    });
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'waiver for boundary']);
    writeBoundary(dir, 3); // introduces 2 new identities
    const { status, out } = runGuard(['--repo', dir, '--base', 'HEAD']);
    if (status !== 1) console.error(`guard exited ${status}, expected 1:\n${out}`);
    expect(status).toBe(1);
    expect(out).toMatch(/identity|subset/i);
  });

  it('the waiver file deliberately does not match the baseline registry scan', () => {
    // growth-waivers.json is guard configuration (reviewed authority), not a debt
    // baseline; registering it would deadlock the mechanism. This canary fails if a
    // rename ever drags it into the scan pattern above.
    expect(GROWTH_WAIVERS_PATH).toBe('.claude/fitness/growth-waivers.json');
    expect(/baseline.*\.json$/.test(GROWTH_WAIVERS_PATH)).toBe(false);
    expect(/-baseline\.json$/.test(GROWTH_WAIVERS_PATH)).toBe(false);
  });
});

/**
 * The candidate side used to be hardcoded to the working tree, so a CI run could not name
 * WHICH commit it cleared and its verdict was unreproducible once the checkout moved. These
 * cover the pinned-revision surface and, more importantly, the base/candidate relations that
 * weigh equal and would otherwise pass having proven nothing.
 */
describe('exact-revision pinning — the verdict must name what it measured', () => {
  it('weighs the pinned candidate revision, NOT the working tree', () => {
    // The working tree and the pinned candidate must disagree in OPPOSITE directions, or
    // the test cannot tell the two apart. Base holds 2 entries; the committed candidate
    // SHRINKS to 1 (a pass) while the working tree GROWS to 40 (a block). Honouring
    // --candidate therefore exits 0 and ignoring it exits 1 — the assertion below fails
    // under either mistake. (Verified by mutation: reverting to weighAt(null, ...) turns
    // this red. An earlier version of this test pinned base === candidate, which
    // short-circuited on the relation check and passed even when --candidate was ignored.)
    const dir = makeRepo(2);
    const base = git(dir, ['rev-parse', 'HEAD']).trim();
    git(dir, ['checkout', '-q', '-b', 'candidate-branch']);
    writeBoundary(dir, 1);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'committed shrink']);
    const candidate = git(dir, ['rev-parse', 'HEAD']).trim();
    writeBoundary(dir, 40); // uncommitted growth, present ONLY in the working tree

    const { status, out } = runGuard([
      '--repo', dir, '--base', base, '--candidate', candidate, '--json',
    ]);
    if (status !== 0) console.error(`guard exited ${status}, expected 0:\n${out}`);
    expect(status).toBe(0);
    const receipt: unknown = JSON.parse(out.slice(out.indexOf('{')));
    expect((receipt as { findings: unknown[] }).findings).toEqual([]);
  });

  it('still weighs the working tree when no candidate is pinned (local strictness held)', () => {
    // The mirror of the above: the SAME uncommitted growth must still block by default,
    // or making the candidate pinnable would have quietly disarmed the pre-push gate.
    const dir = makeRepo(2);
    const base = git(dir, ['rev-parse', 'HEAD']).trim();
    git(dir, ['checkout', '-q', '-b', 'candidate-branch']);
    writeBoundary(dir, 1);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'committed shrink']);
    writeBoundary(dir, 40); // uncommitted growth

    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        resolve(repoRoot, 'scripts/baseline-growth-guard.ts'),
        '--repo', dir, '--base', base,
      ],
      { cwd: repoRoot, encoding: 'utf8', timeout: 60_000 },
    );
    const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.status !== 1) console.error(`guard exited ${result.status}, expected 1:\n${out}`);
    expect(result.status).toBe(1);
    expect(out).toMatch(/2 -> 40/);
  });

  it('reports the exact candidate OID in the receipt, not a label', () => {
    const dir = makeRepo(2);
    const base = git(dir, ['rev-parse', 'HEAD']).trim();
    writeBoundary(dir, 1); // shrink, so the run is a clean pass
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'shrink']);
    const candidate = git(dir, ['rev-parse', 'HEAD']).trim();
    const { status, out } = runGuard(['--repo', dir, '--base', base, '--candidate', candidate, '--json']);
    expect(status, out).toBe(0);
    const receipt: unknown = JSON.parse(out.slice(out.indexOf('{')));
    expect((receipt as { candidate: string }).candidate).toBe(candidate);
    expect((receipt as { base: string }).base).toBe(base);
  });

  it('reports working-tree literally when no candidate is pinned', () => {
    const dir = makeRepo(2);
    writeBoundary(dir, 1);
    const { status, out } = runGuard(['--repo', dir, '--base', 'HEAD', '--json']);
    expect(status, out).toBe(0);
    const receipt: unknown = JSON.parse(out.slice(out.indexOf('{')));
    // Not a SHA: a working-tree weighing is genuinely not reproducible from an OID, and
    // saying so is more honest than printing the HEAD it did not actually weigh.
    expect((receipt as { candidate: string }).candidate).toBe('working-tree');
  });

  it('is INCONCLUSIVE (exit 2), never a pass, when base and candidate are the same commit', () => {
    // The vacuous case: identical revisions always weigh equal, so a green here would mean
    // "proved nothing" was reported as "proved clean". Reachable from a merge_group whose
    // base and head resolve alike.
    const dir = makeRepo(3);
    const oid = git(dir, ['rev-parse', 'HEAD']).trim();
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        resolve(repoRoot, 'scripts/baseline-growth-guard.ts'),
        '--repo', dir, '--base', oid, '--candidate', oid,
      ],
      { cwd: repoRoot, encoding: 'utf8', timeout: 60_000 },
    );
    const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.status !== 2) console.error(`guard exited ${result.status}, expected 2:\n${out}`);
    expect(result.status).toBe(2);
    expect(out).toMatch(/cannot detect growth/);
  });

  it('is INCONCLUSIVE (exit 2) when the base is not an ancestor of the candidate', () => {
    // Divergent histories: a weight difference is then someone else's work, in either
    // direction, so neither a pass nor a block would be evidence about THIS change.
    const dir = makeRepo(2);
    const root = git(dir, ['rev-parse', 'HEAD']).trim();
    git(dir, ['checkout', '-q', '-b', 'other']);
    writeBoundary(dir, 4);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'divergent']);
    const other = git(dir, ['rev-parse', 'HEAD']).trim();
    git(dir, ['checkout', '-q', 'main']);
    writeBoundary(dir, 3);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'mainline']);
    const mainline = git(dir, ['rev-parse', 'HEAD']).trim();
    expect(other).not.toBe(mainline);
    expect(root).not.toBe(mainline);

    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        resolve(repoRoot, 'scripts/baseline-growth-guard.ts'),
        '--repo', dir, '--base', other, '--candidate', mainline,
      ],
      { cwd: repoRoot, encoding: 'utf8', timeout: 60_000 },
    );
    const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.status !== 2) console.error(`guard exited ${result.status}, expected 2:\n${out}`);
    expect(result.status).toBe(2);
    expect(out).toMatch(/not an ancestor/);
  });

  it('is INCONCLUSIVE (exit 2) when the candidate revision cannot be resolved', () => {
    const dir = makeRepo(2);
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        resolve(repoRoot, 'scripts/baseline-growth-guard.ts'),
        '--repo', dir, '--base', 'HEAD',
        '--candidate', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      ],
      { cwd: repoRoot, encoding: 'utf8', timeout: 60_000 },
    );
    const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.status !== 2) console.error(`guard exited ${result.status}, expected 2:\n${out}`);
    expect(result.status).toBe(2);
    expect(out).toMatch(/could not be resolved/);
  });

  it('treats the all-zero base OID as "no base given" and infers instead', () => {
    // GitHub reports 0{40} as the `before` of a branch creation. Resolving it always fails,
    // so passing it through verbatim would turn every such push INCONCLUSIVE. It must fall
    // back to inference — proven by the run succeeding against an inferred base.
    const dir = makeRepo(4);
    // The candidate must be AHEAD of main, not main itself: inference resolves
    // merge-base(main, candidate), which for main's own tip is that tip — a vacuous pair
    // the guard correctly refuses. Branching is what makes the inferred base a real
    // predecessor, and it mirrors the branch-creation push this sentinel comes from.
    git(dir, ['checkout', '-q', '-b', 'created-branch']);
    writeBoundary(dir, 1);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'shrink']);
    const candidate = git(dir, ['rev-parse', 'HEAD']).trim();
    const { status, out } = runGuard([
      '--repo', dir, '--base', '0'.repeat(40), '--candidate', candidate, '--json',
    ]);
    expect(status, out).toBe(0);
    const receipt: unknown = JSON.parse(out.slice(out.indexOf('{')));
    // The inferred base is a real commit, never the zero sentinel.
    expect((receipt as { base: string }).base).not.toMatch(/^0{40}$/);
  });

  it('rejects a flag-shaped value for --candidate instead of using it as a revision', () => {
    const { status, out } = runGuard(['--base', 'HEAD', '--candidate', '--json']);
    expect(status, out).toBe(2);
  });

  it('names both pinned revisions in the reproduce hint', () => {
    const dir = makeRepo(1);
    const base = git(dir, ['rev-parse', 'HEAD']).trim();
    writeBoundary(dir, 6); // grow
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'grow']);
    const candidate = git(dir, ['rev-parse', 'HEAD']).trim();
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        resolve(repoRoot, 'scripts/baseline-growth-guard.ts'),
        '--repo', dir, '--base', base, '--candidate', candidate,
      ],
      { cwd: repoRoot, encoding: 'utf8', timeout: 60_000 },
    );
    const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.status !== 1) console.error(`guard exited ${result.status}, expected 1:\n${out}`);
    expect(result.status).toBe(1);
    // A reproduce line that omits the revisions reproduces a DIFFERENT measurement.
    expect(out).toMatch(new RegExp(`--base ${base} --candidate ${candidate}`));
  });
});

describe('CI wiring — the guard must be invoked with pinned revisions', () => {
  it('quality.yml passes both --base and --candidate from event OIDs', () => {
    const workflow = readFileSync(resolve(repoRoot, '.github/workflows/quality.yml'), 'utf8');
    const step = workflow.slice(workflow.indexOf('- name: Baseline growth guard'));
    const invocation = step.slice(0, step.indexOf('- name: Catch ratchet drift'));
    // Env indirection, not inline ${{ }} in run: — the repo's workflow-injection rule.
    expect(invocation).toMatch(/BASELINE_BASE_OID:/);
    expect(invocation).toMatch(/--base "\$BASELINE_BASE_OID"/);
    expect(invocation).toMatch(/--candidate "\$GITHUB_SHA"/);
    // Every trigger the workflow declares must supply a base, or that lane silently
    // degrades to inference while looking pinned.
    expect(invocation).toMatch(/github\.event\.before/);
    expect(invocation).toMatch(/pull_request\.base\.sha/);
    expect(invocation).toMatch(/merge_group\.base_sha/);
  });
});
