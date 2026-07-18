import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { assertNoSecretLike } from '../../artifact-redaction.ts';
import { cleanGitEnv } from '../../../src/lib/git-env.ts';
import { fsyncDirectory, privateWriteError } from '../../../src/lib/private-fs.ts';
import type {
  BoundaryAction,
  BoundaryActionV1,
  BoundaryArtifact,
  BoundaryDecision,
  BoundaryFinding,
  BoundaryFindingInput,
  BoundaryOverflow,
  BoundaryReceiptBase,
  BoundaryTarget,
  CanonicalBoundaryFinding,
} from './boundary-types.ts';
import {
  assertReceiptWithinBudgets,
  BoundaryContractError,
  DEFAULT_BOUNDARY_BUDGETS,
  canonicalBoundaryFinding,
  canonicalBoundaryLimitations,
  canonicalBoundaryTarget,
  canonicalEnforcementMode,
  evidenceDigestSha256,
} from './boundary-contract.ts';
import type { CandidateTree } from './git-tree.ts';
import { isValidHistoryTimestamp } from './history-provider.ts';
import {
  semanticPolicyEvidenceState,
  type SemanticPolicyFinding,
} from './policy.ts';
import { evidenceStateForRule, ruleCatalogDigestSha256 } from './rule-guidance.ts';

export type {
  BoundaryAction,
  BoundaryArtifact,
  BoundaryDecision,
  BoundaryEvidenceRecord,
  BoundaryFinding,
} from './boundary-types.ts';
export type { EnforcementMode } from './boundary-types.ts';
import type { EnforcementMode } from './boundary-types.ts';

export interface BoundaryReceiptV1 {
  schemaVersion: 1;
  repository: 'LucasQuiles/WhatSoup';
  invocation: string;
  action?: BoundaryActionV1;
  correlationIdSha256?: string;
  enforcementMode: EnforcementMode;
  decision: BoundaryDecision;
  base: {
    headOid: string | null;
    baseOid: string | null;
    mergeBaseOid: string | null;
    evidenceSource: string;
  };
  fingerprints: Record<string, string | null>;
  findings: BoundaryFinding[];
  limitations: string[];
}

export interface BoundaryReceiptV2 {
  schemaVersion: 2;
  repository: 'LucasQuiles/WhatSoup';
  invocation: string;
  action: BoundaryAction;
  target: BoundaryTarget;
  observedAt: string;
  validUntil: string | null;
  correlationIdSha256: string;
  ruleCatalogDigestSha256: string;
  evidenceDigestSha256: string;
  enforcementMode: EnforcementMode;
  decision: BoundaryDecision;
  base: BoundaryReceiptBase;
  fingerprints: Record<string, string | null>;
  findings: CanonicalBoundaryFinding[];
  limitations: string[];
  overflow: BoundaryOverflow | null;
}

export type BoundaryReceipt = BoundaryReceiptV1 | BoundaryReceiptV2;

export interface BuildBoundaryReceiptInput {
  invocation: string;
  action: BoundaryAction;
  target: BoundaryTarget;
  observedAt: string;
  validUntil?: string | null;
  enforcementMode: EnforcementMode;
  base: BoundaryReceiptBase;
  fingerprints?: Record<string, string | null>;
  findings: BoundaryFindingInput[];
  limitations?: string[];
}

export interface BuildSemanticReceiptInput {
  tree: CandidateTree;
  policyFindings: SemanticPolicyFinding[];
  enforcementMode: EnforcementMode;
  evidenceSource: string;
  limitations?: string[];
  now?: Date;
  targetRef: string | null;
}

interface FindingLanguage {
  summary: string;
  why: string;
}

const FINDING_LANGUAGE: Record<SemanticPolicyFinding['ruleId'], FindingLanguage> = {
  'semantic.production-reachability': {
    summary: 'A changed production module is not reachable from a declared runtime root.',
    why: 'Tests or isolated declarations do not prove that a production composition path owns this module.',
  },
  'semantic.export-ownership': {
    summary: 'A reachable module exposes a runtime export without a production owner.',
    why: 'An exported declaration can survive refactoring even after every runtime caller has been removed.',
  },
  'semantic.unresolved-runtime-edge': {
    summary: 'A changed production module contains an unresolved relative runtime edge.',
    why: 'An unresolved literal import prevents the exact runtime graph from proving the intended production path.',
  },
  'semantic.invalid-allowlist': {
    summary: 'The semantic quality allowlist is missing, malformed, duplicated, or expired.',
    why: 'An invalid override record could hide evidence without a current owner, reason, expiry, and re-entry condition.',
  },
  'semantic.candidate-unavailable': {
    summary: 'The requested candidate revision could not be resolved.',
    why: 'Without an exact candidate tree and head identity, semantic reachability and ownership analysis cannot produce a clean result.',
  },
  'semantic.policy-unavailable': {
    summary: 'The semantic quality policy could not be read or parsed.',
    why: 'Unreadable policy evidence leaves production roots, source scope, and owner exceptions unknown.',
  },
  'semantic.source-tree-unavailable': {
    summary: 'The candidate source tree or a configured production root is incomplete.',
    why: 'A missing source inventory or runtime root prevents the graph from proving which production composition paths exist.',
  },
  'semantic.analysis-unavailable': {
    summary: 'Semantic graph analysis could not complete.',
    why: 'A parse, graph, reachability, or ownership failure makes partial semantic conclusions unsafe.',
  },
  'semantic.invocation-invalid': {
    summary: 'The semantic quality invocation is invalid.',
    why: 'Unknown, conflicting, or missing CLI arguments mean the requested boundary scope was not established.',
  },
  'semantic.receipt-write-failed': {
    summary: 'The boundary receipt could not be written durably.',
    why: 'Analysis without an atomic durable receipt cannot prove what evidence and decision reached the enforcement boundary.',
  },
};

