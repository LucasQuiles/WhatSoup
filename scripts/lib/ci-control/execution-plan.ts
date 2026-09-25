import { Buffer } from 'node:buffer';

import {
  matchesSameProcessRiskClassificationAdmission,
  riskClassificationEvidenceDigest,
  type AdmittedRiskClassificationV1,
} from './classification-admission.ts';
import type { ExactRevisionInput, RiskClassificationV1 } from './classifier.ts';
import {
  MAX_CONTROL_COUNT,
  MAX_MANIFEST_BYTES,
  digestControlManifest,
  validateControlManifest,
  type ControlAvailability,
  type ControlManifestV1,
  type RiskTier,
} from './manifest.ts';
import {
  canonicalizeBoundaryRun,
  sha256Bytes,
} from '../verification/boundary-run/shared.ts';

export type ExecutionPlanErrorCode =
  | 'ci.execution-plan.input-budget'
  | 'ci.execution-plan.manifest-invalid'
  | 'ci.execution-plan.classification-unadmitted'
  | 'ci.execution-plan.manifest-binding-mismatch'
  | 'ci.execution-plan.classification-binding-mismatch'
  | 'ci.execution-plan.required-set-invalid'
  | 'ci.execution-plan.command-unresolved'
  | 'ci.execution-plan.command-ambiguous';

export class ExecutionPlanError extends Error {
  readonly code: ExecutionPlanErrorCode;
  readonly outcome = 'inconclusive' as const;
  readonly exitCode = 2 as const;

  constructor(code: ExecutionPlanErrorCode) {
    super(code);
    this.name = 'ExecutionPlanError';
    this.code = code;
  }
}

export type ExecutionPlanReadiness = 'report-only' | 'inconclusive';
export type ExecutionStepDisposition = 'report-only' | 'unavailable';

export interface ControlExecutionStepV1 {
  readonly controlId: string;
  readonly commandId: string;
  readonly argv: readonly string[];
  readonly dependencies: readonly string[];
  readonly availability: ControlAvailability;
  readonly disposition: ExecutionStepDisposition;
}

export interface ControlExecutionPlanV1 {
  readonly schemaVersion: 1;
  readonly authorization: 'report-only';
  readonly executable: false;
  readonly readiness: ExecutionPlanReadiness;
  readonly manifestDigest: string;
  readonly classificationEvidenceDigest: string;
  readonly classifierDigest: string;
  readonly baseOid: string | null;
  readonly candidateOid: string;
  readonly mergeOid: string | null;
  readonly riskTier: RiskTier;
  readonly classificationOutcome: 'pass' | 'inconclusive';
  readonly requiredControls: readonly string[];
  readonly requiredSuites: readonly string[];
  readonly steps: readonly ControlExecutionStepV1[];
  readonly unavailableControls: readonly string[];
  readonly limitations: readonly string[];
  readonly planDigest: string;
}

type PlanWithoutDigest = Omit<ControlExecutionPlanV1, 'planDigest'>;

export const EXECUTION_PLAN_INPUT_BUDGET = Object.freeze({
  maxAggregateTextBytes: MAX_MANIFEST_BYTES,
  maxVisitedValues: 50_000,
  maxDepth: 16,
  maxContainerItems: MAX_CONTROL_COUNT,
});

