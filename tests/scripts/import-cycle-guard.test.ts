/**
 * Import-cycle guard — end-to-end, including the red proof against a real cycle.
 *
 * `module-cycles.test.ts` covers the pure Tarjan rules. What this file proves is the part
 * that only works end-to-end: that the guard resolves real TypeScript modules, builds a
 * graph with RUNTIME edges only, and refuses to call an unbuildable graph clean.
 *
 * The `--repo`/`--scope` seams point the production code path at a throwaway tree; nothing
 * about the resolution, graph construction, or cycle rules changes.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const guardPath = resolve(repoRoot, 'scripts/import-cycle-guard.ts');

const tempRoots: string[] = [];
afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway TS project whose `src/` holds exactly the given files. */
function makeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'import-cycle-'));
  tempRoots.push(dir);
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify(
      { compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext', target: 'esnext', allowImportingTsExtensions: true, noEmit: true }, include: ['src'] },
      null,
      2,
    ),
  );
  mkdirSync(join(dir, 'src'), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const abs = join(dir, 'src', name);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}

function runGuard(args: string[]): { status: number | null; out: string } {
  const r = spawnSync(
    process.execPath,
    ['--experimental-strip-types', guardPath, ...args],
    { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 },
  );
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** Enough acyclic modules to clear the guard's non-vacuity floors (100 modules / 200 edges). */
function padding(count: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    // Two runtime edges each, so the edge floor is cleared as well as the module floor.
    const a = `pad${(i + 1) % count}.ts`;
    const b = `pad${(i + 2) % count}.ts`;
    files[`pad${i}.ts`] = `export const v${i} = 1;\n`;
    if (i < count - 3) {
      files[`pad${i}.ts`] =
        `import { v${(i + 1) % count} } from './${a}';\n` +
        `import { v${(i + 2) % count} } from './${b}';\n` +
        `export const v${i} = v${(i + 1) % count} + v${(i + 2) % count};\n`;
    }
  }
  return files;
}

describe('import-cycle guard — the red proof', () => {
  it('BLOCKS (exit 1) on a real two-module runtime cycle', () => {
    const files = {
      ...padding(120),
      'a.ts': `import { b } from './b.ts';\nexport const a = b;\n`,
      'b.ts': `import { a } from './a.ts';\nexport const b = a;\n`,
    };
    const dir = makeProject(files);

    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', resolve(repoRoot, 'scripts/import-cycle-guard.ts'), '--repo', dir, '--scope', 'src'],
      { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 },
    );
    const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;

    if (result.status !== 1) console.error(`guard exited ${result.status}, expected 1:\n${out}`);
    expect(result.status).toBe(1);
    expect(out).toMatch(/src\/a\.ts/);
    expect(out).toMatch(/src\/b\.ts/);
    expect(out, 'must say how to break it').toMatch(/Break the cycle/);
  });

  it('PASSES (exit 0) on an acyclic project', () => {
    const dir = makeProject(padding(120));
    const { status, out } = runGuard(['--repo', dir, '--scope', 'src']);
    expect(status, out).toBe(0);
  });

  it('IGNORES a cycle formed only by `import type` — those edges are erased at runtime', () => {
    // This is the exact mistake that made a regex prototype report three cycles in src/
    // that do not exist. A type-only edge cannot participate in a runtime cycle.
    const files = {
      ...padding(120),
      'ta.ts': `import type { TB } from './tb.ts';\nexport interface TA { b?: TB }\n`,
      'tb.ts': `import type { TA } from './ta.ts';\nexport interface TB { a?: TA }\n`,
    };
    const dir = makeProject(files);
    const { status, out } = runGuard(['--repo', dir, '--scope', 'src']);
    expect(status, `type-only cycle must NOT block:\n${out}`).toBe(0);
    expect(out).toMatch(/type-only import\(s\) correctly excluded/);
  });

  it('is INCONCLUSIVE (exit 2), never a pass, when the graph is implausibly small', () => {
    // An empty or near-empty scan finds no cycles trivially. That must not read as clean.
    const dir = makeProject({ 'only.ts': 'export const x = 1;\n' });
    const { status, out } = runGuard(['--repo', dir, '--scope', 'src']);
    expect(status, `expected INCONCLUSIVE, got ${status}:\n${out}`).toBe(2);
    expect(out).toMatch(/implausibly small/);
  });

  it('is INCONCLUSIVE (exit 2) when the scope directory does not exist', () => {
    const dir = makeProject(padding(120));
    const { status, out } = runGuard(['--repo', dir, '--scope', 'nope']);
    expect(status, out).toBe(2);
    expect(out).toMatch(/inconclusive/i);
  });

  it('refuses a flag-shaped value instead of using it as a path', () => {
    const { status, out } = runGuard(['--scope', '--json']);
    expect(status).toBe(2);
    expect(out).toMatch(/another flag/);
  });

  it('refuses an unknown flag rather than silently ignoring it', () => {
    const { status, out } = runGuard(['--scoop', 'src']);
    expect(status).toBe(2);
    expect(out).toMatch(/Unknown argument/);
  });
});

describe('import-cycle guard — this repo', () => {
  it('reports no runtime import cycles in src/, over a non-vacuous graph', () => {
    // Green on arrival: measured 433 modules / 1176 runtime edges / 0 cycles when written.
    // The counts are asserted too — a pass over an empty graph would otherwise look
    // identical to a pass over the real one.
    const { status, out } = runGuard(['--json']);
    expect(status, `guard is not green on arrival:\n${out}`).toBe(0);
    const report = JSON.parse(out) as {
      moduleCount: number;
      edgeCount: number;
      typeOnlySkipped: number;
      cycles: string[][];
    };
    expect(report.cycles).toEqual([]);
    expect(report.moduleCount).toBeGreaterThan(300);
    expect(report.edgeCount).toBeGreaterThan(800);
    expect(report.typeOnlySkipped, 'type-only imports must actually be being counted').toBeGreaterThan(0);
  });
});
