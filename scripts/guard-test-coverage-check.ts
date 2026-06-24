import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Meta-guard: every guard-family script under `scripts/` must ship a companion
 * test that is actually wired into the `verify:push:branch` gate.
 *
 * The public-surface-drift check already forces each `guard:*` npm script to
 * carry a row in `docs/public-surface.md`, but NOTHING forced the guard to ship
 * a test that runs in the pre-push gate. A guard could therefore ship entirely
 * untested. This guard closes that gap.
 *
 * A guard PASSES when EITHER:
 *   (a) its companion test file exists under `tests/scripts/` AND that test's
 *       path appears in the `verify:push:branch` script string in package.json
 *       (so the test actually runs in the gate); OR
 *   (b) the guard carries a top-of-file `// meta-guard:no-test <reason>` comment
 *       opting out (for guards genuinely covered by a broader suite test).
 *
 * Companion-test resolution: a guard `scripts/<name>.ts` maps to
 * `tests/scripts/<name>.test.ts`. As a documented alias, a `check-<x>.ts` guard
 * may instead ship `tests/scripts/<x>.test.ts` (the `check-` prefix dropped) —
 * an established convention in this repo (e.g. `check-node-pin-consistency.ts`
 * is covered by `tests/scripts/node-pin-consistency.test.ts`).
 */

export interface GuardTestCoverageOptions {
  cwd?: string;
}

export type GuardTestCoverageReason =
  | 'no-test'
  | 'test-not-wired';

export interface GuardCoverageGap {
  /** Guard script path relative to repo root, e.g. `scripts/repo-hygiene-guard.ts`. */
  guard: string;
  /** Why the guard failed coverage. */
  reason: GuardTestCoverageReason;
  /** Companion test path we looked for / found, relative to repo root. */
  expectedTest: string;
}

export interface GuardAllowlistEntry {
  guard: string;
  reason: string;
}

export interface GuardCoverageResult {
  /** Guards that pass (have a wired companion test). */
  covered: string[];
  /** Guards opted out via `// meta-guard:no-test <reason>`. */
  allowlisted: GuardAllowlistEntry[];
  /** Guards missing a wired companion test (failures). */
  gaps: GuardCoverageGap[];
}

const SCRIPTS_DIR = 'scripts';
const TESTS_DIR = 'tests/scripts';
const ALLOWLIST_PATTERN = /^\s*\/\/\s*meta-guard:no-test\s+(.+?)\s*$/m;

/**
 * Enumerate guard-family scripts: `scripts/*guard*.ts` plus `scripts/check-*.ts`.
 * Type-declaration files and the meta-guard's own helpers are folded in naturally
 * because the meta-guard itself (`guard-test-coverage-check.ts`) matches the
 * `*guard*` glob and so is held to the same standard.
 */
export function enumerateGuardScripts(cwd: string): string[] {
  const dir = path.join(cwd, SCRIPTS_DIR);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    const detail = err instanceof Error && err.message ? `: ${err.message}` : '';
    throw new Error(`unable to scan guard scripts directory ${dir}${detail}`);
  }
  const guards = entries.filter((name) => {
    if (!name.endsWith('.ts')) return false;
    if (name.endsWith('.d.ts')) return false;
    return name.includes('guard') || name.startsWith('check-');
  });
  guards.sort();
  return guards.map((name) => `${SCRIPTS_DIR}/${name}`);
}

/**
 * Candidate companion-test paths (repo-relative) for a guard, in priority order.
 * Primary: same basename. Alias: drop a leading `check-` prefix.
 */
export function companionTestCandidates(guardRelPath: string): string[] {
  const base = path.basename(guardRelPath).replace(/\.ts$/, '');
  const candidates = [`${TESTS_DIR}/${base}.test.ts`];
  if (base.startsWith('check-')) {
    candidates.push(`${TESTS_DIR}/${base.slice('check-'.length)}.test.ts`);
  }
  return candidates;
}

function readVerifyPushBranch(cwd: string): string {
  const pkgPath = path.join(cwd, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    scripts?: Record<string, string>;
  };
  return pkg.scripts?.['verify:push:branch'] ?? '';
}

function readAllowlistReason(absGuardPath: string): string | null {
  let text: string;
  try {
    text = readFileSync(absGuardPath, 'utf8');
  } catch {
    return null;
  }
  const match = text.match(ALLOWLIST_PATTERN);
  return match ? (match[1] ?? '').trim() || null : null;
}

export function findGuardsMissingTests(
  options: GuardTestCoverageOptions = {},
): GuardCoverageResult {
  const cwd = options.cwd ?? process.cwd();
  const verifyScript = readVerifyPushBranch(cwd);
  const guards = enumerateGuardScripts(cwd);

  const covered: string[] = [];
  const allowlisted: GuardAllowlistEntry[] = [];
  const gaps: GuardCoverageGap[] = [];

  for (const guard of guards) {
    const allowReason = readAllowlistReason(path.join(cwd, guard));
    if (allowReason) {
      allowlisted.push({ guard, reason: allowReason });
      continue;
    }

    const candidates = companionTestCandidates(guard);
    const existing = candidates.find((rel) => existsSync(path.join(cwd, rel)));

    if (!existing) {
      // No companion test under any recognised name.
      gaps.push({ guard, reason: 'no-test', expectedTest: candidates[0] ?? '' });
      continue;
    }

    // The test exists — but does it actually run in the pre-push gate?
    const wired = candidates.some((rel) => verifyScript.includes(rel));
    if (!wired) {
      gaps.push({ guard, reason: 'test-not-wired', expectedTest: existing });
      continue;
    }

    covered.push(guard);
  }

  return { covered, allowlisted, gaps };
}

function printResult(result: GuardCoverageResult): void {
  for (const gap of result.gaps) {
    if (gap.reason === 'no-test') {
      console.error(
        `  MISSING-TEST ${gap.guard}: no companion test found (expected ${gap.expectedTest}). ` +
          `Add it under tests/scripts/ and wire its path into verify:push:branch, ` +
          `or add a top-of-file '// meta-guard:no-test <reason>' comment.`,
      );
    } else {
      console.error(
        `  TEST-NOT-WIRED ${gap.guard}: companion test ${gap.expectedTest} exists but is ` +
          `not listed in the verify:push:branch 'npm test --' arg list, so it never runs in the gate.`,
      );
    }
  }
}

export function run(
  _argv: string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
  _env: NodeJS.ProcessEnv = process.env,
): GuardCoverageResult {
  const result = findGuardsMissingTests({ cwd });
  if (result.gaps.length > 0) {
    console.error(
      `guard-test-coverage check failed: ${result.gaps.length} guard script(s) lack a wired companion test`,
    );
    printResult(result);
    process.exitCode = 1;
  } else {
    const allowNote =
      result.allowlisted.length > 0
        ? ` (${result.allowlisted.length} allowlisted: ${result.allowlisted
            .map((entry) => `${entry.guard} — ${entry.reason}`)
            .join('; ')})`
        : '';
    console.log(
      `guard-test-coverage check passed: ${result.covered.length} guard(s) have a wired companion test${allowNote}`,
    );
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run();
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
