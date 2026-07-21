import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseBoundaryJsonBytes } from '../verification/boundary-run/schema.ts';
import { isValidGitRefName, type OutgoingRefPolicyV1 } from './ref-policy.ts';

export const MAX_CONTROL_COUNT = 10_000;
export const MAX_MANIFEST_BYTES = 1_000_000;

const CONTROL_DOMAINS = [
  'repository-hygiene',
  'privacy-publication',
  'source-integrity',
  'workflow-security',
  'test-integrity',
  'functional-correctness',
  'semantic-quality',
  'portability',
  'dependency-governance',
  'artifact-integrity',
  'supply-chain',
  'deployment-safety',
  'runtime-assurance',
  'documentation',
  'operability',
] as const;
const CONTROL_STAGES = [
  'pre-commit',
  'commit-message',
  'pre-push',
  'pull-request',
  'merge-group',
  'default-branch',
  'release',
  'deployment',
  'runtime',
  'scheduled',
] as const;
const TRUST_CLASSES = [
  'untrusted-candidate',
  'reviewed-source',
  'protected-policy',
  'trusted-build',
  'verified-artifact',
  'authorized-release',
  'observed-deployment',
] as const;
const CONTROL_MODES = [
  'assist',
  'warn',
  'block',
  'quarantine',
  'human-authorization',
  'automatic-remediation',
  'detect-respond',
] as const;
const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
const RISK_TIERS = ['low', 'standard', 'elevated', 'system-wide'] as const;
const FAILURE_DECISIONS = ['warn', 'block', 'inconclusive'] as const;

export type ControlDomain = (typeof CONTROL_DOMAINS)[number];
export type ControlStage = (typeof CONTROL_STAGES)[number];
export type TrustClass = (typeof TRUST_CLASSES)[number];
export type ControlMode = (typeof CONTROL_MODES)[number];
export type ControlSeverity = (typeof SEVERITIES)[number];
export type RiskTier = (typeof RISK_TIERS)[number];
export type FailureDecision = (typeof FAILURE_DECISIONS)[number];

export interface ManifestIssue {
  code: string;
  path: string;
  message: string;
}

export interface ControlImplementationV1 {
  commandId: string;
  detectorId: string;
  nativeSchemaVersion: number | null;
}

export interface ControlEvidenceV1 {
  schemaVersion: number | null;
  paths: string[];
  digestBinding: 'none' | 'exact';
  freshness: 'same-process' | 'receipt';
}

export interface ControlFailurePolicyV1 {
  finding: FailureDecision;
  crash: FailureDecision;
  timeout: FailureDecision;
  missing: FailureDecision;
  skipped: FailureDecision;
  cancelled: FailureDecision;
  stale: FailureDecision;
}

export interface ControlRemediationV1 {
  summary: string;
  steps: string[];
  reproduction: string;
}

export interface ControlExceptionPolicyV1 {
  allowed: boolean;
  scope: string;
  approverRole: string | null;
  maxLifetimeSeconds: number | null;
}

export interface ControlRecordV1 {
  id: string;
  policyCategory: ControlDomain;
  domain: ControlDomain;
  owner: string;
  decisionOwner: string;
  implementation: ControlImplementationV1;
  stages: ControlStage[];
  trustClass: TrustClass;
  mode: ControlMode;
  severity: ControlSeverity;
  riskTiers: RiskTier[];
  surfaces: string[];
  dependencies: string[];
  evidence: ControlEvidenceV1;
  failurePolicy: ControlFailurePolicyV1;
  remediation: ControlRemediationV1;
  exceptionPolicy: ControlExceptionPolicyV1;
}

export interface RiskRuleV1 {
  id: string;
  tier: RiskTier;
  reasons: string[];
  pathPrefixes: string[];
}

export interface ControlManifestV1 {
  schemaVersion: 1;
  policyVersion: string;
  controls: ControlRecordV1[];
  requiredSurfaces: string[];
  riskRules: RiskRuleV1[];
  stages: ControlStage[];
  trustClasses: TrustClass[];
  canonicalCommands: Record<string, string[]>;
  outgoingRefPolicy: OutgoingRefPolicyV1 | null;
  resultSchema: 'ci-control-result-v1';
  exceptionSchema: 'ci-control-exception-v1';
}

