#!/usr/bin/env node --experimental-strip-types
/**
 * Phantom-dependency guard — every imported package must be declared.
 *
 * THE GAP THIS CLOSES. A package imported but never declared resolves only because something
 * else hoisted it into `node_modules`. It works here and breaks on a clean install, under a
 * different package-manager layout, or the moment the hoisting dependency stops pulling it.
 * Nothing in this repo detected that.
 *
 * EMPTY BASELINE. Measured before shipping: 1972 tracked source files, 1860 bare import
 * specifiers, ZERO phantoms. Any finding is new.
 *
 * WHY NOT ALSO "UNUSED DEPENDENCIES". Measured, and unusable here — every candidate was a
 * false positive: `pino-roll` is a pino transport TARGET STRING (src/logger.ts:40) rather
 * than an import; `better-sqlite3` is declared in the sub-package that imports it; 14
 * devDependencies are used implicitly by tooling and never appear in an import. Gating it
 * would require a ~15-entry allowlist and would catch nothing real — itself the
 * auto-institutionalised-debt shape that `guard:baseline-growth` exists to refuse.
 *
 * RESOLUTION IS PER FILE. Declarations are the union of every `package.json` from the
 * importing file's directory up to the repo root. `tools/whatsoup_guard` declares
 * `better-sqlite3` that the root does not; comparing everything against the root manifest
 * reports a phantom that is not one.
 *
 * EXIT CODES: 0 none · 1 phantom found · 2 inconclusive (nothing to scan, or a manifest
 * chain could not be read). An unscannable tree is never a pass.
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { CliArgError, assertKnownFlag, isHelpFlag, takeValue } from './lib/cli-args.ts';
import {
  type ImportSite,
  type PhantomFinding,
  findPhantomDependencies,
} from './lib/dependency-declarations.ts';

const EXIT_PASS = 0;
const EXIT_BLOCK = 1;
const EXIT_INCONCLUSIVE = 2;

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;

/**
 * Floor for the non-vacuity check. The tree held 1972 files and 1860 bare specifiers when
 * this was written; the floors sit far below that, so ordinary change never trips them but a
 * scan that enumerated nothing does.
 */
const MIN_FILES = 200;
/** Counts every import site (relative ones included), not just bare package imports. */
const MIN_IMPORT_SITES = 300;

const KNOWN_FLAGS = ['--repo', '--json', '--help', '-h'] as const;

interface Options {
  repo: string;
  json: boolean;
}

type ManifestDeclarations =
  | { state: 'absent' }
  | { state: 'readable'; declarations: Set<string> }
  | { state: 'unreadable' };

interface DeclarationResolution {
  declarations: Set<string> | null;
  unreadableManifests: string[];
}

interface ImportCollection {
  sites: ImportSite[];
  unreadableFiles: string[];
}

function parseOptions(argv: readonly string[]): Options | 'help' {
  const options: Options = { repo: defaultRepoRoot, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (isHelpFlag(arg)) return 'help';
    assertKnownFlag(arg, KNOWN_FLAGS);
    if (arg === '--repo') {
      const taken = takeValue(argv, i);
      options.repo = resolve(taken.value);
      i = taken.index;
    } else if (arg === '--json') {
      options.json = true;
    }
  }
  return options;
}

/** Escape control and formatting characters that can reshape or visually reorder output. */
function escapeUnsafeUnicode(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => {
    let escaped = '';
    for (let index = 0; index < character.length; index++) {
      escaped += `\\u${character.charCodeAt(index).toString(16).padStart(4, '0')}`;
    }
    return escaped;
  });
}

function safeScalar(value: string): string {
  return escapeUnsafeUnicode(JSON.stringify(value).slice(1, -1));
}

function safeJson(value: unknown): string {
  return escapeUnsafeUnicode(JSON.stringify(value));
}

/** Require an in-repository regular file with no symlinked ancestor below the repo root. */
function isRegularRepoFile(repoRoot: string, file: string): boolean {
  const repoRelative = relative(repoRoot, file);
  if (
    repoRelative.length === 0 ||
    repoRelative === '..' ||
    repoRelative.startsWith(`..${sep}`) ||
    isAbsolute(repoRelative)
  ) {
    return false;
  }

  const components = repoRelative.split(sep);
  let current = repoRoot;
  for (let index = 0; index < components.length; index++) {
    current = join(current, components[index]!);
    const stat = lstatSync(current);
    if (index === components.length - 1 ? !stat.isFile() : !stat.isDirectory()) return false;
  }
  return true;
}

