/**
 * The three-outcome verification helpers, and the self-test that proves they still refuse.
 *
 * `scripts/lib/verify-lib.sh` exists because five separate ad-hoc checks in one session
 * produced FALSE GREENS — each time an absent measurement silently became the reassuring
 * answer:
 *
 *   - a windowed `grep -A28` found nothing -> written up as "REFUTED"; the match was 7 lines
 *     outside the window
 *   - `grep -c "severity: 'block'"` counted a doc comment NAMING the pattern as an instance
 *   - a Bash call bundling an edit and a test run was rejected by a hook, so the EDIT never
 *     happened either, and the only signal was a test count that failed to move
 *   - a verifier compared two empty variables and reported "MATCHES" for all three PRs
 *   - a JSON filter queried `function_a` when the schema said `func_a`, returning 0 hits
 *
 * The shipped guards already encode 0 pass / 1 fail / 2 could-not-determine. This applies
 * the same rule to throwaway shell, where a false green becomes a wrong conclusion reported
 * to a human as fact.
 *
 * THE ASSERTION BELOW IS EXACTLY 2, AND THAT IS THE POINT. The self-test deliberately feeds
 * failing and inconclusive cases through the helpers, so a correct run ends INCONCLUSIVE.
 *   exit 0 -> the INCONCLUSIVE branches stopped firing; the library has gone permissive
 *   exit 1 -> a control case that should PASS now fails
 * Asserting `toBe(0)` here would invert the check into exactly the false green the library
 * was written to prevent.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const selfTest = resolve(repoRoot, 'scripts/verify-lib-selftest.sh');
const lib = resolve(repoRoot, 'scripts/lib/verify-lib.sh');

describe('verify-lib self-test', () => {
  it('both files exist — the assertion below is meaningless if the script is missing', () => {
    expect(existsSync(lib), 'scripts/lib/verify-lib.sh missing').toBe(true);
    expect(existsSync(selfTest), 'scripts/verify-lib-selftest.sh missing').toBe(true);
  });

  it('exits EXACTLY 2 — inconclusive, because it exercises the refusal branches', () => {
    const r = spawnSync('bash', [selfTest], { cwd: repoRoot, encoding: 'utf8', timeout: 60_000 });
    expect(
      r.status,
      r.status === 0
        ? 'self-test exited 0: the INCONCLUSIVE branches stopped firing, so the helpers have ' +
          'gone permissive and would now report an absent measurement as a pass.\n' +
          `${r.stdout}${r.stderr}`
        : `self-test exited ${r.status}, expected 2.\n${r.stdout}${r.stderr}`,
    ).toBe(2);
  });

  it('reports each known failure shape with the right verdict', () => {
    // Not just the exit code: the individual verdicts must still be right, or the exit code
    // could be 2 for the wrong reason.
    const r = spawnSync('bash', [selfTest], { cwd: repoRoot, encoding: 'utf8', timeout: 60_000 });
    const out = `${r.stdout}${r.stderr}`;
    expect(out, 'empty-vs-empty must be INCONCLUSIVE').toMatch(
      /INCONCLUSIVE\s+two empty values/,
    );
    expect(out, 'an errored command must not read as "found nothing"').toMatch(
      /INCONCLUSIVE\s+errored search/,
    );
    expect(out, 'a near-empty scan must not certify').toMatch(/INCONCLUSIVE\s+vacuous scan/);
    expect(out, 'absence over an unreadable file is not absence').toMatch(
      /INCONCLUSIVE\s+unreadable file/,
    );
    // …and the controls must still PASS, or the helpers have become uselessly strict.
    expect(out, 'a genuine match must still pass').toMatch(/PASS\s+real match/);
    expect(out, 'a genuine absence must still pass').toMatch(/PASS\s+real absence/);
    expect(out, 'grep exit 1 IS a valid zero-match').toMatch(/PASS\s+grep no match/);
  });
});