export type CapabilityAvailability =
  | 'report-only'
  | 'advisory'
  | 'blocking'
  | 'quarantined';

export interface ControlInventoryV1 {
  schemaVersion: 1;
  manifestDigest: string;
  controls: Array<{
    id: string;
    domain: ControlDomain;
    stages: ControlStage[];
    mode: ControlMode;
    severity: ControlSeverity;
    availability: CapabilityAvailability;
    implementation: ControlImplementationV1;
  }>;
  requiredSurfaces: string[];
  absentCapabilityFamilies: string[];
}

export class ControlManifestError extends Error {
  readonly issue: ManifestIssue;

  constructor(issue: ManifestIssue) {
    super(issue.code);
    this.name = 'ControlManifestError';
    this.issue = issue;
  }
}

const domainSet = new Set<string>(CONTROL_DOMAINS);
const stageSet = new Set<string>(CONTROL_STAGES);
const trustSet = new Set<string>(TRUST_CLASSES);
const modeSet = new Set<string>(CONTROL_MODES);
const severitySet = new Set<string>(SEVERITIES);
const riskSet = new Set<string>(RISK_TIERS);
const failureDecisionSet = new Set<string>(FAILURE_DECISIONS);

const TOP_KEYS = [
  'schemaVersion',
  'policyVersion',
  'controls',
  'requiredSurfaces',
  'riskRules',
  'stages',
  'trustClasses',
  'canonicalCommands',
  'outgoingRefPolicy',
  'resultSchema',
  'exceptionSchema',
] as const;
const CONTROL_KEYS = [
  'id',
  'policyCategory',
  'domain',
  'owner',
  'decisionOwner',
  'implementation',
  'stages',
  'trustClass',
  'mode',
  'severity',
  'riskTiers',
  'surfaces',
  'dependencies',
  'evidence',
  'failurePolicy',
  'remediation',
  'exceptionPolicy',
] as const;
const IMPLEMENTATION_KEYS = ['commandId', 'detectorId', 'nativeSchemaVersion'] as const;
const EVIDENCE_KEYS = ['schemaVersion', 'paths', 'digestBinding', 'freshness'] as const;
const FAILURE_KEYS = ['finding', 'crash', 'timeout', 'missing', 'skipped', 'cancelled', 'stale'] as const;
const REMEDIATION_KEYS = ['summary', 'steps', 'reproduction'] as const;
const EXCEPTION_KEYS = ['allowed', 'scope', 'approverRole', 'maxLifetimeSeconds'] as const;
const RISK_RULE_KEYS = ['id', 'tier', 'reasons', 'pathPrefixes'] as const;
const REF_POLICY_KEYS = ['allowedDeleteRefs', 'branchNamespace', 'branchObjectType', 'controlId', 'nonFastForward', 'releaseBranches', 'releaseTagObjectType', 'releaseTagPrefixes', 'remotes', 'schemaVersion', 'unknownRef'] as const;
const APPROVED_REMOTE_KEYS = ['name', 'repositoryId'] as const;

function issue(code: string, path: string, message: string): ManifestIssue {
  return { code, path, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function inspectExactObject(
  value: unknown,
  expectedKeys: readonly string[],
  path: string,
  problems: ManifestIssue[],
): Record<string, unknown> | null {
  if (!isRecord(value)) {
    problems.push(issue('ci.manifest.invalid-object', path, 'expected an object'));
    return null;
  }
  const expected = new Set(expectedKeys);
  let descriptorSafe = true;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      problems.push(issue('ci.manifest.unknown-key', `${path}.<symbol>`, 'symbol manifest keys are forbidden'));
      descriptorSafe = false;
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.enumerable !== true || !('value' in descriptor)) {
      problems.push(issue('ci.manifest.invalid-property', `${path}.${key}`, 'manifest keys must be enumerable data properties'));
      descriptorSafe = false;
    }
    if (!expected.has(key)) problems.push(issue('ci.manifest.unknown-key', `${path}.${key}`, 'unknown manifest key'));
  }
  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      problems.push(issue('ci.manifest.missing-key', `${path}.${key}`, 'required manifest key is missing'));
    }
  }
  if (!descriptorSafe) return null;
  return value;
}

