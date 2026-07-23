/**
 * Phantom-dependency rules: a bare import whose package nothing declares.
 *
 * WHY THIS EXISTS. A package imported but never declared resolves only because something
 * else hoisted it into `node_modules`. It works on this machine and breaks on a clean
 * install, on a different package-manager layout, or the moment the hoisting dependency
 * drops it. Nothing in this repo detected that.
 *
 * WHY NOT "UNUSED DEPENDENCIES" INSTEAD. Both were measured on `9dbd15795` before choosing.
 * Unused-dependency detection is unusable here — every candidate was a false positive:
 * `pino-roll` is referenced as a pino transport TARGET STRING rather than imported;
 * `better-sqlite3` is declared in the sub-package that imports it; and 14 devDependencies
 * (`@types/*`, `globals`, `typescript-eslint`, `@vitest/coverage-v8`, `tailwindcss`, …) are
 * used implicitly by tooling and never appear in an import. Gating that would need a
 * ~15-entry allowlist and catch nothing real. Phantom detection is mechanical, and measured
 * at ZERO across 1972 files / 1860 bare specifiers — so the guard ships with an empty
 * baseline and any finding is new.
 *
 * PURE by design: no fs, no ts, no process. Declaration sets are resolved by the caller and
 * handed in, which is what makes the per-file (sub-package) rule testable.
 */
import { builtinModules } from 'node:module';

/** Node builtins in both spellings. `import … from 'fs'` is a builtin, not a phantom. */
const BUILTINS: ReadonlySet<string> = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

/**
 * The package a specifier belongs to, or `null` when it is not a package import at all.
 *
 * `null` for relative/absolute paths and for builtins. Scoped packages keep two segments:
 * `@scope/name/deep` belongs to `@scope/name`, not to `@scope`.
 */
export function packageOfSpecifier(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null;
  if (BUILTINS.has(specifier)) return null;

  const segments = specifier.split('/');
  const name = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : (segments[0] ?? '');
  if (name === '') return null;
  // Guard the subpath spelling too (`fs/promises`), while leaving `fs-extra` alone.
  if (BUILTINS.has(name)) return null;
  return name;
}

export interface ImportSite {
  /** Repo-relative path of the importing file. */
  file: string;
  specifier: string;
}

export interface PhantomFinding {
  packageName: string;
  /** Every file importing it, sorted. */
  files: string[];
  /**
   * True when the importing file had NO resolved declaration set — the manifest chain could
   * not be read. Distinguished from a genuine phantom because "could not check" and
   * "checked and it is missing" call for different outcomes; the caller maps this to
   * INCONCLUSIVE rather than to a block.
   */
  unverifiable: boolean;
}

/**
 * Every package imported without being declared for the importing file.
 *
 * `declaredByFile` maps a file to the union of dependency names declared by every
 * `package.json` from that file's directory up to the repo root. Resolution is PER FILE, not
 * against the root manifest: `tools/whatsoup_guard` legitimately declares `better-sqlite3`
 * that the root does not, and a root-only comparison reports it as a phantom when it is not.
 * That was a real false positive in the first recon pass over this repo.
 */
export function findPhantomDependencies(
  sites: readonly ImportSite[],
  declaredByFile: ReadonlyMap<string, ReadonlySet<string>>,
): PhantomFinding[] {
  const byPackage = new Map<string, { files: Set<string>; unverifiable: boolean }>();

  for (const site of sites) {
    const packageName = packageOfSpecifier(site.specifier);
    if (packageName === null) continue;

    const declared = declaredByFile.get(site.file);
    if (declared?.has(packageName)) continue;

    const entry = byPackage.get(packageName) ?? { files: new Set<string>(), unverifiable: false };
    entry.files.add(site.file);
    if (declared === undefined) entry.unverifiable = true;
    byPackage.set(packageName, entry);
  }

  return [...byPackage.entries()]
    .map(([packageName, entry]) => ({
      packageName,
      files: [...entry.files].sort(),
      unverifiable: entry.unverifiable,
    }))
    .sort((a, b) => a.packageName.localeCompare(b.packageName));
}
