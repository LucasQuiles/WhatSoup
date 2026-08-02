/**
 * Non-empty-string `.trim().length > 0` inline-pattern ratchet — ensures no
 * src/ file re-inlines the positive-form non-empty-string idiom instead of
 * using isNonEmptyString()/asNonEmptyString() from src/lib/type-guards.ts.
 *
 * #2849 slice 2 migrates the `.trim().length > 0` variant sites to the shared
 * helpers. Slice 1 (#2942) covers the `!x || x.trim() === ''` and
 * `typeof x !== 'string' || x.trim() === ''` variants — a separate ratchet.
 *
 * Tracked pattern (positive form, semantically equivalent to isNonEmptyString):
 *   `var.trim().length > 0` — used in ternaries/conditionals returning the
 *   value or undefined/null.
 *
 * Excluded by design (require per-site analysis, NOT mechanical migration):
 *   - src/lib/type-guards.ts — defines the helpers (self-reference)
 *   - Zod `.refine(s => s.trim().length > 0)` validators — operate on
 *     already-typed strings, not unknown values
 *   - src/runtimes/agent/handoff-summarizer.ts — complex filter chain
 *     operating on array splits, not a raw value guard
 *
 * Companion: #2849 (slice 2: .trim().length sites).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const srcRoot = resolve(repoRoot, 'src');

const TRIM_LENGTH_BUDGET = 0;

// Files excluded by design (see header comment).
const EXCLUDED = new Set([
  'src/lib/type-guards.ts',
  // Zod refine validators operate on already-typed strings, not unknown values.
  'src/fleet/typing-payload.ts',
  'src/fleet/silence-manager.ts',
  // Complex filter chain operating on array splits, not a raw value guard.
  'src/runtimes/agent/handoff-summarizer.ts',
]);

// Pattern: var.trim().length > 0 (positive form of the non-empty-string check)
const TRIM_LENGTH_PATTERN = /\w+\.trim\(\)\.length\s*[><!]=?\s*[01]/;

function collectSrcFiles(): string[] {
  return readdirSync(srcRoot, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.ts'))
    .map((d) => resolve(d.parentPath || srcRoot, d.name));
}

interface InlineSite {
  file: string;
}

function findInlineSites(): InlineSite[] {
  const files = collectSrcFiles();
  const sites: InlineSite[] = [];
  for (const file of files) {
    const relPath = file.replace(repoRoot + '/', '');
    if (EXCLUDED.has(relPath)) continue;
    const src = readFileSync(file, 'utf8');
    if (TRIM_LENGTH_PATTERN.test(src)) sites.push({ file: relPath });
  }
  return sites;
}

describe('non-empty-string .trim().length inline-pattern ratchet', () => {
  it('no src/ file inlines the .trim().length>0 idiom (use isNonEmptyString/asNonEmptyString)', () => {
    const sites = findInlineSites();
    if (sites.length > TRIM_LENGTH_BUDGET) {
      const breakdown = sites.map((s) => `  ${s.file}`).join('\n');
      expect(
        sites,
        `${sites.length} src/ file(s) still inline the .trim().length>0 pattern instead of ` +
          `using isNonEmptyString()/asNonEmptyString() from src/lib/type-guards.ts:\n${breakdown}`,
      ).toHaveLength(TRIM_LENGTH_BUDGET);
    }
    // Explicit pass assertion (avoids js-no-expect test-integrity finding).
    expect(sites).toHaveLength(TRIM_LENGTH_BUDGET);
  });
});
