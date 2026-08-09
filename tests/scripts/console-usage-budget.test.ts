/**
 * Console-usage budget ratchet — locks the raw console.* call count in src/ at
 * its current baseline so new occurrences are consciously introduced.
 *
 * WhatSoup routes all operator-visible diagnostics through Pino (`src/logger.ts`)
 * and the bot-errors outbox. A raw `console.(log|warn|error|info|debug)(...)` in
 * production code bypasses that surface: it is invisible to the structured log
 * pipeline, unredacted (it can leak secrets the logger would scrub), and
 * unattributed (no level / instance / module metadata). This ratchet prevents
 * the raw count from growing silently; each migration to the logger / outbox
 * lowers the baseline.
 *
 * Baseline measured live on main b8e1cbc0d: 31 occurrences across 6 src/ files.
 * Per-method: error 25, log 4, warn 2 (info/debug 0). The dominant site is
 * `src/transport/auth.ts` (21 — the pre-Pino auth path); the remainder are
 * bootstrap/cli top-level fatal-error prints and the standalone fleet entrypoint.
 *
 * Follow-on cars migrate these sites to the logger / bot-errors outbox and
 * lower the baseline one file at a time. This car introduces the ratchet only
 * (no migrations, no eslint rule, no other ratchets touched).
 *
 * Companion: #2209.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const srcRoot = resolve(repoRoot, 'src');

// Ratchet ceiling: the count may only stay the same or decrease.
// To raise it, update this constant AND explain why in the commit message.
// Baseline: 31, measured 2026-08-09 on main b8e1cbc0d (#2209).
// 2026-08-09: auth.ts 21 sites migrated to process.stderr.write (dual-channel
// pairing CLI; structured pipeline already served by log.* twins, #2930); 31→10.
const CONSOLE_USAGE_BUDGET = 10;

function collectSrcFiles(): string[] {
  // Node 22+ readdirSync recursive (replaces the phantom-dep tinyglobby that #2909 purged).
  return readdirSync(srcRoot, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.ts'))
    .map((d) => resolve(d.parentPath || srcRoot, d.name));
}

interface CountResult {
  file: string;
  count: number;
}

function countConsoleCalls(): { total: number; byFile: CountResult[] } {
  const files = collectSrcFiles();
  const byFile: CountResult[] = [];
  let total = 0;
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const matches = src.match(/console\.(log|warn|error|info|debug)\(/g);
    if (matches && matches.length > 0) {
      total += matches.length;
      byFile.push({ file: file.replace(repoRoot + '/', ''), count: matches.length });
    }
  }
  byFile.sort((a, b) => b.count - a.count);
  return { total, byFile };
}

describe('console-usage budget ratchet', () => {
  it('raw console.* call count in src/ does not exceed baseline (use the logger)', () => {
    const { total, byFile } = countConsoleCalls();
    const breakdown = byFile.map((r) => `  ${r.count}  ${r.file}`).join('\n');
    if (total > CONSOLE_USAGE_BUDGET) {
      // Use expect() with the breakdown as assertion message so failure output is actionable.
      expect(
        total,
        `console.* count is ${total} (budget: ${CONSOLE_USAGE_BUDGET}).\n` +
          'New occurrences should route through src/logger.ts (Pino) or the ' +
          'bot-errors outbox rather than raw console.* — raw prints bypass ' +
          'redaction, level metadata, and the operator log surface.\n\n' +
          `Current breakdown:\n${breakdown}`,
      ).toBeLessThanOrEqual(CONSOLE_USAGE_BUDGET);
    }
    // Explicit pass assertion (avoids js-no-expect test-integrity finding).
    expect(total).toBeLessThanOrEqual(CONSOLE_USAGE_BUDGET);
  });

  it('counting methodology scans .ts files under src/ (no phantom deps)', () => {
    const { total } = countConsoleCalls();
    // Smoke check: if this ever returns 0, the file discovery is broken.
    expect(total).toBeGreaterThan(0);
  });
});