function requiredString(value: unknown, path: string, problems: ManifestIssue[], code = 'ci.manifest.invalid-string'): value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    problems.push(issue(code, path, 'a non-empty string is required'));
    return false;
  }
  return true;
}

function inspectStringMap(value: unknown, path: string, problems: ManifestIssue[]): Record<string, unknown> | null {
  if (!isRecord(value)) {
    problems.push(issue('ci.manifest.invalid-object', path, 'expected an object map'));
    return null;
  }
  let descriptorSafe = true;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      problems.push(issue('ci.manifest.unknown-key', `${path}.<symbol>`, 'symbol manifest keys are forbidden'));
      descriptorSafe = false;
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.enumerable !== true || !('value' in descriptor)) {
      problems.push(issue('ci.manifest.invalid-property', `${path}.${key}`, 'manifest keys must be enumerable data properties'));
      descriptorSafe = false;
    }
  }
  return descriptorSafe ? value : null;
}

function stringArray(
  value: unknown,
  path: string,
  problems: ManifestIssue[],
  options: { nonEmpty?: boolean; enumValues?: Set<string>; unique?: boolean } = {},
): string[] | null {
  if (!Array.isArray(value) || (options.nonEmpty === true && value.length === 0)) {
    problems.push(issue('ci.manifest.invalid-array', path, 'a string array is required'));
    return null;
  }
  const output: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (typeof entry !== 'string' || entry.length === 0) {
      problems.push(issue('ci.manifest.invalid-array', `${path}[${index}]`, 'a non-empty string is required'));
      continue;
    }
    if (options.enumValues !== undefined && !options.enumValues.has(entry)) {
      problems.push(issue('ci.manifest.invalid-enum', `${path}[${index}]`, 'unsupported enum value'));
    }
    if (options.unique !== false && seen.has(entry)) problems.push(issue('ci.manifest.duplicate-value', `${path}[${index}]`, 'duplicate set value'));
    seen.add(entry);
    output.push(entry);
  }
  return output;
}

function enumValue(value: unknown, allowed: Set<string>, path: string, problems: ManifestIssue[]): value is string {
  if (typeof value !== 'string' || !allowed.has(value)) {
    problems.push(issue('ci.manifest.invalid-enum', path, 'unsupported enum value'));
    return false;
  }
  return true;
}

function validateImplementation(value: unknown, path: string, problems: ManifestIssue[]): ControlImplementationV1 | null {
  const record = inspectExactObject(value, IMPLEMENTATION_KEYS, path, problems);
  if (record === null) return null;
  requiredString(record.commandId, `${path}.commandId`, problems);
  requiredString(record.detectorId, `${path}.detectorId`, problems);
  if (record.nativeSchemaVersion !== null && (!Number.isSafeInteger(record.nativeSchemaVersion) || (record.nativeSchemaVersion as number) < 1)) {
    problems.push(issue('ci.manifest.invalid-schema-version', `${path}.nativeSchemaVersion`, 'schema version must be null or a positive integer'));
  }
  return record as unknown as ControlImplementationV1;
}

function validateEvidence(value: unknown, path: string, problems: ManifestIssue[]): ControlEvidenceV1 | null {
  const record = inspectExactObject(value, EVIDENCE_KEYS, path, problems);
  if (record === null) return null;
  if (record.schemaVersion !== null && (!Number.isSafeInteger(record.schemaVersion) || (record.schemaVersion as number) < 1)) {
    problems.push(issue('ci.manifest.invalid-schema-version', `${path}.schemaVersion`, 'schema version must be null or a positive integer'));
  }
  stringArray(record.paths, `${path}.paths`, problems, { nonEmpty: true });
  enumValue(record.digestBinding, new Set(['none', 'exact']), `${path}.digestBinding`, problems);
  enumValue(record.freshness, new Set(['same-process', 'receipt']), `${path}.freshness`, problems);
  if (record.schemaVersion === null && (record.digestBinding !== 'none' || record.freshness !== 'same-process')) {
    problems.push(issue('ci.manifest.evidence-contract-mismatch', path, 'schema-less evidence cannot claim receipt or digest assurance'));
  }
  if (record.schemaVersion !== null && (record.digestBinding !== 'exact' || record.freshness !== 'receipt')) {
    problems.push(issue('ci.manifest.evidence-contract-mismatch', path, 'schema evidence requires exact digest and receipt freshness'));
  }
  return record as unknown as ControlEvidenceV1;
}

