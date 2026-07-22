/**
 * Every `severity: 'block'` fitness rule must name a real, gate-reachable backstop.
 *
 * A registry rule marked `block` is a promise that a merge carrying a violation cannot
 * land. Before `implementedBy`, nothing checked that promise: the rule→enforcement link
 * lived in prose inside `rationale` and in a row of the taxonomy doc. Establishing that all
 * 17 block rules were genuinely enforced (2026-07-22) took a dozen greps, because four of
 * them — `arch.file-size`, `hygiene.commit-author`, `hygiene.internal-labels`,
 * `test.typecheck-all-required` — had NO occurrence of their rule id anywhere outside the
 * registry and that doc. They turned out to be enforced, by mechanisms named after the
 * concept rather than the rule (`internal-workstream-label`, `typecheck:all`,
 * `--commit-authors`). The enforcement was real; the LINK was archaeology.
 *
 * This suite closes the last hole in the chain the session built:
 *   #2052  guard in the push gate      → named CI step or justified exemption
 *   #2053  exemption                   → a backing test file that EXISTS and is collected
 *   here   block-severity RULE         → a backstop that exists and is gate-reachable
 *
 * Without this layer a rule could be declared `block` with no guard whatsoever, and the
 * #2052 parity suite would not notice: it audits guards that are already in the gate, so a
 * rule nothing implements is invisible to it.
 *
 * WHAT THIS PROVES, precisely: every block rule DECLARES a backstop that exists on disk and
 * cannot be bypassed by a server-side merge. WHAT IT DOES NOT PROVE: that the named
 * backstop actually detects the thing the rule describes. That semantic link stays
 * hand-asserted in each guard's own tests — claiming otherwise would be the same
 * false-green this file exists to prevent.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { fitnessRules } from '../../scripts/lib/fitness/registry.ts';
import { readGateInputs, scriptReachability } from '../helpers/gate-membership.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const gate = readGateInputs(repoRoot);
const qualityWorkflow = readFileSync(resolve(repoRoot, '.github/workflows/quality.yml'), 'utf8');

const blockRules = fitnessRules.filter((r) => r.severity === 'block');

/** A backstop entry is a test path if it looks like one; otherwise it names an npm script. */
const isTestPath = (entry: string): boolean => entry.endsWith('.test.ts');

/** vitest.config.ts: include `tests/**` , exclude the two browser-mode subtrees. */
const collectedByVitest = (path: string): boolean =>
  path.startsWith('tests/') &&
  !path.startsWith('tests/browser/') &&
  !path.startsWith('tests/browser-motion/');

describe('fitness registry — every block rule declares a gate-reachable backstop', () => {
  it('the registry actually contains block rules (this suite is not vacuous)', () => {
    // Without this, deleting every block rule would make the whole file pass trivially —
    // the same "certified a tree I never examined" failure the empty-scope guards had.
    expect(blockRules.length).toBeGreaterThanOrEqual(15);
  });

  it('every block rule declares a non-empty implementedBy', () => {
    const undeclared = blockRules
      .filter((r) => !r.implementedBy || r.implementedBy.length === 0)
      .map((r) => r.id);
    expect(
      undeclared,
      undeclared.length === 0
        ? ''
        : `These rules are severity:'block' but name nothing that enforces them:\n` +
          undeclared.map((id) => `  - ${id}`).join('\n') +
          `\nAdd implementedBy: ['<npm script>'] or ['tests/.../x.test.ts']. If nothing ` +
          `enforces the rule, it is not a block rule — downgrade its severity instead of ` +
          `inventing a backstop.`,
    ).toEqual([]);
  });

  it('every npm-script backstop exists in package.json', () => {
    // Byte-derived, not declared: a typo'd or renamed script would otherwise read as backing.
    const missing = blockRules.flatMap((r) =>
      (r.implementedBy ?? [])
        .filter((e) => !isTestPath(e))
        .filter((e) => !(e in gate.scripts))
        .map((e) => `${r.id} -> ${e}`),
    );
    expect(missing, `implementedBy names npm scripts that do not exist: ${missing.join(', ')}`).toEqual(
      [],
    );
  });

  it('every test-file backstop exists on disk and is collected by vitest', () => {
    const broken = blockRules.flatMap((r) =>
      (r.implementedBy ?? [])
        .filter(isTestPath)
        .filter((e) => !existsSync(resolve(repoRoot, e)) || !collectedByVitest(e))
        .map((e) => `${r.id} -> ${e}`),
    );
    expect(
      broken,
      `implementedBy names test files that are missing or excluded from the default vitest run: ${broken.join(', ')}`,
    ).toEqual([]);
  });

  it('coverage:check is a named CI step (what makes a test-file backstop enforceable)', () => {
    // A test-file backstop is only unbypassable because CI runs the FULL suite. If that step
    // ever leaves quality.yml, every test-backed block rule silently becomes hook-only —
    // and the assertion above would keep passing, because the file would still exist.
    expect(qualityWorkflow).toMatch(/npm run coverage:check/);
  });

  it('every npm-script backstop is gate-reachable — no block rule rests on a client-side hook', () => {
    // The core assertion. A guard that runs ONLY from .husky/pre-push is advisory:
    // `gh pr merge`, the GitHub merge button, `--no-verify`, and any clone without husky
    // installed all bypass it. `guard:transport-patterns` was in exactly that state while
    // backing three of these rules until #2052.
    const unreachable = blockRules.flatMap((r) =>
      (r.implementedBy ?? [])
        .filter((e) => !isTestPath(e))
        .map((e) => ({ rule: r.id, script: e, reach: scriptReachability(e, gate) }))
        .filter((x) => !x.reach.reachable)
        .map((x) => `${x.rule} -> ${x.script}: ${x.reach.detail}`),
    );
    expect(
      unreachable,
      unreachable.length === 0
        ? ''
        : `These block rules rest on checks a server-side merge bypasses:\n` +
          unreachable.map((u) => `  - ${u}`).join('\n') +
          `\nAdd a named step to .github/workflows/quality.yml, or add the guard to ` +
          `CI_EXEMPT_PUSH_GATE_GUARDS in tests/helpers/gate-membership.ts naming the ` +
          `live-tree test that enforces it inside the full suite.`,
    ).toEqual([]);
  });

  it('implementedBy entries are distinguishable — no path-shaped npm script or vice versa', () => {
    // Cheap shape check so a mis-typed entry lands in the branch that will actually test it,
    // rather than being silently classified as the other kind and skipped by both.
    const confused = blockRules.flatMap((r) =>
      (r.implementedBy ?? [])
        .filter((e) => (isTestPath(e) ? !e.includes('/') : e.includes('/')))
        .map((e) => `${r.id} -> ${e}`),
    );
    expect(
      confused,
      `entries that look like neither a clean npm script nor a repo-relative test path: ${confused.join(', ')}`,
    ).toEqual([]);
  });
});
