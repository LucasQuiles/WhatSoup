import { execFileSync } from 'node:child_process';
import { cleanGitEnv } from '../../src/lib/git-env.ts';
import type { runEslintFitness } from '../../scripts/eslint-fitness-check.ts';

type ScanResult = Awaited<ReturnType<typeof runEslintFitness>>;

export function scanFitnessInNativeProcess(cwd: string): ScanResult {
  const scanner = new URL('../../scripts/eslint-fitness-check.ts', import.meta.url).href;
  // ESLint must scan real source without paying Vitest's instrumentation cost for its parser.
  const output = execFileSync(process.execPath, [
    '--input-type=module', '--eval',
    'let complete = false; process.on("exit", () => { if (!complete && Number(process.exitCode ?? 0) === 0) process.exitCode = 1; }); '
      + 'const { runEslintFitness } = await import(process.argv[1]); '
      + 'process.stdout.write(JSON.stringify(await runEslintFitness(process.cwd()))); complete = true;',
    scanner,
  ], {
    cwd, encoding: 'utf8', timeout: 290_000, killSignal: 'SIGKILL',
    maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...cleanGitEnv(), NODE_DISABLE_COMPILE_CACHE: '1' },
  });
  const result: ScanResult = JSON.parse(output);
  if (!result || typeof result.fatal !== 'boolean'
    || ![result.warningCount, result.errorCount, result.filesLinted].every((value) => Number.isSafeInteger(value) && value >= 0)
    || !Array.isArray(result.issues) || result.issues.length !== result.warningCount + result.errorCount
    || result.issues.some((issue) => !issue || typeof issue.code !== 'string' || typeof issue.message !== 'string'
      || typeof issue.filePath !== 'string' || (issue.line !== undefined && (!Number.isSafeInteger(issue.line) || issue.line < 1)))) {
    throw new Error('Native fitness scan returned an incomplete report');
  }
  return result;
}
