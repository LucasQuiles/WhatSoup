import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { assertNoSecretLike } from '../../artifact-redaction.ts';
import { cleanGitEnv } from '../../../src/lib/git-env.ts';
import { evidenceStateForRule, guidanceForRule } from './rule-guidance.ts';
import type {
  BoundaryAction,
  BoundaryArtifact,
  BoundaryFindingInput,
  BoundaryOverflow,
  BoundaryReceiptBase,
  BoundaryTarget,
  CanonicalBoundaryFinding,
  EnforcementMode,
  EvidenceState,
  FindingDecision,
} from './boundary-types.ts';

export interface BoundaryBudgets {
  maxFindings: number;
  maxObservedPerFinding: number;
  maxArtifactsPerFinding: number;
  maxLimitationsPerFinding: number;
  maxTopLevelLimitations: number;
  maxFingerprints: number;
  maxCanonicalRecords: number;
  maxCorrectionsPerFinding: number;
  maxVerificationPerFinding: number;
  maxSourcesPerFinding: number;
  maxPublicTextBytes: number;
  maxJsonBytes: number;
  maxHumanBytes: number;
  maxHumanReservedSummaryBytes: number;
  maxHumanDetailedFindings: number;
}

export const DEFAULT_BOUNDARY_BUDGETS: Readonly<BoundaryBudgets> = Object.freeze({
  maxFindings: 128,
  maxObservedPerFinding: 64,
  maxArtifactsPerFinding: 16,
  maxLimitationsPerFinding: 8,
  maxTopLevelLimitations: 16,
  maxFingerprints: 64,
  maxCanonicalRecords: 2_048,
  maxCorrectionsPerFinding: 4,
  maxVerificationPerFinding: 8,
  maxSourcesPerFinding: 16,
  maxPublicTextBytes: 512,
  maxJsonBytes: 1024 * 1024,
  maxHumanBytes: 64 * 1024,
  maxHumanReservedSummaryBytes: 16 * 1024,
  maxHumanDetailedFindings: 12,
});

export type BoundaryContractCode =
  | 'boundary.contract-invalid'
  | 'boundary.finding-identity-conflict'
  | 'boundary.artifact-identity-conflict'
  | 'boundary.evidence-volume-exceeded';

export interface BoundaryContractIssue {
  code: BoundaryContractCode;
  fieldPath: string;
  identity: string | null;
  count: number | null;
  descriptorDigestSha256: string | null;
}

interface IssuedBoundaryContractPayload {
  code: BoundaryContractCode;
  issues: readonly BoundaryContractIssue[];
  overflow: BoundaryOverflow | null;
}

const BOUNDARY_CONTRACT_ISSUER = Symbol('boundary-contract-issuer');
const ISSUED_BOUNDARY_ERRORS = new WeakMap<BoundaryContractError, IssuedBoundaryContractPayload>();

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export class BoundaryContractError extends Error {
  readonly code: BoundaryContractCode;
  readonly issues: readonly BoundaryContractIssue[];
  readonly overflow: BoundaryOverflow | null;

  constructor(
    issuer: typeof BOUNDARY_CONTRACT_ISSUER,
    code: BoundaryContractCode,
    issues: readonly BoundaryContractIssue[],
    overflow: BoundaryOverflow | null,
  ) {
    if (issuer !== BOUNDARY_CONTRACT_ISSUER) throw new TypeError('invalid boundary contract issuer');
    super(code);
    this.name = 'BoundaryContractError';
    const payload = deepFreeze(structuredClone({ code, issues, overflow }));
    this.code = payload.code;
    this.issues = deepFreeze(structuredClone(payload.issues));
    this.overflow = payload.overflow === null
      ? null
      : deepFreeze(structuredClone(payload.overflow));
    ISSUED_BOUNDARY_ERRORS.set(this, payload);
    Object.freeze(this.issues);
  }
}

export interface BoundaryEvidenceDigestInput {
  target: BoundaryTarget;
  observedAt: string;
  validUntil: string | null;
  base: BoundaryReceiptBase;
  fingerprints: Record<string, string | null>;
  findings: CanonicalBoundaryFinding[];
  limitations: string[];
  ruleCatalogDigestSha256: string;
}

