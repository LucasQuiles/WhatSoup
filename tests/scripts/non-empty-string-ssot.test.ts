/**
 * Arch ratchet: typeof+trim non-empty-string SSOT concentration (#2211, #2849).
 *
 * The open-coded `typeof v === 'string' && v.trim() !== ''` idiom was
 * consolidated into `nonEmptyString()` / `nonEmptyStringRaw()` in
 * `src/lib/type-guards.ts`. This test enforces that the count of remaining
 * open-coded sites never INCREASES — each migration lowers the baseline.
 *
 * The remaining sites are either:
 *  - Boolean-returning predicates (not value coercers — different shape)
 *  - Inline clauses inside larger logic (other variant patterns — #2849 scope)
 *  - Multi-arg helpers with additional logic beyond the bare idiom
 *
 * When a site is migrated, lower EXPECTED_BASELINE by the number of sites
 * removed. If this test fails with a count HIGHER than the baseline, a new
 * open-coded instance was introduced — use the helper instead.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, it, expect } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '../..');
const SRC_DIR = join(REPO_ROOT, 'src');
const HELPER_FILE = 'src/lib/type-guards.ts';

const PATTERN = /typeof\s+\w+\s*===\s*['"]string['"]\s*&&\s*\w+\.trim\(\)\s*!==\s*['"]['"]/g;

/**
 * Current baseline of open-coded typeof+trim sites outside type-guards.ts.
 * Lower this when migrating sites to nonEmptyString/nonEmptyStringRaw.
 *
 * History:
 *  - 21: initial baseline at #2211 landing (named-function migrations only).
 *  - 0:  #2849 variant-1 batch migrated all remaining inline `typeof === 'string'
 *        && v.trim() !== ''` sites in src/. Remaining #2849 scope uses other
 *        variant patterns (.length, truthy, cast) not matched by this ratchet,
 *        plus console/src sites (this ratchet scans src/ only).
 */
const EXPECTED_BASELINE = 0;

function countOpenCodedSites(): { total: number; perFile: Record<string, number> } {
  const perFile: Record<string, number> = {};
  const files = readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'));

  for (const file of files) {
    const relPath = join('src', file);
    if (relPath === HELPER_FILE) continue;
    const content = readFileSync(join(SRC_DIR, file), 'utf8');
    const matches = content.match(PATTERN);
    if (matches && matches.length > 0) {
      perFile[relPath] = matches.length;
    }
  }

  const total = Object.values(perFile).reduce((a, b) => a + b, 0);
  return { total, perFile };
}

describe('non-empty-string SSOT ratchet (#2211)', () => {
  it('open-coded typeof+trim count does not exceed baseline', () => {
    const { total, perFile } = countOpenCodedSites();
    expect(
      total,
      `Expected at most ${EXPECTED_BASELINE} open-coded typeof+trim sites outside ${HELPER_FILE}.\n` +
      `Found ${total}:\n${JSON.stringify(perFile, null, 2)}\n` +
      `If you migrated sites, lower EXPECTED_BASELINE. If you added a new site, use nonEmptyString()/nonEmptyStringRaw() instead.`,
    ).toBeLessThanOrEqual(EXPECTED_BASELINE);
  });

  it('the helper file itself is exempt (it owns the idiom)', () => {
    const helperContent = readFileSync(join(REPO_ROOT, HELPER_FILE), 'utf8');
    const matches = helperContent.match(PATTERN);
    // The helper file MUST contain the idiom — that's its purpose.
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2); // nonEmptyString + nonEmptyStringRaw
  });
});