/** Distinguish an absent manifest from one that exists but cannot be trusted. */
function declaredAt(
  dir: string,
  repoRoot: string,
  cache: Map<string, ManifestDeclarations>,
): ManifestDeclarations {
  const cached = cache.get(dir);
  if (cached !== undefined) return cached;

  const manifest = join(dir, 'package.json');
  let result: ManifestDeclarations;
  try {
    if (!isRegularRepoFile(repoRoot, manifest)) {
      result = { state: 'unreadable' };
      cache.set(dir, result);
      return result;
    }
  } catch (error) {
    result =
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? { state: 'absent' }
        : { state: 'unreadable' };
    cache.set(dir, result);
    return result;
  }

  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as Record<
      string,
      Record<string, string> | undefined
    >;
    result = {
      state: 'readable',
      declarations: new Set([
        ...Object.keys(parsed.dependencies ?? {}),
        ...Object.keys(parsed.devDependencies ?? {}),
        ...Object.keys(parsed.optionalDependencies ?? {}),
        ...Object.keys(parsed.peerDependencies ?? {}),
      ]),
    };
  } catch {
    result = { state: 'unreadable' };
  }
  cache.set(dir, result);
  return result;
}

/**
 * Union of declarations from the file's directory up to the repo root.
 *
 * Separately reports an unreadable manifest and a chain with no manifest. Both are
 * inconclusive, while absent intermediate manifests remain valid.
 */
function declaredFor(
  file: string,
  repoRoot: string,
  cache: Map<string, ManifestDeclarations>,
): DeclarationResolution {
  const union = new Set<string>();
  const unreadableManifests: string[] = [];
  let found = false;
  let dir = dirname(resolve(repoRoot, file));

  for (;;) {
    const manifest = declaredAt(dir, repoRoot, cache);
    if (manifest.state === 'readable') {
      found = true;
      for (const name of manifest.declarations) union.add(name);
    } else if (manifest.state === 'unreadable') {
      unreadableManifests.push(relative(repoRoot, join(dir, 'package.json')));
    }
    if (dir === repoRoot || dir === dirname(dir)) break;
    dir = dirname(dir);
  }
  return {
    declarations: unreadableManifests.length === 0 && found ? union : null,
    unreadableManifests,
  };
}