export const ENFORCEMENT_MODES = ['shadow', 'enforce'] as const;

const FINDING_DECISIONS = new Set<FindingDecision>(['warn', 'block', 'inconclusive']);
const ACTIONS = new Set<BoundaryAction>([
  'commit', 'push', 'open-pr', 'reopen-pr', 'update-pr', 'open-issue',
  'merge', 'tag', 'release', 'config-write',
]);
const EVIDENCE_STATES = new Set<EvidenceState>([
  'observed', 'absent', 'invalid', 'unavailable', 'stale', 'unknown',
]);
const ARTIFACT_KINDS = new Set<BoundaryArtifact['kind']>([
  'pull-request', 'issue', 'commit', 'path',
]);
const CORRECTION_OPERATIONS = new Set([
  'edit', 'reuse', 'remove', 'refresh', 'split', 'retry',
]);
const GIT_OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const LOCAL_PATH_RE =
  /(?:^|[\s'"=([{,:;])\/(?:Users|home|private|tmp|var\/folders)\/[^\s'"\])},;]+/;
const FILE_URL_RE = /(?:^|[\s'"=([{,:;])file:\/\/\/[^\s'"\])},;]+/i;
const URL_CANDIDATE_RE = /https?:\/\/[^\s'"\])},;]+/giu;
const FINDING_KEYS = new Set([
  'ruleId', 'decision', 'action', 'evidenceState', 'summary', 'why',
  'observed', 'matchedArtifacts', 'limitations',
]);
const TARGET_KEYS = new Set(['repository', 'actionTarget', 'headOid']);
const ARTIFACT_KEYS = new Set([
  'kind', 'repository', 'id', 'url', 'state', 'fingerprintSha256',
]);

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function issue(
  code: BoundaryContractCode,
  fieldPath: string,
  identity: string | null = null,
  count: number | null = null,
  descriptorDigestSha256: string | null = null,
): BoundaryContractIssue {
  return { code, fieldPath, identity, count, descriptorDigestSha256 };
}

function issuedError(
  code: BoundaryContractCode,
  issues: readonly BoundaryContractIssue[],
  overflow: BoundaryOverflow | null = null,
): BoundaryContractError {
  return new BoundaryContractError(BOUNDARY_CONTRACT_ISSUER, code, issues, overflow);
}

function contractInvalid(fieldPath: string): BoundaryContractError {
  return issuedError('boundary.contract-invalid', [
    issue('boundary.contract-invalid', fieldPath),
  ]);
}

function emptyInputCounts(): BoundaryOverflow['inputCounts'] {
  return {
    findings: 0,
    observed: 0,
    artifacts: 0,
    limitations: 0,
    fingerprints: 0,
    corrections: 0,
    verification: 0,
    sources: 0,
    canonicalRecords: 0,
  };
}

function volumeExceeded(
  fieldPath: string,
  count: number,
  limit: number,
  inputCounts: BoundaryOverflow['inputCounts'] = emptyInputCounts(),
): BoundaryContractError {
  const descriptorDigestSha256 = sha256(JSON.stringify({
    fieldClass: fieldPath.replace(/\[\d+\]/g, '[]'),
    scalarType: 'structural',
    count,
    limit,
    rejection: 'declared-budget-exceeded',
  }));
  const overflow: BoundaryOverflow = {
    reason: 'boundary.evidence-volume-exceeded',
    inputCounts: { ...inputCounts },
    rejectedBytes: null,
    descriptorDigestSha256,
    digestCoverage: 'bounded-structural-descriptor',
  };
  return issuedError('boundary.evidence-volume-exceeded', [issue(
    'boundary.evidence-volume-exceeded', fieldPath, null, count, descriptorDigestSha256,
  )], overflow);
}

function ownDataRecord(value: unknown, fieldPath: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw contractInvalid(fieldPath);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw contractInvalid(fieldPath);
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw contractInvalid(fieldPath);
  }
  const record: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!('value' in descriptor)) throw contractInvalid(`${fieldPath}.${key}`);
    record[key] = descriptor.value;
  }
  return record;
}

function exactRecord(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  fieldPath: string,
): Record<string, unknown> {
  const record = ownDataRecord(value, fieldPath);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) throw contractInvalid(`${fieldPath}.${key}`);
  }
  return record;
}