function findingFromPolicy(
  finding: SemanticPolicyFinding,
): BoundaryFindingInput {
  const language = FINDING_LANGUAGE[finding.ruleId];
  return {
    ruleId: finding.ruleId,
    decision: finding.decision,
    action: 'push',
    evidenceState: semanticPolicyEvidenceState(finding),
    summary: language.summary,
    why: language.why,
    observed: [
      ...finding.paths.map((value) => ({ label: 'path', value })),
      ...finding.evidence,
    ],
    matchedArtifacts: [],
    limitations: [],
  };
}

function receiptText(value: string): string {
  const text = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 2_000);
  try {
    assertNoSecretLike(text, 'boundary receipt');
    return text;
  } catch {
    return 'redacted-sensitive-value';
  }
}

function receiptReference(value: string): string {
  const text = receiptText(value);
  if (text === 'redacted-sensitive-value' || text.length === 0 || path.isAbsolute(text)) {
    return 'boundary-reference:redacted';
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      const parsed = new URL(text);
      if (parsed.username || parsed.password || parsed.search) {
        return 'boundary-reference:redacted';
      }
    } catch {
      return 'boundary-reference:redacted';
    }
  }
  return text;
}

function sortedFingerprints(
  fingerprints: Record<string, string | null> | undefined,
): Record<string, string | null> {
  const entries = Object.entries(fingerprints ?? {}).map(([key, value]) => {
    const canonicalKey = receiptText(key);
    if (canonicalKey !== key || canonicalKey.length === 0) invalidContract(`fingerprints.${key}`);
    if (value !== null && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
      invalidContract(`fingerprints.${key}`);
    }
    return [canonicalKey, value] as const;
  });
  entries.sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries);
}

function correlationIdSha256(input: {
  invocation: string;
  action: BoundaryAction;
  enforcementMode: EnforcementMode;
  target: BoundaryTarget;
  evidenceDigestSha256: string;
}): string {
  const tuple = {
    schemaVersion: 2,
    repository: 'LucasQuiles/WhatSoup',
    invocation: input.invocation,
    action: input.action,
    enforcementMode: input.enforcementMode,
    target: input.target,
    evidenceDigestSha256: input.evidenceDigestSha256,
  };
  return createHash('sha256').update(JSON.stringify(tuple)).digest('hex');
}

function invalidContract(_fieldPath: string): never {
  return canonicalEnforcementMode('__boundary_contract_invalid__' as never) as never;
}

function ownDataRecord(value: unknown, fieldPath: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    invalidContract(fieldPath);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !('value' in descriptor)) invalidContract(`${fieldPath}.${key}`);
  }
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
  );
}

function exactKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, field: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) invalidContract(`${field}.${key}`);
  }
}

function canonicalTimestamp(value: unknown, fieldPath: string): string {
  if (!isValidHistoryTimestamp(value)) invalidContract(fieldPath);
  return new Date(value).toISOString();
}

function canonicalOid(value: unknown, fieldPath: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    invalidContract(fieldPath);
  }
  return value;
}

function canonicalBase(input: unknown): BoundaryReceiptBase {
  const record = ownDataRecord(input, 'base');
  exactKeys(record, new Set(['headOid', 'baseOid', 'mergeBaseOid', 'evidenceSource']), 'base');
  if (!Object.hasOwn(record, 'headOid') || !Object.hasOwn(record, 'baseOid')
    || !Object.hasOwn(record, 'mergeBaseOid') || !Object.hasOwn(record, 'evidenceSource')) {
    invalidContract('base');
  }
  if (typeof record.evidenceSource !== 'string'
    || receiptReference(record.evidenceSource) !== record.evidenceSource) {
    invalidContract('base.evidenceSource');
  }
  return {
    headOid: canonicalOid(record.headOid, 'base.headOid'),
    baseOid: canonicalOid(record.baseOid, 'base.baseOid'),
    mergeBaseOid: canonicalOid(record.mergeBaseOid, 'base.mergeBaseOid'),
    evidenceSource: record.evidenceSource,
  };
}

function findingInput(item: CanonicalBoundaryFinding): BoundaryFindingInput {
  const record = item as unknown as Record<string, unknown>;
  const ruleId = String(record.ruleId ?? '');
  const limitations = Array.isArray(record.limitations) ? record.limitations : [];
  return {
    ruleId,
    decision: record.decision as BoundaryFindingInput['decision'],
    action: record.action as BoundaryAction,
    evidenceState: record.evidenceState as BoundaryFindingInput['evidenceState'],
    summary: record.summary as string,
    why: record.why as string,
    observed: record.observed as BoundaryFindingInput['observed'],
    matchedArtifacts: record.matchedArtifacts as BoundaryFindingInput['matchedArtifacts'],
    limitations: limitations as string[],
  };
}

function canonicalFindings(
  input: BoundaryFindingInput[],
  action: BoundaryAction,
  limitations: string[],
): CanonicalBoundaryFinding[] {
  const findings = input.map((item) => canonicalBoundaryFinding(item));
  for (const finding of findings) {
    if (finding.action !== action) invalidContract('findings.action');
    if (finding.limitations.length > 0 && finding.decision !== 'inconclusive') {
      invalidContract('findings.limitations');
    }
  }
  if (limitations.length > 0
    && !findings.some((finding) => finding.ruleId === 'boundary.evidence-incomplete')) {
    const limitationDigest = createHash('sha256')
      .update(JSON.stringify(limitations))
      .digest('hex');
    findings.push(canonicalBoundaryFinding({
      ruleId: 'boundary.evidence-incomplete',
      decision: 'inconclusive',
      action,
      evidenceState: evidenceStateForRule('boundary.evidence-incomplete'),
      summary: 'Boundary evidence collection is incomplete.',
      why: 'One or more collection-wide limitations prevent a complete decision.',
      observed: [
        { label: 'limitation_count', value: String(limitations.length) },
        { label: 'limitation_digest_sha256', value: limitationDigest },
      ],
      matchedArtifacts: [],
      limitations: [],
    }));
  }
  findings.sort((left, right) => left.ruleId.localeCompare(right.ruleId)
    || left.findingDigestSha256.localeCompare(right.findingDigestSha256));
  for (let index = 1; index < findings.length; index += 1) {
    const left = findings[index - 1]!;
    const right = findings[index]!;
    if (left.ruleId === right.ruleId
      && left.findingDigestSha256 === right.findingDigestSha256) {
      invalidContract('findings.identity');
    }
  }
  return findings;
}

