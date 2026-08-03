/**
 * DB-read prefix ratchet — enforces the `get` naming convention for DB-read helpers.
 *
 * The codebase uses three different prefixes for the same conceptual operation
 * (DB read taking a db: Database first argument): 'get' (the convention),
 * 'load' (legacy), and 'fetch' (non-DB I/O). #2213 establishes 'get' as the
 * SSOT prefix for DB-read helpers so code search by prefix returns consistent
 * subsets and new contributors can predict the convention without grep.
 *
 * This ratchet locks the inconsistency count at its current baseline so new
 * occurrences are consciously introduced rather than silently added. Each rename
 * (load to get, fetch to get where the function is actually a DB read) lowers
 * the baseline.
 *
 * Baseline measured live on main 4dc0e18e after slice 1 renames: 0
 * (the 2 prior inconsistencies were renamed to get-prefixed in this slice).
 * The remaining load and fetch exports are either async I/O (HTTP fetches,
 * file reads) or do not take a db argument, so they are correctly NOT counted.
 *
 * The spec proposed 7 inconsistencies; live count before this slice was 2
 * (the codebase evolved over 9 days). Using the accurate post-rename count.
 *
 * Companion: #2213 slice 1.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const srcRoot = resolve(repoRoot, 'src');

// Ratchet ceiling: the count may only stay the same or decrease.
const DB_READ_PREFIX_BUDGET = 0;

// Match: export (async )? function (load|fetch)<X>(... db: Database ...)
// The convention: DB-read helpers use `get`. `load`/`fetch` are legacy.
const DB_READ_INCONSISTENCY = /export\s+(?:async\s+)?function\s+(load|fetch)([A-Z]\w*)\s*\([^)]*db\s*:\s*(?:Database|DatabaseSync)/;

function collectSrcFiles(): string[] {
  // Node 22+ readdirSync recursive (no phantom deps).
  return readdirSync(srcRoot, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.ts'))
    .map((d) => resolve(d.parentPath || srcRoot, d.name));
}

interface Inconsistency {
  file: string;
  prefix: string;
  functionRest: string;
}

function findDbReadInconsistencies(): Inconsistency[] {
  const files = collectSrcFiles();
  const found: Inconsistency[] = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(DB_READ_INCONSISTENCY);
      if (match) {
        found.push({
          file: file.replace(repoRoot + '/', ''),
          prefix: match[1],
          functionRest: match[2],
        });
      }
    }
  }
  return found;
}

describe('DB-read prefix ratchet', () => {
  it('DB-read helpers use the get prefix (load*/fetch* with db arg are legacy)', () => {
    const inconsistencies = findDbReadInconsistencies();
    if (inconsistencies.length > DB_READ_PREFIX_BUDGET) {
      const breakdown = inconsistencies
        .map((i) => `  ${i.prefix}${i.functionRest}  ${i.file}`)
        .join('\n');
      expect(
        inconsistencies,
        `${inconsistencies.length} DB-read helper(s) use load*/fetch* instead of get*:\n${breakdown}`,
      ).toHaveLength(DB_READ_PREFIX_BUDGET);
    }
    // Explicit pass assertion (avoids js-no-expect test-integrity finding).
    expect(inconsistencies).toHaveLength(DB_READ_PREFIX_BUDGET);
  });

  it('file discovery scans src/**/*.ts (no phantom deps)', () => {
    const files = collectSrcFiles();
    expect(files.length).toBeGreaterThan(0);
  });
});
