import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findImportViolations } from '../../scripts/import-boundary-check.ts';

/**
 * Console ring/import-boundary ratchet (#2210).
 *
 * console/src is a peer package inside the import graph: it may reach into
 * the backend's shared primitives (lib) and domain contracts (core), never
 * into transport/mcp/runtimes/fleet internals. Until #2210 the boundary
 * guards walked only src/**, so a new console-side reach slipped past every
 * gate. Three layers now pin the invariant:
 *
 *  1. the standalone boundary guard walks console/src and the registry
 *     matrix admits only console → {console, core, lib};
 *  2. this ratchet pins the exact current reach (4 imports across 2 files)
 *     — any NEW console→src import fails with the offender named, and any
 *     baseline entry that disappears fails until the baseline is updated
 *     (shrink requires intent, matching the repo's baseline discipline);
 *  3. the fitness eslint ring mirrors ring-boundaries on console/src as
 *     advisory warnings (zero today).
 */

const CONSOLE_SRC = path.join(process.cwd(), 'console', 'src');

/**
 * The exact current reach, resolved to repo-relative targets. Update ONLY by
 * deliberate decision: a new entry is a new sanctioned cross-package edge and
 * belongs in the PR discussion, not in a quiet import line.
 */
const BASELINE: Readonly<Record<string, readonly string[]>> = {
  'console/src/types.ts': ['src/core/mark-read-types.ts'],
  'console/src/lib/providers.ts': [
    'src/lib/provider-ids.json',
    'src/lib/provider-ids.ts',
    'src/lib/provider-key-service.ts',
  ],
};

function walkConsoleFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkConsoleFiles(full));
    } else if (
      entry.isFile()
      && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))
      && !entry.name.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Every import/export specifier in a console file that resolves into the
 * backend src/ tree, as `${repoRelFile} -> ${repoRelTarget}` edges.
 */
function consoleToSrcEdges(): string[] {
  const edges: string[] = [];
  for (const file of walkConsoleFiles(CONSOLE_SRC)) {
    const relFile = path.relative(process.cwd(), file).split(path.sep).join('/');
    const source = readFileSync(file, 'utf8');
    const specifiers = source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g);
    for (const match of specifiers) {
      const specifier = match[1];
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue;
      const targetAbs = path.resolve(path.dirname(file), specifier);
      const relTarget = path.relative(process.cwd(), targetAbs).split(path.sep).join('/');
      if (relTarget.startsWith('src/')) {
        edges.push(`${relFile} -> ${relTarget}`);
      }
    }
  }
  return edges.sort();
}

describe('console ring/import-boundary ratchet (#2210)', () => {
  it('pins console→src reach to the exact baseline (growth fails with the offender named)', () => {
    const baselineEdges = Object.entries(BASELINE)
      .flatMap(([file, targets]) => targets.map((target) => `${file} -> ${target}`))
      .sort();
    const actual = consoleToSrcEdges();

    const growth = actual.filter((edge) => !baselineEdges.includes(edge));
    const shrink = baselineEdges.filter((edge) => !actual.includes(edge));

    expect(
      growth,
      `new console→src edge(s) outside the sanctioned baseline — discuss in the PR and update the ratchet deliberately:\n${growth.join('\n')}`,
    ).toEqual([]);
    expect(
      shrink,
      `baseline edge(s) disappeared — shrink requires intent: remove the entry from BASELINE in the same change:\n${shrink.join('\n')}`,
    ).toEqual([]);
  });

  it('the standalone boundary guard finds zero violations on the real repo with console in scope', () => {
    const violations = findImportViolations(process.cwd());
    const consoleViolations = violations.filter((violation) =>
      violation.file.startsWith('console/src/'),
    );
    expect(consoleViolations).toEqual([]);
    // Vacuous-scan tripwire: the guard must actually SEE console files.
    expect(existsSync(CONSOLE_SRC)).toBe(true);
    expect(walkConsoleFiles(CONSOLE_SRC).length).toBeGreaterThan(10);
  });

  it('baseline files still exist (the ratchet cannot silently pin a moved file)', () => {
    for (const file of Object.keys(BASELINE)) {
      expect(existsSync(file), `${file} moved — update the ratchet baseline`).toBe(true);
    }
  });
});