const BUILD_INPUT_KEYS = new Set([
  'invocation', 'action', 'target', 'observedAt', 'validUntil', 'enforcementMode',
  'base', 'fingerprints', 'findings', 'limitations',
]);

function volumeExceededFinding(
  action: BoundaryAction,
  overflow: BoundaryOverflow,
): BoundaryFindingInput {
  return {
    ruleId: 'boundary.evidence-volume-exceeded',
    decision: 'inconclusive',
    action,
    evidenceState: evidenceStateForRule('boundary.evidence-volume-exceeded'),
    summary: 'Boundary evidence exceeded the declared receipt budget.',
    why: 'Rejected evidence cannot be silently truncated or treated as a complete clean result.',
    observed: [
      { label: 'finding_count', value: String(overflow.inputCounts.findings) },
      { label: 'observation_count', value: String(overflow.inputCounts.observed) },
      { label: 'artifact_count', value: String(overflow.inputCounts.artifacts) },
      { label: 'rejected_bytes', value: String(overflow.rejectedBytes ?? 'not-materialized') },
      { label: 'descriptor_sha256', value: overflow.descriptorDigestSha256 },
      { label: 'digest_coverage', value: overflow.digestCoverage },
    ],
    matchedArtifacts: [],
    limitations: ['The rejected evidence was not admitted into the canonical receipt.'],
  };
}

function buildBoundaryReceiptStrict(
  input: BuildBoundaryReceiptInput,
  overflow: BoundaryOverflow | null,
): BoundaryReceiptV2 {
  const inputRecord = ownDataRecord(input, 'receiptInput');
  exactKeys(inputRecord, BUILD_INPUT_KEYS, 'receiptInput');
  if (typeof input.invocation !== 'string' || receiptText(input.invocation) !== input.invocation
    || input.invocation.length === 0) {
    invalidContract('invocation');
  }
  const enforcementMode = canonicalEnforcementMode(input.enforcementMode);
  const target = canonicalBoundaryTarget(input.action, input.target);
  const observedAt = canonicalTimestamp(input.observedAt, 'observedAt');
  const validUntil = input.validUntil == null
    ? null
    : canonicalTimestamp(input.validUntil, 'validUntil');
  if (validUntil !== null && validUntil < observedAt) invalidContract('validUntil');
  const fingerprints = sortedFingerprints(input.fingerprints);
  const limitations = canonicalBoundaryLimitations(input.limitations ?? []);
  const findings = canonicalFindings(input.findings, input.action, limitations);
  const base = canonicalBase(input.base);
  if (input.action !== 'config-write' && target.headOid !== base.headOid) {
    invalidContract('target.headOid');
  }
  const catalogDigest = ruleCatalogDigestSha256();
  const evidenceDigest = evidenceDigestSha256({
    target,
    observedAt,
    validUntil,
    base,
    fingerprints,
    findings,
    limitations,
    ruleCatalogDigestSha256: catalogDigest,
  });
  const receipt: BoundaryReceiptV2 = {
    schemaVersion: 2,
    repository: 'LucasQuiles/WhatSoup',
    invocation: input.invocation,
    action: input.action,
    target,
    observedAt,
    validUntil,
    correlationIdSha256: correlationIdSha256({
      invocation: input.invocation,
      action: input.action,
      enforcementMode,
      target,
      evidenceDigestSha256: evidenceDigest,
    }),
    ruleCatalogDigestSha256: catalogDigest,
    evidenceDigestSha256: evidenceDigest,
    enforcementMode,
    decision: aggregateBoundaryDecision(findings, limitations),
    base,
    fingerprints,
    findings,
    limitations,
    overflow,
  };
  assertReceiptWithinBudgets(receipt);
  return receipt;
}

function buildVolumeExceededReceipt(
  input: BuildBoundaryReceiptInput,
  overflow: BoundaryOverflow,
): BoundaryReceiptV2 {
  return buildBoundaryReceiptStrict({
    ...input,
    fingerprints: {},
    findings: [volumeExceededFinding(input.action, overflow)],
    limitations: [],
  }, overflow);
}

export function buildBoundaryReceipt(input: BuildBoundaryReceiptInput): BoundaryReceiptV2 {
  try {
    return buildBoundaryReceiptStrict(input, null);
  } catch (error) {
    if (!(error instanceof BoundaryContractError)
      || error.code !== 'boundary.evidence-volume-exceeded'
      || error.overflow === null) {
      throw error;
    }
    return buildVolumeExceededReceipt(input, error.overflow);
  }
}

