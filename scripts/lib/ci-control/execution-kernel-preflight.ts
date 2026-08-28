import {
  matchesSameProcessControlExecutionPlan,
  type ControlExecutionPlanV1,
} from './execution-plan.ts';

const REFLECT_APPLY = Reflect.apply;
const ARRAY_MAP = Array.prototype.map;
const ARRAY_SLICE = Array.prototype.slice;
const ARRAY_SORT = Array.prototype.sort;
const OBJECT_FREEZE = Object.freeze;

export type KernelInputRequirement =
  | 'working-directory-policy'
  | 'environment-allowlist-policy'
  | 'executable-identity-policy'
  | 'timeout-policy'
  | 'output-budget-policy'
  | 'taint-and-write-scope-policy'
  | 'precondition-receipt-producer'
  | 'supervisor-process-lease-producer'
  | 'terminal-result-producer';

export interface UnadmittedKernelPreflightV1 {
  readonly schemaVersion: 1;
  readonly authorization: 'report-only';
  readonly operation: 'evidence-collection';
  readonly outcome: 'inconclusive';
  readonly exitCode: 2;
  readonly spawnAllowed: false;
  readonly code: 'ci.execution-kernel.plan-unadmitted';
}

export interface ReportOnlyKernelPreflightV1 {
  readonly schemaVersion: 1;
  readonly authorization: 'report-only';
  readonly operation: 'evidence-collection';
  readonly outcome: 'inconclusive';
  readonly exitCode: 2;
  readonly spawnAllowed: false;
  readonly code: 'ci.execution-kernel.contracts-unavailable';
  readonly plan: ControlExecutionPlanV1;
  readonly planDigest: string;
  readonly exactChildControlIds: readonly string[];
  readonly unavailableInputs: readonly KernelInputRequirement[];
  readonly unavailableControls: readonly string[];
  readonly requiredSuites: readonly string[];
  readonly limitations: readonly string[];
}

export type KernelPreflightV1 = UnadmittedKernelPreflightV1 | ReportOnlyKernelPreflightV1;

const UNADMITTED = OBJECT_FREEZE({
  schemaVersion: 1,
  authorization: 'report-only',
  operation: 'evidence-collection',
  outcome: 'inconclusive',
  exitCode: 2,
  spawnAllowed: false,
  code: 'ci.execution-kernel.plan-unadmitted',
} as const);

const UNAVAILABLE_INPUTS = OBJECT_FREEZE([
  'environment-allowlist-policy',
  'executable-identity-policy',
  'output-budget-policy',
  'precondition-receipt-producer',
  'supervisor-process-lease-producer',
  'taint-and-write-scope-policy',
  'terminal-result-producer',
  'timeout-policy',
  'working-directory-policy',
] satisfies KernelInputRequirement[]);

function copyFrozen<T>(value: readonly T[]): readonly T[] {
  return OBJECT_FREEZE(REFLECT_APPLY(ARRAY_SLICE, value, []) as T[]);
}

export function preflightReportOnlyExecutionPlan(value: unknown): KernelPreflightV1 {
  if (!matchesSameProcessControlExecutionPlan(value)) return UNADMITTED;
  const exactChildControlIds = REFLECT_APPLY(
    ARRAY_MAP,
    value.steps,
    [({ controlId }: { controlId: string }) => controlId],
  ) as string[];
  const selected = REFLECT_APPLY(ARRAY_SLICE, value.requiredControls, []) as string[];
  const sortedObserved = REFLECT_APPLY(ARRAY_SLICE, exactChildControlIds, []) as string[];
  REFLECT_APPLY(ARRAY_SORT, selected, []);
  REFLECT_APPLY(ARRAY_SORT, sortedObserved, []);
  if (exactChildControlIds.length !== selected.length) return UNADMITTED;
  for (let index = 0; index < sortedObserved.length; index += 1) {
    if (sortedObserved[index] !== selected[index]) return UNADMITTED;
  }
  return OBJECT_FREEZE({
    schemaVersion: 1,
    authorization: 'report-only',
    operation: 'evidence-collection',
    outcome: 'inconclusive',
    exitCode: 2,
    spawnAllowed: false,
    code: 'ci.execution-kernel.contracts-unavailable',
    plan: value,
    planDigest: value.planDigest,
    exactChildControlIds: copyFrozen(exactChildControlIds),
    unavailableInputs: copyFrozen(UNAVAILABLE_INPUTS),
    unavailableControls: copyFrozen(value.unavailableControls),
    requiredSuites: copyFrozen(value.requiredSuites),
    limitations: copyFrozen(value.limitations),
  } satisfies ReportOnlyKernelPreflightV1);
}
