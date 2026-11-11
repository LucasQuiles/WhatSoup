import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cleanGitEnv } from '../src/lib/git-env.ts';
import { takeValue } from './lib/cli-args.ts';
import { checkBotErrorsRuntimeManifest, EXPLICIT_REQUIRED_RUNTIME_PATHS, parseManifestEntries } from './check-bot-errors-runtime-manifest.ts';
import { classifyTestChanges, isSafeChangedPath, type TestSelectionPolicy } from './lib/test-selection-policy.ts';

export type TestSuite = 'all' | 'root' | 'console' | 'browser' | 'guard' | 'python';
export interface TestOptions {
  base?: string;
  files?: string[];
  full: boolean;
  suite: TestSuite;
  maxWorkers: number;
  timeoutMs: number;
  timeoutExplicit: boolean;
  coverage: boolean;
  json: boolean;
  help: boolean;
}

export const TEST_HELP = `Usage: npm run test:plan -- [options]
       npm run test:affected -- [options]
  --base REF          Compare merge base with the worktree (default origin/main)
  --files PATH...      Explicit repository paths; cannot combine with --base
  --full              Select full validation regardless of the diff
  --suite NAME        all (default), root, console, browser, guard, python
  --max-workers N     Vitest workers, 1..4 (default 2; browser always 1)
  --timeout-ms N      Total execution budget (default 120000; full 1800000)
  --coverage          Full root coverage with unchanged thresholds
  --json              One JSON document on stdout; diagnostics on stderr
  --help              Show this contract without running tests
Planning is dependency-free and read-only. Suite selection is a local focus,
not complete merge/release evidence. No passing test result is cached.
Exit: 0 success, 1 failure, 2 invalid input, 75 busy, 124 timeout, 125 inconclusive.
`;

export function parseTestOptions(argv: readonly string[]): TestOptions {
  const options: TestOptions = { full: false, suite: 'all', maxWorkers: 2, timeoutMs: 120_000, timeoutExplicit: false, coverage: false, json: false, help: false };
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (seen.has(flag)) throw new Error(`Repeated option: ${flag}`);
    seen.add(flag);
    if (flag === '--json') options.json = true;
    else if (flag === '--help') options.help = true;
    else if (flag === '--full') options.full = true;
    else if (flag === '--coverage') options.coverage = true;
    else if (flag === '--files') {
      const files: string[] = [];
      while (argv[index + 1] && !argv[index + 1]!.startsWith('-')) files.push(argv[++index]!);
      if (files.length === 0) throw new Error('--files requires at least one repository path');
      options.files = files;
    } else if (['--base', '--suite', '--max-workers', '--timeout-ms'].includes(flag)) {
      const taken = takeValue(argv, index, flag);
      const value = taken.value;
      index = taken.index;
      if (flag === '--base') options.base = value;
      else if (flag === '--suite') {
        if (!['all', 'root', 'console', 'browser', 'guard', 'python'].includes(value)) throw new Error(`Unknown suite: ${value}`);
        options.suite = value as TestSuite;
      } else {
        const number = Number(value);
        const maximum = flag === '--max-workers' ? 4 : 2_147_483_647;
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1 || number > maximum) {
          throw new Error(`${flag} must be an integer in 1..${maximum}`);
        }
        if (flag === '--max-workers') options.maxWorkers = number;
        else { options.timeoutMs = number; options.timeoutExplicit = true; }
      }
    } else throw new Error(`Unknown option: ${flag}`);
  }
  if (options.base && options.files) throw new Error('--base and --files are mutually exclusive');
  if (options.coverage && !['all', 'root'].includes(options.suite)) throw new Error('--coverage requires --suite all or root');
  for (const file of options.files ?? []) {
    if (!isSafeChangedPath(file)) {
      throw new Error(`Invalid repository path: ${JSON.stringify(file)}`);
    }
  }
  if ((options.full || options.coverage) && !seen.has('--timeout-ms')) options.timeoutMs = 1_800_000;
  return options;
}

