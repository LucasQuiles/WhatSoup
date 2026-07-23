/**
 * guard:lint:src — the ESLint fitness ring runner.
 *
 * Runs ESLint over src/, scripts/, and tests/ using the registry-derived
 * `eslint.config.fitness.mjs`, then reports findings in the GuardIssue shape used
 * by the other repo guards (scripts/repo-hygiene-guard.ts).
 *
 * Exit semantics (the whole point of a wrapper rather than bare `eslint`):
 *   - Fitness-ring rules are all `warn`, so warnings DO NOT fail the
 *     guard — they print and exit 0 (visibility without blocking).
 *   - ESLint *errors* (a rule configured to error, a parser fatal, a config load
 *     failure) DO fail the guard (process.exitCode = 1). A scanner that swallowed
 *     its own failure would itself be a fail-open guard — so config/runtime
 *     failures are surfaced, never downcast to a warning.
 *
 * Escape hatch: WHATSOUP_SKIP_ESLINT_FITNESS=1 skips locally but is ignored in
 * CI (matches the doc-drift / public-surface-drift idiom).
 */

import { ESLint } from 'eslint';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface GuardIssue {
  code: string;
  message: string;
  filePath?: string;
  line?: number;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface RunResult {
  issues: GuardIssue[];
  warningCount: number;
  errorCount: number;
  fatal: boolean;
  /** How many files ESLint actually linted. Zero means the globs matched nothing —
   *  `errorOnUnmatchedPattern: false` turns that into a silent clean pass unless refused. */
  filesLinted: number;
}

/**
 * Lint the fitness-ring globs and collect findings. Separated from the CLI
 * wrapper so tests can call it directly.
 */
export async function runEslintFitness(cwd: string = repoRoot): Promise<RunResult> {
  const eslint = new ESLint({
    cwd,
    overrideConfigFile: path.join(cwd, 'eslint.config.fitness.mjs'),
    errorOnUnmatchedPattern: false,
  });

  const results = await eslint.lintFiles([
    'src/**/*.ts',
    'scripts/**/*.ts',
    'tests/**/*.ts',
  ]);

  const issues: GuardIssue[] = [];
  let warningCount = 0;
  let errorCount = 0;
  let fatal = false;

  for (const result of results) {
    const rel = path.relative(cwd, result.filePath);
    for (const m of result.messages) {
      if (m.fatal) fatal = true;
      if (m.severity === 2) errorCount += 1;
      else if (m.severity === 1) warningCount += 1;
      issues.push({
        code: m.ruleId ?? (m.fatal ? 'parse-error' : 'unknown'),
        message: m.message,
        filePath: rel,
        line: m.line,
      });
    }
  }

  return { issues, warningCount, errorCount, fatal, filesLinted: results.length };
}

function printIssues(issues: GuardIssue[]): void {
  for (const issue of issues) {
    const loc = issue.filePath ? `${issue.filePath}:${issue.line ?? 0}` : '';
    console.error(`${loc} ${issue.code}: ${issue.message}`);
  }
}

export async function run(
  _argv: string[] = process.argv.slice(2),
  cwd: string = repoRoot,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (env.WHATSOUP_SKIP_ESLINT_FITNESS === '1') {
    const inCi = env.CI === 'true' || Boolean(env.GITHUB_ACTIONS);
    if (inCi) {
      console.warn(
        'WHATSOUP_SKIP_ESLINT_FITNESS=1 ignored: CI/GITHUB_ACTIONS detected; eslint fitness ring will run (this skip is for local dev only)',
      );
    } else {
      console.warn('eslint fitness ring skipped via WHATSOUP_SKIP_ESLINT_FITNESS=1');
      return;
    }
  }

  let result: RunResult;
  try {
    result = await runEslintFitness(cwd);
  } catch (err) {
    // Config load / ESLint construction failure — fail closed, never silent.
    console.error(`eslint fitness ring FAILED to run: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  // Non-vacuity floor. `errorOnUnmatchedPattern: false` means globs that match nothing yield
  // zero results and a clean pass — a scan that examined no files. A guard that certifies an
  // empty tree is a fail-open guard, the same class refused across the #2102 guards.
  if (result.filesLinted === 0) {
    console.error(
      'eslint fitness ring: INCONCLUSIVE — ESLint matched 0 files under the fitness globs ' +
        '(src/, scripts/, tests/). A ring that linted no files finds no errors trivially, which is not a pass.',
    );
    process.exitCode = 2;
    return;
  }

  if (result.issues.length > 0) {
    printIssues(result.issues);
  }

  const summary = `eslint fitness ring: ${result.warningCount} warning(s), ${result.errorCount} error(s), ${result.filesLinted} file(s) linted`;

  // Errors (configured-error rules or parser fatals) fail the guard. Warnings do
  // not — they are the intended visible-but-non-blocking signal.
  if (result.errorCount > 0 || result.fatal) {
    console.error(`${summary} — FAILED (errors present)`);
    process.exitCode = 1;
    return;
  }

  console.log(`${summary} — passed (warnings are non-blocking)`);
}

// Only auto-run when invoked as a script (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await run();
}
