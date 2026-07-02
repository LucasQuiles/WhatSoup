import { readdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { gitList, git, normalizeRepoPath } from './lib/guard-core.ts';

/**
 * Triage aid — compute the REQUIRED local test suites for a change, encoding
 * the merge-gate coverage invariant that CI `quality` enforces:
 *
 *   required = (functional suites referencing the changed files' modules)
 *              ∪ (ALL fitness / guard suites)
 *
 * Motivation (proven gaps):
 *   - #1507: a local resolution ran a symbol-referencing vitest subset and
 *     passed, but missed `tests/runtimes/agent/recovery-probe-validity.test.ts`
 *     — the suite most directly referencing the changed symbol — and CI failed.
 *   - #1514: a local run missed STRUCTURAL / fitness guard suites
 *     (`tests/scripts/dedup-reaccumulation-guard.test.ts`,
 *      `tests/scripts/fitness-file-size-warning-budget.test.ts`) and CI failed.
 *
 * The canonical, complete pre-merge local gate is `npm run verify:push:branch`
 * (see docs/enforcement/merge-gate.md). That chain runs the guard scripts plus a
 * FIXED enumerated subset of vitest suites — it does NOT run the full
 * `vitest run` that CI's `coverage:check` executes. Running only a
 * symbol-referencing vitest subset is therefore NOT sufficient. This script is a
 * FAST triage aid for when the full chain is too slow: it prints the minimum set
 * of suites a change must run locally so the two proven gap classes above cannot
 * recur silently. It is informational (WARN-tier): it always exits 0 and mutates
 * nothing.
 */

const TESTS_DIR = 'tests';

/**
 * A test file is a "fitness / guard" suite (the structural batch that CI runs in
 * full and that #1514 proved a subset run can miss) when EITHER:
 *   - it lives under `tests/scripts/` (the guard-script companion-test home), OR
 *   - its path basename references a fitness/guard concern (`guard`, `fitness`).
 * This is the ∪-ALL-fitness half of the invariant; it is change-independent.
 */
export function isFitnessGuardSuite(relPath: string): boolean {
  const norm = normalizeRepoPath(relPath);
  if (!norm.endsWith('.test.ts')) return false;
  if (norm.startsWith(`${TESTS_DIR}/scripts/`)) return true;
  const base = path.basename(norm);
  return /guard|fitness/.test(base);
}

/** Recursively enumerate every `*.test.ts` under `tests/` (repo-relative, sorted). */
export function enumerateTestSuites(cwd: string): string[] {
  const root = path.join(cwd, TESTS_DIR);
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
        out.push(normalizeRepoPath(path.relative(cwd, abs)));
      }
    }
  };
  walk(root);
  out.sort();
  return out;
}

/** The change-independent fitness/guard batch: every suite matching the structural rule. */
export function fitnessGuardSuites(cwd: string): string[] {
  return enumerateTestSuites(cwd).filter(isFitnessGuardSuite);
}

/**
 * Reference tokens a test file might use to import/reference a changed source
 * file: the repo-relative path without extension, and the bare basename without
 * extension. A test that mentions either in its text is treated as referencing
 * that source (the functional half of the invariant, #1507).
 */
export function referenceTokens(changedFile: string): string[] {
  const norm = normalizeRepoPath(changedFile);
  const noExt = norm.replace(/\.[cm]?tsx?$/, '');
  const base = path.basename(noExt);
  const tokens = new Set<string>();
  if (noExt) tokens.add(noExt);
  if (base) tokens.add(base);
  return [...tokens];
}

/**
 * Functional suites for a set of changed files: every test suite whose text
 * references any changed (non-test) source file's module path or basename.
 * A changed file that is itself a test suite is included directly.
 */
export function functionalSuites(cwd: string, changedFiles: string[]): string[] {
  const suites = enumerateTestSuites(cwd);
  const changedSources = changedFiles
    .map(normalizeRepoPath)
    .filter((f) => /\.[cm]?tsx?$/.test(f));

  const result = new Set<string>();

  // A changed file that IS a test suite must run.
  for (const f of changedSources) {
    if (f.endsWith('.test.ts')) result.add(f);
  }

  const nonTestSources = changedSources.filter((f) => !f.endsWith('.test.ts'));
  if (nonTestSources.length === 0) return [...result].sort();

  const tokenList = nonTestSources.flatMap(referenceTokens);
  for (const suite of suites) {
    let text: string;
    try {
      text = readFileSync(path.join(cwd, suite), 'utf8');
    } catch {
      continue;
    }
    if (tokenList.some((tok) => text.includes(tok))) {
      result.add(suite);
    }
  }
  return [...result].sort();
}

/**
 * Resolve the changed-file set: explicit non-flag args if given, else
 * `git diff --name-only <base>` (base defaults to `origin/main`).
 */
export function resolveChangedFiles(
  cwd: string,
  argv: string[],
): { changed: string[]; source: string } {
  const positional = argv.filter((a) => !a.startsWith('-'));
  if (positional.length > 0) {
    return { changed: positional.map(normalizeRepoPath), source: 'args' };
  }
  const baseIdx = argv.indexOf('--base');
  const base = baseIdx >= 0 && argv[baseIdx + 1] ? argv[baseIdx + 1] : 'origin/main';
  // Use merge-base so the diff reflects only this branch's changes.
  let range = base;
  try {
    const mergeBase = git(['merge-base', base, 'HEAD'], cwd).trim();
    if (mergeBase) range = mergeBase;
  } catch {
    // fall back to the raw base ref
  }
  const changed = gitList(['diff', '--name-only', range], cwd);
  return { changed, source: `git diff --name-only ${range}` };
}

export interface RequiredSuitesResult {
  changed: string[];
  source: string;
  functional: string[];
  fitness: string[];
  /** Union, sorted — the complete required local set. */
  required: string[];
}

export function computeRequiredSuites(cwd: string, argv: string[]): RequiredSuitesResult {
  const { changed, source } = resolveChangedFiles(cwd, argv);
  const functional = functionalSuites(cwd, changed);
  const fitness = fitnessGuardSuites(cwd);
  const required = [...new Set([...functional, ...fitness])].sort();
  return { changed, source, functional, fitness, required };
}

export function run(
  argv: string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
): RequiredSuitesResult {
  const result = computeRequiredSuites(cwd, argv);
  const jsonMode = argv.includes('--json');
  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  console.log(`# required-suites (triage aid — WARN-tier, informational)`);
  console.log(`# changed-file source: ${result.source}`);
  console.log(`# changed files: ${result.changed.length}`);
  console.log(
    `# functional suites (reference changed modules): ${result.functional.length}`,
  );
  console.log(`# fitness/guard suites (ALL, change-independent): ${result.fitness.length}`);
  console.log(
    `# required = functional ∪ fitness = ${result.required.length} suite(s).`,
  );
  console.log(
    `# NOTE: the canonical complete gate is 'npm run verify:push:branch'.`,
  );
  console.log(
    `#       This list is a fast subset-triage aid, NOT a substitute for it.`,
  );
  for (const suite of result.required) {
    console.log(suite);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run();
  } catch (err) {
    console.error((err as Error).message);
    // WARN-tier triage aid: never fail the caller's pipeline.
    process.exitCode = 0;
  }
}
