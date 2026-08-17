/**
 * Clock budget ratchet — locks the raw Date.now() count in src/ at its
 * pre-migration baseline so new occurrences are consciously introduced.
 *
 * #2200 establishes src/lib/clock.ts as the SSOT for time access. Production
 * code should call systemClock.now() (or an injected Clock) instead of
 * Date.now() directly. This ratchet prevents the raw count from growing;
 * each migration slice lowers the baseline.
 *
 * Baseline measured live on main 94c574f6: 365 Date.now() calls in src/
 * (excluding src/lib/clock.ts itself, which legitimately wraps Date.now()
 * inside SystemClock).
 *
 * The spec proposed 403; the live count had already shrunk to 365 as other
 * refactors removed call sites organically. Using the accurate current count.
 *
 * Tranche 1 (2026-08-08, #2200): migrated 10 timestamp-stamp files (34
 * Date.now() call sites) to systemClock.now(); live count dropped 363→329.
 *
 * Slice (2026-08-09, #2200): migrated lib/inbound-debouncer.ts (1
 * timing-math call site — createInboundDebouncer default clock object now
 * thunk) to systemClock.now(); live count dropped 329→328.
 *
 * Slice (2026-08-17, #2200): migrated memory/consolidation-scheduler.ts (8
 * call sites) to an injected Clock defaulting to systemClock, and threaded
 * that clock into runConsolidation so the run report is stamped from it too.
 * Chosen as constructor injection rather than a bare systemClock.now() swap
 * because #2200 names these tests as "already-flaky": injection is what makes
 * the scheduler drivable to a known instant, which a direct swap would not
 * have achieved. src/memory/ is now clear of all three patterns below.
 *
 * That slice also found the ratchet was measuring the wrong thing twice over:
 *
 *   1. It counted raw text, so comments naming the pattern scored as call
 *      sites — documenting the migration RAISED the number the ratchet bounds.
 *      Comments are now stripped, which revealed the real code-only count was
 *      308, not 328: twelve of the recorded "debt" was prose.
 *   2. It matched only `Date.now()`, so the same debt reached by other syntax
 *      was invisible — 9 bare `Date.now` references (no call parens) and 105
 *      bare `new Date()` wall-clock reads, all live in src/ while the budget
 *      read clean. Each now has its own budget, so the debt cannot move
 *      sideways while the headline number falls.
 *
 * Companion: #2200 slice 1.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const srcRoot = resolve(repoRoot, 'src');

// Ratchet ceiling: the count may only stay the same or decrease.
// Lower this constant when a migration slice removes Date.now() call sites.
const CLOCK_BUDGET = 308;
// Same debt, different syntax — each dodged the call-site count entirely.
const DATE_NOW_REF_BUDGET = 9;
const BARE_NEW_DATE_BUDGET = 105;

// src/lib/clock.ts is the ONE file allowed to call Date.now() (it wraps it).
const EXEMPT_FILE = 'src/lib/clock.ts';

function collectSrcFiles(): string[] {
  return readdirSync(srcRoot, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.ts'))
    .map((d) => resolve(d.parentPath || srcRoot, d.name))
    .filter((f) => !f.endsWith(EXEMPT_FILE));
}

interface PatternSite {
  file: string;
  line: number;
  count: number;
}

/**
 * Strips comments before counting.
 *
 * The count is a debt metric, and prose is not debt. Counting raw text meant a
 * comment explaining the migration registered as a new call site — so
 * DOCUMENTING the rule raised the number the rule bounds. That is a perverse
 * incentive, and it is how this slice first "failed" its own ratchet.
 *
 * Deliberately naive about comment-like sequences inside string literals: the
 * counted patterns do not appear inside strings anywhere in src/, and a
 * conservative strip is strictly better than scoring prose. The `[^:]` guard
 * keeps `https://` URLs from being treated as line comments.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function countPattern(pattern: RegExp): { total: number; sites: PatternSite[] } {
  const files = collectSrcFiles();
  const sites: PatternSite[] = [];
  let total = 0;
  for (const file of files) {
    const src = stripComments(readFileSync(file, 'utf8'));
    const lines = src.split('\n');
    let fileCount = 0;
    for (let i = 0; i < lines.length; i++) {
      const matches = lines[i].match(pattern);
      if (matches) fileCount += matches.length;
    }
    if (fileCount > 0) {
      total += fileCount;
      sites.push({
        file: file.replace(repoRoot + '/', ''),
        line: 0,
        count: fileCount,
      });
    }
  }
  return { total, sites };
}

function assertBudget(
  label: string,
  pattern: RegExp,
  budget: number,
  guidance: string,
): void {
  const { total, sites } = countPattern(pattern);
  const breakdown = sites.map((s) => `  ${s.file}: ${s.count}`).join('\n');
  expect(
    total,
    `${total} ${label} in src/ (baseline ${budget}); ${guidance}:\n${breakdown}`,
  ).toBeLessThanOrEqual(budget);
}

describe('clock budget ratchet', () => {
  it('raw Date.now() count in src/ does not exceed baseline (use systemClock)', () => {
    assertBudget(
      'Date.now() calls',
      /Date\.now\(\)/g,
      CLOCK_BUDGET,
      'new sites should use systemClock.now() from src/lib/clock.ts',
    );
  });

  // The three budgets below bound the SAME debt reached by different syntax.
  // Bounding only Date.now() let the debt move sideways: a bare `Date.now`
  // reference has no call parens and a `new Date()` is a wall-clock read with
  // no `Date.now` in it at all, so neither was ever counted. Both were found
  // live in src/ while the original budget read clean.
  it('bare Date.now references do not exceed baseline (they dodge the call-site count)', () => {
    assertBudget(
      'bare Date.now references',
      /Date\.now(?!\s*\()/g,
      DATE_NOW_REF_BUDGET,
      'pass a Clock or default to systemClock.now() instead of handing out Date.now',
    );
  });

  it('bare new Date() count in src/ does not exceed baseline', () => {
    // Empty parens only: `new Date(nowMs)` derives from an explicit argument
    // and is not a wall-clock read, so it must not be counted.
    assertBudget(
      'bare new Date() wall-clock reads',
      /new Date\(\)/g,
      BARE_NEW_DATE_BUDGET,
      'use systemClock.nowIso() (or derive from an explicit epoch) instead',
    );
  });

  it('counts code, not prose', () => {
    // Regression pin for the perverse incentive this slice hit: before comment
    // stripping, a comment naming the pattern counted as a call site, so
    // documenting the migration raised the number the ratchet bounds.
    const stripped = stripComments(
      ['// mentions Date.now() in prose', '/* and new Date() here */', 'const a = 1;'].join('\n'),
    );
    expect(stripped).not.toContain('Date.now()');
    expect(stripped).not.toContain('new Date()');
    expect(stripped).toContain('const a = 1;');
    // A real call site still counts.
    expect(stripComments('const t = Date.now();')).toContain('Date.now()');
    // Protocol-relative URLs are not line comments.
    expect(stripComments("const u = 'https://x.example';")).toContain('https://x.example');
  });
});
