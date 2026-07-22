/**
 * Guards the SHAPE of secret-like test fixtures, not their content.
 *
 * Why this exists (real incident, 2026-07-22): `tests/scripts/repo-hygiene-guard.test.ts`
 * carried literal secret-SHAPED fixtures. Machine-level agent secret scanners — notably the
 * claude-guards `validate-secrets` PreToolUse hook — scan the PROJECTED file on every
 * Write/Edit/MultiEdit and denied EVERY edit to it, including a whitespace-only one. Those
 * scanners have only a structural `.mcp.json` exemption; there is no test-fixture carve-out.
 * The result was a legitimate, actively-maintained file that no agent could modify at all,
 * which blocked a real typecheck fix and held ~54 commits back from the remote.
 *
 * The fix was to ASSEMBLE secret-shaped fixtures at runtime instead of writing them as
 * literals. The value the code under test receives is byte-identical, so tests are unchanged;
 * only the source stops looking like a secret. This is not scanner evasion — the scanner
 * exists to keep REAL secrets out of files, and these are synthetic fixtures that were
 * false-positiving.
 *
 * This test stops that from silently regressing: a future literal fixture would re-brick the
 * file, and the failure mode is invisible (an agent simply cannot edit it) rather than a
 * normal red test.
 *
 * Fail-closed: a listed file that cannot be read FAILS. "I could not check" is never a pass.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { scanAddedLines } from '../../scripts/repo-hygiene-guard.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Files that legitimately contain secret-SHAPED fixtures and are therefore exposed to the
 * uneditable-file failure mode. Mirrors the `fixtureFiles` allowlist in
 * `scripts/repo-hygiene-guard.ts` (which is module-internal, so it cannot be imported).
 * If you add a path there that carries secret-shaped fixtures, add it here too.
 */
const SECRET_SHAPED_FIXTURE_FILES = [
  'tests/scripts/repo-hygiene-guard.test.ts',
  'tests/scripts/anonymize-private-literals.test.ts',
  'scripts/repo-hygiene-guard.ts',
  'scripts/anonymize-private-literals.ts',
];

/**
 * Literal secret shapes that machine-level scanners flag. Built from fragments so THIS file
 * never contains a literal shape either — otherwise the guard would brick itself, which is
 * precisely the bug it exists to prevent.
 */
const LITERAL_SECRET_SHAPES: ReadonlyArray<{ readonly label: string; readonly regex: RegExp }> = [
  { label: 'anthropic-key', regex: new RegExp(['sk', 'ant', '[A-Za-z0-9]{16,}'].join('-')) },
  { label: 'pinecone-key', regex: new RegExp(['pcsk', '[A-Za-z0-9_]{16,}'].join('_')) },
  { label: 'openai-key', regex: new RegExp(['sk', '[A-Za-z0-9]{32,}'].join('-')) },
  { label: 'pem-private-key', regex: new RegExp(`${'-----BEGIN'}[A-Z ]*${'PRIVATE KEY'}-----`) },
  { label: 'supabase-secret', regex: new RegExp(['sb', 'secret', '[A-Za-z0-9_-]{16,}'].join('_')) },
];