const RECEIPT_V1_KEYS = new Set([
  'schemaVersion', 'repository', 'invocation', 'action', 'correlationIdSha256',
  'enforcementMode', 'decision', 'base', 'fingerprints', 'findings', 'limitations',
]);
const RECEIPT_V2_KEYS = new Set([
  'schemaVersion', 'repository', 'invocation', 'action', 'target', 'observedAt',
  'validUntil', 'correlationIdSha256', 'ruleCatalogDigestSha256',
  'evidenceDigestSha256', 'enforcementMode', 'decision', 'base', 'fingerprints',
  'findings', 'limitations', 'overflow',
]);
const RECEIPT_OVERFLOW_KEYS = new Set([
  'reason', 'inputCounts', 'rejectedBytes', 'descriptorDigestSha256', 'digestCoverage',
]);
const RECEIPT_OVERFLOW_COUNT_KEYS = new Set([
  'findings', 'observed', 'artifacts', 'limitations', 'fingerprints', 'corrections',
  'verification', 'sources', 'canonicalRecords',
]);
const RECEIPT_V1_ACTIONS = new Set<BoundaryActionV1>([
  'commit', 'push', 'open-pr', 'reopen-pr', 'open-issue',
]);
const RECEIPT_DECISIONS = new Set<BoundaryDecision>([
  'pass', 'warn', 'block', 'inconclusive',
]);
const LEGACY_FINDING_KEYS = new Set([
  'ruleId', 'decision', 'action', 'summary', 'why', 'observed', 'matchedArtifacts',
  'correction', 'rerun', 'sourceRefs',
]);

function legacyText(value: unknown, fieldPath: string, reference = false): string {
  if (typeof value !== 'string' || value.length === 0) invalidContract(fieldPath);
  const canonical = reference ? receiptReference(value) : receiptText(value);
  if (canonical !== value) invalidContract(fieldPath);
  return value;
}

function legacyStringArray(value: unknown, fieldPath: string, reference = false): string[] {
  if (!Array.isArray(value)) invalidContract(fieldPath);
  return value.map((item, index) => legacyText(item, `${fieldPath}[${index}]`, reference));
}

function parseLegacyFinding(value: unknown, index: number): BoundaryFinding {
  const fieldPath = `findings[${index}]`;
  const record = ownDataRecord(value, fieldPath);
  exactKeys(record, LEGACY_FINDING_KEYS, fieldPath);
  if (Object.keys(record).length !== LEGACY_FINDING_KEYS.size) invalidContract(fieldPath);
  if (!RECEIPT_V1_ACTIONS.has(record.action as BoundaryActionV1)) {
    invalidContract(`${fieldPath}.action`);
  }
  if (!['warn', 'block', 'inconclusive'].includes(String(record.decision))) {
    invalidContract(`${fieldPath}.decision`);
  }
  if (!Array.isArray(record.observed) || !Array.isArray(record.matchedArtifacts)) {
    invalidContract(fieldPath);
  }
  const observed = record.observed.map((item, itemIndex) => {
    const itemRecord = ownDataRecord(item, `${fieldPath}.observed[${itemIndex}]`);
    exactKeys(itemRecord, new Set(['label', 'value']), `${fieldPath}.observed[${itemIndex}]`);
    if (Object.keys(itemRecord).length !== 2) invalidContract(`${fieldPath}.observed[${itemIndex}]`);
    return {
      label: legacyText(itemRecord.label, `${fieldPath}.observed[${itemIndex}].label`),
      value: legacyText(itemRecord.value, `${fieldPath}.observed[${itemIndex}].value`),
    };
  });
  const matchedArtifacts = record.matchedArtifacts.map((item, itemIndex) => {
    const artifactPath = `${fieldPath}.matchedArtifacts[${itemIndex}]`;
    const artifact = ownDataRecord(item, artifactPath);
    exactKeys(artifact, new Set([
      'kind', 'repository', 'id', 'url', 'state', 'fingerprintSha256',
    ]), artifactPath);
    if (!['pull-request', 'issue', 'commit', 'path'].includes(String(artifact.kind))
      || artifact.repository !== 'LucasQuiles/WhatSoup') invalidContract(artifactPath);
    const parsed: BoundaryArtifact = {
      kind: artifact.kind as BoundaryArtifact['kind'],
      repository: 'LucasQuiles/WhatSoup',
      id: legacyText(artifact.id, `${artifactPath}.id`),
    };
    if (artifact.url !== undefined) parsed.url = legacyText(artifact.url, `${artifactPath}.url`, true);
    if (artifact.state !== undefined) parsed.state = legacyText(artifact.state, `${artifactPath}.state`);
    if (artifact.fingerprintSha256 !== undefined) {
      if (typeof artifact.fingerprintSha256 !== 'string'
        || !/^[0-9a-f]{64}$/.test(artifact.fingerprintSha256)) invalidContract(`${artifactPath}.fingerprintSha256`);
      parsed.fingerprintSha256 = artifact.fingerprintSha256;
    }
    return parsed;
  });
  const finding: BoundaryFinding = {
    ruleId: legacyText(record.ruleId, `${fieldPath}.ruleId`),
    decision: record.decision as BoundaryFinding['decision'],
    action: record.action as BoundaryActionV1,
    summary: legacyText(record.summary, `${fieldPath}.summary`),
    why: legacyText(record.why, `${fieldPath}.why`),
    observed,
    matchedArtifacts,
    correction: legacyStringArray(record.correction, `${fieldPath}.correction`),
    rerun: legacyText(record.rerun, `${fieldPath}.rerun`),
    sourceRefs: legacyStringArray(record.sourceRefs, `${fieldPath}.sourceRefs`, true),
  };
  if (!isBoundaryFindingComplete(finding)) invalidContract(fieldPath);
  return finding;
}