function boundedUtf8(value: string, limit: number): boolean {
  const destination = new Uint8Array(limit + 1);
  const result = new TextEncoder().encodeInto(value, destination);
  return result.read === value.length && result.written <= limit;
}

function hasCredentialOrQueryUrl(value: string): boolean {
  for (const match of value.matchAll(URL_CANDIDATE_RE)) {
    try {
      const parsed = new URL(match[0]);
      if (parsed.username || parsed.password || parsed.search) return true;
    } catch {
      continue;
    }
  }
  return false;
}

export function redactBoundaryText(value: string): string {
  try {
    assertNoSecretLike(value, 'boundary public text');
  } catch {
    return 'redacted-sensitive-value';
  }
  if (FILE_URL_RE.test(value) || LOCAL_PATH_RE.test(value)) return 'redacted-local-reference';
  if (hasCredentialOrQueryUrl(value)) return 'redacted-credential-url';
  return value;
}

function requiredText(
  value: unknown,
  fieldPath: string,
  budgets: BoundaryBudgets = DEFAULT_BOUNDARY_BUDGETS,
): string {
  if (typeof value !== 'string') throw contractInvalid(fieldPath);
  if (!boundedUtf8(value, budgets.maxPublicTextBytes)) {
    throw volumeExceeded(fieldPath, value.length, budgets.maxPublicTextBytes);
  }
  const canonical = redactBoundaryText(value)
    .replace(/[\u0000-\u001f\u007f\u001b]+/g, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!canonical) throw contractInvalid(fieldPath);
  if (!boundedUtf8(canonical, budgets.maxPublicTextBytes)) {
    throw volumeExceeded(fieldPath, canonical.length, budgets.maxPublicTextBytes);
  }
  try {
    assertNoSecretLike(canonical, 'boundary canonical public text');
  } catch {
    throw contractInvalid(fieldPath);
  }
  if (FILE_URL_RE.test(canonical) || LOCAL_PATH_RE.test(canonical)) {
    throw contractInvalid(fieldPath);
  }
  return canonical;
}

function boundedArray(value: unknown, fieldPath: string, limit: number): unknown[] {
  if (!Array.isArray(value)) throw contractInvalid(fieldPath);
  if (value.length > limit) throw volumeExceeded(fieldPath, value.length, limit);
  return value;
}

function canonicalTextArray(
  value: unknown,
  fieldPath: string,
  limit: number,
  budgets: BoundaryBudgets = DEFAULT_BOUNDARY_BUDGETS,
): string[] {
  const input = boundedArray(value, fieldPath, limit);
  const canonical: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < input.length; index += 1) {
    const text = requiredText(input[index], `${fieldPath}[${index}]`, budgets);
    if (seen.has(text)) throw contractInvalid(`${fieldPath}[${index}]`);
    seen.add(text);
    canonical.push(text);
  }
  return canonical;
}

export function canonicalBoundaryLimitations(input: unknown): string[] {
  return canonicalTextArray(
    input,
    'limitations',
    DEFAULT_BOUNDARY_BUDGETS.maxTopLevelLimitations,
  );
}

function canonicalObserved(input: unknown, budgets: BoundaryBudgets): Array<{
  label: string;
  value: string;
}> {
  const records = boundedArray(input, 'finding.observed', budgets.maxObservedPerFinding);
  const canonical = records.map((value, index) => {
    const record = exactRecord(value, new Set(['label', 'value']), `finding.observed[${index}]`);
    return {
      label: requiredText(record.label, `finding.observed[${index}].label`, budgets),
      value: requiredText(record.value, `finding.observed[${index}].value`, budgets),
    };
  });
  canonical.sort((left, right) => left.label.localeCompare(right.label)
    || left.value.localeCompare(right.value));
  for (let index = 1; index < canonical.length; index += 1) {
    if (canonical[index - 1]?.label === canonical[index]?.label
      && canonical[index - 1]?.value === canonical[index]?.value) {
      throw contractInvalid('finding.observed');
    }
  }
  return canonical;
}