function validateFailurePolicy(value: unknown, path: string, problems: ManifestIssue[]): ControlFailurePolicyV1 | null {
  const record = inspectExactObject(value, FAILURE_KEYS, path, problems);
  if (record === null) return null;
  for (const key of FAILURE_KEYS) enumValue(record[key], failureDecisionSet, `${path}.${key}`, problems);
  return record as unknown as ControlFailurePolicyV1;
}

function validateRemediation(value: unknown, path: string, problems: ManifestIssue[]): ControlRemediationV1 | null {
  const record = inspectExactObject(value, REMEDIATION_KEYS, path, problems);
  if (record === null) {
    problems.push(issue('ci.manifest.missing-remediation', path, 'bounded remediation is required'));
    return null;
  }
  const before = problems.length;
  requiredString(record.summary, `${path}.summary`, problems);
  stringArray(record.steps, `${path}.steps`, problems, { nonEmpty: true, unique: false });
  requiredString(record.reproduction, `${path}.reproduction`, problems);
  if (problems.length > before) problems.push(issue('ci.manifest.missing-remediation', path, 'bounded remediation is required'));
  return record as unknown as ControlRemediationV1;
}

function validateExceptionPolicy(value: unknown, path: string, problems: ManifestIssue[]): ControlExceptionPolicyV1 | null {
  const record = inspectExactObject(value, EXCEPTION_KEYS, path, problems);
  if (record === null) return null;
  if (typeof record.allowed !== 'boolean') problems.push(issue('ci.manifest.invalid-exception', `${path}.allowed`, 'allowed must be boolean'));
  requiredString(record.scope, `${path}.scope`, problems);
  if (record.approverRole !== null && !requiredString(record.approverRole, `${path}.approverRole`, problems)) {
    // requiredString records the issue.
  }
  const lifetime = record.maxLifetimeSeconds;
  if (record.allowed === false) {
    if (record.scope !== 'none' || record.approverRole !== null || lifetime !== null) {
      problems.push(issue('ci.manifest.invalid-exception', path, 'non-waivable controls require none/null/null exception fields'));
    }
  } else if (
    record.scope === 'none'
    || typeof record.approverRole !== 'string'
    || record.approverRole.length === 0
    || !Number.isSafeInteger(lifetime)
    || (lifetime as number) <= 0
  ) {
    problems.push(issue('ci.manifest.unbounded-exception', path, 'waivable exceptions require bounded scope, approver, and lifetime'));
  }
  return record as unknown as ControlExceptionPolicyV1;
}

function validateRiskRule(value: unknown, path: string, problems: ManifestIssue[]): void {
  const record = inspectExactObject(value, RISK_RULE_KEYS, path, problems);
  if (record === null) return;
  requiredString(record.id, `${path}.id`, problems);
  enumValue(record.tier, riskSet, `${path}.tier`, problems);
  stringArray(record.reasons, `${path}.reasons`, problems, { nonEmpty: true });
  stringArray(record.pathPrefixes, `${path}.pathPrefixes`, problems, { nonEmpty: true });
}