function parseBoundaryReceiptV1(record: Record<string, unknown>): BoundaryReceiptV1 {
  exactKeys(record, RECEIPT_V1_KEYS, 'receipt');
  const required = [...RECEIPT_V1_KEYS]
    .filter((key) => key !== 'action' && key !== 'correlationIdSha256');
  if (required.some((key) => !Object.hasOwn(record, key))) invalidContract('receipt');
  if (record.repository !== 'LucasQuiles/WhatSoup') invalidContract('receipt.repository');
  if (record.action !== undefined && !RECEIPT_V1_ACTIONS.has(record.action as BoundaryActionV1)) {
    invalidContract('receipt.action');
  }
  if (record.correlationIdSha256 !== undefined
    && (typeof record.correlationIdSha256 !== 'string'
      || !/^[0-9a-f]{64}$/.test(record.correlationIdSha256))) {
    invalidContract('receipt.correlationIdSha256');
  }
  const mode = canonicalEnforcementMode(record.enforcementMode);
  if (!RECEIPT_DECISIONS.has(record.decision as BoundaryDecision)) invalidContract('receipt.decision');
  if (!Array.isArray(record.findings)) invalidContract('receipt.findings');
  const receipt: BoundaryReceiptV1 = {
    schemaVersion: 1,
    repository: 'LucasQuiles/WhatSoup',
    invocation: legacyText(record.invocation, 'receipt.invocation'),
    ...(record.action === undefined ? {} : { action: record.action as BoundaryActionV1 }),
    ...(record.correlationIdSha256 === undefined
      ? {}
      : { correlationIdSha256: record.correlationIdSha256 as string }),
    enforcementMode: mode,
    decision: record.decision as BoundaryDecision,
    base: canonicalBase(record.base),
    fingerprints: sortedFingerprints(record.fingerprints as Record<string, string | null>),
    findings: record.findings.map(parseLegacyFinding),
    limitations: legacyStringArray(record.limitations, 'receipt.limitations'),
  };
  if (receipt.findings.length > DEFAULT_BOUNDARY_BUDGETS.maxFindings
    || receipt.limitations.length > DEFAULT_BOUNDARY_BUDGETS.maxTopLevelLimitations) {
    invalidContract('receipt');
  }
  return receipt;
}

function parseBoundaryOverflow(value: unknown): BoundaryOverflow | null {
  if (value === null) return null;
  const record = ownDataRecord(value, 'receipt.overflow');
  exactKeys(record, RECEIPT_OVERFLOW_KEYS, 'receipt.overflow');
  const counts = ownDataRecord(record.inputCounts, 'receipt.overflow.inputCounts');
  exactKeys(counts, RECEIPT_OVERFLOW_COUNT_KEYS, 'receipt.overflow.inputCounts');
  if (record.reason !== 'boundary.evidence-volume-exceeded'
    || record.digestCoverage !== 'bounded-structural-descriptor'
    || typeof record.descriptorDigestSha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(record.descriptorDigestSha256)
    || (record.rejectedBytes !== null
      && (!Number.isSafeInteger(record.rejectedBytes) || Number(record.rejectedBytes) < 0))) {
    invalidContract('receipt.overflow');
  }
  for (const key of RECEIPT_OVERFLOW_COUNT_KEYS) {
    if (!Number.isSafeInteger(counts[key]) || Number(counts[key]) < 0) {
      invalidContract(`receipt.overflow.inputCounts.${key}`);
    }
  }
  return {
    reason: 'boundary.evidence-volume-exceeded',
    inputCounts: Object.fromEntries(
      [...RECEIPT_OVERFLOW_COUNT_KEYS].map((key) => [key, Number(counts[key])]),
    ) as unknown as BoundaryOverflow['inputCounts'],
    rejectedBytes: record.rejectedBytes === null ? null : Number(record.rejectedBytes),
    descriptorDigestSha256: record.descriptorDigestSha256,
    digestCoverage: 'bounded-structural-descriptor',
  };
}

function parseBoundaryReceiptV2(record: Record<string, unknown>): BoundaryReceiptV2 {
  exactKeys(record, RECEIPT_V2_KEYS, 'receipt');
  if ([...RECEIPT_V2_KEYS].some((key) => !Object.hasOwn(record, key))) invalidContract('receipt');
  if (!Array.isArray(record.findings) || !Array.isArray(record.limitations)) {
    invalidContract('receipt');
  }
  const overflow = parseBoundaryOverflow(record.overflow);
  const rebuildInput: BuildBoundaryReceiptInput = {
    invocation: record.invocation as string,
    action: record.action as BoundaryAction,
    target: record.target as BoundaryTarget,
    observedAt: record.observedAt as string,
    validUntil: record.validUntil as string | null,
    enforcementMode: record.enforcementMode as EnforcementMode,
    base: record.base as BoundaryReceiptBase,
    fingerprints: record.fingerprints as Record<string, string | null>,
    findings: (record.findings as CanonicalBoundaryFinding[]).map(findingInput),
    limitations: record.limitations as string[],
  };
  const rebuilt = overflow === null
    ? buildBoundaryReceipt(rebuildInput)
    : buildVolumeExceededReceipt(rebuildInput, overflow);
  if (!isDeepStrictEqual(rebuilt, record)) invalidContract('receipt.derivedIdentity');
  return rebuilt;
}

export function parseBoundaryReceipt(input: unknown): BoundaryReceipt {
  const record = ownDataRecord(input, 'receipt');
  if (record.schemaVersion === 1) return parseBoundaryReceiptV1(record);
  if (record.schemaVersion === 2) return parseBoundaryReceiptV2(record);
  return invalidContract('receipt.schemaVersion');
}

export function aggregateBoundaryDecision(
  findings: ReadonlyArray<{ decision: BoundaryDecision }>,
  limitations: ReadonlyArray<string> = [],
): BoundaryDecision {
  if (findings.some((finding) => finding.decision === 'block')) return 'block';
  if (limitations.length > 0) return 'inconclusive';
  if (findings.some((finding) => finding.decision === 'inconclusive')) return 'inconclusive';
  if (findings.some((finding) => finding.decision === 'warn')) return 'warn';
  return 'pass';
}