function canonicalArtifact(
  value: unknown,
  index: number,
  budgets: BoundaryBudgets,
): BoundaryArtifact {
  const fieldPath = `finding.matchedArtifacts[${index}]`;
  const record = exactRecord(value, ARTIFACT_KEYS, fieldPath);
  if (!ARTIFACT_KINDS.has(record.kind as BoundaryArtifact['kind'])) {
    throw contractInvalid(`${fieldPath}.kind`);
  }
  if (record.repository !== 'LucasQuiles/WhatSoup') {
    throw contractInvalid(`${fieldPath}.repository`);
  }
  const artifact: BoundaryArtifact = {
    kind: record.kind as BoundaryArtifact['kind'],
    repository: 'LucasQuiles/WhatSoup',
    id: requiredText(record.id, `${fieldPath}.id`, budgets),
  };
  if (record.url !== undefined) {
    artifact.url = requiredText(record.url, `${fieldPath}.url`, budgets);
  }
  if (record.state !== undefined) {
    artifact.state = requiredText(record.state, `${fieldPath}.state`, budgets);
  }
  if (record.fingerprintSha256 !== undefined) {
    if (typeof record.fingerprintSha256 !== 'string'
      || !SHA256_RE.test(record.fingerprintSha256)) {
      throw contractInvalid(`${fieldPath}.fingerprintSha256`);
    }
    artifact.fingerprintSha256 = record.fingerprintSha256;
  }
  return artifact;
}

function canonicalArtifacts(input: unknown, budgets: BoundaryBudgets): BoundaryArtifact[] {
  const records = boundedArray(input, 'finding.matchedArtifacts', budgets.maxArtifactsPerFinding);
  const artifacts = records.map((value, index) => canonicalArtifact(value, index, budgets));
  artifacts.sort((left, right) => left.kind.localeCompare(right.kind)
    || left.repository.localeCompare(right.repository)
    || left.id.localeCompare(right.id)
    || JSON.stringify(left).localeCompare(JSON.stringify(right)));
  for (let index = 1; index < artifacts.length; index += 1) {
    const left = artifacts[index - 1]!;
    const right = artifacts[index]!;
    if (left.kind === right.kind && left.repository === right.repository && left.id === right.id) {
      const identity = `${right.kind}:${sha256(`${right.repository}\0${right.id}`)}`;
      throw issuedError('boundary.artifact-identity-conflict', [issue(
        'boundary.artifact-identity-conflict', 'finding.matchedArtifacts', identity, 2,
      )]);
    }
  }
  return artifacts;
}

