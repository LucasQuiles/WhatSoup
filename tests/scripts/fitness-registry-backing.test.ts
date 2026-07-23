/**
 * Every `severity: 'block'` fitness rule must name a real backstop, and that backstop must
 * actually run on a gate nobody can bypass — stated PER GATE PATH, because there are two
 * and they are not equivalent.
 *
 * A registry rule marked `block` is a promise that a merge carrying a violation cannot land.
 * Before `implementedBy`, nothing checked that promise: the rule→enforcement link lived in
 * prose inside `rationale` and in a row of the taxonomy doc. Establishing that all 17 block
 * rules were genuinely enforced (2026-07-22) took a dozen greps, because four of them —
 * `arch.file-size`, `hygiene.commit-author`, `hygiene.internal-labels`,
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
 * TWO CORRECTIONS to the first version of this file, both of which made it overstate:
 *
 *  1. It asserted EVERY `implementedBy` entry was reachable. Wrong quantifier — entries are
 *     ALTERNATIVE routes to the same detector, not a conjunction. `hygiene.internal-labels`
 *     is reached by three repo-hygiene modes, and `guard:repo:release-hygiene` runs only on
 *     the tag gate. Under the old rule, recording that third (true, load-bearing) route
 *     would have turned the suite red. A rule is enforced on a path if ANY of its backstops
 *     runs there; an entry that runs on NO path is a separate, weaker defect, asserted
 *     separately below.
 *
 *  2. It said "gate-reachable" while consulting `quality.yml` alone. There are two
 *     independent server-side paths, and `tag-release-gate.yml` runs fifteen discrete guard
 *     steps and NO unit suite — so every exemption-backed guard and every test-file backstop
 *     is unreachable there. That is 12 of the 17 block rules. The old wording implied a
 *     coverage claim the check never made.
 *
 * WHAT THIS PROVES: every block rule declares a backstop that exists on disk, runs somewhere,
 * and cannot be bypassed on the pull-request path; and the set of rules unenforced on the tag
 * path is exactly the recorded set, so that gap cannot widen unnoticed.
 * WHAT IT DOES NOT PROVE: that a named backstop detects what its rule describes. That
 * semantic link stays hand-asserted in each guard's own tests — claiming otherwise would be
 * the same false-green this file exists to prevent.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { fitnessRules } from '../../scripts/lib/fitness/registry.ts';
import {
  GATE_PATHS,
  backstopReachability,
  isTestPathBackstop,
  readGateInputs,
  runsFullSuite,
} from '../helpers/gate-membership.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const gate = readGateInputs(repoRoot);

const blockRules = fitnessRules.filter((r) => r.severity === 'block');

/** vitest.config.ts: include `tests/**`, exclude the two browser-mode subtrees. */
const collectedByVitest = (path: string): boolean =>
  path.startsWith('tests/') &&
  !path.startsWith('tests/browser/') &&
  !path.startsWith('tests/browser-motion/');

/**
 * Block rules with NO backstop on the tag/release gate — an exact ratchet, not a tolerance.
 *
 * `tag-release-gate.yml` runs no unit suite, so anything carried by `coverage:check` (every
 * test-file backstop, and every guard exempted on the strength of a live-tree test) does not
 * execute there, as well as any guard simply absent from that workflow.
 *
 * Second-order rather than a live breach: a tag is cut from `main`, and the pull-request path
 * covers all 17, so a clean `main` yields a clean tag. It matters because `enforce_admins`
 * is false on this repo — an admin push to `main` can skip `quality.yml` entirely, and the
 * tag gate is the only thing downstream of that.
 *
 * Recorded rather than fixed, deliberately: making the tag gate mirror the PR gate is a
 * release-engineering decision about what a tag push should cost, and belongs to whoever owns
 * that workflow. What is NOT optional is that the list stop growing silently. Adding a block
 * rule with no tag-path backstop fails here; wiring one up also fails here, until its id is
 * removed from this list — which is the good kind of failure.
 */
