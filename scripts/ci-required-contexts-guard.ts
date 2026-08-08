#!/usr/bin/env node
/**
 * #2980: required-CI-context guard.
 *
 * A required CI context that never starts at a head SHA is ABSENT — no failing
 * row, nothing pending. Naive green logic reads this as "all checks passed"
 * and ships unverified code. This guard queries the GitHub Actions runs API
 * AND the check-runs API at the exact head SHA, and FAILS unless every
 * required context in controls/ci-required-contexts.json has a run registered.
 *
 * Fail closed: API error, timeout, or missing run = block, never green.
 *
 * Usage:
 *   bash scripts/run-with-pinned-node.sh scripts/ci-required-contexts-guard.ts \
 *     --head-sha <sha> [--owner <owner> --repo <repo>]
 *
 * Derives --head-sha from HEAD and --owner/--repo from GITHUB_REPOSITORY or
 * git remote origin when omitted.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { isHelpFlag, parseClosedOptions } from './lib/cli-args.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContextSource = 'github-actions' | 'check-runs';

export interface RequiredContext {
  readonly name: string;
  readonly source: ContextSource;
  readonly workflow?: string;
  readonly description?: string;
}

export interface RequiredContextsRegistry {
  readonly schemaVersion: 1;
  readonly contexts: RequiredContext[];
  readonly failurePolicy: {
    readonly missing: 'block';
    readonly apiError: 'block';
    readonly timeout: 'block';
  };
}

export interface WorkflowRun {
  readonly name: string;
  readonly head_sha: string;
  readonly status: string;
  readonly conclusion: string | null;
}

export interface ActionsRunsResponse {
  readonly workflow_runs: WorkflowRun[];
}

export interface CheckRun {
  readonly name: string;
  readonly head_sha: string;
  readonly status: string;
  readonly conclusion: string | null;
}

export interface CheckRunsResponse {
  readonly check_runs: CheckRun[];
}

export type ContextStatus = 'present' | 'absent' | 'inconclusive';

export interface ContextVerdict {
  readonly context: string;
  readonly status: ContextStatus;
  readonly detail: string;
}

export interface GuardDeps {
  readonly ghApi: (endpoint: string) => string;
  readonly gitHeadSha: () => string;
  readonly ownerRepo: () => string;
}

export interface GuardOutput {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export const EXIT_PASS = 0;
export const EXIT_ABSENT = 1;
export const EXIT_INCONCLUSIVE = 2;

const REGISTRY_PATH = 'controls/ci-required-contexts.json';
const API_TIMEOUT_MS = 30_000;
const USAGE =
  'Usage: npm run guard:ci-required-contexts -- --head-sha <sha> [--owner <o> --repo <r>]\n';

// ---------------------------------------------------------------------------
// Registry loading + validation
// ---------------------------------------------------------------------------

export function loadRequiredContexts(cwd: string = process.cwd()): RequiredContextsRegistry {
  const raw = readFileSync(resolve(cwd, REGISTRY_PATH), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${REGISTRY_PATH}: expected a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.schemaVersion !== 1) {
    throw new Error(`${REGISTRY_PATH}: unsupported schemaVersion`);
  }
  if (!Array.isArray(obj.contexts)) {
    throw new Error(`${REGISTRY_PATH}: contexts must be an array`);
  }
  for (const [i, ctx] of obj.contexts.entries()) {
    if (typeof ctx !== 'object' || ctx === null) {
      throw new Error(`${REGISTRY_PATH}: contexts[${i}] must be an object`);
    }
    const c = ctx as Record<string, unknown>;
    if (typeof c.name !== 'string' || c.name.trim().length === 0) {
      throw new Error(`${REGISTRY_PATH}: contexts[${i}].name must be a non-empty string`);
    }
    if (c.source !== 'github-actions' && c.source !== 'check-runs') {
      throw new Error(`${REGISTRY_PATH}: contexts[${i}].source must be 'github-actions' or 'check-runs'`);
    }
  }
  return obj as unknown as RequiredContextsRegistry;
}

// ---------------------------------------------------------------------------
// Pure core: check required contexts against API responses
// ---------------------------------------------------------------------------

/**
 * Check every required context against the API responses at the exact head SHA.
 *
 * - `actionsRuns === null` → the Actions API call failed; any github-actions
 *   context is inconclusive (fail closed).
 * - `checkRuns === null` → the check-runs API call failed; any check-runs
 *   context is inconclusive (fail closed).
 * - A context whose API response is available but who has no matching run at
 *   the head SHA is ABSENT.
 * - A context with a matching run is present.
 *
 * Exit code: 0 if all present, 1 if any ABSENT, 2 if any inconclusive.
 */