export function isBoundaryFindingComplete(item: {
  ruleId: string;
  action: string;
  summary: string;
  why: string;
  observed: ReadonlyArray<unknown>;
  correction: ReadonlyArray<string | { operation: string; target: string; expected: string }>;
  rerun: string | { command: string; args: ReadonlyArray<string> };
  sourceRefs: ReadonlyArray<string>;
}): boolean {
  return Boolean(
    item.ruleId
      && item.action
      && item.summary
      && item.why
      && item.observed.length > 0
      && item.correction.length > 0
      && (typeof item.rerun === 'string' ? item.rerun.length > 0 : item.rerun.command.length > 0)
      && item.sourceRefs.length > 0,
  );
}

export function buildSemanticReceipt(input: BuildSemanticReceiptInput): BoundaryReceiptV2 {
  const now = input.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) invalidContract('now');
  const target = input.tree.headOid && input.targetRef !== null
    ? {
        repository: 'LucasQuiles/WhatSoup' as const,
        actionTarget: `ref:${input.targetRef}`,
        headOid: input.tree.headOid,
      }
    : {
        repository: 'LucasQuiles/WhatSoup' as const,
        actionTarget: 'unresolved:push',
        headOid: null,
      };
  if (target.headOid === null) {
    const findings = input.policyFindings.map((finding) =>
      findingFromPolicy(finding));
    if (!findings.some((finding) => finding.ruleId === 'boundary.action-identity-unproven')) {
      findings.push({
        ruleId: 'boundary.action-identity-unproven',
        decision: 'inconclusive',
        action: 'push',
        evidenceState: evidenceStateForRule('boundary.action-identity-unproven'),
        summary: 'The push destination identity could not be proven.',
        why: 'A candidate commit cannot stand in for the independently resolved mutation target.',
        observed: [
          { label: 'action_target', value: target.actionTarget },
          { label: 'head_oid', value: 'unresolved' },
        ],
        matchedArtifacts: [],
        limitations: [],
      });
    }
    return buildDiagnosticReceipt({
      ...input,
      now,
      target,
      findings,
    });
  }
  return buildBoundaryReceipt({
    invocation: 'semantic-quality',
    action: 'push',
    target,
    observedAt: now.toISOString(),
    validUntil: null,
    enforcementMode: input.enforcementMode,
    base: {
      headOid: input.tree.headOid || null,
      baseOid: input.tree.baseOid,
      mergeBaseOid: input.tree.mergeBaseOid,
      evidenceSource: input.evidenceSource,
    },
    fingerprints: {},
    findings: input.policyFindings.map((finding) =>
      findingFromPolicy(finding),
    ),
    limitations: [...new Set([...input.tree.limitations, ...(input.limitations ?? [])])],
  });
}

function buildDiagnosticReceipt(input: BuildSemanticReceiptInput & {
  now: Date;
  target: BoundaryTarget;
  findings: BoundaryFindingInput[];
}): BoundaryReceiptV2 {
  const limitations = canonicalBoundaryLimitations(
    [...new Set([...input.tree.limitations, ...(input.limitations ?? [])])],
  );
  const findings = canonicalFindings(input.findings, 'push', limitations);
  const base: BoundaryReceiptBase = {
    headOid: null,
    baseOid: input.tree.baseOid && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.tree.baseOid)
      ? input.tree.baseOid
      : null,
    mergeBaseOid: input.tree.mergeBaseOid
      && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.tree.mergeBaseOid)
      ? input.tree.mergeBaseOid
      : null,
    evidenceSource: receiptReference(input.evidenceSource),
  };
  const observedAt = input.now.toISOString();
  const catalogDigest = ruleCatalogDigestSha256();
  const evidenceDigest = evidenceDigestSha256({
    target: input.target,
    observedAt,
    validUntil: null,
    base,
    fingerprints: {},
    findings,
    limitations,
    ruleCatalogDigestSha256: catalogDigest,
  });
  const receipt: BoundaryReceiptV2 = {
    schemaVersion: 2,
    repository: 'LucasQuiles/WhatSoup',
    invocation: 'semantic-quality',
    action: 'push',
    target: input.target,
    observedAt,
    validUntil: null,
    correlationIdSha256: correlationIdSha256({
      invocation: 'semantic-quality',
      action: 'push',
      enforcementMode: input.enforcementMode,
      target: input.target,
      evidenceDigestSha256: evidenceDigest,
    }),
    ruleCatalogDigestSha256: catalogDigest,
    evidenceDigestSha256: evidenceDigest,
    enforcementMode: canonicalEnforcementMode(input.enforcementMode),
    decision: aggregateBoundaryDecision(findings, limitations),
    base,
    fingerprints: {},
    findings,
    limitations,
    overflow: null,
  };
  assertReceiptWithinBudgets(receipt);
  return receipt;
}

function renderLegacyReceipt(receipt: BoundaryReceiptV1): string {
  if (receipt.decision === 'pass') {
    return `PASS semantic quality head=${receipt.base.headOid ?? 'unknown'} legacy receipt schema=1\n`;
  }
  const lines: string[] = [];
  for (const finding of receipt.findings) {
    if (lines.length > 0) lines.push('');
    lines.push(`${finding.decision.toUpperCase()} [${finding.ruleId}] while ${finding.action}`);
    if (receipt.correlationIdSha256) {
      lines.push(`Correlation: ${receipt.correlationIdSha256.slice(0, 12)}`);
    }
    lines.push(`Summary: ${finding.summary}`);
    lines.push('Observed:');
    for (const item of finding.observed) lines.push(`  - ${item.label}: ${item.value}`);
    if (finding.matchedArtifacts.length > 0) {
      lines.push('Matched artifacts:');
      for (const item of finding.matchedArtifacts) {
        const details = [
          `${item.kind} ${item.repository}#${item.id}`,
          item.state ? `state=${item.state}` : '',
          item.url ?? '',
          item.fingerprintSha256 ? `fingerprint=${item.fingerprintSha256}` : '',
        ].filter(Boolean);
        lines.push(`  - ${details.join(' ')}`);
      }
    }
    lines.push(`Why: ${finding.why}`);
    lines.push('Correction:');
    for (const item of finding.correction) {
      lines.push(`  - ${item}`);
    }
    lines.push(`Rerun: ${finding.rerun}`);
    lines.push('Sources:');
    for (const item of finding.sourceRefs) lines.push(`  - ${item}`);
  }
  if (receipt.findings.length === 0 && receipt.limitations.length > 0) {
    lines.push(`INCONCLUSIVE [boundary.evidence-incomplete] while ${receipt.action ?? 'push'}`);
    if (receipt.correlationIdSha256) {
      lines.push(`Correlation: ${receipt.correlationIdSha256.slice(0, 12)}`);
    }
    lines.push('Observed:');
    for (const limitation of receipt.limitations) lines.push(`  - limitation: ${limitation}`);
  }
  lines.push('', 'legacy receipt schema=1');
  return `${lines.join('\n')}\n`;
}