function canonicalGuidance(ruleId: string, budgets: BoundaryBudgets) {
  let guidance;
  try {
    guidance = guidanceForRule(ruleId);
  } catch {
    throw contractInvalid('finding.ruleId');
  }
  if (guidance.correction.length > budgets.maxCorrectionsPerFinding) {
    throw volumeExceeded(
      'finding.correction', guidance.correction.length, budgets.maxCorrectionsPerFinding,
    );
  }
  if (guidance.verification.length > budgets.maxVerificationPerFinding) {
    throw volumeExceeded(
      'finding.verification', guidance.verification.length, budgets.maxVerificationPerFinding,
    );
  }
  if (guidance.sourceRefs.length > budgets.maxSourcesPerFinding) {
    throw volumeExceeded('finding.sourceRefs', guidance.sourceRefs.length, budgets.maxSourcesPerFinding);
  }
  const correction = guidance.correction.map((step, index) => {
    if (!CORRECTION_OPERATIONS.has(step.operation)) {
      throw contractInvalid(`finding.correction[${index}].operation`);
    }
    return {
      operation: step.operation,
      target: requiredText(step.target, `finding.correction[${index}].target`, budgets),
      expected: requiredText(step.expected, `finding.correction[${index}].expected`, budgets),
    };
  });
  const verification = guidance.verification.map((step, index) => ({
    command: requiredText(step.command, `finding.verification[${index}].command`, budgets),
    args: canonicalTextArray(
      step.args,
      `finding.verification[${index}].args`,
      budgets.maxSourcesPerFinding,
      budgets,
    ),
    expected: requiredText(step.expected, `finding.verification[${index}].expected`, budgets),
  }));
  return {
    ruleVersion: guidance.ruleVersion,
    expected: canonicalTextArray(guidance.expected, 'finding.expected', 8, budgets),
    impact: canonicalTextArray(guidance.impact, 'finding.impact', 8, budgets),
    safeControls: canonicalTextArray(guidance.safeControls, 'finding.safeControls', 8, budgets),
    correction,
    verification,
    rerun: {
      command: requiredText(guidance.rerun.command, 'finding.rerun.command', budgets),
      args: canonicalTextArray(
        guidance.rerun.args,
        'finding.rerun.args',
        budgets.maxSourcesPerFinding,
        budgets,
      ),
    },
    rerunPurpose: guidance.rerunPurpose,
    sourceRefs: canonicalTextArray(
      guidance.sourceRefs,
      'finding.sourceRefs',
      budgets.maxSourcesPerFinding,
      budgets,
    ),
  };
}

export function canonicalBoundaryFinding(input: BoundaryFindingInput): CanonicalBoundaryFinding {
  const budgets = DEFAULT_BOUNDARY_BUDGETS;
  const record = exactRecord(input, FINDING_KEYS, 'finding');
  const ruleId = requiredText(record.ruleId, 'finding.ruleId', budgets);
  if (!FINDING_DECISIONS.has(record.decision as FindingDecision)) {
    throw contractInvalid('finding.decision');
  }
  if (!ACTIONS.has(record.action as BoundaryAction)) throw contractInvalid('finding.action');
  if (!EVIDENCE_STATES.has(record.evidenceState as EvidenceState)) {
    throw contractInvalid('finding.evidenceState');
  }
  let expectedEvidenceState: EvidenceState;
  try {
    expectedEvidenceState = evidenceStateForRule(ruleId);
  } catch {
    throw contractInvalid('finding.ruleId');
  }
  if (record.evidenceState !== expectedEvidenceState) {
    throw contractInvalid('finding.evidenceState');
  }
  const summary = requiredText(record.summary, 'finding.summary', budgets);
  const why = requiredText(record.why, 'finding.why', budgets);
  const observed = canonicalObserved(record.observed, budgets);
  const matchedArtifacts = canonicalArtifacts(record.matchedArtifacts, budgets);
  const limitations = canonicalTextArray(
    record.limitations ?? [],
    'finding.limitations',
    budgets.maxLimitationsPerFinding,
    budgets,
  );
  const guidance = canonicalGuidance(ruleId, budgets);
  const decision = limitations.length === 0
    ? record.decision as FindingDecision
    : 'inconclusive';
  const digestInput = {
    ruleId,
    ruleVersion: guidance.ruleVersion,
    action: record.action as BoundaryAction,
    decision,
    evidenceState: record.evidenceState as EvidenceState,
    observed,
    matchedArtifacts: matchedArtifacts.map((artifact) => ({
      kind: artifact.kind,
      repository: artifact.repository,
      id: artifact.id,
      url: artifact.url ?? null,
      state: artifact.state ?? null,
      fingerprintSha256: artifact.fingerprintSha256 ?? null,
    })),
    limitations,
  };
  return {
    ruleId,
    decision,
    action: record.action as BoundaryAction,
    evidenceState: record.evidenceState as EvidenceState,
    summary,
    why,
    observed,
    matchedArtifacts,
    limitations,
    ...guidance,
    findingDigestSha256: sha256(JSON.stringify(digestInput)),
  };
}