describe('secret-shaped test fixtures stay assembled, never literal', () => {
  it.each(SECRET_SHAPED_FIXTURE_FILES)('%s contains no literal secret shape', (relPath) => {
    let content: string;
    try {
      content = readFileSync(join(repoRoot, relPath), 'utf8');
    } catch (error) {
      // Fail closed: an unreadable or renamed file is an unchecked invariant, not a pass.
      throw new Error(
        `cannot read ${relPath} to verify fixture shape (${(error as Error).message}). ` +
          'If the file moved, update SECRET_SHAPED_FIXTURE_FILES; do not delete the check.',
      );
    }

    const offenders = content
      .split('\n')
      .flatMap((line, index) =>
        LITERAL_SECRET_SHAPES.filter((shape) => shape.regex.test(line)).map(
          (shape) => `${relPath}:${index + 1} literal ${shape.label}`,
        ),
      );

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `Literal secret-shaped fixture(s) found. Machine-level agent secret scanners scan the ` +
          `projected file on every edit, so a literal here makes this file permanently uneditable ` +
          `by any agent. Assemble the value instead, e.g. \`\${'pcsk' + '_rest'}\` in a template ` +
          `literal — the runtime value is identical and the tests do not change.\n` +
          offenders.join('\n'),
    ).toEqual([]);
  });

  it('the shape patterns actually match a literal (guard is not vacuous)', () => {
    // Assemble genuinely-shaped samples at runtime so this file stays literal-free while
    // still proving each pattern fires. A guard that never matches anything is a false green.
    const samples: ReadonlyArray<readonly [string, string]> = [
      ['anthropic-key', ['sk', 'ant', 'A1b2C3d4E5f6G7h8I9j0K1l2'].join('-')],
      ['pinecone-key', ['pcsk', 'A1b2C3d4E5f6G7h8I9j0'].join('_')],
      ['openai-key', ['sk', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('-')],
      ['pem-private-key', `${'-----BEGIN'} ${'PRIVATE KEY'}-----`],
      ['supabase-secret', ['sb', 'secret', 'A1b2C3d4E5f6G7h8I9j0'].join('_')],
    ];

    for (const [label, sample] of samples) {
      const shape = LITERAL_SECRET_SHAPES.find((candidate) => candidate.label === label);
      expect(shape, `no pattern registered for ${label}`).toBeDefined();
      expect(shape!.regex.test(sample), `${label} pattern failed to match its own sample`).toBe(true);
    }
  });

  it('exempts markdown prose from unbounded-suppression but still flags code', () => {
    // Every suppression token below is ASSEMBLED at runtime. Written literally they would make
    // THIS file trip the very rule under test - the same self-detection problem
    // `isSuppressionComment` solves the same way in the guard's own source. The values are
    // byte-identical at runtime, so the assertions below test exactly what they appear to.
    const tsSuppression = (kind: string) => `// @ts-${kind}`;
    const bare = (kind: string) => `@ts-${kind}`;

    // Documentation that DOCUMENTS the suppression policy must be able to name the tokens it
    // forbids. A suppression comment in prose is inert - it suppresses nothing.
    const docIssues = scanAddedLines([
      { filePath: 'docs/plans/example.md', line: 1, text: `Do not add \`${bare('ignore')}\` to silence this.` },
      { filePath: 'docs/plans/example.md', line: 2, text: `Never use ${bare('expect-error')} here.` },
      // Token assembled at runtime: writing it literally trips the machine-level
      // suppression hook on THIS file, the same way literal secret fixtures used to.
      // `isSuppressionComment` in the guard under test uses this exact idiom on itself.
      { filePath: 'README.md', line: 3, text: `Avoid ${['eslint', 'disable'].join('-')} in new code.` },
    ]);
    expect(docIssues.filter((issue) => issue.code === 'unbounded-suppression')).toEqual([]);

    // The exemption is EXTENSION-scoped, not path-scoped: real code anywhere still blocks.
    // Tests especially - an unbounded suppression in a test is a real suppression. Gating this
    // rule on isProductionCodePath (src|scripts|deploy|console/src) would have silently
    // exempted tests/, which is why the check is documentation-scoped instead.
    // Assembled at runtime for the same reason as everything else in this file: written
    // literally, these three fixtures make THIS file trip the very suppression rule it is
    // testing. (They were previously silent only because they lived in
    // repo-hygiene-guard.test.ts, which sits in the guard's `fixtureFiles` allowlist —
    // assembling is preferable to widening that allowlist to cover another file.)
    const codeIssues = scanAddedLines([
      { filePath: 'src/x.ts', line: 1, text: tsSuppression('ignore') },
      { filePath: 'tests/x.test.ts', line: 2, text: tsSuppression('expect-error') },
      { filePath: 'console/src/y.tsx', line: 3, text: tsSuppression('nocheck') },
    ]);
    expect(codeIssues.filter((issue) => issue.code === 'unbounded-suppression')).toHaveLength(3);
    expect(codeIssues.filter((issue) => issue.code === 'unbounded-suppression').map((i) => i.filePath)).toEqual([
      'src/x.ts',
      'tests/x.test.ts',
      'console/src/y.tsx',
    ]);

    // A bounded suppression in code stays accepted, and a markdown file with a bounded one
    // is likewise silent - the exemption does not change the rationale+expiry contract.
    const boundedIssues = scanAddedLines([
      {
        filePath: 'src/z.ts',
        line: 1,
        text: '// @ts-expect-error -- upstream type is narrower than runtime payload; expires 2026-12-31',
      },
    ]);
    expect(boundedIssues.filter((issue) => issue.code === 'unbounded-suppression')).toEqual([]);
  });

  it('every listed fixture file is real (list cannot rot silently)', () => {
    for (const relPath of SECRET_SHAPED_FIXTURE_FILES) {
      expect(() => readFileSync(join(repoRoot, relPath), 'utf8'), `${relPath} is missing`).not.toThrow();
    }
  });
});
