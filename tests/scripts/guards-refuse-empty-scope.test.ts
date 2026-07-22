import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * A guard that scans nothing and prints "clean" is a false green.
 *
 * Found by a sweep (2026-07-22): every `guard:*` entrypoint was run against an EMPTY
 * directory. 24 failed closed, but four exited 0 while examining nothing — three of them
 * backing `severity: 'block'` registry rules:
 *
 *   import-boundary-check      arch.import-boundaries      "passed (no violations)"
 *   no-destructive-git-guard   process.no-destructive-git  "clean (0 findings)"
 *   check-insecure-tempfile    test.insecure-tempfile      "clean (0 findings)"
 *
 * Each already failed closed on an IO fault; none noticed the quieter case where nothing
 * threw because there was simply nothing to read — which is what a wrong cwd, a stripped
 * checkout, or a renamed surface directory looks like. `collectSourceFiles` even returned
 * `[]` explicitly when `src/` was absent.
 *
 * These are CLI-level tests on purpose. The scan functions are pure and are legitimately
 * allowed to return `[]`; the refusal belongs at the boundary that reports an exit code,
 * which is also why adding it broke none of the 88 existing tests across the three suites.
 *
 * Exit 2, not 1: "I could not examine the tree" must be distinguishable from "I examined it
 * and found a violation", or an operator goes hunting for a violation that does not exist.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

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
    { cwd, encoding: 'utf8' },
  );
  return { status: r.status ?? -1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
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

  it.each(GUARDS)('$script still succeeds against the real repo', ({ script }) => {
    // Guards against over-correcting: the refusal must not fire on a genuine checkout.
    const { status, output } = runGuardIn(repoRoot, script);
    expect(status, `${script} exited ${status} on the real repo; output:\n${output}`).toBe(0);
  });
});
