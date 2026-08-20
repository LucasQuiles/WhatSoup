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
 * syntactic call sites, 7 of them effective — ConsolidationRunStore
 * .requestCancellation takes its nowMs as `_nowMs` and discards it, so one
 * migrated site feeds a value nothing reads) to an injected Clock defaulting
 * to systemClock, and threaded that clock into runConsolidation so the run
 * report — and the completion receipt derived from it — are stamped from it
 * too.
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
 * Deliberately NOT bounded, with reasons rather than by omission:
 *   - `new Date(explicitMs)` — derives from an argument, not the wall clock.
 *   - `Date.parse(str)` (52 in src/) — parses a supplied string; the value
 *     comes from the caller, so it inherits whatever clock produced it.
 *   - `performance.now()` (10 in src/) — a monotonic duration timer, not a
 *     wall-clock reading, and not substitutable by systemClock.
 * Bounding these would flag correct code and train people to ignore the gate.
 *
 * Slice (2026-08-18, #2200): migrated the src/mcp/ subtree — registry.ts (7),
 * tools/knowledge.ts (3), socket-server.ts (1), tools/retention.ts (1), and
 * tools/memory-write.ts (1 bare new Date()) — to an injected Clock defaulting
 * to systemClock. 12 Date.now() + 1 bare new Date() sites removed, clearing
 * the whole src/mcp/ subtree: it now has zero raw sites of all three patterns.
 * CLOCK_BUDGET lowered 308 -> 296; BARE_NEW_DATE_BUDGET lowered 105 -> 104.
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
const CLOCK_BUDGET = 296;
// Same debt, different syntax — each dodged the call-site count entirely.
const DATE_NOW_REF_BUDGET = 9;
const BARE_NEW_DATE_BUDGET = 104;

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
 * Drops comment content, keeping code — including code that follows a
 * block-comment closer ON THE SAME LINE.
 *
 * Why strip at all: the count is a debt metric and prose is not debt. Counting
 * raw text meant a comment explaining the migration registered as a call site,
 * so DOCUMENTING the rule raised the number the rule bounds — a perverse
 * incentive, and how this slice first "failed" its own ratchet.
 *
 * Policy (fail-closed in the undercount direction): block-comment spans are
 * consumed ONLY when they begin the (remaining) line, and whatever follows the
 * closer on that line is KEPT and counted. A line that opens and closes
 * (`/* n *\/ const t = …`), a closer line of an open block (`more *\/ const t…`),
 * and close-then-reopen (`/* a *\/ /* b`) are all handled; the old whole-line
 * drop hid code in the first two shapes. Comment spans that start MID-line
 * (after real code) are NOT consumed — trailing comments are kept and would
 * OVERcount, the safe direction. A string or template literal therefore still
 * never starts a phantom comment unless the line's first non-space characters
 * are literally `/*` (the multi-line template caveat is inherited unchanged
 * from the whole-line policy).
 */
function stripComments(src: string): string {
  const kept: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    let text = line;
    for (;;) {
      const trimmed = text.trim();
      if (inBlock) {
        const closer = trimmed.indexOf('*/');
        if (closer === -1) break; // whole remainder is comment
        inBlock = false;
        text = trimmed.slice(closer + 2); // keep any code after the closer
        if (text.trim() === '') break;
        continue;
      }
      if (trimmed.startsWith('/*')) {
        const closer = trimmed.indexOf('*/');
        if (closer === -1) {
          inBlock = true; // opens a block that continues past this line
          break;
        }
        text = trimmed.slice(closer + 2); // keep any code after the closer
        if (text.trim() === '') break;
        continue;
      }
      if (trimmed.startsWith('//')) break;
      // A `*`-prefixed line OUTSIDE a block is code — an operator
      // continuation such as `  * Date.now();` (harvested from orphan
      // f06dec747). Inside a block it is comment interior, consumed by the
      // inBlock branch above.
      kept.push(text); // code line, or the code remainder after consumed spans
      break;
    }
  }
  return kept.join('\n');
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
    // Multi-line block comments (including JSDoc continuation lines).
    expect(
      stripComments(['/**', ' * Defaults to Date.now().', ' */', 'const a = 1;'].join('\n')),
    ).not.toContain('Date.now()');
    // A real call site still counts.
    expect(stripComments('const t = Date.now();')).toContain('Date.now()');
  });

  it('never hides a call site behind comment-like text in a literal', () => {
    // Undercounting is the one direction that matters: it lets the ratchet
    // silently permit new debt. The earlier inline-regex stripper failed all
    // three of these — a literal containing a comment opener swallowed real
    // code until the next closer, and a literal containing // truncated its
    // own line. Same totals, hidden hazard.
    const hazards = [
      ['const s = "/*";', 'const t = Date.now();', 'const u = "*/";'].join('\n'),
      "const s = 'a // b'; const t = Date.now();",
      'const s = `x // y`; const t = Date.now();',
      // Harvested from preserved orphan f06dec747 (2026-08-17, not on main):
      // a `*`-prefixed line OUTSIDE a block comment is an operator
      // continuation, not a JSDoc line — the whole-line stripper dropped it.
      'const x = a\n  * Date.now();',
    ];
    for (const src of hazards) {
      expect(
        stripComments(src),
        `stripping hid a real call site — the ratchet would undercount:\n${src}`,
      ).toContain('Date.now()');
    }
  });

  it('same-line block-comment close does not hide code after the closer', () => {
    // A line that both opens and closes a block comment, or that closes an
    // open block, can still carry real code after the closer. The old
    // stripper dropped the whole line either way, hiding call sites —
    // undercount, the one dangerous direction. Both shapes confirmed by a
    // lead-side differential harness.
    expect(
      stripComments('/* n */ const t = Date.now();'),
      'opener+closer on one line hid trailing code',
    ).toContain('Date.now()');
    expect(
      stripComments(['/* explain', '   more */ const t = Date.now();'].join('\n')),
      'closer line of an open block hid trailing code',
    ).toContain('Date.now()');
    // Close-and-reopen on one line: the reopened comment must stay a comment
    // (its prose must NOT leak into the kept code as a false call site).
    expect(
      stripComments(
        ['/* a */ /* reopened', 'prose naming Date.now()', '*/', 'const t = 1;'].join('\n'),
      ),
      'reopened comment leaked prose into code',
    ).not.toContain('Date.now()');
    expect(
      stripComments(['/* a */ /* reopened', 'prose naming Date.now()', '*/', 'const t = 1;'].join('\n')),
    ).toContain('const t = 1;');
  });
});