function collectImportSites(repoRoot: string, files: readonly string[]): ImportCollection {
  const sites: ImportSite[] = [];
  const unreadableFiles: string[] = [];
  for (const file of files) {
    let text: string;
    try {
      const source = join(repoRoot, file);
      if (!isRegularRepoFile(repoRoot, source)) {
        unreadableFiles.push(file);
        continue;
      }
      text = readFileSync(source, 'utf8');
    } catch {
      unreadableFiles.push(file);
      continue;
    }
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

    const visit = (node: ts.Node): void => {
      let specifier: ts.Expression | undefined;
      if (ts.isImportDeclaration(node)) specifier = node.moduleSpecifier;
      else if (ts.isExportDeclaration(node) && node.moduleSpecifier) specifier = node.moduleSpecifier;
      else if (node.kind === ts.SyntaxKind.CallExpression) {
        const call = node as ts.CallExpression;
        const isDynamicImport = call.expression.kind === ts.SyntaxKind.ImportKeyword;
        const isRequire = ts.isIdentifier(call.expression) && call.expression.text === 'require';
        if ((isDynamicImport || isRequire) && call.arguments[0]) specifier = call.arguments[0];
      }
      if (specifier && ts.isStringLiteral(specifier)) {
        sites.push({ file, specifier: specifier.text });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return { sites, unreadableFiles };
}

function main(): number {
  let options: Options | 'help';
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    if (error instanceof CliArgError) {
      console.error(`FAIL(usage): ${error.message}`);
      return EXIT_INCONCLUSIVE;
    }
    throw error;
  }

  if (options === 'help') {
    console.log(
      'Usage: phantom-dependency-guard.ts [--repo <path>] [--json]\n\n' +
        'Refuses an import of a package that no package.json from the importing file up to\n' +
        'the repo root declares. Exit 0 = none, 1 = phantom found, 2 = inconclusive.',
    );
    return EXIT_PASS;
  }

  const repoRoot = options.repo;
  let files: string[];
  try {
    files = execFileSync('git', ['ls-files', '-z'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\0')
      .filter((file) => SOURCE_FILE.test(file));
  } catch {
    console.error(
      'FAIL(inconclusive): could not list tracked source files. A tree that could not be ' +
        'enumerated contains no phantoms trivially, which is not a pass.',
    );
    return EXIT_INCONCLUSIVE;
  }

  const { sites, unreadableFiles } = collectImportSites(repoRoot, files);

  if (unreadableFiles.length > 0) {
    if (options.json) {
      console.log(
        safeJson({
          files: files.length,
          importSites: sites.length,
          phantoms: [],
          unverifiable: [],
          unreadableFiles,
          unreadableManifests: [],
        }),
      );
    } else {
      console.error(
        `FAIL(inconclusive): ${unreadableFiles.length} tracked source file(s) could not be ` +
          'read, so the import set is incomplete:',
      );
      for (const file of unreadableFiles) console.error(`  ${safeScalar(file)}`);
    }
    return EXIT_INCONCLUSIVE;
  }

  if (files.length < MIN_FILES || sites.length < MIN_IMPORT_SITES) {
    console.error(
      `FAIL(inconclusive): scan is implausibly small (${files.length} file(s), ` +
        `${sites.length} import site(s); floors are ${MIN_FILES}/${MIN_IMPORT_SITES}). ` +
        'A scan that examined almost nothing finds no phantoms trivially.',
    );
    return EXIT_INCONCLUSIVE;
  }

  const cache = new Map<string, ManifestDeclarations>();
  const declaredByFile = new Map<string, ReadonlySet<string>>();
  const unreadableManifests = new Set<string>();
  for (const file of new Set(sites.map((site) => site.file))) {
    const resolution = declaredFor(file, repoRoot, cache);
    for (const manifest of resolution.unreadableManifests) unreadableManifests.add(manifest);
    if (resolution.declarations) declaredByFile.set(file, resolution.declarations);
  }

  if (unreadableManifests.size > 0) {
    const manifests = [...unreadableManifests].sort();
    if (options.json) {
      console.log(
        safeJson({
          files: files.length,
          importSites: sites.length,
          phantoms: [],
          unverifiable: [],
          unreadableFiles: [],
          unreadableManifests: manifests,
        }),
      );
    } else {
      console.error(
        `FAIL(inconclusive): ${manifests.length} package.json file(s) in an importer's ` +
          'declaration chain could not be read or parsed:',
      );
      for (const manifest of manifests) console.error(`  ${safeScalar(manifest)}`);
    }
    return EXIT_INCONCLUSIVE;
  }

  const findings: PhantomFinding[] = findPhantomDependencies(sites, declaredByFile);
  const unverifiable = findings.filter((finding) => finding.unverifiable);
  const phantoms = findings.filter((finding) => !finding.unverifiable);

  if (options.json) {
    console.log(
      safeJson({ files: files.length, importSites: sites.length, phantoms, unverifiable }),
    );
  }

  if (unverifiable.length > 0) {
    if (!options.json) {
      console.error(
        `FAIL(inconclusive): ${unverifiable.length} package(s) imported from files with no ` +
          'readable package.json anywhere up to the repo root, so their declaration could not ' +
          'be checked:',
      );
      for (const finding of unverifiable) {
        console.error(
          `  ${safeScalar(finding.packageName)} — e.g. ${safeScalar(finding.files[0]!)}`,
        );
      }
    }
    return EXIT_INCONCLUSIVE;
  }

  if (phantoms.length > 0) {
    if (!options.json) {
      console.error(`FAIL(phantom-dependency): ${phantoms.length} undeclared package(s):`);
      for (const finding of phantoms) {
        console.error(
          `\n  ${safeScalar(finding.packageName)} — imported by ${finding.files.length} file(s):`,
        );
        for (const file of finding.files.slice(0, 5)) console.error(`    ${safeScalar(file)}`);
      }
      console.error(
        '\nThese resolve today only because something else hoisted them into node_modules; ' +
          'they break on a clean install. Add each to the dependencies of the nearest ' +
          'package.json, or drop the import.\nReproduce:\n' +
          '  ./scripts/run-with-pinned-node.sh scripts/phantom-dependency-guard.ts --json',
      );
    }
    return EXIT_BLOCK;
  }

  if (!options.json) {
    console.log(
      `OK: every imported package is declared — ${sites.length} import site(s) across ` +
        `${files.length} tracked source file(s).`,
    );
  }
  return EXIT_PASS;
}

process.exit(main());
