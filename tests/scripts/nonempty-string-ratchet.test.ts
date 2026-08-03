/**
 * Non-empty-string inline-pattern ratchet — ensures no src/ file re-inlines
 * the non-empty-string idiom instead of using isNonEmptyString() from
 * src/lib/type-guards.ts.
 *
 * #2849 tracks the migration of ~30 inline non-empty-string sites to the
 * shared helper. This ratchet locks the count of files still using the
 * inline patterns at baseline 0 (all migrated), preventing regression.
 *
 * Tracked patterns (both are semantically `!isNonEmptyString(x)`):
 *   1. `!x || x.trim() === ''` — falsy OR whitespace-only string
 *   2. `typeof x !== 'string' || x.trim() === ''` — non-string OR whitespace-only
 *
 * Excluded by design:
 *   - src/fleet/health-poller.ts — returns the RAW value after a trimmed
 *     check; needs a human decision before migration (#2849 notes this).
 *
 * Companion: #2849.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const srcRoot = resolve(repoRoot, 'src');

const NONEMPTY_STRING_BUDGET = 0;

// Files excluded by design (see header comment).
const EXCLUDED = new Set(['src/fleet/health-poller.ts']);

// Match the two inline patterns that are exact equivalents of !isNonEmptyString(x).
// Pattern 1: !var || var.trim() === ''
// Pattern 2: typeof var !== 'string' || var.trim() === ''
const INLINE_PATTERNS = [
  /!\w+\s*\|\|\s*\w+\.trim\(\)\s*===\s*''/,
  /typeof\s+\w+\s*!==\s*'string'\s*\|\|\s*\w+\.trim\(\)\s*===\s*''/,
];

function collectSrcFiles(): string[] {
  return readdirSync(srcRoot, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.ts'))
    .map((d) => resolve(d.parentPath || srcRoot, d.name));
}

interface InlineSite {
  file: string;
  patterns: string[];
}

function findInlineSites(): InlineSite[] {
  const files = collectSrcFiles();
  const sites: InlineSite[] = [];
  for (const file of files) {
    const relPath = file.replace(repoRoot + '/', '');
    if (EXCLUDED.has(relPath)) continue;
    const src = readFileSync(file, 'utf8');
    const matched: string[] = [];
    for (const pattern of INLINE_PATTERNS) {
      if (pattern.test(src)) matched.push(pattern.source);
    }
    if (matched.length > 0) sites.push({ file: relPath, patterns: matched });
  }
  return sites;
}

describe('non-empty-string inline-pattern ratchet', () => {
  it('no src/ file inlines the non-empty-string idiom (use isNonEmptyString)', () => {
    const sites = findInlineSites();
    if (sites.length > NONEMPTY_STRING_BUDGET) {
      const breakdown = sites
        .map((s) => `  ${s.file}: ${s.patterns.join(', ')}`)
        .join('\n');
      expect(
        sites,
        `${sites.length} src/ file(s) still inline the non-empty-string pattern instead of ` +
          `using isNonEmptyString() from src/lib/type-guards.ts:\n${breakdown}`,
      ).toHaveLength(NONEMPTY_STRING_BUDGET);
    }
    // Explicit pass assertion (avoids js-no-expect test-integrity finding).
    expect(sites).toHaveLength(NONEMPTY_STRING_BUDGET);
  });
});