const TAG_PATH_UNCOVERED_BLOCK_RULES: readonly string[] = [
  'arch.file-size',
  'arch.ring-boundaries',
  'arch.ssot-jid-construction',
  'arch.ssot-lid-reads',
  'arch.ssot-name-ladder',
  'arch.ssot-phone-shape',
  'arch.ssot-presentation-literals',
  'hygiene.no-health-whatsapp-key-read',
  'hygiene.no-wa-jid-literal-in-generic-ui',
  'hygiene.no-whatsapp-copy-in-generic-ui',
  'process.no-destructive-git',
  'test.insecure-tempfile',
].sort();

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
        .filter((e) => !isTestPathBackstop(e))
        .filter((e) => !(e in gate.scripts))
        .map((e) => `${r.id} -> ${e}`),
    );
    expect(
      missing,
      `implementedBy names npm scripts that do not exist: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('every test-file backstop exists on disk and is collected by vitest', () => {
    const broken = blockRules.flatMap((r) =>
      (r.implementedBy ?? [])
        .filter(isTestPathBackstop)
        .filter((e) => !existsSync(resolve(repoRoot, e)) || !collectedByVitest(e))
        .map((e) => `${r.id} -> ${e}`),
    );
    expect(
      broken,
      `implementedBy names test files that are missing or excluded from the default vitest run: ${broken.join(', ')}`,
    ).toEqual([]);
  });

  it('coverage:check is a named step on the pull-request path (what makes a test-file backstop enforceable)', () => {
    // A test-file backstop is only unbypassable because that path runs the FULL suite. If
    // the step ever leaves quality.yml, every test-backed block rule silently becomes
    // hook-only — and the existence assertion above would keep passing, because the file
    // would still be on disk.
    expect(runsFullSuite('pull-request', gate)).toBe(true);
  });

  it('every block rule has at least one backstop that runs on the pull-request path', () => {
    // The core assertion. A guard that runs ONLY from .husky/pre-push is advisory:
    // `gh pr merge`, the GitHub merge button, `--no-verify`, and any clone without husky
    // installed all bypass it. `guard:transport-patterns` was in exactly that state while
    // backing three of these rules until #2052.
    //
    // ANY, not ALL: entries are alternative routes to one detector, so a rule is enforced
    // when one of them runs.
    const unreachable = blockRules
      .filter(
        (r) =>
          !(r.implementedBy ?? []).some(
            (e) => backstopReachability(e, gate, 'pull-request').reachable,
          ),
      )
      .map((r) => {
        const why = (r.implementedBy ?? [])
          .map((e) => `      ${e}: ${backstopReachability(e, gate, 'pull-request').detail}`)
          .join('\n');
        return `  - ${r.id}\n${why}`;
      });
    expect(
      unreachable,
      unreachable.length === 0
        ? ''
        : `These block rules rest entirely on checks a server-side merge bypasses:\n` +
          unreachable.join('\n') +
          `\nAdd a named step to .github/workflows/quality.yml, or add the guard to ` +
          `CI_EXEMPT_PUSH_GATE_GUARDS in tests/helpers/gate-membership.ts naming the ` +
          `live-tree test that enforces it inside the full suite.`,
    ).toEqual([]);
  });

  it('no declared backstop is dead — every entry runs on at least one gate path', () => {
    // Weaker than the per-rule assertion above and catches a different fault: an entry that
    // is listed, exists, and never executes anywhere. Without this, a rule could keep its
    // green by way of one live entry while accumulating decorative ones beside it.
    const dead = blockRules.flatMap((r) =>
      (r.implementedBy ?? [])
        .filter((e) => !GATE_PATHS.some((p) => backstopReachability(e, gate, p).reachable))
        .map((e) => `${r.id} -> ${e}`),
    );
    expect(
      dead,
      `these implementedBy entries run on NO gate path — remove them or wire them up: ${dead.join(', ')}`,
    ).toEqual([]);
  });

  it('the set of block rules unenforced on the tag/release path is exactly the recorded set', () => {
    const actual = blockRules
      .filter(
        (r) =>
          !(r.implementedBy ?? []).some(
            (e) => backstopReachability(e, gate, 'tag-release').reachable,
          ),
      )
      .map((r) => r.id)
      .sort();
    expect(
      actual,
      `Tag-path coverage changed.\n` +
        `  now uncovered: ${actual.join(', ') || '(none)'}\n` +
        `  recorded     : ${TAG_PATH_UNCOVERED_BLOCK_RULES.join(', ')}\n` +
        `If you wired a rule into tag-release-gate.yml, delete its id from ` +
        `TAG_PATH_UNCOVERED_BLOCK_RULES. If a rule newly lost tag coverage, that is a ` +
        `regression — restore it rather than recording it.`,
    ).toEqual(TAG_PATH_UNCOVERED_BLOCK_RULES);
  });

  it('the tag/release path really does skip the full suite (the reason the list above exists)', () => {
    // Pins the single fact the whole tag-path analysis rests on. If tag-release-gate.yml
    // ever gains coverage:check, this fails and the recorded list must shrink accordingly —
    // so the explanation cannot outlive the condition that justified it.
    expect(runsFullSuite('tag-release', gate)).toBe(false);
  });

  it('implementedBy entries are distinguishable — no path-shaped npm script or vice versa', () => {
    // Cheap shape check so a mis-typed entry lands in the branch that will actually test it,
    // rather than being silently classified as the other kind and skipped by both.
    const confused = blockRules.flatMap((r) =>
      (r.implementedBy ?? [])
        .filter((e) => (isTestPathBackstop(e) ? !e.includes('/') : e.includes('/')))
        .map((e) => `${r.id} -> ${e}`),
    );
    expect(
      confused,
      `entries that look like neither a clean npm script nor a repo-relative test path: ${confused.join(', ')}`,
    ).toEqual([]);
  });
});
