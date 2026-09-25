import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  countDisallowedMaskedOperatorLines,
  deferredMaskedOperatorLineSites,
  findDisallowedMatch,
  maskedOperatorLinePattern,
} from '../../scripts/lib/repo-hygiene-policy.ts';

const REPO_ROOT = process.cwd();

// A group deliberately outside the reserved fiction set, and not a valid area
// code in any numbering plan, so the positive controls exercise the exclusion
// branch without publishing a line that could belong to anyone. The rule keys
// on "not reserved for fiction", never on a known value, so no real group is
// named in this file or in the policy it imports.
const NON_RESERVED_GROUP = '019';

// The reserved fiction form the identifier-replacement pass substituted.
const RESERVED_GROUP = '555';

function trackedDocsFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', 'docs/'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
  })
    .split('\0')
    .filter(Boolean);
}

describe('masked operator-line identifiers in published documentation', () => {
  it('matches every ellipsis glyph the documents use and clears the reserved fiction form', () => {
    // Positive controls. Each document keeps its own ellipsis glyph, so all
    // forms have to match: middle-dot runs in the mockups, ASCII periods in the
    // QA reports, and a bare horizontal ellipsis where an excerpt truncates
    // after the area group and publishes no trailing group at all.
    for (const sample of [
      `<span class="lid">+1 ${NON_RESERVED_GROUP} ··· 0142</span>`,
      `+1 ${NON_RESERVED_GROUP} ... 0142`,
      `community agent · WhatsApp · +1 ${NON_RESERVED_GROUP}…`,
      `signal · +1 ${NON_RESERVED_GROUP} ⋯ 014`,
    ]) {
      expect(findDisallowedMatch('', maskedOperatorLinePattern, sample)).not.toBeNull();
    }

    // Negative controls: the replacement form must stay clean in every glyph,
    // or the rule would re-flag the very text that satisfied it.
    for (const sample of [
      `<span class="lid">+1 ${RESERVED_GROUP} ··· 0199</span>`,
      `+1 ${RESERVED_GROUP} ... 0100`,
      `community agent · WhatsApp · +1 ${RESERVED_GROUP}…`,
    ]) {
      expect(findDisallowedMatch('', maskedOperatorLinePattern, sample)).toBeNull();
    }

    // A contiguous-digit rule cannot see this shape, which is why the earlier
    // census of the documentation tree read near-zero: the spaces and the
    // ellipsis break the digit run.
    expect(/[0-9]{10,}/.test(`+1 ${NON_RESERVED_GROUP} ··· 0142`)).toBe(false);
  });

  it('sweeps tracked documentation and grandfathers only the deferred sites', () => {
    const files = trackedDocsFiles();
    let scanned = 0;
    const offenders = new Map<string, number>();

    for (const file of files) {
      const bytes = readFileSync(join(REPO_ROOT, file));
      // Screenshots and other binaries carry no scannable text.
      if (bytes.includes(0)) continue;
      scanned += 1;
      const count = countDisallowedMaskedOperatorLines(bytes.toString('utf8'));
      if (count > 0) offenders.set(file, count);
    }

    // Coverage assertions. A sweep that silently collapsed to a handful of
    // files, or missed the design-system tree entirely, would report a clean
    // result for the wrong reason.
    expect(files.length).toBeGreaterThan(500);
    expect(scanned).toBeGreaterThan(500);
    expect(files).toContain('docs/design-system/v35/qa/README.md');
    expect(files).toContain('docs/design-system/v35/mockups/hatch.html');
    for (const site of deferredMaskedOperatorLineSites.keys()) expect(files).toContain(site);

    for (const [file, count] of offenders) {
      const budget = deferredMaskedOperatorLineSites.get(file);
      expect(
        budget,
        `${file} publishes ${count} masked operator-line group(s) and is not a deferred site`,
      ).toBeDefined();
      // The recorded count is an upper bound, so a ruling that removes masks
      // keeps this green while a new one on a listed file turns it red.
      expect(count, `${file} gained masked operator-line groups`).toBeLessThanOrEqual(budget!);
    }

    // The one mockup the replacement pass never opened. It is not grandfathered,
    // so this is the site that fails the sweep if the scrub is ever reverted.
    expect(deferredMaskedOperatorLineSites.has('docs/design-system/v35/mockups/hatch.html')).toBe(
      false,
    );
    expect(offenders.get('docs/design-system/v35/mockups/hatch.html')).toBeUndefined();
  });
});
