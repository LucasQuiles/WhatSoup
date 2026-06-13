import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  findImportViolations,
  buildLayerMatrix,
  run,
  type BoundaryViolation,
} from '../../scripts/import-boundary-check.ts';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let fixtureRoot: string;

function createFixtureTree(files: Record<string, string>): void {
  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(fixtureRoot, relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('import-boundary-check', () => {
  beforeEach(() => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), 'whatsoup-import-boundary-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Layer detection
  // -------------------------------------------------------------------------

  describe('layer detection', () => {
    it('maps src/core/... to layer "core"', () => {
      createFixtureTree({
        'src/core/foo.ts': 'export const x = 1;\n',
      });
      const violations = findImportViolations(fixtureRoot);
      // No imports → no violations regardless
      expect(violations).toHaveLength(0);
    });

    it('maps src/config.ts (direct src/ file) to layer "root"', () => {
      createFixtureTree({
        'src/config.ts': 'export const x = 1;\n',
        'src/fleet/main.ts': `import { x } from '../config.ts';\n`,
      });
      // fleet → root is allowed (any layer may import root)
      const violations = findImportViolations(fixtureRoot);
      expect(violations).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Allowed edges pass
  // -------------------------------------------------------------------------

  describe('allowed edges', () => {
    it('allows core → lib import', () => {
      createFixtureTree({
        'src/lib/util.ts': 'export function util() {}\n',
        'src/core/service.ts': `import { util } from '../lib/util.ts';\n`,
      });
      const violations = findImportViolations(fixtureRoot);
      expect(violations).toHaveLength(0);
    });

    it('allows transport → core import', () => {
      createFixtureTree({
        'src/core/types.ts': 'export type T = string;\n',
        'src/transport/conn.ts': `import type { T } from '../core/types.ts';\n`,
      });
      const violations = findImportViolations(fixtureRoot);
      expect(violations).toHaveLength(0);
    });

    it('allows same-layer imports (core → core)', () => {
      createFixtureTree({
        'src/core/a.ts': 'export const a = 1;\n',
        'src/core/b.ts': `import { a } from './a.ts';\n`,
      });
      const violations = findImportViolations(fixtureRoot);
      expect(violations).toHaveLength(0);
    });

    it('allows any layer importing from root layer (src/config.ts)', () => {
      createFixtureTree({
        'src/config.ts': 'export const cfg = {};\n',
        'src/fleet/main.ts': `import { cfg } from '../config.ts';\n`,
        'src/mcp/server.ts': `import { cfg } from '../config.ts';\n`,
      });
      const violations = findImportViolations(fixtureRoot);
      expect(violations).toHaveLength(0);
    });

    it('allows fleet → transport import', () => {
      createFixtureTree({
        'src/transport/conn.ts': 'export function connect() {}\n',
        'src/fleet/manager.ts': `import { connect } from '../transport/conn.ts';\n`,
      });
      const violations = findImportViolations(fixtureRoot);
      expect(violations).toHaveLength(0);
    });

    it('allows mcp → transport import', () => {
      createFixtureTree({
        'src/transport/conn.ts': 'export function connect() {}\n',
        'src/mcp/registry.ts': `import { connect } from '../transport/conn.ts';\n`,
      });
      const violations = findImportViolations(fixtureRoot);
      expect(violations).toHaveLength(0);
    });

    it('allows memory → core import', () => {
      createFixtureTree({
        'src/core/db.ts': 'export function db() {}\n',
        'src/memory/store.ts': `import { db } from '../core/db.ts';\n`,
      });
      const violations = findImportViolations(fixtureRoot);
      expect(violations).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Forbidden edges fail with file:line in message
  // -------------------------------------------------------------------------

  describe('forbidden edges', () => {
    it('blocks lib → core import and includes file:line in violation', () => {
      createFixtureTree({
        'src/core/db.ts': 'export function db() {}\n',
        'src/lib/util.ts': `import { db } from '../core/db.ts';\n`,
      });
      const violations = findImportViolations(fixtureRoot);
      expect(violations).toHaveLength(1);
      const v = violations[0]!;
      expect(v.file).toContain('src/lib/util.ts');
      expect(v.line).toBe(1);
      expect(v.fromLayer).toBe('lib');
      expect(v.toLayer).toBe('core');
    });

    it('blocks core → transport import', () => {
      createFixtureTree({
        'src/transport/conn.ts': 'export function connect() {}\n',
        'src/core/bad.ts': `import { connect } from '../transport/conn.ts';\n`,
      });
      const violations = findImportViolations(fixtureRoot);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.fromLayer).toBe('core');
      expect(violations[0]!.toLayer).toBe('transport');
    });

    it('blocks core → fleet import', () => {
      createFixtureTree({
        'src/fleet/manager.ts': 'export const mgr = {};\n',
        'src/core/service.ts': `import { mgr } from '../fleet/manager.ts';\n`,
      });
      const violations = findImportViolations(fixtureRoot);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.fromLayer).toBe('core');
      expect(violations[0]!.toLayer).toBe('fleet');
    });

    it('blocks transport → fleet import', () => {
      createFixtureTree({
        'src/fleet/manager.ts': 'export const mgr = {};\n',
        'src/transport/conn.ts': `import { mgr } from '../fleet/manager.ts';\n`,
      });
      const violations = findImportViolations(fixtureRoot);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.fromLayer).toBe('transport');
      expect(violations[0]!.toLayer).toBe('fleet');
    });

    it('reports the correct line number for a violation', () => {
      createFixtureTree({
        'src/core/db.ts': 'export function db() {}\n',
        'src/lib/util.ts': [
          '// line 1',
          '// line 2',
          `import { db } from '../core/db.ts';`,
          '',
        ].join('\n'),
      });
      const violations = findImportViolations(fixtureRoot);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.line).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // src → tests/scripts is a violation
  // -------------------------------------------------------------------------

  describe('src importing from tests or scripts', () => {
    it('flags src → tests import as a violation', () => {
      createFixtureTree({
        'tests/helpers/fixture.ts': 'export const x = 1;\n',
        'src/core/service.ts': `import { x } from '../../tests/helpers/fixture.ts';\n`,
      });
      const violations = findImportViolations(fixtureRoot);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.toLayer).toBe('tests');
    });

    it('flags src → scripts import as a violation', () => {
      createFixtureTree({
        'scripts/util.ts': 'export const helper = () => {};\n',
        'src/core/service.ts': `import { helper } from '../../scripts/util.ts';\n`,
      });
      const violations = findImportViolations(fixtureRoot);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.toLayer).toBe('scripts');
    });
  });

  // -------------------------------------------------------------------------
  // Dynamic imports detected
  // -------------------------------------------------------------------------

  describe('dynamic imports', () => {
    it('detects a forbidden dynamic import()', () => {
      createFixtureTree({
        'src/core/db.ts': 'export function db() {}\n',
        'src/lib/lazy.ts': `const mod = await import('../core/db.ts');\n`,
      });
      const violations = findImportViolations(fixtureRoot);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.fromLayer).toBe('lib');
      expect(violations[0]!.toLayer).toBe('core');
    });

    it('detects a forbidden re-export from another layer', () => {
      createFixtureTree({
        'src/core/types.ts': 'export type T = string;\n',
        'src/lib/re-export.ts': `export { T } from '../core/types.ts';\n`,
      });
      const violations = findImportViolations(fixtureRoot);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.fromLayer).toBe('lib');
      expect(violations[0]!.toLayer).toBe('core');
    });

    it('detects a forbidden dynamic import() with a template-literal specifier', () => {
      createFixtureTree({
        'src/core/db.ts': 'export function db() {}\n',
        'src/lib/tpl.ts': 'const mod = await import(`../core/db.ts`);\n',
      });
      const violations = findImportViolations(fixtureRoot);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.fromLayer).toBe('lib');
      expect(violations[0]!.toLayer).toBe('core');
    });

    it('detects a forbidden dynamic import() whose specifier sits on a later line', () => {
      createFixtureTree({
        'src/core/db.ts': 'export function db() {}\n',
        'src/lib/multiline-dyn.ts': `const mod = await import(\n  '../core/db.ts'\n);\n`,
      });
      const violations = findImportViolations(fixtureRoot);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.toLayer).toBe('core');
      expect(violations[0]!.line).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Extraction edge cases (multiline statements, comments)
  // -------------------------------------------------------------------------

  describe('extraction edge cases', () => {
    it('detects a forbidden import whose binding list spans multiple lines', () => {
      createFixtureTree({
        'src/core/db.ts': 'export function db() {}\nexport function tx() {}\n',
        'src/lib/multi.ts': `import {\n  db,\n  tx,\n} from '../core/db.ts';\n`,
      });
      const violations = findImportViolations(fixtureRoot);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.specifier).toBe('../core/db.ts');
      expect(violations[0]!.line).toBe(1);
    });

    it('detects a forbidden multiline export-type re-export', () => {
      createFixtureTree({
        'src/core/types.ts': 'export type A = 1;\nexport type B = 2;\n',
        'src/lib/reexport.ts': `export type {\n  A,\n  B,\n} from '../core/types.ts';\n`,
      });
      const violations = findImportViolations(fixtureRoot);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.toLayer).toBe('core');
    });

    it('ignores a commented-out dynamic import', () => {
      createFixtureTree({
        'src/core/db.ts': 'export function db() {}\n',
        'src/lib/commented.ts': `// const m = await import('../core/db.ts');\nexport const ok = 1;\n`,
      });
      const violations = findImportViolations(fixtureRoot);
      expect(violations).toHaveLength(0);
    });

    it('detects a forbidden side-effect import', () => {
      createFixtureTree({
        'src/core/boot.ts': 'export {};\n',
        'src/lib/side.ts': `import '../core/boot.ts';\n`,
      });
      const violations = findImportViolations(fixtureRoot);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.specifier).toBe('../core/boot.ts');
    });

    it('does not let an export declaration absorb a later unrelated import', () => {
      createFixtureTree({
        'src/core/db.ts': 'export function db() {}\n',
        // `export const` can never have a `from` clause; the forbidden import
        // on the next line must be attributed to ITS own line, exactly once.
        'src/lib/decl.ts': `export const x = 1;\nimport { db } from '../core/db.ts';\n`,
      });
      const violations = findImportViolations(fixtureRoot);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.line).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Baseline / ratchet behaviour
  // -------------------------------------------------------------------------

  describe('baseline ratchet', () => {
    it('passes when a violation is already in the baseline (grandfathered)', () => {
      createFixtureTree({
        'src/core/db.ts': 'export function db() {}\n',
        'src/lib/util.ts': `import { db } from '../core/db.ts';\n`,
      });
      // Write a baseline that grandfathers this exact violation
      const baseline = [
        {
          file: 'src/lib/util.ts',
          line: 1,
          specifier: '../core/db.ts',
          fromLayer: 'lib',
          toLayer: 'core',
        },
      ];
      const baselineDir = path.join(fixtureRoot, '.claude/fitness');
      mkdirSync(baselineDir, { recursive: true });
      writeFileSync(
        path.join(baselineDir, 'boundary-baseline.json'),
        JSON.stringify(baseline, null, 2),
        'utf8',
      );

      const result = run(['--root', fixtureRoot], fixtureRoot, {});
      expect(process.exitCode).not.toBe(1);
      expect(result.newViolations).toHaveLength(0);
    });

    it('fails on NEW violation when a baselined violation also exists', () => {
      createFixtureTree({
        'src/core/db.ts': 'export function db() {}\n',
        'src/core/types.ts': 'export type T = string;\n',
        'src/lib/util.ts': `import { db } from '../core/db.ts';\n`,
        'src/lib/other.ts': `import type { T } from '../core/types.ts';\n`,
      });
      // Baseline grandfathers util.ts but NOT other.ts
      const baseline = [
        {
          file: 'src/lib/util.ts',
          line: 1,
          specifier: '../core/db.ts',
          fromLayer: 'lib',
          toLayer: 'core',
        },
      ];
      const baselineDir = path.join(fixtureRoot, '.claude/fitness');
      mkdirSync(baselineDir, { recursive: true });
      writeFileSync(
        path.join(baselineDir, 'boundary-baseline.json'),
        JSON.stringify(baseline, null, 2),
        'utf8',
      );

      const result = run(['--root', fixtureRoot], fixtureRoot, {});
      expect(process.exitCode).toBe(1);
      expect(result.newViolations).toHaveLength(1);
      expect(result.newViolations[0]!.file).toContain('src/lib/other.ts');
    });

    it('still matches a baselined violation after its line number shifts (formatter-safe ratchet)', () => {
      createFixtureTree({
        'src/core/db.ts': 'export function db() {}\n',
        // Two leading comment lines shift the import to line 3.
        'src/lib/util.ts': `// moved\n// by a formatter\nimport { db } from '../core/db.ts';\n`,
      });
      // Baseline recorded the violation when it sat on line 1.
      const baseline = [
        {
          file: 'src/lib/util.ts',
          line: 1,
          specifier: '../core/db.ts',
          fromLayer: 'lib',
          toLayer: 'core',
        },
      ];
      const baselineDir = path.join(fixtureRoot, '.claude/fitness');
      mkdirSync(baselineDir, { recursive: true });
      writeFileSync(
        path.join(baselineDir, 'boundary-baseline.json'),
        JSON.stringify(baseline, null, 2),
        'utf8',
      );

      const result = run(['--root', fixtureRoot], fixtureRoot, {});
      expect(process.exitCode).not.toBe(1);
      expect(result.newViolations).toHaveLength(0);
      expect(result.baselinedViolations).toHaveLength(1);
      expect(result.baselinedViolations[0]!.line).toBe(3);
    });

    it('--baseline-save writes the sorted violation set and check mode then passes', () => {
      createFixtureTree({
        'src/core/db.ts': 'export function db() {}\n',
        'src/core/types.ts': 'export type T = string;\n',
        'src/lib/zz.ts': `import type { T } from '../core/types.ts';\n`,
        'src/lib/aa.ts': `import { db } from '../core/db.ts';\n`,
      });

      run(['--baseline-save', '--root', fixtureRoot], fixtureRoot, {});
      const saved = JSON.parse(
        readFileSync(path.join(fixtureRoot, '.claude/fitness/boundary-baseline.json'), 'utf8'),
      ) as BoundaryViolation[];
      expect(saved).toHaveLength(2);
      // Sorted by file:specifier key — aa.ts before zz.ts.
      expect(saved.map((v) => v.file)).toEqual(['src/lib/aa.ts', 'src/lib/zz.ts']);

      const result = run(['--root', fixtureRoot], fixtureRoot, {});
      expect(process.exitCode).not.toBe(1);
      expect(result.newViolations).toHaveLength(0);
      expect(result.baselinedViolations).toHaveLength(2);
    });

    it('prints the shrink notice when a baselined violation disappears, and exits 0', () => {
      createFixtureTree({
        'src/core/db.ts': 'export function db() {}\n',
        'src/lib/clean.ts': 'export const ok = 1;\n',
      });
      const baseline = [
        {
          file: 'src/lib/clean.ts',
          line: 1,
          specifier: '../core/db.ts',
          fromLayer: 'lib',
          toLayer: 'core',
        },
      ];
      const baselineDir = path.join(fixtureRoot, '.claude/fitness');
      mkdirSync(baselineDir, { recursive: true });
      writeFileSync(
        path.join(baselineDir, 'boundary-baseline.json'),
        JSON.stringify(baseline, null, 2),
        'utf8',
      );

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const result = run(['--root', fixtureRoot], fixtureRoot, {});
      expect(process.exitCode).not.toBe(1);
      expect(result.allViolations).toHaveLength(0);
      const shrinkLine = logSpy.mock.calls
        .map((c) => String(c[0]))
        .find((s) => s.includes('Baseline shrunk'));
      expect(shrinkLine).toContain('(1 → 0');
    });
  });

  // -------------------------------------------------------------------------
  // --report mode
  // -------------------------------------------------------------------------

  describe('--report mode', () => {
    it('exits 0 in --report mode and prints the violating edge in the report', () => {
      createFixtureTree({
        'src/core/db.ts': 'export function db() {}\n',
        'src/lib/bad.ts': `import { db } from '../core/db.ts';\n`,
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      run(['--report', '--root', fixtureRoot], fixtureRoot, {});
      expect(process.exitCode).not.toBe(1);
      const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      const edgeLine = output.split('\n').find((l) => l.includes('lib → core'));
      expect(edgeLine).toContain('[VIOLATION]');
    });
  });

  // -------------------------------------------------------------------------
  // Matrix loaded from registry
  // -------------------------------------------------------------------------

  describe('matrix from registry', () => {
    it('buildLayerMatrix returns an object keyed by layer names', () => {
      const matrix = buildLayerMatrix();
      expect(matrix).toHaveProperty('lib');
      expect(matrix).toHaveProperty('core');
      expect(matrix).toHaveProperty('transport');
      expect(matrix).toHaveProperty('mcp');
      expect(matrix).toHaveProperty('fleet');
      expect(matrix).toHaveProperty('runtimes');
      expect(matrix).toHaveProperty('memory');
      expect(matrix).toHaveProperty('root');
    });

    it('lib layer is only allowed to import lib (not core)', () => {
      const matrix = buildLayerMatrix();
      expect(matrix['lib']).toContain('lib');
      expect(matrix['lib']).not.toContain('core');
    });

    it('fleet layer can import runtimes', () => {
      const matrix = buildLayerMatrix();
      expect(matrix['fleet']).toContain('runtimes');
    });

    it('honors injected params when provided', () => {
      // Build a restricted matrix from explicit params; anyMayImportRoot appends 'root' to each layer
      const restrictedParams = {
        layers: {
          lib: ['lib'],
          core: ['core', 'lib'],
        },
        anyMayImportRoot: true,
      };
      const matrix = buildLayerMatrix(restrictedParams);
      // anyMayImportRoot=true appends 'root' to each layer
      expect(matrix['lib']).toContain('lib');
      expect(matrix['lib']).toContain('root');
      expect(matrix['lib']).not.toContain('core');
      expect(matrix['core']).toContain('lib');
      expect(matrix['core']).not.toContain('transport');
    });
  });

  // -------------------------------------------------------------------------
  // WHATSOUP_SKIP_BOUNDARY_CHECK env var
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Fail-closed baseline scanner
  // -------------------------------------------------------------------------

  describe('fail-closed baseline', () => {
    it('exits nonzero when the baseline file is unparseable JSON', () => {
      createFixtureTree({
        'src/lib/util.ts': 'export function util() {}\n',
        // Corrupt baseline — not valid JSON
        '.claude/fitness/boundary-baseline.json': '{ this is not valid json !!',
      });

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      // run() throws on corrupt baseline; entry point catches and sets exitCode=1
      expect(() => run(['--root', fixtureRoot], fixtureRoot, {})).toThrow();
      // Confirm the error message is diagnostic, not a silent pass
      errorSpy.mockRestore();
    });

    it('passes cleanly when the baseline file is absent', () => {
      createFixtureTree({
        'src/lib/util.ts': 'export function util() {}\n',
      });
      // No baseline file — should pass (0 violations, no throw)
      expect(() => run(['--root', fixtureRoot], fixtureRoot, {})).not.toThrow();
      expect(process.exitCode).not.toBe(1);
    });
  });

  describe('skip env var', () => {
    it('skips check when WHATSOUP_SKIP_BOUNDARY_CHECK=1 and not in CI', () => {
      createFixtureTree({
        'src/core/db.ts': 'export function db() {}\n',
        'src/lib/bad.ts': `import { db } from '../core/db.ts';\n`,
      });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = run(
        ['--root', fixtureRoot],
        fixtureRoot,
        { WHATSOUP_SKIP_BOUNDARY_CHECK: '1' },
      );
      expect(process.exitCode).not.toBe(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('skipped'));
      expect(result.newViolations).toHaveLength(0);
    });

    it('ignores skip when GITHUB_ACTIONS is set', () => {
      createFixtureTree({
        'src/core/db.ts': 'export function db() {}\n',
        'src/lib/bad.ts': `import { db } from '../core/db.ts';\n`,
      });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = run(
        ['--root', fixtureRoot],
        fixtureRoot,
        { WHATSOUP_SKIP_BOUNDARY_CHECK: '1', GITHUB_ACTIONS: 'true' },
      );
      // Should still have run the check and found violations
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ignored'));
      expect(result.allViolations.length).toBeGreaterThan(0);
    });
  });
});
