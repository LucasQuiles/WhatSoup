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
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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

/** Dependency names declared by one `package.json`, or `null` if it is absent/unreadable. */
function declaredAt(dir: string, cache: Map<string, Set<string> | null>): Set<string> | null {
  const cached = cache.get(dir);
  if (cached !== undefined) return cached;

  const manifest = join(dir, 'package.json');
  let result: Set<string> | null = null;
  if (existsSync(manifest)) {
    try {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as Record<
        string,
        Record<string, string> | undefined
      >;
      result = new Set([
        ...Object.keys(parsed.dependencies ?? {}),
        ...Object.keys(parsed.devDependencies ?? {}),
        ...Object.keys(parsed.optionalDependencies ?? {}),
        ...Object.keys(parsed.peerDependencies ?? {}),
      ]);
    } catch {
      result = null; // unreadable manifest -> unverifiable, never "declares nothing"
    }
  }
  cache.set(dir, result);
  return result;
}

/**
 * Union of declarations from the file's directory up to the repo root.
 *
 * Returns `null` when NO manifest was found anywhere in the chain — that is "could not
 * check", which the caller reports as INCONCLUSIVE rather than as a clean file.
 */
function declaredFor(
  file: string,
  repoRoot: string,
  cache: Map<string, Set<string> | null>,
): Set<string> | null {
  const union = new Set<string>();
  let found = false;
  let dir = dirname(resolve(repoRoot, file));

  for (;;) {
    const declared = declaredAt(dir, cache);
    if (declared) {
      found = true;
      for (const name of declared) union.add(name);
    }
    if (dir === repoRoot || dir === dirname(dir)) break;
    dir = dirname(dir);
  }
  return found ? union : null;
}

function collectImportSites(repoRoot: string, files: readonly string[]): ImportSite[] {
  const sites: ImportSite[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(repoRoot, file), 'utf8');
    } catch {
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
  return sites;
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
    files = execFileSync('git', ['ls-files'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\n')
      .filter((file) => SOURCE_FILE.test(file) && !file.includes('node_modules'));
  } catch (error) {
    console.error(
      `FAIL(inconclusive): could not list tracked files in ${repoRoot} — ` +
        `${error instanceof Error ? error.message : String(error)}. A tree that could not be ` +
        'enumerated contains no phantoms trivially, which is not a pass.',
    );
    return EXIT_INCONCLUSIVE;
  }

  const sites = collectImportSites(repoRoot, files);

  if (files.length < MIN_FILES || sites.length < MIN_IMPORT_SITES) {
    console.error(
      `FAIL(inconclusive): scan is implausibly small (${files.length} file(s), ` +
        `${sites.length} import site(s); floors are ${MIN_FILES}/${MIN_IMPORT_SITES}). ` +
        'A scan that examined almost nothing finds no phantoms trivially.',
    );
    return EXIT_INCONCLUSIVE;
  }

  const cache = new Map<string, Set<string> | null>();
  const declaredByFile = new Map<string, ReadonlySet<string>>();
  for (const file of new Set(sites.map((site) => site.file))) {
    const declared = declaredFor(file, repoRoot, cache);
    if (declared) declaredByFile.set(file, declared);
  }

  const findings: PhantomFinding[] = findPhantomDependencies(sites, declaredByFile);
  const unverifiable = findings.filter((finding) => finding.unverifiable);
  const phantoms = findings.filter((finding) => !finding.unverifiable);

  if (options.json) {
    console.log(
      JSON.stringify(
        { files: files.length, importSites: sites.length, phantoms, unverifiable },
        null,
        2,
      ),
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
        console.error(`  ${finding.packageName} — e.g. ${finding.files[0]}`);
      }
    }
    return EXIT_INCONCLUSIVE;
  }

  if (phantoms.length > 0) {
    if (!options.json) {
      console.error(`FAIL(phantom-dependency): ${phantoms.length} undeclared package(s):`);
      for (const finding of phantoms) {
        console.error(`\n  ${finding.packageName} — imported by ${finding.files.length} file(s):`);
        for (const file of finding.files.slice(0, 5)) console.error(`    ${file}`);
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