interface BoundaryFeedbackGroup {
  key: string;
  findings: CanonicalBoundaryFinding[];
}

function byteCompare(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function feedbackGroupKey(finding: CanonicalBoundaryFinding): string {
  return JSON.stringify({
    ruleId: finding.ruleId,
    ruleVersion: finding.ruleVersion,
    decision: finding.decision,
    action: finding.action,
    summary: finding.summary,
    why: finding.why,
    expected: finding.expected,
    impact: finding.impact,
    safeControls: finding.safeControls,
    correction: finding.correction,
    verification: finding.verification,
    rerun: finding.rerun,
    rerunPurpose: finding.rerunPurpose,
    limitations: finding.limitations,
  });
}

function feedbackGroups(findings: readonly CanonicalBoundaryFinding[]): BoundaryFeedbackGroup[] {
  const grouped = new Map<string, CanonicalBoundaryFinding[]>();
  for (const finding of findings) {
    const key = feedbackGroupKey(finding);
    grouped.set(key, [...(grouped.get(key) ?? []), finding]);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => byteCompare(left, right))
    .map(([key, members]) => ({
      key,
      findings: [...members].sort((left, right) => byteCompare(
        JSON.stringify([left.observed, left.matchedArtifacts, left.findingDigestSha256]),
        JSON.stringify([right.observed, right.matchedArtifacts, right.findingDigestSha256]),
      )),
    }));
}

function uniqueCanonical<T>(items: readonly T[]): T[] {
  const values = new Map<string, T>();
  for (const item of items) values.set(JSON.stringify(item), item);
  return [...values.entries()]
    .sort(([left], [right]) => byteCompare(left, right))
    .map(([, value]) => value);
}

function renderFeedbackGroup(
  receipt: BoundaryReceiptV2,
  group: BoundaryFeedbackGroup,
  selected: readonly CanonicalBoundaryFinding[],
  observationLimit: number,
  artifactLimit: number,
): string {
  const finding = group.findings[0]!;
  const observations = uniqueCanonical(selected.flatMap((item) => item.observed))
    .slice(0, observationLimit);
  const artifacts = uniqueCanonical(selected.flatMap((item) => item.matchedArtifacts))
    .slice(0, artifactLimit);
  const limitations = [...new Set([
    ...finding.limitations,
    ...receipt.limitations,
  ])].sort(byteCompare);
  const lines = [
    `${finding.decision.toUpperCase()} [${finding.ruleId}] while ${finding.action}`,
  ];
  if (group.findings.length > 1) {
    lines.push(`Finding group: ${group.findings.length} findings`);
  }
  lines.push(`Correlation: ${receipt.correlationIdSha256.slice(0, 12)}`);
  lines.push(`Summary: ${finding.summary}`);
  lines.push('Observed:');
  if (observations.length === 0) lines.push('  - retained in canonical JSON only');
  for (const item of observations) lines.push(`  - ${item.label}: ${item.value}`);
  if (artifacts.length > 0) {
    lines.push('Matched artifacts:');
    for (const item of artifacts) {
      const details = [
        `${item.kind} ${item.repository}#${item.id}`,
        item.state ? `state=${item.state}` : '',
        item.url ?? '',
        item.fingerprintSha256 ? `fingerprint=${item.fingerprintSha256}` : '',
      ].filter(Boolean);
      lines.push(`  - ${details.join(' ')}`);
    }
  }
  lines.push('Expected invariant:');
  for (const item of finding.expected) lines.push(`  - ${item}`);
  lines.push('Why this matters:');
  lines.push(`  - ${finding.why}`);
  for (const item of finding.impact) lines.push(`  - ${item}`);
  lines.push(`Why: ${finding.why}`);
  lines.push('Safe control:');
  for (const item of finding.safeControls) lines.push(`  - ${item}`);
  lines.push('Correction:');
  for (const item of finding.correction) {
    lines.push(`  - ${item.operation} ${item.target}: ${item.expected}`);
  }
  lines.push('Verification:');
  for (const item of finding.verification) {
    lines.push(`  - ${[item.command, ...item.args].join(' ')} => ${item.expected}`);
  }
  lines.push('Rerun:');
  lines.push(`  - ${[finding.rerun.command, ...finding.rerun.args].join(' ')}`);
  lines.push(`  - purpose: ${finding.rerunPurpose === 'integration-boundary'
    ? 'integration boundary'
    : 'focused family replay'}`);
  lines.push('Sources:');
  for (const item of finding.sourceRefs) lines.push(`  - ${item}`);
  lines.push('Limitations:');
  if (limitations.length === 0) lines.push('  - none declared');
  for (const limitation of limitations) lines.push(`  - ${limitation}`);
  lines.push(`Receipt evidence: ${receipt.evidenceDigestSha256}`);
  return lines.join('\n');
}

export function renderBoundaryReceipt(receipt: BoundaryReceipt): string {
  if (receipt.schemaVersion === 1) return renderLegacyReceipt(receipt);
  if (receipt.decision === 'pass') {
    return `PASS ${receipt.invocation} while ${receipt.action}\n`;
  }

  const detailLimit = DEFAULT_BOUNDARY_BUDGETS.maxHumanBytes
    - DEFAULT_BOUNDARY_BUDGETS.maxHumanReservedSummaryBytes;
  const groups = feedbackGroups(receipt.findings);
  const blocks: string[] = [];
  const renderedFindingDigests = new Set<string>();
  let renderedObservations = 0;
  let detailedFindings = 0;
  for (const group of groups) {
    const available = DEFAULT_BOUNDARY_BUDGETS.maxHumanDetailedFindings - detailedFindings;
    let selectedCount = Math.min(group.findings.length, available);
    let accepted: {
      block: string;
      selected: CanonicalBoundaryFinding[];
      observationCount: number;
    } | null = null;
    while (selectedCount > 0 && accepted === null) {
      const selected = group.findings.slice(0, selectedCount);
      const observations = uniqueCanonical(selected.flatMap((item) => item.observed));
      const artifacts = uniqueCanonical(selected.flatMap((item) => item.matchedArtifacts));
      let observationLimit = observations.length;
      let artifactLimit = artifacts.length;
      for (;;) {
        const block = renderFeedbackGroup(
          receipt,
          group,
          selected,
          observationLimit,
          artifactLimit,
        );
        const candidate = [...blocks, block].join('\n\n');
        if (Buffer.byteLength(candidate, 'utf8') <= detailLimit) {
          accepted = { block, selected, observationCount: observationLimit };
          break;
        }
        if (artifactLimit > 0) artifactLimit -= 1;
        else if (observationLimit > 0) observationLimit -= 1;
        else break;
      }
      if (accepted === null) selectedCount -= 1;
    }
    if (accepted !== null) {
      blocks.push(accepted.block);
      for (const finding of accepted.selected) {
        renderedFindingDigests.add(finding.findingDigestSha256);
      }
      detailedFindings += accepted.selected.length;
      renderedObservations += accepted.observationCount;
    }
    if (detailedFindings >= DEFAULT_BOUNDARY_BUDGETS.maxHumanDetailedFindings) break;
  }

  const omittedFindings = receipt.findings.filter(
    (finding) => !renderedFindingDigests.has(finding.findingDigestSha256),
  );
  const totalObservations = receipt.findings.reduce(
    (total, finding) => total + finding.observed.length,
    0,
  );
  const omittedObservations = Math.max(0, totalObservations - renderedObservations);
  const omittedEvidenceDigest = createHash('sha256').update(JSON.stringify({
    findingDigests: omittedFindings.map((finding) => finding.findingDigestSha256).sort(byteCompare),
    omittedObservations,
  })).digest('hex');
  const footer = [
    'Feedback summary:',
    `Rendered findings: ${detailedFindings}`,
    `Omitted findings: ${omittedFindings.length}`,
    `Rendered observations: ${renderedObservations}`,
    `Omitted observations: ${omittedObservations}`,
    `Omitted evidence digest: ${omittedEvidenceDigest}`,
    `Receipt evidence: ${receipt.evidenceDigestSha256}`,
  ].join('\n');
  if (Buffer.byteLength(`${footer}\n`, 'utf8')
    > DEFAULT_BOUNDARY_BUDGETS.maxHumanReservedSummaryBytes) {
    throw new Error('boundary feedback footer exceeds its reserved byte budget');
  }
  const output = `${[...blocks, footer].join('\n\n')}\n`;
  if (Buffer.byteLength(output, 'utf8') > DEFAULT_BOUNDARY_BUDGETS.maxHumanBytes) {
    throw new Error('boundary feedback exceeds its declared human byte budget');
  }
  return output;
}

export const renderSemanticReceipt = renderBoundaryReceipt;

export function semanticExitCode(receipt: BoundaryReceipt): 0 | 1 | 2 {
  if (receipt.enforcementMode === 'shadow') return 0;
  if (receipt.decision === 'block') return 1;
  if (receipt.decision === 'inconclusive') return 2;
  return 0;
}

function assertReceiptDestination(filePath: string): void {
  try {
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      throw privateWriteError('refusing to write receipt through symlink', 'ELOOP');
    }
    if (!stat.isFile()) {
      throw privateWriteError('refusing to write receipt over non-regular path', 'EINVAL');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function writeSemanticReceipt(filePath: string, receipt: BoundaryReceipt): string {
  const absolute = path.resolve(filePath);
  const directory = path.dirname(absolute);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(directory);
  if (directoryStat.isSymbolicLink()) {
    throw privateWriteError('refusing to write receipt through symlinked directory', 'ELOOP');
  }
  if (!directoryStat.isDirectory()) {
    throw privateWriteError('refusing to write receipt under non-directory path', 'EINVAL');
  }
  assertReceiptDestination(absolute);

  const temporary = path.join(
    directory,
    `.${path.basename(absolute)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    assertReceiptDestination(absolute);
    renameSync(temporary, absolute);
    fsyncDirectory(directory);
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // Best effort after the primary write failure.
      }
    }
    try {
      unlinkSync(temporary);
    } catch {
      // Best effort when the temporary file was never created or was already renamed.
    }
    throw error;
  }
  return absolute;
}

export function writeLocalReceipt(cwd: string, receipt: BoundaryReceipt): string {
  const gitPath = execFileSync(
    'git',
    ['rev-parse', '--git-path', 'whatsoup/receipts/semantic-quality.json'],
    {
      cwd,
      encoding: 'utf8',
      env: cleanGitEnv(),
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
  if (!gitPath) throw new Error('git returned an empty semantic receipt path');
  const receiptPath = path.isAbsolute(gitPath) ? gitPath : path.resolve(cwd, gitPath);
  return writeSemanticReceipt(receiptPath, receipt);
}
