/**
 * Fail-closed required-context aggregation for the change-aware Quality workflow.
 *
 * GitHub Actions reports skipped jobs as a successful workflow unless the required
 * check reads `needs.*.result` itself. Keep that interpretation in one testable
 * module so the stable branch-protection contexts cannot go green after a selected
 * validation job was skipped, cancelled, absent, or failed.
 */
import { pathToFileURL } from 'node:url';

export type TestProfile = 'docs' | 'affected' | 'full';
export type TestMatrix = 'node24' | 'node25';
export type JobResult = 'success' | 'failure' | 'cancelled' | 'skipped' | 'missing';

export interface TestLanes {
  root: boolean;
  console: boolean;
  browser: boolean;
  python: boolean;
  guard: boolean;
  docker: boolean;
  compatibility: boolean;
}

export interface TestPlan {
  profile: TestProfile;
  lanes: TestLanes;
}

export interface TestJobCheck {
  ok: boolean;
  required: string[];
  failed: Array<{ job: string; result: JobResult | 'invalid-plan' }>;
}

const laneNames = ['root', 'console', 'browser', 'python', 'guard', 'docker', 'compatibility'] as const;
const validProfiles = new Set<TestProfile>(['docs', 'affected', 'full']);
const validMatrices = new Set<TestMatrix>(['node24', 'node25']);
const validResults = new Set<JobResult>(['success', 'failure', 'cancelled', 'skipped', 'missing']);

function validPlan(plan: TestPlan): boolean {
  if (!validProfiles.has(plan.profile)) return false;
  if (typeof plan.lanes !== 'object' || plan.lanes === null) return false;
  if (!laneNames.every((lane) => typeof plan.lanes[lane] === 'boolean')) return false;

  const allLanes = laneNames.every((lane) => plan.lanes[lane]);
  const noLanes = laneNames.every((lane) => !plan.lanes[lane]);
  return (plan.profile === 'full' && allLanes)
    || (plan.profile === 'docs' && noLanes)
    || (plan.profile === 'affected' && !allLanes && !noLanes);
}

function selectedJobs(matrix: TestMatrix, plan: TestPlan): string[] {
  if (plan.profile === 'docs') return ['selection', 'docs'];
  if (plan.profile === 'full') {
    return matrix === 'node24'
      ? ['selection', 'full', 'bot-errors-health-macos']
      : ['selection', 'compatibility-full'];
  }
  if (matrix === 'node24') return ['selection', 'affected'];
  return plan.lanes.compatibility ? ['selection', 'compatibility-affected'] : ['selection'];
}

export function checkTestJobs(
  matrix: TestMatrix,
  plan: TestPlan,
  results: Readonly<Record<string, JobResult>>,
): TestJobCheck {
  if (!validMatrices.has(matrix) || !validPlan(plan)) {
    return { ok: false, required: ['selection'], failed: [{ job: 'selection', result: 'invalid-plan' }] };
  }

  const required = selectedJobs(matrix, plan);
  const failed = required.flatMap((job) => {
    const result = results[job] ?? 'missing';
    return result === 'success' ? [] : [{ job, result }];
  });
  return { ok: failed.length === 0, required, failed };
}

function parsePlan(text: string | undefined): TestPlan | null {
  if (text === undefined) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const plan = value as Partial<TestPlan>;
    if (typeof plan.profile !== 'string' || plan.lanes === null || typeof plan.lanes !== 'object') return null;
    return plan as TestPlan;
  } catch {
    return null;
  }
}

function parseResults(text: string | undefined): Record<string, JobResult> | null {
  if (text === undefined) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const parsed: Record<string, JobResult> = {};
    for (const [job, raw] of Object.entries(value)) {
      const result = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as { result?: unknown }).result
        : raw;
      if (typeof result !== 'string' || !validResults.has(result as JobResult)) return null;
      parsed[job] = result as JobResult;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function runTestJobCheck(environment: NodeJS.ProcessEnv = process.env): number {
  const matrix = environment.TEST_JOB_MATRIX as TestMatrix | undefined;
  const plan = parsePlan(environment.TEST_PLAN_JSON);
  const results = parseResults(environment.TEST_JOB_RESULTS);
  if (matrix === undefined || plan === null || results === null) {
    console.error('TEST_JOB_CHECK inconclusive: invalid matrix, plan, or job results input');
    return 2;
  }

  const checked = checkTestJobs(matrix, plan, results);
  if (!checked.ok) {
    console.error(`TEST_JOB_CHECK failed: ${checked.failed.map(({ job, result }) => `${job}=${result}`).join(', ')}`);
    return 1;
  }
  console.log(`TEST_JOB_CHECK pass: ${checked.required.join(', ')}`);
  return 0;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exitCode = runTestJobCheck();