function validGitRef(ref: string): boolean {
  if (!ref.startsWith('refs/')) return false;
  try {
    execFileSync('git', ['check-ref-format', ref], {
      env: cleanGitEnv(),
      stdio: 'ignore',
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

function validTargetForAction(action: BoundaryAction, actionTarget: string, headOid: string | null) {
  switch (action) {
    case 'commit': {
      const match = /^commit:([0-9a-f]{40}|[0-9a-f]{64})$/.exec(actionTarget);
      return match !== null && match[1] === headOid;
    }
    case 'push':
      return actionTarget.startsWith('ref:') && validGitRef(actionTarget.slice(4));
    case 'open-pr': {
      if (!actionTarget.startsWith('pr-create:')) return false;
      const refs = actionTarget.slice('pr-create:'.length).split('..');
      return refs.length === 2 && refs.every(validGitRef);
    }
    case 'reopen-pr':
    case 'update-pr':
    case 'merge':
      return /^pr:[1-9][0-9]*$/.test(actionTarget);
    case 'open-issue':
      return /^task:[0-9a-f]{64}$/.test(actionTarget);
    case 'tag':
      return actionTarget.startsWith('tag:refs/tags/')
        && validGitRef(actionTarget.slice('tag:'.length));
    case 'release':
      return actionTarget.startsWith('release:refs/tags/')
        && validGitRef(actionTarget.slice('release:'.length));
    case 'config-write':
      return /^config:[0-9a-f]{64}$/.test(actionTarget) && headOid === null;
  }
}

export function canonicalBoundaryTarget(action: BoundaryAction, input: unknown): BoundaryTarget {
  if (!ACTIONS.has(action)) throw contractInvalid('target.action');
  const record = exactRecord(input, TARGET_KEYS, 'target');
  if (record.repository !== 'LucasQuiles/WhatSoup') throw contractInvalid('target.repository');
  if (typeof record.actionTarget !== 'string' || record.actionTarget.trim() !== record.actionTarget
    || record.actionTarget.length === 0) {
    throw contractInvalid('target.actionTarget');
  }
  if (action === 'config-write') {
    if (record.headOid !== null) throw contractInvalid('target.headOid');
  } else if (typeof record.headOid !== 'string' || !GIT_OID_RE.test(record.headOid)) {
    throw contractInvalid('target.headOid');
  }
  const headOid = record.headOid as string | null;
  if (!validTargetForAction(action, record.actionTarget, headOid)) {
    throw contractInvalid('target.actionTarget');
  }
  return {
    repository: 'LucasQuiles/WhatSoup',
    actionTarget: record.actionTarget,
    headOid,
  };
}

export function canonicalEnforcementMode(input: unknown): EnforcementMode {
  if (input !== 'shadow' && input !== 'enforce') throw contractInvalid('enforcementMode');
  return input;
}

function canonicalTimestamp(value: unknown, fieldPath: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw contractInvalid(fieldPath);
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw contractInvalid(fieldPath);
  return new Date(time).toISOString();
}

function optionalOid(value: unknown, fieldPath: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !GIT_OID_RE.test(value)) throw contractInvalid(fieldPath);
  return value;
}

export function evidenceDigestSha256(input: BoundaryEvidenceDigestInput): string {
  const observedAt = canonicalTimestamp(input.observedAt, 'evidence.observedAt');
  const validUntil = input.validUntil === null
    ? null
    : canonicalTimestamp(input.validUntil, 'evidence.validUntil');
  if (validUntil !== null && validUntil <= observedAt) throw contractInvalid('evidence.validUntil');
  if (!SHA256_RE.test(input.ruleCatalogDigestSha256)) {
    throw contractInvalid('evidence.ruleCatalogDigestSha256');
  }
  const fingerprints = Object.fromEntries(Object.entries(input.fingerprints)
    .map(([key, value]) => [
      requiredText(key, 'evidence.fingerprints.key'),
      value === null ? null : optionalOid(value, 'evidence.fingerprints.value'),
    ] as const)
    .sort(([left], [right]) => left.localeCompare(right)));
  const canonical = {
    target: input.target,
    observedAt,
    validUntil,
    base: {
      headOid: optionalOid(input.base.headOid, 'evidence.base.headOid'),
      baseOid: optionalOid(input.base.baseOid, 'evidence.base.baseOid'),
      mergeBaseOid: optionalOid(input.base.mergeBaseOid, 'evidence.base.mergeBaseOid'),
      evidenceSource: requiredText(input.base.evidenceSource, 'evidence.base.evidenceSource'),
    },
    fingerprints,
    findings: [...input.findings]
      .sort((left, right) => left.findingDigestSha256.localeCompare(right.findingDigestSha256))
      .map((finding) => finding.findingDigestSha256),
    limitations: canonicalBoundaryLimitations(input.limitations),
    ruleCatalogDigestSha256: input.ruleCatalogDigestSha256,
  };
  return sha256(JSON.stringify(canonical));
}

function checkedAdd(left: number, right: number, limit: number): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || right < 0 || left > limit - right) {
    throw volumeExceeded('receipt.canonicalRecords', left + right, limit);
  }
  return left + right;
}

export function assertReceiptWithinBudgets(
  receipt: unknown,
  budgets: BoundaryBudgets = DEFAULT_BOUNDARY_BUDGETS,
): void {
  const record = ownDataRecord(receipt, 'receipt');
  const findings = boundedArray(record.findings, 'receipt.findings', budgets.maxFindings);
  const limitations = boundedArray(
    record.limitations,
    'receipt.limitations',
    budgets.maxTopLevelLimitations,
  );
  const fingerprints = ownDataRecord(record.fingerprints, 'receipt.fingerprints');
  const fingerprintCount = Object.keys(fingerprints).length;
  if (fingerprintCount > budgets.maxFingerprints) {
    throw volumeExceeded('receipt.fingerprints', fingerprintCount, budgets.maxFingerprints);
  }
  const counts = emptyInputCounts();
  counts.findings = findings.length;
  counts.limitations = limitations.length;
  counts.fingerprints = fingerprintCount;
  let canonicalRecords = checkedAdd(limitations.length, fingerprintCount, budgets.maxCanonicalRecords);
  for (let index = 0; index < findings.length; index += 1) {
    const finding = ownDataRecord(findings[index], `receipt.findings[${index}]`);
    const observed = boundedArray(
      finding.observed,
      `receipt.findings[${index}].observed`,
      budgets.maxObservedPerFinding,
    );
    const artifacts = boundedArray(
      finding.matchedArtifacts,
      `receipt.findings[${index}].matchedArtifacts`,
      budgets.maxArtifactsPerFinding,
    );
    const findingLimitations = boundedArray(
      finding.limitations,
      `receipt.findings[${index}].limitations`,
      budgets.maxLimitationsPerFinding,
    );
    const corrections = boundedArray(
      finding.correction,
      `receipt.findings[${index}].correction`,
      budgets.maxCorrectionsPerFinding,
    );
    const verification = boundedArray(
      finding.verification,
      `receipt.findings[${index}].verification`,
      budgets.maxVerificationPerFinding,
    );
    const sources = boundedArray(
      finding.sourceRefs,
      `receipt.findings[${index}].sourceRefs`,
      budgets.maxSourcesPerFinding,
    );
    counts.observed += observed.length;
    counts.artifacts += artifacts.length;
    counts.limitations += findingLimitations.length;
    counts.corrections += corrections.length;
    counts.verification += verification.length;
    counts.sources += sources.length;
    canonicalRecords = checkedAdd(
      canonicalRecords,
      1 + observed.length + artifacts.length + findingLimitations.length
        + corrections.length + verification.length + sources.length,
      budgets.maxCanonicalRecords,
    );
  }
  counts.canonicalRecords = canonicalRecords;
  if (canonicalRecords > budgets.maxCanonicalRecords) {
    throw volumeExceeded(
      'receipt.canonicalRecords', canonicalRecords, budgets.maxCanonicalRecords, counts,
    );
  }
  const json = JSON.stringify(receipt);
  if (!boundedUtf8(json, budgets.maxJsonBytes)) {
    throw volumeExceeded('receipt.json', json.length, budgets.maxJsonBytes, counts);
  }
}
