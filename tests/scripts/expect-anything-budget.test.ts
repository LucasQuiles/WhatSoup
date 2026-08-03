/**
 * expect.anything() budget ratchet — the debt ceiling for weak test assertions.
 *
 * `expect.anything()` is the loosest possible matcher in vitest: it asserts only
 * that an argument was passed, regardless of value. A test whose only assertion is
 * `expect.anything()` is a false-green — it passes whether or not the function under
 * test works correctly. Over time the suite accumulates these vestigial placeholders
 * that mask regressions.
 *
 * This ratchet locks the count at its current baseline so new occurrences are
 * consciously introduced (raise the baseline in a reviewed change that says why)
 * rather than silently added. Each tightening in a test file lowers the baseline.
 *
 * Baseline measured live on main 4dc0e18e: 66 occurrences across 21 test files.
 * The spec (#2214) proposed 58 but the count grew between authoring and landing.
 *
 * Companion: #2214 slice 1 — adds this ratchet + rationale comments to the 6
 * main-bootstrap-helpers sites. Future slices tighten occurrences to
 * `expect.objectContaining({...})` where the expected shape is known, lowering
 * the baseline one file at a time.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const testsRoot = resolve(repoRoot, 'tests');

// Ratchet ceiling: the count may only stay the same or decrease.
// To raise it, update this constant AND explain why in the commit message.
const EXPECT_ANYTHING_BUDGET = 66;

function collectTestFiles(): string[] {
  // Node 22+ readdirSync recursive (replaces the phantom-dep tinyglobby that #2909 purged).
  const entries = readdirSync(testsRoot, { recursive: true, withFileTypes: true });
  return entries
    .filter((d) => d.isFile() && /\.test\.ts$/.test(d.name))
    .map((d) => join(d.parentPath || testsRoot, d.name));
}

interface CountResult {
  file: string;
  count: number;
}

function countExpectAnything(): { total: number; byFile: CountResult[] } {
  const files = collectTestFiles();
  const byFile: CountResult[] = [];
  let total = 0;
  // Exclude this file from its own count: the regex and error-message literals
  // contain the search string and would inflate the measurement by 5.
  const SELF = fileURLToPath(import.meta.url);
  for (const file of files) {
    if (resolve(file) === SELF) continue;
    const src = readFileSync(file, 'utf8');
    const matches = src.match(/expect\.anything\(\)/g);
    if (matches && matches.length > 0) {
      total += matches.length;
      byFile.push({ file: file.replace(repoRoot + '/', ''), count: matches.length });
    }
  }
  byFile.sort((a, b) => b.count - a.count);
  return { total, byFile };
}

describe('expect.anything() budget ratchet', () => {
  it('total count must not exceed the baseline ceiling (may only shrink)', () => {
    const { total, byFile } = countExpectAnything();
    const breakdown = byFile.map((r) => `  ${r.count}  ${r.file}`).join('\n');
    // Use expect() with the breakdown as assertion message so failure output is actionable.
    expect(
      total,
      `expect.anything() count is ${total} (budget: ${EXPECT_ANYTHING_BUDGET}).\n` +
        'Either tighten the new occurrence(s) to expect.objectContaining({...}) with the ' +
        'actual expected fields, or raise EXPECT_ANYTHING_BUDGET in this test with a ' +
        'justification in the commit message.\n\n' +
        `Current breakdown:\n${breakdown}`,
    ).toBeLessThanOrEqual(EXPECT_ANYTHING_BUDGET);
  });

  it('counting methodology scans .test.ts files under tests/ (no phantom deps)', () => {
    const { total } = countExpectAnything();
    // Smoke check: if this ever returns 0, the file discovery is broken.
    expect(total).toBeGreaterThan(0);
  });
});