export function checkRequiredContexts(
  required: readonly RequiredContext[],
  headSha: string,
  actionsRuns: ActionsRunsResponse | null,
  checkRuns: CheckRunsResponse | null,
): { verdicts: ContextVerdict[]; exitCode: typeof EXIT_PASS | typeof EXIT_ABSENT | typeof EXIT_INCONCLUSIVE } {
  const verdicts: ContextVerdict[] = [];
  const shortSha = headSha.slice(0, 7);

  for (const ctx of required) {
    if (ctx.source === 'github-actions') {
      if (actionsRuns === null) {
        verdicts.push({
          context: ctx.name,
          status: 'inconclusive',
          detail: `INCONCLUSIVE: actions/runs API unavailable — cannot verify "${ctx.name}" at ${shortSha}`,
        });
        continue;
      }
      const runsAtHead = actionsRuns.workflow_runs.filter((r) => r.head_sha === headSha);
      const workflowName = ctx.workflow ?? ctx.name;
      const found = runsAtHead.some((r) => r.name === workflowName);
      verdicts.push({
        context: ctx.name,
        status: found ? 'present' : 'absent',
        detail: found
          ? `present: workflow "${workflowName}" has a run at ${shortSha} for context "${ctx.name}"`
          : `ABSENT: context "${ctx.name}" — no workflow run "${workflowName}" at ${shortSha}`,
      });
    } else {
      // check-runs source — MUST query the check-runs API (not actions/runs).
      // Removing this branch causes check-runs contexts to go undetected.
      if (checkRuns === null) {
        verdicts.push({
          context: ctx.name,
          status: 'inconclusive',
          detail: `INCONCLUSIVE: check-runs API unavailable — cannot verify "${ctx.name}" at ${shortSha}`,
        });
        continue;
      }
      const found = checkRuns.check_runs.some(
        (cr) => cr.name === ctx.name && cr.head_sha === headSha,
      );
      verdicts.push({
        context: ctx.name,
        status: found ? 'present' : 'absent',
        detail: found
          ? `present: check-run "${ctx.name}" at ${shortSha}`
          : `ABSENT: no check-run "${ctx.name}" at ${shortSha}`,
      });
    }
  }

  const hasInconclusive = verdicts.some((v) => v.status === 'inconclusive');
  const hasAbsent = verdicts.some((v) => v.status === 'absent');
  const exitCode = hasInconclusive ? EXIT_INCONCLUSIVE : hasAbsent ? EXIT_ABSENT : EXIT_PASS;
  return { verdicts, exitCode };
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

function defaultGhApi(endpoint: string): string {
  return execFileSync('gh', ['api', endpoint], {
    encoding: 'utf8',
    timeout: API_TIMEOUT_MS,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function defaultGitHeadSha(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function defaultOwnerRepo(): string {
  const env = process.env.GITHUB_REPOSITORY;
  if (typeof env === 'string' && env.includes('/')) return env;
  const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  // git@github.com:owner/repo.git  OR  https://github.com/owner/repo.git
  const match = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (match === null) throw new Error(`cannot parse owner/repo from origin URL: ${url}`);
  return `${match[1]}/${match[2]}`;
}

function fetchActionsRuns(
  ghApi: (endpoint: string) => string,
  ownerRepo: string,
  headSha: string,
): ActionsRunsResponse | null {
  try {
    const raw = ghApi(`repos/${ownerRepo}/actions/runs?head_sha=${headSha}&per_page=100`);
    return JSON.parse(raw) as ActionsRunsResponse;
  } catch {
    return null;
  }
}

function fetchCheckRuns(
  ghApi: (endpoint: string) => string,
  ownerRepo: string,
  headSha: string,
): CheckRunsResponse | null {
  try {
    const raw = ghApi(`repos/${ownerRepo}/commits/${headSha}/check-runs?per_page=100`);
    return JSON.parse(raw) as CheckRunsResponse;
  } catch {
    return null;
  }
}

export function run(
  args: readonly string[],
  cwd: string,
  deps: GuardDeps,
  output: GuardOutput,
): 0 | 1 | 2 {
  if (args.length === 1 && isHelpFlag(args[0]!)) {
    output.stdout(USAGE);
    return 0;
  }

  const parsed = parseClosedOptions(args, {
    booleanOptions: [],
    valueOptions: ['--head-sha', '--owner', '--repo'],
  });
  if (parsed.error !== null) {
    output.stderr(`ci-required-contexts-guard: INCONCLUSIVE — ${parsed.error}\n${USAGE}`);
    return EXIT_INCONCLUSIVE;
  }

  let headSha: string;
  try {
    headSha = parsed.values.get('--head-sha') ?? deps.gitHeadSha();
  } catch (err) {
    output.stderr(`ci-required-contexts-guard: INCONCLUSIVE — cannot resolve head SHA: ${(err as Error).message}\n`);
    return EXIT_INCONCLUSIVE;
  }

  let ownerRepo: string;
  try {
    const owner = parsed.values.get('--owner');
    const repo = parsed.values.get('--repo');
    if (typeof owner === 'string' && typeof repo === 'string') {
      ownerRepo = `${owner}/${repo}`;
    } else {
      ownerRepo = deps.ownerRepo();
    }
  } catch (err) {
    output.stderr(`ci-required-contexts-guard: INCONCLUSIVE — cannot resolve owner/repo: ${(err as Error).message}\n`);
    return EXIT_INCONCLUSIVE;
  }

  let registry: RequiredContextsRegistry;
  try {
    registry = loadRequiredContexts(cwd);
  } catch (err) {
    output.stderr(`ci-required-contexts-guard: INCONCLUSIVE — cannot load registry: ${(err as Error).message}\n`);
    return EXIT_INCONCLUSIVE;
  }

  // Query BOTH APIs — actions/runs for github-actions contexts, check-runs
  // for check-runs contexts. A context that reports via check-runs (not
  // Actions) would go undetected if only actions/runs is queried.
  const actionsRuns = fetchActionsRuns(deps.ghApi, ownerRepo, headSha);
  const checkRuns = fetchCheckRuns(deps.ghApi, ownerRepo, headSha);

  // If BOTH APIs failed, we can't verify anything — fail closed.
  if (actionsRuns === null && checkRuns === null) {
    output.stderr(
      `ci-required-contexts-guard: INCONCLUSIVE — both GitHub API calls failed for ${headSha.slice(0, 7)}\n`,
    );
    return EXIT_INCONCLUSIVE;
  }

  const { verdicts, exitCode } = checkRequiredContexts(
    registry.contexts,
    headSha,
    actionsRuns,
    checkRuns,
  );

  for (const v of verdicts) {
    if (v.status === 'present') {
      output.stdout(`PASS ${v.context} — ${v.detail}\n`);
    } else {
      output.stderr(`${v.detail}\n`);
    }
  }

  if (exitCode === EXIT_PASS) {
    output.stdout(`ci-required-contexts-guard: all ${verdicts.length} required context(s) present at ${headSha.slice(0, 7)}\n`);
  } else if (exitCode === EXIT_ABSENT) {
    const absent = verdicts.filter((v) => v.status === 'absent').map((v) => v.context);
    output.stderr(`ci-required-contexts-guard: ABSENT ${absent.join(', ')} at ${headSha.slice(0, 7)}\n`);
  } else {
    output.stderr(`ci-required-contexts-guard: INCONCLUSIVE — API error prevented full verification at ${headSha.slice(0, 7)}\n`);
  }

  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run(
    process.argv.slice(2),
    process.cwd(),
    { ghApi: defaultGhApi, gitHeadSha: defaultGitHeadSha, ownerRepo: defaultOwnerRepo },
    { stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t) },
  );
}
