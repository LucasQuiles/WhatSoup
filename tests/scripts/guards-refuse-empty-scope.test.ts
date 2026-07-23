/**
 * A guard that scans nothing and prints "clean" is a false green.
 *
 * ORIGINALLY LANDED 2026-07-22 and REVERTED the same day by `9cf044d45` as "incomplete
 * guard enforcement", whose message records: *"This does not fix guard non-vacuity or bound
 * spawnSync children; both remain follow-up work."* The spawnSync half is now done
 * (`bot-errors-release-proof-installer.test.ts` bounds its children below the test budget).
 * This restores the non-vacuity half, and fixes the thing that made the first attempt
 * incomplete.
 *
 * WHY THE FIRST ATTEMPT WAS INCOMPLETE — and it genuinely was. It refused using PRESENCE
 * PROXIES: `check-insecure-tempfile` checked that `root/package.json` existed, and
 * `no-destructive-git-guard` checked that at least one of its SURFACE_DIRS existed. Those
 * catch "pointed at the wrong directory entirely" and miss the quieter, likelier case.
 * Measured against the reverted logic before rewriting it:
 *
 *   package.json present + scripts/ deploy/ tools/ all present but EMPTY
 *     -> both proxies PASS, zero files are read, guard still exits 0 "clean (0 findings)"
 *
 * A location check is not a work check. The refusal now derives from the number of files the
 * scan ACTUALLY READ, which is the only thing that distinguishes "examined a tree and found
 * nothing" from "examined nothing". The `dirs exist but are empty` case below is the
 * regression that pins the difference, and it is the case the reverted version failed.
 *
 * Exit 2, not 1: "I could not examine the tree" must stay distinguishable from "I examined
 * it and found a violation", or an operator goes hunting for a violation that does not exist.
 *
 * CLI-level on purpose. The exported scan functions are pure and are legitimately allowed to
 * return `[]`; the refusal belongs at the boundary that reports an exit code.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * `fail-closed-gate-guard` is deliberately included even though it ALREADY refuses. It is
 * the control: if a future change made every guard exit 2 unconditionally, the first two
 * blocks here would still pass and only the real-repo block would catch it. Keeping a guard
 * that was never broken in the list proves the suite discriminates.
 */
const GUARDS = [
  { script: 'scripts/import-boundary-check.ts', rule: 'arch.import-boundaries' },
  { script: 'scripts/no-destructive-git-guard.ts', rule: 'process.no-destructive-git' },
  { script: 'scripts/check-insecure-tempfile.ts', rule: 'test.insecure-tempfile' },
  { script: 'scripts/fail-closed-gate-guard.ts', rule: 'invariant.fail-closed-gate' },
] as const;

let emptyTree: string;

beforeEach(() => {
  emptyTree = mkdtempSync(join(tmpdir(), 'guard-empty-scope-'));
});
afterEach(() => {
  rmSync(emptyTree, { recursive: true, force: true });
});

function runGuardIn(cwd: string, script: string): { status: number; output: string } {
  const r = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', join(repoRoot, script)],
    { cwd, encoding: 'utf8', timeout: 120_000 },
  );
  return { status: r.status ?? -1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** A tree that LOOKS like a checkout to a presence proxy but contains no readable source. */
function makeDecoyCheckout(root: string): void {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'decoy' }));
  for (const dir of ['src', 'scripts', 'deploy', 'tools', 'tests', '.husky']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
}

describe('guards refuse to certify a tree they never examined', () => {
  it.each(GUARDS)('$script exits 2 INCONCLUSIVE on an empty tree (backs $rule)', ({ script }) => {
    const { status, output } = runGuardIn(emptyTree, script);
    expect(status, `${script} exited ${status} on an empty tree; output:\n${output}`).toBe(2);
    expect(output).toMatch(/INCONCLUSIVE/i);
  });

  it.each(GUARDS)('$script does NOT print a clean/passed verdict on an empty tree', ({ script }) => {
    const { output } = runGuardIn(emptyTree, script);
    // The exact strings that made this invisible before.
    expect(output).not.toMatch(/clean \(0 findings\)|passed \(no violations\)|no .*shapes found/i);
  });
});

describe('the case the reverted presence-proxy fix missed', () => {
  it.each(GUARDS)(
    '$script still exits 2 when the expected directories EXIST but are empty',
    ({ script }) => {
      // This is the regression. `package.json` and every surface directory are present, so
      // both proxies the reverted version used would report "this is a real checkout" — yet
      // not one file is readable. Refusing here is what makes the fix a work check rather
      // than a location check.
      makeDecoyCheckout(emptyTree);
      const { status, output } = runGuardIn(emptyTree, script);
      expect(
        status,
        `${script} exited ${status} on a decoy checkout (dirs present, all empty). A guard ` +
          `that reads zero files must not certify the tree.\noutput:\n${output}`,
      ).toBe(2);
      expect(output).toMatch(/INCONCLUSIVE/i);
    },
  );
});

describe('the refusal does not over-correct', () => {
  it.each(GUARDS)('$script still succeeds against the real repo', ({ script }) => {
    // Without this the whole suite could be satisfied by making every guard exit 2 always,
    // which would be a worse failure than the one being fixed.
    const { status, output } = runGuardIn(repoRoot, script);
    expect(status, `${script} exited ${status} on the real repo; output:\n${output}`).toBe(0);
  });

  it.each(GUARDS)('$script reports how much it examined, so a pass is checkable', ({ script }) => {
    // A bare "clean" is unfalsifiable. The count is what lets a reader tell a real scan from
    // a vacuous one without re-running anything.
    const { output } = runGuardIn(repoRoot, script);
    expect(
      output,
      `${script} passed without saying how many files it examined; output:\n${output}`,
      // Allows a qualifier between the count and the noun: fail-closed-gate-guard reports
      // "52 shell file(s)", which a strict `\d+\s+file` would miss.
    ).toMatch(/\d+[^\n]{0,24}file/i);
  });
});