function validateOutgoingRefPolicy(value: unknown, path: string, problems: ManifestIssue[]): OutgoingRefPolicyV1 | null {
  if (value === null) return null;
  const record = inspectExactObject(value, REF_POLICY_KEYS, path, problems);
  if (record === null) return null;
  if (record.schemaVersion !== 1 || record.controlId !== 'ci.outgoing-ref-policy') {
    problems.push(issue('ci.manifest.invalid-enum', path, 'unsupported outgoing-ref policy identity'));
  }
  if (record.branchNamespace !== 'refs/heads/' || record.branchObjectType !== 'commit' || record.releaseTagObjectType !== 'annotated-tag' || record.nonFastForward !== 'block' || record.unknownRef !== 'inconclusive') {
    problems.push(issue('ci.manifest.invalid-enum', path, 'unsupported outgoing-ref policy value'));
  }
  const releaseBranches = stringArray(record.releaseBranches, `${path}.releaseBranches`, problems, { nonEmpty: true }) ?? [];
  const releaseTagPrefixes = stringArray(record.releaseTagPrefixes, `${path}.releaseTagPrefixes`, problems, { nonEmpty: true }) ?? [];
  const allowedDeleteRefs = stringArray(record.allowedDeleteRefs, `${path}.allowedDeleteRefs`, problems) ?? [];
  for (const [key, values] of [['releaseBranches', releaseBranches], ['allowedDeleteRefs', allowedDeleteRefs]] as const) {
    values.forEach((entry, index) => {
      if (!isValidGitRefName(entry)) problems.push(issue('ci.manifest.invalid-ref', `${path}.${key}[${index}]`, 'invalid reviewed ref identity'));
    });
  }
  releaseTagPrefixes.forEach((entry, index) => {
    if (!entry.startsWith('refs/tags/') || !isValidGitRefName(`${entry}x`)) {
      problems.push(issue('ci.manifest.invalid-ref', `${path}.releaseTagPrefixes[${index}]`, 'invalid release-tag prefix'));
    }
  });
  allowedDeleteRefs.forEach((entry, index) => {
    if (releaseBranches.includes(entry) || releaseTagPrefixes.some((prefix) => entry.startsWith(prefix))) {
      problems.push(issue('ci.manifest.ref-policy-protected-delete', `${path}.allowedDeleteRefs[${index}]`, 'release branches and release tags cannot be deletion exceptions'));
    }
  });
  if (!Array.isArray(record.remotes) || record.remotes.length === 0 || record.remotes.length > 16) {
    problems.push(issue('ci.manifest.invalid-array', `${path}.remotes`, 'a bounded non-empty remote array is required'));
  } else {
    const identities = new Set<string>();
    record.remotes.forEach((entry, index) => {
      const remote = inspectExactObject(entry, APPROVED_REMOTE_KEYS, `${path}.remotes[${index}]`, problems);
      if (remote === null) return;
      requiredString(remote.name, `${path}.remotes[${index}].name`, problems);
      requiredString(remote.repositoryId, `${path}.remotes[${index}].repositoryId`, problems);
      if (typeof remote.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(remote.name)
        || typeof remote.repositoryId !== 'string'
        || !/^[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(remote.repositoryId)) {
        problems.push(issue('ci.manifest.invalid-remote', `${path}.remotes[${index}]`, 'invalid normalized remote identity'));
        return;
      }
      const identity = `${remote.name}\0${remote.repositoryId}`;
      if (identities.has(identity)) problems.push(issue('ci.manifest.duplicate-value', `${path}.remotes[${index}]`, 'duplicate remote identity'));
      identities.add(identity);
    });
  }
  return record as unknown as OutgoingRefPolicyV1;
}

function validateManifest(value: unknown): ManifestIssue[] {
  if (!isRecord(value)) return [issue('ci.manifest.type', '$', 'manifest must be an object')];

  const rawControls = value.controls;
  if (!Array.isArray(rawControls)) return [issue('ci.manifest.invalid-array', '$.controls', 'controls must be an array')];
  if (rawControls.length > MAX_CONTROL_COUNT) {
    return [issue('ci.manifest.count-budget', '$.controls', 'control count exceeds admission budget')];
  }

  const problems: ManifestIssue[] = [];
  const top = inspectExactObject(value, TOP_KEYS, '$', problems);
  if (top === null) return problems;
  if (top.schemaVersion !== 1) problems.push(issue('ci.manifest.invalid-enum', '$.schemaVersion', 'unsupported schema version'));
  requiredString(top.policyVersion, '$.policyVersion', problems);
  if (top.resultSchema !== 'ci-control-result-v1') problems.push(issue('ci.manifest.invalid-enum', '$.resultSchema', 'unsupported result schema'));
  if (top.exceptionSchema !== 'ci-control-exception-v1') problems.push(issue('ci.manifest.invalid-enum', '$.exceptionSchema', 'unsupported exception schema'));

  const requiredSurfaces = stringArray(top.requiredSurfaces, '$.requiredSurfaces', problems, { nonEmpty: true }) ?? [];
  const declaredStages = stringArray(top.stages, '$.stages', problems, { nonEmpty: true, enumValues: stageSet }) ?? [];
  const declaredTrusts = stringArray(top.trustClasses, '$.trustClasses', problems, { nonEmpty: true, enumValues: trustSet }) ?? [];
  const declaredStageSet = new Set(declaredStages);
  const declaredTrustSet = new Set(declaredTrusts);

  if (!Array.isArray(top.riskRules)) problems.push(issue('ci.manifest.invalid-array', '$.riskRules', 'riskRules must be an array'));
  else {
    const riskRuleIds = new Set<string>();
    top.riskRules.forEach((entry, index) => {
      validateRiskRule(entry, `$.riskRules[${index}]`, problems);
      if (!isRecord(entry) || typeof entry.id !== 'string') return;
      if (riskRuleIds.has(entry.id)) problems.push(issue('ci.manifest.duplicate-id', `$.riskRules[${index}].id`, 'duplicate risk rule id'));
      riskRuleIds.add(entry.id);
    });
  }

  const commands = inspectStringMap(top.canonicalCommands, '$.canonicalCommands', problems);
  if (commands !== null) {
    for (const [commandId, command] of Object.entries(commands)) {
      requiredString(commandId, '$.canonicalCommands', problems);
      stringArray(command, `$.canonicalCommands.${commandId}`, problems, { nonEmpty: true, unique: false });
    }
  }
  const outgoingRefPolicy = validateOutgoingRefPolicy(top.outgoingRefPolicy, '$.outgoingRefPolicy', problems);

  const ids = new Set<string>();
  const ownership = new Set<string>();
  const byId = new Map<string, ControlRecordV1>();
  const referencedCommands = new Set<string>();

  for (let index = 0; index < rawControls.length; index += 1) {
    const path = `$.controls[${index}]`;
    const record = inspectExactObject(rawControls[index], CONTROL_KEYS, path, problems);
    if (record === null) continue;
    const idValid = requiredString(record.id, `${path}.id`, problems);
    if (idValid) {
      if (ids.has(record.id as string)) problems.push(issue('ci.manifest.duplicate-id', `${path}.id`, 'duplicate control id'));
      ids.add(record.id as string);
    }
    enumValue(record.policyCategory, domainSet, `${path}.policyCategory`, problems);
    enumValue(record.domain, domainSet, `${path}.domain`, problems);
    requiredString(record.owner, `${path}.owner`, problems, 'ci.manifest.missing-owner');
    requiredString(record.decisionOwner, `${path}.decisionOwner`, problems, 'ci.manifest.missing-owner');
    const implementation = validateImplementation(record.implementation, `${path}.implementation`, problems);
    if (implementation !== null) referencedCommands.add(implementation.commandId);
    const recordStages = stringArray(record.stages, `${path}.stages`, problems, { nonEmpty: true, enumValues: stageSet }) ?? [];
    for (const stage of recordStages) {
      if (!declaredStageSet.has(stage)) problems.push(issue('ci.manifest.stage-not-declared', `${path}.stages`, 'control stage is absent from the manifest stage catalog'));
    }
    if (enumValue(record.trustClass, trustSet, `${path}.trustClass`, problems) && !declaredTrustSet.has(record.trustClass as string)) {
      problems.push(issue('ci.manifest.trust-not-declared', `${path}.trustClass`, 'control trust class is absent from the manifest trust catalog'));
    }
    enumValue(record.mode, modeSet, `${path}.mode`, problems);
    enumValue(record.severity, severitySet, `${path}.severity`, problems);
    stringArray(record.riskTiers, `${path}.riskTiers`, problems, { nonEmpty: true, enumValues: riskSet });
    const surfaces = stringArray(record.surfaces, `${path}.surfaces`, problems, { nonEmpty: true }) ?? [];
    stringArray(record.dependencies, `${path}.dependencies`, problems);
    validateEvidence(record.evidence, `${path}.evidence`, problems);
    validateFailurePolicy(record.failurePolicy, `${path}.failurePolicy`, problems);
    validateRemediation(record.remediation, `${path}.remediation`, problems);
    validateExceptionPolicy(record.exceptionPolicy, `${path}.exceptionPolicy`, problems);

    if (typeof record.policyCategory === 'string' && typeof record.decisionOwner === 'string') {
      for (const surface of surfaces) {
        const key = `${record.policyCategory}\0${surface}\0${record.decisionOwner}`;
        if (ownership.has(key)) problems.push(issue('ci.manifest.duplicate-owner', path, 'conflicting canonical decision ownership'));
        ownership.add(key);
      }
    }
    if (idValid && !byId.has(record.id as string)) byId.set(record.id as string, record as unknown as ControlRecordV1);
  }

  const commandIds = new Set(commands === null ? [] : Object.keys(commands));
  if (commandIds.size !== referencedCommands.size || [...commandIds].some((entry) => !referencedCommands.has(entry))) {
    problems.push(issue('ci.manifest.command-set-mismatch', '$.canonicalCommands', 'canonical command keys must exactly match referenced command IDs'));
  }

  for (const [id, record] of byId) {
    for (const dependency of record.dependencies) {
      if (!byId.has(dependency)) problems.push(issue('ci.manifest.missing-dependency', `$.controls.${id}.dependencies`, 'dependency is not registered'));
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycleIds = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      if (!cycleIds.has(id)) problems.push(issue('ci.manifest.dependency-cycle', `$.controls.${id}`, 'dependency graph contains a cycle'));
      cycleIds.add(id);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) {
      if (byId.has(dependency)) visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id);

  if (outgoingRefPolicy !== null) {
    const owner = byId.get(outgoingRefPolicy.controlId);
    const refCommand = commands?.['ci:ref-policy'];
    if (owner === undefined
      || owner.owner !== 'ci-ref-policy-owner'
      || owner.decisionOwner !== 'outgoing-ref-policy-decision-owner'
      || owner.implementation.commandId !== 'ci:ref-policy'
      || owner.implementation.detectorId !== 'outgoing-ref-policy'
      || owner.implementation.nativeSchemaVersion !== 1
      || owner.mode !== 'assist'
      || owner.trustClass !== 'untrusted-candidate'
      || owner.stages.length !== 1
      || owner.stages[0] !== 'pre-push'
      || owner.surfaces.length !== 1
      || owner.surfaces[0] !== 'outgoing-ref-policy'
      || !Array.isArray(refCommand)
      || refCommand.length !== 3
      || refCommand[0] !== 'bash'
      || refCommand[1] !== 'scripts/run-with-pinned-node.sh'
      || refCommand[2] !== 'scripts/ci-control-ref-policy.ts') {
      problems.push(issue('ci.manifest.ref-policy-control-mismatch', '$.outgoingRefPolicy.controlId', 'outgoing-ref policy must cross-link its report-only canonical control'));
    }
  } else if (byId.has('ci.outgoing-ref-policy')
    || referencedCommands.has('ci:ref-policy')
    || requiredSurfaces.includes('outgoing-ref-policy')) {
    problems.push(issue('ci.manifest.ref-policy-control-mismatch', '$.outgoingRefPolicy', 'registered outgoing-ref capability requires its reviewed policy'));
  }

  const requiredIds = new Set<string>();
  for (const surface of requiredSurfaces) {
    const owners = [...byId.values()].filter((record) => record.surfaces.includes(surface));
    if (owners.length === 0) problems.push(issue('ci.manifest.required-control-unreachable', '$.requiredSurfaces', 'required surface has no registered control'));
    owners.forEach((record) => requiredIds.add(record.id));
  }
  const reachable = new Set<string>();
  const markReachable = (id: string): void => {
    if (reachable.has(id)) return;
    reachable.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) if (byId.has(dependency)) markReachable(dependency);
  };
  requiredIds.forEach(markReachable);
  for (const id of byId.keys()) {
    if (!reachable.has(id)) problems.push(issue('ci.manifest.control-unreachable', `$.controls.${id}`, 'control is not required and does not support a required control'));
  }

  return problems;
}

export function validateControlManifest(value: unknown): ManifestIssue[] {
  try {
    return validateManifest(value);
  } catch {
    return [issue('ci.manifest.traversal-failed', '$', 'manifest traversal failed')];
  }
}

export function parseControlManifestBytes(bytes: Uint8Array): ControlManifestV1 {
  if (bytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new ControlManifestError(issue('ci.manifest.byte-budget', '$', 'manifest exceeds UTF-8 byte budget'));
  }
  const parsed = parseBoundaryJsonBytes(bytes);
  if (!parsed.result.ok || parsed.value === null) {
    const nativeCode = parsed.result.issues[0]?.code ?? 'invalid-json';
    const code = nativeCode === 'duplicate-json-key'
      ? 'ci.manifest.duplicate-json-key'
      : nativeCode === 'invalid-json-byte'
        ? 'ci.manifest.invalid-utf8'
        : 'ci.manifest.invalid-json';
    throw new ControlManifestError(issue(code, '$', 'manifest must be strict JSON with unique object keys'));
  }
  const value = parsed.value;
  const problems = validateControlManifest(value);
  if (problems.length > 0) throw new ControlManifestError(problems[0]!);
  return value as ControlManifestV1;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export function canonicalizeControlManifest(manifest: ControlManifestV1): string {
  const problems = validateControlManifest(manifest);
  if (problems.length > 0) throw new ControlManifestError(problems[0]!);
  const normalized: ControlManifestV1 = {
    ...manifest,
    requiredSurfaces: sorted(manifest.requiredSurfaces),
    stages: sorted(manifest.stages) as ControlStage[],
    trustClasses: sorted(manifest.trustClasses) as TrustClass[],
    controls: [...manifest.controls]
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .map((record) => ({
        ...record,
        stages: sorted(record.stages) as ControlStage[],
        riskTiers: sorted(record.riskTiers) as RiskTier[],
        surfaces: sorted(record.surfaces),
        dependencies: sorted(record.dependencies),
        evidence: { ...record.evidence, paths: sorted(record.evidence.paths) },
        remediation: { ...record.remediation, steps: [...record.remediation.steps] },
      })),
    riskRules: [...manifest.riskRules]
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .map((rule) => ({ ...rule, reasons: sorted(rule.reasons), pathPrefixes: sorted(rule.pathPrefixes) })),
    canonicalCommands: Object.fromEntries(
      Object.keys(manifest.canonicalCommands)
        .sort()
        .map((commandId) => [commandId, [...manifest.canonicalCommands[commandId]!]]),
    ),
    outgoingRefPolicy: manifest.outgoingRefPolicy === null ? null : {
      ...manifest.outgoingRefPolicy,
      remotes: [...manifest.outgoingRefPolicy.remotes]
        .sort((left, right) => `${left.name}\0${left.repositoryId}`.localeCompare(`${right.name}\0${right.repositoryId}`)),
      releaseBranches: sorted(manifest.outgoingRefPolicy.releaseBranches),
      releaseTagPrefixes: sorted(manifest.outgoingRefPolicy.releaseTagPrefixes),
      allowedDeleteRefs: sorted(manifest.outgoingRefPolicy.allowedDeleteRefs),
    },
  };
  return stableJson(normalized);
}

export function digestControlManifest(manifest: ControlManifestV1): string {
  return `sha256:${createHash('sha256').update(canonicalizeControlManifest(manifest), 'utf8').digest('hex')}`;
}

export function loadControlManifest(cwd: string): ControlManifestV1 {
  const bytes = readFileSync(resolve(cwd, 'controls/ci-control-manifest.json'));
  return parseControlManifestBytes(bytes);
}

function availabilityForMode(mode: ControlMode): CapabilityAvailability {
  if (mode === 'block' || mode === 'human-authorization') return 'blocking';
  if (mode === 'warn') return 'advisory';
  if (mode === 'quarantine') return 'quarantined';
  return 'report-only';
}

export function buildControlInventory(manifest: ControlManifestV1): ControlInventoryV1 {
  const problems = validateControlManifest(manifest);
  if (problems.length > 0) throw new ControlManifestError(problems[0]!);
  return {
    schemaVersion: 1,
    manifestDigest: digestControlManifest(manifest),
    controls: [...manifest.controls]
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .map((record) => ({
        id: record.id,
        domain: record.domain,
        stages: sorted(record.stages) as ControlStage[],
        mode: record.mode,
        severity: record.severity,
        availability: availabilityForMode(record.mode),
        implementation: record.implementation,
      })),
    requiredSurfaces: sorted(manifest.requiredSurfaces),
    absentCapabilityFamilies: [
      'artifact-integrity',
      'deployment-safety',
      'portability',
      'protected-policy',
      'scheduled',
    ],
  };
}