export interface TestPlan extends TestSelectionPolicy {
  schemaVersion: 1;
  effect: 'read-only';
  base: string | null;
  head: string | null;
  selection: 'git' | 'files' | 'full';
  suite: TestSuite;
  maxWorkers: number;
  timeoutMs: number;
  coverage: boolean;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, env: cleanGitEnv(), encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** --no-renames represents moves as deletion + addition, preserving both risk surfaces. */
export function readChangedPaths(cwd: string, base: string): { files: string[]; deleted: boolean; base: string; head: string } {
  const revision = git(cwd, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]).trim();
  const head = git(cwd, ['rev-parse', 'HEAD']).trim();
  const mergeBase = git(cwd, ['merge-base', revision, head]).trim();
  const fields = git(cwd, ['diff', '--no-renames', '--name-status', '-z', mergeBase, '--']).split('\0');
  const files = new Set<string>();
  let deleted = false;
  for (let index = 0; index < fields.length - 1; index += 2) {
    const status = fields[index];
    const file = fields[index + 1];
    if (!status || !file || !/^[AMDTUXB]$/.test(status)) throw new Error('Unrecognized git diff status; selection is inconclusive');
    files.add(file);
    if (status !== 'A' && status !== 'M') deleted = true;
  }
  for (const file of git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0')) {
    if (file) files.add(file);
  }
  return { files: [...files].sort(), deleted, base: mergeBase, head };
}

export function createTestPlan(cwd: string, options: TestOptions): TestPlan {
  const change = options.full || options.files ? null : readChangedPaths(cwd, options.base ?? 'origin/main');
  const files = options.files ?? change?.files ?? [];
  let policy = classifyTestChanges(files);
  const forcedReasons: string[] = [];
  if (options.full) forcedReasons.push('Full validation explicitly requested');
  if (options.coverage) forcedReasons.push('Coverage requires the complete root suite');
  if (change?.deleted) forcedReasons.push('Deletion, rename or unresolved change requires full validation');
  if (options.files?.some((file) => !existsSync(resolve(cwd, file)))) forcedReasons.push('Missing explicit path requires full validation');
  if (policy.profile === 'affected' && forcedReasons.length === 0) {
    // Deployed library inputs need Python parity checks even when their names look low risk.
    try {
      const manifest = parseManifestEntries(JSON.parse(readFileSync(resolve(cwd, 'deploy/bot-errors-runtime-manifest.json'), 'utf8')));
      if (manifest.findings.length > 0 || manifest.entries.length === 0 || !checkBotErrorsRuntimeManifest(cwd).ok) {
        forcedReasons.push('Invalid deployment runtime manifest requires full validation');
      } else {
        policy = classifyTestChanges(files, [...EXPLICIT_REQUIRED_RUNTIME_PATHS, ...manifest.entries.map((entry) => entry.path)]);
      }
    } catch {
      forcedReasons.push('Unavailable deployment runtime manifest requires full validation');
    }
  }
  if (forcedReasons.length > 0) policy = { ...classifyTestChanges([]), changedFiles: [...files].sort(), reasons: forcedReasons };
  return {
    ...policy, schemaVersion: 1, effect: 'read-only', base: change?.base ?? null,
    head: change?.head ?? git(cwd, ['rev-parse', 'HEAD']).trim(),
    selection: options.full ? 'full' : options.files ? 'files' : 'git', suite: options.suite,
    maxWorkers: options.maxWorkers,
    timeoutMs: policy.profile === 'full' && !options.timeoutExplicit ? 1_800_000 : options.timeoutMs,
    coverage: options.coverage,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseTestOptions(process.argv.slice(2));
    if (options.help) process.stdout.write(TEST_HELP);
    else {
      const plan = createTestPlan(process.cwd(), options);
      process.stdout.write(options.json ? `${JSON.stringify(plan)}\n` : `${plan.profile}: ${plan.reasons.join('; ')}\nLanes: ${Object.entries(plan.lanes).filter(([, selected]) => selected).map(([name]) => name).join(', ') || 'static checks only'}\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ schemaVersion: 1, outcome: 'invalid', error: message })}\n`);
    else process.stderr.write(`test:plan: ${message}\n`);
    process.exitCode = 2;
  }
}
