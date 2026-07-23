/**
 * Phantom-dependency rules — the pure half of the guard.
 *
 * A PHANTOM dependency is a package a file imports but that nothing declares. It works
 * locally only because some other package hoisted it into `node_modules`, and it breaks on a
 * clean install or under a different install layout. Nothing in this repo detected them.
 *
 * WHY THIS RULE AND NOT "UNUSED DEPENDENCIES". Both were measured on `9dbd15795` before
 * choosing. Unused-dependency detection is unusable here — every candidate it produced was a
 * false positive:
 *   - `pino-roll` is referenced as a pino TRANSPORT TARGET STRING (`target: 'pino-roll'`,
 *     src/logger.ts:40), never imported
 *   - `better-sqlite3` is declared in `tools/whatsoup_guard/package.json`, the sub-package
 *     that imports it — only a root-only comparison calls it undeclared
 *   - 14 devDependencies (`@types/*`, `globals`, `typescript-eslint`, `@vitest/coverage-v8`,
 *     `tailwindcss`, …) are used implicitly by tooling and never appear in an import
 * Gating on that would need a ~15-entry allowlist and would catch nothing real — which is
 * itself the auto-institutionalised-debt shape. Phantom detection has the opposite profile:
 * mechanical, and measured at ZERO across 1972 files / 1860 bare specifiers.
 */
import { describe, expect, it } from 'vitest';

import {
  type ImportSite,
  findPhantomDependencies,
  packageOfSpecifier,
} from '../../scripts/lib/dependency-declarations.ts';

describe('packageOfSpecifier', () => {
  it('returns the package name for a plain specifier', () => {
    expect(packageOfSpecifier('pino')).toBe('pino');
    expect(packageOfSpecifier('pino/file')).toBe('pino');
  });

  it('keeps both segments of a scoped package', () => {
    expect(packageOfSpecifier('@scope/name')).toBe('@scope/name');
    expect(packageOfSpecifier('@scope/name/deep/path')).toBe('@scope/name');
  });

  it('returns null for relative and absolute specifiers', () => {
    expect(packageOfSpecifier('./local.ts')).toBeNull();
    expect(packageOfSpecifier('../up.ts')).toBeNull();
    expect(packageOfSpecifier('/abs/path.ts')).toBeNull();
  });

  it('returns null for node builtins, with and without the node: prefix', () => {
    // `import { readFileSync } from 'fs'` is a builtin, NOT an undeclared package. Treating
    // the un-prefixed spelling as a phantom is a false positive a naive check will produce.
    expect(packageOfSpecifier('node:fs')).toBeNull();
    expect(packageOfSpecifier('fs')).toBeNull();
    expect(packageOfSpecifier('node:child_process')).toBeNull();
    expect(packageOfSpecifier('path')).toBeNull();
  });

  it('does not mistake a package that merely starts like a builtin', () => {
    expect(packageOfSpecifier('fs-extra')).toBe('fs-extra');
    expect(packageOfSpecifier('path-to-regexp')).toBe('path-to-regexp');
  });
});

describe('findPhantomDependencies', () => {
  const declared = (entries: Record<string, string[]>) =>
    new Map(Object.entries(entries).map(([k, v]) => [k, new Set(v)]));

  it('finds an import of a package nothing declares', () => {
    const sites: ImportSite[] = [{ file: 'src/a.ts', specifier: 'left-pad' }];
    const found = findPhantomDependencies(sites, declared({ 'src/a.ts': ['pino'] }));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ packageName: 'left-pad' });
    expect(found[0]!.files).toEqual(['src/a.ts']);
  });

  it('accepts a package declared for that file', () => {
    const sites: ImportSite[] = [{ file: 'src/a.ts', specifier: 'pino/file' }];
    expect(findPhantomDependencies(sites, declared({ 'src/a.ts': ['pino'] }))).toEqual([]);
  });

  it('is per-file: a sub-package may declare what the root does not', () => {
    // tools/whatsoup_guard declares better-sqlite3; the root does not. Comparing every file
    // against the ROOT manifest reports a phantom that is not one — the exact false positive
    // that made the first recon pass wrong.
    const sites: ImportSite[] = [
      { file: 'tools/whatsoup_guard/tests/x.test.ts', specifier: 'better-sqlite3' },
      { file: 'src/db.ts', specifier: 'better-sqlite3' },
    ];
    const found = findPhantomDependencies(
      sites,
      declared({ 'tools/whatsoup_guard/tests/x.test.ts': ['better-sqlite3'], 'src/db.ts': [] }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.files).toEqual(['src/db.ts']);
  });

  it('groups every importing file under one finding, sorted', () => {
    const sites: ImportSite[] = [
      { file: 'src/z.ts', specifier: 'ghost' },
      { file: 'src/a.ts', specifier: 'ghost' },
      { file: 'src/a.ts', specifier: 'ghost/sub' },
    ];
    const found = findPhantomDependencies(sites, declared({ 'src/z.ts': [], 'src/a.ts': [] }));
    expect(found).toHaveLength(1);
    expect(found[0]!.files).toEqual(['src/a.ts', 'src/z.ts']);
  });

  it('ignores relative, absolute and builtin specifiers entirely', () => {
    const sites: ImportSite[] = [
      { file: 'src/a.ts', specifier: './x.ts' },
      { file: 'src/a.ts', specifier: 'node:fs' },
      { file: 'src/a.ts', specifier: 'fs' },
      { file: 'src/a.ts', specifier: '/tmp/x.ts' },
    ];
    expect(findPhantomDependencies(sites, declared({ 'src/a.ts': [] }))).toEqual([]);
  });

  it('treats a file with NO known declaration set as unverifiable, not as clean', () => {
    // Missing entry means the manifest chain could not be read. Reporting no phantom there
    // would be a false green; the finding is flagged unverifiable so the caller can refuse.
    const sites: ImportSite[] = [{ file: 'src/a.ts', specifier: 'ghost' }];
    const found = findPhantomDependencies(sites, new Map());
    expect(found).toHaveLength(1);
    expect(found[0]!.unverifiable).toBe(true);
  });

  it('returns findings sorted by package name for stable output', () => {
    const sites: ImportSite[] = [
      { file: 'src/a.ts', specifier: 'zeta' },
      { file: 'src/a.ts', specifier: 'alpha' },
    ];
    const found = findPhantomDependencies(sites, declared({ 'src/a.ts': [] }));
    expect(found.map((f) => f.packageName)).toEqual(['alpha', 'zeta']);
  });
});