const INPUT_KEYS = ['baseOid', 'candidateOid', 'eventName', 'manifestDigest', 'mergeOid'] as const;
const EVENTS = new Set(['pull_request', 'merge_group', 'push', 'tag', 'local']);
const OID = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const AVAILABLE = new Set<ControlAvailability>(['report-only', 'advisory', 'canary', 'blocking']);
const UNAVAILABLE = new Set<ControlAvailability>(['planned', 'quarantined', 'deprecated']);
const SHELLS = new Set(['bash', 'dash', 'ksh', 'sh', 'zsh']);
const UNSAFE_ARG = /[\u0000\r\n`$;&|]/;
const REFLECT_APPLY = Reflect.apply;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_IS_FROZEN = Object.isFrozen;
const OBJECT_VALUES = Object.values;
const WEAK_MAP_GET = WeakMap.prototype.get;
const WEAK_MAP_SET = WeakMap.prototype.set;
const PLAN_KEYS = [
  'authorization', 'baseOid', 'candidateOid', 'classificationEvidenceDigest',
  'classificationOutcome', 'classifierDigest', 'executable', 'limitations',
  'manifestDigest', 'mergeOid', 'planDigest', 'readiness', 'requiredControls',
  'requiredSuites', 'riskTier', 'schemaVersion', 'steps', 'unavailableControls',
] as const;

interface SameProcessPlanBinding {
  readonly planDigest: string;
  readonly requiredControls: readonly string[];
  readonly requiredSuites: readonly string[];
  readonly steps: readonly ControlExecutionStepV1[];
  readonly unavailableControls: readonly string[];
  readonly limitations: readonly string[];
}

const SAME_PROCESS_PLANS = new WeakMap<object, Readonly<SameProcessPlanBinding>>();

function fail(code: ExecutionPlanErrorCode): never {
  throw new ExecutionPlanError(code);
}

class InputStructureError extends Error {}

interface PreflightContainer {
  readonly array: boolean;
  readonly keys: readonly string[];
  readonly descriptors: Readonly<Record<string, PropertyDescriptor>>;
}

interface PreflightSnapshot {
  readonly containers: WeakMap<object, PreflightContainer>;
}

function preflightPlainData(root: unknown): PreflightSnapshot {
  const containers = new WeakMap<object, PreflightContainer>();
  const active = new WeakSet<object>();
  const pending: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value: root, depth: 0 }];
  let visitedValues = 0;
  let aggregateTextBytes = 0;

  const countText = (value: string): void => {
    aggregateTextBytes += Buffer.byteLength(value, 'utf8');
    if (aggregateTextBytes > EXECUTION_PLAN_INPUT_BUDGET.maxAggregateTextBytes) {
      fail('ci.execution-plan.input-budget');
    }
  };

  while (pending.length > 0) {
    const frame = pending.pop()!;
    if (frame.exit === true) {
      if (frame.value !== null && typeof frame.value === 'object') active.delete(frame.value);
      continue;
    }
    visitedValues += 1;
    if (visitedValues > EXECUTION_PLAN_INPUT_BUDGET.maxVisitedValues
      || frame.depth > EXECUTION_PLAN_INPUT_BUDGET.maxDepth) {
      fail('ci.execution-plan.input-budget');
    }
    const entry = frame.value;
    if (typeof entry === 'string') {
      countText(entry);
      continue;
    }
    if (entry === null || typeof entry === 'boolean') continue;
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) throw new InputStructureError('non-finite number');
      continue;
    }
    if (typeof entry !== 'object') throw new InputStructureError('unsupported value');
    if (active.has(entry)) throw new InputStructureError('cycle');
    active.add(entry);
    pending.push({ value: entry, depth: frame.depth, exit: true });

    let array: boolean;
    let prototype: object | null;
    let ownKeys: readonly PropertyKey[];
    try {
      array = Array.isArray(entry);
      prototype = Object.getPrototypeOf(entry);
      ownKeys = Reflect.ownKeys(entry);
    } catch {
      throw new InputStructureError('container inspection failed');
    }
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype) {
      throw new InputStructureError('non-plain container');
    }
    if (ownKeys.some((key) => typeof key !== 'string')) throw new InputStructureError('symbol key');
    const stringKeys = ownKeys as string[];
    let dataKeys: string[];
    if (array) {
      let lengthDescriptor: PropertyDescriptor | undefined;
      try {
        lengthDescriptor = Object.getOwnPropertyDescriptor(entry, 'length');
      } catch {
        throw new InputStructureError('array length inspection failed');
      }
      if (lengthDescriptor === undefined || !('value' in lengthDescriptor)
        || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
        throw new InputStructureError('invalid array length');
      }
      const length = lengthDescriptor.value as number;
      if (length > EXECUTION_PLAN_INPUT_BUDGET.maxContainerItems) {
        fail('ci.execution-plan.input-budget');
      }
      dataKeys = stringKeys.filter((key) => key !== 'length');
      if (dataKeys.length !== length
        || dataKeys.some((key) => !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)) {
        throw new InputStructureError('sparse or decorated array');
      }
    } else {
      dataKeys = [...stringKeys];
      if (dataKeys.length > EXECUTION_PLAN_INPUT_BUDGET.maxContainerItems) {
        fail('ci.execution-plan.input-budget');
      }
    }
    for (const key of dataKeys) countText(key);
    let descriptors: Record<string, PropertyDescriptor>;
    try {
      descriptors = Object.getOwnPropertyDescriptors(entry);
    } catch {
      throw new InputStructureError('property inspection failed');
    }
    const values: unknown[] = [];
    for (const key of dataKeys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || descriptor.enumerable !== true || !('value' in descriptor)) {
        throw new InputStructureError('accessor or hidden property');
      }
      values.push(descriptor.value);
    }
    containers.set(entry, Object.freeze({
      array,
      keys: Object.freeze([...dataKeys]),
      descriptors: Object.freeze({ ...descriptors }),
    }));
    for (let index = values.length - 1; index >= 0; index -= 1) {
      pending.push({ value: values[index], depth: frame.depth + 1 });
    }
  }

  return { containers };
}

function clonePlainData(value: unknown): unknown {
  const preflight = preflightPlainData(value);

  const clone = (entry: unknown): unknown => {
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return entry;
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) throw new Error('non-finite number');
      return entry;
    }
    if (typeof entry !== 'object') throw new Error('unsupported value');
    const container = preflight.containers.get(entry);
    if (container === undefined) throw new InputStructureError('container changed after preflight');
    if (container.array) {
      const output: unknown[] = [];
      for (const key of container.keys) {
        output.push(clone(container.descriptors[key]!.value));
      }
      return output;
    }
    const output: Record<string, unknown> = {};
    for (const key of container.keys) {
      Object.defineProperty(output, key, {
        enumerable: true,
        configurable: true,
        writable: true,
        value: clone(container.descriptors[key]!.value),
      });
    }
    return output;
  };

  return clone(value);
}

function snapshotManifest(value: ControlManifestV1): ControlManifestV1 {
  try {
    const snapshot = clonePlainData(value) as ControlManifestV1;
    const issues = validateControlManifest(snapshot);
    if (issues.length > 0) fail('ci.execution-plan.manifest-invalid');
    if (Buffer.byteLength(canonicalizeBoundaryRun(snapshot), 'utf8') > MAX_MANIFEST_BYTES) {
      fail('ci.execution-plan.manifest-invalid');
    }
    return snapshot;
  } catch (error) {
    if (error instanceof ExecutionPlanError) throw error;
    fail('ci.execution-plan.manifest-invalid');
  }
}

function snapshotTrustedInput(value: ExactRevisionInput): ExactRevisionInput {
  try {
    const snapshot = clonePlainData(value) as ExactRevisionInput;
    const keys = Object.keys(snapshot).sort();
    if (keys.length !== INPUT_KEYS.length
      || keys.some((key, index) => key !== [...INPUT_KEYS].sort()[index])
      || !EVENTS.has(snapshot.eventName)
      || !(snapshot.baseOid === null || OID.test(snapshot.baseOid))
      || !OID.test(snapshot.candidateOid)
      || !(snapshot.mergeOid === null || OID.test(snapshot.mergeOid))
      || !DIGEST.test(snapshot.manifestDigest)) {
      fail('ci.execution-plan.classification-binding-mismatch');
    }
    return snapshot;
  } catch (error) {
    if (error instanceof ExecutionPlanError) throw error;
    fail('ci.execution-plan.classification-binding-mismatch');
  }
}

function assertClassificationBindings(
  classification: Readonly<RiskClassificationV1>,
  admission: AdmittedRiskClassificationV1,
  input: ExactRevisionInput,
  manifestDigest: string,
): void {
  if (classification.baseOid !== input.baseOid
    || classification.candidateOid !== input.candidateOid
    || classification.mergeOid !== input.mergeOid
    || classification.manifestDigest !== input.manifestDigest
    || classification.manifestDigest !== manifestDigest
    || !DIGEST.test(classification.classifierDigest)) {
    fail('ci.execution-plan.classification-binding-mismatch');
  }
  let evidenceDigest: string;
  try {
    evidenceDigest = riskClassificationEvidenceDigest(input, classification as RiskClassificationV1);
  } catch {
    fail('ci.execution-plan.classification-binding-mismatch');
  }
  if (evidenceDigest !== admission.evidenceDigest) {
    fail('ci.execution-plan.classification-binding-mismatch');
  }
}

function selectedControlIds(
  classification: Readonly<RiskClassificationV1>,
  manifest: ControlManifestV1,
): string[] {
  const required = classification.requiredControls;
  if (!Array.isArray(required)
    || required.length === 0
    || required.some((id) => typeof id !== 'string' || id.length === 0 || id.startsWith('@'))
    || new Set(required).size !== required.length) {
    fail('ci.execution-plan.required-set-invalid');
  }
  const byId = new Map(manifest.controls.map((record) => [record.id, record]));
  if (required.some((id) => !byId.has(id))) fail('ci.execution-plan.required-set-invalid');
  const selected = new Set(required);
  for (const id of required) {
    const record = byId.get(id)!;
    if (record.dependencies.some((dependency) => !selected.has(dependency))) {
      fail('ci.execution-plan.required-set-invalid');
    }
  }
  return [...required].sort();
}

function dependencyOrder(ids: readonly string[], manifest: ControlManifestV1): string[] {
  const selected = new Set(ids);
  const byId = new Map(manifest.controls.map((record) => [record.id, record]));
  const remainingDependencies = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of ids) {
    const dependencies = byId.get(id)!.dependencies.filter((dependency) => selected.has(dependency));
    remainingDependencies.set(id, dependencies.length);
    for (const dependency of dependencies) {
      const rows = dependents.get(dependency) ?? [];
      rows.push(id);
      dependents.set(dependency, rows);
    }
  }
  const ready = ids.filter((id) => remainingDependencies.get(id) === 0).sort();
  const ordered: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    ordered.push(id);
    for (const dependent of [...(dependents.get(id) ?? [])].sort()) {
      const next = remainingDependencies.get(dependent)! - 1;
      remainingDependencies.set(dependent, next);
      if (next === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }
  if (ordered.length !== ids.length) fail('ci.execution-plan.required-set-invalid');
  return ordered;
}

function safeArgv(command: unknown): command is string[] {
  if (!Array.isArray(command)
    || Object.getPrototypeOf(command) !== Array.prototype
    || command.length === 0
    || command.some((argument) => typeof argument !== 'string' || argument.length === 0 || UNSAFE_ARG.test(argument))) {
    return false;
  }
  let executableIndex = 0;
  if (command[0]!.split('/').at(-1) === 'env') {
    executableIndex = 1;
    while (executableIndex < command.length
      && /^[A-Za-z_][A-Za-z0-9_]*=/.test(command[executableIndex]!)) {
      executableIndex += 1;
    }
    if (executableIndex >= command.length || command[executableIndex]!.startsWith('-')) return false;
  }
  const executable = command[executableIndex]!.split('/').at(-1)!;
  return !(SHELLS.has(executable)
    && command.slice(executableIndex + 1).some((argument) => /^-[^-]*c/.test(argument)));
}

function stepsFor(
  orderedIds: readonly string[],
  manifest: ControlManifestV1,
): { steps: ControlExecutionStepV1[]; unavailableControls: string[] } {
  const byId = new Map(manifest.controls.map((record) => [record.id, record]));
  const seenCommands = new Set<string>();
  const steps: ControlExecutionStepV1[] = [];
  const unavailableControls: string[] = [];
  for (const id of orderedIds) {
    const record = byId.get(id)!;
    const { commandId } = record.implementation;
    if (seenCommands.has(commandId)) fail('ci.execution-plan.command-ambiguous');
    seenCommands.add(commandId);
    const command = manifest.canonicalCommands[commandId];
    if (!safeArgv(command)) fail('ci.execution-plan.command-unresolved');
    if (!AVAILABLE.has(record.availability) && !UNAVAILABLE.has(record.availability)) {
      fail('ci.execution-plan.manifest-invalid');
    }
    const disposition: ExecutionStepDisposition = AVAILABLE.has(record.availability)
      ? 'report-only'
      : 'unavailable';
    if (disposition === 'unavailable') unavailableControls.push(id);
    steps.push({
      controlId: id,
      commandId,
      argv: [...command],
      dependencies: [...record.dependencies].sort(),
      availability: record.availability,
      disposition,
    });
  }
  return { steps, unavailableControls: unavailableControls.sort() };
}

function snapshotSuites(value: readonly string[]): string[] {
  if (!Array.isArray(value)
    || value.some((suite) => typeof suite !== 'string' || suite.length === 0)
    || new Set(value).size !== value.length) {
    fail('ci.execution-plan.required-set-invalid');
  }
  return [...value];
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || OBJECT_IS_FROZEN(value)) return value;
  const nestedValues = OBJECT_VALUES(value);
  for (let index = 0; index < nestedValues.length; index += 1) deepFreeze(nestedValues[index]);
  return OBJECT_FREEZE(value);
}

export function matchesSameProcessControlExecutionPlan(
  value: unknown,
): value is ControlExecutionPlanV1 {
  if (value === null || typeof value !== 'object') return false;
  try {
    const binding = REFLECT_APPLY(
      WEAK_MAP_GET,
      SAME_PROCESS_PLANS,
      [value],
    ) as Readonly<SameProcessPlanBinding> | undefined;
    if (binding === undefined) return false;
    const keys = REFLECT_OWN_KEYS(value);
    if (keys.length !== PLAN_KEYS.length) return false;
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (typeof key !== 'string') return false;
      let expected = false;
      for (let expectedIndex = 0; expectedIndex < PLAN_KEYS.length; expectedIndex += 1) {
        if (key === PLAN_KEYS[expectedIndex]) {
          expected = true;
          break;
        }
      }
      if (!expected) return false;
    }
    const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(value);
    for (let index = 0; index < PLAN_KEYS.length; index += 1) {
      const key = PLAN_KEYS[index]!;
      const descriptor = descriptors[key];
      if (descriptor === undefined
        || !('value' in descriptor)
        || descriptor.enumerable !== true
        || descriptor.configurable !== false
        || descriptor.writable !== false) return false;
    }
    return descriptors.authorization?.value === 'report-only'
      && descriptors.executable?.value === false
      && descriptors.planDigest?.value === binding.planDigest
      && descriptors.requiredControls?.value === binding.requiredControls
      && descriptors.requiredSuites?.value === binding.requiredSuites
      && descriptors.steps?.value === binding.steps
      && descriptors.unavailableControls?.value === binding.unavailableControls
      && descriptors.limitations?.value === binding.limitations;
  } catch {
    return false;
  }
}

export function compileReportOnlyExecutionPlan(
  manifestValue: ControlManifestV1,
  admission: AdmittedRiskClassificationV1,
  trustedInputValue: ExactRevisionInput,
): ControlExecutionPlanV1 {
  if (!matchesSameProcessRiskClassificationAdmission(admission)) {
    fail('ci.execution-plan.classification-unadmitted');
  }
  const manifest = snapshotManifest(manifestValue);
  const trustedInput = snapshotTrustedInput(trustedInputValue);
  let manifestDigest: string;
  try {
    manifestDigest = digestControlManifest(manifest);
  } catch {
    fail('ci.execution-plan.manifest-invalid');
  }
  if (manifestDigest !== trustedInput.manifestDigest) {
    fail('ci.execution-plan.manifest-binding-mismatch');
  }
  const classification = admission.classification;
  assertClassificationBindings(classification, admission, trustedInput, manifestDigest);
  const requiredControls = selectedControlIds(classification, manifest);
  const orderedIds = dependencyOrder(requiredControls, manifest);
  const { steps, unavailableControls } = stepsFor(orderedIds, manifest);
  const requiredSuites = snapshotSuites(classification.requiredSuites);
  const limitations = [
    ...(classification.outcome === 'inconclusive' ? ['ci.execution-plan.classification-inconclusive'] : []),
    ...(unavailableControls.length > 0 ? ['ci.execution-plan.controls-unavailable'] : []),
    'ci.execution-plan.report-only',
    ...(requiredSuites.length > 0 ? ['ci.execution-plan.suite-registry-unavailable'] : []),
  ].sort();
  const readiness: ExecutionPlanReadiness = classification.outcome === 'inconclusive'
    || unavailableControls.length > 0
    || requiredSuites.length > 0
    ? 'inconclusive'
    : 'report-only';
  const body: PlanWithoutDigest = {
    schemaVersion: 1,
    authorization: 'report-only',
    executable: false,
    readiness,
    manifestDigest,
    classificationEvidenceDigest: admission.evidenceDigest,
    classifierDigest: classification.classifierDigest,
    baseOid: trustedInput.baseOid,
    candidateOid: trustedInput.candidateOid,
    mergeOid: trustedInput.mergeOid,
    riskTier: classification.riskTier,
    classificationOutcome: classification.outcome,
    requiredControls,
    requiredSuites,
    steps,
    unavailableControls,
    limitations,
  };
  const plan: ControlExecutionPlanV1 = {
    ...body,
    planDigest: `sha256:${sha256Bytes(canonicalizeBoundaryRun(body))}`,
  };
  const frozenPlan = deepFreeze(plan);
  REFLECT_APPLY(WEAK_MAP_SET, SAME_PROCESS_PLANS, [frozenPlan, OBJECT_FREEZE({
    planDigest: frozenPlan.planDigest,
    requiredControls: frozenPlan.requiredControls,
    requiredSuites: frozenPlan.requiredSuites,
    steps: frozenPlan.steps,
    unavailableControls: frozenPlan.unavailableControls,
    limitations: frozenPlan.limitations,
  })]);
  return frozenPlan;
}
