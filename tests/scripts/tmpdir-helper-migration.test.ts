/**
 * tmpdir helper migration ratchet — ensures no test file re-inlines the
 * mkdtempSync + afterEach cleanup pattern instead of using trackTmpDirs().
 *
 * #2205 extracted `tests/helpers/tmp-dir.ts` to eliminate ~150 lines of
 * copy-pasted setup/teardown boilerplate across 37 test files. This ratchet
 * locks the count of files still using the inline `const tmpDirs: string[]`
 * pattern at baseline 0 (all migrated). New test files must use
 * `trackTmpDirs()` from `tests/helpers/tmp-dir.ts`.
 *
 * Companion: #2205.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const testsRoot = resolve(repoRoot, 'tests');

const TMPDIR_INLINE_BUDGET = 0;

// The inline pattern: `const tmpDirs: string[] = []` at file scope.
// This is the declaration that precedes the manual afterEach cleanup.
const INLINE_TMPDIRS_PATTERN = /const\s+tmpDirs\s*:\s*string\[\]\s*=\s*\[\]/;

function collectTestFiles(): string[] {
  return readdirSync(testsRoot, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && (d.name.endsWith('.test.ts') || d.name.endsWith('.spec.ts')))
    .map((d) => resolve(d.parentPath || testsRoot, d.name));
}

function findInlineTmpDirsFiles(): string[] {
  const files = collectTestFiles();
  const found: string[] = [];
  for (const file of files) {
    // Skip this ratchet file (its regex literal contains the pattern text).
    if (file.endsWith('tmpdir-helper-migration.test.ts')) continue;
    const src = readFileSync(file, 'utf8');
    if (INLINE_TMPDIRS_PATTERN.test(src)) {
      found.push(file.replace(repoRoot + '/', ''));
    }
  }
  return found;
}

describe('tmpdir helper migration ratchet', () => {
  it('no test file inlines the tmpDirs pattern (use trackTmpDirs)', () => {
    const inlineFiles = findInlineTmpDirsFiles();
    if (inlineFiles.length > TMPDIR_INLINE_BUDGET) {
      const breakdown = inlineFiles.map((f) => `  ${f}`).join('\n');
      expect(
        inlineFiles,
        `${inlineFiles.length} test file(s) still inline the tmpDirs pattern instead of using ` +
          `trackTmpDirs() from tests/helpers/tmp-dir.ts:\n${breakdown}`,
      ).toHaveLength(TMPDIR_INLINE_BUDGET);
    }
    // Explicit pass assertion (avoids js-no-expect test-integrity finding).
    expect(inlineFiles).toHaveLength(TMPDIR_INLINE_BUDGET);
  });
});
