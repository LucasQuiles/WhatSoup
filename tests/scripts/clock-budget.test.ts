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
const CLOCK_BUDGET = 365;

// src/lib/clock.ts is the ONE file allowed to call Date.now() (it wraps it).
const EXEMPT_FILE = 'src/lib/clock.ts';

function collectSrcFiles(): string[] {
  return readdirSync(srcRoot, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.ts'))
    .map((d) => resolve(d.parentPath || srcRoot, d.name))
    .filter((f) => !f.endsWith(EXEMPT_FILE));
}

interface DateNowSite {
  file: string;
  line: number;
  count: number;
}

function countDateNow(): { total: number; sites: DateNowSite[] } {
  const files = collectSrcFiles();
  const sites: DateNowSite[] = [];
  let total = 0;
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');
    let fileCount = 0;
    for (let i = 0; i < lines.length; i++) {
      const matches = lines[i].match(/Date\.now\(\)/g);
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

describe('clock budget ratchet', () => {
  it('raw Date.now() count in src/ does not exceed baseline (use systemClock)', () => {
    const { total, sites } = countDateNow();
    if (total > CLOCK_BUDGET) {
      const breakdown = sites
        .map((s) => `  ${s.file}: ${s.count}`)
        .join('\n');
      expect(
        total,
        `${total} Date.now() calls in src/ (baseline ${CLOCK_BUDGET}); ` +
          `new sites should use systemClock.now() from src/lib/clock.ts:\n${breakdown}`,
      ).toBeLessThanOrEqual(CLOCK_BUDGET);
    }
    // Explicit pass assertion (avoids js-no-expect test-integrity finding).
    expect(total).toBeLessThanOrEqual(CLOCK_BUDGET);
  });
});
