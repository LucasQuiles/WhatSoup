#!/usr/bin/env node --experimental-strip-types
/**
 * Import-cycle guard — no runtime import cycles in `src/`.
 *
 * THE GAP THIS CLOSES. `guard:boundaries` checks import DIRECTION (which layer may import
 * which). Nothing checked for CYCLES. Verified on origin/main `f3bda5941`: the only
 * `cyclic` matches under `scripts/` and `tests/` are unrelated (cyclic object references in
 * fixtures, cyclic error-cause chains).
 *
 * EMPTY BASELINE, AND WHY THAT IS SAFE. Measured before this shipped: 433 modules, 1176
 * runtime edges, ZERO cycles. So the guard is green on arrival with no baselined debt and
 * no ratchet — any cycle it reports is new. A regex prototype had claimed 3 cycles; all
 * three came from counting `import type` edges, which TypeScript ERASES at runtime and
 * which therefore cannot participate in a runtime cycle. This guard resolves modules
 * through the TypeScript compiler and skips type-only imports for exactly that reason.
 *
 * NON-VACUITY IS ENFORCED, not assumed. A graph that failed to build, or whose specifiers
 * failed to resolve, would trivially contain no cycles — the classic false green. If any
 * relative specifier fails to resolve, or the graph is implausibly small, the guard exits
 * INCONCLUSIVE rather than reporting success.
 *
 * EXIT CODES: 0 no cycles · 1 cycles found · 2 inconclusive (could not build a trustworthy
 * graph). "Could not look" is never "nothing there".
 */
import { existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { CliArgError, assertKnownFlag, isHelpFlag, takeValue } from './lib/cli-args.ts';
import { type ModuleGraph, findCycles } from './lib/module-cycles.ts';

const EXIT_PASS = 0;
const EXIT_BLOCK = 1;
const EXIT_INCONCLUSIVE = 2;

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Floor for the non-vacuity check. `src/` held 433 modules and 1176 runtime edges when this
 * guard was written; these floors are deliberately far below that, so ordinary refactors
 * never trip them but a graph that silently failed to build does.
 */
const MIN_MODULES = 100;
const MIN_EDGES = 200;

const KNOWN_FLAGS = ['--repo', '--scope', '--json', '--help', '-h'] as const;

interface Options {
  repo: string;
  /** Directory scanned, repo-relative. Default `src`. */
  scope: string;
  json: boolean;
}

function parseOptions(argv: readonly string[]): Options | 'help' {
  const options: Options = { repo: defaultRepoRoot, scope: 'src', json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (isHelpFlag(arg)) return 'help';
    assertKnownFlag(arg, KNOWN_FLAGS);
    if (arg === '--repo') {
      const taken = takeValue(argv, i);
      options.repo = resolve(taken.value);
      i = taken.index;
    } else if (arg === '--scope') {
      const taken = takeValue(argv, i);
      options.scope = taken.value.replace(/\/+$/, '');
      i = taken.index;
    } else if (arg === '--json') {
      options.json = true;
    }
  }
  return options;
}

interface BuildResult {
  graph: ModuleGraph;
  moduleCount: number;
  edgeCount: number;
  /** Relative specifiers the compiler could not resolve — each one is a hole in the graph. */
  unresolved: string[];
  typeOnlySkipped: number;
}

function buildGraph(repoRoot: string, scope: string): BuildResult | { error: string } {
  const configPath = ts.findConfigFile(repoRoot, ts.sys.fileExists, 'tsconfig.json');
  if (!configPath) return { error: `no tsconfig.json found under ${repoRoot}` };

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    return { error: `tsconfig.json could not be read: ${configFile.error.messageText}` };
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repoRoot);
  const program = ts.createProgram(parsed.fileNames, parsed.options);

  const scopePrefix = `${resolve(repoRoot, scope)}/`;
  if (!existsSync(resolve(repoRoot, scope))) {
    return { error: `scope directory ${scope} does not exist under ${repoRoot}` };
  }

  const graph = new Map<string, Set<string>>();
  const unresolved: string[] = [];
  let typeOnlySkipped = 0;

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (!sourceFile.fileName.startsWith(scopePrefix)) continue;

    const from = relative(repoRoot, sourceFile.fileName);
    const out = graph.get(from) ?? new Set<string>();
    graph.set(from, out);

    for (const statement of sourceFile.statements) {
      let specifier: ts.Expression | undefined;

      // RUNTIME edges only. `import type` / `export type` are erased by the compiler and
      // cannot close a runtime cycle — counting them is precisely what made an earlier
      // regex prototype report three cycles that do not exist.
      if (ts.isImportDeclaration(statement)) {
        if (statement.importClause?.isTypeOnly) {
          typeOnlySkipped += 1;
          continue;
        }
        specifier = statement.moduleSpecifier;
      } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
        if (statement.isTypeOnly) {
          typeOnlySkipped += 1;
          continue;
        }
        specifier = statement.moduleSpecifier;
      }

      if (!specifier || !ts.isStringLiteral(specifier)) continue;
      if (!specifier.text.startsWith('.')) continue;

      const resolvedModule = ts.resolveModuleName(
        specifier.text,
        sourceFile.fileName,
        parsed.options,
        ts.sys,
      ).resolvedModule;

      if (!resolvedModule) {
        unresolved.push(`${from} -> ${specifier.text}`);
        continue;
      }
      if (resolvedModule.resolvedFileName.endsWith('.d.ts')) continue;

      const target = resolve(repoRoot, resolvedModule.resolvedFileName);
      if (!target.startsWith(scopePrefix)) continue;
      out.add(relative(repoRoot, target));
    }
  }

  const edgeCount = [...graph.values()].reduce((total, set) => total + set.size, 0);
  return { graph, moduleCount: graph.size, edgeCount, unresolved, typeOnlySkipped };
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
      'Usage: import-cycle-guard.ts [--repo <path>] [--scope <dir>] [--json]\n\n' +
        'Refuses runtime import cycles. Exit 0 = none, 1 = cycles found, 2 = inconclusive.',
    );
    return EXIT_PASS;
  }

  const built = buildGraph(options.repo, options.scope);
  if ('error' in built) {
    console.error(
      `FAIL(inconclusive): could not build the module graph — ${built.error}. ` +
        'A graph that did not build contains no cycles trivially, which is not a pass.',
    );
    return EXIT_INCONCLUSIVE;
  }

  const { graph, moduleCount, edgeCount, unresolved, typeOnlySkipped } = built;

  // A hole in the graph can hide a cycle that runs through it, so an unresolved specifier
  // makes the whole answer untrustworthy rather than merely incomplete.
  if (unresolved.length > 0) {
    console.error(
      `FAIL(inconclusive): ${unresolved.length} relative import(s) did not resolve, so the ` +
        'graph has holes and a cycle through them would be invisible:\n  ' +
        unresolved.slice(0, 10).join('\n  '),
    );
    return EXIT_INCONCLUSIVE;
  }

  if (moduleCount < MIN_MODULES || edgeCount < MIN_EDGES) {
    console.error(
      `FAIL(inconclusive): graph is implausibly small (${moduleCount} modules, ${edgeCount} ` +
        `edges; floors are ${MIN_MODULES}/${MIN_EDGES}). An empty scan finds no cycles ` +
        'trivially. If the tree genuinely shrank this much, lower the floors deliberately.',
    );
    return EXIT_INCONCLUSIVE;
  }

  const cycles = findCycles(graph);

  if (options.json) {
    console.log(JSON.stringify({ moduleCount, edgeCount, typeOnlySkipped, cycles }, null, 2));
  }

  if (cycles.length > 0) {
    if (!options.json) {
      console.error(`FAIL(import-cycle): ${cycles.length} runtime import cycle(s) in ${options.scope}/:`);
      for (const cycle of cycles) {
        console.error(`\n  cycle of ${cycle.length}:`);
        for (const member of cycle) console.error(`    ${member}`);
      }
      console.error(
        '\nBreak the cycle by extracting the shared piece into a module both sides import, ' +
          'or by inverting one dependency. If the edge is types-only, `import type` makes it ' +
          'disappear at runtime and this guard stops seeing it.\nReproduce:\n' +
          '  ./scripts/run-with-pinned-node.sh scripts/import-cycle-guard.ts --json',
      );
    }
    return EXIT_BLOCK;
  }

  if (!options.json) {
    console.log(
      `OK: no runtime import cycles across ${moduleCount} module(s) and ${edgeCount} edge(s) ` +
        `in ${options.scope}/ (${typeOnlySkipped} type-only import(s) correctly excluded).`,
    );
  }
  return EXIT_PASS;
}

process.exit(main());
