/**
 * Guard test: every registered transport error code resolves to a non-empty
 * operator runbook under docs/runbooks/transport-error-<kebab-suffix>.md, and
 * there are no orphan runbooks without a registered code.
 *
 * The naming suffix is derived from the code by the rule pinned in
 * error-codes.test.ts: `transport.foo_bar` -> `transport-error-foo-bar.md`.
 *
 * This guard is parameterized over `allErrorCodes()` so it stays in lockstep
 * with the registry in src/core/transport-error-taxonomy.ts — adding, renaming,
 * or removing a code without matching runbook (or deprecation) coverage fails
 * here deterministically.
 *
 * [DISCRIMINATING] Removing any runbook, emptying it, or breaking the
 * suffix-derivation mapping fails this test. It also fails if an orphan
 * transport-error-*.md runbook exists with no registered code, so a removed
 * code cannot leave a stale runbook behind.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { allErrorCodes } from '../../../src/transport/contract/error-codes.ts';

const RUNBOOKS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../docs/runbooks',
);

/** Mirrors the suffix-derivation rule pinned in error-codes.test.ts. */
function runbookFilename(code: string): string {
  const suffix = code.replace(/^transport\./, '').replace(/_/g, '-');
  return `transport-error-${suffix}.md`;
}

describe('transport error runbooks', () => {
  it('every registered code has a non-empty matching runbook (parameterized over allErrorCodes())', () => {
    for (const code of allErrorCodes()) {
      const file = runbookFilename(code);
      const path = resolve(RUNBOOKS_DIR, file);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        // surface a clear failure with the code -> expected path
        expect.fail(`missing runbook for ${code}: expected docs/runbooks/${file}`);
      }
      expect(stat.size, `${file} must be non-empty`).toBeGreaterThan(0);
    }
  });

  it('each runbook references its own error code string (catches stubs / wrong-code runbooks)', () => {
    for (const code of allErrorCodes()) {
      const path = resolve(RUNBOOKS_DIR, runbookFilename(code));
      const body = readFileSync(path, 'utf8');
      expect(
        body,
        `${runbookFilename(code)} must reference its own code string ${code}`,
      ).toContain(code);
    }
  });

  it('there are no orphan transport-error-*.md runbooks without a registered code', () => {
    const expected = new Set(allErrorCodes().map(runbookFilename));
    const present = readdirSync(RUNBOOKS_DIR).filter(
      (name) => name.startsWith('transport-error-') && name.endsWith('.md'),
    );
    const orphans = present.filter((name) => !expected.has(name));
    expect(
      orphans,
      `orphan runbooks with no registered code: ${orphans.join(', ')}`,
    ).toEqual([]);
  });

  it('the runbook count exactly matches the registered code count', () => {
    const codes = allErrorCodes();
    const present = readdirSync(RUNBOOKS_DIR).filter(
      (name) => name.startsWith('transport-error-') && name.endsWith('.md'),
    );
    expect(present).toHaveLength(codes.length);
    expect(codes).toHaveLength(8);
  });
});
